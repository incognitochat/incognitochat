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

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
)

// An account keeps at most MaxSockets connections on record: opening more
// forgets the oldest, so a delivery never fans out further.
func TestSocketsAreCapped(t *testing.T) {
	client := dynamotest.Client(t)
	clock := time.Unix(1_800_000_000, 0)
	s := &Sockets{DB: client, Table: dynamotest.Table(t, client), Now: func() time.Time { return clock }}
	ctx := context.Background()

	var opened []string
	for i := range MaxSockets + 3 {
		c := "conn" + string(rune('a'+i))
		opened = append(opened, c)
		if err := s.Open(ctx, "acct", c); err != nil {
			t.Fatal(err)
		}
		// Slower than the connect limit.
		clock = clock.Add(ConnectWindow / MaxSockets)
	}
	if err := s.Open(ctx, "other", "theirs"); err != nil {
		t.Fatal(err)
	}
	conns, err := s.Connections(ctx, "acct")
	slices.Sort(conns)
	if want := opened[3:]; err != nil || !slices.Equal(conns, want) {
		t.Fatalf("connections = %v, %v; want the newest %v", conns, err, want)
	}
	if conns, _ := s.Connections(ctx, "other"); !slices.Equal(conns, []string{"theirs"}) {
		t.Fatalf("another account's connections = %v", conns)
	}
}

// A connect writes one record, plus one delete once the account is at its
// cap; it no longer writes a second record for $disconnect, which costs
// nothing. Before: 2 writes, plus 2 deletes per record forgotten, and 1
// read and 2 deletes on disconnect.
func TestSocketWrites(t *testing.T) {
	client := dynamotest.Client(t)
	meter := dynamotest.NewMeter(client)
	clock := time.Unix(1_800_000_000, 0)
	table := dynamotest.Table(t, client)
	s := &Sockets{DB: meter, Table: table, Now: func() time.Time { return clock }}
	ctx := context.Background()

	meter.Reset()
	if err := s.Open(ctx, "acct", "first"); err != nil {
		t.Fatal(err)
	}
	if u := meter.Units(table); u.Write != 1 || u.Read > 0.5 {
		t.Fatalf("a first connect cost %+v", u)
	}
	for i := range MaxSockets {
		clock = clock.Add(ConnectWindow / MaxSockets)
		if err := s.Open(ctx, "acct", "c"+string(rune('a'+i))); err != nil {
			t.Fatal(err)
		}
	}
	clock = clock.Add(ConnectWindow / MaxSockets)
	meter.Reset()
	if err := s.Open(ctx, "acct", "at-cap"); err != nil {
		t.Fatal(err)
	}
	if u := meter.Units(table); u.Write != 2 || u.Read > 0.5 {
		t.Fatalf("a connect at the cap cost %+v", u)
	}
	t.Logf("connect at the cap: %.1f read, %.1f write units", meter.Units(table).Read, meter.Units(table).Write)
	// Only C# records, all expiring.
	out, err := client.Scan(ctx, &dynamodb.ScanInput{TableName: &table})
	if err != nil {
		t.Fatal(err)
	}
	for _, it := range out.Items {
		pk := it["pk"].(*types.AttributeValueMemberS).Value
		if !strings.HasPrefix(pk, "C#") || it["e"] == nil {
			t.Fatalf("unexpected record %v", it)
		}
	}
	if len(out.Items) != MaxSockets {
		t.Fatalf("%d records, want %d", len(out.Items), MaxSockets)
	}
}

