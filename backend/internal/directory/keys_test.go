package directory

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/devicesig"
	"github.com/incognitochat/incognitochat/backend/internal/links"
)

// keyOwner returns the account a signing key's item names ("" for none),
// and whether there is an item, read straight from the table.
func keyOwner(t *testing.T, client *dynamodb.Client, table string, signingKey []byte) (string, bool) {
	t.Helper()
	out, err := client.GetItem(context.Background(), &dynamodb.GetItemInput{
		TableName:      &table,
		Key:            key(keyPK(devicesig.Fingerprint(signingKey)), skKey),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		t.Fatal(err)
	}
	owner, _ := str(out.Item, "a")
	return owner, out.Item != nil
}

// burned fails unless a signing key's item is a tombstone: there, naming
// no account, with nothing but its key.
func burned(t *testing.T, client *dynamodb.Client, table string, signingKey []byte, how string) {
	t.Helper()
	out, err := client.GetItem(context.Background(), &dynamodb.GetItemInput{
		TableName:      &table,
		Key:            key(keyPK(devicesig.Fingerprint(signingKey)), skKey),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Item == nil || len(out.Item) != 2 {
		t.Fatalf("%s: the key's item is %v, not a tombstone", how, out.Item)
	}
}

// tombstone reports whether an item is a signing key's tombstone: its key
// and nothing else.
func tombstone(it map[string]types.AttributeValue) bool {
	pk, _ := str(it, "pk")
	sk, _ := str(it, "sk")
	return strings.HasPrefix(pk, keyPK("")) && sk == skKey && len(it) == 2
}

// withKey is a new link (new ID, keys, intro mailbox) with the given
// signing key.
func withKey(t *testing.T, signingKey []byte) Link {
	l := testLink(t)
	l.SigningKey = signingKey
	return l
}

// linkChangeOf is an account's lq as read ("" if it has none).
func linkChangeOf(t *testing.T, s *Store, accountID string) string {
	t.Helper()
	acct, err := s.get(context.Background(), accountPK(accountID), skAccount, now)
	if err != nil {
		t.Fatal(err)
	}
	lq, _ := acct["lq"].(*types.AttributeValueMemberS)
	if lq == nil {
		return ""
	}
	return lq.Value
}

// asBefore makes an account's link look like one made before signing keys
// were claimed: no item for its key, and no record of it.
func asBefore(t *testing.T, client *dynamodb.Client, table, accountID string, l Link) {
	t.Helper()
	ctx := context.Background()
	fingerprint := devicesig.Fingerprint(l.SigningKey)
	for _, k := range []map[string]types.AttributeValue{key(keyPK(fingerprint), skKey), key(accountPK(accountID), keyRecordPrefix+fingerprint)} {
		if _, err := client.DeleteItem(ctx, &dynamodb.DeleteItemInput{TableName: &table, Key: k}); err != nil {
			t.Fatal(err)
		}
	}
}

// A link signing key is one account's for good: another account can't make
// a link with it, or replace its own link with one that has it, so a
// sender's tag never matches across accounts, nor can a key pass from one
// account to another over time. The account itself keeps it through
// rotations and replacements, and after it revokes its link or moves to
// another key, for its next link.
func TestOneAccountPerSigningKey(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()
	owner, other := registered(t, s), registered(t, s)

	l := testLink(t)
	if err := s.CreateLink(ctx, owner.ID, l, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	if got, _ := keyOwner(t, client, s.Table, l.SigningKey); got != owner.ID {
		t.Fatalf("the key's item names %q", got)
	}
	if sks := partitionKeysWith(t, client, s.Table, owner.ID, keyRecordPrefix); len(sks) != 1 {
		t.Fatalf("the account's records of keys: %v", sks)
	}

	// Another account, with the key (shared on purpose).
	if err := s.CreateLink(ctx, other.ID, withKey(t, l.SigningKey), links.MaxActive); !errors.Is(err, ErrKeyTaken) {
		t.Fatalf("another account's link with the key: %v", err)
	}
	if dev, _ := s.Device(ctx, other.ID, other.DeviceID, now); dev.Links != 0 {
		t.Fatalf("the refused link was counted: %d", dev.Links)
	}
	own := testLink(t)
	if err := s.CreateLink(ctx, other.ID, own, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	if err := s.ReplaceLink(ctx, other.ID, own.ID, withKey(t, l.SigningKey)); !errors.Is(err, ErrKeyTaken) {
		t.Fatalf("replacing with another account's key: %v", err)
	}
	if _, err := s.Link(ctx, own.ID); err != nil {
		t.Fatalf("the link a refused replacement was for: %v", err)
	}
	// Someone else's link still answers like a missing one.
	if err := s.SetLinkKeys(ctx, other.ID, l.ID, l.Keys); !errors.Is(err, ErrNotFound) {
		t.Fatalf("rotating another account's link: %v", err)
	}

	// The owner rotates, and replaces keeping the key.
	if err := s.SetLinkKeys(ctx, owner.ID, l.ID, testLink(t).Keys); err != nil {
		t.Fatal(err)
	}
	same := withKey(t, l.SigningKey)
	if err := s.ReplaceLink(ctx, owner.ID, l.ID, same); err != nil {
		t.Fatal(err)
	}
	// Moving to another key keeps the old one the owner's.
	next := testLink(t)
	if err := s.ReplaceLink(ctx, owner.ID, same.ID, next); err != nil {
		t.Fatal(err)
	}
	for _, k := range [][]byte{l.SigningKey, next.SigningKey} {
		if got, _ := keyOwner(t, client, s.Table, k); got != owner.ID {
			t.Fatalf("after moving to another key, a key's item names %q", got)
		}
	}
	if err := s.ReplaceLink(ctx, other.ID, own.ID, withKey(t, l.SigningKey)); !errors.Is(err, ErrKeyTaken) {
		t.Fatalf("a key the owner moved away from: %v", err)
	}
	// So does a revocation, and the owner makes its next link with it.
	if err := s.DeleteLink(ctx, owner.ID, next.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateLink(ctx, registered(t, s).ID, withKey(t, next.SigningKey), links.MaxActive); !errors.Is(err, ErrKeyTaken) {
		t.Fatalf("a revoked link's key, by another account: %v", err)
	}
	if err := s.CreateLink(ctx, owner.ID, withKey(t, next.SigningKey), links.MaxActive); err != nil {
		t.Fatalf("the owner's key after a revocation: %v", err)
	}
	if sks := partitionKeysWith(t, client, s.Table, owner.ID, keyRecordPrefix); len(sks) != 2 {
		t.Fatalf("the account's records of keys: %v", sks)
	}
}

// When an account ends, the items of every signing key it has lose it and
// stay, as tombstones that refuse every account, so a key never passes to
// another account. The write that ends the account does it; the steps after
// take what that write didn't (more keys than it takes), and leave no
// record of a key behind.
func TestSigningKeysBurnWithTheAccount(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()

	for _, end := range []string{"replace", "delete"} {
		n := newAccount(t, "th-"+end)
		if err := s.Create(ctx, n); err != nil {
			t.Fatal(err)
		}
		// Keys it moved away from, and its link's.
		var keys [][]byte
		var current Link
		for i := range maxSwapLinks + 2 {
			l := testLink(t)
			if i == 0 {
				err := s.CreateLink(ctx, n.ID, l, links.MaxActive)
				if err != nil {
					t.Fatal(err)
				}
			} else if err := s.ReplaceLink(ctx, n.ID, current.ID, l); err != nil {
				t.Fatal(err)
			}
			current = l
			keys = append(keys, l.SigningKey)
		}
		var successor NewAccount
		if end == "replace" {
			old, _ := s.ByTelegram(ctx, n.TelegramHash, n.DeviceID)
			successor = newAccount(t, n.TelegramHash)
			if err := s.Replace(ctx, old, successor, now); err != nil {
				t.Fatal(err)
			}
		} else if err := s.MarkDeleting(ctx, n.ID); err != nil {
			t.Fatal(err)
		}
		// The first write took its link's key with the link, and as many
		// others as it takes; none is left to anyone meanwhile.
		burned(t, client, s.Table, current.SigningKey, end+", at once")
		// (Its link's key, and maxSwapLinks records, which may include it.)
		if got := len(partitionKeysWith(t, client, s.Table, n.ID, keyRecordPrefix)); got < len(keys)-maxSwapLinks-1 || got > len(keys)-maxSwapLinks {
			t.Fatalf("%s: %d records of keys left after the first write", end, got)
		}
		for _, k := range keys {
			if err := s.CreateLink(ctx, registered(t, s).ID, withKey(t, k), links.MaxActive); !errors.Is(err, ErrKeyTaken) {
				t.Fatalf("%s: an ended account's key: %v", end, err)
			}
		}
		if end == "replace" {
			cleanUp(t, s, successor.ID, n.ID)
		} else {
			for steps := 0; ; steps++ {
				if steps > 20 {
					t.Fatal("never finishes")
				}
				done, err := s.Delete(ctx, n.ID, n.TelegramHash, 3)
				if err != nil {
					t.Fatal(err)
				}
				if done {
					break
				}
			}
			if sks := partitionKeys(t, client, s.Table, n.ID); len(sks) != 0 {
				t.Fatalf("left behind: %v", sks)
			}
		}
		for _, k := range keys {
			burned(t, client, s.Table, k, end+", after the steps")
		}
		if shared, records := owned(t, client, s.Table, n.ID); len(shared)+len(records) != 0 {
			t.Fatalf("%s: left behind: %v, %v", end, shared, records)
		}
	}
}

// A record of a key someone else has (which nothing makes) goes when the
// account ends; their item stays theirs. One the account has, that the
// first write left (a step cut short), is burned by the next step.
func TestStepsBurnOnlyTheAccountsKeys(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()
	theirs := registered(t, s)
	taken := testLink(t)
	if err := s.CreateLink(ctx, theirs.ID, taken, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	n := registered(t, s)
	if err := s.MarkDeleting(ctx, n.ID); err != nil {
		t.Fatal(err)
	}
	mine := publicKey(t)
	for _, it := range []attrs{
		item(accountPK(n.ID), keyRecordPrefix+devicesig.Fingerprint(taken.SigningKey), attrs{}),
		item(accountPK(n.ID), keyRecordPrefix+devicesig.Fingerprint(mine), attrs{}),
		item(keyPK(devicesig.Fingerprint(mine)), skKey, attrs{"a": sv(n.ID)}),
	} {
		if _, err := client.PutItem(ctx, &dynamodb.PutItemInput{TableName: &s.Table, Item: it}); err != nil {
			t.Fatal(err)
		}
	}
	for steps := 0; ; steps++ {
		if steps > 20 {
			t.Fatal("never finishes")
		}
		done, err := s.Delete(ctx, n.ID, n.TelegramHash, 3)
		if err != nil {
			t.Fatal(err)
		}
		if done {
			break
		}
	}
	burned(t, client, s.Table, mine, "the account's key")
	if got, _ := keyOwner(t, client, s.Table, taken.SigningKey); got != theirs.ID {
		t.Fatalf("another account's key's item names %q", got)
	}
	if sks := partitionKeys(t, client, s.Table, n.ID); len(sks) != 0 {
		t.Fatalf("left behind: %v", sks)
	}
}

// Links made before signing keys were claimed get theirs claimed at their
// next rotation or replacement, as a change to the account's links. Until
// then another account holding the private key (one it shared) could claim
// it first; the earlier link then can't be rotated or replaced with it,
// but can still be revoked, and its account ended, without touching the
// other's claim. A key nobody claimed isn't burned when its account ends.
func TestEarlierLinksClaimTheirKeyLazily(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()

	// Rotated.
	n := registered(t, s)
	l := testLink(t)
	if err := s.CreateLink(ctx, n.ID, l, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	asBefore(t, client, s.Table, n.ID, l)
	before := linkChangeOf(t, s, n.ID)
	if err := s.SetLinkKeys(ctx, n.ID, l.ID, testLink(t).Keys); err != nil {
		t.Fatal(err)
	}
	if got, _ := keyOwner(t, client, s.Table, l.SigningKey); got != n.ID {
		t.Fatalf("after a rotation, the key's item names %q", got)
	}
	if after := linkChangeOf(t, s, n.ID); after == "" || after == before {
		t.Fatal("claiming the key isn't a change to the account's links")
	}
	if sks := partitionKeysWith(t, client, s.Table, n.ID, keyRecordPrefix); len(sks) != 1 {
		t.Fatalf("the account's records of keys: %v", sks)
	}
	if err := s.CreateLink(ctx, registered(t, s).ID, withKey(t, l.SigningKey), links.MaxActive); !errors.Is(err, ErrKeyTaken) {
		t.Fatalf("a rotated link's key: %v", err)
	}
	// Once claimed, a rotation only rotates.
	before = linkChangeOf(t, s, n.ID)
	if err := s.SetLinkKeys(ctx, n.ID, l.ID, testLink(t).Keys); err != nil {
		t.Fatal(err)
	}
	if linkChangeOf(t, s, n.ID) != before {
		t.Fatal("a rotation of a claimed key changed the account's links")
	}

	// Replaced.
	n = registered(t, s)
	l = testLink(t)
	if err := s.CreateLink(ctx, n.ID, l, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	asBefore(t, client, s.Table, n.ID, l)
	if err := s.ReplaceLink(ctx, n.ID, l.ID, withKey(t, l.SigningKey)); err != nil {
		t.Fatal(err)
	}
	if got, _ := keyOwner(t, client, s.Table, l.SigningKey); got != n.ID {
		t.Fatalf("after a replacement, the key's item names %q", got)
	}

	// Claimed by another account first.
	for _, end := range []string{"revoke", "delete", "replace"} {
		n := newAccount(t, "th-"+end)
		if err := s.Create(ctx, n); err != nil {
			t.Fatal(err)
		}
		l := testLink(t)
		if err := s.CreateLink(ctx, n.ID, l, links.MaxActive); err != nil {
			t.Fatal(err)
		}
		asBefore(t, client, s.Table, n.ID, l)
		other := registered(t, s)
		if err := s.CreateLink(ctx, other.ID, withKey(t, l.SigningKey), links.MaxActive); err != nil {
			t.Fatalf("a key nobody claimed: %v", err)
		}
		if err := s.SetLinkKeys(ctx, n.ID, l.ID, testLink(t).Keys); !errors.Is(err, ErrKeyTaken) {
			t.Fatalf("rotating a link whose key another account claimed: %v", err)
		}
		if err := s.ReplaceLink(ctx, n.ID, l.ID, withKey(t, l.SigningKey)); !errors.Is(err, ErrKeyTaken) {
			t.Fatalf("replacing it with that key: %v", err)
		}
		switch end {
		case "revoke":
			if err := s.DeleteLink(ctx, n.ID, l.ID); err != nil {
				t.Fatal(err)
			}
		case "delete":
			if err := s.MarkDeleting(ctx, n.ID); err != nil {
				t.Fatal(err)
			}
		case "replace":
			old, _ := s.ByTelegram(ctx, n.TelegramHash, n.DeviceID)
			if err := s.Replace(ctx, old, newAccount(t, n.TelegramHash), now); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := s.Bundle(ctx, l.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s: the link: %v", end, err)
		}
		if got, _ := keyOwner(t, client, s.Table, l.SigningKey); got != other.ID {
			t.Fatalf("%s: the other account's key's item names %q", end, got)
		}
	}

	// Nobody claimed it: the end leaves it unclaimed.
	n = registered(t, s)
	l = testLink(t)
	if err := s.CreateLink(ctx, n.ID, l, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	asBefore(t, client, s.Table, n.ID, l)
	if err := s.MarkDeleting(ctx, n.ID); err != nil {
		t.Fatal(err)
	}
	if _, there := keyOwner(t, client, s.Table, l.SigningKey); there {
		t.Fatal("an unclaimed key got an item when its account ended")
	}
}

// A rotation that claims its link's key is a change to the account's links:
// a deletion (or replacement) that read them before loses, and done again
// burns the claim too.
func TestEndingLosesToAKeyClaimedMeanwhile(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()
	n := registered(t, s)
	l := testLink(t)
	if err := s.CreateLink(ctx, n.ID, l, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	asBefore(t, client, s.Table, n.ID, l)
	hooked := &Store{DB: &afterQuery{DB: client, n: 1, hook: func() {
		if err := s.SetLinkKeys(ctx, n.ID, l.ID, testLink(t).Keys); err != nil {
			t.Error(err)
		}
	}}, Table: s.Table}
	if err := hooked.MarkDeleting(ctx, n.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("marking with a key claimed meanwhile: %v", err)
	}
	if err := s.MarkDeleting(ctx, n.ID); err != nil {
		t.Fatal(err)
	}
	burned(t, client, s.Table, l.SigningKey, "after the deletion")
}
