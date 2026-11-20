package directory

import (
	"context"
	"errors"
	"strconv"
	"strings"
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
	// keyRecordPrefix starts the sort key of an account's record of a
	// signing key it has, by the key's fingerprint.
	keyRecordPrefix = "F#"
)

var (
	// ErrLimit is returned when an account already has the most links allowed.
	ErrLimit = errors.New("directory: limit reached")
	// ErrKeyTaken is returned when another account has the signing key a
	// link is to have, or had it (claimKey).
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

// Link IDs are the client's choice, so a link that goes (revoked, replaced,
// or with its account) leaves a tombstone: its item stripped to its ID, with
// no owner, keys or mailbox, that never expires. A new link is put only
// where there is no item (attribute_not_exists), so nobody can take up the
// ID later: people opening the old link would get another account's keys,
// and a warning that someone may be intercepting their messages, instead
// of being told the link is gone. Whatever reads a link takes a tombstone
// for none (link: no signing key; Grant and endLinks: no owner).

// endLinkWrite turns a link into its tombstone, only while accountID owns it.
func (s *Store) endLinkWrite(accountID, id string) types.TransactWriteItem {
	return types.TransactWriteItem{Put: &types.Put{
		TableName:                 &s.Table,
		Item:                      item(linkPK(id), skLink, attrs{}),
		ConditionExpression:       aws.String("a = :a"),
		ExpressionAttributeValues: attrs{":a": sv(accountID)},
	}}
}

// Signing keys. A sender's tag is the same on every link with one signing
// key (docs/protocol.md, the tag field), so two accounts whose links shared
// a key could compare the tags they get and match a sender who writes to
// both. So a signing key is given to one account, for good:
//
//	F#<fingerprint>  F                the account that has the key (a); none once it ended
//	A#<account>      F#<fingerprint>  marks a signing key the account has
//
// The account claims the key in the same transaction that gives it a link
// with it (claimKey: creating, replacing, and rotating a link from before
// keys were claimed), which the API allows only with an owner proof
// (links.CheckOwner), so only whoever holds the private key can claim it.
// The same account may use it again at any time (a replacement keeps it,
// and a revoked link's key stays the account's for its next link). Another
// account never gets it (ErrKeyTaken): not while the account has it, and
// not after the account ends, when the item loses the account (endKeys, in
// the write that ends it, and the steps after) and stays as a tombstone
// that holds only the fingerprint, refusing every claim. So a key can't
// pass from one account to another over time either. Only the account's
// own writes change the item, and only when it ends.
//
// While the account's link has the key, the item names nothing the link
// item doesn't (its owner, and its signing key, whose fingerprint anyone
// can work out); after a revocation it keeps the account's claim, and
// after the account ends, only that the key was used.
//
// Links made before keys were claimed have no item until their account
// rotates their keys (SetLinkKeys) or replaces them, which claims it.

// keyPK is the partition key of a signing key's item, by its fingerprint.
func keyPK(fingerprint string) string { return "F#" + fingerprint }

// claimKey returns the transaction items that claim a signing key, by its
// fingerprint, for accountID, to go with the write that gives the account a
// link with it, and whether the key is accountID's already (then the item
// only checks that it still is). It returns ErrKeyTaken if another account
// has the key, or had it and ended.
func (s *Store) claimKey(ctx context.Context, accountID, fingerprint string) ([]types.TransactWriteItem, bool, error) {
	it, err := s.get(ctx, keyPK(fingerprint), skKey, time.Time{})
	if errors.Is(err, ErrNotFound) {
		return []types.TransactWriteItem{
			{Put: &types.Put{
				TableName:           &s.Table,
				Item:                item(keyPK(fingerprint), skKey, attrs{"a": sv(accountID)}),
				ConditionExpression: aws.String("attribute_not_exists(pk)"),
			}},
			{Put: &types.Put{TableName: &s.Table, Item: item(accountPK(accountID), keyRecordPrefix+fingerprint, attrs{})}},
		}, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if owner, _ := str(it, "a"); owner != accountID {
		return nil, false, ErrKeyTaken
	}
	return []types.TransactWriteItem{{ConditionCheck: &types.ConditionCheck{
		TableName:                 &s.Table,
		Key:                       key(keyPK(fingerprint), skKey),
		ConditionExpression:       aws.String("a = :a"),
		ExpressionAttributeValues: attrs{":a": sv(accountID)},
	}}}, true, nil
}

// endKeys returns the transaction items that end an account's claims on its
// signing keys, for the write that ends the account: the keys of the links
// that write ends (their fingerprints, first), and up to maxSwapLinks more
// (the steps take any others). Each key's item the account has becomes a
// tombstone, only while it still has it, and the account's record of the
// key goes. A key the account doesn't have keeps its item (another
// account's, or none: a link from before keys were claimed), and a record
// of it (which nothing makes) goes all the same.
func (s *Store) endKeys(ctx context.Context, accountID string, first []string) ([]types.TransactWriteItem, error) {
	pk := accountPK(accountID)
	records, err := s.query(ctx, pk, "begins_with(sk, :v)", keyRecordPrefix, "sk", maxSwapLinks)
	if err != nil {
		return nil, err
	}
	recorded := map[string]bool{}
	fingerprints := first
	for _, r := range records.items {
		sk, _ := str(r, "sk")
		fingerprint := strings.TrimPrefix(sk, keyRecordPrefix)
		recorded[fingerprint] = true
		fingerprints = append(fingerprints, fingerprint)
	}
	var writes []types.TransactWriteItem
	seen := map[string]bool{}
	for _, fingerprint := range fingerprints {
		if seen[fingerprint] {
			continue // a transaction takes each item once
		}
		seen[fingerprint] = true
		it, err := s.get(ctx, keyPK(fingerprint), skKey, time.Time{})
		if err != nil && !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		owner, _ := str(it, "a")
		if owner == accountID {
			writes = append(writes, types.TransactWriteItem{Put: &types.Put{
				TableName:                 &s.Table,
				Item:                      item(keyPK(fingerprint), skKey, attrs{}),
				ConditionExpression:       aws.String("a = :a"),
				ExpressionAttributeValues: attrs{":a": sv(accountID)},
			}})
		}
		if owner == accountID || recorded[fingerprint] {
			writes = append(writes, types.TransactWriteItem{Delete: &types.Delete{TableName: &s.Table, Key: key(pk, keyRecordPrefix+fingerprint)}})
		}
	}
	return writes, nil
}

// CreateLink stores a new link for an account, counting it against max. It
// returns ErrConflict if the link ID is taken (or was: a tombstone),
// ErrKeyTaken if another account's link has its signing key, and ErrLimit
// if the account has max links already (or no longer exists, or is being
// deleted).
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

// oldLinkWrites ends an account's link, leaving its tombstone, and deletes
// its listing and its intro mailbox. The first write fails its condition
// unless the account owns the link.
func (s *Store) oldLinkWrites(accountID string, old Link) []types.TransactWriteItem {
	return []types.TransactWriteItem{
		s.endLinkWrite(accountID, old.ID),
		{Delete: &types.Delete{TableName: &s.Table, Key: key(accountPK(accountID), linkPrefix+old.ID)}},
		{Delete: &types.Delete{TableName: &s.Table, Key: key(mailboxPK(old.Mailbox), skMailbox)}},
		{Delete: &types.Delete{TableName: &s.Table, Key: key(accountPK(accountID), mailboxPrefix+old.Mailbox)}},
	}
}

// ReplaceLink swaps an account's link for a new one in one step: the old
// link and its intro mailbox go, the new one takes its place, and the link
// count stays the same. The new link's signing key is claimed for the
// account; the old one's stays the account's, and the old ID keeps its
// tombstone. It returns ErrNotFound unless the account (still there,
// neither replaced nor being deleted) owns oldID, ErrKeyTaken if another
// account has (or had) the new signing key, and ErrConflict if the new ID
// is taken (or was).
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
	claim, _, err := s.claimKey(ctx, accountID, devicesig.Fingerprint(l.SigningKey))
	if err != nil {
		return err
	}
	writes := append(s.oldLinkWrites(accountID, old), s.newLinkWrites(accountID, l)...)
	writes = append(writes, s.introMailboxWrites(accountID, l.ID, l.Mailbox)...)
	writes = append(writes, claim...)
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

// Link returns a link's bundle. Revoked and unknown links (a tombstone, or
// no item) are both ErrNotFound.
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
// the account owns the link, and ErrConflict if a concurrent change won.
//
// A link whose signing key isn't claimed yet (one made before keys were
// claimed) gets it claimed for the account in the same transaction, as a
// change to the account's links (lq), so a deletion or replacement that
// read them before doesn't leave the claim behind; ErrKeyTaken if another
// account has (or had) it.
func (s *Store) SetLinkKeys(ctx context.Context, accountID, id string, keys []links.Key) error {
	l, owner, err := s.link(ctx, id, true)
	if err != nil {
		return err
	}
	if owner != accountID {
		return ErrNotFound
	}
	claim, claimed, err := s.claimKey(ctx, accountID, devicesig.Fingerprint(l.SigningKey))
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
	if claimed {
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

// DeleteLink revokes a link and its intro mailbox; its signing key stays the
// account's, for its next link, and its ID keeps a tombstone. It returns
// ErrNotFound unless the account owns it, and ErrConflict if a concurrent
// change won.
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
