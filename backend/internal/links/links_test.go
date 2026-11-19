package links

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/devicesig"
)

var now = time.Unix(1_800_000_000, 0)

// The signed message for a fixed key, computed independently (Node) and
// checked by the client too (web/src/protocol/link.test.ts).
const (
	vectorKey     = "043e4cd596e64fe0d4dac5cce1479f58b981e24664c49c89e823be92673cd970d130b3038618a2156d3db3edccde5a6f271cb346dd868dc771d0ba2812a1197cb1"
	vectorMessage = "0019696e636f676e69746f636861742f76322f6c696e6b2d6b6579000000010100000041043e4cd596e64fe0d4dac5cce1479f58b981e24664c49c89e823be92673cd970d130b3038618a2156d3db3edccde5a6f271cb346dd868dc771d0ba2812a1197cb100000008000000006b49d20000000008000000006b6ebc00"
)

// The owner proof's message for fixed IDs, computed independently (Python)
// and checked by the client too (web/src/protocol/link.test.ts).
const (
	vectorLinkID       = "AAAAAAAAAAA"
	vectorAccountID    = "AAAAAAAAAAAAAAAAAAAAAA"
	vectorOwnerMessage = "001b696e636f676e69746f636861742f76322f6c696e6b2d6f776e657200000001010000000b41414141414141414141410000001641414141414141414141414141414141414141414141"
)

func signOwner(t *testing.T, key *ecdsa.PrivateKey, linkID, accountID string) []byte {
	t.Helper()
	digest := sha256.Sum256(devicesig.Message(devicesig.LabelLinkOwner, OwnerParts(linkID, accountID)...))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return sig
}

func TestOwnerMessageMatchesClient(t *testing.T) {
	got := devicesig.Message(devicesig.LabelLinkOwner, OwnerParts(vectorLinkID, vectorAccountID)...)
	if want, _ := hex.DecodeString(vectorOwnerMessage); !bytes.Equal(got, want) {
		t.Fatalf("message = %x\nwant      %x", got, want)
	}
}

// An owner proof holds only for the key that made it, the link ID and the
// account ID it names: a copied bundle (keys signed for anyone) proves
// nothing, and one account's proof doesn't serve another, or another link.
func TestCheckOwner(t *testing.T) {
	lsk, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	const link, account = "AAAAAAAAAAA", "AAAAAAAAAAAAAAAAAAAAAA"
	if err := CheckOwner(&lsk.PublicKey, signOwner(t, lsk, link, account), link, account); err != nil {
		t.Fatalf("a valid proof: %v", err)
	}
	k := sign(t, lsk, Key{Key: encryptionKey(t), From: now.Truncate(time.Hour), Until: now.Truncate(time.Hour).Add(time.Hour)})
	for name, proof := range map[string][]byte{
		"none":                  nil,
		"another key":           signOwner(t, other, link, account),
		"another link":          signOwner(t, lsk, "BBBBBBBBBBB", account),
		"another account":       signOwner(t, lsk, link, "BBBBBBBBBBBBBBBBBBBBBB"),
		"an encryption key's":   k.Signature,
		"garbage of the length": bytes.Repeat([]byte{1}, 64),
	} {
		if err := CheckOwner(&lsk.PublicKey, proof, link, account); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func sign(t *testing.T, key *ecdsa.PrivateKey, k Key) Key {
	t.Helper()
	digest := sha256.Sum256(devicesig.Message(devicesig.LabelLinkKey, KeyParts(k)...))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	k.Signature = make([]byte, 64)
	r.FillBytes(k.Signature[:32])
	s.FillBytes(k.Signature[32:])
	return k
}

func encryptionKey(t *testing.T) []byte {
	t.Helper()
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return k.PublicKey().Bytes()
}

func TestKeyMessageMatchesClient(t *testing.T) {
	key, _ := hex.DecodeString(vectorKey)
	k := Key{Key: key, From: now, Until: now.Add(4 * 7 * 24 * time.Hour)}
	got := devicesig.Message(devicesig.LabelLinkKey, KeyParts(k)...)
	if want, _ := hex.DecodeString(vectorMessage); !bytes.Equal(got, want) {
		t.Fatalf("message = %x\nwant      %x", got, want)
	}
}

func TestCheck(t *testing.T) {
	lsk, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	good := func() Key {
		return sign(t, lsk, Key{Key: encryptionKey(t), From: now.Truncate(time.Hour), Until: now.Truncate(time.Hour).Add(5 * 7 * 24 * time.Hour)})
	}
	if err := Check(&lsk.PublicKey, []Key{good()}, now); err != nil {
		t.Fatalf("valid bundle refused: %v", err)
	}
	if err := Check(&lsk.PublicKey, []Key{good(), good()}, now); err != nil {
		t.Fatalf("two keys refused: %v", err)
	}

	cases := map[string][]Key{
		"no keys":        nil,
		"too many":       {good(), good(), good(), good(), good()},
		"other signer":   {sign(t, other, Key{Key: encryptionKey(t), From: now, Until: now.Add(time.Hour)})},
		"off the hour":   {sign(t, lsk, Key{Key: encryptionKey(t), From: now.Add(time.Second), Until: now.Add(time.Hour)})},
		"expired":        {sign(t, lsk, Key{Key: encryptionKey(t), From: now.Add(-2 * time.Hour), Until: now})},
		"too long":       {sign(t, lsk, Key{Key: encryptionKey(t), From: now, Until: now.Add(MaxKeyValidity + time.Hour)})},
		"backwards":      {sign(t, lsk, Key{Key: encryptionKey(t), From: now.Add(2 * time.Hour), Until: now.Add(time.Hour)})},
		"not a point":    {sign(t, lsk, Key{Key: bytes.Repeat([]byte{4}, 65), From: now, Until: now.Add(time.Hour)})},
		"tampered until": {func() Key { k := good(); k.Until = k.Until.Add(time.Hour); return k }()},
	}
	for name, keys := range cases {
		if err := Check(&lsk.PublicKey, keys, now); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestValidID(t *testing.T) {
	for id, want := range map[string]bool{
		"AAAAAAAAAAA":  true,
		"aB-_012345w":  true,
		"AAAAAAAAAA":   false,
		"AAAAAAAAAAAA": false,
		"AAAAAAAAAA=":  false,
		"AAAAAAAAAA+":  false,
		"AAAAAAAAAAB":  false, // non-canonical: trailing bits set
		// CR and LF, which the decoder skips, anywhere and in any number
		// (TST-1).
		"00000\r000000":   false,
		"AAAA\nAAAAAAA":   false,
		"AAAAAAAAAAA\r\n": false,
		"AAA" + strings.Repeat("\r\n", 1000) + "AAAAAAAA": false,
	} {
		if ValidID(id) != want {
			t.Errorf("ValidID(%q) = %v", id, !want)
		}
	}
}

// Whatever ValidID accepts is the canonical spelling of 8 bytes, so a link
// has one ID (TST-1).
func FuzzValidID(f *testing.F) {
	for _, seed := range []string{"AAAAAAAAAAA", "aB-_012345w", "00000\r000000", "AAAAAAAAAAB", ""} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, id string) {
		if !ValidID(id) {
			return
		}
		b, err := base64.RawURLEncoding.DecodeString(id)
		if err != nil || len(id) != 11 || base64.RawURLEncoding.EncodeToString(b) != id {
			t.Fatalf("non-canonical link ID %q accepted", id)
		}
	})
}
