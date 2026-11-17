package api

import (
	"encoding/base64"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/session"
)

// fill delivers n envelopes to m's device and returns their item IDs, as
// GET /inbox lists them.
func (h *harness) fill(t *testing.T, m member, n int) []string {
	t.Helper()
	// Several mailboxes, each under its cap of SendsPerMailboxPerMinute.
	_, out := h.as(t, m, http.MethodPost, "/mailboxes", map[string]any{"count": MailboxBatch}, false)
	mailboxes := out["mailboxes"].([]any)
	env := clientEnvelope(t)
	for i := range n {
		mailbox := mailboxes[i%len(mailboxes)]
		if status, out := h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": env, "token": mintToken(t, h.now)}); status != http.StatusOK {
			t.Fatalf("send: %d %v", status, out)
		}
	}
	var got []string
	for after := ""; ; {
		path := "/inbox"
		if after != "" {
			path += "?after=" + after
		}
		status, out := h.as(t, m, http.MethodGet, path, nil, false)
		if status != http.StatusOK {
			t.Fatalf("inbox: %d %v", status, out)
		}
		for _, it := range out["items"].([]any) {
			got = append(got, it.(map[string]any)["id"].(string))
		}
		if out["more"] != true {
			return got
		}
		after = out["next"].(string)
	}
}

func (h *harness) inboxSize(m member) int {
	h.inbox.mu.Lock()
	defer h.inbox.mu.Unlock()
	return len(h.inbox.items[m.d.account+"#"+m.d.id])
}

// Pages come InboxPage at a time, each saying where the next starts.
func TestInboxPages(t *testing.T) {
	h := newHarness(t)
	m := h.account(t, userID)
	got := h.fill(t, m, InboxPage+10)
	seen := map[string]bool{}
	for _, id := range got {
		seen[id] = true
	}
	if len(got) != InboxPage+10 || len(seen) != len(got) {
		t.Fatalf("paged through %d items, %d distinct", len(got), len(seen))
	}
	status, out := h.as(t, m, http.MethodGet, "/inbox?after=x", nil, false)
	wantError(t, status, out, http.StatusBadRequest, "bad_request")
}

// POST /ack takes only IDs that GET /inbox gave this device: anything else
// is refused before a delete is tried, since each one costs the table a
// write even when there's nothing to delete.
func TestAckTakesOnlyListedIDs(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	m := h.account(t, userID)
	other := h.account(t, userID+1)
	listed := h.fill(t, m, 3)

	forged := func() string {
		raw, _ := base64.RawURLEncoding.DecodeString(listed[0])
		raw[0] ^= 1 // another item, with this one's MAC
		return base64.RawURLEncoding.EncodeToString(raw)
	}()
	cheaper := func() string {
		raw, _ := base64.RawURLEncoding.DecodeString(listed[0])
		raw[16] = 0 // claims to cost nothing
		return base64.RawURLEncoding.EncodeToString(raw)
	}()
	random := make([]string, AckBatch)
	for i := range random {
		random[i] = ids.New()
	}
	for name, batch := range map[string][]string{
		"random IDs":            random,
		"another item's MAC":    {forged},
		"units changed":         {cheaper},
		"a listed one, and one": {listed[0], forged},
		"more than a page":      append(append([]string{}, listed...), random...),
	} {
		status, out := h.as(t, m, http.MethodPost, "/ack", map[string]any{"ids": batch}, false)
		if status != http.StatusBadRequest || out["error"] != "bad_request" {
			t.Fatalf("%s: %d %v", name, status, out)
		}
	}
	// Another device can't confirm them either.
	status, out := h.as(t, other, http.MethodPost, "/ack", map[string]any{"ids": listed}, false)
	wantError(t, status, out, http.StatusBadRequest, "bad_request")
	if n := h.inboxSize(m); n != 3 {
		t.Fatalf("%d items left, want 3", n)
	}

	// The real ones, one of them twice, are deleted.
	status, out = h.as(t, m, http.MethodPost, "/ack", map[string]any{"ids": append(listed, listed[0])}, false)
	if status != http.StatusOK {
		t.Fatalf("ack: %d %v", status, out)
	}
	if n := h.inboxSize(m); n != 0 {
		t.Fatalf("%d items left", n)
	}
}

