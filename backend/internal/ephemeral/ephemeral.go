// Package ephemeral keeps short-lived records in DynamoDB: used login nonces,
// spent tokens, quiet periods, rate counters and open sockets. Every item expires through the table's TTL attribute e,
// and reads treat expired items as missing because TTL deletion can lag.
//
//	N#<nonce>  N              a used login nonce
//	S#<nonce>  S              a spent send or media token's nonce (Spent)
//	Q#<key>    Q              a quiet period (e.g. after a notice), with a random token (t)
//	R#<key>    <window start> a rate counter (c), or a device's budgets for a UTC day (Limiter.SpendAt)
//	C#<name>   <connection>   a socket (sockets.go)
//	U#<id>     U              an upload (uploads.go)
//
// No key holds a mailbox, link, account or device ID, or the hash of a
// Telegram ID the directory keeps: rows about one are named by a keyed
// hash instead (internal/keyed), under a key only the functions that use
// them hold, so a copy of the table can't be matched with the directory.
// Rate counters (api's, named by api.Server.rateName under the Telegram-ID
// pepper) change name with every window, and expire when it ends; socket
// records (ws and api, SocketKey) and notice quiet periods (notify,
// notices.QuietKey) keep one name per account, which says nothing without
// the key. None holds an exact time. A socket's record lasts from a connect until a push finds the socket
// closed, a later connect needs the place, the account is deleted, or a
// connect or push finds it expired (40 minutes after the minute it opened,
// rounded up to the minute; TTL itself can take days, and an expired
// record is never used).
package ephemeral

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"maps"
	"slices"
	"strconv"
	"strings"
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
// It also remembers, in memory, the tokens it has seen spent, until they
// expire (spentMemory: up to maxRemembered of them), so a token replayed
// over and over costs the table one write unit at most on each instance.
type Spent struct {
	DB    DB
	Table string
	Now   func() time.Time

	mu     sync.Mutex
	memory spentMemory
}

// TokenNonce is a token to spend: its nonce, and when the token stops being
// accepted anyway.
type TokenNonce struct {
	Nonce       []byte
	ForgetAfter time.Time
}

// memoryKey returns a nonce's key in the memory.
func (sp *Spent) memoryKey(nonce []byte) spentKey {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	return sp.memory.key(nonce)
}

// known reports whether this instance has seen the token spent.
func (sp *Spent) known(key spentKey, now time.Time) bool {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	return sp.memory.has(key, minuteOf(now))
}

// remember records, in memory, that a token is spent.
func (sp *Spent) remember(key spentKey, forgetAfter, now time.Time) {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	sp.memory.add(key, minuteOf(time.Unix(expiry(forgetAfter), 0)), minuteOf(now))
}

// Spend records a token's nonce until forgetAfter (when the token stops
// being accepted anyway). It reports false if the token was spent already,
// and not given back since.
func (sp *Spent) Spend(ctx context.Context, nonce []byte, forgetAfter time.Time) (bool, error) {
	key := sp.memoryKey(nonce)
	now := sp.Now()
	if sp.known(key, now) {
		return false, nil
	}
	// An update, not a put, so a token given back keeps r when spent again.
	_, err := sp.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 &sp.Table,
		Key:                       map[string]types.AttributeValue{"pk": s("S#" + base64.RawURLEncoding.EncodeToString(nonce)), "sk": s("S")},
		UpdateExpression:          aws.String("SET e = :e REMOVE u"),
		ConditionExpression:       aws.String("attribute_not_exists(pk) OR e <= :now OR attribute_exists(u)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":e": num(expiry(forgetAfter)), ":now": num(now.Unix())},
	})
	fresh := err == nil
	if conditionFailed(err) {
		err = nil
	}
	if err != nil {
		return false, err
	}
	// Spent either way: just now, or before.
	sp.remember(key, forgetAfter, now)
	return fresh, nil
}

