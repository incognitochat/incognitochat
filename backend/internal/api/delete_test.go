package api

import (
	"net/http"
	"testing"
	"time"
)

func TestDeleteAccount(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	owner := h.account(t, userID)

	l := newLinkKeys(t)
	if status, out := h.as(t, owner, http.MethodPost, "/links", l.create(t, h.now), true); status != http.StatusCreated {
		t.Fatalf("create link: %d %v", status, out)
	}
	status, out := h.as(t, owner, http.MethodPost, "/mailboxes", map[string]any{"count": 2}, false)
	if status != http.StatusCreated {
		t.Fatalf("mailboxes: %d %v", status, out)
	}
	mailbox := out["mailboxes"].([]any)[0].(string)
	if status, out := h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": clientEnvelope(t), "token": mintToken(t, h.now)}); status != http.StatusOK {
		t.Fatalf("send: %d %v", status, out)
	}

	// Only with a fresh device signature.
	status, out = h.as(t, owner, http.MethodDelete, "/account", nil, false)
	wantError(t, status, out, http.StatusUnauthorized, "signature_rejected")
	if h.dir.accounts[owner.d.account] == nil {
		t.Fatal("deleted without a signature")
	}

	if status, out := h.as(t, owner, http.MethodDelete, "/account", nil, true); status != http.StatusOK || len(out) != 0 {
		t.Fatalf("delete: %d %v", status, out)
	}

	// Everything is gone: the account, its link, its mailboxes and what waited in them.
	if len(h.dir.accounts) != 0 || len(h.dir.links) != 0 || len(h.dir.boxes) != 0 || len(h.dir.telegram) != 0 {
		t.Fatalf("left behind: accounts %d, links %d, mailboxes %d, telegram %d", len(h.dir.accounts), len(h.dir.links), len(h.dir.boxes), len(h.dir.telegram))
	}
	for key, items := range h.inbox.items {
		if len(items) != 0 {
			t.Fatalf("inbox %s still holds %d items", key, len(items))
		}
	}
	status, out = h.call(t, nil, "", http.MethodGet, "/links/"+l.id, nil, false)
	wantError(t, status, out, http.StatusNotFound, "not_found")
	// Sends to its mailboxes look the same as to any unknown one.
	if status, out := h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": clientEnvelope(t), "token": mintToken(t, h.now)}); status != http.StatusOK || len(out) != 0 {
		t.Fatalf("send after delete: %d %v", status, out)
	}

	// The device can't use its session any more.
	status, out = h.as(t, owner, http.MethodGet, "/account", nil, false)
	wantError(t, status, out, http.StatusUnauthorized, "login_refused")

	// The same Telegram user can set up again, as new (no replacing needed).
	again := newDevice(t)
	again.user = userID
	if status, out := h.register(t, again, false); status != http.StatusOK {
		t.Fatalf("register again: %d %v", status, out)
	}
}

func TestDeleteAccountInSteps(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	owner := h.account(t, userID)
	l := newLinkKeys(t)
	if status, out := h.as(t, owner, http.MethodPost, "/links", l.create(t, h.now), true); status != http.StatusCreated {
		t.Fatalf("create link: %d %v", status, out)
	}
	// More mailboxes than one step deletes.
	for range DeleteStep / MailboxBatch {
		h.now = h.now.Add(time.Second)
		if status, out := h.as(t, owner, http.MethodPost, "/mailboxes", map[string]any{"count": MailboxBatch}, false); status != http.StatusCreated {
			t.Fatalf("mailboxes: %d %v", status, out)
		}
	}

	// The first step takes the link and answers that more is left; the
	// account still logs in.
	status, out := h.as(t, owner, http.MethodDelete, "/account", nil, true)
	wantError(t, status, out, http.StatusConflict, "in_progress")
	if len(h.dir.links) != 0 || len(h.dir.accounts) != 1 {
		t.Fatalf("after one step: links %d, accounts %d", len(h.dir.links), len(h.dir.accounts))
	}
	status, out = h.call(t, nil, "", http.MethodGet, "/links/"+l.id, nil, false)
	wantError(t, status, out, http.StatusNotFound, "not_found")

	// Repeating finishes it.
	for steps := 1; ; steps++ {
		if steps > 10 {
			t.Fatal("never finishes")
		}
		h.now = h.now.Add(time.Second)
		status, out := h.as(t, owner, http.MethodDelete, "/account", nil, true)
		if status == http.StatusOK {
			break
		}
		wantError(t, status, out, http.StatusConflict, "in_progress")
	}
	if len(h.dir.accounts) != 0 || len(h.dir.boxes) != 0 || len(h.dir.telegram) != 0 {
		t.Fatalf("left behind: accounts %d, mailboxes %d, telegram %d", len(h.dir.accounts), len(h.dir.boxes), len(h.dir.telegram))
	}
}
