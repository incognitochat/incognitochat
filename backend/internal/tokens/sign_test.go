package tokens

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"errors"
	"math/big"
	"sync"
	"testing"

	"filippo.io/bigmod"
	"github.com/cloudflare/circl/blindsign/blindrsa"
)

var (
	testKeysOnce sync.Once
	testKeys     []*rsa.PrivateKey
)

// keys returns a few issuer-sized keys, made once for all tests here.
func keys(t testing.TB) []*rsa.PrivateKey {
	t.Helper()
	testKeysOnce.Do(func() {
		for range 2 {
			key, err := rsa.GenerateKey(rand.Reader, ModulusBits)
			if err != nil {
				panic(err)
			}
			testKeys = append(testKeys, key)
		}
	})
	return testKeys
}

func fill(n *big.Int, k int) []byte { return n.FillBytes(make([]byte, k)) }

// The CRT signer gives circl's bytes for every message below n, including
// ones that share a factor with it, and refuses the rest as circl does.
func TestSignerMatchesCircl(t *testing.T) {
	for _, key := range keys(t) {
		s, err := newSigner(key)
		if err != nil {
			t.Fatal(err)
		}
		circl := blindrsa.NewSigner(key)
		k := key.Size()
		p, q := key.Primes[0], key.Primes[1]
		one := big.NewInt(1)
		inputs := [][]byte{
			fill(big.NewInt(0), k),
			fill(one, k),
			fill(big.NewInt(2), k),
			fill(new(big.Int).Sub(key.N, one), k),
			fill(p, k),
			fill(q, k),
			fill(new(big.Int).Mul(p, big.NewInt(12345)), k),
			fill(new(big.Int).Sub(p, one), k),
		}
		for range 200 {
			m, _ := rand.Int(rand.Reader, key.N)
			inputs = append(inputs, fill(m, k))
		}
		for _, in := range inputs {
			want, err := circl.BlindSign(in)
			if err != nil {
				t.Fatalf("circl: %v", err)
			}
			got, err := s.sign(in)
			if err != nil {
				t.Fatalf("sign(%x): %v", in, err)
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("sign(%x)\n = %x\nwant %x", in, got, want)
			}
		}

		// n and above, and the wrong length: refused by both.
		ff := bytes.Repeat([]byte{0xff}, k)
		for name, in := range map[string][]byte{
			"n":         fill(key.N, k),
			"n+1":       fill(new(big.Int).Add(key.N, one), k),
			"all ones":  ff,
			"too short": fill(one, k-1),
			"too long":  fill(one, k+1),
		} {
			if _, err := circl.BlindSign(in); err == nil {
				t.Errorf("%s: circl signed it", name)
			}
			if sig, err := s.sign(in); !errors.Is(err, ErrInvalid) {
				t.Errorf("%s: sign = %x, %v; want ErrInvalid", name, sig, err)
			}
		}
	}
}

// Through the client's whole path: blind (circl's client, as the app's
// web/src/crypto/blindrsa.ts), sign here, unblind and verify.
func TestSignerClientRoundTrip(t *testing.T) {
	key := keys(t)[0]
	s, err := newSigner(key)
	if err != nil {
		t.Fatal(err)
	}
	client, err := blindrsa.NewClient(blindrsa.SHA384PSSDeterministic, &key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	verifier, _ := blindrsa.NewVerifier(blindrsa.SHA384PSSDeterministic, &key.PublicKey)
	for range 20 {
		msg := make([]byte, inputLen)
		_, _ = rand.Read(msg)
		blinded, state, err := client.Blind(rand.Reader, msg)
		if err != nil {
			t.Fatal(err)
		}
		blindSig, err := s.sign(blinded)
		if err != nil {
			t.Fatal(err)
		}
		sig, err := client.Finalize(state, blindSig)
		if err != nil {
			t.Fatalf("Finalize: %v", err)
		}
		if err := verifier.Verify(msg, sig); err != nil {
			t.Fatalf("Verify: %v", err)
		}
	}
}

// A fault in either half of the CRT computation (here, a wrong exponent or
// coefficient) is caught by the check: an error, never a signature. Such a
// signature would give away a factor of n (gcd(sᵉ - m, n)).
func TestSignerKeepsFaultsIn(t *testing.T) {
	key := keys(t)[0]
	good, err := newSigner(key)
	if err != nil {
		t.Fatal(err)
	}
	m := fill(big.NewInt(0x1234567), key.Size())
	flip := func(b []byte) []byte {
		b = bytes.Clone(b)
		b[len(b)-1] ^= 2
		return b
	}
	badP, badQ, badInv := *good, *good, *good
	badP.dP = flip(good.dP)
	badQ.dQ = flip(good.dQ)
	badInv.qInv = bigmod.NewNat().SetUint(3).ExpandFor(good.p)
	for name, s := range map[string]*signer{"dP": &badP, "dQ": &badQ, "qInv": &badInv} {
		if sig, err := s.sign(m); !errors.Is(err, ErrSign) || sig != nil {
			t.Errorf("faulty %s: sign = %x, %v; want ErrSign", name, sig, err)
		}
	}
	if _, err := good.sign(m); err != nil {
		t.Fatalf("the good signer was changed: %v", err)
	}

	// A key whose stored CRT values are wrong is refused at startup.
	bad := *key
	bad.Precomputed.Dp = new(big.Int).Add(key.Precomputed.Dp, big.NewInt(2))
	if _, err := newSigner(&bad); err == nil {
		t.Error("accepted a key with a wrong dP")
	}
}

// One signer serves concurrent requests (go test -race).
func TestSignerConcurrent(t *testing.T) {
	key := keys(t)[0]
	s, err := newSigner(key)
	if err != nil {
		t.Fatal(err)
	}
	circl := blindrsa.NewSigner(key)
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			for range 5 {
				m, _ := rand.Int(rand.Reader, key.N)
				in := fill(m, key.Size())
				got, err := s.sign(in)
				want, _ := circl.BlindSign(in)
				if err != nil || !bytes.Equal(got, want) {
					t.Errorf("concurrent sign: %v", err)
				}
			}
		})
	}
	wg.Wait()
}

// BenchmarkSign compares one blind signature with a 2048-bit key: this
// package's (CRT, constant-time, blinded, checked) and circl's (full
// exponent, math/big, blinded, checked).
func BenchmarkSign(b *testing.B) {
	key := keys(b)[0]
	m, _ := rand.Int(rand.Reader, key.N)
	in := fill(m, key.Size())
	b.Run("crt", func(b *testing.B) {
		s, err := newSigner(key)
		if err != nil {
			b.Fatal(err)
		}
		for b.Loop() {
			if _, err := s.sign(in); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("circl", func(b *testing.B) {
		circl := blindrsa.NewSigner(key)
		for b.Loop() {
			if _, err := circl.BlindSign(in); err != nil {
				b.Fatal(err)
			}
		}
	})
}
