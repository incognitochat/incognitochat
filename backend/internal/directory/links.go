package directory

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/links"
)

const (
	linkPrefix = "K#"
	skLink     = "L"
)

// ErrLimit is returned when an account already has the most links allowed.
var ErrLimit = errors.New("directory: limit reached")

// Link is a link's public bundle.
type Link struct {
	ID         string
	SigningKey []byte
	Keys       []links.Key
	Mailbox    string // the intro mailbox first messages go to
}

func linkPK(id string) string { return "L#" + id }

// CreateLink stores a new link for an account, counting it against max. It
// returns ErrConflict if the link ID is taken, and ErrLimit if the account
// has max links already (or no longer exists, or is being deleted).
//
// A count that says more links than the account has (left by a deletion
// cut short before deletions were marked, which took the link but not the
// count) is put right, once, and the link made after all.
func (s *Store) CreateLink(ctx context.Context, accountID string, l Link, max int) error {
	err := s.createLink(ctx, accountID, l, max)
	if errors.Is(err, ErrLimit) {
		if fixed, ferr := s.recountLinks(ctx, accountID); ferr != nil {
			return ferr
		} else if fixed {
			err = s.createLink(ctx, accountID, l, max)
		}
	}
	return err
}

func (s *Store) createLink(ctx context.Context, accountID string, l Link, max int) error {
	writes := append(s.newLinkWrites(accountID, l), types.TransactWriteItem{Update: &types.Update{
		TableName:           &s.Table,
		Key:                 key(accountPK(accountID), skAccount),
		UpdateExpression:    aws.String("SET lc = if_not_exists(lc, :zero) + :one, " + linkChange),
		ConditionExpression: aws.String(live + " AND (attribute_not_exists(lc) OR lc < :max)"),
		ExpressionAttributeValues: attrs{
			":zero": nv(0),
			":one":  nv(1),
			":max":  nv(int64(max)),
			":lq":   newLinkChange(),
		},
	}})
	writes = append(writes, s.introMailboxWrites(accountID, l.ID, l.Mailbox)...)
	reasons, err := s.transactReasons(ctx, writes)
	if errors.Is(err, ErrConflict) && len(reasons) == len(writes) && reasons[2] == "ConditionalCheckFailed" {
		return ErrLimit
	}
	return err
}

// linkChange marks a change to an account's links (lq), in the same write
// as the change: create, replace and revoke all do, and so do recountLinks
// and MarkDeleting. It is a fresh random value each time (newLinkChange,
// as :lq), not a count, so the item says nothing about how often an
// account changed its link; a write that read it can tell, by comparing
// (linksUnchanged), whether any change came since.
const linkChange = "lq = :lq"

// newLinkChange is a value for linkChange.
func newLinkChange() types.AttributeValue { return sv(ids.New()) }

// linksUnchanged is a condition that an account's links haven't changed
// since its item was read with lq (nil if it had none), and its values.
func linksUnchanged(lq types.AttributeValue) (string, attrs) {
	if lq == nil {
		return "attribute_not_exists(lq)", attrs{}
	}
	return "lq = :q", attrs{":q": lq}
}

// recountLinks sets a live account's link count to the links it has, if it
// says more, and reports whether it did. Only if no link changed since it
// read them (lq): one made or revoked meanwhile wins, even if the count is
// back where it was.
func (s *Store) recountLinks(ctx context.Context, accountID string) (bool, error) {
	acct, err := s.get(ctx, accountPK(accountID), skAccount, time.Time{})
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	_, account := acct["ak"]
	_, deleting := acct["dl"]
	counted := num(acct, "lc")
	if !account || deleting || counted == 0 {
		return false, nil
	}
	owned, err := s.prefixed(ctx, accountID, linkPrefix, "sk")
	if err != nil || int64(len(owned)) >= counted {
		return false, err
	}
	unchanged, values := linksUnchanged(acct["lq"])
	values[":n"], values[":lq"] = nv(int64(len(owned))), newLinkChange()
	_, err = s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 &s.Table,
		Key:                       key(accountPK(accountID), skAccount),
		UpdateExpression:          aws.String("SET lc = :n, " + linkChange),
		ConditionExpression:       aws.String(live + " AND " + unchanged),
		ExpressionAttributeValues: values,
	})
	var failed *types.ConditionalCheckFailedException
	if errors.As(err, &failed) {
		return false, nil
	}
	return err == nil, err
}

