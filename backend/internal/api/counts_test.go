package api

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
)

// memCounts records what the public statistics are told (Counts).
type memCounts struct {
	sent     []time.Time
	uploaded []int64
}

func (m *memCounts) Sent(now time.Time)                 { m.sent = append(m.sent, now) }
func (m *memCounts) Uploaded(now time.Time, size int64) { m.uploaded = append(m.uploaded, size) }

// A message is counted when its send is answered 200 and isn't quiet,
// whoever it went to; quiet sends and refused ones aren't.
func TestCountsMessagesSent(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	c := &memCounts{}
	h.server.Counts = c
	owner := h.account(t, userID)
	_, out := h.as(t, owner, http.MethodPost, "/mailboxes", map[string]any{"count": 2}, false)
	mailbox := out["mailboxes"].([]any)[0].(string)
	discarded := out["mailboxes"].([]any)[1].(string)
	h.as(t, owner, http.MethodPost, "/mailboxes/"+discarded+"/discard", nil, false)
	env := clientEnvelope(t)
	send := func(mb, envelope, token string, quiet bool) int {
		t.Helper()
		status, _ := h.post(t, "/send", map[string]any{"mailbox": mb, "envelope": envelope, "token": token, "quiet": quiet})
		return status
	}
	counted := func(want int) {
		t.Helper()
		if len(c.sent) != want {
			t.Fatalf("counted %d messages, want %d", len(c.sent), want)
		}
	}

	// A message counts, at the server's time; a receipt, reaction, edit or
	// delete (quiet) doesn't.
	if status := send(mailbox, env, mintToken(t, h.now), false); status != http.StatusOK {
		t.Fatalf("send: %d", status)
	}
	counted(1)
	if !c.sent[0].Equal(h.now) {
		t.Fatalf("counted at %v, want %v", c.sent[0], h.now)
	}
	if status := send(mailbox, env, mintToken(t, h.now), true); status != http.StatusOK {
		t.Fatalf("quiet send: %d", status)
	}
	counted(1)
	// An ended mailbox, and one that never existed, get the same answer as
	// any other, so they count the same.
	for _, mb := range []string{discarded, ids.New()} {
		if status := send(mb, env, mintToken(t, h.now), false); status != http.StatusOK {
			t.Fatalf("send to nobody: %d", status)
		}
	}
	counted(3)
	// Refused sends don't count: a token spent already, a bad envelope, a
	// bad mailbox.
	token := mintToken(t, h.now)
	if send(mailbox, env, token, false) != http.StatusOK {
		t.Fatal("send")
	}
	counted(4)
	for _, status := range []int{
		send(mailbox, env, token, false),
		send(mailbox, "not an envelope", mintToken(t, h.now), false),
		send("bad", env, mintToken(t, h.now), false),
	} {
		if status == http.StatusOK {
			t.Fatal("a refused send was accepted")
		}
	}
	counted(4)
	// No counter, no counts, and the send is the same.
	h.server.Counts = nil
	if send(mailbox, env, mintToken(t, h.now), false) != http.StatusOK {
		t.Fatal("send without a counter")
	}
	counted(4)
}

// An upload adds its padded size when it's paid for (POST /media answered
// 201); a refused one adds nothing, nor does a fresh link for the same file.
func TestCountsUploads(t *testing.T) {
	h := newHarness(t)
	h.server.Media, h.server.Uploads = &memMedia{}, &memUploads{ups: map[string]ephemeral.Upload{}}
	c := &memCounts{}
	h.server.Counts = c
	secret := []byte("the delete secret")
	hash := sha256.Sum256(secret)
	upload := func(size int64, tokens ...string) (int, map[string]any) {
		t.Helper()
		return h.post(t, "/media", map[string]any{"size": size, "deleteHash": b64(hash[:]), "tokens": tokens})
	}

	status, out := upload(16<<10, mintMediaToken(t, h.now))
	if status != http.StatusCreated {
		t.Fatalf("upload: %d %v", status, out)
	}
	id := out["id"].(string)
	if status, out := upload(2<<20, mintMediaToken(t, h.now), mintMediaToken(t, h.now)); status != http.StatusCreated {
		t.Fatalf("upload: %d %v", status, out)
	}
	want := []int64{16 << 10, 2 << 20}
	if len(c.uploaded) != 2 || c.uploaded[0] != want[0] || c.uploaded[1] != want[1] {
		t.Fatalf("uploaded %v, want %v", c.uploaded, want)
	}
	// Refused: a size the app doesn't pad to, too few tokens, a spent one.
	spent := mintMediaToken(t, h.now)
	if status, _ := upload(16<<10, spent); status != http.StatusCreated {
		t.Fatal("upload")
	}
	for _, status := range []int{
		func() int { s, _ := upload(10, mintMediaToken(t, h.now)); return s }(),
		func() int { s, _ := upload(2<<20, mintMediaToken(t, h.now)); return s }(),
		func() int { s, _ := upload(16<<10, spent); return s }(),
	} {
		if status == http.StatusCreated {
			t.Fatal("a refused upload was accepted")
		}
	}
	// A fresh link for an upload paid for already costs nothing and adds
	// nothing.
	if status, out := h.post(t, "/media/"+id+"/upload", map[string]any{"secret": b64(secret)}); status != http.StatusOK {
		t.Fatalf("renew: %d %v", status, out)
	}
	if len(c.uploaded) != 3 {
		t.Fatalf("uploaded %v, want 3 uploads", c.uploaded)
	}
}

