package tokens

import (
	"encoding/binary"
	"time"
)

// NoKey stands for no key where an optional one (the previous key) is read
// from configuration: SSM can't store an empty value (infra/parameters.tf).
const NoKey = "none"

// LoadKeyring reads one kind's keys from configuration: the current key
// (a PEM, as NewIssuer takes) and the previous one, or NoKey for none.
// Every key held is checked as NewIssuer checks it.
func LoadKeyring(current, previous, label string) (*Keyring, error) {
	cur, err := NewIssuer([]byte(current), label)
	if err != nil {
		return nil, err
	}
	var prev *Issuer
	if previous != NoKey {
		if prev, err = NewIssuer([]byte(previous), label); err != nil {
			return nil, err
		}
	}
	return NewKeyring(cur, prev)
}

// Keyring holds the issuer keys of one kind of token: the current key and,
// while a rotation lasts, the previous one (docs/deployment.md, Rotating an
// issuer key). Tokens of either key are accepted. A batch is signed with
// the key the app names, its build's, never one the server picks: an app
// still open on a build for the old key keeps getting tokens it can use,
// and one built for the new key never gets old-key tokens.
type Keyring struct {
	// held is the current key, then the previous one if there is one.
	held []*Issuer
}

// NewKeyring holds current and, unless it is nil, previous: two different
// keys of the same kind.
func NewKeyring(current, previous *Issuer) (*Keyring, error) {
	if current == nil {
		return nil, ErrKey
	}
	held := []*Issuer{current}
	if previous != nil {
		if previous.label != current.label || previous.keyID == current.keyID || previous.k != current.k {
			return nil, ErrKey
		}
		held = append(held, previous)
	}
	return &Keyring{held: held}, nil
}

// KeyIDs returns the IDs of the keys held, the current one first, then the
// previous one if there is one.
func (r *Keyring) KeyIDs() [][32]byte {
	ids := make([][32]byte, len(r.held))
	for i, k := range r.held {
		ids[i] = k.keyID
	}
	return ids
}

// Holds reports whether the key with this ID is held.
func (r *Keyring) Holds(keyID [32]byte) bool { return r.key(keyID) != nil }

func (r *Keyring) key(id [32]byte) *Issuer {
	for _, k := range r.held {
		if k.keyID == id {
			return k
		}
	}
	return nil
}

// BlindedLen is the length of a blinded message and of its signature: the
// same for every key held.
func (r *Keyring) BlindedLen() int { return r.held[0].k }

// Sign signs a blinded message with the held key keyID names (Issuer.Sign),
// or returns ErrUnknownKey.
func (r *Keyring) Sign(keyID [32]byte, blinded []byte) ([]byte, error) {
	k := r.key(keyID)
	if k == nil {
		return nil, ErrUnknownKey
	}
	return k.Sign(blinded)
}

// Check verifies a token of any key held (Issuer.Check), the one its key
// ID names. A token of this kind and of this week or last, but for a key
// that isn't held, gets ErrUnknownKey, so that an app still on a build for
// a retired key can be told so; anything else that isn't valid (another
// kind's token among them), ErrInvalid.
func (r *Keyring) Check(token []byte, now time.Time) (nonce []byte, forgetAfter time.Time, err error) {
	if len(token) != inputLen+r.BlindedLen() || binary.BigEndian.Uint16(token) != Type {
		return nil, time.Time{}, ErrInvalid
	}
	if k := r.key([32]byte(token[66:98])); k != nil {
		return k.Check(token, now)
	}
	label, epoch, challenge := r.held[0].label, EpochOf(now), [32]byte(token[34:66])
	if challenge == Challenge(label, epoch) || challenge == Challenge(label, epoch-1) {
		return nil, time.Time{}, ErrUnknownKey
	}
	return nil, time.Time{}, ErrInvalid
}
