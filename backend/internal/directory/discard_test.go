package directory

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/awsconf"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/links"
)

// twisted is a DB whose reads of chosen items return what a test says (an
// item forged, or an error), and whose deletes and updates of chosen items
// fail first; the rest goes to DB. It counts those writes, and keeps the
// options of each, by "<operation> <pk> <sk>".
type twisted struct {
	DB
	reads map[string]map[string]types.AttributeValue // "<pk> <sk>" -> the item read instead
	fail  error                                      // what every GetItem returns, if set

	mu    sync.Mutex
	fails map[string][]error // what the next writes return, in turn, before any goes through
	calls map[string]int
	opts  map[string][]func(*dynamodb.Options)
}

func (d *twisted) GetItem(ctx context.Context, in *dynamodb.GetItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	if d.fail != nil {
		return nil, d.fail
	}
	if it, ok := d.reads[keyString(in.Key)]; ok {
		return &dynamodb.GetItemOutput{Item: it}, nil
	}
	return d.DB.GetItem(ctx, in, opts...)
}

// write counts a write, and returns the error it should fail with, if any.
func (d *twisted) write(op string, k map[string]types.AttributeValue, opts []func(*dynamodb.Options)) error {
	name := op + " " + keyString(k)
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.calls == nil {
		d.calls, d.opts = map[string]int{}, map[string][]func(*dynamodb.Options){}
	}
	d.calls[name]++
	d.opts[name] = opts
	if fails := d.fails[name]; len(fails) > 0 {
		d.fails[name] = fails[1:]
		return fails[0]
	}
	return nil
}

func (d *twisted) DeleteItem(ctx context.Context, in *dynamodb.DeleteItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error) {
	if err := d.write("DeleteItem", in.Key, opts); err != nil {
		return nil, err
	}
	return d.DB.DeleteItem(ctx, in, opts...)
}

func (d *twisted) UpdateItem(ctx context.Context, in *dynamodb.UpdateItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	if err := d.write("UpdateItem", in.Key, opts); err != nil {
		return nil, err
	}
	return d.DB.UpdateItem(ctx, in, opts...)
}

func keyString(k map[string]types.AttributeValue) string {
	pk, _ := str(k, "pk")
	sk, _ := str(k, "sk")
	return pk + " " + sk
}

// discardSetup is an account with two mailboxes and a link, and another
// account with a mailbox.
type discardSetup struct {
	owner, other NewAccount
	mine         []string
	theirs       string
	intro        string
}

