package api

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
)

// memSwitches is the switches item, counting its reads.
type memSwitches struct {
	mu    sync.Mutex
	sw    directory.Switches
	reads int
	fail  error // what reading and writing fail with
}

func (m *memSwitches) Switches(_ context.Context, _ bool) (directory.Switches, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.reads++
	if m.fail != nil {
		return directory.Switches{}, m.fail
	}
	return m.sw, nil
}

func (m *memSwitches) SetSwitch(_ context.Context, sw directory.Switch, paused bool) (directory.Switches, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.fail != nil {
		return directory.Switches{}, m.fail
	}
	switch sw {
	case directory.SwitchUploads:
		m.sw.UploadsPaused = paused
	case directory.SwitchDownloads:
		m.sw.DownloadsPaused = paused
	default:
		return directory.Switches{}, directory.ErrUnknownSwitch
	}
	return m.sw, nil
}

func (m *memSwitches) set(sw directory.Switches) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sw = sw
}

// mediaHarness is a server with media and switches.
func mediaHarness(t *testing.T) (*harness, *memMedia, *memUploads, *memSwitches) {
	t.Helper()
	h := newHarness(t)
	store, uploads, switches := &memMedia{stored: map[string]bool{}}, &memUploads{ups: map[string]ephemeral.Upload{}}, &memSwitches{}
	h.server.Media, h.server.Uploads, h.server.Switches = store, uploads, switches
	return h, store, uploads, switches
}

var deleteSecret = []byte("the delete secret, from the message")

// pay asks for an upload with fresh tokens.
func (h *harness) pay(t *testing.T, size int64, tokens ...string) (int, map[string]any) {
	t.Helper()
	hash := sha256.Sum256(deleteSecret)
	list := make([]any, len(tokens))
	for i, tok := range tokens {
		list[i] = tok
	}
	return h.post(t, "/media", map[string]any{"size": size, "deleteHash": b64(hash[:]), "tokens": list})
}

func TestPausedUploads(t *testing.T) {
	h, store, uploads, switches := mediaHarness(t)
	spent := h.server.Spent.(*memSpent)

	// Paid for before the pause; it still needs a fresh URL.
	status, out := h.pay(t, 16<<10, mintMediaToken(t, h.now))
	if status != http.StatusCreated {
		t.Fatalf("upload: %d %v", status, out)
	}
	id := out["id"].(string)

	switches.set(directory.Switches{UploadsPaused: true})
	h.now = h.now.Add(SwitchesTTL)
	presigned, records, spends := store.presigned, len(uploads.ups), len(spent.spent)

	// Refused before any token is checked or spent, and nothing is asked of
	// the bucket: the tokens still pay later.
	tokens := []string{mintMediaToken(t, h.now), mintMediaToken(t, h.now)}
	status, out = h.pay(t, 2<<20, tokens...)
	wantError(t, status, out, http.StatusServiceUnavailable, "uploads_paused")
	// Even tokens that would be refused: nothing about them is looked at.
	status, out = h.pay(t, 2<<20, "not a token")
	wantError(t, status, out, http.StatusServiceUnavailable, "uploads_paused")
	// No fresh URL either, and none of the upload's three is used up.
	status, out = h.post(t, "/media/"+id+"/upload", map[string]any{"secret": b64(deleteSecret)})
	wantError(t, status, out, http.StatusServiceUnavailable, "uploads_paused")
	if len(spent.spent) != spends || store.presigned != presigned || len(uploads.ups) != records || uploads.writes != 0 || store.lookups != 0 {
		t.Fatalf("spent %d -> %d, presigned %d -> %d, records %d -> %d, renewal writes %d, lookups %d",
			spends, len(spent.spent), presigned, store.presigned, records, len(uploads.ups), uploads.writes, store.lookups)
	}

	// Downloads, deletes and everything else go on.
	if status, out := h.call(t, nil, "", http.MethodGet, "/media/"+id, nil, false); status != http.StatusOK {
		t.Fatalf("download while uploads are paused: %d %v", status, out)
	}

	// Resumed: the same tokens pay, and the upload gets all its fresh URLs.
	switches.set(directory.Switches{})
	h.now = h.now.Add(SwitchesTTL)
	if status, out := h.pay(t, 2<<20, tokens...); status != http.StatusCreated {
		t.Fatalf("upload after resuming: %d %v", status, out)
	}
	for range UploadRenewals {
		if status, out := h.post(t, "/media/"+id+"/upload", map[string]any{"secret": b64(deleteSecret)}); status != http.StatusOK || out["url"] == nil {
			t.Fatalf("renew after resuming: %d %v", status, out)
		}
	}
}

