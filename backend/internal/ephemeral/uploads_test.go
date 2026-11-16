package ephemeral

import (
	"bytes"
	"context"
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
	clock = clock.Add(time.Hour)
	if _, ok, _ := u.Get(ctx, "up1"); ok {
		t.Fatal("expired upload still there")
	}
	if err := u.Delete(ctx, "up1"); err != nil {
		t.Fatal(err)
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
	// At most twice.
	put("up1", clock.Add(-time.Hour))
	if !renew("up1") || !renew("up1") {
		t.Fatal("renewal refused")
	}
	if renew("up1") {
		t.Fatal("a third renewal")
	}
	// The record is unchanged otherwise.
	if got, ok, err := u.Get(ctx, "up1"); err != nil || !ok || got.Size != 2<<20 || !bytes.Equal(got.DeleteHash, hash) {
		t.Fatalf("Get = %+v %v %v", got, ok, err)
	}
	// Not for an upload paid for too long ago, or expired.
	put("up2", clock.Add(-4*time.Hour))
	if renew("up2") {
		t.Fatal("renewed an old upload")
	}
	put("up3", clock.Add(-time.Hour))
	clock = clock.Add(keep)
	if ok, err := u.Renew(ctx, "up3", 2, clock.Add(-2*time.Hour)); ok || err != nil {
		t.Fatalf("renewed an expired upload: %v", err)
	}
}