// newLinkWrites stores a link's bundle and lists it under its account.
func (s *Store) newLinkWrites(accountID string, l Link) []types.TransactWriteItem {
	return []types.TransactWriteItem{
		{Put: &types.Put{
			TableName: &s.Table,
			Item: item(linkPK(l.ID), skLink, attrs{
				"a":  sv(accountID),
				"k":  bv(l.SigningKey),
				"ek": keysValue(l.Keys),
				"m":  sv(l.Mailbox),
			}),
			ConditionExpression: aws.String("attribute_not_exists(pk)"),
		}},
		{Put: &types.Put{
			TableName: &s.Table,
			Item:      item(accountPK(accountID), linkPrefix+l.ID, attrs{}),
		}},
	}
}

// oldLinkWrites deletes an account's link, its listing and its intro mailbox.
// The first write fails its condition unless the account owns the link.
func (s *Store) oldLinkWrites(accountID string, old Link) []types.TransactWriteItem {
	return []types.TransactWriteItem{
		{Delete: &types.Delete{
			TableName:                 &s.Table,
			Key:                       key(linkPK(old.ID), skLink),
			ConditionExpression:       aws.String("a = :a"),
			ExpressionAttributeValues: attrs{":a": sv(accountID)},
		}},
		{Delete: &types.Delete{TableName: &s.Table, Key: key(accountPK(accountID), linkPrefix+old.ID)}},
		{Delete: &types.Delete{TableName: &s.Table, Key: key(mailboxPK(old.Mailbox), skMailbox)}},
		{Delete: &types.Delete{TableName: &s.Table, Key: key(accountPK(accountID), mailboxPrefix+old.Mailbox)}},
	}
}

// ReplaceLink swaps an account's link for a new one in one step: the old
// link and its intro mailbox go, the new one takes its place, and the link
// count stays the same. It returns ErrNotFound unless the account (still
// there, neither replaced nor being deleted) owns oldID, and ErrConflict if
// the new ID is taken.
func (s *Store) ReplaceLink(ctx context.Context, accountID, oldID string, l Link) error {
	if oldID == l.ID {
		return ErrConflict
	}
	old, err := s.Link(ctx, oldID)
	if err != nil {
		return err
	}
	writes := append(s.oldLinkWrites(accountID, old), s.newLinkWrites(accountID, l)...)
	writes = append(writes, s.introMailboxWrites(accountID, l.ID, l.Mailbox)...)
	// As for every item made in the partition: a replaced account's item is
	// only a marker, with no account key, and nothing new joins it, nor an
	// account being deleted.
	writes = append(writes, types.TransactWriteItem{Update: &types.Update{
		TableName:                 &s.Table,
		Key:                       key(accountPK(accountID), skAccount),
		UpdateExpression:          aws.String("SET " + linkChange),
		ConditionExpression:       aws.String(live),
		ExpressionAttributeValues: attrs{":lq": newLinkChange()},
	}})
	reasons, err := s.transactReasons(ctx, writes)
	if errors.Is(err, ErrConflict) && len(reasons) == len(writes) &&
		(reasons[0] == "ConditionalCheckFailed" || reasons[len(reasons)-1] == "ConditionalCheckFailed") {
		return ErrNotFound
	}
	return err
}

// Link returns a link's bundle. Revoked and unknown links are both ErrNotFound.
func (s *Store) Link(ctx context.Context, id string) (Link, error) {
	return s.link(ctx, id, true)
}

