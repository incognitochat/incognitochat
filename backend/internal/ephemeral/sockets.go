package ephemeral

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"slices"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// SocketTTL is how long a connection record lives. The app replaces its
// socket about every half hour (27 to 33 minutes), so an open socket always
// has a live record; one an older app keeps open longer gets no pushes
// after this, and its app polls instead.
const SocketTTL = 40 * time.Minute

// MaxSockets is how many of an account's sockets a delivery is pushed to,
// and how many it may open in a minute. An account has one device, with a
// socket for each visible copy of the app, so a few are plenty.
const MaxSockets = 5

// MaxRecords is how many socket records one account may have, about: the
// open ones, and closed ones not yet tidied away. A connect is refused at
// it, and the oldest go before it is reached (KeepRecords), so a closed
// socket's record doesn't lock an account out and the partition stays
// small.
//
// Both limits are checked against what a connect reads before it writes,
// so connects at the same moment all pass them: the bounds are as exact as
// the ws function's concurrency (10) allows, a few over at worst.
const MaxRecords = 2 * MaxSockets

// KeepRecords is how many records a connect leaves, its own included. It is
// three below MaxRecords, so two connects at the same moment on an account
// at it still leave room for the next one.
const KeepRecords = MaxRecords - 3

// maxTidy is how many expired records one connect or push deletes, at most.
const maxTidy = 2

var (
	// ErrTooManyConnects is returned by Open, which writes nothing then,
	// for an account that opened MaxSockets sockets this minute or has
	// MaxRecords on record.
	ErrTooManyConnects = errors.New("ephemeral: too many connects")
	// ErrTidy is returned when what was asked for was done but old records
	// couldn't be deleted: a connect stands, a push goes ahead.
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
// when a connect needs its place (KeepRecords), when a connect or push
// finds it expired (TTL deletion can lag by days; expired records are
// never used), or with the account (ForgetAll).
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
// of the next minute, so it says only the minute.
func expiryAt(t time.Time) int64 {
	return t.Truncate(time.Minute).Add(SocketTTL + time.Minute).Unix()
}

// oldestFirst orders records by expiry, so by the minute they opened.
func oldestFirst(a, b socketRecord) int { return cmp.Compare(a.expires, b.expires) }

// records reads an account's socket records, eventually consistent: a
// record written in about the last second may be missing. It splits them
// into those still live and those expired, at now.
func (s *Sockets) records(ctx context.Context, account string, now time.Time) (live, expired []socketRecord, err error) {
	pages := dynamodb.NewQueryPaginator(s.DB, &dynamodb.QueryInput{
		TableName:                 &s.Table,
		KeyConditionExpression:    aws.String("pk = :pk"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":pk": sv("C#" + account)},
		ProjectionExpression:      aws.String("sk, e"),
	})
	for pages.HasMorePages() {
		page, err := pages.NextPage(ctx)
		if err != nil {
			return nil, nil, err
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
			if r := (socketRecord{c.Value, expires}); expires > now.Unix() {
				live = append(live, r)
			} else {
				expired = append(expired, r)
			}
		}
	}
	return live, expired, nil
}

// tidy deletes up to maxTidy of an account's expired records, picked at
// random: connects and pushes at the same moment see the same ones, and if
// they all picked the oldest, each delete costing a write whether or not
// it's done, the rest would pile up until TTL.
func (s *Sockets) tidy(ctx context.Context, account string, expired []socketRecord) error {
	rand.Shuffle(len(expired), func(i, j int) { expired[i], expired[j] = expired[j], expired[i] })
	var errs []error
	for _, r := range expired[:min(maxTidy, len(expired))] {
		errs = append(errs, s.Forget(ctx, account, r.connection))
	}
	return errors.Join(errs...)
}

// Open records a connection for an account: one write.
//
// It refuses (ErrTooManyConnects, writing nothing) an account that has
// opened MaxSockets sockets this minute (UTC minutes; records say which
// minute they opened in) or has MaxRecords on record, which only connects
// at the same moment can reach.
//
// Once recorded, it tidies: up to maxTidy records it finds expired go, and
// the oldest go so that KeepRecords are left, so a connect writes 4 times
// at most. A record forgotten this way may be of a socket still open,
// which then gets no pushes until the app replaces it (every half hour). If
// tidying fails, Open returns ErrTidy, and the connect stands.
func (s *Sockets) Open(ctx context.Context, account, connection string) error {
	now := s.Now()
	live, expired, err := s.records(ctx, account, now)
	if err != nil {
		return err
	}
	live = slices.DeleteFunc(live, func(r socketRecord) bool { return r.connection == connection })
	expires := expiryAt(now)
	thisMinute := 0
	for _, r := range live {
		if r.expires >= expires {
			thisMinute++
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

	errs := []error{s.tidy(ctx, account, expired)}
	if extra := len(live) + 1 - KeepRecords; extra > 0 {
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

// ForgetAll deletes all of an account's socket records (the account is
// deleted): one read, and a delete for each, about MaxRecords at most.
func (s *Sockets) ForgetAll(ctx context.Context, account string) error {
	live, expired, err := s.records(ctx, account, s.Now())
	if err != nil {
		return err
	}
	var errs []error
	for _, r := range append(live, expired...) {
		errs = append(errs, s.Forget(ctx, account, r.connection))
	}
	return errors.Join(errs...)
}

// Connections lists an account's recorded connections that haven't
// expired, newest first: about MaxRecords at most, some of them of sockets
// that have closed (a push finds out, and forgets those). It also deletes
// up to maxTidy expired records it reads; if that fails, it returns the
// connections with ErrTidy. An empty account has none, at the same cost (a
// send to an unknown mailbox asks for it).
func (s *Sockets) Connections(ctx context.Context, account string) ([]string, error) {
	live, expired, err := s.records(ctx, account, s.Now())
	if err != nil {
		return nil, err
	}
	slices.SortStableFunc(live, func(a, b socketRecord) int { return oldestFirst(b, a) })
	conns := make([]string, len(live))
	for i, r := range live {
		conns[i] = r.connection
	}
	if err := s.tidy(ctx, account, expired); err != nil {
		return conns, fmt.Errorf("%w: %w", ErrTidy, err)
	}
	return conns, nil
}

func sv(v string) types.AttributeValue { return &types.AttributeValueMemberS{Value: v} }
