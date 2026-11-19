package devicelist_test

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"testing"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/devicelist"
	"github.com/incognitochat/incognitochat/backend/internal/devicelist/devicelisttest"
	"github.com/incognitochat/incognitochat/backend/internal/devicesig"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
)

// Parse accepts only well-formed lists, in the one encoding the app writes
// (devicelisttest.Encode, as web/src/protocol/device-list.ts), and Verify
// accepts none of them without the account key's signature.
func FuzzParse(f *testing.F) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		f.Fatal(err)
	}
	raw, _ := key.PublicKey.Bytes()
	l := devicelist.List{
		Seq:     1,
		Issued:  issued,
		Expires: issued.Add(devicelist.MaxValidity),
		Entries: []devicelist.Entry{{DeviceID: ids.New(), Key: raw, Added: issued}},
	}
	one := devicelisttest.Encode(l)
	f.Add(one)
	l.Seq, l.Prev = 7, sha256.Sum256(one)
	l.Entries = append(l.Entries, devicelist.Entry{DeviceID: ids.New(), Key: raw, Added: issued.Add(-time.Hour)})
	f.Add(devicelisttest.Encode(l))
	l.Entries = l.Entries[:1]
	l.Expires = l.Issued // not after it was issued
	f.Add(devicelisttest.Encode(l))
	f.Add(devicesig.Message(devicesig.LabelDeviceList))
	f.Add(devicesig.Message(devicesig.LabelSession, []byte{devicesig.Suite}))
	f.Fuzz(func(t *testing.T, b []byte) {
		l, err := devicelist.Parse(b)
		if err != nil {
			if _, verr := devicelist.Verify(b, make([]byte, devicesig.SignatureLen), &key.PublicKey); verr == nil {
				t.Fatal("Verify accepted what Parse refuses")
			}
			return
		}
		if len(l.Entries) == 0 || len(l.Entries) > devicelist.MaxDevices || l.Seq == 0 {
			t.Fatalf("accepted %d entries, sequence %d", len(l.Entries), l.Seq)
		}
		if !l.Issued.Before(l.Expires) || l.Expires.Sub(l.Issued) > devicelist.MaxValidity {
			t.Fatalf("accepted validity %s to %s", l.Issued, l.Expires)
		}
		seen := map[string]bool{}
		for _, e := range l.Entries {
			if !ids.Valid(e.DeviceID) || seen[e.DeviceID] || e.Added.After(l.Issued) {
				t.Fatalf("accepted entry %+v", e)
			}
			seen[e.DeviceID] = true
			if _, err := devicesig.ParsePublicKey(e.Key); err != nil {
				t.Fatalf("accepted key %x", e.Key)
			}
		}
		if !bytes.Equal(devicelisttest.Encode(l), b) {
			t.Fatalf("Parse accepted %x, which the app doesn't write", b)
		}
		// Only the account key's signature makes it valid.
		sig := sign(t, key, b)
		if _, err := devicelist.Verify(b, sig, &key.PublicKey); err != nil {
			t.Fatalf("a signed list was refused: %v", err)
		}
		sig[0] ^= 1
		if _, err := devicelist.Verify(b, sig, &key.PublicKey); err == nil {
			t.Fatal("a changed signature verified")
		}
		if _, err := devicelist.Verify(b, make([]byte, devicesig.SignatureLen), &key.PublicKey); err == nil {
			t.Fatal("a zero signature verified")
		}
	})
}
