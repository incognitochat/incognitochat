package inbox

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
	"github.com/incognitochat/incognitochat/backend/internal/envelope"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
)

var now = time.Unix(1_800_000_000, 0)

// limits are a page's limits for tests: as GET /inbox's, in a size.
func limits(items, bytes int) PageLimits { return PageLimits{Items: items, Units: 300, Bytes: bytes} }

// validSizes are the sizes a valid envelope can have: every padding, with
// every number of wraps.
func validSizes() []int {
	var sizes []int
	for _, padded := range envelope.PaddedSizes {
		for wraps := 1; wraps <= envelope.MaxWraps; wraps++ {
			sizes = append(sizes, 2+wraps*envelope.WrapLen+12+padded+16)
		}
	}
	return sizes
}

// Delivering to no device (a mailbox that doesn't exist) makes the same
// call as a one-device delivery, carrying as many bytes and costing as many
// write units, for every size an envelope can have, again and again; it
// keeps nothing about the send, and adds no item after the first of a size.
func TestDeliverToNoDevice(t *testing.T) {
	client := dynamotest.Client(t)
	meter := dynamotest.NewMeter(client)
	s := &Store{DB: meter, Table: dynamotest.Table(t, client)}
	ctx := context.Background()
	account, phone, mailbox := ids.New(), ids.New(), ids.New()
	sizes := validSizes()
	if len(sizes) != 64 || sizes[len(sizes)-1] != envelope.MaxLen {
		t.Fatalf("%d sizes, the largest %d", len(sizes), sizes[len(sizes)-1])
	}

	for _, size := range sizes {
		env := bytes.Repeat([]byte{7}, size)
		meter.Reset()
		if err := s.Deliver(ctx, account, []string{phone}, mailbox, env, now); err != nil {
			t.Fatal(err)
		}
		calls, units := meter.Calls(), meter.Units(s.Table)
		for range 2 {
			meter.Reset()
			if err := s.Deliver(ctx, ids.New(), nil, mailbox, env, now); err != nil {
				t.Fatal(err)
			}
			if got := meter.Calls(); !slices.Equal(got, calls) {
				t.Fatalf("size %d: no device made %v, a delivery %v", size, got, calls)
			}
			if got := meter.Units(s.Table); got != units {
				t.Fatalf("size %d: no device cost %+v, a delivery %+v", size, got, units)
			}
		}
	}

	out, err := client.Scan(ctx, &dynamodb.ScanInput{TableName: &s.Table})
	if err != nil || len(out.Items) != 2*len(sizes) {
		t.Fatalf("the table holds %d items, %v", len(out.Items), err)
	}
	placeholders := 0
	for _, it := range out.Items {
		pk := it["pk"].(*types.AttributeValueMemberS).Value
		if pk == devicePK(account, phone) {
			continue
		}
		placeholders++
		if !strings.HasPrefix(pk, "D#"+placeholderID+"#") || it["m"].(*types.AttributeValueMemberS).Value != placeholderID ||
			it["e"].(*types.AttributeValueMemberN).Value != placeholderExpiry ||
			!bytes.Equal(it["b"].(*types.AttributeValueMemberB).Value, make([]byte, len(it["b"].(*types.AttributeValueMemberB).Value))) {
			t.Fatalf("placeholder %v", it)
		}
	}
	if placeholders != len(sizes) {
		t.Fatalf("%d placeholders", placeholders)
	}
	// Nothing reads them: a device lists only its own items.
	for _, it := range list(t, s, account, phone, now) {
		if it.Mailbox != mailbox {
			t.Fatalf("the device listed %+v", it)
		}
	}
}

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
	limits []int32
	// consistent is whether a query read strongly consistent.
	consistent bool
	failing    map[string]bool
	// slow deletes answer only when the caller gives up.
	slow bool
}