// What a device's fetches cost counts against its minute; confirming
// items that are there counts against nothing, and writes no counter.
func TestInboxAndAckLimits(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	m := h.account(t, userID)
	listed := h.fill(t, m, 2)
	limits := h.server.Limits.(*memLimiter)
	inboxKey := h.server.rateName("inbox", h.now, time.Minute, m.d.account, m.d.id)

	// Confirmations of items that are there: no counter at all.
	before := len(limits.counts)
	if status, out := h.as(t, m, http.MethodPost, "/ack", map[string]any{"ids": listed[:1]}, false); status != http.StatusOK {
		t.Fatalf("ack: %d %v", status, out)
	}
	if len(limits.counts) != before {
		t.Fatalf("a confirmation wrote a counter: %v", limits.counts)
	}

	// Fetches: at least MinRequestUnits each.
	if n := limits.counts[inboxKey]; n < MinRequestUnits {
		t.Fatalf("a fetch counted %d", n)
	}
	var status int
	var out map[string]any
	// Fetches: once the minute's units are used, refused before reading.
	limits.counts[inboxKey] = InboxUnitsPerMinute
	status, out = h.as(t, m, http.MethodGet, "/inbox", nil, false)
	wantError(t, status, out, http.StatusTooManyRequests, "rate_limited")

	// The counters name neither the account nor the device.
	for key := range limits.counts {
		for _, id := range []string{m.d.account, m.d.id} {
			if strings.Contains(key, id) {
				t.Fatalf("counter %q names %s", key, id)
			}
		}
	}
	// Other devices have their own.
	other := h.account(t, userID+1)
	if status, out := h.as(t, other, http.MethodGet, "/inbox", nil, false); status != http.StatusOK {
		t.Fatalf("another device: %d %v", status, out)
	}
	// So does the next minute.
	h.now = h.now.Add(time.Minute)
	if status, out := h.as(t, m, http.MethodGet, "/inbox", nil, false); status != http.StatusOK {
		t.Fatalf("the next minute: %d %v", status, out)
	}
}

// A rate counter's name is a keyed hash of who it counts and its window:
// each minute's differs from the last, so a copy of the table can't chain
// one device's fetches or confirmations into a timeline.
func TestRateNames(t *testing.T) {
	h := newHarness(t)
	s := h.server
	names := map[string]bool{
		s.rateName("inbox", h.now, time.Minute, "account", "device"):                  true,
		s.rateName("inbox", h.now.Add(time.Minute), time.Minute, "account", "device"): true,
		s.rateName("inbox", h.now, time.Minute, "account", "other"):                   true,
		s.rateName("ackmiss", h.now, time.Minute, "account", "device"):                true,
	}
	if len(names) != 4 {
		t.Fatalf("names repeat: %v", names)
	}
	// Within the window, it stays.
	if s.rateName("inbox", h.now, time.Minute, "account", "device") != s.rateName("inbox", h.now.Add(59*time.Second), time.Minute, "account", "device") {
		t.Fatal("a name changed within its minute")
	}
	for name := range names {
		if strings.Contains(name, "account") || strings.Contains(name, "device") {
			t.Fatalf("%q names who it counts", name)
		}
	}
}

// An item listed again within the hour has the same ID, so the app can
// tell what it has just confirmed; an ID from before the last hour is
// taken without deleting anything.
func TestItemIDsAge(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	m := h.account(t, userID)
	first := h.fill(t, m, 2)
	h.now = h.now.Add(30 * time.Minute)
	m.token = h.token(t, m.d)
	if again := h.fill(t, m, 0); len(again) != 2 || !sameSet(again, first) {
		t.Fatalf("listed again within the hour: %v, then %v", first, again)
	}
	h.now = h.now.Add(2 * time.Hour)
	m.token = h.token(t, m.d)
	later := h.fill(t, m, 0)
	if sameSet(later, first) {
		t.Fatal("the same IDs two hours later")
	}
	// The old IDs: taken, nothing deleted, counted as misses.
	limits := h.server.Limits.(*memLimiter)
	c := caller{Claims: session.Claims{AccountID: m.d.account, DeviceID: m.d.id}}
	c.device, _ = h.dir.Device(t.Context(), m.d.account, m.d.id, h.now)
	day := h.server.rateName("ackmiss", h.now, 24*time.Hour, c.person())
	if status, out := h.as(t, m, http.MethodPost, "/ack", map[string]any{"ids": first}, false); status != http.StatusOK {
		t.Fatalf("old IDs: %d %v", status, out)
	}
	if n := h.inboxSize(m); n != 2 || limits.counts[day] != 2 {
		t.Fatalf("old IDs: %d items left, %d misses counted", n, limits.counts[day])
	}
	// Listed twice in one batch, an item goes by its latest ID.
	if status, out := h.as(t, m, http.MethodPost, "/ack", map[string]any{"ids": append(append([]string{}, first...), later...)}, false); status != http.StatusOK || h.inboxSize(m) != 0 {
		t.Fatalf("old and new IDs: %d %v, %d items left", status, out, h.inboxSize(m))
	}
	if n := limits.counts[day]; n != 2 {
		t.Fatalf("%d misses counted, want still 2", n)
	}
}

