package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/logx"
	"github.com/incognitochat/incognitochat/backend/internal/media"
	"github.com/incognitochat/incognitochat/backend/internal/tokens"
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
	// DeleteAll deletes several at once, and returns those that failed.
	DeleteAll(ctx context.Context, ids []string) (failed []string, err error)
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
	// LookupAll is Lookup for several at once: those there are, by ID.
	LookupAll(ctx context.Context, ids []string) (map[string]ephemeral.Upload, error)
	DeleteAll(ctx context.Context, ids []string) error
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
	paid := make([]checked, len(in.Tokens))
	for i, t := range in.Tokens {
		raw, err := base64.RawURLEncoding.Strict().DecodeString(t)
		if err != nil {
			return httpapi.Error(http.StatusUnauthorized, "invalid_token")
		}
		nonce, forgetAfter, err := s.MediaIssuer.Check(raw, now)
		if errors.Is(err, tokens.ErrUnknownKey) {
			// A retired key's token: the app is told apart (sendTokens).
			return httpapi.Error(http.StatusUnauthorized, "unknown_issuer_key")
		}
		if err != nil {
			return httpapi.Error(http.StatusUnauthorized, "invalid_token")
		}
		for _, prev := range paid[:i] {
			if bytes.Equal(prev.nonce, nonce) {
				return httpapi.Error(http.StatusUnauthorized, "invalid_token")
			}
		}
		paid[i] = checked{nonce, forgetAfter}
	}
	for _, t := range paid {
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
	now := s.Now()
	ok, err := s.Limits.AllowNAt(ctx, s.rateName("dl", now, 24*time.Hour, id), 1, DownloadsPerDay, 24*time.Hour, now)
	if err != nil {
		return s.internal(route, err)
	}
	if !ok {
		// Its own code, and when the UTC day ends, so the app can say why a
		// tap did nothing and when the file can be fetched again.
		return limitReached("download_limit", now, 24*time.Hour)
	}
	url, err := s.Media.DownloadURL(ctx, id)
	if err != nil {
		return s.internal(route, err)
	}
	return httpapi.JSON(http.StatusOK, map[string]string{"url": url})
}

// deleteUpload deletes an upload for whoever holds its delete secret (the
// sender, and the recipient, whose message carries it): the app asks when
// the upload's message is deleted. The app deletes uploads in batches
// (deleteUploads), and asks here one at a time only of a server without
// that route; this stays for older apps.
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

// DeleteBatch is the most uploads one POST /media/delete takes. Looking
// them up reads half a unit each (eventually consistent, as for one
// delete), found or not, and each whose secret matches takes one write unit
// to forget: at most 50 read and 100 write units a request, about two steps
// of deleting an account (DeleteStep). The app sends one batch at a time
// and pauses between them, so a chat with thousands of attachments is
// deleted at about 40 a second, as an account's steps are.
const DeleteBatch = 100

// What POST /media/delete answers for each upload.
const (
	uploadDeleted  = "deleted"
	uploadNotFound = "not_found"
	uploadFailed   = "failed"
)

type uploadToDelete struct {
	ID     string `json:"id"`
	Secret string `json:"secret"` // base64url, as deleteUpload takes it
}

// deleteUploads is deleteUpload for up to DeleteBatch uploads at once, so
// that deleting a chat with many attachments takes a few requests rather
// than one per attachment. It needs no login either: each upload is
// deleted for its own delete secret, checked as deleteUpload checks it. It
// answers {results}, one for each item, in their order:
//
//	deleted    deleted now
//	not_found  what deleteUpload answers not_found: no such upload (never
//	           made, expired, or deleted already), a wrong secret, or an
//	           item that can't name one (a malformed ID or secret)
//	failed     the bucket couldn't delete it this time; ask again later
//
// The bucket's objects go in one request, then the records of those that
// went, so one the bucket kept can still be deleted by its secret, as with
// deleteUpload. If the table fails, the whole request does.
func (s *Server) deleteUploads(ctx context.Context, req httpapi.Request) httpapi.Response {
	const route = "POST /media/delete"
	var in struct {
		Items []uploadToDelete `json:"items"`
	}
	if err := httpapi.DecodeJSON(req, &in); err != nil {
		return httpapi.DecodeError(err)
	}
	if s.Media == nil {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	if len(in.Items) == 0 || len(in.Items) > DeleteBatch {
		return httpapi.Error(http.StatusBadRequest, "bad_request")
	}
	// Each item that can name an upload: the hash of its secret. One that
	// can't is answered not_found, as deleteUpload answers it, and doesn't
	// hold up the others.
	hashes := make([][]byte, len(in.Items))
	lookup := make([]string, 0, len(in.Items))
	for i, it := range in.Items {
		secret, err := base64.RawURLEncoding.Strict().DecodeString(it.Secret)
		if err != nil || len(secret) == 0 || !ids.Valid(it.ID) {
			continue
		}
		hash := sha256.Sum256(secret)
		hashes[i] = hash[:]
		lookup = append(lookup, it.ID)
	}
	// Eventually consistent, as deleteUpload's Lookup, and safe for the
	// same reasons.
	found, err := s.Uploads.LookupAll(ctx, lookup)
	if err != nil {
		return s.internal(route, err)
	}
	matched := make([]bool, len(in.Items))
	var doomed []string
	for i, it := range in.Items {
		up, ok := found[it.ID]
		if hashes[i] == nil || !ok || subtle.ConstantTimeCompare(hashes[i], up.DeleteHash) != 1 {
			continue
		}
		matched[i] = true
		if !slices.Contains(doomed, it.ID) {
			doomed = append(doomed, it.ID)
		}
	}
	failed, err := s.Media.DeleteAll(ctx, doomed)
	if err != nil {
		return s.internal(route, err)
	}
	kept := make(map[string]bool, len(failed))
	for _, id := range failed {
		kept[id] = true
	}
	gone := slices.DeleteFunc(slices.Clone(doomed), func(id string) bool { return kept[id] })
	if err := s.Uploads.DeleteAll(ctx, gone); err != nil {
		return s.internal(route, err)
	}
	if len(failed) > 0 {
		s.Log.Warn("uploads not deleted", slog.String(logx.KeyRoute, route), slog.Int(logx.KeyCount, len(failed)))
	}
	results := make([]string, len(in.Items))
	for i, it := range in.Items {
		switch {
		case !matched[i]:
			results[i] = uploadNotFound
		case kept[it.ID]:
			results[i] = uploadFailed
		default:
			results[i] = uploadDeleted
		}
	}
	return httpapi.JSON(http.StatusOK, map[string][]string{"results": results})
}
