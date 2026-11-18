package directory

import (
	"context"
	"errors"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/links"
)

func TestDelete(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()
	other := registered(t, s)
	n := registered(t, s)
	l := testLink(t)
	pool := []string{ids.New(), ids.New()}
	if err := s.CreateLink(ctx, n.ID, l, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateMailboxes(ctx, n.ID, pool, 10); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateInvitation(ctx, n.ID, "abcd-efgh", 1, 0, -1); err != nil {
		t.Fatal(err)
	}
	if err := s.SetNotices(ctx, n.ID, []byte("sealed chat"), "en"); err != nil {
		t.Fatal(err)
	}

	if done, err := s.Delete(ctx, n.ID, n.TelegramHash, 100); err != nil || !done {
		t.Fatalf("delete: %v %v", done, err)
	}

	// Nothing of it is left: the table holds only the other account's items,
	// and its link signing key's tombstone, which names nobody.
	out, err := client.Scan(ctx, &dynamodb.ScanInput{TableName: aws.String(s.Table)})
	if err != nil {
		t.Fatal(err)
	}
	for _, it := range out.Items {
		pk, _ := str(it, "pk")
		if pk != accountPK(other.ID) && pk != "T#"+other.TelegramHash && !tombstone(it) {
			sk, _ := str(it, "sk")
			t.Errorf("left behind: %s %s", pk, sk)
		}
	}
	if _, err := s.Device(ctx, n.ID, n.DeviceID, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("device of a deleted account: %v", err)
	}
	if _, err := s.Link(ctx, l.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("link of a deleted account: %v", err)
	}
	for _, id := range append(pool, l.Mailbox) {
		if _, err := s.Mailbox(ctx, id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("mailbox %s of a deleted account: %v", id, err)
		}
	}
	if _, err := s.Redeem(ctx, other.ID, "abcd-efgh"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("code of a deleted account: %v", err)
	}

	// The same Telegram user can set up again, as new.
	if err := s.Create(ctx, newAccount(t, n.TelegramHash)); err != nil {
		t.Fatalf("set up again: %v", err)
	}
	// Deleting again finds nothing.
	if _, err := s.Delete(ctx, n.ID, n.TelegramHash, 100); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete: %v", err)
	}
}

func TestDeleteInSteps(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()
	n := registered(t, s)
	l := testLink(t)
	if err := s.CreateLink(ctx, n.ID, l, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	var pool []string
	for range 4 {
		batch := []string{ids.New(), ids.New(), ids.New(), ids.New(), ids.New()}
		if err := s.CreateMailboxes(ctx, n.ID, batch, 100); err != nil {
			t.Fatal(err)
		}
		pool = append(pool, batch...)
	}

	// The first step takes the link first, and the account stays.
	done, err := s.Delete(ctx, n.ID, n.TelegramHash, 6)
	if err != nil || done {
		t.Fatalf("first step: %v %v", done, err)
	}
	if _, err := s.Link(ctx, l.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("link after the first step: %v", err)
	}
	if _, err := s.Device(ctx, n.ID, n.DeviceID, now); err != nil {
		t.Fatalf("device after the first step: %v", err)
	}

	// 21 mailboxes (the link's intro mailbox too) and the link, 2 items
	// each, and a few of the account's own, 6 a step.
	steps := 1
	for !done {
		if done, err = s.Delete(ctx, n.ID, n.TelegramHash, 6); err != nil {
			t.Fatal(err)
		}
		if steps++; steps > 20 {
			t.Fatal("never finishes")
		}
	}
	if steps < 8 {
		t.Errorf("only %d steps", steps)
	}
	out, err := client.Scan(ctx, &dynamodb.ScanInput{TableName: aws.String(s.Table)})
	if err != nil {
		t.Fatal(err)
	}
	for _, it := range out.Items {
		pk, _ := str(it, "pk")
		sk, _ := str(it, "sk")
		if !tombstone(it) {
			t.Errorf("left behind: %s %s", pk, sk)
		}
	}
	for _, id := range append(pool, l.Mailbox) {
		if _, err := s.Mailbox(ctx, id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("mailbox %s: %v", id, err)
		}
	}
}

func TestDeleteReplacedAccount(t *testing.T) {
	s, _ := store(t)
	ctx := context.Background()
	first := registered(t, s)
	old, _ := s.ByTelegram(ctx, first.TelegramHash, first.DeviceID)
	second := newAccount(t, first.TelegramHash)
	if err := s.Replace(ctx, old, second, now); err != nil {
		t.Fatal(err)
	}
	// A replaced account can't delete anything, least of all its successor's Telegram item.
	if _, err := s.Delete(ctx, first.ID, first.TelegramHash, 100); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete a replaced account: %v", err)
	}
	if got, err := s.ByTelegram(ctx, first.TelegramHash, first.DeviceID); err != nil || got.ID != second.ID {
		t.Fatalf("successor = %+v, %v", got, err)
	}
}

// conflictDB cancels the first transaction that deletes an account item, as
// DynamoDB does when another write to it (a mailbox, a notice) is in flight.
// DynamoDB Local runs transactions one at a time, so it can't race them.
type conflictDB struct {
	*dynamodb.Client
	fired bool
}

func (c *conflictDB) TransactWriteItems(ctx context.Context, in *dynamodb.TransactWriteItemsInput, opts ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error) {
	if first := in.TransactItems[0].Delete; !c.fired && first != nil {
		if sk, _ := str(first.Key, "sk"); sk == skAccount {
			c.fired = true
			reasons := make([]types.CancellationReason, len(in.TransactItems))
			for i := range reasons {
				reasons[i] = types.CancellationReason{Code: aws.String("None")}
			}
			reasons[0].Code = aws.String("TransactionConflict")
			return nil, &types.TransactionCanceledException{Message: aws.String("conflict"), CancellationReasons: reasons}
		}
	}
	return c.Client.TransactWriteItems(ctx, in, opts...)
}

func TestDeleteAfterAConflictIsNotDone(t *testing.T) {
	plain, client := store(t)
	ctx := context.Background()
	n := registered(t, plain)
	s := &Store{DB: &conflictDB{Client: client}, Table: plain.Table}

	// The last step is cancelled by another write: not done, and not "gone".
	done, err := s.Delete(ctx, n.ID, n.TelegramHash, 100)
	if err != nil || done {
		t.Fatalf("delete with a conflict: %v %v", done, err)
	}
	if _, err := s.Device(ctx, n.ID, n.DeviceID, now); err != nil {
		t.Fatalf("the account went anyway: %v", err)
	}
	// Asking again finishes it.
	if done, err := s.Delete(ctx, n.ID, n.TelegramHash, 100); err != nil || !done {
		t.Fatalf("delete again: %v %v", done, err)
	}
	if _, err := s.Device(ctx, n.ID, n.DeviceID, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("device after delete: %v", err)
	}
	if _, err := s.AccountOf(ctx, n.TelegramHash); !errors.Is(err, ErrNotFound) {
		t.Fatalf("telegram item after delete: %v", err)
	}
}
