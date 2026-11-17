// Package ephemeral keeps short-lived records in DynamoDB: used login nonces,
// spent tokens, quiet periods, rate counters and open sockets. Every item expires through the table's TTL attribute e,
// and reads treat expired items as missing because TTL deletion can lag.
//
//	N#<nonce>  N              a used login nonce
//	S#<nonce>  S              a spent send token's nonce
//	Q#<key>    Q              a quiet period (e.g. after a notice)
//	R#<key>    <window start> a rate counter (c)
//	C#<account> <connection>  a socket (sockets.go)
//
// Socket records and notice quiet periods (Q#notice#<account>) hold an
// account ID, neither with an exact time. A socket's record lasts from a
// connect until a push finds the socket closed, a later connect needs the
// place, the account is deleted, or a connect or push finds it expired (40
// minutes after the minute it opened, rounded up to the minute; TTL itself
// can take days, and an expired record is never used).
package ephemeral

import (
	"context"
	"encoding/base64"
	"errors"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// DB is the part of the DynamoDB client this package uses.
type DB interface {
	GetItem(context.Context, *dynamodb.GetItemInput, ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
	PutItem(context.Context, *dynamodb.PutItemInput, ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error)
	UpdateItem(context.Context, *dynamodb.UpdateItemInput, ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error)
	DeleteItem(context.Context, *dynamodb.DeleteItemInput, ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error)
}

// Nonces records used login nonces. It implements session.NonceStore.
type Nonces struct {
	DB    DB
	Table string
	Now   func() time.Time
}

// Use records nonce until expires, rounded up to the minute. It reports false
// if the nonce was already used and hasn't expired.
func (n *Nonces) Use(ctx context.Context, nonce string, expires time.Time) (bool, error) {
	return once(ctx, n.DB, n.Table, "N#"+nonce, "N", expires, n.Now())
}

// Spent records spent send and media tokens. Tokens say nothing about who
// spent them, and neither does this:
//
//	S#<nonce>  S  until it expires (e); given back (u), and whether it
//	              has been given back before (r)
//
// It also remembers, in memory, the tokens it has seen spent, so replaying
// one token over and over costs the table nothing after the first time.
type Spent struct {
	DB    SpentDB
	Table string
	Now   func() time.Time

	mu   sync.Mutex
	seen map[string]int64 // spent nonce -> when its record expires (Unix seconds)
}

// SpentDB is the part of the DynamoDB client Spent uses: DB, and
// transactions, to spend several tokens at once.
type SpentDB interface {
	DB
	TransactWriteItems(context.Context, *dynamodb.TransactWriteItemsInput, ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error)
}

// TokenNonce is a token to spend: its nonce, and when the token stops being
// accepted anyway.
type TokenNonce struct {
	Nonce       []byte
	ForgetAfter time.Time
}

// maxSeen bounds the in-memory record of spent tokens; it starts over when full.
const maxSeen = 8192

// Spending a token writes its record unless it's spent already: an update,
// not a put, so a token given back keeps r when spent again.
const (
	spendUpdate    = "SET e = :e REMOVE u"
	spendCondition = "attribute_not_exists(pk) OR e <= :now OR attribute_exists(u)"
)

func (sp *Spent) spendKey(key string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{"pk": s("S#" + key), "sk": s("S")}
}

func spendValues(forgetAfter, now time.Time) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{":e": num(expiry(forgetAfter)), ":now": num(now.Unix())}
}

// known reports whether this instance has seen the token spent.
func (sp *Spent) known(key string, now time.Time) bool {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	until, ok := sp.seen[key]
	return ok && now.Unix() < until
}

// remember records, in memory, that a token is spent.
func (sp *Spent) remember(key string, forgetAfter time.Time) {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if sp.seen == nil || len(sp.seen) >= maxSeen {
		sp.seen = map[string]int64{}
	}
	sp.seen[key] = expiry(forgetAfter)
}

// Spend records a token's nonce until forgetAfter (when the token stops
// being accepted anyway). It reports false if the token was spent already,
// and not given back since.
func (sp *Spent) Spend(ctx context.Context, nonce []byte, forgetAfter time.Time) (bool, error) {
	key := base64.RawURLEncoding.EncodeToString(nonce)
	now := sp.Now()
	if sp.known(key, now) {
		return false, nil
	}
	_, err := sp.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 &sp.Table,
		Key:                       sp.spendKey(key),
		UpdateExpression:          aws.String(spendUpdate),
		ConditionExpression:       aws.String(spendCondition),
		ExpressionAttributeValues: spendValues(forgetAfter, now),
	})
	fresh := err == nil
	if conditionFailed(err) {
		err = nil
	}
	if err != nil {
		return false, err
	}
	// Spent either way: just now, or before.
	sp.remember(key, forgetAfter)
	return fresh, nil
}

