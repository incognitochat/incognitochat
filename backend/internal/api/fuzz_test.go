package api

import (
	"bytes"
	"encoding/base64"
	"strconv"
	"strings"
	"testing"
)

// Every byte field of a request is base64url without padding. Whatever is
// accepted decodes to bytes that encode and decode back to themselves.
func FuzzBytes64(f *testing.F) {
	for _, seed := range []string{`"AAAA"`, `"AAAB"`, `"AA=="`, `"AA"`, `"A"`, `"A\r\nAAA"`, `""`, `null`, `1`, `"-_"`} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, s string) {
		var b bytes64
		if err := b.UnmarshalJSON([]byte(s)); err != nil {
			return
		}
		out, err := b.MarshalJSON()
		if err != nil {
			t.Fatal(err)
		}
		var again bytes64
		if err := again.UnmarshalJSON(out); err != nil || !bytes.Equal(again, b) {
			t.Fatalf("%s decodes to %x, written %s, which decodes to %x (%v)", s, []byte(b), out, []byte(again), err)
		}
	})
}

// The signature header is "<timestamp>.<nonce>.<signature>". Whatever is
// accepted reads back the same when written again with the signature in
// its one encoding.
func FuzzParseSignature(f *testing.F) {
	f.Add("1800000000.AAAAAAAAAAAAAAAAAAAAAA." + strings.Repeat("A", 86))
	f.Add("1800000000..")
	f.Add("+1.x.AA")
	f.Add("-1.x.A")
	f.Add("1.x.y.z")
	f.Fuzz(func(t *testing.T, header string) {
		signed, ok := parseSignature(header)
		if !ok {
			return
		}
		if strings.Contains(signed.Nonce, ".") {
			t.Fatalf("%q: nonce %q", header, signed.Nonce)
		}
		again := strconv.FormatInt(signed.Timestamp, 10) + "." + signed.Nonce + "." + base64.RawURLEncoding.EncodeToString(signed.Signature)
		if back, ok := parseSignature(again); !ok || back.Timestamp != signed.Timestamp || back.Nonce != signed.Nonce || !bytes.Equal(back.Signature, signed.Signature) {
			t.Fatalf("%q reads as %+v; written again %q, as %+v", header, signed, again, back)
		}
	})
}