// SpendAll spends several tokens, one at a time in the order given, as
// Spend does, and stops at the first that was spent already (and not given
// back since): it reports false then, and the tokens before that one stay
// spent. So a list with a spent token in it can't keep its others for
// another try, and a refusal costs the table one write unit, plus one for
// each token it burned. A list with a token this instance has seen spent,
// or with one token twice, is refused before anything is written.
//
// Not a transaction: DynamoDB charges a cancelled one two write units a
// token, and spends nothing, so a list with one spent token in it would
// cost the table that much on every try.
func (sp *Spent) SpendAll(ctx context.Context, tokens []TokenNonce) (bool, error) {
	now := sp.Now()
	keys := make([]spentKey, len(tokens))
	for i, t := range tokens {
		keys[i] = sp.memoryKey(t.Nonce)
		if sp.known(keys[i], now) || slices.Contains(keys[:i], keys[i]) {
			return false, nil
		}
	}
	if len(tokens) == 0 {
		return false, nil
	}
	for _, t := range tokens {
		if fresh, err := sp.Spend(ctx, t.Nonce, t.ForgetAfter); err != nil || !fresh {
			return false, err
		}
	}
	return true, nil
}

// Unspend gives back a token that Spend just took, when what it paid for
// didn't happen. A token is given back once at most: spent again and
// refused again, it stays spent. Otherwise one token could be replayed
// against a refusal without end, each time at the table's cost.
func (sp *Spent) Unspend(ctx context.Context, nonce []byte) error {
	_, err := sp.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 &sp.Table,
		Key:                       map[string]types.AttributeValue{"pk": s("S#" + base64.RawURLEncoding.EncodeToString(nonce)), "sk": s("S")},
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
	sp.memory.remove(sp.memory.key(nonce))
	sp.mu.Unlock()
	return nil
}

// Quiet holds quiet periods: one action per key per period.
type Quiet struct {
	DB    DB
	Table string
	Now   func() time.Time
}

// Start begins a quiet period for key until until, unless one is already
// running, atomically: of two at once, one starts. It returns the period's
// token, for Move, or "" if one was running. The token is random: it says
// nothing but which start this is.
func (q *Quiet) Start(ctx context.Context, key string, until time.Time) (string, error) {
	token := rand.Text()
	_, err := q.DB.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: &q.Table,
		Item: map[string]types.AttributeValue{
			"pk": s("Q#" + key),
			"sk": s("Q"),
			"e":  num(expiry(until)),
			"t":  s(token),
		},
		ConditionExpression:       aws.String("attribute_not_exists(pk) OR e <= :now"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":now": num(q.Now().Unix())},
	})
	if conditionFailed(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return token, nil
}

// Move moves the end of the quiet period Start began with token, to until.
// An until that has passed ends it: it is stored as the minute that has
// begun, since no row holds an exact time. Any other period (none, or one
// started since, even within the same minute) is left alone, so a Move
// tried again late can't end a newer period.
//
// So whoever starts a short period while it acts can keep it for longer
// once the action worked, or end it if it didn't, without moving a period
// someone else started.
func (q *Quiet) Move(ctx context.Context, key, token string, until time.Time) error {
	e := expiry(until)
	if now := q.Now(); !until.After(now) {
		e = now.Truncate(time.Minute).Unix()
	}
	_, err := q.DB.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: &q.Table,
		Item: map[string]types.AttributeValue{
			"pk": s("Q#" + key),
			"sk": s("Q"),
			"e":  num(e),
			"t":  s(token),
		},
		ConditionExpression:       aws.String("t = :t"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":t": s(token)},
	})
	if conditionFailed(err) {
		return nil
	}
	return err
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
	known   map[string]counted   // key and window start -> the count the table last returned
	tallies map[string]tally     // key and window start -> uses not yet written (Tally)
	local   map[string]int       // key and window start -> uses counted here only (LocalAt)
	rows    map[string]budgetRow // key and day start -> the row the table last returned (SpendAt)
	pending map[string]int       // key, day start and budget -> uses let through here, not yet written (SpendAt, Budget.Batch)
	resting time.Time            // until when batches aren't tried after a write failed (SpendAt, Budget.Batch)
	failing bool                 // a write failed, and none has gone through since: batches aren't held (SpendAt, Budget.Batch)
}