func sameSet(a, b []string) bool {
	in := map[string]bool{}
	for _, x := range a {
		in[x] = true
	}
	for _, x := range b {
		if !in[x] {
			return false
		}
	}
	return len(a) == len(b)
}

// Confirming items that aren't there counts against the person's day.
// Past AckMissesPerDay, confirmations delete nothing (and answer as
// usual) until the next UTC day; confirming items that are there costs the
// day nothing.
func TestAckMissesPerDay(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	m := h.account(t, userID)
	c := caller{Claims: session.Claims{AccountID: m.d.account, DeviceID: m.d.id}}
	c.device, _ = h.dir.Device(t.Context(), m.d.account, m.d.id, h.now)
	limits := h.server.Limits.(*memLimiter)
	day := func() string { return h.server.rateName("ackmiss", h.now, 24*time.Hour, c.person()) }

	listed := h.fill(t, m, 3)
	if status, out := h.as(t, m, http.MethodPost, "/ack", map[string]any{"ids": listed[:2]}, false); status != http.StatusOK {
		t.Fatalf("ack: %d %v", status, out)
	}
	if n := limits.counts[day()]; n != 0 {
		t.Fatalf("confirming items that are there counted %d misses", n)
	}
	// Again: both are gone now.
	h.as(t, m, http.MethodPost, "/ack", map[string]any{"ids": listed[:2]}, false)
	if n := limits.counts[day()]; n != 2 {
		t.Fatalf("%d misses counted, want 2", n)
	}

	// The day's misses used up: taken, nothing deleted.
	limits.counts[day()] = AckMissesPerDay
	if status, out := h.as(t, m, http.MethodPost, "/ack", map[string]any{"ids": listed[2:]}, false); status != http.StatusOK || h.inboxSize(m) != 1 {
		t.Fatalf("past the day's misses: %d %v, %d items left", status, out, h.inboxSize(m))
	}
	// Tomorrow it goes.
	h.now = h.now.Truncate(24 * time.Hour).Add(24 * time.Hour)
	m.token = h.token(t, m.d)
	again := h.fill(t, m, 0)
	if status, out := h.as(t, m, http.MethodPost, "/ack", map[string]any{"ids": again}, false); status != http.StatusOK || h.inboxSize(m) != 0 {
		t.Fatalf("the next day: %d %v, %d items left", status, out, h.inboxSize(m))
	}
}

