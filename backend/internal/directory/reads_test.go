package directory

import (
	"bytes"
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
)

// Looking up the devices of an account that doesn't exist (a send to a
// mailbox that doesn't exist) makes the same query as for an account with
// its one device, at the same cost, and finds none; it writes its
// placeholder only the first time.
func TestNoDevicesCostsWhatDevicesDoes(t *testing.T) {
	s, meter, _ := metered(t)
	ctx := context.Background()
	now := time.Unix(1_800_000_000, 0)
	n := newAccount(t, "th-1")
	if err := s.Create(ctx, n); err != nil {
		t.Fatal(err)
	}
	meter.Reset()
	if devices, err := s.Devices(ctx, n.ID, now); err != nil || len(devices) != 1 {
		t.Fatalf("Devices = %v, %v", devices, err)
	}
	calls, units := meter.Calls(), meter.Units(s.Table)

	meter.Reset()
	if err := s.NoDevices(ctx, now); err != nil {
		t.Fatal(err)
	}
	if u := meter.Units(s.Table); u.Write != 1 {
		t.Fatalf("the first lookup cost %+v", u)
	}
	for range 3 {
		meter.Reset()
		if err := s.NoDevices(ctx, now); err != nil {
			t.Fatal(err)
		}
		if got := meter.Calls(); !slices.Equal(got, calls) {
			t.Fatalf("NoDevices made %v, Devices %v", got, calls)
		}
		if got := meter.Units(s.Table); got != units {
			t.Fatalf("NoDevices cost %+v, Devices %+v", got, units)
		}
	}
	if devices, err := s.Devices(ctx, NoAccount, now); err != nil || len(devices) != 0 {
		t.Fatalf("the placeholder's devices: %v, %v", devices, err)
	}
}

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

// afterFirstQuery is a table that runs hook once, right after the first
// query made through it: what happens between Replace's first listing of
// the old partition and its swap.
type afterFirstQuery struct {
	DB
	hook    func()
	queried bool
}

func (a *afterFirstQuery) Query(ctx context.Context, in *dynamodb.QueryInput, opts ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	out, err := a.DB.Query(ctx, in, opts...)
	if !a.queried {
		a.queried = true
		a.hook()
	}
	return out, err
}

