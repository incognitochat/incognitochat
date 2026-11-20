package directory

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/links"
)

func linkID() string {
	return base64.RawURLEncoding.EncodeToString([]byte(ids.New())[:8])
}

func testLink(t *testing.T) Link {
	return Link{
		ID:         linkID(),
		SigningKey: publicKey(t),
		Keys: []links.Key{{
			Key:       publicKey(t),
			From:      now,
			Until:     now.Add(28 * 24 * time.Hour),
			Signature: bytes.Repeat([]byte{7}, 64),
		}},
		Mailbox: ids.New(),
	}
}

// withID is a new link (keys, intro mailbox) with the given ID.
func withID(t *testing.T, id string) Link {
	l := testLink(t)
	l.ID = id
	return l
}

func registered(t *testing.T, s *Store) NewAccount {
	t.Helper()
	n := newAccount(t, "th-"+ids.New())
	if err := s.Create(context.Background(), n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestLinks(t *testing.T) {
	s, _ := store(t)
	ctx := context.Background()
	owner := registered(t, s)
	other := registered(t, s)

	l := testLink(t)
	if err := s.CreateLink(ctx, owner.ID, l, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	got, err := s.Link(ctx, l.ID)
	if err != nil || !bytes.Equal(got.SigningKey, l.SigningKey) || len(got.Keys) != 1 || got.Mailbox != l.Mailbox ||
		!got.Keys[0].Until.Equal(l.Keys[0].Until) || !bytes.Equal(got.Keys[0].Signature, l.Keys[0].Signature) {
		t.Fatalf("Link = %+v, %v", got, err)
	}
	if err := s.CreateLink(ctx, other.ID, Link{ID: l.ID, SigningKey: publicKey(t), Keys: l.Keys, Mailbox: ids.New()}, links.MaxActive); !errors.Is(err, ErrConflict) {
		t.Fatalf("taken ID: %v", err)
	}
	if dev, _ := s.Device(ctx, owner.ID, owner.DeviceID, now); dev.Links != 1 || dev.TelegramHash != owner.TelegramHash || dev.Member {
		t.Fatalf("Device = %+v", dev)
	}

	// Only the owner can change or revoke it.
	if err := s.SetLinkKeys(ctx, other.ID, l.ID, l.Keys); !errors.Is(err, ErrNotFound) {
		t.Fatalf("SetLinkKeys by another account: %v", err)
	}
	if err := s.DeleteLink(ctx, other.ID, l.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("DeleteLink by another account: %v", err)
	}
	rotated := testLink(t).Keys
	if err := s.SetLinkKeys(ctx, owner.ID, l.ID, rotated); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Link(ctx, l.ID); !bytes.Equal(got.Keys[0].Key, rotated[0].Key) {
		t.Fatal("keys not replaced")
	}

	if err := s.DeleteLink(ctx, owner.ID, l.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Link(ctx, l.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoked link: %v", err)
	}
	if err := s.DeleteLink(ctx, owner.ID, l.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second revoke: %v", err)
	}
	if dev, _ := s.Device(ctx, owner.ID, owner.DeviceID, now); dev.Links != 0 {
		t.Fatalf("count after revoke = %d", dev.Links)
	}
}

func TestLinkLimit(t *testing.T) {
	s, _ := store(t)
	ctx := context.Background()
	owner := registered(t, s)
	for i := range links.MaxActive {
		if err := s.CreateLink(ctx, owner.ID, testLink(t), links.MaxActive); err != nil {
			t.Fatalf("link %d: %v", i+1, err)
		}
	}
	if err := s.CreateLink(ctx, owner.ID, testLink(t), links.MaxActive); !errors.Is(err, ErrLimit) {
		t.Fatalf("over the limit: %v", err)
	}
	if err := s.CreateLink(ctx, ids.New(), testLink(t), links.MaxActive); !errors.Is(err, ErrLimit) {
		t.Fatalf("unknown account: %v", err)
	}
}

func TestReplaceRevokesLinks(t *testing.T) {
	s, _ := store(t)
	ctx := context.Background()
	first := registered(t, s)
	l := testLink(t)
	if err := s.CreateLink(ctx, first.ID, l, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	old, err := s.ByTelegram(ctx, first.TelegramHash, first.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	next := newAccount(t, first.TelegramHash)
	if err := s.Replace(ctx, old, next, now); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Link(ctx, l.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("link of a replaced account: %v", err)
	}
	// Its ID stays taken, by a tombstone: not even the new account gets it.
	linkGone(t, s, l.ID)
	if err := s.CreateLink(ctx, next.ID, withID(t, l.ID), links.MaxActive); !errors.Is(err, ErrConflict) {
		t.Fatalf("the replaced account's link ID: %v", err)
	}
}

// linkGone fails unless a link's item is its tombstone: its key, nothing
// that names an account, a key or a mailbox.
func linkGone(t *testing.T, s *Store, id string) {
	t.Helper()
	out, err := s.DB.GetItem(context.Background(), &dynamodb.GetItemInput{
		TableName:      &s.Table,
		Key:            key(linkPK(id), skLink),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !tombstone(out.Item) {
		t.Fatalf("link %s: %v, not a tombstone", id, out.Item)
	}
}

// A link ID is the client's choice. Once its link goes, revoked or
// replaced, a tombstone keeps it, for good: nobody can make a link with it
// again (DIR-6), so people who open the old link are told it's gone rather
// than given someone else's keys. Everything that reads links takes the
// tombstone for no link.
func TestDeletedLinkIDsStayTaken(t *testing.T) {
	s, _ := store(t)
	ctx := context.Background()
	owner := registered(t, s)
	other := registered(t, s)

	revoked := testLink(t)
	if err := s.CreateLink(ctx, owner.ID, revoked, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteLink(ctx, owner.ID, revoked.ID); err != nil {
		t.Fatal(err)
	}
	linkGone(t, s, revoked.ID)
	if _, err := s.Link(ctx, revoked.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Link: %v", err)
	}
	if _, err := s.Bundle(ctx, revoked.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Bundle: %v", err)
	}
	if err := s.SetLinkKeys(ctx, owner.ID, revoked.ID, revoked.Keys); !errors.Is(err, ErrNotFound) {
		t.Fatalf("SetLinkKeys: %v", err)
	}
	if err := s.DeleteLink(ctx, owner.ID, revoked.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("DeleteLink again: %v", err)
	}
	if err := s.ReplaceLink(ctx, owner.ID, revoked.ID, testLink(t)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ReplaceLink of it: %v", err)
	}
	if err := s.Grant(ctx, revoked.ID, 3); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Grant: %v", err)
	}
	// Taken as a taken ID is, for anyone, its owner too.
	for who, id := range map[string]string{"another account": other.ID, "its owner": owner.ID} {
		if err := s.CreateLink(ctx, id, withID(t, revoked.ID), links.MaxActive); !errors.Is(err, ErrConflict) {
			t.Fatalf("%s makes a link with a revoked ID: %v", who, err)
		}
	}

	// Replaced: the old ID likewise.
	old := testLink(t)
	if err := s.CreateLink(ctx, owner.ID, old, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	next := testLink(t)
	if err := s.ReplaceLink(ctx, owner.ID, old.ID, next); err != nil {
		t.Fatal(err)
	}
	linkGone(t, s, old.ID)
	if err := s.CreateLink(ctx, other.ID, withID(t, old.ID), links.MaxActive); !errors.Is(err, ErrConflict) {
		t.Fatalf("another account makes a link with a replaced ID: %v", err)
	}
	if err := s.ReplaceLink(ctx, owner.ID, next.ID, withID(t, revoked.ID)); !errors.Is(err, ErrConflict) {
		t.Fatalf("replacing a link with a revoked ID: %v", err)
	}
	// The refusals changed nothing: one link, and it works.
	if dev, _ := s.Device(ctx, owner.ID, owner.DeviceID, now); dev.Links != 1 {
		t.Fatalf("links = %d", dev.Links)
	}
	if got, err := s.Link(ctx, next.ID); err != nil || got.Mailbox != next.Mailbox {
		t.Fatalf("the new link: %+v, %v", got, err)
	}
}

// A deletion's steps that find a link the first write didn't end (one cut
// short before links were ended with it, say) leave its tombstone too.
func TestStepsLeaveLinkTombstones(t *testing.T) {
	s, _ := store(t)
	ctx := context.Background()
	n := registered(t, s)
	other := registered(t, s)
	l := testLink(t)
	if err := s.CreateLink(ctx, n.ID, l, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	if more, err := s.endSome(ctx, n.ID, step); err != nil || more {
		t.Fatalf("endSome: %v %v", more, err)
	}
	linkGone(t, s, l.ID)
	if err := s.CreateLink(ctx, other.ID, withID(t, l.ID), links.MaxActive); !errors.Is(err, ErrConflict) {
		t.Fatalf("another account takes its ID: %v", err)
	}
}

func TestReplaceLink(t *testing.T) {
	s, _ := store(t)
	ctx := context.Background()
	owner := registered(t, s)
	other := registered(t, s)
	old := testLink(t)
	if err := s.CreateLink(ctx, owner.ID, old, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	next := testLink(t)
	next.SigningKey = old.SigningKey // the same identity, a new address
	if err := s.ReplaceLink(ctx, other.ID, old.ID, next); !errors.Is(err, ErrNotFound) {
		t.Fatalf("someone else's link: %v", err)
	}
	if err := s.ReplaceLink(ctx, owner.ID, old.ID, next); err != nil {
		t.Fatal(err)
	}
	// The old link and its intro mailbox are gone; the new one works.
	if _, err := s.Link(ctx, old.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old link: %v", err)
	}
	if _, err := s.Mailbox(ctx, old.Mailbox); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old intro mailbox: %v", err)
	}
	got, err := s.Link(ctx, next.ID)
	if err != nil || got.Mailbox != next.Mailbox {
		t.Fatalf("new link: %+v, %v", got, err)
	}
	if mb, err := s.Mailbox(ctx, next.Mailbox); err != nil || mb.Owner != owner.ID || mb.Link != next.ID {
		t.Fatalf("new intro mailbox: %+v, %v", mb, err)
	}
	// Still one link, so another can't be added next to it.
	if dev, _ := s.Device(ctx, owner.ID, owner.DeviceID, now); dev.Links != 1 {
		t.Fatalf("count = %d", dev.Links)
	}
	if err := s.CreateLink(ctx, owner.ID, testLink(t), links.MaxActive); !errors.Is(err, ErrLimit) {
		t.Fatalf("second link: %v", err)
	}
	// Replacing a link that's gone, or with a taken ID.
	if err := s.ReplaceLink(ctx, owner.ID, old.ID, testLink(t)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("replacing a gone link: %v", err)
	}
	taken := testLink(t)
	taken.ID = next.ID
	if err := s.ReplaceLink(ctx, owner.ID, next.ID, taken); !errors.Is(err, ErrConflict) {
		t.Fatalf("same ID: %v", err)
	}
}
