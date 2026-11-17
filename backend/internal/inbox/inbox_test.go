package inbox

import (
	"bytes"
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
	"github.com/incognitochat/incognitochat/backend/internal/envelope"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
)

var now = time.Unix(1_800_000_000, 0)

// limits are a page's limits for tests: as GET /inbox's, in a size.
func limits(items, bytes int) PageLimits { return PageLimits{Items: items, Units: 300, Bytes: bytes} }

func TestDeliverListAck(t *testing.T) {
	client := dynamotest.Client(t)
	s := &Store{DB: client, Table: dynamotest.Table(t, client)}
	ctx := context.Background()
	account, phone, laptop, mailbox := ids.New(), ids.New(), ids.New(), ids.New()

	for i := range 3 {
		if err := s.Deliver(ctx, account, []string{phone, laptop}, mailbox, []byte{1, byte(i)}, now); err != nil {
			t.Fatal(err)
		}
	}
	page, err := s.List(ctx, account, phone, "", limits(2, 1<<20), now, nil)
	if err != nil || len(page.Items) != 2 || page.After == "" || page.Items[0].Mailbox != mailbox || page.Read != 2 {
		t.Fatalf("List = %+v, %v", page, err)
	}
	// The next page starts after it.
	rest, err := s.List(ctx, account, phone, page.After, limits(2, 1<<20), now, nil)
	if err != nil || len(rest.Items) != 1 || rest.After != "" || rest.Items[0].ID == page.Items[0].ID || rest.Items[0].ID == page.Items[1].ID {
		t.Fatalf("next page = %+v, %v", rest, err)
	}
	all := list(t, s, account, phone, now)
	if len(all) != 3 {
		t.Fatalf("phone has %d items", len(all))
	}
	if all[0].Size < 2 || all[0].Size > 200 || all[0].Units() != 1 {
		t.Fatalf("size %d, %d units", all[0].Size, all[0].Units())
	}

	// Confirming on the phone leaves the laptop's copies alone, and says
	// how many of the IDs had nothing to delete.
	if missing, failed := s.Ack(ctx, account, phone, []string{all[0].ID, all[1].ID, ids.New()}, 0); missing != 1 || failed != nil {
		t.Fatalf("Ack = %d, %v", missing, failed)
	}
	if missing, failed := s.Ack(ctx, account, phone, []string{all[0].ID}, 0); missing != 1 || failed != nil {
		t.Fatalf("Ack again = %d, %v", missing, failed)
	}
	if left := list(t, s, account, phone, now); len(left) != 1 || !bytes.Equal(left[0].Envelope, all[2].Envelope) {
		t.Fatalf("phone after ack: %+v", left)
	}
	if laptopItems := list(t, s, account, laptop, now); len(laptopItems) != 3 {
		t.Fatalf("laptop has %d items", len(laptopItems))
	}

	// The same device ID under another account sees nothing.
	if other := list(t, s, ids.New(), phone, now); len(other) != 0 {
		t.Fatalf("another account sees %d items", len(other))
	}
	// Expired items are hidden even before TTL deletes them.
	if late := list(t, s, account, laptop, now.Add(TTL+2*time.Hour)); len(late) != 0 {
		t.Fatalf("%d expired items listed", len(late))
	}
}

// list returns a device's items, as many as fit in one page of 50 and 1 MiB.
func list(t *testing.T, s *Store, account, device string, now time.Time) []Item {
	t.Helper()
	page, err := s.List(context.Background(), account, device, "", PageLimits{Items: 50, Units: 1000, Bytes: 1 << 20}, now, nil)
	if err != nil {
		t.Fatal(err)
	}
	return page.Items
}

// counting counts a DB's Queries and the most items each asked for, and
// fails the deletes of some items.
type counting struct {
	DB
	limits  []int32
	failing map[string]bool
	// slow deletes answer only when the caller gives up.
	slow bool
}

