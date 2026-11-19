package keyed

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"strings"
	"testing"
)

func TestName(t *testing.T) {
	key := bytes.Repeat([]byte("k"), MinKeyLen)
	a := Name(key, "label", []byte("acct"))
	if len(a) != 22 || strings.Contains(a, "acct") {
		t.Fatalf("name %q", a)
	}
	if Name(key, "label", []byte("acct")) != a {
		t.Fatal("not deterministic")
	}
	// Another key, label or part, or the same bytes split differently, is
	// another name.
	for _, other := range []string{
		Name(bytes.Repeat([]byte("j"), MinKeyLen), "label", []byte("acct")),
		Name(key, "other", []byte("acct")),
		Name(key, "label", []byte("acct2")),
		Name(key, "label", []byte("ac"), []byte("ct")),
	} {
		if other == a {
			t.Fatal("two different inputs share a name")
		}
	}
	defer func() {
		if recover() == nil {
			t.Fatal("a key that was never set was accepted")
		}
	}()
	Name(nil, "label", []byte("acct"))
}

// A derived key depends on the secret and the label, and is no session
// token's MAC: those are HMACs of a message that starts with their label's
// bytes, where Key's starts with the label's length.
func TestKey(t *testing.T) {
	secret := bytes.Repeat([]byte("s"), 64)
	k := Key(secret, "incognitochat/v2/socket-key")
	if len(k) != 32 || bytes.Equal(k, Key(secret, "incognitochat/v2/notice-key")) ||
		bytes.Equal(k, Key(bytes.Repeat([]byte("t"), 64), "incognitochat/v2/socket-key")) {
		t.Fatal("derived keys don't depend on both the secret and the label")
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte("incognitochat/v2/socket-key"))
	if bytes.Equal(k, mac.Sum(nil)) {
		t.Fatal("the derived key is a plain HMAC of the label")
	}
}