// SpendAll spends several tokens at once: all of them, or none. It reports
// false, and spends none, if any was spent already and not given back
// since, if one is in the list twice, or if another request is spending
// one of them at this very moment. One token is spent as Spend does; more
// in one transaction, which costs the table two write units each. A token
// this instance has seen spent is refused before anything is written.
func (sp *Spent) SpendAll(ctx context.Context, tokens []TokenNonce) (bool, error) {
	if len(tokens) == 1 {
		return sp.Spend(ctx, tokens[0].Nonce, tokens[0].ForgetAfter)
	}
	now := sp.Now()
	keys := make([]string, len(tokens))
	items := make([]types.TransactWriteItem, len(tokens))
	for i, t := range tokens {
		keys[i] = base64.RawURLEncoding.EncodeToString(t.Nonce)
		if sp.known(keys[i], now) || slices.Contains(keys[:i], keys[i]) {
			return false, nil
		}
		items[i] = types.TransactWriteItem{Update: &types.Update{
			TableName:                 &sp.Table,
			Key:                       sp.spendKey(keys[i]),
			UpdateExpression:          aws.String(spendUpdate),
			ConditionExpression:       aws.String(spendCondition),
			ExpressionAttributeValues: spendValues(t.ForgetAfter, now),
		}}
	}
	if len(items) == 0 {
		return false, nil
	}
	_, err := sp.DB.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: items})
	var canceled *types.TransactionCanceledException
	if errors.As(err, &canceled) {
		refused := false
		for i, r := range canceled.CancellationReasons {
			switch aws.ToString(r.Code) {
			case "ConditionalCheckFailed":
				// Spent before: replaying it here costs the table nothing.
				if i < len(keys) {
					sp.remember(keys[i], tokens[i].ForgetAfter)
				}
				refused = true
			case "TransactionConflict":
				refused = true
			}
		}
		if refused {
			return false, nil
		}
	}
	if err != nil {
		return false, err
	}
	for i, t := range tokens {
		sp.remember(keys[i], t.ForgetAfter)
	}
	return true, nil
}

// Unspend gives back a token that Spend just took, when what it paid for
// didn't happen. A token is given back once at most: spent again and
// refused again, it stays spent. Otherwise one token could be replayed
// against a refusal without end, each time at the table's cost.
func (sp *Spent) Unspend(ctx context.Context, nonce []byte) error {
	key := base64.RawURLEncoding.EncodeToString(nonce)
	_, err := sp.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 &sp.Table,
		Key:                       map[string]types.AttributeValue{"pk": s("S#" + key), "sk": s("S")},
		UpdateExpression:          aws.String("SET u = :one, r = :one"),
		ConditionExpression:       aws.String("attribute_exists(pk) AND attribute_not_exists(r)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":one": num(1)},
	})
	if conditionFailed(err) {
		return nil // given back before: it stays spent
	}
	if err != nil {
		return err
	}
	sp.mu.Lock()
	delete(sp.seen, key)
	sp.mu.Unlock()
	return nil
}

// Quiet holds quiet periods: one action per key per period.
type Quiet struct {
	DB    DB
	Table string
	Now   func() time.Time
}

// Start begins a quiet period for key until until. It reports false if one
// is already running.
func (q *Quiet) Start(ctx context.Context, key string, until time.Time) (bool, error) {
	return once(ctx, q.DB, q.Table, "Q#"+key, "Q", until, q.Now())
}

