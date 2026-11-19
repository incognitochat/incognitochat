// Package media handles encrypted attachments (design phase 5). The app
// encrypts a file, pads it, and uploads only the ciphertext, straight to S3
// with a presigned URL. The recipient downloads it the same way, decrypts it,
// keeps it on the device, and deletes it from S3. Whatever isn't fetched
// expires. The server never sees a file's key, name or type.
package media

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const (
	// MinSize and MaxSize are the smallest and largest uploads. The app pads
	// every file, with its encryption overhead, to the next power of two
	// from 16 KiB up to 1 MiB, then to the next whole MiB, up to a 50 MiB
	// file (PaddedSize).
	MinSize = 16 << 10
	MaxSize = 51 << 20
	// TokenBytes is how much one media token pays for: an upload costs one
	// token per started MiB.
	TokenBytes = 1 << 20
	// UploadURLTTL and DownloadURLTTL are how long presigned URLs work. S3
	// checks a URL's expiry when a request starts, and a transfer that has
	// started goes on after its URL expires. Every request with a URL is
	// billed, and a URL can be tried any number of times while it lasts, so
	// it lasts only long enough to start: the app asks for one and uses it
	// at once. An upload URL also writes only once (UploadURL).
	UploadURLTTL   = time.Minute
	DownloadURLTTL = time.Minute
	// Retention is how long an upload waits to be fetched: as long as an
	// undelivered message waits (30 days, rounded up to the hour), so in the
	// last hour an attachment may be gone before its message.
	Retention = 30 * 24 * time.Hour
	// ContentType is the only type uploads carry: the server doesn't learn
	// what a file is.
	ContentType = "application/octet-stream"
)

// TokensFor is how many media tokens an upload of size bytes costs.
func TokensFor(size int64) int { return int((size + TokenBytes - 1) / TokenBytes) }

// PaddedSize reports whether size is one the app pads uploads to: a power of
// two from MinSize up to 1 MiB, or a whole number of MiB up to MaxSize.
// Nothing else is accepted, so a token can't buy a tiny upload.
func PaddedSize(size int64) bool {
	if size > 1<<20 {
		return size <= MaxSize && size%(1<<20) == 0
	}
	return size >= MinSize && size&(size-1) == 0
}

// Presigner signs S3 requests for the app to make (s3.PresignClient).
type Presigner interface {
	PresignPutObject(context.Context, *s3.PutObjectInput, ...func(*s3.PresignOptions)) (*v4.PresignedHTTPRequest, error)
	PresignGetObject(context.Context, *s3.GetObjectInput, ...func(*s3.PresignOptions)) (*v4.PresignedHTTPRequest, error)
}

// Objects looks up and deletes objects (s3.Client).
type Objects interface {
	HeadObject(context.Context, *s3.HeadObjectInput, ...func(*s3.Options)) (*s3.HeadObjectOutput, error)
	DeleteObject(context.Context, *s3.DeleteObjectInput, ...func(*s3.Options)) (*s3.DeleteObjectOutput, error)
}

// Bucket is the media bucket.
type Bucket struct {
	Presign Presigner
	S3      Objects
	Name    string
}

func key(id string) *string {
	k := "m/" + id
	return &k
}

// UploadURL returns a URL that writes exactly size bytes for id, once. The
// length, the type and "If-None-Match: *" are part of its signature: a PUT
// of another length or type, or without that header, is refused, and so is
// every PUT once the object exists (412). So an upload can't be replaced, or
// written again after it was deleted. The app sends those headers.
func (b *Bucket) UploadURL(ctx context.Context, id string, size int64) (string, error) {
	req, err := b.Presign.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket:        &b.Name,
		Key:           key(id),
		ContentLength: &size,
		ContentType:   aws.String(ContentType),
		IfNoneMatch:   aws.String("*"),
	}, s3.WithPresignExpires(UploadURLTTL))
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

// DownloadURL returns a URL that fetches id's ciphertext. S3 answers it with
// "Content-Encoding: identity" and the one type, whatever the upload claimed,
// so a sender can't have the recipient's browser unpack a compressed bomb
// while it downloads. It also answers "Cache-Control: no-store", so the
// browser keeps no copy of the ciphertext in its cache, where the file's key
// (which its message keeps) would open it after the app cleared the file and
// the bucket deleted it. Each fetch asks for a fresh URL anyway, so a cached
// copy would never be used. All three are signed query parameters, which add
// no CORS preflight.
func (b *Bucket) DownloadURL(ctx context.Context, id string) (string, error) {
	req, err := b.Presign.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket:                  &b.Name,
		Key:                     key(id),
		ResponseCacheControl:    aws.String("no-store"),
		ResponseContentEncoding: aws.String("identity"),
		ResponseContentType:     aws.String(ContentType),
	}, s3.WithPresignExpires(DownloadURLTTL))
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

// Stored reports whether id's ciphertext has been uploaded. The api role may
// read objects but not list the bucket, so S3 answers 403 rather than 404
// for one that isn't there; both mean no.
func (b *Bucket) Stored(ctx context.Context, id string) (bool, error) {
	_, err := b.S3.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &b.Name, Key: key(id)})
	var answer interface{ HTTPStatusCode() int }
	if errors.As(err, &answer) && (answer.HTTPStatusCode() == http.StatusNotFound || answer.HTTPStatusCode() == http.StatusForbidden) {
		return false, nil
	}
	return err == nil, err
}

// Delete deletes id's ciphertext. Deleting one that's gone is fine.
func (b *Bucket) Delete(ctx context.Context, id string) error {
	_, err := b.S3.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &b.Name, Key: key(id)})
	return err
}
