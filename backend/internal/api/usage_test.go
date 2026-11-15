package api

import (
	"net/http"
	"testing"
	"time"
)

func TestUsage(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	m := h.account(t, userID)
	status, out := h.as(t, m, http.MethodGet, "/usage", nil, false)
	if status != http.StatusOK {
		t.Fatalf("usage: %d %v", status, out)
	}
	want := func(name string, used, limit int) {
		t.Helper()
		item, _ := out[name].(map[string]any)
		if item["used"] != float64(used) || item["limit"] != float64(limit) {
			t.Errorf("%s = %v; want %d of %d", name, item, used, limit)
		}
	}
	want("send", 0, TokensPerDay)
	want("mailboxes", 0, MailboxesPerDay)
	want("owned", 0, MaxMailboxes)
	if out["resetsAt"] != float64(h.now.Truncate(24*time.Hour).Add(24*time.Hour).Unix()) {
		t.Errorf("resetsAt = %v", out["resetsAt"])
	}

	// Some of the day used: mailboxes, a link, tokens.
	if status, out := h.as(t, m, http.MethodPost, "/mailboxes", map[string]any{"count": 5}, false); status != http.StatusCreated {
		t.Fatalf("mailboxes: %d %v", status, out)
	}
	if status, out := h.as(t, m, http.MethodPost, "/links", newLinkKeys(t).create(t, h.now), true); status != http.StatusCreated {
		t.Fatalf("link: %d %v", status, out)
	}
	blinded := randomBytes(t, testIssuer().BlindedLen())
	blinded[0] = 0
	if status, out := h.as(t, m, http.MethodPost, "/tokens", map[string]any{"blinded": []string{b64(blinded), b64(blinded)}}, false); status != http.StatusOK {
		t.Fatalf("tokens: %d %v", status, out)
	}
	_, out = h.as(t, m, http.MethodGet, "/usage", nil, false)
	want("send", 2, TokensPerDay)
	want("media", 0, MediaTokensPerDay)
	want("mailboxes", 5, MailboxesPerDay)
	want("linkChanges", 1, LinkChangesPerDay)
	want("owned", 5, MaxMailboxes)

	// Needs a login.
	status, out = h.call(t, nil, "", http.MethodGet, "/usage", nil, false)
	wantError(t, status, out, http.StatusUnauthorized, "session_expired")
}
