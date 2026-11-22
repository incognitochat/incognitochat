package ephemeral

import (
	"context"
	"maps"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
)

// A budget counts in its minute, its quarter and its day, each refusing
// once used up until it ends; refused tries count nothing, and what memory
// knows is used up costs the table nothing.
func TestSpendAt(t *testing.T) {
	client := dynamotest.Client(t)
	meter := dynamotest.NewMeter(client)
	table := dynamotest.Table(t, client)
	clock := start // 08:00 UTC, on a quarter
	l := &Limiter{DB: meter, Table: table, Now: func() time.Time { return clock }}
	ctx := context.Background()
	b := Budget{Kind: "l", Day: "l", PerMinute: 3, PerQuarter: 5, PerDay: 8}
	spend := func(l *Limiter, want time.Duration) {
		t.Helper()
		full, err := l.SpendAt(ctx, "k", b, clock)
		if err != nil || full != want {
			t.Fatalf("at %v: full %v, %v; want %v", clock.Sub(start), full, err, want)
		}
	}

	for range 3 {
		spend(l, 0)
	}
	meter.Reset()
	for range 5 {
		spend(l, time.Minute)
	}
	if u := meter.Units(table); u.Write != 0 || u.Read != 0 {
		t.Fatalf("refusals known in memory cost %+v", u)
	}
	// The next minute of the quarter: two more, then the quarter is used up,
	// for the rest of it.
	clock = start.Add(time.Minute)
	spend(l, 0)
	spend(l, 0)
	spend(l, Quarter)
	clock = start.Add(14 * time.Minute)
	spend(l, Quarter)
	// The next quarter: three more fill the day.
	clock = start.Add(Quarter)
	for range 3 {
		spend(l, 0)
	}
	spend(l, 24*time.Hour)
	clock = start.Add(5 * Quarter)
	spend(l, 24*time.Hour)
	// The refused tries counted nothing: the row says 8 for the day.
	row := rowOf(t, client, table, "k", start)
	if row["ld"] != 8 {
		t.Fatalf("the day counted %d", row["ld"])
	}
	// The next UTC day starts afresh, in a row of its own.
	clock = start.Truncate(24 * time.Hour).Add(24 * time.Hour)
	spend(l, 0)
	if n := len(rowsOf(t, client, table, "k")); n != 2 {
		t.Fatalf("%d rows for two days", n)
	}
}

// The row holds the last minute of each budget and its counts, nothing
// older, and expires when its day ends. Budgets count apart, but those
// that share a day share its limit.
func TestSpendAtRow(t *testing.T) {
	client := dynamotest.Client(t)
	table := dynamotest.Table(t, client)
	clock := start
	l := &Limiter{DB: client, Table: table, Now: func() time.Time { return clock }}
	ctx := context.Background()
	logins := Budget{Kind: "l", Day: "l", PerMinute: 10, PerQuarter: 10, PerDay: 10}
	signed := Budget{Kind: "s", Day: "s", PerMinute: 10, PerQuarter: 10, PerDay: 5}
	steps := Budget{Kind: "c", Day: "s", PerMinute: 10, PerQuarter: 10, PerDay: 5}
	spend := func(b Budget, want time.Duration) {
		t.Helper()
		if full, err := l.SpendAt(ctx, "k", b, clock); err != nil || full != want {
			t.Fatalf("%s at %v: full %v, %v; want %v", b.Kind, clock.Sub(start), full, err, want)
		}
	}
	spend(logins, 0)
	spend(signed, 0)
	spend(signed, 0)
	clock = start.Add(3*time.Minute + 20*time.Second)
	spend(logins, 0)
	spend(steps, 0)
	spend(steps, 0)
	spend(steps, 0)
	// The signed day is shared: 2 + 3 used it up, for both.
	spend(signed, 24*time.Hour)
	spend(steps, 24*time.Hour)
	spend(logins, 0)

	rows := rowsOf(t, client, table, "k")
	if len(rows) != 1 {
		t.Fatalf("%d rows for one day", len(rows))
	}
	day := start.Truncate(24 * time.Hour)
	minute := start.Add(3 * time.Minute).Unix()
	want := map[string]int64{
		"e":  day.Add(24 * time.Hour).Unix(),
		"lm": minute, "ln": 2, "lq": 3, "ld": 3,
		"sm": start.Unix(), "sn": 2, "sq": 2, "sd": 5,
		"cm": minute, "cn": 3, "cq": 3,
	}
	got := rowOf(t, client, table, "k", start)
	if !maps.Equal(got, want) {
		t.Fatalf("row %v, want %v", got, want)
	}
	if names := slices.Sorted(maps.Keys(rows[0])); !slices.Equal(names, []string{"cm", "cn", "cq", "e", "ld", "lm", "ln", "lq", "pk", "sd", "sk", "sm", "sn", "sq"}) {
		t.Fatalf("row holds %v", names)
	}
	if sk := rows[0]["sk"].(*types.AttributeValueMemberS).Value; sk != strconv.FormatInt(day.Unix(), 10) {
		t.Fatalf("row's window starts at %s", sk)
	}
}