// A confirmation whose deletes partly fail answers with the IDs to send
// again, and only those: items it did delete aren't confirmed twice, as
// missing, so a throttled table can't use up a person's day.
func TestAckRetriesFailed(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	m := h.account(t, userID)
	listed := h.fill(t, m, 3)
	limits := h.server.Limits.(*memLimiter)
	c := caller{Claims: session.Claims{AccountID: m.d.account, DeviceID: m.d.id}}
	c.device, _ = h.dir.Device(t.Context(), m.d.account, m.d.id, h.now)
	day := h.server.rateName("ackmiss", h.now, 24*time.Hour, c.person())

	h.inbox.mu.Lock()
	key := h.inbox.items[m.d.account+"#"+m.d.id][1].ID
	h.inbox.failing = map[string]bool{key: true}
	h.inbox.mu.Unlock()
	status, out := h.as(t, m, http.MethodPost, "/ack", map[string]any{"ids": listed}, false)
	retry, _ := out["retry"].([]any)
	if status != http.StatusOK || len(retry) != 1 || h.inboxSize(m) != 1 {
		t.Fatalf("partly failed: %d %v, %d left", status, out, h.inboxSize(m))
	}
	h.inbox.mu.Lock()
	h.inbox.failing = nil
	h.inbox.mu.Unlock()
	if status, out := h.as(t, m, http.MethodPost, "/ack", map[string]any{"ids": retry}, false); status != http.StatusOK || out["retry"] != nil || h.inboxSize(m) != 0 {
		t.Fatalf("again: %d %v, %d left", status, out, h.inboxSize(m))
	}
	if n := limits.counts[day]; n != 0 {
		t.Fatalf("%d misses counted", n)
	}
	// All failed: an error, to try again.
	more := h.fill(t, m, 1)
	h.inbox.mu.Lock()
	h.inbox.failing = map[string]bool{h.inbox.items[m.d.account+"#"+m.d.id][0].ID: true}
	h.inbox.mu.Unlock()
	status, out = h.as(t, m, http.MethodPost, "/ack", map[string]any{"ids": more}, false)
	wantError(t, status, out, http.StatusInternalServerError, "internal")
}

// A person's fetches are limited per day too; an empty inbox still
// answers.
func TestInboxPerDay(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	m := h.account(t, userID)
	c := caller{Claims: session.Claims{AccountID: m.d.account, DeviceID: m.d.id}}
	c.device, _ = h.dir.Device(t.Context(), m.d.account, m.d.id, h.now)
	limits := h.server.Limits.(*memLimiter)
	day := h.server.rateName("inboxday", h.now, 24*time.Hour, c.person())

	h.fill(t, m, 3)
	if n := limits.counts[day]; n < 1 {
		t.Fatalf("a fetch counted %d for the day", n)
	}
	limits.counts[day] = InboxUnitsPerDay - 1
	h.now = h.now.Add(time.Minute)
	status, out := h.as(t, m, http.MethodGet, "/inbox", nil, false)
	if status != http.StatusOK {
		t.Fatalf("the day's last: %d %v", status, out)
	}
	h.now = h.now.Add(time.Minute)
	status, out = h.as(t, m, http.MethodGet, "/inbox", nil, false)
	wantError(t, status, out, http.StatusTooManyRequests, "daily_limit")
	// Tomorrow it goes on.
	h.now = h.now.Truncate(24 * time.Hour).Add(24 * time.Hour)
	m.token = h.token(t, m.d)
	if status, out := h.as(t, m, http.MethodGet, "/inbox", nil, false); status != http.StatusOK {
		t.Fatalf("the next day: %d %v", status, out)
	}
	// The answer says when the day ends.
	resp := dailyLimited(time.Date(2027, 1, 1, 23, 0, 0, 0, time.UTC))
	if resp.StatusCode != http.StatusTooManyRequests || !strings.Contains(resp.Body, `"daily_limit"`) || resp.Headers["retry-after"] != "3600" {
		t.Fatalf("daily_limit answer: %d %s %v", resp.StatusCode, resp.Body, resp.Headers)
	}
}

// A send to a mailbox known to be at its cap is refused before its token
// is spent, and a token is given back only once: one token can no longer
// be replayed against a capped mailbox forever (#106).
func TestSendAtCapKeepsToken(t *testing.T) {
	h := newHarness(t)
	spent := h.server.Spent.(*memSpent)
	mailbox := ids.New()
	env := clientEnvelope(t)
	for range SendsPerMailboxPerMinute {
		h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": env, "token": mintToken(t, h.now)})
	}
	before := spent.calls
	token := mintToken(t, h.now)
	for range 5 {
		status, out := h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": env, "token": token})
		wantError(t, status, out, http.StatusTooManyRequests, "rate_limited")
	}
	// Not spent and given back: not tried at all.
	if spent.calls != before {
		t.Fatalf("refused sends tried to spend their token %d times", spent.calls-before)
	}
	// Next minute, the token works.
	h.now = h.now.Add(time.Minute)
	h.server.Limits.(*memLimiter).counts = map[string]int{}
	if status, out := h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": env, "token": token}); status != http.StatusOK {
		t.Fatalf("next minute: %d %v", status, out)
	}
}