func newDiscardSetup(t *testing.T, s *Store) discardSetup {
	t.Helper()
	ctx := context.Background()
	d := discardSetup{owner: registered(t, s), other: registered(t, s), mine: []string{ids.New(), ids.New()}, theirs: ids.New()}
	if err := s.CreateMailboxes(ctx, d.owner.ID, d.mine, 10); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateMailboxes(ctx, d.other.ID, []string{d.theirs}, 10); err != nil {
		t.Fatal(err)
	}
	l := testLink(t)
	if err := s.CreateLink(ctx, d.owner.ID, l, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	d.intro = l.Mailbox
	return d
}

// mailboxRecords reports an account's mailbox records and its count of mailboxes.
func mailboxRecords(t *testing.T, s *Store, n NewAccount) ([]string, int) {
	t.Helper()
	ctx := context.Background()
	records, err := s.Mailboxes(ctx, n.ID)
	if err != nil {
		t.Fatal(err)
	}
	d, err := s.Device(ctx, n.ID, n.DeviceID, now)
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(records)
	return records, d.Mailboxes
}

// operations counts calls by their operation.
func operations(calls []string) map[string]int {
	ops := map[string]int{}
	for _, c := range calls {
		op, _, _ := strings.Cut(c, " ")
		ops[op]++
	}
	return ops
}

// The write that decides a discard checks for itself that the account owns
// the mailbox and that it isn't an intro mailbox, whatever the read before
// it said: a stale or forged read can't discard someone else's mailbox or
// an intro mailbox, nor touch the account's records or count.
func TestDiscardChecksInItsWrite(t *testing.T) {
	s, meter, _ := metered(t)
	ctx := context.Background()
	d := newDiscardSetup(t, s)
	forged := &twisted{DB: meter, reads: map[string]map[string]types.AttributeValue{}}
	for _, id := range []string{d.theirs, d.intro} {
		forged.reads[mailboxPK(id)+" "+skMailbox] = item(mailboxPK(id), skMailbox, attrs{"o": sv(d.owner.ID)})
	}
	fs := &Store{DB: forged, Table: s.Table}
	records, count := mailboxRecords(t, s, d.owner)
	theirRecords, theirCount := mailboxRecords(t, s, d.other)

	for what, id := range map[string]string{"someone else's mailbox": d.theirs, "an intro mailbox": d.intro} {
		meter.Reset()
		if err := fs.DiscardMailbox(ctx, d.owner.ID, id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s read as the account's own: %v", what, err)
		}
		// The read was forged, so the meter sees only the delete, refused.
		if ops := operations(meter.Calls()); ops["DeleteItem"] != 1 || len(ops) != 1 {
			t.Fatalf("%s: calls %v", what, meter.Calls())
		}
	}
	if m, err := s.Mailbox(ctx, d.theirs); err != nil || m.Owner != d.other.ID {
		t.Fatalf("someone else's mailbox: %+v, %v", m, err)
	}
	if m, err := s.Mailbox(ctx, d.intro); err != nil || m.Owner != d.owner.ID || m.Link == "" {
		t.Fatalf("intro mailbox: %+v, %v", m, err)
	}
	if r, c := mailboxRecords(t, s, d.owner); !slices.Equal(r, records) || c != count {
		t.Fatalf("the account's records %v, count %d; were %v, %d", r, c, records, count)
	}
	if r, c := mailboxRecords(t, s, d.other); !slices.Equal(r, theirRecords) || c != theirCount {
		t.Fatalf("the other account's records %v, count %d; were %v, %d", r, c, theirRecords, theirCount)
	}
}

// A read that fails is an error, never taken for a mailbox that isn't
// there: the app would record a block that discarded nothing.
func TestDiscardReadFailureIsNotNotFound(t *testing.T) {
	s, meter, _ := metered(t)
	ctx := context.Background()
	d := newDiscardSetup(t, s)
	throttled := &types.ProvisionedThroughputExceededException{Message: aws.String("throttled")}
	fs := &Store{DB: &twisted{DB: meter, fail: throttled}, Table: s.Table}
	meter.Reset()
	err := fs.DiscardMailbox(ctx, d.owner.ID, d.mine[0])
	if err == nil || errors.Is(err, ErrNotFound) || !awsconf.Unavailable(err) {
		t.Fatalf("a throttled read: %v", err)
	}
	if calls := meter.Calls(); len(calls) != 0 {
		t.Fatalf("wrote after a failed read: %v", calls)
	}
	if _, err := s.Mailbox(ctx, d.mine[0]); err != nil {
		t.Fatalf("mailbox after a failed read: %v", err)
	}
}

// Removing a discarded mailbox's record and counting it off happen once,
// however often they're tried. A write the table refused outright is tried
// again, a few times; the count's, which mustn't be applied twice, is sent
// once by the SDK and not tried again after any other failure. What a
// failure leaves is the record, or the count one too high; the block holds.
func TestForgetMailbox(t *testing.T) {
	s, meter, _ := metered(t)
	ctx := context.Background()
	d := newDiscardSetup(t, s)
	saved := forgetWaits
	forgetWaits = []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond}
	t.Cleanup(func() { forgetWaits = saved })
	count := func() int {
		t.Helper()
		_, c := mailboxRecords(t, s, d.owner)
		return c
	}
	recorded := func(id string) bool {
		t.Helper()
		r, _ := mailboxRecords(t, s, d.owner)
		return slices.Contains(r, id)
	}
	mailbox := func() string {
		t.Helper()
		id := ids.New()
		if err := s.CreateMailboxes(ctx, d.owner.ID, []string{id}, 10); err != nil {
			t.Fatal(err)
		}
		return id
	}
	record := func(id string) string { return "DeleteItem " + accountPK(d.owner.ID) + " " + mailboxPrefix + id }
	counter := "UpdateItem " + accountPK(d.owner.ID) + " " + skAccount
	throttled := &types.ProvisionedThroughputExceededException{Message: aws.String("throttled")}
	conflict := &types.TransactionConflictException{Message: aws.String("a transaction under way")}

	// Twice: the second finds the record gone and changes nothing.
	before := count()
	for range 2 {
		if err := s.forgetMailbox(ctx, d.owner.ID, d.mine[0]); err != nil {
			t.Fatal(err)
		}
	}
	if recorded(d.mine[0]) || count() != before-1 {
		t.Fatalf("after forgetting twice: recorded %v, count %d (was %d)", recorded(d.mine[0]), count(), before)
	}
	// An intro mailbox's record isn't one to forget, and isn't counted.
	if err := s.forgetMailbox(ctx, d.owner.ID, d.intro); err != nil {
		t.Fatal(err)
	}
	if !recorded(d.intro) || count() != before-1 {
		t.Fatalf("an intro mailbox's record forgotten: count %d", count())
	}

	// Refused outright, then tried again: the record's delete throttled
	// once; the count's met a transaction under way, then was throttled.
	// The count's is sent once by the SDK.
	before = count()
	tw := &twisted{DB: meter, fails: map[string][]error{record(d.mine[1]): {throttled}, counter: {conflict, throttled}}}
	fs := &Store{DB: tw, Table: s.Table}
	if err := fs.DiscardMailbox(ctx, d.owner.ID, d.mine[1]); err != nil || tw.calls[record(d.mine[1])] != 2 || tw.calls[counter] != 3 {
		t.Fatalf("discard through throttling and a conflict: %v; calls %v", err, tw.calls)
	}
	if recorded(d.mine[1]) || count() != before-1 {
		t.Fatalf("after a discard tried again: recorded %v, count %d (was %d)", recorded(d.mine[1]), count(), before)
	}
	var o dynamodb.Options
	for _, f := range tw.opts[counter] {
		f(&o)
	}
	if o.RetryMaxAttempts != 1 {
		t.Fatalf("the count's write may be sent %d times", o.RetryMaxAttempts)
	}

	// The record's delete refused past the tries again: the mailbox is gone
	// (the block holds), the record stays and the count with it; the error
	// is a NotForgotten, the table's, not ErrNotFound. Discarding it again
	// finds nothing to discard.
	extra := mailbox()
	before = count()
	tw = &twisted{DB: meter, fails: map[string][]error{record(extra): slices.Repeat([]error{throttled}, len(forgetWaits)+1)}}
	fs = &Store{DB: tw, Table: s.Table}
	err := fs.DiscardMailbox(ctx, d.owner.ID, extra)
	var notForgotten *NotForgotten
	if !errors.As(err, &notForgotten) || !awsconf.Unavailable(err) || errors.Is(err, ErrNotFound) || tw.calls[record(extra)] != len(forgetWaits)+1 {
		t.Fatalf("the record's delete throttled throughout: %v; calls %v", err, tw.calls)
	}
	if _, err := s.Mailbox(ctx, extra); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the mailbox after its record couldn't be forgotten: %v", err)
	}
	if !recorded(extra) || count() != before {
		t.Fatalf("what a failed record delete leaves: recorded %v, count %d (was %d)", recorded(extra), count(), before)
	}
	if err := s.DiscardMailbox(ctx, d.owner.ID, extra); !errors.Is(err, ErrNotFound) {
		t.Fatalf("discarding it again: %v", err)
	}

	// The count's write failing otherwise (it may have been applied): not
	// tried again. The record is gone, the count one too high.
	extra = mailbox()
	before = count()
	tw = &twisted{DB: meter, fails: map[string][]error{counter: {errors.New("connection reset")}}}
	fs = &Store{DB: tw, Table: s.Table}
	if err := fs.DiscardMailbox(ctx, d.owner.ID, extra); !errors.As(err, &notForgotten) || tw.calls[counter] != 1 {
		t.Fatalf("the count's write failing: %v; calls %v", err, tw.calls)
	}
	if recorded(extra) || count() != before {
		t.Fatalf("what a failed count leaves: recorded %v, count %d (was %d)", recorded(extra), count(), before)
	}
}