// Instances that know nothing of the row, or an old state of it, count
// right all the same: a wrong guess costs one refused write and teaches
// the row. Each learns that a window is used up from one refused write.
func TestSpendAtInstances(t *testing.T) {
	client := dynamotest.Client(t)
	meter := dynamotest.NewMeter(client)
	table := dynamotest.Table(t, client)
	clock := start
	now := func() time.Time { return clock }
	a := &Limiter{DB: meter, Table: table, Now: now}
	b := &Limiter{DB: meter, Table: table, Now: now}
	ctx := context.Background()
	budget := Budget{Kind: "s", Day: "s", PerMinute: 4, PerQuarter: 100, PerDay: 1000}
	spend := func(l *Limiter, want time.Duration) {
		t.Helper()
		if full, err := l.SpendAt(ctx, "k", budget, clock); err != nil || full != want {
			t.Fatalf("at %v: full %v, %v; want %v", clock.Sub(start), full, err, want)
		}
	}
	spend(a, 0)
	// b guesses a new quarter: refused, then counts in the same minute.
	meter.Reset()
	spend(b, 0)
	if w := meter.Units(table).Write; w != 2 {
		t.Fatalf("a first use on another instance cost %v write units", w)
	}
	spend(a, 0) // a's memory is behind: counts all the same, in one write
	spend(b, 0)
	meter.Reset()
	spend(a, time.Minute)
	spend(b, time.Minute)
	spend(a, time.Minute)
	spend(b, time.Minute)
	// b counted the last use, so knew; a learnt it from one refused write.
	if w := meter.Units(table).Write; w != 1 {
		t.Fatalf("learning that the minute is used up cost %v write units", w)
	}
	if got := rowOf(t, client, table, "k", start); got["sn"] != 4 || got["sq"] != 4 || got["sd"] != 4 {
		t.Fatalf("row %v", got)
	}

	// The next minute, on a that knows the last one: one write. b, whose
	// memory says the minute is used up, guesses a later minute of the
	// quarter: wrong once (a moved it on), then right.
	clock = start.Add(time.Minute)
	meter.Reset()
	spend(a, 0)
	spend(b, 0)
	if w := meter.Units(table).Write; w != 3 {
		t.Fatalf("the next minute cost %v write units", w)
	}

	// A clock a moment ahead counted in the next minute: one behind counts
	// there too, not in an older minute.
	clock = start.Add(2 * time.Minute)
	spend(a, 0)
	clock = start.Add(2*time.Minute - time.Second)
	spend(b, 0)
	if got := rowOf(t, client, table, "k", start); got["sm"] != start.Add(2*time.Minute).Unix() || got["sn"] != 2 || got["sq"] != 8 {
		t.Fatalf("row %v", got)
	}
}

