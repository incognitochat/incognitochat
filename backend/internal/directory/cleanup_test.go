package directory

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/links"
)

// step is the steps' size in these tests, as the API's (api.DeleteStep).
const step = 50

// cleanUp runs CleanUp until it finishes.
func cleanUp(t *testing.T, s *Store, accountID, old string) {
	t.Helper()
	for steps := 0; ; steps++ {
		if steps > 400 {
			t.Fatal("the cleanup never finishes")
		}
		done, err := s.CleanUp(context.Background(), accountID, old, step)
		if err != nil {
			t.Fatal(err)
		}
		if done {
			return
		}
	}
}

// partition returns the sort keys of everything in an account's partition.
func partitionKeys(t *testing.T, client *dynamodb.Client, table, accountID string) []string {
	t.Helper()
	pages := dynamodb.NewQueryPaginator(client, &dynamodb.QueryInput{
		TableName:                 &table,
		KeyConditionExpression:    aws.String("pk = :pk"),
		ExpressionAttributeValues: attrs{":pk": sv(accountPK(accountID))},
		ConsistentRead:            aws.Bool(true),
	})
	var sks []string
	for pages.HasMorePages() {
		page, err := pages.NextPage(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		for _, it := range page.Items {
			sk, _ := str(it, "sk")
			sks = append(sks, sk)
		}
	}
	return sks
}

// owned returns the shared items (mailboxes, codes, links) the table says
// an account owns, and the account's own records of them, each by the sort
// key of its record ("M#<mailbox>", "I#<code>", "K#<link>").
func owned(t *testing.T, client *dynamodb.Client, table, accountID string) (shared, records map[string]bool) {
	t.Helper()
	shared, records = map[string]bool{}, map[string]bool{}
	pages := dynamodb.NewScanPaginator(client, &dynamodb.ScanInput{TableName: &table, ConsistentRead: aws.Bool(true)})
	for pages.HasMorePages() {
		page, err := pages.NextPage(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		for _, it := range page.Items {
			pk, _ := str(it, "pk")
			sk, _ := str(it, "sk")
			if pk == accountPK(accountID) && sk != skAccount && sk != skDeviceList && !strings.HasPrefix(sk, devicePrefix) {
				records[sk] = true
			}
			if o, _ := str(it, "o"); o == accountID {
				shared[pk] = true // mailboxes and codes: the record's sort key is their key
			}
			if a, _ := str(it, "a"); a == accountID && strings.HasPrefix(pk, "L#") {
				shared[linkPrefix+strings.TrimPrefix(pk, "L#")] = true
			}
		}
	}
	return shared, records
}

// A replacement takes a few writes however big the old account is, and
// ends it at once: its mailboxes take no deliveries, its link is gone, its
// codes don't work and nothing new joins it; its marker and device keys
// expire. Then the rest goes in steps of about 50 writes, each reading
// only what it deletes, and repeating the last step changes nothing.
func TestReplaceABigAccount(t *testing.T) {
	s, meter, client := metered(t)
	ctx := context.Background()

	// The same replacement of a small account, to compare.
	small := newAccount(t, "th-small")
	if err := s.Create(ctx, small); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateLink(ctx, small.ID, testLink(t), links.MaxActive); err != nil {
		t.Fatal(err)
	}
	oldSmall, err := s.ByTelegram(ctx, "th-small", small.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	meter.Reset()
	if err := s.Replace(ctx, oldSmall, newAccount(t, "th-small"), now); err != nil {
		t.Fatal(err)
	}
	smallCost := meter.Units(s.Table)

	first := newAccount(t, "th-1")
	if err := s.Create(ctx, first); err != nil {
		t.Fatal(err)
	}
	l := testLink(t)
	if err := s.CreateLink(ctx, first.ID, l, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateInvitation(ctx, first.ID, "abcd-efgh", 2, 0, -1); err != nil {
		t.Fatal(err)
	}
	boxes := grow(t, client, s.Table, first.ID, 4000)
	other := registered(t, s)
	old, err := s.ByTelegram(ctx, "th-1", first.DeviceID)
	if err != nil {
		t.Fatal(err)
	}

	second := newAccount(t, "th-1")
	at := now.Add(17 * time.Minute)
	meter.Reset()
	if err := s.Replace(ctx, old, second, at); err != nil {
		t.Fatal(err)
	}
	cost := meter.Units(s.Table)
	t.Logf("replacing an account with 4,000 mailboxes: %v; with none: %v", meter.Calls(), cost)
	if cost != smallCost {
		t.Fatalf("replacing 4,000 mailboxes cost %+v, none %+v", cost, smallCost)
	}

	// Ended at once.
	for _, m := range []string{boxes[0], boxes[3999], l.Mailbox} {
		mb, err := s.Mailbox(ctx, m)
		if err != nil || mb.Owner != first.ID {
			t.Fatalf("mailbox %s = %+v, %v", m, mb, err)
		}
	}
	if devices, err := s.Recipients(ctx, first.ID, now); err != nil || len(devices) != 0 {
		t.Fatalf("the old account's mailboxes deliver to %v, %v", devices, err)
	}
	if _, err := s.Bundle(ctx, l.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the old link is served: %v", err)
	}
	if _, err := s.Redeem(ctx, other.ID, "abcd-efgh"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the old account's code: %v", err)
	}
	if err := s.CreateMailboxes(ctx, first.ID, []string{ids.New()}, 5000); err == nil {
		t.Fatal("the old account made a mailbox")
	}
	if dev, err := s.Device(ctx, first.ID, first.DeviceID, now); err != nil || !dev.Replaced {
		t.Fatalf("old device = %+v, %v", dev, err)
	}
	dev, err := s.Device(ctx, second.ID, second.DeviceID, now)
	if err != nil || !slices.Equal(dev.Leftovers, []string{first.ID}) || dev.Replaced || dev.Deleting {
		t.Fatalf("new device = %+v, %v", dev, err)
	}

	// The marker and device keys expire, with nothing else of the account;
	// the device list and the link's record are gone.
	wantExpiry := strconv.FormatInt(now.Add(ReplacedTTL+time.Hour).Unix(), 10)
	for _, sk := range []string{skAccount, devicePrefix + first.DeviceID} {
		out, err := client.GetItem(ctx, &dynamodb.GetItemInput{TableName: &s.Table, Key: key(accountPK(first.ID), sk)})
		if err != nil {
			t.Fatal(err)
		}
		if e, ok := out.Item["e"].(*types.AttributeValueMemberN); !ok || e.Value != wantExpiry {
			t.Fatalf("%s expires %v, want %s", sk, out.Item["e"], wantExpiry)
		}
		if _, ok := out.Item["ak"]; ok {
			t.Fatal("the account key was kept")
		}
	}
	for _, sk := range partitionKeys(t, client, s.Table, first.ID) {
		if sk == skDeviceList || strings.HasPrefix(sk, linkPrefix) {
			t.Fatalf("%s survived the swap", sk)
		}
	}

	// Then the rest, in steps.
	steps := 0
	var most dynamotest.Units
	for done := false; !done; {
		if steps++; steps > 400 {
			t.Fatal("the cleanup never finishes")
		}
		meter.Reset()
		if done, err = s.CleanUp(ctx, second.ID, first.ID, step); err != nil {
			t.Fatal(err)
		}
		u := meter.Units(s.Table)
		most.Read, most.Write = max(most.Read, u.Read), max(most.Write, u.Write)
	}
	t.Logf("cleaning up 4,000 mailboxes and a code: %d steps, each at most %.1f write and %.1f read units", steps, most.Write, most.Read)
	if most.Write > step+1 || most.Read > 8 {
		t.Fatalf("a step cost up to %+v", most)
	}
	if steps < 4000*2/step {
		t.Fatalf("only %d steps", steps)
	}
	if shared, records := owned(t, client, s.Table, first.ID); len(shared)+len(records) != 0 {
		t.Fatalf("left behind: %d shared items, %d records", len(shared), len(records))
	}
	if sks := partitionKeys(t, client, s.Table, first.ID); !slices.Equal(sks, []string{skAccount, devicePrefix + first.DeviceID}) {
		t.Fatalf("the old partition holds %v", sks)
	}
	if dev, err := s.Device(ctx, second.ID, second.DeviceID, now); err != nil || len(dev.Leftovers) != 0 {
		t.Fatalf("new device after the cleanup = %+v, %v", dev, err)
	}

	// Repeating it (an answer lost) changes nothing.
	meter.Reset()
	if done, err := s.CleanUp(ctx, second.ID, first.ID, step); err != nil || !done {
		t.Fatalf("cleaning up again: %v, %v", done, err)
	}
	if u := meter.Units(s.Table); u.Write > 1 {
		t.Fatalf("cleaning up again cost %+v", u)
	}
	if dev, err := s.Device(ctx, first.ID, first.DeviceID, now); err != nil || !dev.Replaced {
		t.Fatalf("old device after the cleanup = %+v, %v", dev, err)
	}
}

// flaky is a table that fails some calls, as a throttled one does once
// its retries are spent: every nth batch write, and every mth query.
type flaky struct {
	DB
	batches, queries int
	nb, nq           int
}

func (f *flaky) BatchWriteItem(ctx context.Context, in *dynamodb.BatchWriteItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.BatchWriteItemOutput, error) {
	if f.nb++; f.nb%f.batches == 0 {
		return nil, errors.New("throttled")
	}
	return f.DB.BatchWriteItem(ctx, in, opts...)
}

func (f *flaky) Query(ctx context.Context, in *dynamodb.QueryInput, opts ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	if f.nq++; f.nq%f.queries == 0 {
		return nil, errors.New("throttled")
	}
	return f.DB.Query(ctx, in, opts...)
}

// Steps cut short anywhere leave no mailbox without its record, so the
// next step finds what one left, and the cleanup finishes.
func TestCleanUpSurvivesFailures(t *testing.T) {
	s, _, client := metered(t)
	ctx := context.Background()
	first := newAccount(t, "th-1")
	if err := s.Create(ctx, first); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateLink(ctx, first.ID, testLink(t), links.MaxActive); err != nil {
		t.Fatal(err)
	}
	grow(t, client, s.Table, first.ID, 300)
	old, err := s.ByTelegram(ctx, "th-1", first.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	second := newAccount(t, "th-1")
	if err := s.Replace(ctx, old, second, now); err != nil {
		t.Fatal(err)
	}

	unreliable := &Store{DB: &flaky{DB: client, batches: 4, queries: 7}, Table: s.Table}
	failed := 0
	for done := false; !done; {
		var err error
		if done, err = unreliable.CleanUp(ctx, second.ID, first.ID, 60); err != nil {
			failed++
			// Whatever went, nothing is left without its record.
			shared, records := owned(t, client, s.Table, first.ID)
			for sk := range shared {
				if !records[sk] {
					t.Fatalf("%s is left without its record", sk)
				}
			}
		}
		if failed > 200 {
			t.Fatal("the cleanup never finishes")
		}
	}
	if failed == 0 {
		t.Fatal("nothing failed")
	}
	if shared, records := owned(t, client, s.Table, first.ID); len(shared)+len(records) != 0 {
		t.Fatalf("left behind after %d failed steps: %d shared items, %d records", failed, len(shared), len(records))
	}
}

// A replaced account's leftovers move to whatever replaces its successor,
// so none are lost however often the user sets up again.
func TestLeftoversCarryOver(t *testing.T) {
	s, _, client := metered(t)
	ctx := context.Background()
	a := newAccount(t, "th-1")
	if err := s.Create(ctx, a); err != nil {
		t.Fatal(err)
	}
	grow(t, client, s.Table, a.ID, 20)
	old, _ := s.ByTelegram(ctx, "th-1", a.DeviceID)
	b := newAccount(t, "th-1")
	if err := s.Replace(ctx, old, b, now); err != nil {
		t.Fatal(err)
	}
	grow(t, client, s.Table, b.ID, 20)
	old, _ = s.ByTelegram(ctx, "th-1", b.DeviceID)
	if !slices.Equal(old.Leftovers, []string{a.ID}) {
		t.Fatalf("b's leftovers: %v", old.Leftovers)
	}
	c := newAccount(t, "th-1")
	if err := s.Replace(ctx, old, c, now); err != nil {
		t.Fatal(err)
	}
	dev, err := s.Device(ctx, c.ID, c.DeviceID, now)
	if want := slices.Sorted(slices.Values([]string{a.ID, b.ID})); err != nil || !slices.Equal(dev.Leftovers, want) {
		t.Fatalf("c's leftovers: %v, %v; want %v", dev.Leftovers, err, want)
	}
	for _, gone := range dev.Leftovers {
		cleanUp(t, s, c.ID, gone)
	}
	for _, gone := range []string{a.ID, b.ID} {
		if shared, records := owned(t, client, s.Table, gone); len(shared)+len(records) != 0 {
			t.Fatalf("%s left %d shared items, %d records", gone, len(shared), len(records))
		}
	}
	if dev, err := s.Device(ctx, c.ID, c.DeviceID, now); err != nil || len(dev.Leftovers) != 0 {
		t.Fatalf("c after the cleanups: %+v, %v", dev, err)
	}
}

// A leftover that names a live account (which never happens) is forgotten,
// and nothing of that account is touched.
func TestCleanUpNeverTouchesALiveAccount(t *testing.T) {
	s, _, client := metered(t)
	ctx := context.Background()
	live, b := registered(t, s), registered(t, s)
	boxes := []string{ids.New()}
	if err := s.CreateMailboxes(ctx, live.ID, boxes, 10); err != nil {
		t.Fatal(err)
	}
	if _, err := client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: &s.Table, Key: key(accountPK(b.ID), skAccount),
		UpdateExpression:          aws.String("ADD ro :a"),
		ExpressionAttributeValues: attrs{":a": &types.AttributeValueMemberSS{Value: []string{live.ID}}},
	}); err != nil {
		t.Fatal(err)
	}
	if done, err := s.CleanUp(ctx, b.ID, live.ID, step); err != nil || !done {
		t.Fatalf("CleanUp = %v, %v", done, err)
	}
	if devices, err := s.Recipients(ctx, live.ID, now); err != nil || len(devices) != 1 {
		t.Fatalf("the live account's devices: %v, %v", devices, err)
	}
	if _, err := s.Mailbox(ctx, boxes[0]); err != nil {
		t.Fatalf("the live account's mailbox: %v", err)
	}
	if dev, err := s.Device(ctx, b.ID, b.DeviceID, now); err != nil || len(dev.Leftovers) != 0 {
		t.Fatalf("b = %+v, %v", dev, err)
	}
}

// An account being deleted makes nothing and takes nothing from the first
// step on; a deletion cut short carries on where it stopped, from another
// instance.
func TestDeletingAccount(t *testing.T) {
	s, _, client := metered(t)
	ctx := context.Background()
	n, other := registered(t, s), registered(t, s)
	l := testLink(t)
	if err := s.CreateLink(ctx, n.ID, l, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateInvitation(ctx, n.ID, "abcd-efgh", 2, 0, -1); err != nil {
		t.Fatal(err)
	}
	boxes := grow(t, client, s.Table, n.ID, 30)

	if exists, err := s.AccountExists(ctx, n.TelegramHash); err != nil || !exists {
		t.Fatalf("AccountExists before = %v, %v", exists, err)
	}
	if err := s.MarkDeleting(ctx, n.ID); err != nil {
		t.Fatal(err)
	}
	if dev, err := s.Device(ctx, n.ID, n.DeviceID, now); err != nil || !dev.Deleting || dev.TelegramHash != n.TelegramHash {
		t.Fatalf("device = %+v, %v", dev, err)
	}
	// Not an account in use any more: setting up again replaces it without asking.
	if exists, err := s.AccountExists(ctx, n.TelegramHash); err != nil || exists {
		t.Fatalf("AccountExists while deleting = %v, %v", exists, err)
	}
	if acct, err := s.ByTelegram(ctx, n.TelegramHash, n.DeviceID); err != nil || !acct.Deleting {
		t.Fatalf("ByTelegram while deleting = %+v, %v", acct, err)
	}
	// Its link went with the mark.
	if _, err := s.Bundle(ctx, l.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the link of an account being deleted: %v", err)
	}
	if devices, err := s.Recipients(ctx, n.ID, now); err != nil || len(devices) != 0 {
		t.Fatalf("deliveries to an account being deleted: %v, %v", devices, err)
	}
	// Its code, still there, doesn't work.
	if _, err := s.Redeem(ctx, other.ID, "abcd-efgh"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("redeeming its code: %v", err)
	}
	if err := s.CreateMailboxes(ctx, n.ID, []string{ids.New()}, 100); !errors.Is(err, ErrLimit) {
		t.Fatalf("CreateMailboxes: %v", err)
	}
	if err := s.CreateLink(ctx, n.ID, testLink(t), 5); !errors.Is(err, ErrLimit) {
		t.Fatalf("CreateLink: %v", err)
	}
	if err := s.ReplaceLink(ctx, n.ID, l.ID, testLink(t)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ReplaceLink: %v", err)
	}
	if err := s.CreateInvitation(ctx, n.ID, "bcde-fghj", 1, 0, -1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("CreateInvitation: %v", err)
	}
	if err := s.CreateInvitation(ctx, other.ID, "cdef-ghjk", 1, 0, -1); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Redeem(ctx, n.ID, "cdef-ghjk"); err == nil {
		t.Fatal("an account being deleted joined")
	}

	// One step, then it stops (the app closed).
	if done, err := s.Delete(ctx, n.ID, n.TelegramHash, 6); err != nil || done {
		t.Fatalf("first step: %v, %v", done, err)
	}
	if _, err := s.Bundle(ctx, l.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the link after the first step: %v", err)
	}
	// Still marked, and found as it was by the next launch.
	if dev, err := s.Device(ctx, n.ID, n.DeviceID, now); err != nil || !dev.Deleting {
		t.Fatalf("device after a step = %+v, %v", dev, err)
	}

	again := &Store{DB: client, Table: s.Table}
	for steps := 0; ; steps++ {
		if steps > 50 {
			t.Fatal("never finishes")
		}
		done, err := again.Delete(ctx, n.ID, n.TelegramHash, 6)
		if err != nil {
			t.Fatal(err)
		}
		if done {
			break
		}
	}
	if sks := partitionKeys(t, client, s.Table, n.ID); len(sks) != 0 {
		t.Fatalf("left behind: %v", sks)
	}
	for _, m := range boxes {
		if _, err := s.Mailbox(ctx, m); !errors.Is(err, ErrNotFound) {
			t.Fatalf("mailbox %s: %v", m, err)
		}
	}
	if _, err := s.AccountOf(ctx, n.TelegramHash); !errors.Is(err, ErrNotFound) {
		t.Fatalf("telegram item: %v", err)
	}
	if err := s.MarkDeleting(ctx, n.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("marking a deleted account: %v", err)
	}
	if _, err := s.Delete(ctx, n.ID, n.TelegramHash, 6); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleting it again: %v", err)
	}
}

// Deleting a big account costs about the same a step however much is left:
// it reads only what the step deletes (it used to read the whole partition,
// 52 read units at 4,000 mailboxes, every step).
func TestDeleteStepsCostLittle(t *testing.T) {
	s, meter, client := metered(t)
	ctx := context.Background()
	n := registered(t, s)
	grow(t, client, s.Table, n.ID, 4000)
	steps := 0
	var most dynamotest.Units
	for done := false; !done; {
		if steps++; steps > 400 {
			t.Fatal("never finishes")
		}
		meter.Reset()
		var err error
		if done, err = s.Delete(ctx, n.ID, n.TelegramHash, step); err != nil {
			t.Fatal(err)
		}
		u := meter.Units(s.Table)
		most.Read, most.Write = max(most.Read, u.Read), max(most.Write, u.Write)
	}
	t.Logf("deleting 4,000 mailboxes: %d steps, each at most %.1f write and %.1f read units", steps, most.Write, most.Read)
	// The first step also marks the account, and the last deletes the
	// account and Telegram items (2 units each, in a transaction).
	if most.Write > step+4 || most.Read > 8 {
		t.Fatalf("a step cost up to %+v", most)
	}
	if sks := partitionKeys(t, client, s.Table, n.ID); len(sks) != 0 {
		t.Fatalf("left behind: %d items", len(sks))
	}
}

// A link count left above the links an account has, by a deletion cut
// short before deletions were marked (it took the link, not the count), is
// put right when the account makes a link: it isn't stuck without one.
func TestCreateLinkRepairsAStaleCount(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()
	n := registered(t, s)
	l := testLink(t)
	if err := s.CreateLink(ctx, n.ID, l, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	// What such a deletion's first step left: no link, a count of one.
	for _, k := range []map[string]types.AttributeValue{
		key(linkPK(l.ID), skLink), key(accountPK(n.ID), linkPrefix+l.ID),
		key(mailboxPK(l.Mailbox), skMailbox), key(accountPK(n.ID), mailboxPrefix+l.Mailbox),
	} {
		if _, err := client.DeleteItem(ctx, &dynamodb.DeleteItemInput{TableName: &s.Table, Key: k}); err != nil {
			t.Fatal(err)
		}
	}
	if dev, _ := s.Device(ctx, n.ID, n.DeviceID, now); dev.Links != 1 {
		t.Fatalf("links = %d", dev.Links)
	}
	next := testLink(t)
	if err := s.CreateLink(ctx, n.ID, next, links.MaxActive); err != nil {
		t.Fatalf("CreateLink with a stale count: %v", err)
	}
	if dev, _ := s.Device(ctx, n.ID, n.DeviceID, now); dev.Links != 1 {
		t.Fatalf("links after = %d", dev.Links)
	}
	// A count that is right still limits.
	if err := s.CreateLink(ctx, n.ID, testLink(t), links.MaxActive); !errors.Is(err, ErrLimit) {
		t.Fatalf("a second link: %v", err)
	}
}
