package ephemeral

import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
)

var start = time.Unix(1_800_000_000, 0)

func TestNonces(t *testing.T) {
	client := dynamotest.Client(t)
	clock := start
	n := &Nonces{DB: client, Table: dynamotest.Table(t, client), Now: func() time.Time { return clock }}
	ctx := context.Background()

	use := func(nonce string) bool {
		t.Helper()
		ok, err := n.Use(ctx, nonce, clock.Add(2*time.Minute))
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	if !use("nonce-a") {
		t.Fatal("first use refused")
	}
	if use("nonce-a") {
		t.Fatal("replay accepted")
	}
	if !use("nonce-b") {
		t.Fatal("another nonce refused")
	}
	clock = start.Add(3 * time.Minute)
	if !use("nonce-a") {
		t.Fatal("expired nonce still blocked")
	}
}

func TestLimiter(t *testing.T) {
	client := dynamotest.Client(t)
	clock := start
	l := &Limiter{DB: client, Table: dynamotest.Table(t, client), Now: func() time.Time { return clock }}
	ctx := context.Background()

	allow := func(key string) bool {
		t.Helper()
		ok, err := l.Allow(ctx, key, 2, 24*time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	if !allow("k") || !allow("k") {
		t.Fatal("refused within the limit")
	}
	if allow("k") {
		t.Fatal("allowed past the limit")
	}
	if !allow("other") {
		t.Fatal("keys aren't separate")
	}
	clock = start.Add(24 * time.Hour)
	if !allow("k") {
		t.Fatal("next window refused")
	}
}

func TestAllowN(t *testing.T) {
	client := dynamotest.Client(t)
	l := &Limiter{DB: client, Table: dynamotest.Table(t, client), Now: func() time.Time { return start }}
	ctx := context.Background()
	for _, tc := range []struct {
		n    int
		want bool
	}{{3, true}, {2, true}, {1, false}, {0, false}, {6, false}} {
		if ok, err := l.AllowN(ctx, "k", tc.n, 5, time.Hour); err != nil || ok != tc.want {
			t.Fatalf("AllowN(%d) = %v, %v; want %v", tc.n, ok, err, tc.want)
		}
	}
	// Refused uses aren't counted.
	if used, err := l.Used(ctx, "k", time.Hour); err != nil || used != 5 {
		t.Fatalf("Used = %d, %v; want 5", used, err)
	}
	if used, err := l.Used(ctx, "unused", time.Hour); err != nil || used != 0 {
		t.Fatalf("Used of an unused key = %d, %v", used, err)
	}
}

func TestSpent(t *testing.T) {
	client := dynamotest.Client(t)
	clock := start
	sp := &Spent{DB: client, Table: dynamotest.Table(t, client), Now: func() time.Time { return clock }}
	ctx := context.Background()
	nonce := []byte("0123456789abcdef0123456789abcdef")
	if ok, err := sp.Spend(ctx, nonce, start.Add(time.Hour)); !ok || err != nil {
		t.Fatalf("first spend: %v, %v", ok, err)
	}
	if ok, _ := sp.Spend(ctx, nonce, start.Add(time.Hour)); ok {
		t.Fatal("double spend accepted")
	}
	// Another instance, with nothing remembered, refuses it too.
	other := &Spent{DB: client, Table: sp.Table, Now: sp.Now}
	if ok, _ := other.Spend(ctx, nonce, start.Add(time.Hour)); ok {
		t.Fatal("double spend accepted by another instance")
	}
	clock = start.Add(2 * time.Hour)
	if ok, _ := sp.Spend(ctx, nonce, clock.Add(time.Hour)); !ok {
		t.Fatal("record outlived its expiry")
	}

	// A token given back can be spent again, here and elsewhere.
	if err := sp.Unspend(ctx, nonce); err != nil {
		t.Fatal(err)
	}
	if ok, err := other.Spend(ctx, nonce, clock.Add(time.Hour)); !ok || err != nil {
		t.Fatalf("spend after unspend: %v, %v", ok, err)
	}
}

// A token is given back once at most, whichever instance spends it: a
// token replayed against a refusal (a capped mailbox) can't keep costing
// the table (#106 brought that back).
func TestSpentGivesBackOnce(t *testing.T) {
	client := dynamotest.Client(t)
	table := dynamotest.Table(t, client)
	now := func() time.Time { return start }
	a := &Spent{DB: client, Table: table, Now: now}
	b := &Spent{DB: client, Table: table, Now: now}
	ctx := context.Background()
	nonce := []byte("0123456789abcdef0123456789abcdef")
	forget := start.Add(time.Hour)

	if ok, err := a.Spend(ctx, nonce, forget); !ok || err != nil {
		t.Fatalf("first spend: %v, %v", ok, err)
	}
	if err := a.Unspend(ctx, nonce); err != nil {
		t.Fatal(err)
	}
	// Given back: spendable again, on another instance too.
	if ok, err := b.Spend(ctx, nonce, forget); !ok || err != nil {
		t.Fatalf("spend after it was given back: %v, %v", ok, err)
	}
	if err := b.Unspend(ctx, nonce); err != nil {
		t.Fatal(err)
	}
	// The second give-back doesn't happen: it stays spent everywhere.
	for _, sp := range []*Spent{a, b, {DB: client, Table: table, Now: now}} {
		if ok, err := sp.Spend(ctx, nonce, forget); ok || err != nil {
			t.Fatalf("spent after a second give-back: %v, %v", ok, err)
		}
	}
	// Other tokens are unaffected.
	if ok, err := a.Spend(ctx, []byte("another nonce, 32 bytes long....."), forget); !ok || err != nil {
		t.Fatalf("another token: %v, %v", ok, err)
	}
}

// Once a limit is known to be reached, refusals cost the table nothing:
// a refused conditional write is charged like any other.
func TestLimiterRemembersRefusals(t *testing.T) {
	client := dynamotest.Client(t)
	meter := dynamotest.NewMeter(client)
	table := dynamotest.Table(t, client)
	clock := start
	now := func() time.Time { return clock }
	l := &Limiter{DB: meter, Table: table, Now: now}
	ctx := context.Background()

	for range 3 {
		if ok, err := l.Allow(ctx, "k", 3, time.Minute); !ok || err != nil {
			t.Fatalf("within the limit: %v, %v", ok, err)
		}
	}
	if !l.Full("k", 3, time.Minute) || l.Full("k", 4, time.Minute) || l.Full("other", 3, time.Minute) {
		t.Fatal("Full doesn't know what was counted")
	}
	meter.Reset()
	for range 20 {
		if ok, err := l.Allow(ctx, "k", 3, time.Minute); ok || err != nil {
			t.Fatalf("past the limit: %v, %v", ok, err)
		}
	}
	if u := meter.Units(table); u.Write != 0 || u.Read != 0 {
		t.Fatalf("refusals cost %+v", u)
	}

	// Another instance learns from its first refusal, then stops asking.
	other := &Limiter{DB: meter, Table: table, Now: now}
	if other.Full("k", 3, time.Minute) {
		t.Fatal("a fresh instance knows nothing")
	}
	for range 20 {
		if ok, _ := other.Allow(ctx, "k", 3, time.Minute); ok {
			t.Fatal("past the limit on another instance")
		}
	}
	if u := meter.Units(table); u.Write != 1 {
		t.Fatalf("another instance's refusals cost %v write units, want 1", u.Write)
	}
	// A refusal of many at once doesn't refuse fewer that still fit.
	if ok, _ := l.AllowN(ctx, "n", 4, 5, time.Minute); !ok {
		t.Fatal("refused within the limit")
	}
	if ok, _ := other.AllowN(ctx, "n", 3, 5, time.Minute); ok {
		t.Fatal("allowed past the limit")
	}
	if ok, err := other.AllowN(ctx, "n", 1, 5, time.Minute); !ok || err != nil {
		t.Fatalf("the last one: %v, %v", ok, err)
	}

	// The next window starts afresh.
	clock = start.Add(time.Minute)
	if l.Full("k", 3, time.Minute) {
		t.Fatal("a new window is known to be full")
	}
	if ok, err := l.Allow(ctx, "k", 3, time.Minute); !ok || err != nil {
		t.Fatalf("next window: %v, %v", ok, err)
	}
}

// Tally writes in batches: its first use in a window on an instance, then
// once a batch has gathered, or the count may have reached the limit. Only
// what the table returned refuses.
func TestLimiterTally(t *testing.T) {
	client := dynamotest.Client(t)
	meter := dynamotest.NewMeter(client)
	table := dynamotest.Table(t, client)
	l := &Limiter{DB: meter, Table: table, Now: func() time.Time { return start }}
	ctx := context.Background()
	day := 24 * time.Hour
	for i := range 100 {
		if ok, err := l.Tally(ctx, "k", 1, 1000, day, start); !ok || err != nil {
			t.Fatalf("tally %d: %v, %v", i, ok, err)
		}
	}
	// The first, then one per 50.
	if w := meter.Units(table).Write; w != 2 {
		t.Fatalf("100 tallies wrote %v times", w)
	}
	if used, _ := l.Used(ctx, "k", day); used != 51 {
		t.Fatalf("Used = %d, want 51 (49 gathered)", used)
	}
	// Another instance counts most of the rest; the next batch here
	// writes, and the table's count refuses.
	other := &Limiter{DB: meter, Table: table, Now: func() time.Time { return start }}
	if ok, err := other.Tally(ctx, "k", 900, 1000, day, start); !ok || err != nil {
		t.Fatal(ok, err)
	}
	if ok, _ := l.Tally(ctx, "k", 1, 1000, day, start); ok {
		t.Fatal("still allowed past the limit")
	}
	if !l.FullAt("k", 1000, day, start) {
		t.Fatal("not known to be full")
	}
	// Near the limit as last told, it writes at once.
	near := &Limiter{DB: meter, Table: table, Now: func() time.Time { return start }}
	near.Tally(ctx, "n", 1, 10, day, start)
	meter.Reset()
	near.Tally(ctx, "n", 8, 10, day, start)
	if w := meter.Units(table).Write; w != 0 {
		t.Fatalf("below the limit, %v writes", w)
	}
	if ok, _ := near.Tally(ctx, "n", 1, 10, day, start); ok || meter.Units(table).Write != 1 {
		t.Fatalf("reaching the limit: %v, %v writes", ok, meter.Units(table).Write)
	}
	// Without the table, what was gathered stays for later, and refuses nothing.
	fresh := &Limiter{DB: failingDB{}, Table: table, Now: func() time.Time { return start }}
	if ok, err := fresh.Tally(ctx, "j", 2000, 1000, day, start); !ok || err == nil {
		t.Fatalf("without the table: %v, %v", ok, err)
	}
	fresh.DB = meter
	if ok, err := fresh.Tally(ctx, "j", 1, 1000, day, start); ok || err != nil {
		t.Fatalf("written later: %v, %v", ok, err)
	}
	if used, _ := l.Used(ctx, "j", day); used != 2001 {
		t.Fatalf("Used = %d, want 2001", used)
	}
}

// Check answers from memory, and an instance that knows nothing of a
// window reads its count once, so it doesn't serve a window that others
// have used up.
func TestLimiterCheck(t *testing.T) {
	client := dynamotest.Client(t)
	meter := dynamotest.NewMeter(client)
	table := dynamotest.Table(t, client)
	clock := start
	now := func() time.Time { return clock }
	l := &Limiter{DB: meter, Table: table, Now: now}
	ctx := context.Background()
	if ok, err := l.CheckAt(ctx, "k", 10, time.Minute, clock); !ok || err != nil {
		t.Fatalf("an unused window: %v, %v", ok, err)
	}
	if _, err := l.AllowNAt(ctx, "k", 10, 10, time.Minute, start); err != nil {
		t.Fatal(err)
	}
	meter.Reset()
	if ok, _ := l.CheckAt(ctx, "k", 10, time.Minute, clock); ok {
		t.Fatal("a used-up window, on the instance that used it")
	}
	if u := meter.Units(table); u.Read != 0 {
		t.Fatalf("checking from memory read %v units", u.Read)
	}
	// Fresh instances read the count once each, then know.
	for range 5 {
		fresh := &Limiter{DB: meter, Table: table, Now: now}
		for range 3 {
			if ok, err := fresh.CheckAt(ctx, "k", 10, time.Minute, clock); ok || err != nil {
				t.Fatalf("a used-up window, on a fresh instance: %v, %v", ok, err)
			}
		}
	}
	if u := meter.Units(table); u.Read > 5*0.5 || u.Write != 0 {
		t.Fatalf("5 fresh instances' checks cost %+v", u)
	}
	// The next window starts afresh.
	clock = start.Add(time.Minute)
	if ok, err := l.CheckAt(ctx, "k", 10, time.Minute, clock); !ok || err != nil {
		t.Fatalf("the next window: %v, %v", ok, err)
	}
}

// A counter of a window shorter than an hour expires when its window ends;
// longer ones are kept an hour past theirs, rounded up to the hour.
func TestLimiterExpiry(t *testing.T) {
	client := dynamotest.Client(t)
	table := dynamotest.Table(t, client)
	at := start.Add(90 * time.Second)
	l := &Limiter{DB: client, Table: table, Now: func() time.Time { return at }}
	ctx := context.Background()
	for _, tc := range []struct {
		window time.Duration
		want   time.Time
	}{
		{time.Minute, at.Truncate(time.Minute).Add(time.Minute)},
		{24 * time.Hour, at.Truncate(24 * time.Hour).Add(25 * time.Hour)},
	} {
		key := tc.window.String()
		if ok, err := l.Allow(ctx, key, 5, tc.window); !ok || err != nil {
			t.Fatal(ok, err)
		}
		out, err := client.GetItem(ctx, &dynamodb.GetItemInput{TableName: &table, Key: map[string]types.AttributeValue{
			"pk": s("R#" + key), "sk": s(strconv.FormatInt(at.Truncate(tc.window).Unix(), 10)),
		}})
		if err != nil {
			t.Fatal(err)
		}
		if e := out.Item["e"].(*types.AttributeValueMemberN).Value; e != strconv.FormatInt(tc.want.Unix(), 10) {
			t.Fatalf("%s window: expires %s, want %d", tc.window, e, tc.want.Unix())
		}
	}
}

// A replayed token is refused from memory, without asking the table again.
func TestSpentRemembersReplays(t *testing.T) {
	db := &countingDB{}
	sp := &Spent{DB: db, Table: "t", Now: func() time.Time { return start }}
	ctx := context.Background()
	nonce := []byte("0123456789abcdef0123456789abcdef")
	if ok, err := sp.Spend(ctx, nonce, start.Add(time.Hour)); !ok || err != nil {
		t.Fatalf("first spend: %v, %v", ok, err)
	}
	for range 10 {
		if ok, _ := sp.Spend(ctx, nonce, start.Add(time.Hour)); ok {
			t.Fatal("double spend accepted")
		}
	}
	if db.writes != 1 {
		t.Fatalf("table writes: %d, want 1", db.writes)
	}
}

// countingDB accepts every write and counts them.
type countingDB struct{ writes int }

func (c *countingDB) GetItem(context.Context, *dynamodb.GetItemInput, ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	return &dynamodb.GetItemOutput{}, nil
}

func (c *countingDB) PutItem(context.Context, *dynamodb.PutItemInput, ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error) {
	c.writes++
	return &dynamodb.PutItemOutput{}, nil
}

func (c *countingDB) UpdateItem(context.Context, *dynamodb.UpdateItemInput, ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	c.writes++
	return &dynamodb.UpdateItemOutput{}, nil
}

func (c *countingDB) DeleteItem(context.Context, *dynamodb.DeleteItemInput, ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error) {
	return &dynamodb.DeleteItemOutput{}, nil
}

// A reservation that wasn't all used is given back, and the window then
// has room again.
func TestLimiterRefund(t *testing.T) {
	client := dynamotest.Client(t)
	l := &Limiter{DB: client, Table: dynamotest.Table(t, client), Now: func() time.Time { return start }}
	ctx := context.Background()
	for range 5 {
		if ok, err := l.AllowNAt(ctx, "k", 57, 300, time.Minute, start); !ok || err != nil {
			t.Fatalf("reserve: %v, %v", ok, err)
		}
	}
	if ok, _ := l.AllowNAt(ctx, "k", 57, 300, time.Minute, start); ok {
		t.Fatal("a sixth reservation fits")
	}
	if err := l.RefundAt(ctx, "k", 47, time.Minute, start); err != nil {
		t.Fatal(err)
	}
	if used, _ := l.Used(ctx, "k", time.Minute); used != 5*57-47 {
		t.Fatalf("Used = %d", used)
	}
	if ok, err := l.AllowNAt(ctx, "k", 57, 300, time.Minute, start); !ok || err != nil {
		t.Fatalf("after a refund: %v, %v", ok, err)
	}
}

// The At methods count in the window of the time given, even once the
// clock is in the next: a request counts in one window from start to end.
func TestLimiterAt(t *testing.T) {
	client := dynamotest.Client(t)
	clock := start.Add(59 * time.Second)
	l := &Limiter{DB: client, Table: dynamotest.Table(t, client), Now: func() time.Time { return clock }}
	ctx := context.Background()
	began := clock
	if ok, err := l.AllowNAt(ctx, "k", 10, 300, time.Minute, began); !ok || err != nil {
		t.Fatal(ok, err)
	}
	clock = clock.Add(2 * time.Second)
	if _, err := l.AllowNAt(ctx, "k", 5, 300, time.Minute, began); err != nil {
		t.Fatal(err)
	}
	if err := l.RefundAt(ctx, "k", 3, time.Minute, began); err != nil {
		t.Fatal(err)
	}
	if used, _ := l.Used(ctx, "k", time.Minute); used != 0 {
		t.Fatalf("the next minute counted %d", used)
	}
	clock = began
	if used, _ := l.Used(ctx, "k", time.Minute); used != 12 {
		t.Fatalf("the minute it began counted %d, want 12", used)
	}
}

// For windows longer than a minute, Check trusts a count below the limit
// for checkFresh only: other instances count too. A refusal stands.
func TestLimiterCheckFresh(t *testing.T) {
	client := dynamotest.Client(t)
	table := dynamotest.Table(t, client)
	clock := start
	now := func() time.Time { return clock }
	a := &Limiter{DB: client, Table: table, Now: now}
	b := &Limiter{DB: client, Table: table, Now: now}
	ctx := context.Background()
	day := 24 * time.Hour
	if ok, err := a.CheckAt(ctx, "k", 100, day, clock); !ok || err != nil {
		t.Fatal(ok, err)
	}
	if _, err := b.AllowNAt(ctx, "k", 100, 100, day, clock); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(30 * time.Second)
	if ok, _ := a.CheckAt(ctx, "k", 100, day, clock); !ok {
		t.Fatal("asked again within the minute")
	}
	clock = clock.Add(31 * time.Second)
	if ok, _ := a.CheckAt(ctx, "k", 100, day, clock); ok {
		t.Fatal("still below the limit after a minute")
	}
	// The refusal stands without asking: a table that fails can't change it.
	a.DB = failingDB{}
	clock = clock.Add(time.Hour)
	if ok, err := a.CheckAt(ctx, "k", 100, day, clock); ok || err != nil {
		t.Fatalf("a known refusal: %v, %v", ok, err)
	}
}

// A table that can't be reached counts nothing anywhere: once it's back,
// the limit is as the table says, not used up by the calls that failed.
func TestLimiterOutage(t *testing.T) {
	client := dynamotest.Client(t)
	table := dynamotest.Table(t, client)
	l := &Limiter{DB: failingDB{}, Table: table, Now: func() time.Time { return start }}
	ctx := context.Background()
	for range 50 {
		if ok, err := l.AllowN(ctx, "tok", 50, 1000, 24*time.Hour); ok || err == nil {
			t.Fatalf("during the outage: %v, %v", ok, err)
		}
	}
	if ok, err := l.CheckAt(ctx, "tok", 1000, 24*time.Hour, start); !ok || err == nil {
		t.Fatalf("Check during the outage: %v, %v", ok, err)
	}
	l.DB = client
	if ok, err := l.AllowN(ctx, "tok", 50, 1000, 24*time.Hour); !ok || err != nil {
		t.Fatalf("after it: %v, %v", ok, err)
	}
}

// LocalAt counts in this instance only, apart from the table's counts.
func TestLimiterLocal(t *testing.T) {
	l := &Limiter{DB: failingDB{}, Table: "t", Now: func() time.Time { return start }}
	if !l.LocalAt("k", 57, 57, time.Minute, start) || l.LocalAt("k", 10, 57, time.Minute, start) {
		t.Fatal("one page a minute")
	}
	if l.FullAt("k", 57, time.Minute, start) {
		t.Fatal("a local count reached the table's")
	}
	if !l.LocalAt("k", 57, 57, time.Minute, start.Add(time.Minute)) {
		t.Fatal("the next minute")
	}
}

// Calls to the table give up after Timeout.
func TestLimiterTimeout(t *testing.T) {
	l := &Limiter{DB: slowDB{}, Table: "t", Now: func() time.Time { return start }, Timeout: 50 * time.Millisecond}
	began := time.Now()
	if ok, err := l.AllowN(context.Background(), "k", 1, 10, time.Minute); ok || err == nil {
		t.Fatalf("%v, %v", ok, err)
	}
	if d := time.Since(began); d > time.Second {
		t.Fatalf("took %v", d)
	}
}

// slowDB answers only when the caller gives up.
type slowDB struct{ failingDB }

func (slowDB) UpdateItem(ctx context.Context, _ *dynamodb.UpdateItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

// failingDB fails every call, as a throttled table does.
type failingDB struct{}

var errThrottled = errors.New("throttled")

func (failingDB) GetItem(context.Context, *dynamodb.GetItemInput, ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	return nil, errThrottled
}

func (failingDB) PutItem(context.Context, *dynamodb.PutItemInput, ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error) {
	return nil, errThrottled
}

func (failingDB) UpdateItem(context.Context, *dynamodb.UpdateItemInput, ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	return nil, errThrottled
}

func (failingDB) DeleteItem(context.Context, *dynamodb.DeleteItemInput, ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error) {
	return nil, errThrottled
}
