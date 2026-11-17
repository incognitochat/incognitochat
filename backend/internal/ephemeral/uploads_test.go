package ephemeral

import (
	"bytes"
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

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