type counted struct {
	uses    int
	until   int64 // when its window ends, Unix seconds
	learned int64 // when the table told it, Unix seconds; 0 for a guess (learnGuess)
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
	// usedFresh is how long UsedAt trusts a count the table told: it reads
	// again after that.
	usedFresh = 30 // seconds
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
		// More than limit-n were counted already: a guess, enough to
		// refuse, never served as a count (UsedAt, CheckAt read again).
		l.learnGuess(key, start, window, max(l.counted(key, start), limit-n+1))
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
	return l.CountedAt(key, window, l.Now())
}

// CountedAt is Counted in the window that holds at.
func (l *Limiter) CountedAt(key string, window time.Duration, at time.Time) int {
	return l.counted(key, at.Truncate(window))
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

// Quarter is a quarter of an hour, a Budget's middle window.
const Quarter = 15 * time.Minute

// A Budget limits one kind of use of a key that SpendAt counts in the
// key's row for the UTC day: at most PerMinute in a minute, PerQuarter in a
// quarter of an hour and PerDay in the day, each window aligned like every
// Limiter window. Kind names the row's attributes for its minute and
// quarter, Day the one for its day, which budgets may share (so share
// PerDay): one letter each. Every limit is at least 1.
//
// Batch, if more than 1, has each instance count up to that many uses in
// memory before it writes them, together, in one update (SpendAt), for a
// budget used too often for a write each time.
type Budget struct {
	Kind, Day                     string
	PerMinute, PerQuarter, PerDay int
	Batch                         int
}

// The attributes a Budget counts in: the start of the minute of its last
// use (Unix seconds), its uses in that minute and in that minute's quarter,
// and its day's.
func (b Budget) minute() string   { return b.Kind + "m" }
func (b Budget) inMinute() string { return b.Kind + "n" }
func (b Budget) quarter() string  { return b.Kind + "q" }
func (b Budget) day() string      { return b.Day + "d" }

// windows are the starts of the minute and the quarter that hold at, as b
// counts them in row: the minute of b's last use instead, if another
// instance's clock, a moment ahead, counted it in a later minute already.
func (b Budget) windows(row map[string]int64, at time.Time) (minute, quarter int64) {
	minute = at.Truncate(time.Minute).Unix()
	if last, used := row[b.minute()]; used && last > minute {
		minute = last
	}
	return minute, time.Unix(minute, 0).Truncate(Quarter).Unix()
}

// over is the longest of b's windows that start at minute and quarter, and
// the day, whose uses, as row says, would be past its limit with extra
// more: the day, a quarter or a minute; 0 if none. With extra 1, the
// windows row shows used up.
func (b Budget) over(row map[string]int64, minute, quarter, extra int64) time.Duration {
	var inMinute, inQuarter int64
	if last, used := row[b.minute()]; used {
		if last == minute {
			inMinute = row[b.inMinute()]
		}
		if last >= quarter {
			inQuarter = row[b.quarter()]
		}
	}
	switch {
	case row[b.day()]+extra > int64(b.PerDay):
		return 24 * time.Hour
	case inQuarter+extra > int64(b.PerQuarter):
		return Quarter
	case inMinute+extra > int64(b.PerMinute):
		return time.Minute
	}
	return 0
}

// budgetRow is a key's row for a day, as the table last returned it to
// this instance (SpendAt): its numbers by attribute.
type budgetRow struct {
	attrs map[string]int64
	until int64 // when its day ends, Unix seconds
}

// spendTries is how many conditional updates SpendAt makes at most: one
// that fails returns the row as it is, so the next is the right one, unless
// another request moved the row on meanwhile (at a window's edge).
const spendTries = 3

// errRowMoving is SpendAt's error when its row changed under each of its
// tries: no use was counted, and none must go uncounted.
var errRowMoving = errors.New("ephemeral: the row kept changing")

// ErrResting is SpendAt's error, for a budget with a Batch, while the
// instance rests after a write it couldn't make (restAfterFailure):
// nothing was tried, and the use isn't held.
var ErrResting = errors.New("ephemeral: resting after a failed write")

// restAfterFailure is how long an instance tries no batch after any of its
// writes to the table failed (the table throttled, say): while the table
// can't take them, a write tried at every request would slow every
// request, and add to the load that throttles it.
const restAfterFailure = 5 * time.Second

// wrote notes how a write to the table went: one that failed (not on its
// condition: the table answered that) starts a rest (restAfterFailure),
// and until one goes through again, batches aren't held (spendBatched).
func (l *Limiter) wrote(err error) {
	if conditionFailed(err) {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.failing = err != nil
	if err != nil {
		l.resting = l.Now().Add(restAfterFailure)
	}
}

// SpendAt counts one use of b in key's row for the UTC day that holds at,
// if it fits in b's minute, quarter and day that hold at; otherwise it
// counts nothing and returns the longest of those windows that is used up
// (time.Minute, Quarter or 24 hours), whose end is when to try again.
//
// The row holds, for each budget, only the start of the minute of its last
// use and its uses in that minute, in that minute's quarter and in the day,
// overwritten as it goes: so the table keeps one row per key and day, which
// says when the last use of each kind was, not when every one was. It
// expires when its day ends.
//
// One conditional update counts the use (a write unit), picked by what this
// instance last learned of the row: the same minute, a later minute of the
// same quarter, or a later quarter (or no row yet). One picked wrong
// (another instance counted meanwhile), or refused because a window is used
// up, costs a write unit too, and returns the row as it is, so the next try
// is right. What the row says is used up is refused from memory, at no
// cost, until its window ends. As with AllowNAt, a call that fails counts
// nothing (a lost answer aside), and only what the table returned refuses
// anything.
//
// A budget with a Batch is counted in batches instead (spendBatched).
func (l *Limiter) SpendAt(ctx context.Context, key string, b Budget, at time.Time) (time.Duration, error) {
	day := at.Truncate(24 * time.Hour)
	k := knownKey(key, day)
	if b.Batch > 1 {
		return l.spendBatched(ctx, key, k, b, day, at)
	}
	for range spendTries {
		row := l.row(k)
		minute, quarter := b.windows(row, at)
		if full := b.over(row, minute, quarter, 1); full > 0 {
			return full, nil
		}
		// Picked wrong, or a window is used up: the row as it is (learnt)
		// says which.
		if _, ok, err := l.write(ctx, b.update(key, day, row, minute, quarter, 1, true), k, day); err != nil || ok {
			return 0, err
		}
	}
	return 0, errRowMoving
}

// spendBatched is SpendAt for a budget with a Batch. Each instance lets
// uses through on its own count, and writes them in one update once it has
// Batch of them, or once they might, with what the row last said, use up a
// window (so one instance alone never lets one through past a limit). That
// update adds them whatever the limits, since they were let through
// already, and is picked as SpendAt's is; the row it returns refuses the
// use that made it if a window is then past its limit, and that use stays
// counted. So a window can let through, past its limit, only what other
// instances hold unwritten (fewer than Batch each), and the table is
// written once a batch, not once a use. Uses written to no table (the
// instance stopped, or the day ended first) are fewer than a Batch.
// A call that fails counts nothing (its own use included): the uses let
// through before it wait for the next write. After any write of the
// instance's fails (a count of any kind), every call fails at once for
// restAfterFailure (ErrResting), holding nothing, so the caller's
// allowance while the table can't count holds every use; then each writes
// at once, holding nothing, until one goes through.
func (l *Limiter) spendBatched(ctx context.Context, key, k string, b Budget, day, at time.Time) (time.Duration, error) {
	row := l.row(k)
	minute, quarter := b.windows(row, at)
	if full := b.over(row, minute, quarter, 1); full > 0 {
		return full, nil
	}
	pk := k + "#" + b.Kind
	l.mu.Lock()
	// A write failed lately: nothing is held, so every use goes through
	// what the caller allows while the table can't count (ErrResting), or
	// tries the table at once after the rest.
	if l.Now().Before(l.resting) {
		l.mu.Unlock()
		return 0, ErrResting
	}
	n := l.pending[pk] + 1
	due := l.failing || n >= b.Batch || b.over(row, minute, quarter, int64(n)) > 0
	if l.pending == nil || (len(l.pending) >= maxKnown && l.pending[pk] == 0) {
		l.pending = map[string]int{}
	}
	if due {
		delete(l.pending, pk)
	} else {
		l.pending[pk] = n
	}
	l.mu.Unlock()
	if !due {
		return 0, nil
	}
	err := errRowMoving
	for range spendTries {
		var after map[string]int64
		var ok bool
		after, ok, err = l.write(ctx, b.update(key, day, row, minute, quarter, int64(n), false), k, day)
		if err != nil {
			break
		}
		if ok {
			return b.over(after, minute, quarter, 0), nil
		}
		err = errRowMoving
		row = l.row(k)
		minute, quarter = b.windows(row, at)
	}
	// Not written: the uses let through before wait for the next write.
	if n > 1 {
		l.mu.Lock()
		if l.pending != nil {
			l.pending[pk] += n - 1
		}
		l.mu.Unlock()
	}
	return 0, err
}

// write makes one of b's updates (update) of key's row for day, and learns
// the row the table returns: as it is now, if it was written (ok), or as it
// was, if the update's condition failed (not ok, no error), so the next
// one is picked right.
func (l *Limiter) write(ctx context.Context, in *dynamodb.UpdateItemInput, k string, day time.Time) (map[string]int64, bool, error) {
	in.TableName = &l.Table
	ctx, cancel := l.deadline(ctx)
	defer cancel()
	out, err := l.DB.UpdateItem(ctx, in, fewerRetries)
	l.wrote(err)
	var failed *types.ConditionalCheckFailedException
	if errors.As(err, &failed) {
		l.learnRow(k, day, failed.Item)
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return l.learnRow(k, day, out.Attributes), true, nil
}

// update is the conditional update that counts n uses of b in key's row for
// day, in the minute and quarter that start at minute and quarter, picked
// by row, as this instance last learnt it: b's last use in that minute, in
// that quarter, or earlier (or never). It applies only if the row is still
// as it says; with limited, also only while every window has room for the
// n (exactly: n is 1 then).
func (b Budget) update(key string, day time.Time, row map[string]int64, minute, quarter, n int64, limited bool) *dynamodb.UpdateItemInput {
	last, used := row[b.minute()]
	names := map[string]string{"#m": b.minute(), "#n": b.inMinute(), "#q": b.quarter(), "#d": b.day()}
	values := map[string]types.AttributeValue{
		":n": num(n),
		":e": num(day.Add(24 * time.Hour).Unix()),
		":m": num(minute),
	}
	var update string
	var conditions []string
	switch {
	case used && last == minute:
		update = "SET e = :e ADD #n :n, #q :n, #d :n"
		conditions = []string{"#m = :m"}
		if limited {
			conditions = append(conditions, "#n < :pm", "#q < :pq")
			values[":pm"], values[":pq"] = num(int64(b.PerMinute)), num(int64(b.PerQuarter))
		}
	case used && last >= quarter:
		update = "SET #m = :m, #n = :n, e = :e ADD #q :n, #d :n"
		conditions = []string{"#m >= :qs", "#m < :m"}
		values[":qs"] = num(quarter)
		if limited {
			conditions = append(conditions, "#q < :pq")
			values[":pq"] = num(int64(b.PerQuarter))
		}
	default:
		update = "SET #m = :m, #n = :n, #q = :n, e = :e ADD #d :n"
		conditions = []string{"(attribute_not_exists(#m) OR #m < :qs)"}
		values[":qs"] = num(quarter)
	}
	if limited {
		conditions = append(conditions, "(attribute_not_exists(#d) OR #d < :pd)")
		values[":pd"] = num(int64(b.PerDay))
	}
	return &dynamodb.UpdateItemInput{
		Key: map[string]types.AttributeValue{
			"pk": s("R#" + key),
			"sk": s(strconv.FormatInt(day.Unix(), 10)),
		},
		UpdateExpression:                    aws.String(update),
		ConditionExpression:                 aws.String(strings.Join(conditions, " AND ")),
		ExpressionAttributeNames:            names,
		ExpressionAttributeValues:           values,
		ReturnValues:                        types.ReturnValueAllNew,
		ReturnValuesOnConditionCheckFailure: types.ReturnValuesOnConditionCheckFailureAllOld,
	}
}

// row is a copy of what this instance last learned of a key's row for a
// day (SpendAt): empty if nothing.
func (l *Limiter) row(k string) map[string]int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return maps.Clone(l.rows[k].attrs)
}

// learnRow records a key's row for a day as the table just returned it
// (nil: there is none), and returns its numbers.
func (l *Limiter) learnRow(k string, day time.Time, item map[string]types.AttributeValue) map[string]int64 {
	attrs := map[string]int64{}
	for name, v := range item {
		if n, ok := v.(*types.AttributeValueMemberN); ok {
			if x, err := strconv.ParseInt(n.Value, 10, 64); err == nil {
				attrs[name] = x
			}
		}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.rows[k]; !ok && len(l.rows) >= maxKnown {
		now := l.Now().Unix()
		for k, r := range l.rows {
			if r.until <= now {
				delete(l.rows, k)
			}
		}
	}
	if l.rows == nil || len(l.rows) >= maxKnown {
		l.rows = map[string]budgetRow{}
	}
	l.rows[k] = budgetRow{attrs: attrs, until: day.Add(24 * time.Hour).Unix()}
	return maps.Clone(attrs)
}

// add adds n to key's count for the window that starts at start, if at
// most uses were counted before (any number if most is negative), and
// returns the new count.
func (l *Limiter) add(ctx context.Context, key string, n int, start time.Time, window time.Duration, most int) (*dynamodb.UpdateItemOutput, error) {
	// A count is kept only to the end of its window: past it, it limits
	// nothing, and nothing reads it. Windows are aligned, so the expiry
	// says no more than the window does.
	expires := start.Add(window)
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
	out, err := l.DB.UpdateItem(ctx, in, fewerRetries)
	l.wrote(err)
	return out, err
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
	l.remember(key, start, window, uses, l.Now().Unix())
}

// learnGuess records a count at least the table's, but maybe lower: as
// learnt long ago, so it refuses what it can, and is never taken for a
// fresh count.
func (l *Limiter) learnGuess(key string, start time.Time, window time.Duration, uses int) {
	l.remember(key, start, window, uses, 0)
}

func (l *Limiter) remember(key string, start time.Time, window time.Duration, uses int, learned int64) {
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
	l.known[k] = counted{uses: uses, until: start.Add(window).Unix(), learned: learned}
}

// Used reports how many uses of key the current window has counted.
func (l *Limiter) Used(ctx context.Context, key string, window time.Duration) (int, error) {
	return l.UsedAt(ctx, key, window, l.Now())
}

// UsedAt is Used in the window that holds at: the count the table told this
// instance in the last usedFresh seconds (counting, as AllowNAt does, or
// reading), or else the count read now, eventually consistent (half a read
// unit; one strongly consistent would cost a whole one), which it then
// remembers. So it may miss what other instances counted in about the last
// half a minute, and asking again and again costs the table a read at most
// every half a minute per instance.
func (l *Limiter) UsedAt(ctx context.Context, key string, window time.Duration, at time.Time) (int, error) {
	start := at.Truncate(window)
	if c, ok := l.memo(key, start); ok && l.Now().Unix()-c.learned <= usedFresh {
		return c.uses, nil
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
		return 0, err
	}
	uses := 0
	if c, ok := out.Item["c"].(*types.AttributeValueMemberN); ok {
		if uses, err = strconv.Atoi(c.Value); err != nil {
			return 0, err
		}
	}
	l.learn(key, start, window, uses)
	return uses, nil
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
