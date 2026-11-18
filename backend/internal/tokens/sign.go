package tokens

import (
	"crypto/rand"
	"crypto/rsa"
	"errors"
	"math/big"

	"filippo.io/bigmod"
)

// ErrSign is returned when a signature fails its own check (a fault in the
// computation): the request is refused, and nothing is sent back.
var ErrSign = errors.New("tokens: signing failed its check")

// signer computes RFC 9474's BlindSign, s = m^d mod n: the same bytes as
// circl's blindrsa.Signer, about three times faster. circl raises m to the
// full-size d; this uses the Chinese remainder theorem instead, as Go's
// crypto/rsa does: two exponentiations with half-size exponents and moduli.
//
// The arithmetic is filippo.io/bigmod, the constant-time code crypto/rsa
// uses (crypto/internal/fips140/bigmod), so the time taken doesn't depend on
// the key or the message. On top of that, like circl:
//   - each signature is blinded with a fresh random r: what is exponentiated
//     is m·rᵉ, which nobody chose, and the result is multiplied by r⁻¹;
//   - each signature is checked, sᵉ = m mod n, before it is returned, so a
//     fault in one half of the computation (which would give away a factor
//     of n: the Bellcore attack) never leaves the function.
//
// It holds only values it reads, so one signer can be used concurrently.
type signer struct {
	n, p, q *bigmod.Modulus
	nBig    *big.Int
	e       uint
	// dP and dQ are d mod (p-1) and d mod (q-1), big-endian, as long as p
	// and q.
	dP, dQ []byte
	qInv   *bigmod.Nat // q⁻¹ mod p
	qModN  *bigmod.Nat // q, as a number mod n
}

// newSigner reads the CRT values of a two-prime key, which
// x509.ParsePKCS8PrivateKey precomputes (and checks). The caller has
// validated the key.
func newSigner(key *rsa.PrivateKey) (*signer, error) {
	if len(key.Primes) != 2 || key.E < 3 {
		return nil, ErrKey
	}
	key.Precompute()
	pre := key.Precomputed
	if pre.Dp == nil || pre.Dq == nil || pre.Qinv == nil {
		return nil, ErrKey
	}
	p, q := key.Primes[0], key.Primes[1]
	n, err := bigmod.NewModulus(key.N.Bytes())
	if err != nil {
		return nil, ErrKey
	}
	pMod, err := bigmod.NewModulus(p.Bytes())
	if err != nil {
		return nil, ErrKey
	}
	qMod, err := bigmod.NewModulus(q.Bytes())
	if err != nil {
		return nil, ErrKey
	}
	// The exponents are reduced, so shorter than the primes.
	if pre.Dp.Sign() <= 0 || pre.Dp.Cmp(p) >= 0 || pre.Dq.Sign() <= 0 || pre.Dq.Cmp(q) >= 0 {
		return nil, ErrKey
	}
	qInv, err := bigmod.NewNat().SetBytes(pre.Qinv.Bytes(), pMod)
	if err != nil {
		return nil, ErrKey
	}
	s := &signer{
		n:     n,
		p:     pMod,
		q:     qMod,
		nBig:  new(big.Int).Set(key.N),
		e:     uint(key.E),
		dP:    pre.Dp.FillBytes(make([]byte, pMod.Size())),
		dQ:    pre.Dq.FillBytes(make([]byte, qMod.Size())),
		qInv:  qInv,
		qModN: bigmod.NewNat().Mod(qMod.Nat(), n),
	}
	// A key whose CRT values don't match it would fail every signature:
	// better found at startup.
	two := make([]byte, n.Size())
	two[len(two)-1] = 2
	if _, err := s.sign(two); err != nil {
		return nil, ErrKey
	}
	return s, nil
}

// sign returns m^d mod n for a blinded message m of exactly n's length, or
// ErrInvalid for one that is n or more (circl refuses those too).
func (s *signer) sign(blinded []byte) ([]byte, error) {
	if len(blinded) != s.n.Size() {
		return nil, ErrInvalid
	}
	m, err := bigmod.NewNat().SetBytes(blinded, s.n)
	if err != nil {
		return nil, ErrInvalid
	}
	r, rInv, err := s.blindingFactor()
	if err != nil {
		return nil, err
	}
	// x = m·rᵉ mod n.
	x := bigmod.NewNat().ExpShortVarTime(r, s.e, s.n).Mul(m, s.n)
	// sig = x^d mod n, by CRT (Garner): s1 = x^dP mod p, s2 = x^dQ mod q,
	// sig = s2 + q·(qInv·(s1 - s2) mod p).
	t := bigmod.NewNat()
	s1 := bigmod.NewNat().Exp(t.Mod(x, s.p), s.dP, s.p)
	s2 := bigmod.NewNat().Exp(t.Mod(x, s.q), s.dQ, s.q)
	s1.Sub(t.Mod(s2, s.p), s.p)
	s1.Mul(s.qInv, s.p)
	sig := s1.ExpandFor(s.n).Mul(s.qModN, s.n)
	sig.Add(s2.ExpandFor(s.n), s.n)
	// Unblind: (m·rᵉ)^d = m^d·r.
	sig.Mul(rInv, s.n)
	// The check that keeps a faulty signature in: sigᵉ must be m.
	if bigmod.NewNat().ExpShortVarTime(sig, s.e, s.n).Equal(m) != 1 {
		return nil, ErrSign
	}
	return sig.Bytes(s.n), nil
}

// blindingFactor returns a fresh random r in [1, n) and its inverse mod n.
// The inverse takes variable time, which can only tell about r, as with
// circl's (math/big) blinding.
func (s *signer) blindingFactor() (r, rInv *bigmod.Nat, err error) {
	buf := make([]byte, s.n.Size())
	inv := new(big.Int)
	// An r that isn't invertible shares a factor with n: a chance of about
	// 2⁻¹⁰²³ each time.
	for range 3 {
		rBig, err := rand.Int(rand.Reader, s.nBig)
		if err != nil {
			return nil, nil, err
		}
		if rBig.Sign() == 0 || inv.ModInverse(rBig, s.nBig) == nil {
			continue
		}
		if r, err = bigmod.NewNat().SetBytes(rBig.FillBytes(buf), s.n); err != nil {
			return nil, nil, err
		}
		if rInv, err = bigmod.NewNat().SetBytes(inv.FillBytes(buf), s.n); err != nil {
			return nil, nil, err
		}
		return r, rInv, nil
	}
	return nil, nil, ErrSign
}