// Bundle is Link for anyone who opens the link, eventually consistent at
// half the cost: a link made or revoked in about the last second may not
// show yet. Sends through it still go by its intro mailbox, which is read
// afresh.
func (s *Store) Bundle(ctx context.Context, id string) (Link, error) {
	return s.link(ctx, id, false)
}

func (s *Store) link(ctx context.Context, id string, consistent bool) (Link, error) {
	it, err := s.read(ctx, linkPK(id), skLink, time.Time{}, consistent)
	if err != nil {
		return Link{}, err
	}
	k, ok := bin(it, "k")
	keys, okKeys := keysFrom(it["ek"])
	mailbox, okMailbox := str(it, "m")
	if !ok || !okKeys || !okMailbox {
		return Link{}, ErrNotFound
	}
	return Link{ID: id, SigningKey: k, Keys: keys, Mailbox: mailbox}, nil
}

// SetLinkKeys replaces a link's encryption keys. It returns ErrNotFound unless
// the account owns the link.
func (s *Store) SetLinkKeys(ctx context.Context, accountID, id string, keys []links.Key) error {
	_, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 &s.Table,
		Key:                       key(linkPK(id), skLink),
		UpdateExpression:          aws.String("SET ek = :ek"),
		ConditionExpression:       aws.String("a = :a"),
		ExpressionAttributeValues: attrs{":ek": keysValue(keys), ":a": sv(accountID)},
	})
	var failed *types.ConditionalCheckFailedException
	if errors.As(err, &failed) {
		return ErrNotFound
	}
	return err
}

// DeleteLink revokes a link and its intro mailbox. It returns ErrNotFound
// unless the account owns it.
func (s *Store) DeleteLink(ctx context.Context, accountID, id string) error {
	l, err := s.Link(ctx, id)
	if err != nil {
		return err
	}
	writes := append(s.oldLinkWrites(accountID, l), types.TransactWriteItem{Update: &types.Update{
		TableName:                 &s.Table,
		Key:                       key(accountPK(accountID), skAccount),
		UpdateExpression:          aws.String("SET lc = lc - :one, " + linkChange),
		ConditionExpression:       aws.String("lc > :zero"),
		ExpressionAttributeValues: attrs{":zero": nv(0), ":one": nv(1), ":lq": newLinkChange()},
	}})
	reasons, err := s.transactReasons(ctx, writes)
	if errors.Is(err, ErrConflict) && len(reasons) > 0 && reasons[0] == "ConditionalCheckFailed" {
		return ErrNotFound
	}
	return err
}

func keysValue(keys []links.Key) types.AttributeValue {
	list := make([]types.AttributeValue, len(keys))
	for i, k := range keys {
		list[i] = &types.AttributeValueMemberM{Value: attrs{
			"k": bv(k.Key),
			"f": nv(k.From.Unix()),
			"u": nv(k.Until.Unix()),
			"s": bv(k.Signature),
		}}
	}
	return &types.AttributeValueMemberL{Value: list}
}

func keysFrom(v types.AttributeValue) ([]links.Key, bool) {
	list, ok := v.(*types.AttributeValueMemberL)
	if !ok {
		return nil, false
	}
	keys := make([]links.Key, 0, len(list.Value))
	for _, e := range list.Value {
		m, ok := e.(*types.AttributeValueMemberM)
		if !ok {
			return nil, false
		}
		k, ok1 := bin(m.Value, "k")
		sig, ok2 := bin(m.Value, "s")
		from, ok3 := m.Value["f"].(*types.AttributeValueMemberN)
		until, ok4 := m.Value["u"].(*types.AttributeValueMemberN)
		if !ok1 || !ok2 || !ok3 || !ok4 {
			return nil, false
		}
		f, err1 := strconv.ParseInt(from.Value, 10, 64)
		u, err2 := strconv.ParseInt(until.Value, 10, 64)
		if err1 != nil || err2 != nil {
			return nil, false
		}
		keys = append(keys, links.Key{Key: k, From: time.Unix(f, 0), Until: time.Unix(u, 0), Signature: sig})
	}
	return keys, true
}