// once writes an item unless a live one exists, and reports whether it did.
func once(ctx context.Context, db DB, table, pk, sk string, expires, now time.Time) (bool, error) {
	_, err := db.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: &table,
		Item: map[string]types.AttributeValue{
			"pk": s(pk),
			"sk": s(sk),
			"e":  num(expiry(expires)),
		},
		ConditionExpression:       aws.String("attribute_not_exists(pk) OR e <= :now"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":now": num(now.Unix())},
	})
	if conditionFailed(err) {
		return false, nil
	}
	return err == nil, err
}

// Limiter counts uses of a key in fixed windows. Windows are aligned to
// multiples of their length since the Unix epoch (so a day is a UTC day).
//
// It also remembers, in memory, the count the table last returned for each
// window, so a key known to be used up is refused without writing to the
// table. A refused conditional write is charged like any other, so a
// client hammering a limit it has reached would otherwise cost the table as
// much as one within it. Only counts the table returned ever refuse: a call
// that fails counts nothing here, so an outage can't use up a limit.
//
// The At methods take the time whose window counts, so a request that
// names its counters by their window (as the inbox's do) counts in that
// window from start to end, even when it ends in the next.
//
// Each call to the table has Timeout (a second if zero) and is tried at
// most twice, so a limit can't hold up a request for long when the table
// is struggling.
type Limiter struct {
	DB      DB
	Table   string
	Now     func() time.Time
	Timeout time.Duration

	mu      sync.Mutex
	known   map[string]counted // key and window start -> the count the table last returned
	tallies map[string]tally   // key and window start -> uses not yet written (Tally)
	local   map[string]int     // key and window start -> uses counted here only (LocalAt)
}

type counted struct {
	uses    int
	until   int64 // when its window ends, Unix seconds
	learned int64 // when the table told it, Unix seconds
}

type tally struct {
	pending int
	wrote   bool // whether this instance has written any yet
}

const (
	// maxKnown bounds each in-memory map: ended windows go first, and it
	// starts over when still full.
	maxKnown = 16384
	// checkFresh is how long CheckAt trusts a count below the limit, for
	// windows longer than a minute: other instances count too, so it asks
	// again at least this often.
	checkFresh = 60 // seconds
	// tallyBatch is how many uses a Tally gathers before writing them.
	tallyBatch = 50
)

// fewerRetries tries a call to the table at most twice.
func fewerRetries(o *dynamodb.Options) { o.RetryMaxAttempts = 2 }

func (l *Limiter) deadline(ctx context.Context) (context.Context, context.CancelFunc) {
	if l.Timeout > 0 {
		return context.WithTimeout(ctx, l.Timeout)
	}
	return context.WithTimeout(ctx, time.Second)
}

// Allow counts one use of key in the current window and reports whether it
// is within limit.
func (l *Limiter) Allow(ctx context.Context, key string, limit int, window time.Duration) (bool, error) {
	return l.AllowN(ctx, key, 1, limit, window)
}

// AllowN counts n uses at once, allowing them only if all fit in the limit.
func (l *Limiter) AllowN(ctx context.Context, key string, n, limit int, window time.Duration) (bool, error) {
	return l.AllowNAt(ctx, key, n, limit, window, l.Now())
}

// AllowNAt is AllowN in the window that holds at.
func (l *Limiter) AllowNAt(ctx context.Context, key string, n, limit int, window time.Duration, at time.Time) (bool, error) {
	if n < 1 || n > limit {
		return false, nil
	}
	start := at.Truncate(window)
	if l.counted(key, start)+n > limit {
		return false, nil
	}
	out, err := l.add(ctx, key, n, start, window, limit-n)
	if conditionFailed(err) {
		// More than limit-n were counted already.
		l.learn(key, start, window, max(l.counted(key, start), limit-n+1))
		return false, nil
	}
	if err != nil {
		return false, err
	}
	l.learn(key, start, window, countOf(out))
	return true, nil
}

// RefundAt takes back n uses of key in the window that holds at: what a
// request reserved (AllowNAt) and didn't use. If the table can't be
// reached, the reservation stands.
func (l *Limiter) RefundAt(ctx context.Context, key string, n int, window time.Duration, at time.Time) error {
	if n < 1 {
		return nil
	}
	start := at.Truncate(window)
	out, err := l.add(ctx, key, -n, start, window, -1)
	if err != nil {
		return err
	}
	l.learn(key, start, window, countOf(out))
	return nil
}

