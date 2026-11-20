package ephemeral

import (
	"bytes"
	"context"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/awsconf"
	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
)

func TestUploads(t *testing.T) {
	client := dynamotest.Client(t)
	clock := time.Unix(1_800_000_000, 0)
	u := &Uploads{DB: client, Table: dynamotest.Table(t, client), Now: func() time.Time { return clock }}
	ctx := context.Background()
	hash := bytes.Repeat([]byte{7}, 32)

	if _, ok, err := u.Get(ctx, "up1"); ok || err != nil {
		t.Fatalf("before: %v %v", ok, err)
	}
	if err := u.Put(ctx, "up1", Upload{DeleteHash: hash, Size: 1234}, clock.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := u.Put(ctx, "up1", Upload{DeleteHash: hash, Size: 1}, clock.Add(time.Hour)); err == nil {
		t.Fatal("a taken ID was accepted")
	}
	got, ok, err := u.Get(ctx, "up1")
	if err != nil || !ok || !bytes.Equal(got.DeleteHash, hash) || got.Size != 1234 {
		t.Fatalf("Get = %+v %v %v", got, ok, err)
	}
	if looked, ok, err := u.Lookup(ctx, "up1"); err != nil || !ok || !bytes.Equal(looked.DeleteHash, hash) || !looked.Expires.Equal(got.Expires) {
		t.Fatalf("Lookup = %+v %v %v", looked, ok, err)
	}
	if _, ok, err := u.Lookup(ctx, "up2"); ok || err != nil {
		t.Fatalf("Lookup of none = %v %v", ok, err)
	}
	clock = clock.Add(time.Hour)
	if _, ok, _ := u.Get(ctx, "up1"); ok {
		t.Fatal("expired upload still there")
	}
	if _, ok, _ := u.Lookup(ctx, "up1"); ok {
		t.Fatal("Lookup: expired upload still there")
	}
	if err := u.Delete(ctx, "up1"); err != nil {
		t.Fatal(err)
	}

	// The record holds no exact time: its expiry is rounded up to the
	// minute.
	paid := clock.Add(37 * time.Second)
	if err := u.Put(ctx, "up2", Upload{DeleteHash: hash, Size: 1}, paid.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	got, _, _ = u.Get(ctx, "up2")
	if got.Expires.Unix()%60 != 0 || got.Expires.Before(paid.Add(time.Hour)) || got.Expires.After(paid.Add(time.Hour+time.Minute)) {
		t.Fatalf("expires %v for %v", got.Expires, paid.Add(time.Hour))
	}
}

func TestUploadRenewals(t *testing.T) {
	client := dynamotest.Client(t)
	clock := time.Unix(1_800_000_000, 0)
	u := &Uploads{DB: client, Table: dynamotest.Table(t, client), Now: func() time.Time { return clock }}
	ctx := context.Background()
	hash := bytes.Repeat([]byte{7}, 32)
	const keep = 30 * 24 * time.Hour
	// Paid for at most 3 hours ago: it expires after now + keep - 3h.
	renew := func(id string) bool {
		t.Helper()
		ok, err := u.Renew(ctx, id, 2, clock.Add(keep-3*time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	put := func(id string, paid time.Time) {
		t.Helper()
		if err := u.Put(ctx, id, Upload{DeleteHash: hash, Size: 2 << 20}, paid.Add(keep)); err != nil {
			t.Fatal(err)
		}
	}

	// Nothing to renew, and nothing is created by trying.
	if renew("up1") {
		t.Fatal("renewed an unknown upload")
	}
	if _, ok, _ := u.Get(ctx, "up1"); ok {
		t.Fatal("renewing created an upload")
	}
	// At most twice; Get says how many so far, and when it expires.
	put("up1", clock.Add(-time.Hour))
	if got, _, _ := u.Get(ctx, "up1"); got.Renewals != 0 || !got.Expires.Equal(clock.Add(keep-time.Hour)) {
		t.Fatalf("Get = %+v", got)
	}
	if !renew("up1") || !renew("up1") {
		t.Fatal("renewal refused")
	}
	if renew("up1") {
		t.Fatal("a third renewal")
	}
	// The record is unchanged otherwise.
	if got, ok, err := u.Get(ctx, "up1"); err != nil || !ok || got.Size != 2<<20 || !bytes.Equal(got.DeleteHash, hash) || got.Renewals != 2 {
		t.Fatalf("Get = %+v %v %v", got, ok, err)
	}
	// Paid for a second under 3 hours ago, yes; exactly 3 hours ago, no.
	put("up2", clock.Add(-3*time.Hour+time.Second))
	if !renew("up2") {
		t.Fatal("refused within the window")
	}
	put("up3", clock.Add(-3*time.Hour))
	if renew("up3") {
		t.Fatal("renewed an upload paid for 3 hours ago")
	}
	// Not once it expired.
	put("up4", clock.Add(-time.Hour))
	clock = clock.Add(keep)
	if ok, err := u.Renew(ctx, "up4", 2, clock.Add(-2*time.Hour)); ok || err != nil {
		t.Fatalf("renewed an expired upload: %v", err)
	}
}

func TestUploadRenewalsRace(t *testing.T) {
	client := dynamotest.Client(t)
	clock := time.Unix(1_800_000_000, 0)
	u := &Uploads{DB: client, Table: dynamotest.Table(t, client), Now: func() time.Time { return clock }}
	ctx := context.Background()
	if err := u.Put(ctx, "up", Upload{DeleteHash: bytes.Repeat([]byte{7}, 32), Size: 16 << 10}, clock.Add(24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	// 40 at once, as many as a script could send: exactly 3 get through.
	var wg sync.WaitGroup
	var granted atomic.Int32
	for range 40 {
		wg.Go(func() {
			ok, err := u.Renew(ctx, "up", 3, clock)
			if err != nil {
				t.Error(err)
			}
			if ok {
				granted.Add(1)
			}
		})
	}
	wg.Wait()
	if granted.Load() != 3 {
		t.Fatalf("%d renewals granted", granted.Load())
	}
}

func TestUploadsInBatches(t *testing.T) {
	client := dynamotest.Client(t)
	clock := time.Unix(1_800_000_000, 0)
	u := &Uploads{DB: client, Table: dynamotest.Table(t, client), Now: func() time.Time { return clock }}
	ctx := context.Background()
	hash := bytes.Repeat([]byte{7}, 32)
	var all []string
	for i := range 60 {
		id := fmt.Sprintf("up%02d", i)
		all = append(all, id)
		// The first expires before the rest.
		expires := clock.Add(time.Hour)
		if i == 0 {
			expires = clock.Add(time.Minute)
		}
		if err := u.Put(ctx, id, Upload{DeleteHash: hash, Size: int64(16<<10) << (i % 3)}, expires); err != nil {
			t.Fatal(err)
		}
	}
	paid := clock
	clock = clock.Add(2 * time.Minute)

	// Those there, once each: not the expired one, nor an unknown one, and
	// one asked for twice is read once (DynamoDB refuses a batch naming an
	// item twice).
	found, err := u.LookupAll(ctx, append(slices.Clone(all), "up01", "none"))
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != 59 {
		t.Fatalf("found %d", len(found))
	}
	if _, ok := found["up00"]; ok {
		t.Fatal("an expired upload was found")
	}
	if up := found["up05"]; !bytes.Equal(up.DeleteHash, hash) || up.Size != 64<<10 || !up.Expires.Equal(paid.Add(time.Hour)) {
		t.Fatalf("up05 = %+v", up)
	}
	if found, err := u.LookupAll(ctx, nil); err != nil || len(found) != 0 {
		t.Fatalf("LookupAll(nil) = %v, %v", found, err)
	}
	// At most 100 different ones a call.
	many := make([]string, MaxLookupAll+1)
	for i := range many {
		many[i] = fmt.Sprint(i)
	}
	if _, err := u.LookupAll(ctx, many); err == nil {
		t.Fatal("looked up more than a batch takes")
	}
	if _, err := u.LookupAll(ctx, append(many[:MaxLookupAll], many[0])); err != nil {
		t.Fatalf("a full batch, one repeated: %v", err)
	}

	// Deleted 25 to a write, all of them; an unknown one is no matter.
	if err := u.DeleteAll(ctx, append(slices.Clone(all), "none")); err != nil {
		t.Fatal(err)
	}
	for _, part := range [][]string{all[:50], all[50:]} {
		if found, err := u.LookupAll(ctx, part); err != nil || len(found) != 0 {
			t.Fatalf("after DeleteAll: %d found, %v", len(found), err)
		}
	}
	if err := u.DeleteAll(ctx, nil); err != nil {
		t.Fatal(err)
	}
}

// stingyDB does, as a throttled table does, only the first item of each
// batch and hands back the rest undone: the next `rounds` batches, or every
// one if rounds is negative.
type stingyDB struct {
	*dynamodb.Client
	rounds  int
	batches int
}

func (s *stingyDB) BatchGetItem(ctx context.Context, in *dynamodb.BatchGetItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error) {
	s.batches++
	if s.rounds == 0 {
		return s.Client.BatchGetItem(ctx, in, opts...)
	}
	s.rounds--
	done, rest := map[string]types.KeysAndAttributes{}, map[string]types.KeysAndAttributes{}
	for table, ka := range in.RequestItems {
		first, others := ka, ka
		first.Keys, others.Keys = ka.Keys[:1], ka.Keys[1:]
		done[table] = first
		if len(others.Keys) > 0 {
			rest[table] = others
		}
	}
	out, err := s.Client.BatchGetItem(ctx, &dynamodb.BatchGetItemInput{RequestItems: done}, opts...)
	if err != nil {
		return nil, err
	}
	out.UnprocessedKeys = rest
	return out, nil
}

func (s *stingyDB) BatchWriteItem(ctx context.Context, in *dynamodb.BatchWriteItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.BatchWriteItemOutput, error) {
	s.batches++
	if s.rounds == 0 {
		return s.Client.BatchWriteItem(ctx, in, opts...)
	}
	s.rounds--
	done, rest := map[string][]types.WriteRequest{}, map[string][]types.WriteRequest{}
	for table, requests := range in.RequestItems {
		done[table] = requests[:1]
		if len(requests) > 1 {
			rest[table] = requests[1:]
		}
	}
	out, err := s.Client.BatchWriteItem(ctx, &dynamodb.BatchWriteItemInput{RequestItems: done}, opts...)
	if err != nil {
		return nil, err
	}
	out.UnprocessedItems = rest
	return out, nil
}

// What DynamoDB leaves undone is asked for again, a few times.
func TestUploadsBatchesLeftUndone(t *testing.T) {
	client := dynamotest.Client(t)
	clock := time.Unix(1_800_000_000, 0)
	db := &stingyDB{Client: client}
	u := &Uploads{DB: db, Table: dynamotest.Table(t, client), Now: func() time.Time { return clock }}
	ctx := context.Background()
	ids := []string{"a", "b", "c", "d", "e"}
	for _, id := range ids {
		if err := u.Put(ctx, id, Upload{DeleteHash: bytes.Repeat([]byte{7}, 32), Size: 16 << 10}, clock.Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}

	// Twice part undone, then the rest at once.
	db.rounds, db.batches = 2, 0
	found, err := u.LookupAll(ctx, ids)
	if err != nil || len(found) != 5 || db.batches != 3 {
		t.Fatalf("LookupAll = %d found, %v, after %d batches", len(found), err, db.batches)
	}
	db.rounds, db.batches = 2, 0
	if err := u.DeleteAll(ctx, ids[:3]); err != nil || db.batches != 3 {
		t.Fatalf("DeleteAll = %v, after %d batches", err, db.batches)
	}
	if found, err := u.LookupAll(ctx, ids); err != nil || len(found) != 2 || found["d"].Size == 0 || found["e"].Size == 0 {
		t.Fatalf("after DeleteAll: %v, %v", found, err)
	}

	// Never all of it: an error after a few tries, which the api answers as
	// throttling (503, try again shortly).
	db.rounds, db.batches = -1, 0
	if _, err := u.LookupAll(ctx, ids); !awsconf.Unavailable(err) || db.batches != batchTries {
		t.Fatalf("LookupAll = %v, after %d batches", err, db.batches)
	}
	db.batches = 0
	if err := u.DeleteAll(ctx, ids); !awsconf.Unavailable(err) || db.batches != batchTries {
		t.Fatalf("DeleteAll = %v, after %d batches", err, db.batches)
	}
}