func (c *counting) Query(ctx context.Context, in *dynamodb.QueryInput, opts ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	c.limits = append(c.limits, aws.ToInt32(in.Limit))
	c.consistent = c.consistent || aws.ToBool(in.ConsistentRead)
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

// Clear's steps are sized by what deleting each item costs, not by how
// many there are, and read about what they delete, eventually consistent
// (DLV-12): a step over the largest envelopes deletes two, not fifty.
func TestClearBySize(t *testing.T) {
	client := dynamotest.Client(t)
	meter := dynamotest.NewMeter(client)
	q := &counting{DB: meter}
	s := &Store{DB: q, Table: dynamotest.Table(t, client)}
	ctx := context.Background()
	account, phone, mailbox := ids.New(), ids.New(), ids.New()
	largest := make([]byte, envelope.MaxLen)
	for range 6 {
		if err := s.Deliver(ctx, account, []string{phone}, mailbox, largest, now); err != nil {
			t.Fatal(err)
		}
	}
	each := Item{Size: MaxItemSize}.Units()
	const units = 50
	meter.Reset()
	spent, more, err := s.Clear(ctx, account, phone, units)
	if err != nil || !more || spent != 2*each || spent > units {
		t.Fatalf("a step over the largest items: %d units, more %v, %v", spent, more, err)
	}
	cost := meter.Units(s.Table)
	t.Logf("deleting 2 of the largest items: %+v (%d units each)", cost, each)
	// What it deleted, as it costs; and one read of at most ClearStep items,
	// eventually consistent: each 4 KiB read takes half a unit.
	readCap := float64(ClearStep*MaxItemSize/4096+1) / 2
	if cost.Write > units || cost.Read > readCap || q.consistent || !slices.Equal(q.limits, []int32{ClearStep}) {
		t.Fatalf("the step cost %+v (at most %d write units and %v read units), in reads of %v, consistent %v",
			cost, units, readCap, q.limits, q.consistent)
	}
	if left := list(t, s, account, phone, now); len(left) != 4 {
		t.Fatalf("%d items left", len(left))
	}
	// Units that don't pay for the next item delete nothing.
	if spent, more, err := s.Clear(ctx, account, phone, each-1); err != nil || spent != 0 || !more {
		t.Fatalf("too few units: %d, more %v, %v", spent, more, err)
	}
	// Then the rest.
	for steps := 0; more; steps++ {
		if steps > 3 {
			t.Fatal("never finishes")
		}
		if _, more, err = s.Clear(ctx, account, phone, units); err != nil {
			t.Fatal(err)
		}
	}
	if left := list(t, s, account, phone, now); len(left) != 0 {
		t.Fatalf("%d items left", len(left))
	}
}

// putItems stores a device's items under the given IDs, which sort as
// given, with envelopes of the given sizes.
func putItems(t *testing.T, s *Store, account, device string, sizes map[string]int) {
	t.Helper()
	for id, size := range sizes {
		_, err := s.DB.BatchWriteItem(context.Background(), &dynamodb.BatchWriteItemInput{RequestItems: map[string][]types.WriteRequest{
			s.Table: {{PutRequest: &types.PutRequest{Item: map[string]types.AttributeValue{
				"pk": &types.AttributeValueMemberS{Value: devicePK(account, device)},
				"sk": &types.AttributeValueMemberS{Value: id},
				"m":  &types.AttributeValueMemberS{Value: ids.New()},
				"b":  &types.AttributeValueMemberB{Value: make([]byte, size)},
				"e":  &types.AttributeValueMemberN{Value: "4102444800"},
			}}}},
		}})
		if err != nil {
			t.Fatal(err)
		}
	}
}

// left is the IDs of a device's items, in order.
func left(t *testing.T, s *Store, account, device string) []string {
	t.Helper()
	var out []string
	for _, it := range list(t, s, account, device, now) {
		out = append(out, it.ID)
	}
	slices.Sort(out)
	return out
}

// A step stops at the first item its units can't pay for, though smaller
// ones follow, and reads at most ClearStep items it leaves.
func TestClearStopsAtTheFirstItemItCantPay(t *testing.T) {
	client := dynamotest.Client(t)
	q := &counting{DB: client}
	s := &Store{DB: q, Table: dynamotest.Table(t, client)}
	ctx := context.Background()
	account, phone := ids.New(), ids.New()
	putItems(t, s, account, phone, map[string]int{
		"a1": 10, "a2": 10, "a3": 10, "a4": 10, "a5": 10, "b": envelope.MaxLen, "c1": 10, "c2": 10, "c3": 10,
	})
	large := Item{Size: MaxItemSize}.Units()
	for i, want := range []struct {
		spent int
		more  bool
		left  []string
	}{
		{5, true, []string{"b", "c1", "c2", "c3"}}, // b doesn't fit after the a's
		{large + 1, true, []string{"c2", "c3"}},    // b, then c1
		{2, false, nil},
	} {
		q.limits = nil
		spent, more, err := s.Clear(ctx, account, phone, large+1)
		if err != nil || spent != want.spent || more != want.more {
			t.Fatalf("step %d: %d units, more %v, %v", i, spent, more, err)
		}
		if i == 0 && !slices.Equal(q.limits, []int32{ClearStep}) {
			t.Fatalf("step %d read %v", i, q.limits)
		}
		if got := left(t, s, account, phone); !slices.Equal(got, want.left) {
			t.Fatalf("step %d left %v", i, got)
		}
	}
}

// lagging hides some items from eventually consistent reads, as a replica
// that hasn't caught up with their writes yet does.
type lagging struct {
	DB
	hidden map[string]bool // by item ID
}

func (l *lagging) Query(ctx context.Context, in *dynamodb.QueryInput, opts ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	out, err := l.DB.Query(ctx, in, opts...)
	if err != nil || aws.ToBool(in.ConsistentRead) {
		return out, err
	}
	var kept []map[string]types.AttributeValue
	for _, it := range out.Items {
		if sk, ok := it["sk"].(*types.AttributeValueMemberS); !ok || !l.hidden[sk.Value] {
			kept = append(kept, it)
		}
	}
	out.Items = kept
	return out, nil
}

// An item the eventually consistent reads missed (delivered just before
// the account ended) keeps the device from being reported empty: the next
// step takes it, rather than it staying for 30 days (DLV-12).
func TestClearFindsWhatAReadMissed(t *testing.T) {
	client := dynamotest.Client(t)
	db := &lagging{DB: client, hidden: map[string]bool{"late": true}}
	s := &Store{DB: db, Table: dynamotest.Table(t, client)}
	ctx := context.Background()
	account, phone := ids.New(), ids.New()
	putItems(t, s, account, phone, map[string]int{"a": 10, "b": 10, "late": 10})
	spent, more, err := s.Clear(ctx, account, phone, 50)
	if err != nil || spent != 2 || !more {
		t.Fatalf("with an item missed: %d units, more %v, %v", spent, more, err)
	}
	// The replica caught up.
	db.hidden = nil
	if spent, more, err = s.Clear(ctx, account, phone, 50); err != nil || spent != 1 || more {
		t.Fatalf("the next step: %d units, more %v, %v", spent, more, err)
	}
	if got := left(t, s, account, phone); len(got) != 0 {
		t.Fatalf("left %v", got)
	}
}
