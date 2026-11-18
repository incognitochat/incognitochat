package directory

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/devicesig"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/links"
)

const (
	linkPrefix = "K#"
	skLink     = "L"
	skKey      = "F"
)

var (
	// ErrLimit is returned when an account already has the most links allowed.
	ErrLimit = errors.New("directory: limit reached")
	// ErrKeyTaken is returned when another account's link has the signing
	// key a link is to have (claimKey).
	ErrKeyTaken = errors.New("directory: signing key taken")
)

// Link is a link's public bundle.
type Link struct {
	ID         string
	SigningKey []byte
	Keys       []links.Key
	Mailbox    string // the intro mailbox first messages go to
}

func linkPK(id string) string { return "L#" + id }

// Signing keys. A sender's tag is the same on every link with one signing
// key (docs/protocol.md, the tag field), so two accounts whose links shared
// a key could compare the tags they get and match a sender who writes to
// both. So a signing key belongs to one account:
//
//	F#<fingerprint>  F        the account whose links have the signing key (a)
//
// It is written in the same transaction that gives the account a link with
// the key (claimKey), and the account's record of the link notes the
// fingerprint (f), so the item goes with that record (releaseKey: when the
// link is revoked, replaced by one with another key, or ends with its
// account; or, from the record, in the steps after). The same account may
// use the key again (a replacement keeps it); another account is refused
// (ErrKeyTaken), unless the one the item names isn't live any more: its
// links are gone, or deliver nothing, and the item it left is taken over.
// So an item never blocks a key for good; only its own account's writes
// delete it, and another account's only take it over once that account
// has ended. It says nothing the link item doesn't (the link's owner, and
// its signing key, whose fingerprint anyone can work out), and only while
// the account has a link with that key.
//
// Links made before these items existed have none until their account
// rotates their keys (SetLinkKeys) or replaces them, which records it.

// keyPK is the partition key of a signing key's item, by its fingerprint.
func keyPK(fingerprint string) string { return "F#" + fingerprint }

// claimKey returns the transaction items that record a signing key, by its
// fingerprint, as accountID's, to go with the write that gives the account a
// link with it, and whether the key is accountID's already (then the item
// only checks that it still is). It returns ErrKeyTaken if a live account
// other than accountID has it.
func (s *Store) claimKey(ctx context.Context, accountID, fingerprint string) ([]types.TransactWriteItem, bool, error) {
	it, err := s.get(ctx, keyPK(fingerprint), skKey, time.Time{})
	if err != nil && !errors.Is(err, ErrNotFound) {
		return nil, false, err
	}
	claim := &types.Put{
		TableName:           &s.Table,
		Item:                item(keyPK(fingerprint), skKey, attrs{"a": sv(accountID)}),
		ConditionExpression: aws.String("attribute_not_exists(pk)"),
	}
	if it == nil {
		return []types.TransactWriteItem{{Put: claim}}, false, nil
	}
	owner, ok := str(it, "a")
	if ok && owner == accountID {
		return []types.TransactWriteItem{{ConditionCheck: &types.ConditionCheck{
			TableName:                 &s.Table,
			Key:                       key(keyPK(fingerprint), skKey),
			ConditionExpression:       aws.String("a = :a"),
			ExpressionAttributeValues: attrs{":a": sv(accountID)},
		}}}, true, nil
	}
	if !ok {
		claim.ConditionExpression = aws.String("attribute_not_exists(a)")
		return []types.TransactWriteItem{{Put: claim}}, false, nil
	}
	acct, err := s.get(ctx, accountPK(owner), skAccount, time.Time{})
	if err != nil && !errors.Is(err, ErrNotFound) {
		return nil, false, err
	}
	_, hasKey := acct["ak"]
	_, deleting := acct["dl"]
	if hasKey && !deleting {
		return nil, false, ErrKeyTaken
	}
	// Left by an account that ended: taken over, only while it is so.
	claim.ConditionExpression = aws.String("a = :o")
	claim.ExpressionAttributeValues = attrs{":o": sv(owner)}
	return []types.TransactWriteItem{
		{Put: claim},
		{ConditionCheck: &types.ConditionCheck{
			TableName:           &s.Table,
			Key:                 key(accountPK(owner), skAccount),
			ConditionExpression: aws.String(ended),
		}},
	}, false, nil
}

