package ephemeral

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
)

var nextID atomic.Int64

func connID() string {
	return "conn-" + strconv.FormatInt(nextID.Add(1), 10)
}

// socketsAt is a metered socket store on a fresh table, with a clock the
// test moves.
func socketsAt(t *testing.T, clock *time.Time) (*Sockets, *dynamotest.Meter, *dynamodb.Client) {
	t.Helper()
	client := dynamotest.Client(t)
	meter := dynamotest.NewMeter(client)
	return &Sockets{DB: meter, Table: dynamotest.Table(t, client), Now: func() time.Time { return *clock }}, meter, client
}

// stored is every item in an account's partition, expired ones included.
func stored(t *testing.T, client *dynamodb.Client, table, account string) []map[string]types.AttributeValue {
	t.Helper()
	out, err := client.Query(context.Background(), &dynamodb.QueryInput{
		TableName:                 &table,
		KeyConditionExpression:    aws.String("pk = :pk"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":pk": sv("C#" + account)},
	})
	if err != nil {
		t.Fatal(err)
	}
	return out.Items
}

func TestSockets(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	s, _, _ := socketsAt(t, &clock)
	ctx := context.Background()

	if conns, err := s.Connections(ctx, "acct"); err != nil || len(conns) != 0 {
		t.Fatalf("before: %v %v", conns, err)
	}
	for _, c := range []string{"conn1", "conn2"} {
		if err := s.Open(ctx, "acct", c); err != nil {
			t.Fatal(err)
		}
		clock = clock.Add(time.Minute)
	}
	if err := s.Open(ctx, "other", "conn3"); err != nil {
		t.Fatal(err)
	}
	// Newest first.
	if conns, err := s.Connections(ctx, "acct"); err != nil || !slices.Equal(conns, []string{"conn2", "conn1"}) {
		t.Fatalf("connections = %v, %v", conns, err)
	}
	// A push that finds a socket gone forgets it.
	if err := s.Forget(ctx, "acct", "conn1"); err != nil {
		t.Fatal(err)
	}
	if conns, _ := s.Connections(ctx, "acct"); !slices.Equal(conns, []string{"conn2"}) {
		t.Fatalf("after forget = %v", conns)
	}
	// Forgetting twice, or an unknown connection, is fine.
	for _, c := range []string{"conn1", "conn2"} {
		if err := s.Forget(ctx, "acct", c); err != nil {
			t.Fatal(err)
		}
	}
	if conns, _ := s.Connections(ctx, "acct"); len(conns) != 0 {
		t.Fatalf("after forget = %v", conns)
	}
	// Expired records don't count, even before TTL deletion.
	clock = clock.Add(SocketTTL + time.Minute)
	if conns, _ := s.Connections(ctx, "other"); len(conns) != 0 {
		t.Fatalf("expired = %v", conns)
	}
	if conns, _ := s.Connections(ctx, ""); len(conns) != 0 {
		t.Fatalf("empty account = %v", conns)
	}
}

// A record says only the minute its socket opened: its expiry is on a whole
// minute, after the socket's longest life.
func TestSocketRecordsHoldNoExactTime(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0).Add(37 * time.Second)
	s, _, client := socketsAt(t, &clock)
	if err := s.Open(context.Background(), "acct", "c"); err != nil {
		t.Fatal(err)
	}
	items := stored(t, client, s.Table, "acct")
	if len(items) != 1 {
		t.Fatalf("%d items", len(items))
	}
	e, _ := strconv.ParseInt(items[0]["e"].(*types.AttributeValueMemberN).Value, 10, 64)
	if e%60 != 0 || e < clock.Add(SocketTTL).Unix() || e > clock.Add(SocketTTL+time.Minute).Unix() {
		t.Fatalf("expiry %d for a socket opened at %d", e, clock.Unix())
	}
	for name := range items[0] {
		if name != "pk" && name != "sk" && name != "e" {
			t.Fatalf("stored %q", name)
		}
	}
}

