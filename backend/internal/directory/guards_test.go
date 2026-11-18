package directory

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/devicesig"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/links"
)

// One step at a time holds an account: another is refused until the first
// lets go and a second has passed, or its lease expires; a late release
// doesn't free a newer lease; once the work is done the lease goes from the
// item; an account that doesn't exist isn't leased, and nothing is made.
// (That the lease outlasts the api function is checked against its timeout
// in infra/tests.)
func TestLease(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()
	n := registered(t, s)

	release, ok, err := s.Lease(ctx, n.ID, now)
	if err != nil || !ok {
		t.Fatalf("first lease: %v, %v", ok, err)
	}
	if _, ok, err := s.Lease(ctx, n.ID, now.Add(time.Second)); err != nil || ok {
		t.Fatalf("a second step at once: %v, %v", ok, err)
	}
	if err := release(ctx, now.Add(2*time.Second), false); err != nil {
		t.Fatal(err)
	}
	// The next waits a second after the release.
	if _, ok, _ := s.Lease(ctx, n.ID, now.Add(2*time.Second+stepGap/2)); ok {
		t.Fatal("leased right after a release")
	}
	at := now.Add(2*time.Second + stepGap)
	late, ok, err := s.Lease(ctx, n.ID, at)
	if err != nil || !ok {
		t.Fatalf("after the release: %v, %v", ok, err)
	}
	// A step that dies holds it until the lease expires.
	if _, ok, _ := s.Lease(ctx, n.ID, at.Add(10*time.Second)); ok {
		t.Fatal("leased while held")
	}
	newer, ok, err := s.Lease(ctx, n.ID, at.Add(leaseFor))
	if err != nil || !ok {
		t.Fatalf("after the lease expired: %v, %v", ok, err)
	}
	if err := late(ctx, at.Add(leaseFor), true); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.Lease(ctx, n.ID, at.Add(leaseFor+stepGap)); ok {
		t.Fatal("a late release freed a newer lease")
	}
	// Done: the lease goes from the item.
	if err := newer(ctx, at.Add(leaseFor+stepGap), true); err != nil {
		t.Fatal(err)
	}
	out, err := client.GetItem(ctx, &dynamodb.GetItemInput{TableName: &s.Table, Key: key(accountPK(n.ID), skAccount)})
	if _, held := out.Item["sl"]; err != nil || held {
		t.Fatalf("the lease stayed after the work was done: %v, %v", out.Item["sl"], err)
	}
	// The account reads as before.
	if _, err := s.Device(ctx, n.ID, n.DeviceID, now); err != nil {
		t.Fatal(err)
	}

	gone := ids.New()
	if _, ok, err := s.Lease(ctx, gone, now); err != nil || ok {
		t.Fatalf("leasing no account: %v, %v", ok, err)
	}
	if out, err := client.GetItem(ctx, &dynamodb.GetItemInput{TableName: &s.Table, Key: key(accountPK(gone), skAccount)}); err != nil || out.Item != nil {
		t.Fatalf("leasing no account made %v, %v", out.Item, err)
	}

	// A transaction on the account item at the same moment: taken as held
	// (the SDK doesn't retry it).
	busy := &Store{DB: conflicting{client}, Table: s.Table}
	if _, ok, err := busy.Lease(ctx, registered(t, s).ID, now); err != nil || ok {
		t.Fatalf("lease during a transaction: %v, %v", ok, err)
	}
}

// conflicting is a table whose updates meet a transaction in progress.
type conflicting struct{ DB }

func (conflicting) UpdateItem(context.Context, *dynamodb.UpdateItemInput, ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	return nil, &types.TransactionConflictException{Message: aws.String("conflict")}
}