func (c *counting) Query(ctx context.Context, in *dynamodb.QueryInput, opts ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	c.limits = append(c.limits, aws.ToInt32(in.Limit))
	return c.DB.Query(ctx, in, opts...)
}

func (c *counting) DeleteItem(ctx context.Context, in *dynamodb.DeleteItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error) {
	if sk, ok := in.Key["sk"].(*types.AttributeValueMemberS); ok && c.failing[sk.Value] {
		return nil, errors.New("throttled")
	}
	if c.slow {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return c.DB.DeleteItem(ctx, in, opts...)
}

// A page is capped by size, and reading it costs about its size: an inbox
// full of the largest envelopes no longer costs 50 of them a fetch (226 read
// units, more than the table's whole cap). Its reads ask for at least
// MinStep items, so small ones take few reads; near the cap, a page ends
// rather than read one item at a time; and it never claims more than
// limits.Units to confirm.
func TestListSteps(t *testing.T) {
	client := dynamotest.Client(t)
	meter := dynamotest.NewMeter(client)
	q := &counting{DB: meter}
	s := &Store{DB: q, Table: dynamotest.Table(t, client)}
	ctx := context.Background()
	account, mailbox := ids.New(), ids.New()
	page := PageLimits{Items: 50, Units: 300, Bytes: 128 << 10}
	for _, tc := range []struct {
		name         string
		size, count  int
		items, reads int
	}{
		// 15 a page (18 were read), as many as 300 units hold.
		{"largest", envelope.MaxLen, 40, 15, 2},
		// 8 KiB envelopes: 18 a page, in two reads after the first.
		{"8 KiB", 2 + 121 + 12 + 8192 + 16, 40, 18, 2},
		// Small ones: 50 a page, in three after the first.
		{"small", 663, 60, 50, 4},
	} {
		device := ids.New()
		for range tc.count {
			if err := s.Deliver(ctx, account, []string{device}, mailbox, make([]byte, tc.size), now); err != nil {
				t.Fatal(err)
			}
		}
		q.limits = nil
		meter.Reset()
		got, err := s.List(ctx, account, device, "", page, now, nil)
		if err != nil {
			t.Fatal(err)
		}
		bytes, units := 0, 0
		for _, it := range got.Items {
			bytes += it.Size
			units += it.Units()
		}
		read := meter.Units(s.Table).Read
		t.Logf("%s: %d items (%d bytes, %d units) of %d read, reads asking for %v, %.1f read units", tc.name, len(got.Items), bytes, units, got.Read, q.limits, read)
		if len(got.Items) != tc.items || len(q.limits) != tc.reads || got.After == "" || units > page.Units {
			t.Fatalf("%s: %d items, %d units, in %d reads (%v)", tc.name, len(got.Items), units, len(q.limits), q.limits)
		}
		if read > float64(page.WorstUnits()) || got.Units != read {
			t.Fatalf("%s: read %.1f units (page says %.1f), worst %d", tc.name, read, got.Units, page.WorstUnits())
		}
		if q.limits[0] != ProbeItems {
			t.Fatalf("%s: a first read of %d", tc.name, q.limits[0])
		}
		for _, n := range q.limits[1 : len(q.limits)-1] {
			if n < MinStep {
				t.Fatalf("%s: a read of %d items (%v)", tc.name, n, q.limits)
			}
		}

		// Paging through all of them returns each once.
		seen := map[string]bool{}
		for after := ""; ; {
			got, err := s.List(ctx, account, device, after, page, now, nil)
			if err != nil {
				t.Fatal(err)
			}
			for _, it := range got.Items {
				if seen[it.ID] {
					t.Fatalf("%s: %s listed twice", tc.name, it.ID)
				}
				seen[it.ID] = true
			}
			if after = got.After; after == "" {
				break
			}
		}
		if len(seen) != tc.count {
			t.Fatalf("%s: paged through %d of %d", tc.name, len(seen), tc.count)
		}
	}
	// The worst a page can cost: its bytes and the rounding of its reads.
	if w := page.WorstUnits(); w < 50 || w > 60 {
		t.Fatalf("WorstUnits = %d", w)
	}
}

// more is called once the first read shows there is more, before reading
// on; its error ends the page.
func TestListMore(t *testing.T) {
	client := dynamotest.Client(t)
	q := &counting{DB: client}
	s := &Store{DB: q, Table: dynamotest.Table(t, client)}
	ctx := context.Background()
	account, one, three, mailbox := ids.New(), ids.New(), ids.New(), ids.New()
	if err := s.Deliver(ctx, account, []string{one}, mailbox, []byte{1}, now); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if err := s.Deliver(ctx, account, []string{three}, mailbox, []byte{1}, now); err != nil {
			t.Fatal(err)
		}
	}
	calls := 0
	more := func() error { calls++; return nil }
	if page, err := s.List(ctx, account, one, "", limits(50, 128<<10), now, more); err != nil || len(page.Items) != 1 || calls != 0 {
		t.Fatalf("one item: %+v, %v, more called %d times", page, err, calls)
	}
	if page, _ := s.List(ctx, account, ids.New(), "", limits(50, 128<<10), now, more); page.Read != 0 || calls != 0 {
		t.Fatalf("empty: %+v, more called %d times", page, calls)
	}
	if page, err := s.List(ctx, account, three, "", limits(50, 128<<10), now, more); err != nil || len(page.Items) != 3 || calls != 1 {
		t.Fatalf("three items: %+v, %v, more called %d times", page, err, calls)
	}
	stop := errors.New("no")
	q.limits = nil
	page, err := s.List(ctx, account, three, "", limits(50, 128<<10), now, func() error { return stop })
	if !errors.Is(err, stop) || len(page.Items) != ProbeItems || len(q.limits) != 1 {
		t.Fatalf("stopped: %+v, %v, %d reads", page, err, len(q.limits))
	}
}

