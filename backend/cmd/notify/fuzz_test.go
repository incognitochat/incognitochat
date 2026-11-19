package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"testing"

	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/notices"
)

// Any event: handle never panics, seals only a positive chat ID (sealed so
// that it opens to the same ID), and asks for a notice only for a
// well-formed account ID, the one the event names.
func FuzzHandle(f *testing.F) {
	sealer, err := notices.NewSealer(bytes.Repeat([]byte("k"), 32))
	if err != nil {
		f.Fatal(err)
	}
	f.Add(`{"seal":{"chat":4242}}`)
	f.Add(`{"seal":{"chat":-1}}`)
	f.Add(`{"seal":{"chat":1e3}}`)
	f.Add(`{"notify":{"account":"AAAAAAAAAAAAAAAAAAAAAA"}}`)
	f.Add(`{"notify":{"account":"AAAAAAAAAAAAAAAAAAAAA\r"}}`)
	f.Add(`{"notify":{"account":""}}`)
	f.Add(`{"seal":{"chat":1},"notify":{"account":"x"}}`)
	f.Add(`{"SEAL":{"CHAT":7}}`)
	f.Add(`{"check":{}}`)
	f.Add(`[`)
	f.Fuzz(func(t *testing.T, raw string) {
		n := &fakeNotifier{}
		out, err := handle(context.Background(), json.RawMessage(raw), sealer, n)
		var e notices.Event
		_ = json.Unmarshal([]byte(raw), &e)
		if n.notified != "" && (!ids.Valid(n.notified) || e.Notify == nil || n.notified != e.Notify.Account) {
			t.Fatalf("%q: notice asked for %q", raw, n.notified)
		}
		res, ok := out.(notices.SealResult)
		if !ok {
			return
		}
		if err != nil || e.Seal == nil || e.Seal.Chat <= 0 {
			t.Fatalf("%q: sealed (%v)", raw, err)
		}
		sealed, err := base64.RawURLEncoding.Strict().DecodeString(res.Sealed)
		if err != nil {
			t.Fatalf("sealed as %q", res.Sealed)
		}
		if chat, err := sealer.Open(sealed); err != nil || chat != e.Seal.Chat {
			t.Fatalf("%q: sealed %d, opens to %d (%v)", raw, e.Seal.Chat, chat, err)
		}
	})
}
