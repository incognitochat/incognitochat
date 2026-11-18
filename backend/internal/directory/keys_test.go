package directory

import (
	"context"
	"errors"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/devicesig"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/links"
)

// keyOwner returns the account a signing key's item names ("" if there is
// none), read straight from the table.
func keyOwner(t *testing.T, client *dynamodb.Client, table string, signingKey []byte) string {
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
	return owner
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
// were recorded: no item for its key, and a record that doesn't note it.
func asBefore(t *testing.T, client *dynamodb.Client, table, accountID string, l Link) {
	t.Helper()
	ctx := context.Background()
	if _, err := client.DeleteItem(ctx, &dynamodb.DeleteItemInput{TableName: &table, Key: key(keyPK(devicesig.Fingerprint(l.SigningKey)), skKey)}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.PutItem(ctx, &dynamodb.PutItemInput{TableName: &table, Item: item(accountPK(accountID), linkPrefix+l.ID, attrs{})}); err != nil {
		t.Fatal(err)
	}
}

// A link signing key belongs to one account: another account can't make a
// link with it, or replace its own link with one that has it, so a sender's
// tag never matches across accounts. The account itself keeps it through
// rotations and replacements; once it stops using the key (a replacement
// with another key, or a revocation), anyone can.
func TestOneAccountPerSigningKey(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()
	owner, other := registered(t, s), registered(t, s)

	l := testLink(t)
	if err := s.CreateLink(ctx, owner.ID, l, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	if got := keyOwner(t, client, s.Table, l.SigningKey); got != owner.ID {
		t.Fatalf("the key's item names %q", got)
	}

	// Another account, with a copy of the key (a modified app, or one that
	// copied a bundle).
	clone := withKey(t, l.SigningKey)
	clone.Keys = l.Keys
	if err := s.CreateLink(ctx, other.ID, clone, links.MaxActive); !errors.Is(err, ErrKeyTaken) {
		t.Fatalf("another account's link with the key: %v", err)
	}
	if _, err := s.Link(ctx, clone.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the refused link: %v", err)
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
	// Someone else's link still answers like a missing one, key or not.
	if err := s.SetLinkKeys(ctx, other.ID, l.ID, l.Keys); !errors.Is(err, ErrNotFound) {
		t.Fatalf("rotating another account's link: %v", err)
	}
	if err := s.ReplaceLink(ctx, other.ID, l.ID, withKey(t, l.SigningKey)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("replacing another account's link: %v", err)
	}

	// The owner rotates and replaces with it.
	if err := s.SetLinkKeys(ctx, owner.ID, l.ID, testLink(t).Keys); err != nil {
		t.Fatal(err)
	}
	same := withKey(t, l.SigningKey)
	if err := s.ReplaceLink(ctx, owner.ID, l.ID, same); err != nil {
		t.Fatal(err)
	}
	if got := keyOwner(t, client, s.Table, l.SigningKey); got != owner.ID {
		t.Fatalf("after a replacement keeping the key, its item names %q", got)
	}
	// A replacement with another key frees the old one.
	next := testLink(t)
	if err := s.ReplaceLink(ctx, owner.ID, same.ID, next); err != nil {
		t.Fatal(err)
	}
	if got := keyOwner(t, client, s.Table, l.SigningKey); got != "" {
		t.Fatalf("the old key's item names %q", got)
	}
	if got := keyOwner(t, client, s.Table, next.SigningKey); got != owner.ID {
		t.Fatalf("the new key's item names %q", got)
	}
	if err := s.ReplaceLink(ctx, other.ID, own.ID, withKey(t, l.SigningKey)); err != nil {
		t.Fatalf("taking up a key the owner left: %v", err)
	}
	// A revocation frees it.
	if err := s.DeleteLink(ctx, owner.ID, next.ID); err != nil {
		t.Fatal(err)
	}
	if got := keyOwner(t, client, s.Table, next.SigningKey); got != "" {
		t.Fatalf("a revoked link's key's item names %q", got)
	}
	if err := s.CreateLink(ctx, registered(t, s).ID, withKey(t, next.SigningKey), links.MaxActive); err != nil {
		t.Fatalf("taking up a revoked link's key: %v", err)
	}
	// And the owner can't come back to the key it gave up.
	if err := s.CreateLink(ctx, owner.ID, withKey(t, l.SigningKey), links.MaxActive); !errors.Is(err, ErrKeyTaken) {
		t.Fatalf("the owner's old key, now another's: %v", err)
	}
}

// An account that ends (replaced, or deleted) frees its link's signing key
// at once, in the write that ends it; the rest of its deletion leaves no
// signing key's item behind.
func TestSigningKeyGoesWithTheAccount(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()

	first := newAccount(t, "th-1")
	if err := s.Create(ctx, first); err != nil {
		t.Fatal(err)
	}
	l := testLink(t)
	if err := s.CreateLink(ctx, first.ID, l, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	old, _ := s.ByTelegram(ctx, "th-1", first.DeviceID)
	second := newAccount(t, "th-1")
	if err := s.Replace(ctx, old, second, now); err != nil {
		t.Fatal(err)
	}
	if got := keyOwner(t, client, s.Table, l.SigningKey); got != "" {
		t.Fatalf("a replaced account's key's item names %q", got)
	}
	cleanUp(t, s, second.ID, first.ID)

	deleting := registered(t, s)
	l = testLink(t)
	if err := s.CreateLink(ctx, deleting.ID, l, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkDeleting(ctx, deleting.ID); err != nil {
		t.Fatal(err)
	}
	if got := keyOwner(t, client, s.Table, l.SigningKey); got != "" {
		t.Fatalf("the key's item of an account being deleted names %q", got)
	}
	if err := s.CreateLink(ctx, registered(t, s).ID, withKey(t, l.SigningKey), links.MaxActive); err != nil {
		t.Fatalf("the key of an account being deleted: %v", err)
	}
	for steps := 0; ; steps++ {
		if steps > 20 {
			t.Fatal("never finishes")
		}
		done, err := s.Delete(ctx, deleting.ID, deleting.TelegramHash, step)
		if err != nil {
			t.Fatal(err)
		}
		if done {
			break
		}
	}
	if sks := partitionKeys(t, client, s.Table, deleting.ID); len(sks) != 0 {
		t.Fatalf("left behind: %v", sks)
	}
}

// What the first write didn't take (a record the steps find: a link past
// what that write takes, or one recorded meanwhile) goes in the steps,
// signing key's item and all, and only if it is still the account's.
func TestStepsDeleteSigningKeys(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()
	put := func(it attrs) {
		t.Helper()
		if _, err := client.PutItem(ctx, &dynamodb.PutItemInput{TableName: &s.Table, Item: it}); err != nil {
			t.Fatal(err)
		}
	}
	leftover := func(accountID string) []byte {
		t.Helper()
		k := publicKey(t)
		put(linkRecord(accountID, linkID(), k))
		put(item(keyPK(devicesig.Fingerprint(k)), skKey, attrs{"a": sv(accountID)}))
		return k
	}

	// Deleted: what the first write took, and then what the steps find.
	n := registered(t, s)
	if err := s.MarkDeleting(ctx, n.ID); err != nil {
		t.Fatal(err)
	}
	k := leftover(n.ID)
	theirs := registered(t, s)
	taken := testLink(t)
	if err := s.CreateLink(ctx, theirs.ID, taken, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	put(linkRecord(n.ID, linkID(), taken.SigningKey)) // naming another's key
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
	if got := keyOwner(t, client, s.Table, k); got != "" {
		t.Fatalf("after the deletion, the key's item names %q", got)
	}
	if got := keyOwner(t, client, s.Table, taken.SigningKey); got != theirs.ID {
		t.Fatalf("another account's key's item names %q", got)
	}

	// Replaced.
	first := newAccount(t, "th-2")
	if err := s.Create(ctx, first); err != nil {
		t.Fatal(err)
	}
	old, _ := s.ByTelegram(ctx, "th-2", first.DeviceID)
	second := newAccount(t, "th-2")
	if err := s.Replace(ctx, old, second, now); err != nil {
		t.Fatal(err)
	}
	k = leftover(first.ID)
	put(linkRecord(first.ID, linkID(), taken.SigningKey))
	cleanUp(t, s, second.ID, first.ID)
	if got := keyOwner(t, client, s.Table, k); got != "" {
		t.Fatalf("after the cleanup, the key's item names %q", got)
	}
	if got := keyOwner(t, client, s.Table, taken.SigningKey); got != theirs.ID {
		t.Fatalf("another account's key's item names %q", got)
	}
	if shared, records := owned(t, client, s.Table, first.ID); len(shared)+len(records) != 0 {
		t.Fatalf("left behind: %v, %v", shared, records)
	}
}

// An item an account left when it ended (which the write that ends it
// doesn't, unless cut across) blocks nobody: a live account takes it over.
// One a live account has still refuses.
func TestSigningKeyLeftByAnEndedAccountIsTakenOver(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()
	leave := func(owner string) []byte {
		t.Helper()
		k := publicKey(t)
		if _, err := client.PutItem(ctx, &dynamodb.PutItemInput{TableName: &s.Table, Item: item(keyPK(devicesig.Fingerprint(k)), skKey, attrs{"a": sv(owner)})}); err != nil {
			t.Fatal(err)
		}
		return k
	}

	first := newAccount(t, "th-1")
	if err := s.Create(ctx, first); err != nil {
		t.Fatal(err)
	}
	old, _ := s.ByTelegram(ctx, "th-1", first.DeviceID)
	if err := s.Replace(ctx, old, newAccount(t, "th-1"), now); err != nil {
		t.Fatal(err)
	}
	deleting := registered(t, s)
	if err := s.MarkDeleting(ctx, deleting.ID); err != nil {
		t.Fatal(err)
	}
	for _, ended := range []string{ids.New(), first.ID, deleting.ID} {
		k := leave(ended)
		n := registered(t, s)
		if err := s.CreateLink(ctx, n.ID, withKey(t, k), links.MaxActive); err != nil {
			t.Fatalf("a key %s left: %v", ended, err)
		}
		if got := keyOwner(t, client, s.Table, k); got != n.ID {
			t.Fatalf("the key's item names %q", got)
		}
	}

	live := registered(t, s)
	k := leave(live.ID)
	if err := s.CreateLink(ctx, registered(t, s).ID, withKey(t, k), links.MaxActive); !errors.Is(err, ErrKeyTaken) {
		t.Fatalf("a live account's key: %v", err)
	}
}

// Links made before signing keys were recorded get their key recorded at
// their next rotation or replacement, and from then on it is theirs alone.
// Until then another account can still take the key; the earlier link
// then can't rotate or be replaced with it, but can still be revoked, and
// its account ended, without touching the other's item.
func TestEarlierLinksGetTheirKeyRecorded(t *testing.T) {
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
	if got := keyOwner(t, client, s.Table, l.SigningKey); got != n.ID {
		t.Fatalf("after a rotation, the key's item names %q", got)
	}
	if after := linkChangeOf(t, s, n.ID); after == "" || after == before {
		t.Fatal("recording the key isn't a change to the account's links")
	}
	// Its record notes the key, so the steps would find it.
	record, err := s.get(ctx, accountPK(n.ID), linkPrefix+l.ID, now)
	if f, _ := str(record, "f"); err != nil || f != devicesig.Fingerprint(l.SigningKey) {
		t.Fatalf("the link's record = %v, %v", record, err)
	}
	if err := s.CreateLink(ctx, registered(t, s).ID, withKey(t, l.SigningKey), links.MaxActive); !errors.Is(err, ErrKeyTaken) {
		t.Fatalf("a rotated link's key: %v", err)
	}
	// Once recorded, a rotation only rotates.
	if err := s.SetLinkKeys(ctx, n.ID, l.ID, testLink(t).Keys); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkDeleting(ctx, n.ID); err != nil {
		t.Fatal(err)
	}
	if got := keyOwner(t, client, s.Table, l.SigningKey); got != "" {
		t.Fatalf("after its account's deletion, the key's item names %q", got)
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
	if got := keyOwner(t, client, s.Table, l.SigningKey); got != n.ID {
		t.Fatalf("after a replacement, the key's item names %q", got)
	}

	// Taken by another account first.
	n = registered(t, s)
	l = testLink(t)
	if err := s.CreateLink(ctx, n.ID, l, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	asBefore(t, client, s.Table, n.ID, l)
	other := registered(t, s)
	if err := s.CreateLink(ctx, other.ID, withKey(t, l.SigningKey), links.MaxActive); err != nil {
		t.Fatalf("a key no item records: %v", err)
	}
	if err := s.SetLinkKeys(ctx, n.ID, l.ID, testLink(t).Keys); !errors.Is(err, ErrKeyTaken) {
		t.Fatalf("rotating a link whose key another account recorded: %v", err)
	}
	if err := s.ReplaceLink(ctx, n.ID, l.ID, withKey(t, l.SigningKey)); !errors.Is(err, ErrKeyTaken) {
		t.Fatalf("replacing it with that key: %v", err)
	}
	if err := s.DeleteLink(ctx, n.ID, l.ID); err != nil {
		t.Fatalf("revoking it: %v", err)
	}
	if got := keyOwner(t, client, s.Table, l.SigningKey); got != other.ID {
		t.Fatalf("after the revocation, the key's item names %q", got)
	}
	for _, end := range []string{"delete", "replace"} {
		n := newAccount(t, "th-"+end)
		if err := s.Create(ctx, n); err != nil {
			t.Fatal(err)
		}
		l := withKey(t, publicKey(t))
		if err := s.CreateLink(ctx, n.ID, l, links.MaxActive); err != nil {
			t.Fatal(err)
		}
		asBefore(t, client, s.Table, n.ID, l)
		other := registered(t, s)
		if err := s.CreateLink(ctx, other.ID, withKey(t, l.SigningKey), links.MaxActive); err != nil {
			t.Fatal(err)
		}
		if end == "delete" {
			err := s.MarkDeleting(ctx, n.ID)
			if err != nil {
				t.Fatal(err)
			}
		} else {
			old, _ := s.ByTelegram(ctx, n.TelegramHash, n.DeviceID)
			if err := s.Replace(ctx, old, newAccount(t, n.TelegramHash), now); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := s.Bundle(ctx, l.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s: the link: %v", end, err)
		}
		if got := keyOwner(t, client, s.Table, l.SigningKey); got != other.ID {
			t.Fatalf("%s: the other account's key's item names %q", end, got)
		}
	}
}

// A rotation that records its link's key is a change to the account's
// links: a deletion (or replacement) that read them before loses, and done
// again deletes the item too.
func TestEndingLosesToAKeyRecordedMeanwhile(t *testing.T) {
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
		t.Fatalf("marking with a key recorded meanwhile: %v", err)
	}
	if err := s.MarkDeleting(ctx, n.ID); err != nil {
		t.Fatal(err)
	}
	if got := keyOwner(t, client, s.Table, l.SigningKey); got != "" {
		t.Fatalf("the key's item names %q", got)
	}
}

// The writes that make, replace, rotate and end links stay transactions
// DynamoDB takes when an account has as many links as Replace and
// MarkDeleting take in one go, each with its own key.
func TestEndingManyLinksWithTheirKeys(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()
	for _, end := range []string{"delete", "replace"} {
		n := newAccount(t, "th-"+end)
		if err := s.Create(ctx, n); err != nil {
			t.Fatal(err)
		}
		var made []Link
		for range maxSwapLinks {
			l := testLink(t)
			if err := s.CreateLink(ctx, n.ID, l, maxSwapLinks); err != nil {
				t.Fatal(err)
			}
			made = append(made, l)
		}
		if end == "delete" {
			if err := s.MarkDeleting(ctx, n.ID); err != nil {
				t.Fatal(err)
			}
		} else {
			old, _ := s.ByTelegram(ctx, n.TelegramHash, n.DeviceID)
			if err := s.Replace(ctx, old, newAccount(t, n.TelegramHash), now); err != nil {
				t.Fatal(err)
			}
		}
		for _, l := range made {
			if got := keyOwner(t, client, s.Table, l.SigningKey); got != "" {
				t.Fatalf("%s: a key's item names %q", end, got)
			}
		}
	}
}