// releaseKey returns the transaction item that deletes a signing key's
// item, by its fingerprint, to go with the write that ends accountID's link
// with it: only while accountID has the key, or nobody does (so one that a
// rotation records meanwhile goes too), and none if another account has it
// (it isn't accountID's to delete).
func (s *Store) releaseKey(ctx context.Context, accountID, fingerprint string) ([]types.TransactWriteItem, error) {
	it, err := s.get(ctx, keyPK(fingerprint), skKey, time.Time{})
	if err != nil && !errors.Is(err, ErrNotFound) {
		return nil, err
	}
	if owner, ok := str(it, "a"); ok && owner != accountID {
		return nil, nil
	}
	return []types.TransactWriteItem{{Delete: &types.Delete{
		TableName:                 &s.Table,
		Key:                       key(keyPK(fingerprint), skKey),
		ConditionExpression:       aws.String("attribute_not_exists(pk) OR a = :a"),
		ExpressionAttributeValues: attrs{":a": sv(accountID)},
	}}}, nil
}

// CreateLink stores a new link for an account, counting it against max. It
// returns ErrConflict if the link ID is taken, ErrKeyTaken if another
// account's link has its signing key, and ErrLimit if the account has max
// links already (or no longer exists, or is being deleted).
//
// A count that says more links than the account has (left by a deletion
// cut short before deletions were marked, which took the link but not the
// count) is put right, once, and the link made after all.
func (s *Store) CreateLink(ctx context.Context, accountID string, l Link, max int) error {
	claim, _, err := s.claimKey(ctx, accountID, devicesig.Fingerprint(l.SigningKey))
	if err != nil {
		return err
	}
	err = s.createLink(ctx, accountID, l, max, claim)
	if errors.Is(err, ErrLimit) {
		if fixed, ferr := s.recountLinks(ctx, accountID); ferr != nil {
			return ferr
		} else if fixed {
			err = s.createLink(ctx, accountID, l, max, claim)
		}
	}
	return err
}

func (s *Store) createLink(ctx context.Context, accountID string, l Link, max int, claim []types.TransactWriteItem) error {
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
	writes = append(writes, claim...)
	reasons, err := s.transactReasons(ctx, writes)
	if errors.Is(err, ErrConflict) && len(reasons) == len(writes) && reasons[2] == "ConditionalCheckFailed" {
		return ErrLimit
	}
	return err
}

// linkChange marks a change to an account's links (lq), in the same write
// as the change: create, replace and revoke all do, and so do recountLinks,
// MarkDeleting, and a rotation that records its link's signing key
// (SetLinkKeys). It is a fresh random value each time (newLinkChange,
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

// newLinkWrites stores a link's bundle and lists it under its account, with
// its signing key's fingerprint (whose item goes with the listing).
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
		{Put: &types.Put{TableName: &s.Table, Item: linkRecord(accountID, l.ID, l.SigningKey)}},
	}
}

