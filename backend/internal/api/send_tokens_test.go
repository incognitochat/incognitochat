package api

import (
	"encoding/base64"
	"net/http"
	"testing"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/envelope"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
)

// testEnvelope is an envelope with a valid layout: wraps, and an inner
// message padded to padded bytes.
func testEnvelope(wraps, padded int) string {
	env := make([]byte, 2+wraps*envelope.WrapLen+12+padded+16)
	env[0], env[1] = envelope.Suite, byte(wraps)
	return base64.RawURLEncoding.EncodeToString(env)
}

// An envelope costs a token per started 2.5 KiB, and every token is
// checked, and their number, before any is spent (DLV-4).
func TestSendPricedBySize(t *testing.T) {
	h := newHarness(t)
	spent := h.server.Spent.(*memSpent)
	largest := testEnvelope(envelope.MaxWraps, 16384)
	send := func(env string, body map[string]any) (int, map[string]any) {
		body["mailbox"], body["envelope"] = ids.New(), env
		return h.post(t, "/send", body)
	}

	// One token for the largest envelope, as an app from before sends it:
	// refused, with what it costs, before anything is spent.
	one := mintToken(t, h.now)
	before := spent.calls
	status, out := send(largest, map[string]any{"token": one})
	wantError(t, status, out, http.StatusPaymentRequired, "tokens_needed")
	if out["needed"] != float64(envelope.MaxTokens) || spent.calls != before {
		t.Fatalf("one token: %v, %d spend calls", out, spent.calls-before)
	}
	seven := mintTokens(t, h.now, envelope.MaxTokens-1)
	status, out = send(largest, map[string]any{"tokens": seven})
	wantError(t, status, out, http.StatusPaymentRequired, "tokens_needed")
	// Too many is answered the same way, so an app from before a price cut
	// pays the new price.
	status, out = send(largest, map[string]any{"tokens": append(mintTokens(t, h.now, envelope.MaxTokens), one)})
	wantError(t, status, out, http.StatusPaymentRequired, "tokens_needed")
	if out["needed"] != float64(envelope.MaxTokens) {
		t.Fatalf("too many: %v", out)
	}
	status, out = send(testEnvelope(1, 512), map[string]any{"tokens": mintTokens(t, h.now, 2)})
	wantError(t, status, out, http.StatusPaymentRequired, "tokens_needed")
	if out["needed"] != float64(1) {
		t.Fatalf("two for a small envelope: %v", out)
	}
	status, out = send(largest, map[string]any{"token": one, "tokens": seven})
	wantError(t, status, out, http.StatusBadRequest, "bad_request")
	if spent.calls != before || spent.count(t, append([]string{one}, seven...)) != 0 {
		t.Fatal("a refused send spent tokens")
	}

	// A batch with one bad token, or one token twice, spends none.
	bad := append(append([]string{}, seven...), b64(randomBytes(t, 354)))
	status, out = send(largest, map[string]any{"tokens": bad})
	wantError(t, status, out, http.StatusUnauthorized, "invalid_token")
	twice := append(append([]string{}, seven...), seven[0])
	status, out = send(largest, map[string]any{"tokens": twice})
	wantError(t, status, out, http.StatusUnauthorized, "invalid_token")
	if spent.calls != before {
		t.Fatal("a batch with a bad token was spent")
	}
	// One of them spent already: refused. The ones before it are burned,
	// so they can't be sent along with a spent token again and again; the
	// ones after it aren't tried.
	if status, out := send(testEnvelope(1, 512), map[string]any{"tokens": []string{one}}); status != http.StatusOK {
		t.Fatalf("small send: %d %v", status, out)
	}
	mixed := append(append(append([]string{}, seven[:3]...), one), seven[3:]...)
	status, out = send(largest, map[string]any{"tokens": mixed})
	wantError(t, status, out, http.StatusUnauthorized, "invalid_token")
	if burned, kept := spent.count(t, seven[:3]), spent.count(t, seven[3:]); burned != 3 || kept != 0 {
		t.Fatalf("a batch with a spent token: %d burned before it, %d after", burned, kept)
	}
	status, out = send(largest, map[string]any{"tokens": append(append([]string{}, seven[:3]...), mintTokens(t, h.now, 5)...)})
	wantError(t, status, out, http.StatusUnauthorized, "invalid_token")

	// With what it costs, it's delivered, and exactly that many are spent.
	eight := mintTokens(t, h.now, envelope.MaxTokens)
	if status, out := send(largest, map[string]any{"tokens": eight}); status != http.StatusOK {
		t.Fatalf("paid send: %d %v", status, out)
	}
	if n := spent.count(t, eight); n != envelope.MaxTokens {
		t.Fatalf("spent %d of the 8", n)
	}
	status, out = send(largest, map[string]any{"tokens": eight})
	wantError(t, status, out, http.StatusUnauthorized, "invalid_token")

	// The app's ordinary envelopes cost one, sent either way.
	for _, env := range []string{testEnvelope(1, 512), testEnvelope(1, 2048), clientEnvelope(t)} {
		if status, out := send(env, map[string]any{"tokens": mintTokens(t, h.now, 1)}); status != http.StatusOK {
			t.Fatalf("ordinary envelope: %d %v", status, out)
		}
		if status, out := send(env, map[string]any{"token": mintToken(t, h.now)}); status != http.StatusOK {
			t.Fatalf("ordinary envelope, one token as before: %d %v", status, out)
		}
	}
	status, out = send(testEnvelope(1, 8192), map[string]any{"tokens": mintTokens(t, h.now, 1)})
	wantError(t, status, out, http.StatusPaymentRequired, "tokens_needed")
	if out["needed"] != float64(4) {
		t.Fatalf("an 8 KiB envelope needs %v", out["needed"])
	}
	// None at all is still invalid_token.
	status, out = send(largest, map[string]any{"tokens": []string{}})
	wantError(t, status, out, http.StatusUnauthorized, "invalid_token")
}

// forgetful is a limiter that never knows beforehand that a mailbox is at
// its cap: another instance, new to the minute.
type forgetful struct{ *memLimiter }

func (forgetful) Full(string, int, time.Duration) bool { return false }

func (forgetful) FullAt(string, int, time.Duration, time.Time) bool { return false }

// A send refused by a capped mailbox the instance didn't know about gives
// back every token it paid with (#106).
func TestSendAtCapGivesBackEveryToken(t *testing.T) {
	h := newHarness(t)
	limits := h.server.Limits.(*memLimiter)
	h.server.Limits = forgetful{limits}
	spent := h.server.Spent.(*memSpent)
	mailbox := ids.New()
	for range SendsPerMailboxPerMinute {
		h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": clientEnvelope(t), "token": mintToken(t, h.now)})
	}
	largest := testEnvelope(envelope.MaxWraps, 16384)
	paid := mintTokens(t, h.now, envelope.MaxTokens)
	before := spent.calls
	status, out := h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": largest, "tokens": paid})
	wantError(t, status, out, http.StatusTooManyRequests, "rate_limited")
	// Spent first (the instance didn't know the cap), then given back.
	if spent.calls-before != envelope.MaxTokens {
		t.Fatalf("%d tokens were spent before the cap refused the send", spent.calls-before)
	}
	if n := spent.count(t, paid); n != 0 {
		t.Fatalf("%d tokens stayed spent", n)
	}
	h.now = h.now.Add(time.Minute)
	limits.counts = map[string]int{}
	if status, out := h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": largest, "tokens": paid}); status != http.StatusOK {
		t.Fatalf("next minute: %d %v", status, out)
	}
}
