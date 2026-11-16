package ephemeral

import (
	"context"
	"errors"
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

// MaxSockets is how many connections one account keeps on record. An
// account has one device, with a socket for each visible copy of the app,
// so a few are plenty. It bounds what a delivery costs: each one is pushed
// to every recorded connection of the recipient.
const MaxSockets = 5

// ConnectWindow is how far back Open looks to limit connects: an account
// may open MaxSockets sockets in it, no more.
const ConnectWindow = time.Minute

// ErrTooManyConnects is returned by Open for an account that opened
// MaxSockets sockets in the last ConnectWindow.
var ErrTooManyConnects = errors.New("ephemeral: too many connects")

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
// Nothing else is kept: no device, IP or time beyond the expiry. A record
// isn't deleted when its socket closes: $disconnect knows only the
// connection, and a record of it would cost two more writes a connect. A
// closed socket's record is dropped when a push finds it gone, when newer
// ones push it out, or when it expires.
type Sockets struct {
	DB    SocketDB
	Table string
	Now   func() time.Time
}

// Open records a connection for an account: one write, and a delete once
// the account has MaxSockets on record. The oldest is forgotten then: it
// stays open but gets no more pushes. Forgetting, rather than refusing the
// new one, means records of sockets that have closed never lock anyone out.
//
// Its records also limit connects, for free: an account that opened
// MaxSockets sockets in the last ConnectWindow (their records' expiries
// say when) gets ErrTooManyConnects, and nothing is written.
func (s *Sockets) Open(ctx context.Context, account, connection string) error {
	now := s.Now()
	out, err := s.DB.Query(ctx, &dynamodb.QueryInput{
		TableName:                 &s.Table,
		KeyConditionExpression:    aws.String("pk = :pk"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":pk": sv("C#" + account)},
		ProjectionExpression:      aws.String("sk, e"),
	})
	if err != nil {
		return err
	}
	type record struct {
		connection string
		expires    int64
	}
	var live []record
	recent := 0
	for _, it := range out.Items {
		c, ok := it["sk"].(*types.AttributeValueMemberS)
		if !ok || c.Value == connection {
			continue
		}
		var expires int64
		if e, ok := it["e"].(*types.AttributeValueMemberN); ok {
			expires, _ = strconv.ParseInt(e.Value, 10, 64)
		}
		// Expired ones get no pushes, and TTL deletes them for free.
		if expires <= now.Unix() {
			continue
		}
		live = append(live, record{c.Value, expires})
		if expires > now.Add(SocketTTL-ConnectWindow).Unix() {
			recent++
		}
	}
	if recent >= MaxSockets {
		return ErrTooManyConnects
	}
	if _, err := s.DB.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: &s.Table,
		Item:      map[string]types.AttributeValue{"pk": sv("C#" + account), "sk": sv(connection), "e": num(now.Add(SocketTTL).Unix())},
	}); err != nil {
		return err
	}
	// The opened connection takes one place. One delete at most, so a
	// connect never costs more than two writes, even when connects at the
	// same moment see each other's records; Connections pushes to the
	// newest MaxSockets anyway, and the next connects trim the rest.
	if len(live) < MaxSockets {
		return nil
	}
	oldest := slices.MinFunc(live, func(a, b record) int { return int(a.expires - b.expires) })
	return s.Forget(ctx, account, oldest.connection)
}

// Forget deletes a connection's record (it is gone, or pushed out).
func (s *Sockets) Forget(ctx context.Context, account, connection string) error {
	_, err := s.DB.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: &s.Table,
		Key:       map[string]types.AttributeValue{"pk": sv("C#" + account), "sk": sv(connection)},
	})
	return err
}

// Connections lists an account's open connections: its newest MaxSockets
// (connects at the same moment can leave a few more on record until the
// next one). An empty account has none, at the same cost (a send to an
// unknown mailbox asks for it).
func (s *Sockets) Connections(ctx context.Context, account string) ([]string, error) {
	out, err := s.DB.Query(ctx, &dynamodb.QueryInput{
		TableName:                 &s.Table,
		KeyConditionExpression:    aws.String("pk = :pk"),
		FilterExpression:          aws.String("e > :now"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":pk": sv("C#" + account), ":now": num(s.Now().Unix())},
		ProjectionExpression:      aws.String("sk, e"),
	})
	if err != nil {
		return nil, err
	}
	type record struct {
		connection string
		expires    int64
	}
	records := make([]record, 0, len(out.Items))
	for _, it := range out.Items {
		c, ok := it["sk"].(*types.AttributeValueMemberS)
		if !ok {
			continue
		}
		var expires int64
		if e, ok := it["e"].(*types.AttributeValueMemberN); ok {
			expires, _ = strconv.ParseInt(e.Value, 10, 64)
		}
		records = append(records, record{c.Value, expires})
	}
	slices.SortStableFunc(records, func(a, b record) int { return int(b.expires - a.expires) })
	conns := make([]string, 0, min(len(records), MaxSockets))
	for _, r := range records[:min(len(records), MaxSockets)] {
		conns = append(conns, r.connection)
	}
	return conns, nil
}

func sv(v string) types.AttributeValue { return &types.AttributeValueMemberS{Value: v} }
