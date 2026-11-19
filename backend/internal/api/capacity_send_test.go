package api

import (
	"net/http"
	"testing"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/envelope"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
)

// What a send costs the messages table, to store and to confirm, per
// token it pays with, by size, measured (DLV-4, SCL-3). Before envelopes
// were priced by size, every one cost one token, so a token bought up to
// 19 write units to store and 19 to delete; now at most 3 of each.
func TestSendCostPerToken(t *testing.T) {
	h, tb := newDeliveryTables(t)
	owner := h.account(t, userID)
	_, out := h.as(t, owner, http.MethodPost, "/mailboxes", map[string]any{"count": 1}, false)
	box := out["mailboxes"].([]any)[0]
	for _, c := range []struct {
		wraps, padded int
		what          string
	}{
		{1, 512, "app: short text, receipt, reaction, edit, delete"},
		{1, 2048, "app: longer text, attachment, receipt of up to 68"},
		{1, 8192, "app: text up to about 7,800 bytes"},
		{1, 16384, "app: text up to 12,000 bytes"},
		{envelope.MaxWraps, 512, "16 wraps"},
		{envelope.MaxWraps, 2048, "16 wraps"},
		{envelope.MaxWraps, 16384, "the largest there can be"},
	} {
		env := testEnvelope(c.wraps, c.padded)
		size := len(env) * 3 / 4
		n := envelope.TokensFor(size)
		tb.meter.Reset()
		if status, out := h.post(t, "/send", map[string]any{"mailbox": box, "envelope": env, "tokens": mintTokens(t, h.now, n)}); status != http.StatusOK {
			t.Fatalf("send: %d %v", status, out)
		}
		put, spend := tb.meter.Units(tb.messages), tb.meter.Units(tb.ephemeral)
		_, page := h.as(t, owner, http.MethodGet, "/inbox", nil, false)
		item := page["items"].([]any)[0].(map[string]any)
		tb.meter.Reset()
		if status, out := h.as(t, owner, http.MethodPost, "/ack", map[string]any{"ids": []string{item["id"].(string)}}, false); status != http.StatusOK {
			t.Fatalf("ack: %d %v", status, out)
		}
		del := tb.meter.Units(tb.messages)
		// The ephemeral table: a write unit per token, and the mailbox's
		// counter.
		t.Logf("%2d wraps, padded %5d, %5d B: %d tokens | messages put %4.1f, delete %4.1f (per token %.1f, before %.1f) | ephemeral %4.1f | %s",
			c.wraps, c.padded, size, n, put.Write, del.Write, put.Write/float64(n), put.Write, spend.Write, c.what)
		if put.Write/float64(n) > 3 || del.Write/float64(n) > 3 {
			t.Errorf("%d B: %.1f write units to store and %.1f to delete for %d tokens", size, put.Write, del.Write, n)
		}
		if spend.Write != float64(n+1) {
			t.Errorf("%d tokens cost the ephemeral table %.1f write units", n, spend.Write)
		}
		if c.wraps == 1 && c.padded <= 2048 && n != 1 {
			t.Errorf("an ordinary envelope costs %d tokens", n)
		}
		h.now = h.now.Add(time.Second)
	}
}

// On the real tables: a send refused by a capped mailbox, on an instance
// that didn't know it was capped, gives back every token, each once.
func TestSendAtCapGivesBackEveryTokenOnce(t *testing.T) {
	h, tb := newDeliveryTables(t)
	mailbox := ids.New()
	for range SendsPerMailboxPerMinute {
		if status, out := h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": clientEnvelope(t), "tokens": mintTokens(t, h.now, 1)}); status != http.StatusOK {
			t.Fatalf("send: %d %v", status, out)
		}
	}
	largest := testEnvelope(envelope.MaxWraps, 16384)
	// Each try on another instance, new to the minute.
	refused := func(paid []string) {
		t.Helper()
		status, out := h.postOn(t, tb.instance(h), "/send", map[string]any{"mailbox": mailbox, "envelope": largest, "tokens": paid})
		wantError(t, status, out, http.StatusTooManyRequests, "rate_limited")
	}
	once, twice := mintTokens(t, h.now, envelope.MaxTokens), mintTokens(t, h.now, envelope.MaxTokens)
	refused(once)
	refused(twice)
	refused(twice)
	h.now = h.now.Add(time.Minute)
	// Given back once: all good.
	if status, out := h.post(t, "/send", map[string]any{"mailbox": ids.New(), "envelope": largest, "tokens": once}); status != http.StatusOK {
		t.Fatalf("tokens given back: %d %v", status, out)
	}
	// Refused twice: the second time, they stayed spent.
	status, out := h.post(t, "/send", map[string]any{"mailbox": ids.New(), "envelope": largest, "tokens": twice})
	wantError(t, status, out, http.StatusUnauthorized, "invalid_token")
}

// What a send refused for a spent token costs, on instances new to it: a
// write unit for the refusal and one for each token before the spent one,
// which are burned. A list can't keep fresh tokens unspent behind a spent
// one and be tried again with them, for 2 write units a token each time,
// as a cancelled transaction would cost.
func TestRefusedSendCost(t *testing.T) {
	h, tb := newDeliveryTables(t)
	largest := testEnvelope(envelope.MaxWraps, 16384)
	spent := mintToken(t, h.now)
	if status, out := h.post(t, "/send", map[string]any{"mailbox": ids.New(), "envelope": clientEnvelope(t), "token": spent}); status != http.StatusOK {
		t.Fatalf("send: %d %v", status, out)
	}
	refused := func(what string, tokens []string, want float64) {
		t.Helper()
		tb.meter.Reset()
		status, out := h.postOn(t, tb.instance(h), "/send", map[string]any{"mailbox": ids.New(), "envelope": largest, "tokens": tokens})
		wantError(t, status, out, http.StatusUnauthorized, "invalid_token")
		m, e := tb.cost(t, what)
		if e.Write != want || m.Write != 0 {
			t.Fatalf("%s: ephemeral %.1f write units (want %.0f), messages %.1f", what, e.Write, want, m.Write)
		}
	}
	fillers := mintTokens(t, h.now, envelope.MaxTokens-1)
	// The spent token first: one write unit, and the fillers untouched.
	refused("POST /send, a spent token, then 7 fresh", append([]string{spent}, fillers...), 1)
	// They're still good: a send with them and one more goes through.
	paid := append(append([]string{}, fillers...), mintToken(t, h.now))
	if status, out := h.postOn(t, tb.instance(h), "/send", map[string]any{"mailbox": ids.New(), "envelope": largest, "tokens": paid}); status != http.StatusOK {
		t.Fatalf("the fillers after the spent token: %d %v", status, out)
	}
	// The spent token last: the 7 before it are burned.
	fillers = mintTokens(t, h.now, envelope.MaxTokens-1)
	refused("POST /send, 7 fresh, then a spent token", append(append([]string{}, fillers...), spent), 8)
	// Tried again with them, anywhere: refused at the first, for one write unit.
	refused("POST /send, the 7 burned again, then a fresh one", append(append([]string{}, fillers...), mintToken(t, h.now)), 1)
}

// postOn makes a request without logging in on r: another instance.
func (h *harness) postOn(t *testing.T, r *httpapi.Router, path string, body any) (int, map[string]any) {
	t.Helper()
	saved := h.router
	h.router = r
	defer func() { h.router = saved }()
	return h.post(t, path, body)
}
