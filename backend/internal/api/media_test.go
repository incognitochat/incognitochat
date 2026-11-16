package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"net/http"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/media"
)

type memMedia struct {
	deleted []string
}

func (m *memMedia) UploadURL(_ context.Context, id string, size int64) (string, error) {
	return "https://bucket.example/m/" + id + "?put=" + strconv.FormatInt(size, 10), nil
}

func (m *memMedia) DownloadURL(_ context.Context, id string) (string, error) {
	return "https://bucket.example/m/" + id + "?get", nil
}

func (m *memMedia) Delete(_ context.Context, id string) error {
	m.deleted = append(m.deleted, id)
	return nil
}

type memUploads struct {
	mu       sync.Mutex
	ups      map[string]ephemeral.Upload
	renewals map[string]int
}

func (m *memUploads) Renew(_ context.Context, id string, deleteHash []byte, most int) (ephemeral.Upload, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	up, ok := m.ups[id]
	if !ok || !bytes.Equal(up.DeleteHash, deleteHash) || m.renewals[id] >= most {
		return ephemeral.Upload{}, false, nil
	}
	if m.renewals == nil {
		m.renewals = map[string]int{}
	}
	m.renewals[id]++
	return up, true, nil
}

func (m *memUploads) Put(_ context.Context, id string, up ephemeral.Upload, _ time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ups[id] = up
	return nil
}

func (m *memUploads) Get(_ context.Context, id string) (ephemeral.Upload, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	up, ok := m.ups[id]
	return up, ok, nil
}

func (m *memUploads) Exists(ctx context.Context, id string) (bool, error) {
	_, ok, err := m.Get(ctx, id)
	return ok, err
}

func (m *memUploads) Delete(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.ups, id)
	return nil
}

func TestMedia(t *testing.T) {
	h := newHarness(t)
	store, uploads := &memMedia{}, &memUploads{ups: map[string]ephemeral.Upload{}}
	h.server.Media, h.server.Uploads = store, uploads
	secret := []byte("the delete secret, from the message")
	hash := sha256.Sum256(secret)
	tokens := func(n int) []any {
		out := make([]any, n)
		for i := range out {
			out[i] = mintMediaToken(t, h.now)
		}
		return out
	}

	// 6 MiB costs six tokens; no login needed.
	size := int64(6 << 20)
	status, out := h.post(t, "/media", map[string]any{"size": size, "deleteHash": b64(hash[:]), "tokens": tokens(6)})
	if status != http.StatusCreated {
		t.Fatalf("upload: %d %v", status, out)
	}
	id := out["id"].(string)
	if !ids.Valid(id) || out["url"] != "https://bucket.example/m/"+id+"?put=6291456" {
		t.Fatalf("upload = %v", out)
	}
	if up := uploads.ups[id]; up.Size != size || !bytes.Equal(up.DeleteHash, hash[:]) {
		t.Fatalf("record = %+v", up)
	}

	// Anyone with the ID can fetch it (it's encrypted), a few times a day.
	status, out = h.call(t, nil, "", http.MethodGet, "/media/"+id, nil, false)
	if status != http.StatusOK || out["url"] != "https://bucket.example/m/"+id+"?get" {
		t.Fatalf("download: %d %v", status, out)
	}
	for range DownloadsPerDay - 1 {
		h.call(t, nil, "", http.MethodGet, "/media/"+id, nil, false)
	}
	status, out = h.call(t, nil, "", http.MethodGet, "/media/"+id, nil, false)
	wantError(t, status, out, http.StatusTooManyRequests, "rate_limited")

	// Only the delete secret deletes it.
	status, out = h.post(t, "/media/"+id+"/delete", map[string]any{"secret": b64([]byte("wrong"))})
	wantError(t, status, out, http.StatusNotFound, "not_found")
	if status, out := h.post(t, "/media/"+id+"/delete", map[string]any{"secret": b64(secret)}); status != http.StatusOK {
		t.Fatalf("delete: %d %v", status, out)
	}
	if len(store.deleted) != 1 || store.deleted[0] != id {
		t.Fatalf("deleted = %v", store.deleted)
	}
	status, out = h.call(t, nil, "", http.MethodGet, "/media/"+id, nil, false)
	wantError(t, status, out, http.StatusNotFound, "not_found")
}