// One account can open at most MaxSockets sockets a minute: a loop of
// connects (each was 4 or more writes) stops costing writes at all.
func TestSocketConnectsAreLimited(t *testing.T) {
	client := dynamotest.Client(t)
	meter := dynamotest.NewMeter(client)
	start := time.Unix(1_800_000_000, 0)
	clock := start
	table := dynamotest.Table(t, client)
	s := &Sockets{DB: meter, Table: table, Now: func() time.Time { return clock }}
	ctx := context.Background()

	for i := range MaxSockets {
		if err := s.Open(ctx, "acct", "c"+string(rune('a'+i))); err != nil {
			t.Fatalf("connect %d: %v", i+1, err)
		}
		clock = clock.Add(time.Second)
	}
	meter.Reset()
	for range 20 {
		if err := s.Open(ctx, "acct", connID()); !errors.Is(err, ErrTooManyConnects) {
			t.Fatalf("past the limit: %v", err)
		}
	}
	if u := meter.Units(table); u.Write != 0 || u.Read > 20*0.5 {
		t.Fatalf("20 refused connects cost %+v", u)
	}
	// Others aren't affected, and a minute after the first it opens again.
	if err := s.Open(ctx, "other", "theirs"); err != nil {
		t.Fatal(err)
	}
	// The first two (at 0 s and 1 s) are a minute old at 61 s.
	clock = start.Add(ConnectWindow + time.Second)
	for _, c := range []string{"later", "again"} {
		if err := s.Open(ctx, "acct", c); err != nil {
			t.Fatalf("a minute later: %v", err)
		}
	}
	if err := s.Open(ctx, "acct", "too-soon"); !errors.Is(err, ErrTooManyConnects) {
		t.Fatalf("one more, too soon: %v", err)
	}
	if conns, _ := s.Connections(ctx, "acct"); len(conns) != MaxSockets {
		t.Fatalf("%d on record", len(conns))
	}
}

// Connects at once, on an account at its cap, used to race their trims
// (measured at 15 writes each for 10 at once): now about 2 each, and the
// burst is then refused.
func TestSocketConnectBurst(t *testing.T) {
	client := dynamotest.Client(t)
	meter := dynamotest.NewMeter(client)
	clock := time.Unix(1_800_000_000, 0)
	table := dynamotest.Table(t, client)
	s := &Sockets{DB: meter, Table: table, Now: func() time.Time { return clock }}
	ctx := context.Background()
	for range MaxSockets {
		if err := s.Open(ctx, "acct", connID()); err != nil {
			t.Fatal(err)
		}
	}
	clock = clock.Add(ConnectWindow + time.Second)
	meter.Reset()
	var wg sync.WaitGroup
	var refused atomic.Int32
	for range 10 {
		wg.Go(func() {
			if err := s.Open(ctx, "acct", connID()); errors.Is(err, ErrTooManyConnects) {
				refused.Add(1)
			} else if err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	u := meter.Units(table)
	t.Logf("10 connects at once: %.1f read, %.1f write units, %d refused", u.Read, u.Write, refused.Load())
	if u.Write > 2*10 {
		t.Fatalf("10 connects at once cost %.1f write units", u.Write)
	}
	// Pushes still go to MaxSockets at most.
	if conns, err := s.Connections(ctx, "acct"); err != nil || len(conns) != MaxSockets {
		t.Fatalf("pushed to %d, %v", len(conns), err)
	}
	meter.Reset()
	for range 10 {
		if err := s.Open(ctx, "acct", connID()); !errors.Is(err, ErrTooManyConnects) {
			t.Fatalf("after the burst: %v", err)
		}
	}
	if u := meter.Units(table); u.Write != 0 {
		t.Fatalf("refused connects cost %.1f write units", u.Write)
	}
}

var nextID atomic.Int64

func connID() string {
	return "conn-" + strconv.FormatInt(nextID.Add(1), 10)
}

func TestSockets(t *testing.T) {
	client := dynamotest.Client(t)
	clock := time.Unix(1_800_000_000, 0)
	s := &Sockets{DB: client, Table: dynamotest.Table(t, client), Now: func() time.Time { return clock }}
	ctx := context.Background()

	if conns, err := s.Connections(ctx, "acct"); err != nil || len(conns) != 0 {
		t.Fatalf("before: %v %v", conns, err)
	}
	for _, c := range []string{"conn1", "conn2"} {
		if err := s.Open(ctx, "acct", c); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Open(ctx, "other", "conn3"); err != nil {
		t.Fatal(err)
	}
	conns, err := s.Connections(ctx, "acct")
	slices.Sort(conns)
	if err != nil || !slices.Equal(conns, []string{"conn1", "conn2"}) {
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
	clock = clock.Add(SocketTTL + time.Second)
	if conns, _ := s.Connections(ctx, "other"); len(conns) != 0 {
		t.Fatalf("expired = %v", conns)
	}
	if conns, _ := s.Connections(ctx, ""); len(conns) != 0 {
		t.Fatalf("empty account = %v", conns)
	}
}
