package api

import (
	"crypto/sha256"
	"net/http"
	"testing"
	"time"

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
