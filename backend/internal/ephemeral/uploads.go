package ephemeral

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// Uploads records media uploads until they're deleted, or expire:
//
//	U#<id>  U  the SHA-256 of its delete secret (d), its size (s), how many
//	           fresh upload URLs it was given after the first (r)
//
// Nothing says who uploaded it or who it's for.
type Uploads struct {
	DB    UploadsDB
	Table string
	Now   func() time.Time
}

// UploadsDB is the part of the DynamoDB client Uploads uses: DB, and
// batches, for deleting many uploads at once (LookupAll, DeleteAll).
type UploadsDB interface {
	DB
	BatchGetItem(context.Context, *dynamodb.BatchGetItemInput, ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error)
	BatchWriteItem(context.Context, *dynamodb.BatchWriteItemInput, ...func(*dynamodb.Options)) (*dynamodb.BatchWriteItemOutput, error)
}

const (
	// MaxLookupAll is the most uploads LookupAll takes: DynamoDB reads at
	// most 100 items a batch.
	MaxLookupAll = 100
	// deleteBatch is DynamoDB's limit for one BatchWriteItem.
	deleteBatch = 25
	// batchTries is how many times a batch is sent while DynamoDB leaves
	// some of it undone (it does when throttled), waiting longer each time.
	batchTries = 4
)

// leftUndone is the error once every try left part of a batch undone: the
// table is throttled, and it is answered as throttling is
// (awsconf.Unavailable: 503, try again shortly).
func leftUndone(what string) error {
	return &types.ProvisionedThroughputExceededException{Message: aws.String("ephemeral: batch " + what + " left uploads undone")}
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
	up, ok := u.parse(out.Item)
	return up, ok, nil
}

// parse reads an upload's item; false if it is malformed or expired.
func (u *Uploads) parse(item map[string]types.AttributeValue) (Upload, bool) {
	// Expired items count as gone: TTL deletion can lag by days.
	expires, ok1 := intAttr(item, "e")
	size, ok2 := intAttr(item, "s")
	d, ok3 := item["d"].(*types.AttributeValueMemberB)
	if !ok1 || !ok2 || !ok3 || expires <= u.Now().Unix() {
		return Upload{}, false
	}
	renewals, _ := intAttr(item, "r") // none yet if missing
	return Upload{DeleteHash: d.Value, Size: size, Expires: time.Unix(expires, 0), Renewals: int(renewals)}, true
}

// LookupAll is Lookup for several uploads at once (at most MaxLookupAll, a
// repeated ID counting once): those there are, by ID. One read, eventually
// consistent, at half a unit an upload, found or not.
func (u *Uploads) LookupAll(ctx context.Context, ids []string) (map[string]Upload, error) {
	found := map[string]Upload{}
	var keys []map[string]types.AttributeValue
	seen := map[string]bool{}
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			keys = append(keys, map[string]types.AttributeValue{"pk": sv("U#" + id), "sk": sv("U")})
		}
	}
	if len(keys) == 0 {
		return found, nil
	}
	if len(keys) > MaxLookupAll {
		return nil, errors.New("ephemeral: too many uploads to look up at once")
	}
	request := map[string]types.KeysAndAttributes{u.Table: {Keys: keys, ConsistentRead: aws.Bool(false)}}
	for try := 0; len(request) > 0; try++ {
		if try == batchTries {
			return nil, leftUndone("read")
		}
		if err := backOff(ctx, try); err != nil {
			return nil, err
		}
		out, err := u.DB.BatchGetItem(ctx, &dynamodb.BatchGetItemInput{RequestItems: request})
		if err != nil {
			return nil, err
		}
		for _, item := range out.Responses[u.Table] {
			pk, _ := item["pk"].(*types.AttributeValueMemberS)
			if pk == nil {
				continue
			}
			if up, ok := u.parse(item); ok {
				found[strings.TrimPrefix(pk.Value, "U#")] = up
			}
		}
		request = out.UnprocessedKeys
	}
	return found, nil
}

// DeleteAll forgets several uploads, 25 to a write: one write unit each.
func (u *Uploads) DeleteAll(ctx context.Context, ids []string) error {
	for len(ids) > 0 {
		n := min(deleteBatch, len(ids))
		requests := make([]types.WriteRequest, n)
		for i, id := range ids[:n] {
			requests[i] = types.WriteRequest{DeleteRequest: &types.DeleteRequest{
				Key: map[string]types.AttributeValue{"pk": sv("U#" + id), "sk": sv("U")},
			}}
		}
		ids = ids[n:]
		pending := map[string][]types.WriteRequest{u.Table: requests}
		for try := 0; len(pending[u.Table]) > 0; try++ {
			if try == batchTries {
				return leftUndone("delete")
			}
			if err := backOff(ctx, try); err != nil {
				return err
			}
			out, err := u.DB.BatchWriteItem(ctx, &dynamodb.BatchWriteItemInput{RequestItems: pending})
			if err != nil {
				return err
			}
			pending = out.UnprocessedItems
		}
	}
	return nil
}

// backOff waits before a batch's try: not before the first, then 100, 200
// and 400 ms.
func backOff(ctx context.Context, try int) error {
	if try == 0 {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(time.Duration(50<<try) * time.Millisecond):
		return nil
	}
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
