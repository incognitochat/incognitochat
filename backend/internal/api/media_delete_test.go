package api

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"

	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/media"
)

// fakeS3 is the media bucket's S3, for deletes: it holds keys, deletes
// them, and fails to delete those in fail, one by one as S3 can, or every
// request while err is set.
type fakeS3 struct {
	mu      sync.Mutex
	objects map[string]bool
	fail    map[string]bool
	err     error
	// The keys each DeleteObjects named, and whether it asked to be quiet.
	asked [][]string
	quiet []bool
}

func (f *fakeS3) HeadObject(context.Context, *s3.HeadObjectInput, ...func(*s3.Options)) (*s3.HeadObjectOutput, error) {
	return nil, errors.New("not used")
}

func (f *fakeS3) DeleteObject(_ context.Context, in *s3.DeleteObjectInput, _ ...func(*s3.Options)) (*s3.DeleteObjectOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.objects, aws.ToString(in.Key))
	return &s3.DeleteObjectOutput{}, nil
}

func (f *fakeS3) DeleteObjects(_ context.Context, in *s3.DeleteObjectsInput, _ ...func(*s3.Options)) (*s3.DeleteObjectsOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	out := &s3.DeleteObjectsOutput{}
	var keys []string
	for _, o := range in.Delete.Objects {
		key := aws.ToString(o.Key)
		keys = append(keys, key)
		if f.fail[key] {
			out.Errors = append(out.Errors, s3types.Error{Key: o.Key, Code: aws.String("InternalError")})
			continue
		}
		delete(f.objects, key)
	}
	f.asked = append(f.asked, keys)
	f.quiet = append(f.quiet, aws.ToBool(in.Delete.Quiet))
	return out, nil
}

// batchDeletes is a server whose uploads are recorded on DynamoDB Local,
// metered, with the bucket's S3 faked.
type batchDeletes struct {
	h       *harness
	meter   *dynamotest.Meter
	table   string
	uploads *ephemeral.Uploads
	s3      *fakeS3
}

func newBatchDeletes(t *testing.T) *batchDeletes {
	t.Helper()
	client := dynamotest.Client(t)
	b := &batchDeletes{h: newHarness(t), meter: dynamotest.NewMeter(client), table: dynamotest.Table(t, client),
		s3: &fakeS3{objects: map[string]bool{}, fail: map[string]bool{}}}
	b.uploads = &ephemeral.Uploads{DB: b.meter, Table: b.table, Now: func() time.Time { return b.h.now }}
	b.h.server.Uploads = b.uploads
	b.h.server.Media = &media.Bucket{S3: b.s3, Name: "media"}
	return b
}

type stored struct{ id, secret string }

// put records n uploads, stored in the bucket, each with its own secret,
// expiring after keep.
func (b *batchDeletes) put(t *testing.T, n int, keep time.Duration) []stored {
	t.Helper()
	out := make([]stored, n)
	for i := range out {
		secret := randomBytes(t, 16)
		hash := sha256.Sum256(secret)
		out[i] = stored{ids.New(), b64(secret)}
		if err := b.uploads.Put(context.Background(), out[i].id, ephemeral.Upload{DeleteHash: hash[:], Size: 16 << 10}, b.h.now.Add(keep)); err != nil {
			t.Fatal(err)
		}
		b.s3.objects["m/"+out[i].id] = true
	}
	return out
}

func (b *batchDeletes) there(t *testing.T, id string) bool {
	t.Helper()
	_, ok, err := b.uploads.Get(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if ok != b.s3.objects["m/"+id] {
		t.Fatalf("%s: record there %v, in the bucket %v", id, ok, !ok)
	}
	return ok
}

func item(id, secret string) map[string]any { return map[string]any{"id": id, "secret": secret} }

// del asks POST /media/delete, with no login, and returns its answers.
func (b *batchDeletes) del(t *testing.T, items ...map[string]any) []string {
	t.Helper()
	status, out := b.h.post(t, "/media/delete", map[string]any{"items": items})
	if status != http.StatusOK {
		t.Fatalf("POST /media/delete: %d %v", status, out)
	}
	list, _ := out["results"].([]any)
	results := make([]string, len(list))
	for i, r := range list {
		results[i], _ = r.(string)
	}
	if len(results) != len(items) {
		t.Fatalf("%d results for %d items: %v", len(results), len(items), out)
	}
	return results
}

func wantResults(t *testing.T, got []string, want ...string) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Fatalf("results %v, want %v", got, want)
	}
}