func TestRenewUpload(t *testing.T) {
	h := newHarness(t)
	uploads := &memUploads{ups: map[string]ephemeral.Upload{}}
	h.server.Media, h.server.Uploads = &memMedia{}, uploads
	secret := []byte("the delete secret, from the message")
	hash := sha256.Sum256(secret)
	status, out := h.post(t, "/media", map[string]any{"size": 2 << 20, "deleteHash": b64(hash[:]), "tokens": []any{mintMediaToken(t, h.now), mintMediaToken(t, h.now)}})
	if status != http.StatusCreated {
		t.Fatalf("upload: %d %v", status, out)
	}
	id := out["id"].(string)
	renew := func(id string, secret []byte) (int, map[string]any) {
		return h.post(t, "/media/"+id+"/upload", map[string]any{"secret": b64(secret)})
	}

	// A fresh URL for the same upload and size, for its delete secret only,
	// and without tokens; a few times, then no more.
	status, out = renew(id, []byte("wrong"))
	wantError(t, status, out, http.StatusNotFound, "not_found")
	for range UploadRenewals {
		status, out = renew(id, secret)
		if status != http.StatusOK || out["url"] != "https://bucket.example/m/"+id+"?put=2097152" {
			t.Fatalf("renew: %d %v", status, out)
		}
	}
	status, out = renew(id, secret)
	wantError(t, status, out, http.StatusNotFound, "not_found")
	// Unknown, or deleted.
	status, out = renew(ids.New(), secret)
	wantError(t, status, out, http.StatusNotFound, "not_found")
	status, out = h.post(t, "/media", map[string]any{"size": 16 << 10, "deleteHash": b64(hash[:]), "tokens": []any{mintMediaToken(t, h.now)}})
	if status != http.StatusCreated {
		t.Fatalf("upload: %d %v", status, out)
	}
	other := out["id"].(string)
	if status, out := h.post(t, "/media/"+other+"/delete", map[string]any{"secret": b64(secret)}); status != http.StatusOK {
		t.Fatalf("delete: %d %v", status, out)
	}
	status, out = renew(other, secret)
	wantError(t, status, out, http.StatusNotFound, "not_found")
}

func TestUploadRejects(t *testing.T) {
	h := newHarness(t)
	h.server.Media, h.server.Uploads = &memMedia{}, &memUploads{ups: map[string]ephemeral.Upload{}}
	hash := sha256.Sum256([]byte("x"))
	upload := func(size int64, deleteHash []byte, tokens []any) (int, map[string]any) {
		return h.post(t, "/media", map[string]any{"size": size, "deleteHash": b64(deleteHash), "tokens": tokens})
	}
	one := mintMediaToken(t, h.now)

	// Only the sizes the app pads to, and nothing is spent on others: a
	// token can't buy a tiny upload.
	for _, size := range []int64{0, 1, 10, 16<<10 - 1, 16<<10 + 1, 100 << 10, 1<<20 + 1, 3<<20 - 1, media.MaxSize + 1<<20} {
		status, out := upload(size, hash[:], []any{one})
		wantError(t, status, out, http.StatusBadRequest, "bad_request")
	}
	status, out := upload(16<<10, []byte("short"), []any{one})
	wantError(t, status, out, http.StatusBadRequest, "bad_request")
	// Too few tokens, the same token twice, a bad token.
	status, out = upload(2<<20, hash[:], []any{one})
	wantError(t, status, out, http.StatusUnauthorized, "invalid_token")
	status, out = upload(2<<20, hash[:], []any{one, one})
	wantError(t, status, out, http.StatusUnauthorized, "invalid_token")
	status, out = upload(16<<10, hash[:], []any{"nope"})
	wantError(t, status, out, http.StatusUnauthorized, "invalid_token")
	// Send tokens don't pay for uploads, and media tokens don't pay for sends.
	status, out = upload(16<<10, hash[:], []any{mintToken(t, h.now)})
	wantError(t, status, out, http.StatusUnauthorized, "invalid_token")
	status, out = h.post(t, "/send", map[string]any{"mailbox": ids.New(), "envelope": clientEnvelope(t), "token": mintMediaToken(t, h.now)})
	wantError(t, status, out, http.StatusUnauthorized, "invalid_token")
	// A token pays once: for this upload, then not again.
	if status, out := upload(16<<10, hash[:], []any{one}); status != http.StatusCreated {
		t.Fatalf("upload: %d %v", status, out)
	}
	status, out = upload(16<<10, hash[:], []any{one})
	wantError(t, status, out, http.StatusUnauthorized, "invalid_token")
	// Unknown uploads.
	status, out = h.call(t, nil, "", http.MethodGet, "/media/"+ids.New(), nil, false)
	wantError(t, status, out, http.StatusNotFound, "not_found")
	status, out = h.post(t, "/media/"+ids.New()+"/delete", map[string]any{"secret": b64([]byte("x"))})
	wantError(t, status, out, http.StatusNotFound, "not_found")
}
