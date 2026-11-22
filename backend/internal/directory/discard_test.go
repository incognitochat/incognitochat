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
// item forged, or an error), and whose transactions can fail first; the
// rest goes to DB.
type twisted struct {
	DB
	reads map[string]map[string]types.AttributeValue // "<pk> <sk>" -> the item read instead
	fail  error                                      // what every GetItem returns, if set

	mu      sync.Mutex
	txFails []error // what the next transactions return, in turn, before any goes through
	txCalls int
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

func (d *twisted) TransactWriteItems(ctx context.Context, in *dynamodb.TransactWriteItemsInput, opts ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error) {
	d.mu.Lock()
	d.txCalls++
	var fail error
	if len(d.txFails) > 0 {
		fail, d.txFails = d.txFails[0], d.txFails[1:]
	}
	d.mu.Unlock()
	if fail != nil {
		return nil, fail
	}
	return d.DB.TransactWriteItems(ctx, in, opts...)
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

func writes(calls []string) (deletes, transactions int) {
	for _, c := range calls {
		switch {
		case strings.HasPrefix(c, "DeleteItem "):
			deletes++
		case strings.HasPrefix(c, "TransactWriteItems "):
			transactions++
		case strings.HasPrefix(c, "PutItem "), strings.HasPrefix(c, "UpdateItem "), strings.HasPrefix(c, "BatchWriteItem "):
			deletes += 100 // no such write is expected: fail loudly
		}
	}
	return deletes, transactions
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
		if deletes, transactions := writes(meter.Calls()); deletes != 1 || transactions != 0 {
			t.Fatalf("%s: %d deletes, %d transactions; calls %v", what, deletes, transactions, meter.Calls())
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
	if deletes, transactions := writes(meter.Calls()); deletes != 0 || transactions != 0 {
		t.Fatalf("wrote after a failed read: %v", meter.Calls())
	}
	if _, err := s.Mailbox(ctx, d.mine[0]); err != nil {
		t.Fatalf("mailbox after a failed read: %v", err)
	}
}

// Removing a discarded mailbox's record and counting it off happen once,
// however often they're tried, and are tried again when a concurrent
// transaction or throttling stops them.
func TestForgetMailbox(t *testing.T) {
	s, meter, _ := metered(t)
	ctx := context.Background()
	d := newDiscardSetup(t, s)
	_, count := mailboxRecords(t, s, d.owner)
	saved := forgetRetries
	forgetRetries = []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond}
	t.Cleanup(func() { forgetRetries = saved })

	// Twice: the second finds the record gone and changes nothing.
	for range 2 {
		if err := s.forgetMailbox(ctx, d.owner.ID, d.mine[0]); err != nil {
			t.Fatal(err)
		}
	}
	if r, c := mailboxRecords(t, s, d.owner); slices.Contains(r, d.mine[0]) || c != count-1 {
		t.Fatalf("after forgetting twice: records %v, count %d (was %d)", r, c, count)
	}
	// An intro mailbox's record isn't one to forget, and isn't counted.
	if err := s.forgetMailbox(ctx, d.owner.ID, d.intro); err != nil {
		t.Fatal(err)
	}
	if r, c := mailboxRecords(t, s, d.owner); !slices.Contains(r, d.intro) || c != count-1 {
		t.Fatalf("an intro mailbox's record forgotten: records %v, count %d", r, c)
	}

	// A concurrent transaction won, then the table was throttled: tried again.
	conflict := &types.TransactionCanceledException{CancellationReasons: []types.CancellationReason{
		{Code: aws.String("TransactionConflict")}, {Code: aws.String("None")}}}
	throttled := &types.ProvisionedThroughputExceededException{Message: aws.String("throttled")}
	tw := &twisted{DB: meter, txFails: []error{conflict, throttled}}
	fs := &Store{DB: tw, Table: s.Table}
	if err := fs.DiscardMailbox(ctx, d.owner.ID, d.mine[1]); err != nil || tw.txCalls != 3 {
		t.Fatalf("discard through a conflict and throttling: %v after %d transactions", err, tw.txCalls)
	}
	if r, c := mailboxRecords(t, s, d.owner); slices.Contains(r, d.mine[1]) || c != count-2 {
		t.Fatalf("after a retried discard: records %v, count %d", r, c)
	}

	// Throttled past the retries: the mailbox is gone (the block holds),
	// its record and the count stay, and the error is the table's, not
	// ErrNotFound. Discarding it again finds nothing to discard.
	extra := ids.New()
	if err := s.CreateMailboxes(ctx, d.owner.ID, []string{extra}, 10); err != nil {
		t.Fatal(err)
	}
	tw = &twisted{DB: meter, txFails: slices.Repeat([]error{throttled}, len(forgetRetries)+1)}
	fs = &Store{DB: tw, Table: s.Table}
	err := fs.DiscardMailbox(ctx, d.owner.ID, extra)
	if !awsconf.Unavailable(err) || tw.txCalls != len(forgetRetries)+1 {
		t.Fatalf("discard throttled throughout: %v after %d transactions", err, tw.txCalls)
	}
	if _, err := s.Mailbox(ctx, extra); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the mailbox after its record couldn't be forgotten: %v", err)
	}
	if r, c := mailboxRecords(t, s, d.owner); !slices.Contains(r, extra) || c != count-1 {
		t.Fatalf("what a failed forget leaves: records %v, count %d", r, c)
	}
	if err := s.DiscardMailbox(ctx, d.owner.ID, extra); !errors.Is(err, ErrNotFound) {
		t.Fatalf("discarding it again: %v", err)
	}
}
