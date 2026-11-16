package media

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// recorder is the real presigner (signing needs no network), keeping the last
// request it signed.
type recorder struct {
	*s3.PresignClient
	last *v4.PresignedHTTPRequest
}

func (r *recorder) PresignPutObject(ctx context.Context, in *s3.PutObjectInput, opts ...func(*s3.PresignOptions)) (*v4.PresignedHTTPRequest, error) {
	req, err := r.PresignClient.PresignPutObject(ctx, in, opts...)
	r.last = req
	return req, err
}

func (r *recorder) PresignGetObject(ctx context.Context, in *s3.GetObjectInput, opts ...func(*s3.PresignOptions)) (*v4.PresignedHTTPRequest, error) {
	req, err := r.PresignClient.PresignGetObject(ctx, in, opts...)
	r.last = req
	return req, err
}

func newBucket() (*Bucket, *recorder) {
	client := s3.New(s3.Options{
		Region:      "us-east-1",
		Credentials: credentials.NewStaticCredentialsProvider("AKIDEXAMPLE", "secret", "token"),
		// The SDK would otherwise add a checksum of an empty body to the
		// signature, and the browser's upload would be refused.
		RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
	})
	rec := &recorder{PresignClient: s3.NewPresignClient(client)}
	return &Bucket{Presign: rec, S3: client, Name: "incognitochat-test-media-abc"}, rec
}

func parse(t *testing.T, raw string) (*url.URL, url.Values) {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if u.Scheme != "https" || !strings.HasPrefix(u.Host, "incognitochat-test-media-abc.s3.us-east-1.") || u.Path != "/m/IDIDIDIDIDIDIDIDIDIDID" {
		t.Fatalf("url = %s", raw)
	}
	return u, u.Query()
}

// S3 itself can't run here. What it does with these is documented: it
// refuses a request whose signed headers differ, answers 412 to a PUT with
// "If-None-Match: *" once the object exists, and refuses a URL whose
// X-Amz-Expires has passed when the request starts.
func TestUploadURLWritesOnceTheExactLengthAndTypeWithinAMinute(t *testing.T) {
	bucket, rec := newBucket()
	raw, err := bucket.UploadURL(context.Background(), "IDIDIDIDIDIDIDIDIDIDID", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	_, q := parse(t, raw)
	signed := strings.Split(q.Get("X-Amz-SignedHeaders"), ";")
	// A second PUT with the same URL is refused: the URL works only with
	// If-None-Match: *, which S3 refuses once the object exists.
	for _, h := range []string{"content-length", "content-type", "host", "if-none-match"} {
		if !contains(signed, h) {
			t.Errorf("%s not signed: %v", h, signed)
		}
	}
	for h, want := range map[string]string{"If-None-Match": "*", "Content-Type": "application/octet-stream", "Content-Length": "1048576"} {
		if got := rec.last.SignedHeader.Get(h); got != want {
			t.Errorf("signed %s = %q, want %q", h, got, want)
		}
	}
	// A PUT after the start window is refused: the URL expires a minute after
	// it was signed (and the bucket policy refuses signatures older than two).
	if q.Get("X-Amz-Expires") != "60" {
		t.Errorf("expires = %s", q.Get("X-Amz-Expires"))
	}
	for k := range q {
		if strings.Contains(strings.ToLower(k), "checksum") || strings.EqualFold(k, "If-None-Match") {
			t.Errorf("%s in the URL, not a signed header", k)
		}
	}
}

func TestDownloadURLFixesTheAnswersEncodingAndType(t *testing.T) {
	bucket, _ := newBucket()
	raw, err := bucket.DownloadURL(context.Background(), "IDIDIDIDIDIDIDIDIDIDID")
	if err != nil {
		t.Fatal(err)
	}
	_, q := parse(t, raw)
	// Query parameters are part of a presigned URL's signature.
	if q.Get("response-content-encoding") != "identity" || q.Get("response-content-type") != "application/octet-stream" {
		t.Errorf("overrides = %q %q", q.Get("response-content-encoding"), q.Get("response-content-type"))
	}
	if q.Get("X-Amz-Expires") != "60" || q.Get("X-Amz-Signature") == "" {
		t.Errorf("url = %s", raw)
	}
}

func TestStored(t *testing.T) {
	// What S3 answers a HEAD for each key: without s3:ListBucket, a missing
	// key is 403, not 404.
	answers := map[string]int{"/b/m/there": 200, "/b/m/missing": 403, "/b/m/listed": 404, "/b/m/broken": 400}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(answers[r.URL.Path])
	}))
	defer srv.Close()
	client := s3.New(s3.Options{
		Region:       "us-east-1",
		BaseEndpoint: aws.String(srv.URL),
		UsePathStyle: true,
		Credentials:  credentials.NewStaticCredentialsProvider("AKIDEXAMPLE", "secret", ""),
	})
	bucket := &Bucket{S3: client, Name: "b"}
	for id, want := range map[string]bool{"there": true, "missing": false, "listed": false} {
		if got, err := bucket.Stored(context.Background(), id); err != nil || got != want {
			t.Errorf("Stored(%s) = %v, %v", id, got, err)
		}
	}
	if _, err := bucket.Stored(context.Background(), "broken"); err == nil {
		t.Error("an error answer counted as an answer")
	}
}

func TestPaddedSize(t *testing.T) {
	for _, size := range []int64{16 << 10, 32 << 10, 64 << 10, 128 << 10, 256 << 10, 512 << 10, 1 << 20, 2 << 20, 7 << 20, MaxSize} {
		if !PaddedSize(size) {
			t.Errorf("%d refused", size)
		}
	}
	for _, size := range []int64{-1 << 20, 0, 1, 10, 8 << 10, 16<<10 + 1, 48 << 10, 1<<20 + 1, 3<<20 - 1, 3<<20 + 512<<10, MaxSize + 1<<20} {
		if PaddedSize(size) {
			t.Errorf("%d accepted", size)
		}
	}
}

func TestTokensFor(t *testing.T) {
	for size, want := range map[int64]int{1: 1, MinSize: 1, TokenBytes: 1, TokenBytes + 1: 2, MaxSize: 51} {
		if got := TokensFor(size); got != want {
			t.Errorf("TokensFor(%d) = %d, want %d", size, got, want)
		}
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