// Replace lists the old partition again once the swap has committed, so it
// also ends what was made between its first listing and the swap: a new
// mailbox, and a link replaced with a new one and its intro mailbox.
func TestReplaceListsAfterSwap(t *testing.T) {
	s, _, client := metered(t)
	ctx := context.Background()
	first := newAccount(t, "th-1")
	if err := s.Create(ctx, first); err != nil {
		t.Fatal(err)
	}
	l := testLink(t)
	if err := s.CreateLink(ctx, first.ID, l, 1); err != nil {
		t.Fatal(err)
	}
	old, err := s.ByTelegram(ctx, "th-1", first.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	late, next := ids.New(), testLink(t)
	hooked := &Store{DB: &afterFirstQuery{DB: client, hook: func() {
		if err := s.CreateMailboxes(ctx, first.ID, []string{late}, 10); err != nil {
			t.Error(err)
		}
		if err := s.ReplaceLink(ctx, first.ID, l.ID, next); err != nil {
			t.Error(err)
		}
	}}, Table: s.Table}
	if err := hooked.Replace(ctx, old, newAccount(t, "th-1"), now); err != nil {
		t.Fatal(err)
	}
	for _, m := range []string{late, next.Mailbox} {
		if _, err := s.Mailbox(ctx, m); !errors.Is(err, ErrNotFound) {
			t.Fatalf("mailbox %s, made after the first listing, outlived the replacement: %v", m, err)
		}
	}
	if _, err := s.Bundle(ctx, next.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a link made after the first listing is still served: %v", err)
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

// A login reads the device eventually consistent: half a unit.
func TestLoginDevice(t *testing.T) {
	s, meter, _ := metered(t)
	ctx := context.Background()
	n := newAccount(t, "th-1")
	if err := s.Create(ctx, n); err != nil {
		t.Fatal(err)
	}
	meter.Reset()
	dev, err := s.LoginDevice(ctx, n.ID, n.DeviceID, now)
	if err != nil || !bytes.Equal(dev.Key, n.DeviceKey) {
		t.Fatalf("LoginDevice = %+v, %v", dev, err)
	}
	if u := meter.Units(s.Table); u.Read != 0.5 {
		t.Fatalf("a login read %.1f units, want 0.5", u.Read)
	}
}

// failAfterSwap is a table that refuses reads once a transaction has
// committed, as a throttled one would: all of them, or the first fails.
type failAfterSwap struct {
	DB
	fails   int // 0: all
	swapped bool
	failed  int
}

func (f *failAfterSwap) TransactWriteItems(ctx context.Context, in *dynamodb.TransactWriteItemsInput, opts ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error) {
	out, err := f.DB.TransactWriteItems(ctx, in, opts...)
	f.swapped = f.swapped || err == nil
	return out, err
}

func (f *failAfterSwap) Query(ctx context.Context, in *dynamodb.QueryInput, opts ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	if f.swapped && (f.fails == 0 || f.failed < f.fails) {
		f.failed++
		return nil, errors.New("throttled")
	}
	return f.DB.Query(ctx, in, opts...)
}

// cutShort is a table whose queries say there's more after what they
// return, as DynamoDB does past 1 MB.
type cutShort struct{ DB }

func (c cutShort) Query(ctx context.Context, in *dynamodb.QueryInput, opts ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	out, err := c.DB.Query(ctx, in, opts...)
	if err == nil {
		out.LastEvaluatedKey = map[string]types.AttributeValue{"pk": sv("x"), "sk": sv("y")}
	}
	return out, err
}

// If the one-read login were ever cut short, the device isn't taken for
// missing (login_refused): it's an error.
func TestDeviceReadCutShort(t *testing.T) {
	s, _, client := metered(t)
	ctx := context.Background()
	n := newAccount(t, "th-1")
	if err := s.Create(ctx, n); err != nil {
		t.Fatal(err)
	}
	short := &Store{DB: cutShort{client}, Table: s.Table}
	for _, read := range []func(context.Context, string, string, time.Time) (Device, error){short.Device, short.LoginDevice} {
		if _, err := read(ctx, n.ID, n.DeviceID, now); err == nil || errors.Is(err, ErrNotFound) {
			t.Fatalf("a cut-short read: %v", err)
		}
	}
}

// The listing after the swap is tried again when it fails, so what was
// made since the first listing still goes.
func TestReplaceRetriesTheLaterListing(t *testing.T) {
	s, _, client := metered(t)
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
	flaky := &failAfterSwap{DB: client, fails: listTries - 1}
	hooked := &Store{DB: &afterFirstQuery{DB: flaky, hook: func() {
		if err := s.CreateMailboxes(ctx, first.ID, []string{late}, 10); err != nil {
			t.Error(err)
		}
	}}, Table: s.Table}
	if err := hooked.Replace(ctx, old, newAccount(t, "th-1"), now); err != nil {
		t.Fatal(err)
	}
	if flaky.failed != listTries-1 {
		t.Fatalf("%d listings refused, want %d", flaky.failed, listTries-1)
	}
	if _, err := s.Mailbox(ctx, late); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a mailbox made after the first listing outlived the replacement: %v", err)
	}
}

// A replacement still cleans up the old account when the table refuses
// to list it after the swap: what it listed before goes.
func TestReplaceCleansUpWhenTheLaterListingFails(t *testing.T) {
	s, _, client := metered(t)
	ctx := context.Background()
	first := newAccount(t, "th-1")
	if err := s.Create(ctx, first); err != nil {
		t.Fatal(err)
	}
	l := testLink(t)
	if err := s.CreateLink(ctx, first.ID, l, 1); err != nil {
		t.Fatal(err)
	}
	pool := []string{ids.New(), ids.New()}
	if err := s.CreateMailboxes(ctx, first.ID, pool, 10); err != nil {
		t.Fatal(err)
	}
	old, err := s.ByTelegram(ctx, "th-1", first.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	throttled := &Store{DB: &failAfterSwap{DB: client}, Table: s.Table}
	if err := throttled.Replace(ctx, old, newAccount(t, "th-1"), now); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Bundle(ctx, l.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the old link is still served: %v", err)
	}
	for _, m := range append(pool, l.Mailbox) {
		if _, err := s.Mailbox(ctx, m); !errors.Is(err, ErrNotFound) {
			t.Fatalf("mailbox %s still routes: %v", m, err)
		}
	}
	// The old device stays, to be told, but expires.
	dev, err := client.GetItem(ctx, &dynamodb.GetItemInput{TableName: &s.Table, Key: key(accountPK(first.ID), devicePrefix+first.DeviceID)})
	if err != nil || dev.Item["e"] == nil {
		t.Fatalf("old device = %v, %v", dev, err)
	}
}

// Nothing new joins a replaced account's partition: a link replaced or an
// admin's code made in the moment before its cleanup is refused.
func TestReplacedAccountMakesNothing(t *testing.T) {
	s, _, client := metered(t)
	ctx := context.Background()
	n := newAccount(t, "th-1")
	if err := s.Create(ctx, n); err != nil {
		t.Fatal(err)
	}
	l := testLink(t)
	if err := s.CreateLink(ctx, n.ID, l, 1); err != nil {
		t.Fatal(err)
	}
	// Replaced, its cleanup not yet run: the account item is only a marker.
	if _, err := client.PutItem(ctx, &dynamodb.PutItemInput{TableName: &s.Table, Item: item(accountPK(n.ID), skAccount, attrs{"g": sv(goneReplaced), "e": nv(roundUp(now.Add(ReplacedTTL)))})}); err != nil {
		t.Fatal(err)
	}
	next := testLink(t)
	if err := s.ReplaceLink(ctx, n.ID, l.ID, next); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ReplaceLink on a replaced account: %v", err)
	}
	if _, err := s.Bundle(ctx, next.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("its new link is served: %v", err)
	}
	if err := s.CreateInvitation(ctx, n.ID, "abcd-efgh", 1, 0, -1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an admin code on a replaced account: %v", err)
	}
	if err := s.CreateLink(ctx, n.ID, testLink(t), 2); err == nil {
		t.Fatal("CreateLink on a replaced account")
	}
}

// The one-read login (Device) reads from "A" to "D#<device>": only device
// items may sort in between. A new kind of item in the account partition
// must be listed in accountSortKeys and sort after the devices.
func TestAccountSortKeys(t *testing.T) {
	if !slices.IsSorted(accountSortKeys) || accountSortKeys[0] != skAccount || accountSortKeys[1] != devicePrefix {
		t.Fatalf("accountSortKeys = %v", accountSortKeys)
	}
	// Device IDs are base64url, all below "~".
	for _, k := range accountSortKeys[2:] {
		if k <= devicePrefix+"~" {
			t.Fatalf("%q sorts among the devices", k)
		}
	}

	// Every kind of item an account's partition gets is one of them.
	s, _, client := metered(t)
	ctx := context.Background()
	n := newAccount(t, "th-1")
	if err := s.Create(ctx, n); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateLink(ctx, n.ID, testLink(t), 1); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateMailboxes(ctx, n.ID, []string{ids.New()}, 10); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateInvitation(ctx, n.ID, "abcd-efgh", 1, 0, -1); err != nil {
		t.Fatal(err)
	}
	out, err := client.Query(ctx, &dynamodb.QueryInput{
		TableName:                 &s.Table,
		KeyConditionExpression:    aws.String("pk = :pk"),
		ExpressionAttributeValues: attrs{":pk": sv(accountPK(n.ID))},
	})
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]bool{}
	for _, it := range out.Items {
		sk, _ := str(it, "sk")
		known := false
		for _, k := range accountSortKeys {
			if sk == k || (strings.HasSuffix(k, "#") && strings.HasPrefix(sk, k)) {
				known, kinds[k] = true, true
			}
		}
		if !known {
			t.Fatalf("sort key %q isn't in accountSortKeys", sk)
		}
	}
	if len(kinds) != len(accountSortKeys) {
		t.Fatalf("made %d kinds of item, accountSortKeys lists %d", len(kinds), len(accountSortKeys))
	}
}