func TestPausedDownloads(t *testing.T) {
	h, store, _, switches := mediaHarness(t)
	limits := h.server.Limits.(*memLimiter)
	status, out := h.pay(t, 16<<10, mintMediaToken(t, h.now))
	if status != http.StatusCreated {
		t.Fatalf("upload: %d %v", status, out)
	}
	id := out["id"].(string)

	switches.set(directory.Switches{DownloadsPaused: true})
	h.now = h.now.Add(SwitchesTTL)
	presigned := store.presigned
	// Refused before the file's daily downloads are counted, many times over.
	for range DownloadsPerDay + 1 {
		status, out := h.call(t, nil, "", http.MethodGet, "/media/"+id, nil, false)
		wantError(t, status, out, http.StatusServiceUnavailable, "downloads_paused")
	}
	if limits.counts["dl#"+id] != 0 || store.presigned != presigned {
		t.Fatalf("counted %d downloads, presigned %d -> %d", limits.counts["dl#"+id], presigned, store.presigned)
	}
	// Uploads and deletes go on.
	if status, out := h.pay(t, 16<<10, mintMediaToken(t, h.now)); status != http.StatusCreated {
		t.Fatalf("upload while downloads are paused: %d %v", status, out)
	}

	// Resumed: the file still has all its downloads.
	switches.set(directory.Switches{})
	h.now = h.now.Add(SwitchesTTL)
	for range DownloadsPerDay {
		if status, out := h.call(t, nil, "", http.MethodGet, "/media/"+id, nil, false); status != http.StatusOK {
			t.Fatalf("download after resuming: %d %v", status, out)
		}
	}
	status, out = h.call(t, nil, "", http.MethodGet, "/media/"+id, nil, false)
	wantError(t, status, out, http.StatusTooManyRequests, "rate_limited")
}

func TestSwitchesCache(t *testing.T) {
	h, _, _, switches := mediaHarness(t)
	download := func() int {
		t.Helper()
		status, _ := h.call(t, nil, "", http.MethodGet, "/media/AAAAAAAAAAAAAAAAAAAAAA", nil, false)
		return status
	}

	// Read once, then kept: many requests, one read.
	for range 10 {
		if status := download(); status != http.StatusNotFound {
			t.Fatalf("download = %d", status)
		}
	}
	if switches.reads != 1 {
		t.Fatalf("reads = %d", switches.reads)
	}

	// A flip shows only once what this instance read is SwitchesTTL old.
	switches.set(directory.Switches{DownloadsPaused: true})
	h.now = h.now.Add(SwitchesTTL - time.Second)
	if status := download(); status != http.StatusNotFound || switches.reads != 1 {
		t.Fatalf("within the TTL: %d, reads %d", status, switches.reads)
	}
	h.now = h.now.Add(time.Second)
	if status := download(); status != http.StatusServiceUnavailable || switches.reads != 2 {
		t.Fatalf("after the TTL: %d, reads %d", status, switches.reads)
	}
	if !strings.Contains(h.logs.String(), `"msg":"downloads paused"`) {
		t.Fatalf("logs = %s", h.logs)
	}

	// The directory can't be read: the last value holds, and it is asked
	// again only after a pause, not on every request.
	switches.set(directory.Switches{})
	switches.fail = errors.New("throttled")
	h.now = h.now.Add(SwitchesTTL)
	for range 5 {
		if status := download(); status != http.StatusServiceUnavailable {
			t.Fatalf("failed read: %d", status)
		}
	}
	if switches.reads != 3 {
		t.Fatalf("reads = %d", switches.reads)
	}
	h.now = h.now.Add(switchesRetry)
	switches.fail = nil
	if status := download(); status != http.StatusNotFound || switches.reads != 4 {
		t.Fatalf("read again: %d, reads %d", status, switches.reads)
	}
	if !strings.Contains(h.logs.String(), `"msg":"reading the switches failed"`) {
		t.Fatalf("logs = %s", h.logs)
	}
}

func TestSwitchesNeverRead(t *testing.T) {
	// A fresh instance that can't read the switches pauses nothing.
	h, _, _, switches := mediaHarness(t)
	switches.set(directory.Switches{UploadsPaused: true, DownloadsPaused: true})
	switches.fail = errors.New("throttled")
	status, out := h.call(t, nil, "", http.MethodGet, "/media/AAAAAAAAAAAAAAAAAAAAAA", nil, false)
	wantError(t, status, out, http.StatusNotFound, "not_found")

	// Without switches at all (as before they existed), nothing is paused.
	h.server.Switches = nil
	if status, out := h.pay(t, 16<<10, mintMediaToken(t, h.now)); status != http.StatusCreated {
		t.Fatalf("upload: %d %v", status, out)
	}
}

