package directory

import (
	"context"
	"errors"
	"math/rand/v2"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/awsconf"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
)

// Mailboxes (docs/architecture.md, Conversations and mailboxes): the server
// routes by mailbox, never by account. It knows each mailbox's owner, to
// deliver, but not who writes to it.
//
//	M#<mailbox>  M          owner (o); for a link's intro mailbox, the link (i)
//	A#<account>  M#<mailbox> marks a mailbox the account owns (intro mailboxes: i = 1)
//
// The account item counts its pool and conversation mailboxes (mc).
const (
	mailboxPrefix = "M#"
	skMailbox     = "M"
)

// Mailbox is a mailbox's owner and, for an intro mailbox, its link.
type Mailbox struct {
	ID    string
	Owner string
	Link  string // set for a link's intro mailbox
}

func mailboxPK(id string) string { return "M#" + id }

// CreateMailboxes makes new mailboxes for an account, counting them against
// max. It returns ErrLimit if the account would own more than max, and
// ErrConflict if an ID is taken.
func (s *Store) CreateMailboxes(ctx context.Context, accountID string, ids []string, max int) error {
	writes := make([]types.TransactWriteItem, 0, 2*len(ids)+1)
	for _, id := range ids {
		writes = append(writes,
			types.TransactWriteItem{Put: &types.Put{
				TableName:           &s.Table,
				Item:                item(mailboxPK(id), skMailbox, attrs{"o": sv(accountID)}),
				ConditionExpression: aws.String("attribute_not_exists(pk)"),
			}},
			types.TransactWriteItem{Put: &types.Put{TableName: &s.Table, Item: item(accountPK(accountID), mailboxPrefix+id, attrs{})}},
		)
	}
	writes = append(writes, types.TransactWriteItem{Update: &types.Update{
		TableName:           &s.Table,
		Key:                 key(accountPK(accountID), skAccount),
		UpdateExpression:    aws.String("SET mc = if_not_exists(mc, :zero) + :n"),
		ConditionExpression: aws.String(live + " AND (attribute_not_exists(mc) OR mc <= :most)"),
		ExpressionAttributeValues: attrs{
			":zero": nv(0),
			":n":    nv(int64(len(ids))),
			":most": nv(int64(max - len(ids))),
		},
	}})
	reasons, err := s.transactReasons(ctx, writes)
	if errors.Is(err, ErrConflict) && len(reasons) == len(writes) && reasons[len(reasons)-1] == "ConditionalCheckFailed" {
		return ErrLimit
	}
	return err
}

// Mailbox returns a mailbox. Unknown and discarded mailboxes are ErrNotFound.
func (s *Store) Mailbox(ctx context.Context, id string) (Mailbox, error) {
	it, err := s.get(ctx, mailboxPK(id), skMailbox, time.Time{})
	if err != nil {
		return Mailbox{}, err
	}
	owner, ok := str(it, "o")
	if !ok {
		return Mailbox{}, ErrNotFound
	}
	link, _ := str(it, "i")
	return Mailbox{ID: id, Owner: owner, Link: link}, nil
}

// Mailboxes lists the mailboxes an account owns: pool, conversation and
// intro mailboxes.
func (s *Store) Mailboxes(ctx context.Context, accountID string) ([]string, error) {
	var ids []string
	var start map[string]types.AttributeValue
	for {
		out, err := s.DB.Query(ctx, &dynamodb.QueryInput{
			TableName:                 &s.Table,
			KeyConditionExpression:    aws.String("pk = :pk AND begins_with(sk, :m)"),
			ExpressionAttributeValues: attrs{":pk": sv(accountPK(accountID)), ":m": sv(mailboxPrefix)},
			ProjectionExpression:      aws.String("sk"),
			ConsistentRead:            aws.Bool(true),
			ExclusiveStartKey:         start,
		})
		if err != nil {
			return nil, err
		}
		for _, it := range out.Items {
			if sk, ok := str(it, "sk"); ok {
				ids = append(ids, strings.TrimPrefix(sk, mailboxPrefix))
			}
		}
		if len(out.LastEvaluatedKey) == 0 {
			return ids, nil
		}
		start = out.LastEvaluatedKey
	}
}