// An instance whose memory is behind the row, with the quarter or the day
// used up meanwhile on another and its minute still below its limit, is
// refused by the table itself: one refused write, nothing counted. In the
// same minute and in a later minute of the quarter.
func TestSpendAtTableRefusesWhatMemoryMissed(t *testing.T) {
	client := dynamotest.Client(t)
	meter := dynamotest.NewMeter(client)
	ctx := context.Background()
	for _, tc := range []struct {
		name   string
		budget Budget
		later  bool
		want   time.Duration
	}{
		{"quarter, same minute", Budget{Kind: "s", Day: "s", PerMinute: 10, PerQuarter: 4, PerDay: 100}, false, Quarter},
		{"quarter, later minute", Budget{Kind: "s", Day: "s", PerMinute: 10, PerQuarter: 4, PerDay: 100}, true, Quarter},
		{"day, same minute", Budget{Kind: "s", Day: "s", PerMinute: 10, PerQuarter: 10, PerDay: 4}, false, 24 * time.Hour},
		{"day, later minute", Budget{Kind: "s", Day: "s", PerMinute: 10, PerQuarter: 10, PerDay: 4}, true, 24 * time.Hour},
	} {
		t.Run(tc.name, func(t *testing.T) {
			table := dynamotest.Table(t, client)
			clock := start
			now := func() time.Time { return clock }
			a := &Limiter{DB: meter, Table: table, Now: now}
			b := &Limiter{DB: meter, Table: table, Now: now}
			spend := func(l *Limiter, want time.Duration) {
				t.Helper()
				if full, err := l.SpendAt(ctx, "k", tc.budget, clock); err != nil || full != want {
					t.Fatalf("at %v: full %v, %v; want %v", clock.Sub(start), full, err, want)
				}
			}
			// b learns the row at 2; a takes it to 4, the quarter's or the
			// day's limit.
			spend(a, 0)
			spend(b, 0)
			spend(a, 0)
			spend(a, 0)
			if tc.later {
				clock = start.Add(time.Minute)
			}
			meter.Reset()
			spend(b, tc.want)
			if w := meter.Units(table).Write; w != 1 {
				t.Fatalf("refusing cost %v write units, want 1", w)
			}
			if got := rowOf(t, client, table, "k", start); got["sq"] != 4 || got["sd"] != 4 {
				t.Fatalf("row %v", got)
			}
		})
	}
}

// A refused write that isn't a condition (the table throttled, say) is an
// error, and counts nothing.
func TestSpendAtFails(t *testing.T) {
	l := &Limiter{DB: failingDB{}, Table: "t", Now: func() time.Time { return start }}
	budget := Budget{Kind: "l", Day: "l", PerMinute: 1, PerQuarter: 1, PerDay: 1}
	if full, err := l.SpendAt(context.Background(), "k", budget, start); err == nil || full != 0 {
		t.Fatalf("full %v, err %v", full, err)
	}
}

func rowsOf(t *testing.T, client *dynamodb.Client, table, key string) []map[string]types.AttributeValue {
	t.Helper()
	out, err := client.Scan(context.Background(), &dynamodb.ScanInput{TableName: &table})
	if err != nil {
		t.Fatal(err)
	}
	var rows []map[string]types.AttributeValue
	for _, it := range out.Items {
		if it["pk"].(*types.AttributeValueMemberS).Value == "R#"+key {
			rows = append(rows, it)
		}
	}
	return rows
}

// rowOf is key's row for the day that holds at: its numbers.
func rowOf(t *testing.T, client *dynamodb.Client, table, key string, at time.Time) map[string]int64 {
	t.Helper()
	out, err := client.GetItem(context.Background(), &dynamodb.GetItemInput{
		TableName: &table,
		Key: map[string]types.AttributeValue{
			"pk": s("R#" + key),
			"sk": s(strconv.FormatInt(at.Truncate(24*time.Hour).Unix(), 10)),
		},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		t.Fatal(err)
	}
	row := map[string]int64{}
	for name, v := range out.Item {
		if n, ok := v.(*types.AttributeValueMemberN); ok {
			row[name], _ = strconv.ParseInt(n.Value, 10, 64)
		}
	}
	return row
}
