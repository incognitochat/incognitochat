package devicesig

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"testing"
)

// Parse accepts only what Message writes: whatever it accepts, Message
// encodes back to the same bytes.
func FuzzParse(f *testing.F) {
	f.Add(Message(LabelSession, []byte("a"), []byte("bc")))
	f.Add(Message(LabelDeviceList))
	f.Add(Message("", nil, []byte{}))
	f.Add([]byte{0, 0})
	f.Add([]byte{0xff, 0xff})
	f.Add([]byte{0, 0, 0xff, 0xff, 0xff, 0xff})
	f.Add([]byte{0, 1, 'x', 0, 0, 0})
	f.Fuzz(func(t *testing.T, msg []byte) {
		label, parts, err := Parse(msg)
		if err != nil {
			return
		}
		if !bytes.Equal(Message(label, parts...), msg) {
			t.Fatalf("Parse accepted %x, which Message doesn't write", msg)
		}
	})
}

// A key is accepted only as a 65-byte uncompressed point on the curve, in
// the one encoding it has.
func FuzzParsePublicKey(f *testing.F) {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		f.Fatal(err)
	}
	raw, _ := k.PublicKey.Bytes()
	f.Add(raw)
	f.Add(make([]byte, 65))
	f.Add(append([]byte{4}, bytes.Repeat([]byte{0xff}, 64)...))
	f.Add(append([]byte{2}, raw[1:33]...)) // compressed
	f.Fuzz(func(t *testing.T, raw []byte) {
		pub, err := ParsePublicKey(raw)
		if err != nil {
			return
		}
		if _, err := ecdh.P256().NewPublicKey(raw); err != nil {
			t.Fatalf("%x accepted, which crypto/ecdh refuses", raw)
		}
		if b, err := pub.Bytes(); err != nil || !bytes.Equal(b, raw) {
			t.Fatalf("non-canonical key %x accepted", raw)
		}
	})
}

// Nothing but a real signature verifies, and no input makes the check
// panic, with or without a key.
func FuzzVerifyEncoded(f *testing.F) {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		f.Fatal(err)
	}
	f.Add(make([]byte, 64), []byte("m"))
	f.Add(bytes.Repeat([]byte{0xff}, 64), []byte(""))
	f.Add([]byte{1}, []byte("m"))
	f.Fuzz(func(t *testing.T, sig, msg []byte) {
		if VerifyEncoded(&k.PublicKey, sig, msg) == nil {
			t.Fatalf("a made-up signature %x verified", sig)
		}
		if VerifyEncoded(nil, sig, msg) == nil {
			t.Fatal("verified without a key")
		}
	})
}