// A link made between reading an account's links and marking it (or
// replacing it) isn't left behind: the mark, or the swap, loses, and done
// again takes the new link too.
func TestEndingLosesToALinkMadeMeanwhile(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()

	n := registered(t, s)
	l := testLink(t)
	hooked := &Store{DB: &afterQuery{DB: client, n: 1, hook: func() {
		if err := s.CreateLink(ctx, n.ID, l, links.MaxActive); err != nil {
			t.Error(err)
		}
	}}, Table: s.Table}
	if err := hooked.MarkDeleting(ctx, n.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("marking with a link made meanwhile: %v", err)
	}
	if dev, _ := s.Device(ctx, n.ID, n.DeviceID, now); dev.Deleting {
		t.Fatal("marked anyway")
	}
	if err := s.MarkDeleting(ctx, n.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Bundle(ctx, l.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the link made meanwhile: %v", err)
	}

	first := newAccount(t, "th-r")
	if err := s.Create(ctx, first); err != nil {
		t.Fatal(err)
	}
	old, _ := s.ByTelegram(ctx, "th-r", first.DeviceID)
	late := testLink(t)
	hooked = &Store{DB: &afterQuery{DB: client, n: 2, hook: func() {
		if err := s.CreateLink(ctx, first.ID, late, links.MaxActive); err != nil {
			t.Error(err)
		}
	}}, Table: s.Table}
	if err := hooked.Replace(ctx, old, newAccount(t, "th-r"), now); !errors.Is(err, ErrConflict) {
		t.Fatalf("replacing with a link made meanwhile: %v", err)
	}
	old, _ = s.ByTelegram(ctx, "th-r", first.DeviceID)
	if err := s.Replace(ctx, old, newAccount(t, "th-r"), now); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Bundle(ctx, late.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the link made meanwhile: %v", err)
	}
}

// An account whose Telegram item names another account, or none, is still
// deleted, and the Telegram item stays as it is.
func TestDeleteWhenTheTelegramItemIsNotItsOwn(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()
	n, other := registered(t, s), registered(t, s)
	if _, err := client.PutItem(ctx, &dynamodb.PutItemInput{TableName: &s.Table, Item: item("T#"+n.TelegramHash, skTelegram, attrs{"a": sv(other.ID)})}); err != nil {
		t.Fatal(err)
	}
	for steps := 0; ; steps++ {
		if steps > 10 {
			t.Fatal("never finishes")
		}
		done, err := s.Delete(ctx, n.ID, n.TelegramHash, step)
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
	if id, err := s.AccountOf(ctx, n.TelegramHash); err != nil || id != other.ID {
		t.Fatalf("the Telegram item = %q, %v", id, err)
	}
}

// A record in an account's partition that names someone else's mailbox,
// link, code or signing key (nothing makes one, but nothing may trust it
// either) goes when the account is deleted or replaced; their item stays.
func TestStepsSpareOthersItems(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()
	victim, third := registered(t, s), registered(t, s)
	l := testLink(t)
	if err := s.CreateLink(ctx, victim.ID, l, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	box := ids.New()
	if err := s.CreateMailboxes(ctx, victim.ID, []string{box}, 10); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateInvitation(ctx, victim.ID, "abcd-efgh", 2, 0, -1); err != nil {
		t.Fatal(err)
	}
	plant := func(accountID string) {
		t.Helper()
		victimKey := keyRecordPrefix + devicesig.Fingerprint(l.SigningKey)
		for _, sk := range []string{mailboxPrefix + box, mailboxPrefix + l.Mailbox, linkPrefix + l.ID, codePrefix + "abcdefgh", victimKey} {
			if _, err := client.PutItem(ctx, &dynamodb.PutItemInput{TableName: &s.Table, Item: item(accountPK(accountID), sk, attrs{})}); err != nil {
				t.Fatal(err)
			}
		}
	}
	intact := func(how string) {
		t.Helper()
		for _, m := range []string{box, l.Mailbox} {
			if mb, err := s.Mailbox(ctx, m); err != nil || mb.Owner != victim.ID {
				t.Fatalf("%s: the victim's mailbox %s = %+v, %v", how, m, mb, err)
			}
		}
		if _, err := s.Bundle(ctx, l.ID); err != nil {
			t.Fatalf("%s: the victim's link: %v", how, err)
		}
		if _, err := s.get(ctx, codePK("abcdefgh"), skCode, time.Time{}); err != nil {
			t.Fatalf("%s: the victim's code: %v", how, err)
		}
		if got, _ := keyOwner(t, client, s.Table, l.SigningKey); got != victim.ID {
			t.Fatalf("%s: the victim's signing key's item names %q", how, got)
		}
	}

	// Deleted.
	attacker := registered(t, s)
	plant(attacker.ID)
	for steps := 0; ; steps++ {
		if steps > 20 {
			t.Fatal("never finishes")
		}
		done, err := s.Delete(ctx, attacker.ID, attacker.TelegramHash, 3)
		if err != nil {
			t.Fatal(err)
		}
		if done {
			break
		}
	}
	intact("deleting")
	if sks := partitionKeys(t, client, s.Table, attacker.ID); len(sks) != 0 {
		t.Fatalf("left behind: %v", sks)
	}

	// Replaced.
	other := newAccount(t, "th-other")
	if err := s.Create(ctx, other); err != nil {
		t.Fatal(err)
	}
	plant(other.ID)
	old, err := s.ByTelegram(ctx, "th-other", other.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	next := newAccount(t, "th-other")
	if err := s.Replace(ctx, old, next, now); err != nil {
		t.Fatal(err)
	}
	cleanUp(t, s, next.ID, other.ID)
	intact("replacing")
	if _, err := s.Redeem(ctx, third.ID, "abcd-efgh"); err != nil {
		t.Fatalf("redeeming the victim's code: %v", err)
	}
}

// Repairing a stale link count can't let a second link in: a link made
// between reading the links and writing the count (which then reads as it
// did) wins.
func TestRecountLosesToALinkMadeMeanwhile(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()
	n := registered(t, s)
	l := testLink(t)
	if err := s.CreateLink(ctx, n.ID, l, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	for _, k := range []map[string]types.AttributeValue{
		key(linkPK(l.ID), skLink), key(accountPK(n.ID), linkPrefix+l.ID),
		key(mailboxPK(l.Mailbox), skMailbox), key(accountPK(n.ID), mailboxPrefix+l.Mailbox),
	} {
		if _, err := client.DeleteItem(ctx, &dynamodb.DeleteItemInput{TableName: &s.Table, Key: k}); err != nil {
			t.Fatal(err)
		}
	}
	// Right after this one counts the links (none), another request
	// repairs the count and makes a link, which puts the count back at 1.
	meanwhile := testLink(t)
	hooked := &Store{DB: &afterQuery{DB: client, n: 1, hook: func() {
		if err := s.CreateLink(ctx, n.ID, meanwhile, links.MaxActive); err != nil {
			t.Error(err)
		}
	}}, Table: s.Table}
	if err := hooked.CreateLink(ctx, n.ID, testLink(t), links.MaxActive); !errors.Is(err, ErrLimit) {
		t.Fatalf("the second link: %v", err)
	}
	if got := len(partitionKeysWith(t, client, s.Table, n.ID, linkPrefix)); got != 1 {
		t.Fatalf("%d links", got)
	}
	if dev, _ := s.Device(ctx, n.ID, n.DeviceID, now); dev.Links != 1 {
		t.Fatalf("links counted = %d", dev.Links)
	}
}

// partitionKeysWith is partitionKeys, those that start with prefix.
func partitionKeysWith(t *testing.T, client *dynamodb.Client, table, accountID, prefix string) []string {
	t.Helper()
	var out []string
	for _, sk := range partitionKeys(t, client, table, accountID) {
		if strings.HasPrefix(sk, prefix) {
			out = append(out, sk)
		}
	}
	return out
}

// Deleting an account doesn't finish while something of an account it
// replaced is left (deleting its item would forget it): the last step
// waits, and isn't taken for "gone".
func TestDeleteWaitsForLeftovers(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()
	first := newAccount(t, "th-1")
	if err := s.Create(ctx, first); err != nil {
		t.Fatal(err)
	}
	grow(t, client, s.Table, first.ID, 10)
	old, _ := s.ByTelegram(ctx, "th-1", first.DeviceID)
	second := newAccount(t, "th-1")
	if err := s.Replace(ctx, old, second, now); err != nil {
		t.Fatal(err)
	}
	for range 5 {
		done, err := s.Delete(ctx, second.ID, second.TelegramHash, step)
		if err != nil || done {
			t.Fatalf("delete with leftovers: %v, %v", done, err)
		}
	}
	if dev, err := s.Device(ctx, second.ID, second.DeviceID, now); err != nil || !dev.Deleting || len(dev.Leftovers) != 1 {
		t.Fatalf("device = %+v, %v", dev, err)
	}
	cleanUp(t, s, second.ID, first.ID)
	if done, err := s.Delete(ctx, second.ID, second.TelegramHash, step); err != nil || !done {
		t.Fatalf("delete after the cleanup: %v, %v", done, err)
	}
	if sks := partitionKeys(t, client, s.Table, second.ID); len(sks) != 0 {
		t.Fatalf("left behind: %v", sks)
	}
	if _, err := s.AccountOf(ctx, "th-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("telegram item: %v", err)
	}
}

// Replacing an account being deleted keeps no marker, as its deletion
// wouldn't have: its item and devices go in the swap (its device is then
// refused like a deleted account's, not told it was replaced), and the rest
// with the new account's cleanup, leaving nothing.
func TestReplaceAnAccountBeingDeleted(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()
	first := newAccount(t, "th-1")
	if err := s.Create(ctx, first); err != nil {
		t.Fatal(err)
	}
	boxes := grow(t, client, s.Table, first.ID, 30)
	if err := s.MarkDeleting(ctx, first.ID); err != nil {
		t.Fatal(err)
	}
	old, err := s.ByTelegram(ctx, "th-1", first.DeviceID)
	if err != nil || !old.Deleting {
		t.Fatalf("ByTelegram = %+v, %v", old, err)
	}
	second := newAccount(t, "th-1")
	if err := s.Replace(ctx, old, second, now); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Device(ctx, first.ID, first.DeviceID, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the old device: %v", err)
	}
	if devices, err := s.Recipients(ctx, first.ID, now); err != nil || len(devices) != 0 {
		t.Fatalf("the old account's mailboxes deliver to %v, %v", devices, err)
	}
	if dev, err := s.Device(ctx, second.ID, second.DeviceID, now); err != nil || len(dev.Leftovers) != 1 || dev.Leftovers[0] != first.ID {
		t.Fatalf("new device = %+v, %v", dev, err)
	}
	cleanUp(t, s, second.ID, first.ID)
	if sks := partitionKeys(t, client, s.Table, first.ID); len(sks) != 0 {
		t.Fatalf("left of the old account: %v", sks)
	}
	if _, err := s.Mailbox(ctx, boxes[0]); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an old mailbox: %v", err)
	}
}