// Each upload in a batch is deleted for its own secret, as POST
// /media/{id}/delete deletes one, and answered on its own: those the
// bucket couldn't delete stay, and go when asked again.
func TestDeleteUploadsInBatches(t *testing.T) {
	b := newBatchDeletes(t)
	ups := b.put(t, 3, media.Retention)
	a, c, x := ups[0], ups[1], ups[2]
	soon := b.put(t, 1, time.Minute)[0]
	b.h.now = b.h.now.Add(2 * time.Minute) // soon has expired
	// The bucket fails to delete c, this time.
	b.s3.fail["m/"+c.id] = true
	batch := []map[string]any{
		item(a.id, a.secret),          // deleted
		item(x.id, b64([]byte("no"))), // a wrong secret
		item(ids.New(), a.secret),     // no such upload
		item("not-an-id", a.secret),   // can't name one
		item(x.id, "not base64!"),     // a malformed secret
		item(x.id, ""),                // no secret
		item(c.id, c.secret),          // the bucket fails to delete it
		item(soon.id, soon.secret),    // expired
		item(a.id, a.secret),          // the same again: deleted, once
		item(x.id, x.secret),          // deleted, though asked with a wrong secret above
	}
	wantResults(t, b.del(t, batch...),
		"deleted", "not_found", "not_found", "not_found", "not_found", "not_found", "failed", "not_found", "deleted", "deleted")
	// One request to the bucket, quiet, for the three whose secret matched,
	// each once.
	if len(b.s3.asked) != 1 || !b.s3.quiet[0] || strings.Join(b.s3.asked[0], ",") != "m/"+a.id+",m/"+c.id+",m/"+x.id {
		t.Fatalf("asked the bucket %v (quiet %v)", b.s3.asked, b.s3.quiet)
	}
	if b.there(t, a.id) || b.there(t, x.id) || !b.there(t, c.id) {
		t.Fatal("deleted the wrong ones")
	}
	// The log says how many failed, never which.
	if !strings.Contains(b.h.logs.String(), `"msg":"uploads not deleted"`) || !strings.Contains(b.h.logs.String(), `"count":1`) || strings.Contains(b.h.logs.String(), c.id) {
		t.Fatalf("log %s", b.h.logs)
	}

	// Asked again, once the bucket can: the one it kept goes, and those
	// gone are not_found.
	b.s3.fail = map[string]bool{}
	wantResults(t, b.del(t, batch...),
		"not_found", "not_found", "not_found", "not_found", "not_found", "not_found", "deleted", "not_found", "not_found", "not_found")
	if b.there(t, c.id) {
		t.Fatal("c is still there")
	}
	// Again: nothing is left to delete, and nothing is written or asked of
	// the bucket.
	b.meter.Reset()
	asked := len(b.s3.asked)
	wantResults(t, b.del(t, batch...),
		"not_found", "not_found", "not_found", "not_found", "not_found", "not_found", "not_found", "not_found", "not_found", "not_found")
	if w := b.meter.Units(b.table).Write; w != 0 || len(b.s3.asked) != asked {
		t.Fatalf("a batch of nothing to delete wrote %v units and asked the bucket %d times", w, len(b.s3.asked)-asked)
	}

	// The bucket failing as a whole: nothing is deleted, and the app tries
	// again later.
	more := b.put(t, 2, media.Retention)
	b.s3.err = errors.New("bucket unreachable")
	status, out := b.h.post(t, "/media/delete", map[string]any{"items": []map[string]any{item(more[0].id, more[0].secret), item(more[1].id, more[1].secret)}})
	wantError(t, status, out, http.StatusInternalServerError, "internal")
	if !b.there(t, more[0].id) || !b.there(t, more[1].id) {
		t.Fatal("deleted though the bucket failed")
	}
	b.s3.err = nil
	wantResults(t, b.del(t, item(more[0].id, more[0].secret), item(more[1].id, more[1].secret)), "deleted", "deleted")

	// The single route still works, for older apps; then the batch finds
	// nothing.
	one := b.put(t, 1, media.Retention)[0]
	if status, out := b.h.post(t, "/media/"+one.id+"/delete", map[string]any{"secret": one.secret}); status != http.StatusOK {
		t.Fatalf("POST /media/{id}/delete: %d %v", status, out)
	}
	wantResults(t, b.del(t, item(one.id, one.secret)), "not_found")
}