func TestAdminSwitches(t *testing.T) {
	h, _, _, switches := mediaHarness(t)
	h.makeAdmin(userID)
	admin := h.account(t, userID)
	stranger := h.account(t, userID+1)

	// Admins only, and changes need a device signature.
	status, out := h.as(t, stranger, http.MethodGet, "/admin/switches", nil, false)
	wantError(t, status, out, http.StatusForbidden, "admin_only")
	status, out = h.as(t, stranger, http.MethodPut, "/admin/switches", map[string]any{"switch": "uploads", "paused": true}, true)
	wantError(t, status, out, http.StatusForbidden, "admin_only")
	status, out = h.call(t, nil, "", http.MethodPut, "/admin/switches", map[string]any{"switch": "uploads", "paused": true}, false)
	wantError(t, status, out, http.StatusUnauthorized, "session_expired")
	status, out = h.as(t, admin, http.MethodPut, "/admin/switches", map[string]any{"switch": "uploads", "paused": true}, false)
	wantError(t, status, out, http.StatusUnauthorized, "signature_rejected")
	if switches.sw != (directory.Switches{}) {
		t.Fatalf("switched by a refused request: %+v", switches.sw)
	}
	for _, body := range []map[string]any{
		{"switch": "sends", "paused": true},
		{"switch": "uploads"},
		{"switch": "uploads", "paused": "yes"},
		{"switch": "uploads", "paused": true, "extra": 1},
	} {
		status, out = h.as(t, admin, http.MethodPut, "/admin/switches", body, true)
		wantError(t, status, out, http.StatusBadRequest, "bad_request")
	}

	status, out = h.as(t, admin, http.MethodGet, "/admin/switches", nil, false)
	if status != http.StatusOK || out["uploadsPaused"] != false || out["downloadsPaused"] != false {
		t.Fatalf("switches: %d %v", status, out)
	}
	// This instance follows at once.
	status, out = h.as(t, admin, http.MethodPut, "/admin/switches", map[string]any{"switch": "uploads", "paused": true}, true)
	if status != http.StatusOK || out["uploadsPaused"] != true || out["downloadsPaused"] != false {
		t.Fatalf("pause uploads: %d %v", status, out)
	}
	status, out = h.pay(t, 16<<10, mintMediaToken(t, h.now))
	wantError(t, status, out, http.StatusServiceUnavailable, "uploads_paused")
	status, out = h.as(t, admin, http.MethodPut, "/admin/switches", map[string]any{"switch": "downloads", "paused": true}, true)
	if status != http.StatusOK || out["uploadsPaused"] != true || out["downloadsPaused"] != true {
		t.Fatalf("pause downloads: %d %v", status, out)
	}
	status, out = h.as(t, admin, http.MethodPut, "/admin/switches", map[string]any{"switch": "uploads", "paused": false}, true)
	if status != http.StatusOK || out["uploadsPaused"] != false || out["downloadsPaused"] != true {
		t.Fatalf("resume uploads: %d %v", status, out)
	}
	if status, out := h.pay(t, 16<<10, mintMediaToken(t, h.now)); status != http.StatusCreated {
		t.Fatalf("upload after resuming: %d %v", status, out)
	}
	// The admin screen shows what is stored, not what this instance read.
	switches.set(directory.Switches{})
	if _, out := h.as(t, admin, http.MethodGet, "/admin/switches", nil, false); out["downloadsPaused"] != false {
		t.Fatalf("switches: %v", out)
	}

	switches.fail = errors.New("throttled")
	status, out = h.as(t, admin, http.MethodPut, "/admin/switches", map[string]any{"switch": "uploads", "paused": true}, true)
	wantError(t, status, out, http.StatusInternalServerError, "internal")
}

// slowSwitches holds each read until released.
type slowSwitches struct {
	memSwitches
	release chan struct{}
}

func (s *slowSwitches) Switches(ctx context.Context, consistent bool) (directory.Switches, error) {
	<-s.release
	return s.memSwitches.Switches(ctx, consistent)
}

func TestSwitchesOneReadAtATime(t *testing.T) {
	// While one request reads the switches, the others go on with what the
	// instance knew, rather than reading too or waiting.
	h := newHarness(t)
	slow := &slowSwitches{release: make(chan struct{})}
	slow.sw = directory.Switches{UploadsPaused: true}
	h.server.Switches = slow
	first := make(chan directory.Switches)
	go func() { first <- h.server.switches(context.Background(), "test") }()
	// Wait until the first is reading.
	for {
		h.server.switchCache.mu.Lock()
		reading := h.server.switchCache.reading
		h.server.switchCache.mu.Unlock()
		if reading {
			break
		}
		time.Sleep(time.Millisecond)
	}
	var wg sync.WaitGroup
	for range 10 {
		wg.Go(func() {
			if sw := h.server.switches(context.Background(), "test"); sw.UploadsPaused {
				t.Error("not read yet, but paused")
			}
		})
	}
	wg.Wait()
	close(slow.release)
	if sw := <-first; !sw.UploadsPaused {
		t.Fatal("the read didn't pause uploads")
	}
	if sw := h.server.switches(context.Background(), "test"); !sw.UploadsPaused || slow.reads != 1 {
		t.Fatalf("after the read: %+v, reads %d", sw, slow.reads)
	}
}