// Full reports whether key's current window is known to have reached
// limit, without asking the table, so what it limits can be refused for
// free.
func (l *Limiter) Full(key string, limit int, window time.Duration) bool {
	return l.FullAt(key, limit, window, l.Now())
}

// FullAt is Full in the window that holds at.
func (l *Limiter) FullAt(key string, limit int, window time.Duration, at time.Time) bool {
	return l.counted(key, at.Truncate(window)) >= limit
}

// CheckAt reports whether key's window that holds at is below limit. A
// refusal the table told stands for the window. A count below the limit
// it trusts for a window of a minute or less, and otherwise for checkFresh;
// else it reads the count (an eventually consistent read, half a read
// unit). So an instance doesn't serve a window that others have used up,
// at least not for long. If the table can't be read, it answers from what
// the table last told, and returns the error too.
func (l *Limiter) CheckAt(ctx context.Context, key string, limit int, window time.Duration, at time.Time) (bool, error) {
	start := at.Truncate(window)
	if c, ok := l.memo(key, start); ok {
		if c.uses >= limit {
			return false, nil
		}
		if window <= time.Minute || l.Now().Unix()-c.learned <= checkFresh {
			return true, nil
		}
	}
	ctx, cancel := l.deadline(ctx)
	defer cancel()
	out, err := l.DB.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: &l.Table,
		Key: map[string]types.AttributeValue{
			"pk": s("R#" + key),
			"sk": s(strconv.FormatInt(start.Unix(), 10)),
		},
		ProjectionExpression: aws.String("c"),
	}, fewerRetries)
	if err != nil {
		return l.counted(key, start) < limit, err
	}
	uses := 0
	if c, ok := out.Item["c"].(*types.AttributeValueMemberN); ok {
		uses, _ = strconv.Atoi(c.Value)
	}
	l.learn(key, start, window, uses)
	return uses < limit, nil
}

// Tally counts n uses of key in the window that holds at, in batches: it
// gathers them here and adds them to the table's count on this instance's
// first use in the window (so it learns the count), once there are
// tallyBatch, and once the count may have reached limit. So counting often
// costs the table little: a write per batch. It reports whether the window
// is below limit, as the table last said: a count only gathered here never
// refuses. Uses an instance gathered and never wrote (it stopped) are
// fewer than a batch. If the table can't be reached, the uses stay
// gathered for the next time.
func (l *Limiter) Tally(ctx context.Context, key string, n, limit int, window time.Duration, at time.Time) (bool, error) {
	start := at.Truncate(window)
	k := knownKey(key, start)
	l.mu.Lock()
	t, ok := l.tallies[k]
	if !ok && (l.tallies == nil || len(l.tallies) >= maxKnown) {
		l.tallies = map[string]tally{}
	}
	t.pending += max(n, 0)
	due := !t.wrote || t.pending >= tallyBatch || l.known[k].uses+t.pending >= limit
	write := 0
	if due && t.pending > 0 {
		write, t.pending = t.pending, 0
	}
	l.tallies[k] = t
	l.mu.Unlock()
	if write == 0 {
		return l.counted(key, start) < limit, nil
	}
	out, err := l.add(ctx, key, write, start, window, -1)
	if err != nil {
		l.mu.Lock()
		t := l.tallies[k]
		t.pending += write
		l.tallies[k] = t
		l.mu.Unlock()
		return l.counted(key, start) < limit, err
	}
	l.mu.Lock()
	t = l.tallies[k]
	t.wrote = true
	l.tallies[k] = t
	l.mu.Unlock()
	c := countOf(out)
	l.learn(key, start, window, c)
	return c < limit, nil
}

// Counted is the count the table last returned for key's current window
// on this instance (0 if none), such as just now to AllowN.
func (l *Limiter) Counted(key string, window time.Duration) int {
	return l.counted(key, l.Now().Truncate(window))
}

// LocalAt counts n uses of key in this instance's memory only, in the
// window that holds at, and reports whether they fit in limit there. It is
// for when the table can't be reached, with a limit smaller than the
// table's: nothing else reads these counts.
func (l *Limiter) LocalAt(key string, n, limit int, window time.Duration, at time.Time) bool {
	k := knownKey(key, at.Truncate(window))
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.local == nil || len(l.local) >= maxKnown {
		l.local = map[string]int{}
	}
	if l.local[k]+n > limit {
		return false
	}
	l.local[k] += n
	return true
}

