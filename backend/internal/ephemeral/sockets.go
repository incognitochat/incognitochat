package ephemeral

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// SocketTTL is how long a connection record lives: API Gateway closes every
// socket after 2 hours, plus margin.
const SocketTTL = 2*time.Hour + 10*time.Minute

// MaxSockets is how many of an account's sockets a delivery is pushed to,
// and how many it may open in a minute. An account has one device, with a
// socket for each visible copy of the app, so a few are plenty.
const MaxSockets = 5

// MaxRecords is how many socket records one account may have: the open
// ones, and closed ones not yet tidied away. A connect is refused at it,
// and the oldest are forgotten before it is reached, so a closed socket's
// record never locks an account out and the partition stays small.
const MaxRecords = 2 * MaxSockets

var (
	// ErrTooManyConnects is returned by Open, which writes nothing then,
	// for an account that opened MaxSockets sockets this minute or has
	// MaxRecords on record.
	ErrTooManyConnects = errors.New("ephemeral: too many connects")
	// ErrTidy is returned by Open when the connection was recorded but old
	// records couldn't be deleted: the connect stands.
	ErrTidy = errors.New("ephemeral: socket records not tidied")
)

// SocketDB is the part of the DynamoDB client Sockets (and Uploads) use.
type SocketDB interface {
	PutItem(context.Context, *dynamodb.PutItemInput, ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error)
	GetItem(context.Context, *dynamodb.GetItemInput, ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
	DeleteItem(context.Context, *dynamodb.DeleteItemInput, ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error)
	Query(context.Context, *dynamodb.QueryInput, ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error)
}

// Sockets records which accounts have an app open, by WebSocket connection:
//
//	C#<account>  <connection>  a socket, until it expires (e)
//
// Nothing else is kept: no device or IP, and no exact time: the expiry is
// SocketTTL after the minute the socket opened, rounded up to the minute.
//
// A record isn't deleted when its socket closes: $disconnect knows only the
// connection, so it would need a second record per connect, and it isn't
// routed at all. A closed socket's record goes when a push finds it gone,
// when a connect needs its place (MaxRecords), or when a connect finds it
// expired (TTL deletion can lag by days; expired records are never used).
type Sockets struct {
	DB    SocketDB
	Table string
	Now   func() time.Time
}

// socketRecord is one stored connection of an account.
type socketRecord struct {
	connection string
	expires    int64 // Unix seconds, on a whole minute
}

// expiryAt is the expiry of a socket opened at t: SocketTTL after the start
// of the next minute, so it outlives the socket and says only its minute.
func expiryAt(t time.Time) int64 {
	return t.Truncate(time.Minute).Add(SocketTTL + time.Minute).Unix()
}

// oldestFirst orders records by expiry, so by the minute they opened.
func oldestFirst(a, b socketRecord) int { return cmp.Compare(a.expires, b.expires) }

// records reads an account's socket records, eventually consistent: a
// record written in about the last second may be missing.
func (s *Sockets) records(ctx context.Context, account string) ([]socketRecord, error) {
	pages := dynamodb.NewQueryPaginator(s.DB, &dynamodb.QueryInput{
		TableName:                 &s.Table,
		KeyConditionExpression:    aws.String("pk = :pk"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":pk": sv("C#" + account)},
		ProjectionExpression:      aws.String("sk, e"),
	})
	var records []socketRecord
	for pages.HasMorePages() {
		page, err := pages.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, it := range page.Items {
			c, ok := it["sk"].(*types.AttributeValueMemberS)
			if !ok {
				continue
			}
			var expires int64
			if e, ok := it["e"].(*types.AttributeValueMemberN); ok {
				expires, _ = strconv.ParseInt(e.Value, 10, 64)
			}
			records = append(records, socketRecord{c.Value, expires})
		}
	}
	return records, nil
}

// maxTidy is how many expired records one connect deletes, at most.
const maxTidy = 2

// Open records a connection for an account: one write.
//
// It refuses (ErrTooManyConnects, writing nothing) an account that has
// opened MaxSockets sockets this minute (UTC minutes; records say which
// minute they opened in) or has MaxRecords on record, which only connects
// at the same moment can reach.
//
// Once recorded, it tidies: up to maxTidy records it finds expired go, and
// the oldest one goes once the account would have MaxRecords, so a connect
// writes 4 times at most. A record forgotten this way may be of a socket
// still open, which then gets no pushes until the app reopens it (it does
// every half hour). If tidying fails, Open returns ErrTidy, and the connect
// stands.
func (s *Sockets) Open(ctx context.Context, account, connection string) error {
	now := s.Now()
	records, err := s.records(ctx, account)
	if err != nil {
		return err
	}
	expires := expiryAt(now)
	var live, expired []socketRecord
	thisMinute := 0
	for _, r := range records {
		switch {
		case r.connection == connection:
		case r.expires <= now.Unix():
			expired = append(expired, r)
		default:
			live = append(live, r)
			if r.expires >= expires {
				thisMinute++
			}
		}
	}
	if thisMinute >= MaxSockets || len(live) >= MaxRecords {
		return ErrTooManyConnects
	}
	if _, err := s.DB.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: &s.Table,
		Item:      map[string]types.AttributeValue{"pk": sv("C#" + account), "sk": sv(connection), "e": num(expires)},
	}); err != nil {
		return err
	}

	// A few expired ones at a time: connects at the same moment see the
	// same ones, and each delete costs a write whether or not it's done.
	var errs []error
	slices.SortFunc(expired, oldestFirst)
	for _, r := range expired[:min(maxTidy, len(expired))] {
		errs = append(errs, s.Forget(ctx, account, r.connection))
	}
	// With the new one, at most MaxRecords-1 are kept, so the next connect
	// fits.
	if extra := len(live) + 1 - (MaxRecords - 1); extra > 0 {
		slices.SortFunc(live, oldestFirst)
		for _, r := range live[:min(extra, len(live))] {
			errs = append(errs, s.Forget(ctx, account, r.connection))
		}
	}
	if err := errors.Join(errs...); err != nil {
		return fmt.Errorf("%w: %w", ErrTidy, err)
	}
	return nil
}

// Forget deletes a connection's record (it is gone, expired or pushed out).
func (s *Sockets) Forget(ctx context.Context, account, connection string) error {
	_, err := s.DB.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: &s.Table,
		Key:       map[string]types.AttributeValue{"pk": sv("C#" + account), "sk": sv(connection)},
	})
	return err
}

// Connections lists an account's recorded connections that haven't
// expired, newest first: at most MaxRecords or so, some of them of sockets
// that have closed (a push finds out, and forgets those). An empty account
// has none, at the same cost (a send to an unknown mailbox asks for it).
func (s *Sockets) Connections(ctx context.Context, account string) ([]string, error) {
	records, err := s.records(ctx, account)
	if err != nil {
		return nil, err
	}
	now := s.Now().Unix()
	records = slices.DeleteFunc(records, func(r socketRecord) bool { return r.expires <= now })
	slices.SortStableFunc(records, func(a, b socketRecord) int { return oldestFirst(b, a) })
	conns := make([]string, len(records))
	for i, r := range records {
		conns[i] = r.connection
	}
	return conns, nil
}

func sv(v string) types.AttributeValue { return &types.AttributeValueMemberS{Value: v} }
