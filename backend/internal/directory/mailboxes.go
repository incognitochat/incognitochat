package directory

import (
	"context"
	"errors"
	"slices"
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
// for that.
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
//     account's partition and counts it off (forgetMailbox): 4 write
//     units, so 5 for a block.
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
	return s.forgetMailbox(ctx, accountID, id)
}

// forgetRetries are the waits before forgetMailbox tries again, when it
// was throttled or a concurrent transaction on the account item (a pool
// top-up, say) won: the mailbox is gone by then, and its record left
// behind is worse than a slower answer.
var forgetRetries = []time.Duration{50 * time.Millisecond, 150 * time.Millisecond, 400 * time.Millisecond}

// forgetMailbox removes a discarded mailbox's record from its owner's
// partition and counts it off the account's mailboxes (mc), both at once,
// so the count always matches the records. Only for the one request that
// deleted the mailbox. It does it once however often it runs: it's
// conditioned on the record being there (and the SDK sends its retries
// with the same idempotency token).
//
// If it still fails, the block holds (the mailbox is gone) but its record
// stays, and the count one too high, until the account is deleted, which
// deletes the record and passes over the mailbox that is gone (deleteOwned).
// Nothing mends it sooner: telling such a record from a live mailbox's
// takes reading the mailbox, up to 4,000 for an account at the limit. So
// each such failure leaves the account one place fewer of MaxMailboxes
// (the app, refused mailbox_limit, says so, and ending or blocking any
// chat frees a place); it takes the directory failing in the moment
// between these two writes, past the retries.
func (s *Store) forgetMailbox(ctx context.Context, accountID, id string) error {
	writes := []types.TransactWriteItem{
		{Delete: &types.Delete{
			TableName:           &s.Table,
			Key:                 key(accountPK(accountID), mailboxPrefix+id),
			ConditionExpression: aws.String("attribute_exists(pk) AND attribute_not_exists(i)"),
		}},
		{Update: &types.Update{
			TableName:                 &s.Table,
			Key:                       key(accountPK(accountID), skAccount),
			UpdateExpression:          aws.String("SET mc = mc - :one"),
			ConditionExpression:       aws.String("mc > :zero"),
			ExpressionAttributeValues: attrs{":zero": nv(0), ":one": nv(1)},
		}},
	}
	for attempt := 0; ; attempt++ {
		reasons, err := s.transactReasons(ctx, writes)
		if errors.Is(err, ErrConflict) && len(reasons) > 0 && reasons[0] == "ConditionalCheckFailed" {
			return nil // forgotten already
		}
		again := awsconf.Unavailable(err) || (errors.Is(err, ErrConflict) && slices.Contains(reasons, "TransactionConflict"))
		if err == nil || !again || attempt == len(forgetRetries) {
			return err
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(forgetRetries[attempt]):
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