// linkRecord is an account's record of a link it owns, noting the
// fingerprint of the link's signing key (f).
func linkRecord(accountID, linkID string, signingKey []byte) attrs {
	return item(accountPK(accountID), linkPrefix+linkID, attrs{"f": sv(devicesig.Fingerprint(signingKey))})
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
// count stays the same. The new link's signing key is recorded as the
// account's, and the old one's record goes unless the new link keeps it. It
// returns ErrNotFound unless the account (still there, neither replaced nor
// being deleted) owns oldID, ErrKeyTaken if another account's link has the
// new signing key, and ErrConflict if the new ID is taken.
func (s *Store) ReplaceLink(ctx context.Context, accountID, oldID string, l Link) error {
	if oldID == l.ID {
		return ErrConflict
	}
	old, owner, err := s.link(ctx, oldID, true)
	if err != nil {
		return err
	}
	if owner != accountID {
		return ErrNotFound
	}
	fingerprint, oldFingerprint := devicesig.Fingerprint(l.SigningKey), devicesig.Fingerprint(old.SigningKey)
	keys, _, err := s.claimKey(ctx, accountID, fingerprint)
	if err != nil {
		return err
	}
	if oldFingerprint != fingerprint {
		release, err := s.releaseKey(ctx, accountID, oldFingerprint)
		if err != nil {
			return err
		}
		keys = append(keys, release...)
	}
	writes := append(s.oldLinkWrites(accountID, old), s.newLinkWrites(accountID, l)...)
	writes = append(writes, s.introMailboxWrites(accountID, l.ID, l.Mailbox)...)
	writes = append(writes, keys...)
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
	l, _, err := s.link(ctx, id, true)
	return l, err
}

// Bundle is Link for anyone who opens the link, eventually consistent at
// half the cost: a link made or revoked in about the last second may not
// show yet. Sends through it still go by its intro mailbox, which is read
// afresh.
func (s *Store) Bundle(ctx context.Context, id string) (Link, error) {
	l, _, err := s.link(ctx, id, false)
	return l, err
}

// link reads a link's bundle, and its owner.
func (s *Store) link(ctx context.Context, id string, consistent bool) (Link, string, error) {
	it, err := s.read(ctx, linkPK(id), skLink, time.Time{}, consistent)
	if err != nil {
		return Link{}, "", err
	}
	k, ok := bin(it, "k")
	keys, okKeys := keysFrom(it["ek"])
	mailbox, okMailbox := str(it, "m")
	if !ok || !okKeys || !okMailbox {
		return Link{}, "", ErrNotFound
	}
	owner, _ := str(it, "a")
	return Link{ID: id, SigningKey: k, Keys: keys, Mailbox: mailbox}, owner, nil
}

// SetLinkKeys replaces a link's encryption keys. It returns ErrNotFound unless
// the account owns the link.
//
// A link whose signing key isn't recorded as the account's yet (one made
// before keys were recorded, or whose item an account that ended left) gets
// it recorded too, in the same transaction, as a change to the account's
// links (lq), so a deletion or replacement that read them before doesn't
// leave the item behind; ErrKeyTaken if another account has it.
func (s *Store) SetLinkKeys(ctx context.Context, accountID, id string, keys []links.Key) error {
	l, owner, err := s.link(ctx, id, true)
	if err != nil {
		return err
	}
	if owner != accountID {
		return ErrNotFound
	}
	claim, recorded, err := s.claimKey(ctx, accountID, devicesig.Fingerprint(l.SigningKey))
	if err != nil {
		return err
	}
	update := &types.Update{
		TableName:                 &s.Table,
		Key:                       key(linkPK(id), skLink),
		UpdateExpression:          aws.String("SET ek = :ek"),
		ConditionExpression:       aws.String("a = :a"),
		ExpressionAttributeValues: attrs{":ek": keysValue(keys), ":a": sv(accountID)},
	}
	if recorded {
		_, err = s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
			TableName:                 update.TableName,
			Key:                       update.Key,
			UpdateExpression:          update.UpdateExpression,
			ConditionExpression:       update.ConditionExpression,
			ExpressionAttributeValues: update.ExpressionAttributeValues,
		})
		var failed *types.ConditionalCheckFailedException
		if errors.As(err, &failed) {
			return ErrNotFound
		}
		return err
	}
	writes := append([]types.TransactWriteItem{{Update: update}}, claim...)
	writes = append(writes,
		types.TransactWriteItem{Put: &types.Put{TableName: &s.Table, Item: linkRecord(accountID, id, l.SigningKey)}},
		types.TransactWriteItem{Update: &types.Update{
			TableName:                 &s.Table,
			Key:                       key(accountPK(accountID), skAccount),
			UpdateExpression:          aws.String("SET " + linkChange),
			ConditionExpression:       aws.String(live),
			ExpressionAttributeValues: attrs{":lq": newLinkChange()},
		}},
	)
	reasons, err := s.transactReasons(ctx, writes)
	if errors.Is(err, ErrConflict) && len(reasons) == len(writes) &&
		(reasons[0] == "ConditionalCheckFailed" || reasons[len(reasons)-1] == "ConditionalCheckFailed") {
		return ErrNotFound
	}
	return err
}

// DeleteLink revokes a link and its intro mailbox, and the record of its
// signing key. It returns ErrNotFound unless the account owns it.
func (s *Store) DeleteLink(ctx context.Context, accountID, id string) error {
	l, owner, err := s.link(ctx, id, true)
	if err != nil {
		return err
	}
	if owner != accountID {
		return ErrNotFound
	}
	release, err := s.releaseKey(ctx, accountID, devicesig.Fingerprint(l.SigningKey))
	if err != nil {
		return err
	}
	writes := append(s.oldLinkWrites(accountID, l), release...)
	writes = append(writes, types.TransactWriteItem{Update: &types.Update{
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
