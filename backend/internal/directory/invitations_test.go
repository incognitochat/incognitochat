package directory

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
	"github.com/incognitochat/incognitochat/backend/internal/links"
)

func TestLevels(t *testing.T) {
	s, _ := store(t)
	ctx := context.Background()
	if levels, err := s.Levels(ctx); err != nil || len(levels) != 0 {
		t.Fatalf("Levels = %v, %v", levels, err)
	}
	if err := s.SetLevel(ctx, 1, 5); err != nil {
		t.Fatal(err)
	}
	if err := s.SetLevel(ctx, 2, 3); err != nil {
		t.Fatal(err)
	}
	if err := s.SetLevel(ctx, 1, 4); err != nil {
		t.Fatal(err)
	}
	if levels, err := s.Levels(ctx); err != nil || len(levels) != 2 || levels[1] != 4 || levels[2] != 3 {
		t.Fatalf("Levels = %v, %v", levels, err)
	}
}

func TestInvitations(t *testing.T) {
	s, _ := store(t)
	ctx := context.Background()
	admin := registered(t, s)
	alice := registered(t, s)
	bob := registered(t, s)
	carol := registered(t, s)

	// An admin's code makes level-1 members.
	if err := s.CreateInvitation(ctx, admin.ID, "abcd-efgh", 2, 0, -1); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateInvitation(ctx, alice.ID, "abcd-efgh", 1, 0, -1); !errors.Is(err, ErrConflict) {
		t.Fatalf("taken code: %v", err)
	}
	if list, err := s.Invitations(ctx, admin.ID); err != nil || len(list) != 1 || list[0] != (Invitation{Code: "abcd-efgh", Uses: 2, Left: 2}) {
		t.Fatalf("Invitations = %+v, %v", list, err)
	}
	// Not by the account that made it, and that uses nothing up.
	if _, err := s.Redeem(ctx, admin.ID, "abcd-efgh"); !errors.Is(err, ErrOwnInvitation) {
		t.Fatalf("own code: %v", err)
	}
	if list, _ := s.Invitations(ctx, admin.ID); list[0].Left != 2 {
		t.Fatalf("own redeem used the code: %+v", list)
	}
	if level, err := s.Redeem(ctx, alice.ID, "abcd-efgh"); err != nil || level != 1 {
		t.Fatalf("Redeem = %d, %v", level, err)
	}
	if _, err := s.Redeem(ctx, alice.ID, "abcd-efgh"); !errors.Is(err, ErrAlreadyMember) {
		t.Fatalf("second redeem: %v", err)
	}
	if _, err := s.Redeem(ctx, bob.ID, "abcd-efgh"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Redeem(ctx, carol.ID, "abcd-efgh"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("used-up code: %v", err)
	}
	if _, err := s.Redeem(ctx, carol.ID, "zzzz-zzzz"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown code: %v", err)
	}
	if list, _ := s.Invitations(ctx, admin.ID); list[0].Left != 0 {
		t.Fatalf("uses left = %d", list[0].Left)
	}
	dev, _ := s.Device(ctx, alice.ID, alice.DeviceID, now)
	if !dev.Member || dev.Level != 1 {
		t.Fatalf("alice = %+v", dev)
	}

	// A member spends from their allowance (here 2): codes for 2 uses, then no more.
	if err := s.CreateInvitation(ctx, alice.ID, "aaaa-aaaa", 2, 1, 2); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateInvitation(ctx, alice.ID, "bbbb-bbbb", 1, 1, 2); !errors.Is(err, ErrLimit) {
		t.Fatalf("over allowance: %v", err)
	}
	if level, err := s.Redeem(ctx, carol.ID, "aaaa-aaaa"); err != nil || level != 2 {
		t.Fatalf("level-2 redeem = %d, %v", level, err)
	}
	// Non-members have no allowance at all.
	if err := s.CreateInvitation(ctx, admin.ID, "cccc-cccc", 1, 0, 5); !errors.Is(err, ErrLimit) {
		t.Fatalf("non-member with an allowance: %v", err)
	}
}

// Listing an account's codes is one eventually consistent query, half a
// read unit for many of them, whatever their number: each code's entry
// keeps its uses, which redeeming keeps up. A code made before entries kept
// them is read from its own item, and redeemed as before.
func TestInvitationsListCost(t *testing.T) {
	client := dynamotest.Client(t)
	meter := dynamotest.NewMeter(client)
	s := &Store{DB: meter, Table: dynamotest.Table(t, client)}
	ctx := context.Background()
	admin := registered(t, s)
	bob := registered(t, s)
	for i := range 20 {
		if err := s.CreateInvitation(ctx, admin.ID, fmt.Sprintf("aaaa-%04d", i), 3, 0, -1); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Redeem(ctx, bob.ID, "aaaa-0007"); err != nil {
		t.Fatal(err)
	}
	meter.Reset()
	list, err := s.Invitations(ctx, admin.ID)
	if err != nil || len(list) != 20 || list[7] != (Invitation{Code: "aaaa-0007", Uses: 3, Left: 2}) || list[8].Left != 3 {
		t.Fatalf("Invitations = %+v, %v", list, err)
	}
	if u := meter.Units(s.Table); u.Read > 0.5 || !slices.Equal(meter.Calls(), []string{"Query " + s.Table}) {
		t.Fatalf("listing 20 codes read %v in %v", u.Read, meter.Calls())
	}

	// A code from before: its entry holds nothing but its name.
	carol := registered(t, s)
	if err := s.CreateInvitation(ctx, admin.ID, "bbbb-bbbb", 2, 0, -1); err != nil {
		t.Fatal(err)
	}
	for _, k := range []map[string]types.AttributeValue{key(accountPK(admin.ID), codePrefix+"bbbbbbbb"), key(codePK("bbbbbbbb"), skCode)} {
		if _, err := client.UpdateItem(ctx, &dynamodb.UpdateItemInput{TableName: &s.Table, Key: k, UpdateExpression: aws.String("REMOVE u, r, m")}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: &s.Table, Key: key(codePK("bbbbbbbb"), skCode),
		UpdateExpression: aws.String("SET u = :two, r = :two"), ExpressionAttributeValues: attrs{":two": nv(2)},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Redeem(ctx, carol.ID, "bbbb-bbbb"); err != nil {
		t.Fatal(err)
	}
	meter.Reset()
	list, err = s.Invitations(ctx, admin.ID)
	if err != nil || len(list) != 21 || list[20] != (Invitation{Code: "bbbb-bbbb", Uses: 2, Left: 1}) {
		t.Fatalf("Invitations = %+v, %v", list, err)
	}
	if u := meter.Units(s.Table); u.Read > 1 {
		t.Fatalf("listing with one older code read %v", u.Read)
	}
}

func TestGrant(t *testing.T) {
	s, _ := store(t)
	ctx := context.Background()
	admin := registered(t, s)
	member := registered(t, s)
	other := registered(t, s)
	if err := s.CreateInvitation(ctx, admin.ID, "abcd-efgh", 1, 0, -1); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Redeem(ctx, member.ID, "abcd-efgh"); err != nil {
		t.Fatal(err)
	}
	memberLink, otherLink := testLink(t), testLink(t)
	if err := s.CreateLink(ctx, member.ID, memberLink, links.MaxActive); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateLink(ctx, other.ID, otherLink, links.MaxActive); err != nil {
		t.Fatal(err)
	}

	if err := s.Grant(ctx, memberLink.ID, 3); err != nil {
		t.Fatal(err)
	}
	if err := s.Grant(ctx, memberLink.ID, 2); err != nil {
		t.Fatal(err)
	}
	if dev, _ := s.Device(ctx, member.ID, member.DeviceID, now); dev.Granted != 5 {
		t.Fatalf("granted = %d", dev.Granted)
	}
	if err := s.Grant(ctx, otherLink.ID, 1); !errors.Is(err, ErrNotMember) {
		t.Fatalf("grant to a non-member: %v", err)
	}
	if err := s.Grant(ctx, testLink(t).ID, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("grant through an unknown link: %v", err)
	}
}

func TestReplaceEndsCodes(t *testing.T) {
	s, _ := store(t)
	ctx := context.Background()
	first := registered(t, s)
	if err := s.CreateInvitation(ctx, first.ID, "abcd-efgh", 1, 0, -1); err != nil {
		t.Fatal(err)
	}
	old, _ := s.ByTelegram(ctx, first.TelegramHash, first.DeviceID)
	if err := s.Replace(ctx, old, newAccount(t, first.TelegramHash), now); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Redeem(ctx, registered(t, s).ID, "abcd-efgh"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("code of a replaced account: %v", err)
	}
}
