package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"net/http"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/media"
)

// DownloadsPerDay limits how often one upload can be fetched: the
// recipient needs one or two; more would make it file hosting.
const DownloadsPerDay = 5

// UploadRenewals is how many fresh upload URLs an upload gets after its
// first, for the app to try again when a PUT fails: an upload URL only works
// if the PUT starts within a minute. Each one is another minute in which the
// URL can be tried (and billed), so there are few.
const UploadRenewals = 3

// UploadRenewalWindow is how long after paying for an upload its fresh URLs
// can be asked for: plenty for four tries of 50 MB on a slow connection. An
// upload written much later would outlive its record, which expires
// media.Retention after payment, with nothing to delete it by.
const UploadRenewalWindow = 3 * time.Hour

// Media is the media bucket (media.Bucket).
type Media interface {
	UploadURL(ctx context.Context, id string, size int64) (string, error)
	DownloadURL(ctx context.Context, id string) (string, error)
	Stored(ctx context.Context, id string) (bool, error)
	Delete(ctx context.Context, id string) error
}

// Uploads records uploads until they're deleted (ephemeral.Uploads).
type Uploads interface {
	Put(ctx context.Context, id string, up ephemeral.Upload, expires time.Time) error
	Get(ctx context.Context, id string) (ephemeral.Upload, bool, error)
	// Exists is Get for downloads: eventually consistent.
	Exists(ctx context.Context, id string) (bool, error)
	// Lookup is Get for deletes: eventually consistent.
	Lookup(ctx context.Context, id string) (ephemeral.Upload, bool, error)
	Renew(ctx context.Context, id string, most int, expiresAfter time.Time) (bool, error)
	Delete(ctx context.Context, id string) error
}

type uploadRequest struct {
	Size       int64    `json:"size"`
	DeleteHash bytes64  `json:"deleteHash"` // SHA-256 of the delete secret, which only the message carries
	Tokens     []string `json:"tokens"`     // base64url media tokens, media.TokensFor(size) of them
}