// DiscardMailbox deletes one of an account's pool or conversation mailboxes:
// sends to it then go nowhere, exactly as to one that never existed. Intro
// mailboxes go with their link. It returns ErrNotFound unless the account
// owns the mailbox; a read or write that fails is an error, never taken
// for that. Once the mailbox is deleted, the block holds whatever follows:
// if its record or count can't then be put right, the error is a
// *NotForgotten.
//
// What it costs is what keeps anyone with a session from spending the
// directory's writes:
//   - The mailbox is read first, eventually consistent (half a read unit).
//     An ID that isn't the account's to discard (unknown, someone else's,
//     an intro mailbox, one discarded already) ends there, writing nothing.
//   - Then one conditional delete of the mailbox decides, checking again
//     that the account owns it and that it isn't an intro mailbox: one
//     write unit, and only one request wins it. Copies of the request sent
//     at once all pass the read, and each one that loses is refused here,
//     a write unit, as is a replay that read the mailbox in about the
//     second after it was discarded. (One transaction of all three writes
//     cost each of them 6 write units: DynamoDB bills a cancelled
//     transaction as one that went through.)
//   - The one that deleted the mailbox then removes its record from the
//     account's partition and counts it off (forgetMailbox): two writes of
//     a unit each, so 3 for a block, however many blocks of the account's
//     other mailboxes run at once.
//
// If this delete goes through but its answer is lost, the SDK's second try
// is refused (the mailbox is gone), and the block is answered not_found:
// the app takes that for a block done, which it is, but the record and the
// count aren't put right, as when forgetMailbox fails, and nothing says so.
//
// A mailbox made in about the last second may not be read yet, and is
// answered as unknown. The app takes a mailbox for anything but a receipt
// or a delete it sends in a chat (from its pool, made just before only
// when the pool is empty), and a block comes behind any send under way and
// takes two taps; it tries a block answered not_found once more, about 2
// seconds later.
func (s *Store) DiscardMailbox(ctx context.Context, accountID, id string) error {
	it, err := s.read(ctx, mailboxPK(id), skMailbox, time.Time{}, false)
	if err != nil {
		return err
	}
	owner, _ := str(it, "o")
	if _, intro := it["i"]; owner != accountID || intro {
		return ErrNotFound
	}
	_, err = s.DB.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName:                 &s.Table,
		Key:                       key(mailboxPK(id), skMailbox),
		ConditionExpression:       aws.String("o = :a AND attribute_not_exists(i)"),
		ExpressionAttributeValues: attrs{":a": sv(accountID)},
	})
	var refused *types.ConditionalCheckFailedException
	if errors.As(err, &refused) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if err := s.forgetMailbox(ctx, accountID, id); err != nil {
		return &NotForgotten{Err: err}
	}
	return nil
}

// NotForgotten is DiscardMailbox's error when the mailbox was deleted (the
// block holds) but its record or count couldn't then be put right
// (forgetMailbox). Err says why.
type NotForgotten struct{ Err error }

func (e *NotForgotten) Error() string {
	return "directory: mailbox discarded, its record not forgotten: " + e.Err.Error()
}

func (e *NotForgotten) Unwrap() error { return e.Err }

// forgetWaits bound the random waits before forgetMailbox tries a write
// again, one for each try after the first. Only a write the table refused
// outright is tried again (a throttle, or a transaction on the item under
// way): it wasn't applied, and a throttled one isn't billed. The mailbox
// is gone by then, so its record left behind is worse than a slower
// answer; the waits are random so that instances refused together don't
// try again together.
var forgetWaits = []time.Duration{100 * time.Millisecond, 300 * time.Millisecond, 800 * time.Millisecond}

