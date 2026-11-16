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
	renew := func(id string, hash []byte) bool {
		t.Helper()
		up, ok, err := u.Renew(ctx, id, hash, 2)
		if err != nil {
			t.Fatal(err)
		}
		if ok && (up.Size != 2<<20 || !bytes.Equal(up.DeleteHash, hash)) {
			t.Fatalf("Renew = %+v", up)
		}
		return ok
	}

	// Nothing to renew, and nothing is created by trying.
	if renew("up1", hash) {
		t.Fatal("renewed an unknown upload")
	}
	if _, ok, _ := u.Get(ctx, "up1"); ok {
		t.Fatal("renewing created an upload")
	}
	if err := u.Put(ctx, "up1", Upload{DeleteHash: hash, Size: 2 << 20}, clock.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	// Only with the delete secret's hash, and at most twice.
	if renew("up1", bytes.Repeat([]byte{8}, 32)) {
		t.Fatal("renewed with the wrong hash")
	}
	if !renew("up1", hash) || !renew("up1", hash) {
		t.Fatal("renewal refused")
	}
	if renew("up1", hash) {
		t.Fatal("a third renewal")
	}
	// The record is unchanged otherwise.
	if got, ok, err := u.Get(ctx, "up1"); err != nil || !ok || got.Size != 2<<20 {
		t.Fatalf("Get = %+v %v %v", got, ok, err)
	}
	// Not once it has expired.
	if err := u.Put(ctx, "up2", Upload{DeleteHash: hash, Size: 2 << 20}, clock.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(time.Hour)
	if renew("up2", hash) {
		t.Fatal("renewed an expired upload")
	}
}