// Inbox, Uploads and Media that fail where a send or an upload is refused
// after its tokens are spent.
type failingDeliver struct{ Inbox }

func (failingDeliver) Deliver(context.Context, string, []string, string, []byte, time.Time) error {
	return errors.New("deliver failed")
}

type failingPut struct{ Uploads }

func (failingPut) Put(context.Context, string, ephemeral.Upload, time.Time) error {
	return errors.New("put failed")
}

type failingUploadURL struct{ Media }

func (failingUploadURL) UploadURL(context.Context, string, int64) (string, error) {
	return "", errors.New("presign failed")
}

// Sends refused after their tokens are spent aren't counted: at the
// mailbox's cap, at the link's, or when delivery fails.
func TestCountsNoMessageRefusedLate(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	c := &memCounts{}
	h.server.Counts = c
	owner := h.account(t, userID)
	l := newLinkKeys(t)
	_, out := h.as(t, owner, http.MethodPost, "/links", l.create(t, h.now), true)
	intro := out["mailbox"].(string)
	send := func(mb string) (int, map[string]any) {
		t.Helper()
		return h.post(t, "/send", map[string]any{"mailbox": mb, "envelope": clientEnvelope(t), "token": mintToken(t, h.now)})
	}

	// The mailbox's cap.
	other := ids.New()
	for range SendsPerMailboxPerMinute {
		if status, out := send(other); status != http.StatusOK {
			t.Fatalf("send: %d %v", status, out)
		}
	}
	status, out := send(other)
	wantError(t, status, out, http.StatusTooManyRequests, "rate_limited")
	// And refused only after paying, when this instance didn't know
	// (forgetful): the token is spent, then given back.
	limits := h.server.Limits
	h.server.Limits = forgetful{limits.(*memLimiter)}
	spent := h.server.Spent.(*memSpent)
	before := spent.calls
	status, out = send(other)
	wantError(t, status, out, http.StatusTooManyRequests, "rate_limited")
	if spent.calls == before {
		t.Fatal("the refused send didn't pay first: this checks nothing after payment")
	}
	h.server.Limits = limits
	if len(c.sent) != SendsPerMailboxPerMinute {
		t.Fatalf("counted %d, want %d", len(c.sent), SendsPerMailboxPerMinute)
	}

	// The link's cap, spread over minutes under the mailbox's.
	for i := range IntroSendsPerHour {
		if i%SendsPerMailboxPerMinute == 0 {
			h.now = h.now.Add(time.Minute)
		}
		if status, out := send(intro); status != http.StatusOK {
			t.Fatalf("send %d: %d %v", i, status, out)
		}
	}
	h.now = h.now.Add(time.Minute)
	status, out = send(intro)
	wantError(t, status, out, http.StatusTooManyRequests, "link_busy")
	if want := SendsPerMailboxPerMinute + IntroSendsPerHour; len(c.sent) != want {
		t.Fatalf("counted %d, want %d", len(c.sent), want)
	}

	// Delivery failing.
	h.server.Inbox = failingDeliver{h.server.Inbox}
	if status, _ := send(ids.New()); status != http.StatusInternalServerError {
		t.Fatalf("a failed delivery answered %d", status)
	}
	if want := SendsPerMailboxPerMinute + IntroSendsPerHour; len(c.sent) != want {
		t.Fatalf("counted %d after a failed delivery, want %d", len(c.sent), want)
	}
}

// Refused uploads aren't counted: while uploads are paused (before any
// token is looked at), or after payment, when recording the upload or
// presigning its link fails.
func TestCountsNoUploadRefusedLate(t *testing.T) {
	h, store, uploads, switches := mediaHarness(t)
	c := &memCounts{}
	h.server.Counts = c

	switches.set(directory.Switches{UploadsPaused: true})
	status, out := h.pay(t, 16<<10, mintMediaToken(t, h.now))
	wantError(t, status, out, http.StatusServiceUnavailable, "uploads_paused")
	switches.set(directory.Switches{})
	h.now = h.now.Add(SwitchesTTL)

	h.server.Uploads = failingPut{uploads}
	if status, _ := h.pay(t, 16<<10, mintMediaToken(t, h.now)); status != http.StatusInternalServerError {
		t.Fatalf("a failed record answered %d", status)
	}
	h.server.Uploads, h.server.Media = uploads, failingUploadURL{store}
	if status, _ := h.pay(t, 16<<10, mintMediaToken(t, h.now)); status != http.StatusInternalServerError {
		t.Fatalf("a failed presign answered %d", status)
	}
	if len(c.uploaded) != 0 {
		t.Fatalf("counted %v for refused uploads", c.uploaded)
	}
	// And the same upload, once nothing fails, is.
	h.server.Media = store
	if status, out := h.pay(t, 16<<10, mintMediaToken(t, h.now)); status != http.StatusCreated {
		t.Fatalf("upload: %d %v", status, out)
	}
	if len(c.uploaded) != 1 || c.uploaded[0] != 16<<10 {
		t.Fatalf("counted %v", c.uploaded)
	}
}
