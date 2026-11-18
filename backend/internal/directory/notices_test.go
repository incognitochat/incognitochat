package directory

import (
	"bytes"
	"context"
	"errors"
	"maps"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/ids"
)

func TestNotices(t *testing.T) {
	s, _ := store(t)
	ctx := context.Background()
	a := registered(t, s)

	if _, err := s.Notices(ctx, a.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("before setup: %v", err)
	}
	if err := s.SetNotices(ctx, a.ID, []byte("sealed"), "fa"); err != nil {
		t.Fatal(err)
	}
	if err := s.NoticeSent(ctx, a.ID, 77); err != nil {
		t.Fatal(err)
	}
	on := func() bool {
		t.Helper()
		d, err := s.Device(ctx, a.ID, a.DeviceID, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		return d.Notices
	}
	if !on() {
		t.Fatal("device read says notices are off")
	}
	n, err := s.Notices(ctx, a.ID)
	if err != nil || !bytes.Equal(n.SealedChat, []byte("sealed")) || n.Language != "fa" || n.LastMessage != 77 || n.Off {
		t.Fatalf("Notices = %+v, %v", n, err)
	}
	if err := s.NoticesOff(ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.Notices(ctx, a.ID); !n.Off || on() {
		t.Fatal("notices still on")
	}
	// Setting up again turns them back on.
	if err := s.SetNotices(ctx, a.ID, []byte("sealed2"), "en"); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.Notices(ctx, a.ID); n.Off || n.Language != "en" || !on() {
		t.Fatalf("after re-enabling: %+v", n)
	}
	if err := s.SetNotices(ctx, ids.New(), []byte("x"), "en"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown account: %v", err)
	}
}

// The notify function's calls work within what its role allows (finding
// BOT-5), and an account that is gone gets nothing written.
func TestNoticesWithinNotifyRole(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()
	a := registered(t, s)
	if err := s.SetNotices(ctx, a.ID, []byte("sealed"), "fa"); err != nil {
		t.Fatal(err)
	}
	notify := &Store{DB: notifyRole{DB: client}, Table: s.Table}

	if n, err := notify.Notices(ctx, a.ID); err != nil || !bytes.Equal(n.SealedChat, []byte("sealed")) || n.Language != "fa" || n.LastMessage != 0 || n.Off {
		t.Fatalf("Notices = %+v, %v", n, err)
	}
	if err := notify.NoticeSent(ctx, a.ID, 77); err != nil {
		t.Fatal(err)
	}
	if err := notify.NoticesOff(ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	if n, err := notify.Notices(ctx, a.ID); err != nil || n.LastMessage != 77 || !n.Off {
		t.Fatalf("after writing: %+v, %v", n, err)
	}
	// The account item's other attributes are still there.
	if d, err := s.Device(ctx, a.ID, a.DeviceID, time.Now()); err != nil || d.Notices {
		t.Fatalf("device read: %+v, %v", d, err)
	}

	gone := ids.New()
	if _, err := notify.Notices(ctx, gone); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown account: %v", err)
	}
	if err := notify.NoticeSent(ctx, gone, 1); err != nil {
		t.Fatal(err)
	}
	if err := notify.NoticesOff(ctx, gone); err != nil {
		t.Fatal(err)
	}
	if out, err := client.GetItem(ctx, &dynamodb.GetItemInput{TableName: &s.Table, Key: key(accountPK(gone), skAccount)}); err != nil || out.Item != nil {
		t.Fatalf("an item was made for a gone account: %v, %v", out.Item, err)
	}

	// The stand-in role does refuse: reading the whole item, another
	// partition, or anything but GetItem and UpdateItem.
	if _, err := notify.get(ctx, accountPK(a.ID), skAccount, time.Now()); err == nil {
		t.Fatal("whole-item read allowed")
	}
	if _, err := notify.Link(ctx, ids.New()); err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("link read: %v", err)
	}
	if _, err := notify.Device(ctx, a.ID, a.DeviceID, time.Now()); err == nil {
		t.Fatal("device read allowed")
	}
}

// notifyRole is the table as the notify function's role lets it act
// (infra/functions.tf, statements ReadNoticeSettings and RecordNotices):
// GetItem naming only notice fields, UpdateItem touching only nm and no
// and returning nothing, and only on account items ("A#" partitions). The
// lists here must match the policy's.
type notifyRole struct{ DB }

var (
	notifyReads  = []string{"pk", "sk", "cid", "lg", "nm", "no"}
	notifyWrites = []string{"pk", "sk", "nm", "no"}
	errDenied    = errors.New("AccessDenied")
)

func (r notifyRole) GetItem(ctx context.Context, in *dynamodb.GetItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	if aws.ToString(in.ProjectionExpression) == "" || !within(in.Key, notifyReads, in.ExpressionAttributeNames, in.ProjectionExpression) {
		return nil, errDenied
	}
	return r.DB.GetItem(ctx, in, opts...)
}

func (r notifyRole) UpdateItem(ctx context.Context, in *dynamodb.UpdateItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	if (in.ReturnValues != "" && in.ReturnValues != types.ReturnValueNone) ||
		!within(in.Key, notifyWrites, in.ExpressionAttributeNames, in.UpdateExpression, in.ConditionExpression) {
		return nil, errDenied
	}
	return r.DB.UpdateItem(ctx, in, opts...)
}

func (notifyRole) BatchGetItem(context.Context, *dynamodb.BatchGetItemInput, ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error) {
	return nil, errDenied
}
func (notifyRole) PutItem(context.Context, *dynamodb.PutItemInput, ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error) {
	return nil, errDenied
}
func (notifyRole) Query(context.Context, *dynamodb.QueryInput, ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	return nil, errDenied
}
func (notifyRole) TransactWriteItems(context.Context, *dynamodb.TransactWriteItemsInput, ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error) {
	return nil, errDenied
}
func (notifyRole) BatchWriteItem(context.Context, *dynamodb.BatchWriteItemInput, ...func(*dynamodb.Options)) (*dynamodb.BatchWriteItemOutput, error) {
	return nil, errDenied
}

var (
	exprToken    = regexp.MustCompile(`[#:]?[A-Za-z_][A-Za-z0-9_]*`)
	exprKeywords = map[string]bool{
		"set": true, "remove": true, "add": true, "delete": true, "and": true, "or": true, "not": true,
		"between": true, "in": true, "attribute_exists": true, "attribute_not_exists": true,
		"attribute_type": true, "begins_with": true, "contains": true, "size": true,
		"if_not_exists": true, "list_append": true,
	}
)

// within reports whether a request's key is an account item's, and the
// attributes it names (the key's, and those in its expressions, as IAM's
// dynamodb:Attributes counts them) are all allowed.
func within(k map[string]types.AttributeValue, allowed []string, names map[string]string, exprs ...*string) bool {
	if pk, _ := str(k, "pk"); !strings.HasPrefix(pk, "A#") {
		return false
	}
	named := slices.Collect(maps.Keys(k))
	for _, e := range exprs {
		for _, tok := range exprToken.FindAllString(aws.ToString(e), -1) {
			switch {
			case strings.HasPrefix(tok, ":"), exprKeywords[strings.ToLower(tok)]:
			case strings.HasPrefix(tok, "#"):
				named = append(named, names[tok])
			default:
				named = append(named, tok)
			}
		}
	}
	for _, n := range named {
		if !slices.Contains(allowed, n) {
			return false
		}
	}
	return true
}
