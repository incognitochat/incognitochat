package tokens

import (
	"bytes"
	"crypto/rand"
	"crypto/x509"
	"encoding/binary"
	"encoding/pem"
	"math/big"
	"slices"
	"testing"

	"github.com/cloudflare/circl/blindsign/blindrsa"
)

// fuzzIssuer is an issuer of send tokens with the first test key.
func fuzzIssuer(f *testing.F) *Issuer {
	f.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(keys(f)[0])
	if err != nil {
		f.Fatal(err)
	}
	i, err := NewIssuer(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), LabelSend)
	if err != nil {
		f.Fatal(err)
	}
	return i
}

// tokenInput is a token's signed part for i: type, nonce (nonce, padded or
// cut to 32 bytes), the challenge of epoch and i's key ID.
func tokenInput(i *Issuer, epoch uint64, nonce []byte) []byte {
	in := binary.BigEndian.AppendUint16(nil, Type)
	in = append(in, make([]byte, 32)...)
	copy(in[2:34], nonce)
	challenge, keyID := Challenge(LabelSend, epoch), i.KeyID()
	return append(append(in, challenge[:]...), keyID[:]...)
}

// No bytes pass Check without the issuer's signature, and none make it
// panic. With framed set, the fuzzed bytes are the nonce and authenticator
// of a token with a correct type, challenge and key ID, so they reach the
// signature check.
func FuzzCheck(f *testing.F) {
	i := fuzzIssuer(f)
	k := i.BlindedLen()
	f.Add([]byte("nonce"), make([]byte, k), true)
	f.Add([]byte("nonce"), bytes.Repeat([]byte{0xff}, k), true)
	f.Add([]byte("nonce"), i.PublicKey().N.Bytes(), true)
	f.Add([]byte{}, []byte{}, false)
	f.Add(tokenInput(i, EpochOf(now), nil), make([]byte, k), false)
	f.Fuzz(func(t *testing.T, nonce, auth []byte, framed bool) {
		token := append(slices.Clone(nonce), auth...)
		if framed {
			token = append(tokenInput(i, EpochOf(now), nonce), auth...)
		}
		if _, _, err := i.Check(token, now); err == nil {
			t.Fatalf("a made-up token passed: %x", token)
		}
	})
}

// Sign signs only blinded messages of the key's length below its modulus,
// with a signature of that length which is m^d mod n.
func FuzzSign(f *testing.F) {
	i := fuzzIssuer(f)
	pub := i.PublicKey()
	k := i.BlindedLen()
	one := big.NewInt(1)
	f.Add(make([]byte, k))
	f.Add(one.FillBytes(make([]byte, k)))
	f.Add(new(big.Int).Sub(pub.N, one).FillBytes(make([]byte, k)))
	f.Add(pub.N.FillBytes(make([]byte, k)))
	f.Add(bytes.Repeat([]byte{0xff}, k))
	f.Add([]byte{2})
	f.Fuzz(func(t *testing.T, blinded []byte) {
		sig, err := i.Sign(blinded)
		m := new(big.Int).SetBytes(blinded)
		if err != nil {
			if len(blinded) == k && m.Cmp(pub.N) < 0 {
				t.Fatalf("refused to sign %x: %v", blinded, err)
			}
			return
		}
		if len(blinded) != k || m.Cmp(pub.N) >= 0 {
			t.Fatalf("signed %x", blinded)
		}
		if len(sig) != k {
			t.Fatalf("a signature of %d bytes", len(sig))
		}
		// sigᵉ = m (mod n)
		e := big.NewInt(int64(pub.E))
		if new(big.Int).Exp(new(big.Int).SetBytes(sig), e, pub.N).Cmp(m) != 0 {
			t.Fatalf("a wrong signature of %x", blinded)
		}
	})
}

// A token minted as the app mints it passes once, for its nonce, in this
// epoch and the next, and fails with any byte of it changed.
func FuzzMintCheck(f *testing.F) {
	i := fuzzIssuer(f)
	client, err := blindrsa.NewClient(blindrsa.SHA384PSSDeterministic, i.PublicKey())
	if err != nil {
		f.Fatal(err)
	}
	f.Add([]byte("nonce"), uint16(0))
	f.Add(bytes.Repeat([]byte{0xff}, 32), uint16(300))
	f.Fuzz(func(t *testing.T, nonce []byte, flip uint16) {
		in := tokenInput(i, EpochOf(now), nonce)
		blinded, state, err := client.Blind(rand.Reader, in)
		if err != nil {
			t.Fatal(err)
		}
		blindSig, err := i.Sign(blinded)
		if err != nil {
			t.Fatal(err)
		}
		sig, err := client.Finalize(state, blindSig)
		if err != nil {
			t.Fatal(err)
		}
		token := append(in, sig...)
		got, forget, err := i.Check(token, now)
		if err != nil || !bytes.Equal(got, in[2:34]) {
			t.Fatalf("a minted token was refused: %v", err)
		}
		if !forget.After(now.Add(Epoch)) {
			t.Fatalf("forgotten after %s", forget)
		}
		if _, _, err := i.Check(token, now.Add(Epoch)); err != nil {
			t.Fatalf("refused in the next epoch: %v", err)
		}
		if _, _, err := i.Check(token, now.Add(2*Epoch)); err == nil {
			t.Fatal("accepted two epochs on")
		}
		changed := slices.Clone(token)
		changed[int(flip)%len(changed)] ^= 1
		if _, _, err := i.Check(changed, now); err == nil {
			t.Fatalf("accepted with byte %d changed", int(flip)%len(changed))
		}
	})
}