// Ack reports which deletes failed, so only those are tried again.
func TestAckReportsFailed(t *testing.T) {
	client := dynamotest.Client(t)
	db := &counting{DB: client, failing: map[string]bool{}}
	s := &Store{DB: db, Table: dynamotest.Table(t, client)}
	ctx := context.Background()
	account, phone, mailbox := ids.New(), ids.New(), ids.New()
	for range 4 {
		if err := s.Deliver(ctx, account, []string{phone}, mailbox, []byte{1}, now); err != nil {
			t.Fatal(err)
		}
	}
	all := list(t, s, account, phone, now)
	keys := make([]string, len(all))
	for i, it := range all {
		keys[i] = it.ID
	}
	db.failing[keys[1]], db.failing[keys[3]] = true, true
	missing, failed := s.Ack(ctx, account, phone, keys, 0)
	slices.Sort(failed)
	want := []string{keys[1], keys[3]}
	slices.Sort(want)
	if missing != 0 || !slices.Equal(failed, want) {
		t.Fatalf("Ack = %d, %v; want 0, %v", missing, failed, want)
	}
	// Tried again, only those: nothing missing.
	db.failing = nil
	if missing, failed := s.Ack(ctx, account, phone, want, 0); missing != 0 || failed != nil {
		t.Fatalf("again: %d, %v", missing, failed)
	}
	if left := list(t, s, account, phone, now); len(left) != 0 {
		t.Fatalf("%d left", len(left))
	}
}

// Once maxMissing weren't there, Ack starts no more deletes: a replayed
// batch of gone items costs the table a few write units, not 50.
func TestAckStopsAfterMisses(t *testing.T) {
	client := dynamotest.Client(t)
	meter := dynamotest.NewMeter(client)
	s := &Store{DB: meter, Table: dynamotest.Table(t, client)}
	gone := make([]string, 50)
	for i := range gone {
		gone[i] = ids.New()
	}
	missing, failed := s.Ack(context.Background(), ids.New(), ids.New(), gone, 5)
	if missing < 5 || missing > 5+ackParallel-1 || failed != nil {
		t.Fatalf("Ack = %d missing, %v failed", missing, failed)
	}
	if w := meter.Units(s.Table).Write; w > float64(missing) {
		t.Fatalf("%v write units for %d misses", w, missing)
	}
}

