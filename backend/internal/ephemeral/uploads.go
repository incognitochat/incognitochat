package ephemeral

import (
	"context"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// Uploads records media uploads until they're fetched and deleted, or
// expire:
//
//	U#<id>  U  the SHA-256 of its delete secret (d), its size (s), how many
//	           fresh upload URLs it was given after the first (r)
//
// Nothing says who uploaded it or who it's for.
type Uploads struct {
	DB    DB
	Table string
	Now   func() time.Time
}

// Upload is a recorded upload. Get also fills in when it expires and how
// many fresh upload URLs it was given; Put takes those as they are (expires,
// and none).
type Upload struct {
	DeleteHash []byte
	Size       int64
	Expires    time.Time
	Renewals   int
}

// Put records an upload until expires, rounded up to the minute, so the
// record holds no exact time. It fails if the ID is taken.
func (u *Uploads) Put(ctx context.Context, id string, up Upload, expires time.Time) error {
	_, err := u.DB.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: &u.Table,
		Item: map[string]types.AttributeValue{
			"pk": sv("U#" + id), "sk": sv("U"),
			"d": &types.AttributeValueMemberB{Value: up.DeleteHash},
			"s": num(up.Size),
			"e": num(expiry(expires)),
		},
		ConditionExpression: aws.String("attribute_not_exists(pk)"),
	})
	return err
}

// Get returns an upload, or false if there is none (or it expired).
func (u *Uploads) Get(ctx context.Context, id string) (Upload, bool, error) {
	return u.get(ctx, id, true)
}

// Exists reports whether there is an upload, for anyone who asks to
// download it: eventually consistent, at half the cost, so one recorded or
// deleted in about the last second may not show yet.
func (u *Uploads) Exists(ctx context.Context, id string) (bool, error) {
	_, ok, err := u.get(ctx, id, false)
	return ok, err
}

// Lookup is Get, eventually consistent, at half the cost: for deletes,
// which anyone can ask for with a random ID. A stale read only compares an
// old copy of a delete secret's hash that never changes; an upload recorded
// in about the last second may not show yet.
func (u *Uploads) Lookup(ctx context.Context, id string) (Upload, bool, error) {
	return u.get(ctx, id, false)
}

func (u *Uploads) get(ctx context.Context, id string, consistent bool) (Upload, bool, error) {
	out, err := u.DB.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      &u.Table,
		Key:            map[string]types.AttributeValue{"pk": sv("U#" + id), "sk": sv("U")},
		ConsistentRead: aws.Bool(consistent),
	})
	if err != nil || out.Item == nil {
		return Upload{}, false, err
	}
	// Expired items count as gone: TTL deletion can lag by days.
	expires, ok1 := intAttr(out.Item, "e")
	size, ok2 := intAttr(out.Item, "s")
	d, ok3 := out.Item["d"].(*types.AttributeValueMemberB)
	if !ok1 || !ok2 || !ok3 || expires <= u.Now().Unix() {
		return Upload{}, false, nil
	}
	renewals, _ := intAttr(out.Item, "r") // none yet if missing
	return Upload{DeleteHash: d.Value, Size: size, Expires: time.Unix(expires, 0), Renewals: int(renewals)}, true, nil
}

// Renew counts one more fresh upload URL for an upload. It reports false if
// there is no such upload, the upload expires at or before expiresAfter
// (so it was paid for too long ago, or it expired), or it already had most.
// It writes, so the caller checks the delete secret first (Get).
func (u *Uploads) Renew(ctx context.Context, id string, most int, expiresAfter time.Time) (bool, error) {
	_, err := u.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:           &u.Table,
		Key:                 map[string]types.AttributeValue{"pk": sv("U#" + id), "sk": sv("U")},
		UpdateExpression:    aws.String("ADD r :one"),
		ConditionExpression: aws.String("attribute_exists(pk) AND e > :after AND e > :now AND (attribute_not_exists(r) OR r < :most)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":one":   num(1),
			":after": num(expiresAfter.Unix()),
			":now":   num(u.Now().Unix()),
			":most":  num(int64(most)),
		},
	})
	if conditionFailed(err) {
		return false, nil
	}
	return err == nil, err
}

func intAttr(item map[string]types.AttributeValue, name string) (int64, bool) {
	n, ok := item[name].(*types.AttributeValueMemberN)
	if !ok {
		return 0, false
	}
	v, err := strconv.ParseInt(n.Value, 10, 64)
	return v, err == nil
}

// Delete forgets an upload.
func (u *Uploads) Delete(ctx context.Context, id string) error {
	_, err := u.DB.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: &u.Table,
		Key:       map[string]types.AttributeValue{"pk": sv("U#" + id), "sk": sv("U")},
	})
	return err
}
