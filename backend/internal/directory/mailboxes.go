package directory

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/ids"
)

// Mailboxes (design §9): the server routes by mailbox, never by account. It
// knows each mailbox's owner, to deliver, but not who writes to it.
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
		ConditionExpression: aws.String("attribute_exists(ak) AND (attribute_not_exists(mc) OR mc <= :most)"),
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

// MailboxCount is how many pool and conversation mailboxes an account owns
// (not its link's intro mailbox), as counted against the most allowed.
func (s *Store) MailboxCount(ctx context.Context, accountID string, now time.Time) (int, error) {
	item, err := s.get(ctx, accountPK(accountID), skAccount, now)
	if err != nil {
		return 0, err
	}
	return int(num(item, "mc")), nil
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
// owns the mailbox.
func (s *Store) DiscardMailbox(ctx context.Context, accountID, id string) error {
	writes := []types.TransactWriteItem{
		{Delete: &types.Delete{
			TableName:                 &s.Table,
			Key:                       key(mailboxPK(id), skMailbox),
			ConditionExpression:       aws.String("o = :a AND attribute_not_exists(i)"),
			ExpressionAttributeValues: attrs{":a": sv(accountID)},
		}},
		{Delete: &types.Delete{TableName: &s.Table, Key: key(accountPK(accountID), mailboxPrefix+id)}},
		{Update: &types.Update{
			TableName:                 &s.Table,
			Key:                       key(accountPK(accountID), skAccount),
			UpdateExpression:          aws.String("SET mc = mc - :one"),
			ConditionExpression:       aws.String("mc > :zero"),
			ExpressionAttributeValues: attrs{":zero": nv(0), ":one": nv(1)},
		}},
	}
	reasons, err := s.transactReasons(ctx, writes)
	if errors.Is(err, ErrConflict) && len(reasons) > 0 && reasons[0] == "ConditionalCheckFailed" {
		return ErrNotFound
	}
	return err
}

// Devices returns the IDs of an account's current devices, for delivery.
func (s *Store) Devices(ctx context.Context, accountID string, now time.Time) ([]string, error) {
	devices, _, err := s.devices(ctx, accountID, now)
	return devices, err
}

// devices is Devices, also reporting how many items it read, expired ones
// too.
func (s *Store) devices(ctx context.Context, accountID string, now time.Time) ([]string, int, error) {
	pages := dynamodb.NewQueryPaginator(s.DB, &dynamodb.QueryInput{
		TableName:              &s.Table,
		KeyConditionExpression: aws.String("pk = :pk AND begins_with(sk, :d)"),
		ExpressionAttributeValues: attrs{
			":pk": sv(accountPK(accountID)),
			":d":  sv(devicePrefix),
		},
	})
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
			devices = append(devices, strings.TrimPrefix(sk, devicePrefix))
		}
	}
	return devices, read, nil
}

// NoAccount is the account ID of placeholders: no account has it (IDs are
// random; this one is all zeros).
var NoAccount = ids.Encode([16]byte{})

// placeholderKeyLen is the length of a device's public key, as stored
// (a raw P-256 point).
const placeholderKeyLen = 65

// NoDevices looks up the devices of an account that doesn't exist, for a
// send to a mailbox that doesn't exist, the way Devices looks up an
// account's: the same query, reading one item as large as a device's (a
// placeholder of NoAccount's, all zeros, that expired long ago, so none is
// found). So the lookup costs as many read units, and answers about as
// much, as one for an account with its one device. It writes the
// placeholder when it's missing: the first time, and if TTL ever took it
// (TTL skips expiries more than five years past, as its is). One partition
// reads at most 3,000 units a second, so the table's cap stays at most
// that (infra/variables.tf, table_max_read_units).
func (s *Store) NoDevices(ctx context.Context, now time.Time) error {
	_, read, err := s.devices(ctx, NoAccount, now)
	if err != nil || read > 0 {
		return err
	}
	_, err = s.DB.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: &s.Table,
		Item:      item(accountPK(NoAccount), devicePrefix+NoAccount, attrs{"k": bv(make([]byte, placeholderKeyLen)), "e": nv(1)}),
	})
	return err
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