// forgetMailbox removes a discarded mailbox's record from its owner's
// partition, then counts it off the account's mailboxes (mc). Only for the
// one request that deleted the mailbox. Two single-item writes, not a
// transaction: single-item writes to the account item take turns, where
// transactions naming it cancel each other (and each cancelled one is
// billed), so blocks of the account's other mailboxes at once each still
// cost 3 write units.
//
// It counts a mailbox off at most once, however often it runs: the record
// goes only if it is there (and isn't an intro mailbox's), and only the
// call that removed it counts it off, with a write the SDK sends only once
// (a second try after an answer lost could apply it twice) and that keeps
// the count from going below 0. If the record is gone already, it does
// nothing.
//
// What a failure leaves (the block holds either way: the mailbox is gone):
//   - The record's delete fails: the record stays and the count is one too
//     high, matching it.
//   - The count's fails, or its answer is lost: the record is gone and the
//     count one too high.
//
// Either lasts until the account is deleted, which removes the record and
// passes over the mailbox that is gone (deleteOwned). Nothing mends it
// sooner: telling such a record from a live mailbox's takes reading the
// mailbox, up to 4,000 for an account at the limit. So each such failure
// leaves the account one place fewer of MaxMailboxes (the app, refused
// mailbox_limit, says so, and blocking any chat frees a place); it takes
// the directory failing between two writes made a moment apart, past the
// tries again.
func (s *Store) forgetMailbox(ctx context.Context, accountID, id string) error {
	err := s.untilApplied(ctx, func() error {
		_, err := s.DB.DeleteItem(ctx, &dynamodb.DeleteItemInput{
			TableName:           &s.Table,
			Key:                 key(accountPK(accountID), mailboxPrefix+id),
			ConditionExpression: aws.String("attribute_exists(pk) AND attribute_not_exists(i)"),
		})
		return err
	})
	var refused *types.ConditionalCheckFailedException
	if errors.As(err, &refused) {
		return nil // forgotten already
	}
	if err != nil {
		return err
	}
	err = s.untilApplied(ctx, func() error {
		_, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
			TableName:                 &s.Table,
			Key:                       key(accountPK(accountID), skAccount),
			UpdateExpression:          aws.String("SET mc = mc - :one"),
			ConditionExpression:       aws.String("mc > :zero"),
			ExpressionAttributeValues: attrs{":zero": nv(0), ":one": nv(1)},
		}, triedOnce)
		return err
	})
	if errors.As(err, &refused) {
		return nil // counted off already: mc is 0
	}
	return err
}

// triedOnce makes the SDK send a call once, not again after an error: for
// a write that mustn't be applied twice, which a call that timed out or
// whose answer was lost may have been.
func triedOnce(o *dynamodb.Options) { o.RetryMaxAttempts = 1 }

// untilApplied runs write, and again after a random wait of up to each of
// forgetWaits in turn, while the table refused it outright: throttled
// (awsconf.Throttled), or a transaction on the item under way
// (TransactionConflictException). It returns the last error.
func (s *Store) untilApplied(ctx context.Context, write func() error) error {
	for attempt := 0; ; attempt++ {
		err := write()
		var conflict *types.TransactionConflictException
		if err == nil || !(awsconf.Throttled(err) || errors.As(err, &conflict)) || attempt == len(forgetWaits) {
			return err
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(rand.N(forgetWaits[attempt])):
		}
	}
}

// Devices returns the IDs of an account's devices that haven't expired,
// whatever became of the account: to clear what waits for them. Deliveries
// go by Recipients.
func (s *Store) Devices(ctx context.Context, accountID string, now time.Time) ([]string, error) {
	items, err := s.prefixed(ctx, accountID, devicePrefix, "sk, e")
	if err != nil {
		return nil, err
	}
	var devices []string
	for _, it := range items {
		if !expired(it, now) {
			sk, _ := str(it, "sk")
			devices = append(devices, strings.TrimPrefix(sk, devicePrefix))
		}
	}
	return devices, nil
}