// A connect writes one record; at most one older record goes with it, once
// the account is near MaxRecords. There's no second record for $disconnect.
func TestSocketWrites(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	s, meter, client := socketsAt(t, &clock)
	ctx := context.Background()

	meter.Reset()
	if err := s.Open(ctx, "acct", connID()); err != nil {
		t.Fatal(err)
	}
	if u := meter.Units(s.Table); u.Write != 1 || u.Read > 0.5 {
		t.Fatalf("a first connect cost %+v", u)
	}
	for range MaxRecords - 2 {
		clock = clock.Add(time.Minute)
		if err := s.Open(ctx, "acct", connID()); err != nil {
			t.Fatal(err)
		}
	}
	clock = clock.Add(time.Minute)
	meter.Reset()
	if err := s.Open(ctx, "acct", connID()); err != nil {
		t.Fatal(err)
	}
	u := meter.Units(s.Table)
	t.Logf("connect with %d on record: %.1f read, %.1f write units", MaxRecords-1, u.Read, u.Write)
	if u.Write != 2 || u.Read > 0.5 {
		t.Fatalf("a connect near the limit cost %+v", u)
	}
	items := stored(t, client, s.Table, "acct")
	if len(items) != MaxRecords-1 {
		t.Fatalf("%d records, want %d", len(items), MaxRecords-1)
	}
	for _, it := range items {
		if !strings.HasPrefix(it["pk"].(*types.AttributeValueMemberS).Value, "C#") {
			t.Fatalf("unexpected record %v", it)
		}
	}
}

// At most MaxSockets connects a minute (UTC minutes) per account, and a
// refused one writes nothing.
func TestSocketConnectsAreLimited(t *testing.T) {
	minute := time.Unix(1_800_000_000, 0).Truncate(time.Minute)
	clock := minute
	s, meter, _ := socketsAt(t, &clock)
	ctx := context.Background()

	for i := range MaxSockets {
		if err := s.Open(ctx, "acct", connID()); err != nil {
			t.Fatalf("connect %d: %v", i+1, err)
		}
		clock = clock.Add(5 * time.Second)
	}
	meter.Reset()
	for range 20 {
		if err := s.Open(ctx, "acct", connID()); !errors.Is(err, ErrTooManyConnects) {
			t.Fatalf("past the limit: %v", err)
		}
	}
	if u := meter.Units(s.Table); u.Write != 0 || u.Read > 20*0.5 {
		t.Fatalf("20 refused connects cost %+v", u)
	}
	// Others aren't affected, and the next minute it opens again.
	if err := s.Open(ctx, "other", connID()); err != nil {
		t.Fatal(err)
	}
	clock = minute.Add(time.Minute)
	if err := s.Open(ctx, "acct", connID()); err != nil {
		t.Fatalf("the next minute: %v", err)
	}
}

// Records the account no longer uses don't pile up: expired ones go when
// connects see them (maxTidy each), rather than waiting for TTL, which can
// lag by days.
func TestOpenDeletesExpired(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	s, _, client := socketsAt(t, &clock)
	ctx := context.Background()
	for range maxTidy + 1 {
		if err := s.Open(ctx, "acct", connID()); err != nil {
			t.Fatal(err)
		}
	}
	clock = clock.Add(SocketTTL + 2*time.Minute)
	for _, c := range []string{"fresh", "fresher"} {
		if err := s.Open(ctx, "acct", c); err != nil {
			t.Fatal(err)
		}
	}
	var left []string
	for _, it := range stored(t, client, s.Table, "acct") {
		left = append(left, it["sk"].(*types.AttributeValueMemberS).Value)
	}
	slices.Sort(left)
	if !slices.Equal(left, []string{"fresh", "fresher"}) {
		t.Fatalf("records left: %v", left)
	}
}

// Bursts of connects at once, again and again, keep the account's records
// bounded (they used to grow by about the burst's size each time, to over
// a thousand), and connects refused at the bound write nothing.
func TestSocketBurstsStayBounded(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	s, meter, client := socketsAt(t, &clock)
	ctx := context.Background()
	const burst = 10
	most, refused := 0, 0
	mostWrites := 0.0
	// Longer than SocketTTL, so records expire along the way.
	for i := range 150 {
		meter.Reset()
		var wg sync.WaitGroup
		var refusedNow atomic.Int32
		for range burst {
			wg.Go(func() {
				err := s.Open(ctx, "acct", connID())
				switch {
				case errors.Is(err, ErrTooManyConnects):
					refusedNow.Add(1)
				case err != nil:
					t.Error(err)
				}
			})
		}
		wg.Wait()
		refused += int(refusedNow.Load())
		n := len(stored(t, client, s.Table, "acct"))
		most = max(most, n)
		if n > MaxRecords+burst {
			t.Fatalf("burst %d: %d records", i+1, n)
		}
		w := meter.Units(s.Table).Write
		mostWrites = max(mostWrites, w)
		if w > float64(4*burst) {
			t.Fatalf("burst %d cost %.0f write units", i+1, w)
		}
		clock = clock.Add(61 * time.Second)
	}
	t.Logf("150 bursts of %d: at most %d records, at most %.0f write units a burst, %d connects refused", burst, most, mostWrites, refused)
	if refused == 0 {
		t.Fatal("nothing refused")
	}
}
