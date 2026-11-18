package tokens

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"testing"
)

// During a rotation the ring holds the new key and the old one: tokens of
// both are good, and each batch is signed with the key the app names. Once
// the old key is retired, its tokens are refused.
func TestKeyringRotation(t *testing.T) {
	current, currentPub := newIssuer(t)
	previous, previousPub := newIssuer(t)
	epoch := EpochOf(now)

	ring, err := NewKeyring(current, previous)
	if err != nil {
		t.Fatal(err)
	}
	if ids := ring.KeyIDs(); len(ids) != 2 || ids[0] != current.KeyID() || ids[1] != previous.KeyID() {
		t.Fatalf("key IDs %x", ids)
	}
	if !ring.Holds(current.KeyID()) || !ring.Holds(previous.KeyID()) || ring.Holds([32]byte{1}) {
		t.Fatal("Holds is wrong")
	}
	if ring.BlindedLen() != current.BlindedLen() {
		t.Fatalf("BlindedLen = %d", ring.BlindedLen())
	}

	// Signed with the key named: each token unblinds (and so verifies)
	// under that key's public key only.
	signWith := func(id [32]byte) func([]byte) ([]byte, error) {
		return func(b []byte) ([]byte, error) { return ring.Sign(id, b) }
	}
	newToken := mintWith(t, signWith(current.KeyID()), currentPub, epoch, current.KeyID())
	oldToken := mintWith(t, signWith(previous.KeyID()), previousPub, epoch, previous.KeyID())
	for name, token := range map[string][]byte{"current key": newToken, "previous key": oldToken} {
		if _, _, err := ring.Check(token, now); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := ring.Sign([32]byte{1}, make([]byte, ring.BlindedLen())); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("signing with a key not held: %v", err)
	}
	// Signed by one key but naming the other: refused by both.
	if _, _, err := ring.Check(mint(t, previous, previousPub, epoch, current.KeyID()), now); !errors.Is(err, ErrInvalid) {
		t.Errorf("a token naming another key than its signer: %v", err)
	}
	// A key that isn't held is told apart; something not in a token's shape
	// isn't, whatever key it names.
	other, otherPub := newIssuer(t)
	otherToken := mint(t, other, otherPub, epoch, other.KeyID())
	if _, _, err := ring.Check(otherToken, now); !errors.Is(err, ErrUnknownKey) {
		t.Errorf("a token of a key not held: %v", err)
	}
	media, err := NewKeyring(&Issuer{label: LabelMedia, keyID: [32]byte{9}, k: current.k}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := media.Check(otherToken, now); !errors.Is(err, ErrInvalid) {
		t.Errorf("another kind's token, of a key not held: %v", err)
	}
	for name, bad := range map[string][]byte{
		"truncated":     newToken[:inputLen-1],
		"short":         otherToken[:inputLen+10],
		"other type":    append([]byte{0, 1}, otherToken[2:]...),
		"two weeks old": mint(t, other, otherPub, epoch-2, other.KeyID()),
	} {
		if _, _, err := ring.Check(bad, now); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}

	// The previous key retired.
	retired, err := NewKeyring(current, nil)
	if err != nil {
		t.Fatal(err)
	}
	if retired.Holds(previous.KeyID()) || len(retired.KeyIDs()) != 1 {
		t.Fatal("still holds the retired key")
	}
	if _, _, err := retired.Check(mint(t, previous, previousPub, epoch, previous.KeyID()), now); !errors.Is(err, ErrUnknownKey) {
		t.Errorf("a retired key's token: %v", err)
	}
	if _, _, err := retired.Check(mint(t, current, currentPub, epoch, current.KeyID()), now); err != nil {
		t.Errorf("current key's token after retiring the previous: %v", err)
	}
	if _, err := retired.Sign(previous.KeyID(), make([]byte, retired.BlindedLen())); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("signing with a retired key: %v", err)
	}
}

func TestNewKeyringRejects(t *testing.T) {
	sendPEM, _ := keyPEM(t)
	send, err := NewIssuer(sendPEM, LabelSend)
	if err != nil {
		t.Fatal(err)
	}
	sameKey, _ := NewIssuer(sendPEM, LabelSend)
	media, _ := NewIssuer(sendPEM, LabelMedia)
	for name, previous := range map[string]*Issuer{"the same key": sameKey, "another kind": media} {
		if _, err := NewKeyring(send, previous); !errors.Is(err, ErrKey) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := NewKeyring(nil, nil); !errors.Is(err, ErrKey) {
		t.Errorf("no current key: %v", err)
	}
}

func TestLoadKeyring(t *testing.T) {
	currentPEM, currentPub := keyPEM(t)
	previousPEM, previousPub := keyPEM(t)
	currentID, _ := KeyID(currentPub)
	previousID, _ := KeyID(previousPub)

	ring, err := LoadKeyring(string(currentPEM), NoKey, LabelSend)
	if err != nil || len(ring.KeyIDs()) != 1 || ring.KeyIDs()[0] != currentID {
		t.Fatalf("without a previous key: %v", err)
	}
	ring, err = LoadKeyring(string(currentPEM), string(previousPEM), LabelSend)
	if err != nil || ring.KeyIDs()[0] != currentID || !ring.Holds(previousID) {
		t.Fatalf("with a previous key: %v", err)
	}
	for name, keys := range map[string][2]string{
		"bad current":  {"nope", NoKey},
		"bad previous": {string(currentPEM), "nope"},
		"empty":        {string(currentPEM), ""},
		"same twice":   {string(currentPEM), string(currentPEM)},
	} {
		if _, err := LoadKeyring(keys[0], keys[1], LabelSend); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func keyPEM(t *testing.T) ([]byte, *rsa.PublicKey) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, ModulusBits)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), &key.PublicKey
}
