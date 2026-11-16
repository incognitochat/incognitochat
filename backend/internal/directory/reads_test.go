package directory

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
)

// metered is a store whose reads and writes are counted.
func metered(t *testing.T) (*Store, *dynamotest.Meter, *dynamodb.Client) {
	t.Helper()
	client := dynamotest.Client(t)
	meter := dynamotest.NewMeter(client)
	return &Store{DB: meter, Table: dynamotest.Table(t, client)}, meter, client
}

// grow gives an account n mailboxes, written directly (the way the API
// makes them would take a while).
func grow(t *testing.T, client *dynamodb.Client, table, account string, n int) []string {
	t.Helper()
	var made []string
	var requests []types.WriteRequest
	for range n {
		id := ids.New()
		made = append(made, id)
		requests = append(requests,
			types.WriteRequest{PutRequest: &types.PutRequest{Item: item(accountPK(account), mailboxPrefix+id, attrs{})}},
			types.WriteRequest{PutRequest: &types.PutRequest{Item: item(mailboxPK(id), skMailbox, attrs{"o": sv(account)})}},
		)
	}
	for len(requests) > 0 {
		k := min(25, len(requests))
		if _, err := client.BatchWriteItem(context.Background(), &dynamodb.BatchWriteItemInput{
			RequestItems: map[string][]types.WriteRequest{table: requests[:k]},
		}); err != nil {
			t.Fatal(err)
		}
		requests = requests[k:]
	}
	return made
}

// Registration reads only what it needs, however big the account: not the
// whole partition, which was 52 read units at 4,000 mailboxes.
func TestByTelegramReadsLittle(t *testing.T) {
	s, meter, client := metered(t)
	ctx := context.Background()
	n := newAccount(t, "th-1")
	if err := s.Create(ctx, n); err != nil {
		t.Fatal(err)
	}
	grow(t, client, s.Table, n.ID, 4000)

	meter.Reset()
	got, err := s.ByTelegram(ctx, "th-1", n.DeviceID)
	if err != nil || got.ID != n.ID || !bytes.Equal(got.Key, n.AccountKey) || !bytes.Equal(got.DeviceKey, n.DeviceKey) {
		t.Fatalf("ByTelegram = %+v, %v", got, err)
	}
	if u := meter.Units(s.Table); u.Read > 2 {
		t.Fatalf("ByTelegram read %.1f units", u.Read)
	}
	// Another device of the account: no key.
	if got, err := s.ByTelegram(ctx, "th-1", ids.New()); err != nil || got.DeviceKey != nil || got.ID != n.ID {
		t.Fatalf("ByTelegram for another device = %+v, %v", got, err)
	}

	meter.Reset()
	if id, err := s.AccountOf(ctx, "th-1"); err != nil || id != n.ID {
		t.Fatalf("AccountOf = %q, %v", id, err)
	}
	if _, err := s.AccountOf(ctx, "th-2"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("AccountOf of nobody: %v", err)
	}
	if u := meter.Units(s.Table); u.Read > 2 {
		t.Fatalf("two lookups read %.1f units", u.Read)
	}
}

// A logged-in request reads its device and account in one strongly
// consistent read, and a replaced or deleted account is refused at once.
func TestDeviceIsOneRead(t *testing.T) {
	s, meter, client := metered(t)
	ctx := context.Background()
	n := newAccount(t, "th-1")
	if err := s.Create(ctx, n); err != nil {
		t.Fatal(err)
	}
	grow(t, client, s.Table, n.ID, 50)
	// Devices that sort on either side of it don't get in the way.
	for _, other := range []string{"AAAAAAAAAAAAAAAAAAAAAA", "______________________"} {
		if _, err := client.PutItem(ctx, &dynamodb.PutItemInput{TableName: &s.Table, Item: item(accountPK(n.ID), devicePrefix+other, attrs{"k": bv(publicKey(t))})}); err != nil {
			t.Fatal(err)
		}
	}

	meter.Reset()
	dev, err := s.Device(ctx, n.ID, n.DeviceID, now)
	if err != nil || !bytes.Equal(dev.Key, n.DeviceKey) || dev.Replaced || dev.TelegramHash != "th-1" {
		t.Fatalf("Device = %+v, %v", dev, err)
	}
	if u := meter.Units(s.Table); u.Read != 1 {
		t.Fatalf("Device read %.1f units, want 1", u.Read)
	}

	// Replaced: the very next read knows.
	old, _ := s.ByTelegram(ctx, "th-1", n.DeviceID)
	if err := s.Replace(ctx, old, newAccount(t, "th-1"), now); err != nil {
		t.Fatal(err)
	}
	if dev, err := s.Device(ctx, n.ID, n.DeviceID, now); err != nil || !dev.Replaced {
		t.Fatalf("after replace: %+v, %v", dev, err)
	}

	// Deleted: gone at once.
	m := newAccount(t, "th-2")
	if err := s.Create(ctx, m); err != nil {
		t.Fatal(err)
	}
	for done := false; !done; {
		if done, err = s.Delete(ctx, m.ID, "th-2", 150); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Device(ctx, m.ID, m.DeviceID, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("after delete: %v", err)
	}
}

// Replace lists the old partition only once the swap has committed, so it
// also ends what was made between the read and the replacement.
func TestReplaceListsAfterSwap(t *testing.T) {
	s, _, _ := metered(t)
	ctx := context.Background()
	first := newAccount(t, "th-1")
	if err := s.Create(ctx, first); err != nil {
		t.Fatal(err)
	}
	old, err := s.ByTelegram(ctx, "th-1", first.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	late := ids.New()
	if err := s.CreateMailboxes(ctx, first.ID, []string{late}, 10); err != nil {
		t.Fatal(err)
	}
	if err := s.Replace(ctx, old, newAccount(t, "th-1"), now); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Mailbox(ctx, late); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a mailbox made after the read outlived the replacement: %v", err)
	}
	// Nothing new joins the old partition after the swap.
	if err := s.CreateMailboxes(ctx, first.ID, []string{ids.New()}, 10); err == nil {
		t.Fatal("a replaced account made a mailbox")
	}
}

// Link bundles, read by anyone who opens a link, are eventually
// consistent: half a read unit.
func TestBundle(t *testing.T) {
	s, meter, _ := metered(t)
	ctx := context.Background()
	n := newAccount(t, "th-1")
	if err := s.Create(ctx, n); err != nil {
		t.Fatal(err)
	}
	l := testLink(t)
	if err := s.CreateLink(ctx, n.ID, l, 1); err != nil {
		t.Fatal(err)
	}
	meter.Reset()
	got, err := s.Bundle(ctx, l.ID)
	if err != nil || got.Mailbox != l.Mailbox || !bytes.Equal(got.SigningKey, l.SigningKey) {
		t.Fatalf("Bundle = %+v, %v", got, err)
	}
	if _, err := s.Bundle(ctx, linkID()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown bundle: %v", err)
	}
	if u := meter.Units(s.Table); u.Read != 1 {
		t.Fatalf("two bundle reads cost %.1f units, want 1", u.Read)
	}
}
