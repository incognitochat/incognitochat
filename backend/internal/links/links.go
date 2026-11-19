// Package links checks link bundles (design §8).
//
// A link is t.me/<bot>/<app>?startapp=1<link ID><fingerprint>. Its bundle,
// which anyone with the link ID can fetch, holds the link signing key (whose
// fingerprint is in the link) and the current encryption keys, each signed by
// the signing key with a validity window. Senders check all of that before
// encrypting, so a server that swaps keys is caught. The server only checks
// that a bundle is well formed and signed, and stores it.
//
// An encryption key's signature covers devicesig.Message(LabelLinkKey,
// suite, key, from, until), with times as 8-byte big-endian Unix seconds on a
// whole hour. It doesn't name the link: anyone can copy a bundle's signed
// keys. So creating, replacing or rotating a link also takes an owner proof
// (CheckOwner), a signature by the signing key over
// devicesig.Message(LabelLinkOwner, suite, link ID, account ID), which only
// whoever holds the private key can make for their own account and link ID.
// With it the server gives each signing key to one account for good
// (directory.ErrKeyTaken), so a sender's tag, made from the key's
// fingerprint, doesn't match across accounts' links (for links made before
// the server checked this, from their next rotation or replacement).
package links

import (
	"crypto/ecdsa"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/devicesig"
)

const (
	// MaxActive is how many links one account can have at a time: one, which
	// can be replaced (a new address, the same identity).
	MaxActive = 1
	// MaxKeys is how many encryption keys a bundle can list (v2.0 uses one,
	// two while rotating).
	MaxKeys = 4
	// MaxKeyValidity is the longest an encryption key may be offered for.
	MaxKeyValidity = 8 * 7 * 24 * time.Hour

	idBytes = 8
)

// ErrInvalid is returned for a malformed or badly signed bundle.
var ErrInvalid = errors.New("links: invalid bundle")

// Key is one encryption key in a bundle.
type Key struct {
	Key       []byte // 65-byte P-256 point (ECDH)
	From      time.Time
	Until     time.Time
	Signature []byte // by the link signing key
}

// ValidID reports whether id is a link ID: 8 bytes as 11 base64url
// characters, in their one canonical spelling (the decoder alone skips CR
// and LF anywhere), since the ID names the link's items in the directory.
func ValidID(id string) bool {
	b, err := base64.RawURLEncoding.Strict().DecodeString(id)
	return err == nil && len(b) == idBytes && base64.RawURLEncoding.EncodeToString(b) == id
}

// KeyParts are the signed parts of an encryption key.
func KeyParts(k Key) [][]byte {
	return [][]byte{
		{devicesig.Suite},
		k.Key,
		binary.BigEndian.AppendUint64(nil, uint64(k.From.Unix())),
		binary.BigEndian.AppendUint64(nil, uint64(k.Until.Unix())),
	}
}

// OwnerParts are the signed parts of an owner proof: the suite, then the
// link ID and the account ID as their UTF-8 (base64url) strings.
func OwnerParts(linkID, accountID string) [][]byte {
	return [][]byte{{devicesig.Suite}, []byte(linkID), []byte(accountID)}
}

// CheckOwner verifies an owner proof: that whoever asks for link linkID for
// account accountID holds the link's private signing key.
func CheckOwner(signingKey *ecdsa.PublicKey, proof []byte, linkID, accountID string) error {
	if devicesig.Verify(signingKey, proof, devicesig.LabelLinkOwner, OwnerParts(linkID, accountID)...) != nil {
		return ErrInvalid
	}
	return nil
}

// Check verifies a bundle's encryption keys against its signing key: one to
// MaxKeys keys, each a valid point, on whole hours, valid for at most
// MaxKeyValidity, not yet expired, and signed.
func Check(signingKey *ecdsa.PublicKey, keys []Key, now time.Time) error {
	if len(keys) == 0 || len(keys) > MaxKeys {
		return ErrInvalid
	}
	for _, k := range keys {
		if _, err := devicesig.ParsePublicKey(k.Key); err != nil {
			return ErrInvalid
		}
		if !onHour(k.From) || !onHour(k.Until) || !k.From.Before(k.Until) ||
			k.Until.Sub(k.From) > MaxKeyValidity || !k.Until.After(now) {
			return ErrInvalid
		}
		if devicesig.Verify(signingKey, k.Signature, devicesig.LabelLinkKey, KeyParts(k)...) != nil {
			return ErrInvalid
		}
	}
	return nil
}

func onHour(t time.Time) bool {
	return t.Unix() > 0 && t.Unix()%3600 == 0
}
