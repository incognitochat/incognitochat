// Package keyed names stored rows by keyed hashes of the IDs they are about
// (a mailbox, a link, an account), so a copy of a table can't be matched
// with those IDs, or with the directory that maps them to accounts, without
// the key. Only the functions that need a kind of row hold its key.
package keyed

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"

	"github.com/incognitochat/incognitochat/backend/internal/devicesig"
)

// MinKeyLen is the shortest key Name accepts.
const MinKeyLen = 32

// Key derives a key of its own, for one kind of row, from a secret a
// function already holds: an HMAC of label alone. Nothing else made with
// the secret is an HMAC of such a message, so the derived key is never a
// MAC the secret makes for anything else, and it says nothing about the
// secret.
func Key(secret []byte, label string) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write(devicesig.Message(label))
	return mac.Sum(nil)
}

// Name is a row's name for label and parts under key: the first 16 bytes
// of an HMAC of them, in unpadded base64url. It panics for a key shorter
// than MinKeyLen (one that was never set): names under it would be easy
// to match with IDs.
func Name(key []byte, label string, parts ...[]byte) string {
	if len(key) < MinKeyLen {
		panic("keyed: key not set")
	}
	mac := hmac.New(sha256.New, key)
	mac.Write(devicesig.Message(label, parts...))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)[:16])
}