// add adds n to key's count for the window that starts at start, if at
// most uses were counted before (any number if most is negative), and
// returns the new count.
func (l *Limiter) add(ctx context.Context, key string, n int, start time.Time, window time.Duration, most int) (*dynamodb.UpdateItemOutput, error) {
	// A window of an hour or more is kept an hour past it, rounded up to the
	// hour. A shorter one only to its end: per-minute counts aren't kept
	// longer than they limit anything.
	expires := start.Add(window)
	if window >= time.Hour {
		expires = start.Add(window + 2*time.Hour - time.Nanosecond).Truncate(time.Hour)
	}
	in := &dynamodb.UpdateItemInput{
		TableName: &l.Table,
		Key: map[string]types.AttributeValue{
			"pk": s("R#" + key),
			"sk": s(strconv.FormatInt(start.Unix(), 10)),
		},
		UpdateExpression: aws.String("ADD c :n SET e = :e"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":n": num(int64(n)),
			":e": num(expires.Unix()),
		},
		ReturnValues: types.ReturnValueUpdatedNew,
	}
	if most >= 0 {
		in.ConditionExpression = aws.String("attribute_not_exists(c) OR c <= :most")
		in.ExpressionAttributeValues[":most"] = num(int64(most))
	}
	ctx, cancel := l.deadline(ctx)
	defer cancel()
	return l.DB.UpdateItem(ctx, in, fewerRetries)
}

func countOf(out *dynamodb.UpdateItemOutput) int {
	c, ok := out.Attributes["c"].(*types.AttributeValueMemberN)
	if !ok {
		return 0
	}
	n, _ := strconv.Atoi(c.Value)
	return n
}

func knownKey(key string, start time.Time) string {
	return key + "@" + strconv.FormatInt(start.Unix(), 10)
}

// counted is the count the table last returned for the window of key that
// starts at start (0 if none).
func (l *Limiter) counted(key string, start time.Time) int {
	c, _ := l.memo(key, start)
	return c.uses
}

func (l *Limiter) memo(key string, start time.Time) (counted, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	c, ok := l.known[knownKey(key, start)]
	return c, ok
}

// learn records the count the table just told.
func (l *Limiter) learn(key string, start time.Time, window time.Duration, uses int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	k := knownKey(key, start)
	if _, ok := l.known[k]; !ok && len(l.known) >= maxKnown {
		now := l.Now().Unix()
		for k, c := range l.known {
			if c.until <= now {
				delete(l.known, k)
			}
		}
	}
	if l.known == nil || len(l.known) >= maxKnown {
		l.known = map[string]counted{}
	}
	l.known[k] = counted{uses: uses, until: start.Add(window).Unix(), learned: l.Now().Unix()}
}

// Used reports how many uses of key the current window has counted.
func (l *Limiter) Used(ctx context.Context, key string, window time.Duration) (int, error) {
	start := l.Now().Truncate(window)
	ctx, cancel := l.deadline(ctx)
	defer cancel()
	out, err := l.DB.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: &l.Table,
		Key: map[string]types.AttributeValue{
			"pk": s("R#" + key),
			"sk": s(strconv.FormatInt(start.Unix(), 10)),
		},
		ProjectionExpression: aws.String("c"),
		ConsistentRead:       aws.Bool(true),
	}, fewerRetries)
	if err != nil {
		return 0, err
	}
	c, ok := out.Item["c"].(*types.AttributeValueMemberN)
	if !ok {
		return 0, nil
	}
	return strconv.Atoi(c.Value)
}

// expiry rounds an expiry time up to the minute, as stored.
func expiry(expires time.Time) int64 {
	return expires.Add(time.Minute - time.Nanosecond).Truncate(time.Minute).Unix()
}

func conditionFailed(err error) bool {
	var failed *types.ConditionalCheckFailedException
	return errors.As(err, &failed)
}

func s(v string) types.AttributeValue { return &types.AttributeValueMemberS{Value: v} }

func num(v int64) types.AttributeValue {
	return &types.AttributeValueMemberN{Value: strconv.FormatInt(v, 10)}
}