// Ack gives up at its deadline, and reports what it didn't delete, so the
// answer (with what to try again) comes back within the function's time.
func TestAckDeadline(t *testing.T) {
	client := dynamotest.Client(t)
	db := &counting{DB: client}
	s := &Store{DB: db, Table: dynamotest.Table(t, client), AckTimeout: 100 * time.Millisecond}
	ctx := context.Background()
	account, phone, mailbox := ids.New(), ids.New(), ids.New()
	for range 30 {
		if err := s.Deliver(ctx, account, []string{phone}, mailbox, []byte{1}, now); err != nil {
			t.Fatal(err)
		}
	}
	var keys []string
	for _, it := range list(t, s, account, phone, now) {
		keys = append(keys, it.ID)
	}
	db.slow = true
	began := time.Now()
	missing, failed := s.Ack(ctx, account, phone, keys, 0)
	if d := time.Since(began); d > time.Second || missing != 0 || len(failed) != len(keys) {
		t.Fatalf("Ack took %v: %d missing, %d failed", d, missing, len(failed))
	}
}

// Expired items not yet removed by TTL can fill a page: it comes back
// empty, but says where the next starts, instead of ending the sync with
// live items behind it.
func TestListPagesPastExpired(t *testing.T) {
	client := dynamotest.Client(t)
	s := &Store{DB: client, Table: dynamotest.Table(t, client)}
	ctx := context.Background()
	account, phone, mailbox := ids.New(), ids.New(), ids.New()
	expired := make([]byte, envelope.MaxLen)
	expired[0] = 1
	for range 60 {
		if err := s.Deliver(ctx, account, []string{phone}, mailbox, expired, now); err != nil {
			t.Fatal(err)
		}
	}
	later := now.Add(TTL + 2*time.Hour)
	if err := s.Deliver(ctx, account, []string{phone}, mailbox, []byte{2}, later); err != nil {
		t.Fatal(err)
	}
	var live []Item
	empty, pages := 0, 0
	for after := ""; pages < 30; pages++ {
		page, err := s.List(ctx, account, phone, after, limits(50, 3*MaxItemSize), later, nil)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Items) == 0 && page.After != "" {
			empty++
		}
		live = append(live, page.Items...)
		if after = page.After; after == "" {
			break
		}
	}
	if len(live) != 1 || live[0].Envelope[0] != 2 || empty == 0 {
		t.Fatalf("found %+v in %d pages, %d of them empty with more", live, pages, empty)
	}
}

func TestClear(t *testing.T) {
	client := dynamotest.Client(t)
	s := &Store{DB: client, Table: dynamotest.Table(t, client)}
	ctx := context.Background()
	account, phone, other, mailbox := ids.New(), ids.New(), ids.New(), ids.New()

	// More than one batch of items.
	for i := range 30 {
		if err := s.Deliver(ctx, account, []string{phone}, mailbox, []byte{2, byte(i)}, now); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Deliver(ctx, other, []string{phone}, mailbox, []byte{3}, now); err != nil {
		t.Fatal(err)
	}
	// In steps: at most 20 at a time.
	n, more, err := s.Clear(ctx, account, phone, 20)
	if err != nil || n != 20 || !more {
		t.Fatalf("first step: %d %v %v", n, more, err)
	}
	if n, more, err = s.Clear(ctx, account, phone, 20); err != nil || n != 10 || more {
		t.Fatalf("second step: %d %v %v", n, more, err)
	}
	if left := list(t, s, account, phone, now); len(left) != 0 {
		t.Fatalf("%d items left", len(left))
	}
	// Another account's device of the same ID keeps its items.
	if kept := list(t, s, other, phone, now); len(kept) != 1 {
		t.Fatalf("other account has %d items", len(kept))
	}
}