// A batch is at most 100 uploads, and costs the table no more than 100
// single deletes would: half a read unit each, and one write unit for each
// upload deleted.
func TestDeleteUploadsBatchLimits(t *testing.T) {
	b := newBatchDeletes(t)
	ups := b.put(t, DeleteBatch+1, media.Retention)
	items := make([]map[string]any, len(ups))
	for i, up := range ups {
		items[i] = item(up.id, up.secret)
	}
	refused := func(body any) {
		t.Helper()
		b.meter.Reset()
		status, out := b.h.post(t, "/media/delete", body)
		wantError(t, status, out, http.StatusBadRequest, "bad_request")
		if calls := b.meter.Calls(); len(calls) != 0 || len(b.s3.asked) != 0 {
			t.Fatalf("a refused batch read %v and asked the bucket %v", calls, b.s3.asked)
		}
	}
	// None, or more than 100: refused before anything is read.
	refused(map[string]any{"items": []any{}})
	refused(map[string]any{})
	refused(map[string]any{"items": items})
	// Malformed: an unknown field, an ID that isn't a string.
	refused(map[string]any{"items": []any{map[string]any{"id": ups[0].id, "secret": ups[0].secret, "size": 1}}})
	refused(map[string]any{"items": []any{map[string]any{"id": 7, "secret": ups[0].secret}}})
	// Over the body limit (64 KiB), whatever it holds.
	long := strings.Repeat("A", 700)
	big := make([]map[string]any, DeleteBatch)
	for i := range big {
		big[i] = item(ups[i].id, long)
	}
	refused(map[string]any{"items": big})
	for _, up := range ups {
		if !b.there(t, up.id) {
			t.Fatal("a refused batch deleted something")
		}
	}

	// 100 unknown uploads: one read of at most 50 units, nothing written,
	// nothing asked of the bucket.
	unknown := make([]map[string]any, DeleteBatch)
	for i := range unknown {
		unknown[i] = item(ids.New(), ups[0].secret)
	}
	b.meter.Reset()
	results := b.del(t, unknown...)
	for _, r := range results {
		if r != "not_found" {
			t.Fatalf("results %v", results)
		}
	}
	cost := b.meter.Units(b.table)
	t.Logf("100 unknown uploads: R %.1f W %.1f, %v", cost.Read, cost.Write, b.meter.Calls())
	if cost.Read > 50 || cost.Write != 0 || len(b.s3.asked) != 0 || !slices.Equal(b.meter.Calls(), []string{"BatchGetItem " + b.table}) {
		t.Fatalf("100 unknown uploads: %+v, %v, bucket %v", cost, b.meter.Calls(), b.s3.asked)
	}

	// 100 that are there: one read, 100 write units in four writes, and
	// one request to the bucket.
	b.meter.Reset()
	results = b.del(t, items[:DeleteBatch]...)
	for _, r := range results {
		if r != "deleted" {
			t.Fatalf("results %v", results)
		}
	}
	cost = b.meter.Units(b.table)
	t.Logf("100 uploads deleted: R %.1f W %.1f, %v", cost.Read, cost.Write, b.meter.Calls())
	writes := slices.Repeat([]string{"BatchWriteItem " + b.table}, 4)
	if cost.Read > 50 || cost.Write != DeleteBatch || len(b.s3.asked) != 1 || len(b.s3.asked[0]) != DeleteBatch ||
		!slices.Equal(b.meter.Calls(), append([]string{"BatchGetItem " + b.table}, writes...)) {
		t.Fatalf("100 uploads: %+v, %v, bucket asked %d times", cost, b.meter.Calls(), len(b.s3.asked))
	}
	for _, up := range ups[:DeleteBatch] {
		if b.there(t, up.id) {
			t.Fatalf("%s is still there", up.id)
		}
	}
	if !b.there(t, ups[DeleteBatch].id) {
		t.Fatal("the 101st went too")
	}

	// Without attachments, the route answers as for a server without it.
	b.h.server.Media = nil
	status, out := b.h.post(t, "/media/delete", map[string]any{"items": []any{item(ups[DeleteBatch].id, ups[DeleteBatch].secret)}})
	wantError(t, status, out, http.StatusNotFound, "not_found")
}

// The route is its own: GET /media/delete is a download of an upload that
// can't exist, and other methods are refused as for any route.
func TestDeleteUploadsRoute(t *testing.T) {
	h := newHarness(t)
	h.server.Media, h.server.Uploads = &memMedia{}, &memUploads{ups: map[string]ephemeral.Upload{}}
	for method, want := range map[string]int{http.MethodGet: http.StatusNotFound, http.MethodPut: http.StatusMethodNotAllowed, http.MethodDelete: http.StatusMethodNotAllowed} {
		var req httpapi.Request
		req.RawPath = "/media/delete"
		req.RequestContext.HTTP.Method = method
		resp, err := h.router.Serve(context.Background(), req)
		if err != nil || resp.StatusCode != want {
			t.Errorf("%s /media/delete: %d %v, want %d", method, resp.StatusCode, err, want)
		}
	}
	// An older server, without the route, answers a POST to it 405 (GET
	// /media/{id} has the path): the app then deletes one at a time.
	old := httpapi.NewRouter()
	old.Handle(http.MethodGet, "/media/{id}", func(context.Context, httpapi.Request) httpapi.Response {
		return httpapi.JSON(http.StatusOK, struct{}{})
	})
	old.Handle(http.MethodPost, "/media/{id}/delete", func(context.Context, httpapi.Request) httpapi.Response {
		return httpapi.JSON(http.StatusOK, struct{}{})
	})
	var req httpapi.Request
	req.RawPath = "/media/delete"
	req.RequestContext.HTTP.Method = http.MethodPost
	if resp, _ := old.Serve(context.Background(), req); resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("an older server answers %d", resp.StatusCode)
	}
}
