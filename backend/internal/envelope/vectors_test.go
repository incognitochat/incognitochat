package envelope

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/hpke"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"slices"
	"testing"

	"github.com/incognitochat/incognitochat/backend/internal/devicesig"
)

// The client's fixed-input vectors (testdata/vectors.json): envelopes and
// inner messages sealed from fixed keys and randomness, which
// web/src/protocol/vectors.test.ts seals again byte for byte. Opened here as
// docs/protocol.md describes them, with the standard library only: crypto/hpke
// for the wrap, AES-GCM for the body, HKDF and HMAC for the message's tag. So
// the key ID, wrap info, body AAD and tag can't change on one side alone.

type hexBytes []byte

func (h *hexBytes) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	decoded, err := hex.DecodeString(s)
	*h = decoded
	return err
}

type vectorKey struct {
	PrivateKey hexBytes `json:"privateKey"`
	PublicKey  hexBytes `json:"publicKey"`
}

type vectorFile struct {
	AccountSecret hexBytes `json:"accountSecret"`
	Messages      []struct {
		Name       string    `json:"name"`
		Sender     vectorKey `json:"sender"`
		Recipient  vectorKey `json:"recipient"`
		Ephemeral  vectorKey `json:"ephemeral"`
		KeyID      hexBytes  `json:"keyId"`
		ContentKey hexBytes  `json:"contentKey"`
		Nonce      hexBytes  `json:"nonce"`
		JSON       string    `json:"json"`
		AuthTag    hexBytes  `json:"authTag"`
		AAD        hexBytes  `json:"aad"`
		WrapInfo   hexBytes  `json:"wrapInfo"`
		Envelope   hexBytes  `json:"envelope"`
	} `json:"messages"`
	SenderTags []struct {
		LinkFingerprint string   `json:"linkFingerprint"`
		Tag             hexBytes `json:"tag"`
	} `json:"senderTags"`
	IDTags []struct {
		Conv string `json:"conv"`
		ID   string `json:"id"`
		Tag  string `json:"tag"`
	} `json:"idTags"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	raw, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Messages) == 0 || len(v.SenderTags) == 0 || len(v.IDTags) == 0 {
		t.Fatal("no vectors")
	}
	return v
}

func vectorPrivateKey(t *testing.T, k vectorKey) *ecdh.PrivateKey {
	t.Helper()
	sk, err := ecdh.P256().NewPrivateKey(k.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(sk.PublicKey().Bytes(), k.PublicKey) {
		t.Fatalf("public key %x isn't the private key's", k.PublicKey)
	}
	return sk
}

func equal(t *testing.T, what string, got, want []byte) {
	t.Helper()
	if !bytes.Equal(got, want) {
		t.Fatalf("%s =\n%x\nwant\n%x", what, got, want)
	}
}

func hmacSHA256(key []byte, label string, parts ...[]byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(devicesig.Message(label, parts...))
	return mac.Sum(nil)
}

func TestClientMessageVectors(t *testing.T) {
	suite := []byte{Suite}
	for _, v := range loadVectors(t).Messages {
		t.Run(v.Name, func(t *testing.T) {
			env := []byte(v.Envelope)
			if wraps, err := Check(env); err != nil || wraps != 1 {
				t.Fatalf("%d wraps, %v", wraps, err)
			}
			recipient := vectorPrivateKey(t, v.Recipient)
			sender := vectorPrivateKey(t, v.Sender)
			ephemeral := vectorPrivateKey(t, v.Ephemeral)

			// Key ID: the first 8 bytes of SHA-256(Message("…/key-id", suite, P)).
			sum := sha256.Sum256(devicesig.Message("incognitochat/v2/key-id", suite, v.Recipient.PublicKey))
			keyID := sum[:8]
			equal(t, "key ID", keyID, v.KeyID)
			wrap, body := env[2:2+WrapLen], env[2+WrapLen:]
			equal(t, "wrap's key ID", wrap[:8], keyID)
			enc, wrappedKey := wrap[8:8+65], wrap[8+65:]
			equal(t, "enc", enc, ephemeral.PublicKey().Bytes())

			// The wrap: single-shot HPKE, its info naming the key ID and the body.
			bodySum := sha256.Sum256(body)
			info := devicesig.Message("incognitochat/v2/wrap", suite, keyID, bodySum[:])
			equal(t, "wrap info", info, v.WrapInfo)
			hpkeKey, err := hpke.NewDHKEMPrivateKey(recipient)
			if err != nil {
				t.Fatal(err)
			}
			contentKey, err := hpke.Open(hpkeKey, hpke.HKDFSHA256(), hpke.AES256GCM(), info, slices.Concat(enc, wrappedKey))
			if err != nil {
				t.Fatalf("wrap doesn't open: %v", err)
			}
			equal(t, "content key", contentKey, v.ContentKey)

			// The body: AES-256-GCM with a fixed AAD, then the padding.
			aad := devicesig.Message("incognitochat/v2/body", suite)
			equal(t, "body AAD", aad, v.AAD)
			equal(t, "nonce", body[:nonceLen], v.Nonce)
			block, err := aes.NewCipher(contentKey)
			if err != nil {
				t.Fatal(err)
			}
			gcm, err := cipher.NewGCM(block)
			if err != nil {
				t.Fatal(err)
			}
			padded, err := gcm.Open(nil, body[:nonceLen], body[nonceLen:], aad)
			if err != nil {
				t.Fatalf("body doesn't open: %v", err)
			}
			if !slices.Contains(PaddedSizes, len(padded)) {
				t.Fatalf("padded to %d bytes", len(padded))
			}
			length := int(binary.BigEndian.Uint32(padded))
			if length > len(padded)-4 || slices.ContainsFunc(padded[4+length:], func(b byte) bool { return b != 0 }) {
				t.Fatal("bad padding")
			}
			inner := padded[4 : 4+length]

			// The inner message: tag ‖ JSON, the tag an HMAC with a key
			// both sides derive by ECDH.
			tag, msg := inner[:32], inner[32:]
			equal(t, "JSON", msg, []byte(v.JSON))
			equal(t, "tag", tag, v.AuthTag)
			var fields struct{ From, To string }
			if err := json.Unmarshal(msg, &fields); err != nil {
				t.Fatal(err)
			}
			from, err := base64.RawURLEncoding.DecodeString(fields.From)
			if err != nil {
				t.Fatal(err)
			}
			equal(t, "from", from, v.Sender.PublicKey)
			if fields.To != base64.RawURLEncoding.EncodeToString(keyID) {
				t.Fatalf("to = %s", fields.To)
			}
			senderPublic, err := ecdh.P256().NewPublicKey(from)
			if err != nil {
				t.Fatal(err)
			}
			shared, err := recipient.ECDH(senderPublic)
			if err != nil {
				t.Fatal(err)
			}
			sendersShared, err := sender.ECDH(recipient.PublicKey())
			if err != nil {
				t.Fatal(err)
			}
			equal(t, "shared secret", sendersShared, shared)
			authInfo := devicesig.Message("incognitochat/v2/message-auth", suite, from, v.Recipient.PublicKey)
			authKey, err := hkdf.Key(sha256.New, shared, nil, string(authInfo), 32)
			if err != nil {
				t.Fatal(err)
			}
			mac := hmac.New(sha256.New, authKey)
			mac.Write(msg)
			equal(t, "computed tag", mac.Sum(nil), tag)
		})
	}
}

func TestClientTagVectors(t *testing.T) {
	v := loadVectors(t)
	// Sender tags: HMAC-SHA256(account secret, Message("…/sender-tag", link fingerprint)).
	for _, s := range v.SenderTags {
		equal(t, "sender tag", hmacSHA256(v.AccountSecret, "incognitochat/v2/sender-tag", []byte(s.LinkFingerprint)), s.Tag)
	}
	// ID tags: the first 9 bytes of HMAC-SHA256(account secret,
	// Message("…/local-id-tag", conversation, message ID)), base64url.
	for _, s := range v.IDTags {
		got := base64.RawURLEncoding.EncodeToString(hmacSHA256(v.AccountSecret, "incognitochat/v2/local-id-tag", []byte(s.Conv), []byte(s.ID))[:9])
		if got != s.Tag {
			t.Errorf("ID tag of %s in %s = %s, want %s", s.ID, s.Conv, got, s.Tag)
		}
	}
}