// Recipients returns the devices a delivery to one of an account's
// mailboxes goes to: none unless the account is live, neither replaced nor
// being deleted nor gone. So an account's mailboxes all stop taking
// messages the moment it ends, with no write to any of them: a send to one
// then goes as to a mailbox that doesn't exist. It reads the account item
// and its devices in one query (they sort together: accountSortKeys),
// eventually consistent: an account that ended in about the last second
// may still get a delivery, which its devices can no longer fetch.
func (s *Store) Recipients(ctx context.Context, accountID string, now time.Time) ([]string, error) {
	devices, _, err := s.recipients(ctx, accountID, now)
	return devices, err
}

// recipients is Recipients, also reporting how many items it read, expired
// ones too.
func (s *Store) recipients(ctx context.Context, accountID string, now time.Time) ([]string, int, error) {
	pages := dynamodb.NewQueryPaginator(s.DB, &dynamodb.QueryInput{
		TableName:              &s.Table,
		KeyConditionExpression: aws.String("pk = :pk AND sk BETWEEN :a AND :d"),
		ExpressionAttributeValues: attrs{
			":pk": sv(accountPK(accountID)),
			":a":  sv(skAccount),
			":d":  sv(afterDevices),
		},
		// What tells whether the account is live, and when its items expire.
		ProjectionExpression: aws.String("sk, e, g, dl"),
	})
	live := false
	var devices []string
	read := 0
	for pages.HasMorePages() {
		page, err := pages.NextPage(ctx)
		if err != nil {
			return nil, read, err
		}
		read += len(page.Items)
		for _, it := range page.Items {
			if expired(it, now) {
				continue
			}
			sk, _ := str(it, "sk")
			if sk == skAccount {
				_, replaced := it["g"]
				_, deleting := it["dl"]
				live = !replaced && !deleting
				continue
			}
			devices = append(devices, strings.TrimPrefix(sk, devicePrefix))
		}
	}
	if !live {
		return nil, read, nil
	}
	return devices, read, nil
}

// NoAccount is the account ID of placeholders: no account has it (IDs are
// random; this one is all zeros).
var NoAccount = ids.Encode([16]byte{})

// placeholderKeyLen is the length of a device's public key, as stored
// (a raw P-256 point).
const placeholderKeyLen = 65

// NoRecipients looks up the devices of an account that doesn't exist, for
// a send to a mailbox that doesn't exist, the way Recipients looks up an
// account's: the same query, reading two items, an account's and one as
// large as a device's (placeholders of NoAccount's, the device's key all
// zeros, both expired long ago, so none is found). So the lookup costs as
// many read units, and answers about as much, as one for an account with
// its one device. It writes the placeholders when they're missing: the
// first time, and if TTL ever took them (TTL skips expiries more than five
// years past, as theirs are). One partition reads at most 3,000 units a
// second, so the table's cap stays at most that (infra/variables.tf,
// table_max_read_units).
func (s *Store) NoRecipients(ctx context.Context, now time.Time) error {
	_, read, err := s.recipients(ctx, NoAccount, now)
	if err != nil || read >= 2 {
		return err
	}
	return s.batchWrite(ctx, []types.WriteRequest{
		{PutRequest: &types.PutRequest{Item: item(accountPK(NoAccount), skAccount, attrs{"e": nv(1)})}},
		{PutRequest: &types.PutRequest{Item: item(accountPK(NoAccount), devicePrefix+NoAccount, attrs{"k": bv(make([]byte, placeholderKeyLen)), "e": nv(1)})}},
	})
}

// introMailboxWrites creates a link's intro mailbox (with CreateLink).
func (s *Store) introMailboxWrites(accountID, linkID, mailboxID string) []types.TransactWriteItem {
	return []types.TransactWriteItem{
		{Put: &types.Put{
			TableName:           &s.Table,
			Item:                item(mailboxPK(mailboxID), skMailbox, attrs{"o": sv(accountID), "i": sv(linkID)}),
			ConditionExpression: aws.String("attribute_not_exists(pk)"),
		}},
		{Put: &types.Put{TableName: &s.Table, Item: item(accountPK(accountID), mailboxPrefix+mailboxID, attrs{"i": nv(1)})}},
	}
}