// upload takes payment for an upload and returns where to put it. Like a
// send, it needs no login: anonymous media tokens pay for it (one per started
// MiB), so an upload can't be tied to an account. Only the padded sizes the
// app makes are accepted. The app then PUTs exactly size bytes of
// ciphertext to the URL, once, starting within a minute (media.UploadURL).
func (s *Server) upload(ctx context.Context, req httpapi.Request) httpapi.Response {
	const route = "POST /media"
	var in uploadRequest
	if err := httpapi.DecodeJSON(req, &in); err != nil {
		return httpapi.DecodeError(err)
	}
	if s.Media == nil || s.MediaIssuer == nil {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	// Before any token is looked at, so a paused upload costs nothing: the
	// app keeps its tokens and tries again later.
	if s.switches(ctx, route).UploadsPaused {
		return httpapi.Error(http.StatusServiceUnavailable, "uploads_paused")
	}
	if !media.PaddedSize(in.Size) || len(in.DeleteHash) != sha256.Size {
		return httpapi.Error(http.StatusBadRequest, "bad_request")
	}
	if len(in.Tokens) != media.TokensFor(in.Size) {
		return httpapi.Error(http.StatusUnauthorized, "invalid_token")
	}
	// Check every token before spending any.
	now := s.Now()
	type checked struct {
		nonce       []byte
		forgetAfter time.Time
	}
	tokens := make([]checked, len(in.Tokens))
	for i, t := range in.Tokens {
		raw, err := base64.RawURLEncoding.Strict().DecodeString(t)
		if err != nil {
			return httpapi.Error(http.StatusUnauthorized, "invalid_token")
		}
		nonce, forgetAfter, err := s.MediaIssuer.Check(raw, now)
		if err != nil {
			return httpapi.Error(http.StatusUnauthorized, "invalid_token")
		}
		for _, prev := range tokens[:i] {
			if bytes.Equal(prev.nonce, nonce) {
				return httpapi.Error(http.StatusUnauthorized, "invalid_token")
			}
		}
		tokens[i] = checked{nonce, forgetAfter}
	}
	for _, t := range tokens {
		fresh, err := s.Spent.Spend(ctx, t.nonce, t.forgetAfter)
		if err != nil {
			return s.internal(route, err)
		}
		if !fresh {
			return httpapi.Error(http.StatusUnauthorized, "invalid_token")
		}
	}
	id := ids.New()
	if err := s.Uploads.Put(ctx, id, ephemeral.Upload{DeleteHash: in.DeleteHash, Size: in.Size}, now.Add(media.Retention)); err != nil {
		return s.internal(route, err)
	}
	url, err := s.Media.UploadURL(ctx, id, in.Size)
	if err != nil {
		return s.internal(route, err)
	}
	return httpapi.JSON(http.StatusCreated, map[string]string{"id": id, "url": url})
}

// renewUpload gives a paid upload a fresh upload URL, for whoever holds its
// delete secret: the app trying again after a failed PUT (a URL starts a PUT
// only within a minute). It costs no tokens. A fresh URL is given only while
// nothing is stored, at most UploadRenewals times and within
// UploadRenewalWindow of payment. Once the upload is stored the answer says
// so ({"uploaded": true}), and the app counts its upload as done. Every
// refusal is the same not_found, except uploads_paused while the operator
// has paused uploads (switches.go).
func (s *Server) renewUpload(ctx context.Context, req httpapi.Request) httpapi.Response {
	const route = "POST /media/{id}/upload"
	id := httpapi.Param(ctx, "id")
	var in struct {
		Secret bytes64 `json:"secret"`
	}
	if err := httpapi.DecodeJSON(req, &in); err != nil {
		return httpapi.DecodeError(err)
	}
	if s.Media == nil || !ids.Valid(id) || len(in.Secret) == 0 {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	// Read and check before writing anything: anyone can call this, as often
	// as the firewall lets them, and a refused conditional write still costs
	// write capacity.
	up, ok, err := s.Uploads.Get(ctx, id)
	if err != nil {
		return s.internal(route, err)
	}
	hash := sha256.Sum256(in.Secret)
	// The upload expires media.Retention after payment, so it was paid for
	// within the window if it expires after this.
	expiresAfter := s.Now().Add(media.Retention - UploadRenewalWindow)
	if !ok || subtle.ConstantTimeCompare(hash[:], up.DeleteHash) != 1 || up.Renewals >= UploadRenewals || !up.Expires.After(expiresAfter) {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	// Counted before S3 is asked, so the lookups are limited too. The
	// update checks the cap and the window again, for calls that race.
	ok, err = s.Uploads.Renew(ctx, id, UploadRenewals, expiresAfter)
	if err != nil {
		return s.internal(route, err)
	}
	if !ok {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	stored, err := s.Media.Stored(ctx, id)
	if err != nil {
		return s.internal(route, err)
	}
	if stored {
		return httpapi.JSON(http.StatusOK, map[string]bool{"uploaded": true})
	}
	// Only the fresh URL waits for uploads to resume (another minute of
	// PUTs); one stored already, whose answer was lost, is still done, so
	// it isn't paid for twice. The try counts as one of its fresh URLs.
	if s.switches(ctx, route).UploadsPaused {
		return httpapi.Error(http.StatusServiceUnavailable, "uploads_paused")
	}
	url, err := s.Media.UploadURL(ctx, id, up.Size)
	if err != nil {
		return s.internal(route, err)
	}
	return httpapi.JSON(http.StatusOK, map[string]string{"url": url})
}

// download returns where to fetch an upload. The ID is in the encrypted
// message only, so knowing it is the permission; the content is encrypted
// anyway.
func (s *Server) download(ctx context.Context, _ httpapi.Request) httpapi.Response {
	const route = "GET /media/{id}"
	id := httpapi.Param(ctx, "id")
	if s.Media == nil || !ids.Valid(id) {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	// Before anything is read or the file's downloads are counted.
	if s.switches(ctx, route).DownloadsPaused {
		return httpapi.Error(http.StatusServiceUnavailable, "downloads_paused")
	}
	if ok, err := s.Uploads.Exists(ctx, id); err != nil {
		return s.internal(route, err)
	} else if !ok {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	ok, err := s.allow(ctx, "dl", DownloadsPerDay, 24*time.Hour, id)
	if err != nil {
		return s.internal(route, err)
	}
	if !ok {
		return httpapi.Error(http.StatusTooManyRequests, "rate_limited")
	}
	url, err := s.Media.DownloadURL(ctx, id)
	if err != nil {
		return s.internal(route, err)
	}
	return httpapi.JSON(http.StatusOK, map[string]string{"url": url})
}

// deleteUpload deletes an upload for whoever holds its delete secret: the
// recipient, once the file is safely on their device.
func (s *Server) deleteUpload(ctx context.Context, req httpapi.Request) httpapi.Response {
	const route = "POST /media/{id}/delete"
	id := httpapi.Param(ctx, "id")
	var in struct {
		Secret bytes64 `json:"secret"`
	}
	if err := httpapi.DecodeJSON(req, &in); err != nil {
		return httpapi.DecodeError(err)
	}
	if s.Media == nil || !ids.Valid(id) || len(in.Secret) == 0 {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	// Eventually consistent, at half the cost: anyone can ask with random
	// IDs. A stale read is safe, since the hash it compares never changes,
	// and an upload recorded in about the last second, which may not show
	// yet, isn't one a recipient has the message for.
	up, ok, err := s.Uploads.Lookup(ctx, id)
	if err != nil {
		return s.internal(route, err)
	}
	hash := sha256.Sum256(in.Secret)
	if !ok || subtle.ConstantTimeCompare(hash[:], up.DeleteHash) != 1 {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	if err := s.Media.Delete(ctx, id); err != nil {
		return s.internal(route, err)
	}
	if err := s.Uploads.Delete(ctx, id); err != nil {
		return s.internal(route, err)
	}
	return httpapi.JSON(http.StatusOK, map[string]string{})
}
