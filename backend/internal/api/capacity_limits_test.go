package api

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
	"github.com/incognitochat/incognitochat/backend/internal/envelope"
	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
)

// IDs listed before the last hour delete nothing: the items are listed
// again, under new IDs.
func TestAckOldIDsCapacity(t *testing.T) {
	h, tb := newDeliveryTables(t)
	owner := h.account(t, userID)
	old := h.fill(t, owner, 5)
	h.now = h.now.Add(2 * time.Hour)
	owner.token = h.token(t, owner.d)
	tb.meter.Reset()
	status, _ := h.as(t, owner, http.MethodPost, "/ack", map[string]any{"ids": old}, false)
	m, _ := tb.cost(t, "POST /ack, IDs listed two hours before")
	if status != http.StatusOK || m.Write != 0 {
		t.Fatalf("old IDs: %d, %v write units", status, m.Write)
	}
	if again := h.fill(t, owner, 0); len(again) != 5 {
		t.Fatalf("%d items listed again, want 5", len(again))
	}
}

// Replaying the confirmation of a page that is gone costs the table a write
// unit per ID: a person's day allows AckMissesPerDay of those, then nothing
// is deleted, however long it goes on.
func TestAckReplayCapacity(t *testing.T) {
	h, tb := newDeliveryTables(t)
	owner := h.account(t, userID)

	// A page confirmed, then replayed for 30 minutes, as often as allowed.
	page := h.fill(t, owner, AckBatch)
	if status, out := h.as(t, owner, http.MethodPost, "/ack", map[string]any{"ids": page}, false); status != http.StatusOK {
		t.Fatalf("ack: %d %v", status, out)
	}
	tb.meter.Reset()
	answered := 0
	for minute := range 30 {
		if minute%10 == 0 {
			owner.token = h.token(t, owner.d) // sessions last 15 minutes
		}
		for range 20 {
			switch status, out := h.as(t, owner, http.MethodPost, "/ack", map[string]any{"ids": page}, false); status {
			case http.StatusOK:
				answered++
			case http.StatusTooManyRequests:
			default:
				t.Fatalf("replay: %d %v", status, out)
			}
		}
		h.now = h.now.Add(time.Minute)
	}
	m, e := tb.cost(t, "POST /ack, a confirmed page replayed for 30 minutes")
	t.Logf("  %d replays answered 200", answered)
	// The misses are written in batches of at least 50.
	if m.Write > AckMissesPerDay+AckBatch || e.Write > AckMissesPerDay/AckBatch+5 {
		t.Fatalf("30 minutes of replays cost messages %v, ephemeral %v", m, e)
	}
}

// Confirming one gone ID over and over costs the messages table a write
// unit each, up to the person's day of misses, and the ephemeral table a
// write per batch of them; past the day's misses, nothing.
func TestAckOneIDCapacity(t *testing.T) {
	h, tb := newDeliveryTables(t)
	owner := h.account(t, userID)
	one := h.fill(t, owner, 1)
	if status, out := h.as(t, owner, http.MethodPost, "/ack", map[string]any{"ids": one}, false); status != http.StatusOK {
		t.Fatalf("ack: %d %v", status, out)
	}
	tb.meter.Reset()
	for range 1500 {
		if status, _ := h.as(t, owner, http.MethodPost, "/ack", map[string]any{"ids": one}, false); status != http.StatusOK {
			t.Fatalf("ack: %d", status)
		}
	}
	m, e := tb.cost(t, "POST /ack, one gone ID, 1,500 times")
	if m.Write > AckMissesPerDay+1 || e.Write > AckMissesPerDay/AckBatch+2 {
		t.Fatalf("messages %v, ephemeral %v", m, e)
	}
}

// An honest message: delivered, fetched alone (a push each), confirmed.
// The fetch writes its minute's counter; the day is written in batches;
// the confirmation writes nothing on the ephemeral table.
func TestHonestMessageWrites(t *testing.T) {
	h, tb := newDeliveryTables(t)
	owner := h.account(t, userID)
	_, out := h.as(t, owner, http.MethodPost, "/mailboxes", map[string]any{"count": MailboxBatch}, false)
	boxes := out["mailboxes"].([]any)
	env := clientEnvelope(t)
	const n = 100
	var send, fetch, ack dynamotest.Units
	tb.meter.Reset()
	for i := range n {
		if i%25 == 0 {
			owner.token = h.token(t, owner.d)
		}
		if status, out := h.post(t, "/send", map[string]any{"mailbox": boxes[i%len(boxes)], "envelope": env, "token": mintToken(t, h.now)}); status != http.StatusOK {
			t.Fatalf("send: %d %v", status, out)
		}
		_, e := tb.meter.Units(tb.messages), tb.meter.Units(tb.ephemeral)
		send.Write += e.Write
		tb.meter.Reset()
		status, out := h.as(t, owner, http.MethodGet, "/inbox", nil, false)
		items, _ := out["items"].([]any)
		if status != http.StatusOK || len(items) != 1 {
			t.Fatalf("inbox: %d %v", status, out)
		}
		fetch.Write += tb.meter.Units(tb.ephemeral).Write
		fetch.Read += tb.meter.Units(tb.ephemeral).Read
		tb.meter.Reset()
		id := items[0].(map[string]any)["id"].(string)
		if status, out := h.as(t, owner, http.MethodPost, "/ack", map[string]any{"ids": []string{id}}, false); status != http.StatusOK {
			t.Fatalf("ack: %d %v", status, out)
		}
		ack.Write += tb.meter.Units(tb.ephemeral).Write
		ack.Read += tb.meter.Units(tb.ephemeral).Read
		tb.meter.Reset()
		h.now = h.now.Add(20 * time.Second) // a message every 20 seconds
	}
	t.Logf("ephemeral writes per message: send %.2f, fetch %.2f, confirm %.2f (reads: fetch %.2f, confirm %.2f)",
		send.Write/n, fetch.Write/n, ack.Write/n, fetch.Read/n, ack.Read/n)
	if (fetch.Write+ack.Write)/n > 1.1 {
		t.Fatalf("fetch and confirm wrote %.2f a message", (fetch.Write+ack.Write)/n)
	}
}

// A daily limit outlives an outage of the ephemeral table: the requests
// that failed during it count nothing, and the next is allowed.
func TestDailyLimitAfterOutage(t *testing.T) {
	h, tb := newDeliveryTables(t)
	owner := h.account(t, userID)
	db := &switchable{DB: tb.meter, down: true}
	h.server.Limits = &ephemeral.Limiter{DB: db, Table: tb.ephemeral, Now: func() time.Time { return h.now }}
	for range 50 {
		if status, _ := h.as(t, owner, http.MethodPost, "/mailboxes", map[string]any{"count": MailboxBatch}, false); status != http.StatusInternalServerError {
			t.Fatalf("during the outage: %d", status)
		}
	}
	db.down = false
	if status, out := h.as(t, owner, http.MethodPost, "/mailboxes", map[string]any{"count": MailboxBatch}, false); status != http.StatusCreated {
		t.Fatalf("after it: %d %v", status, out)
	}
}

// switchable is an ephemeral table that can be down.
type switchable struct {
	ephemeral.DB
	down bool
}

func (s *switchable) GetItem(ctx context.Context, in *dynamodb.GetItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	if s.down {
		return nil, errThrottled
	}
	return s.DB.GetItem(ctx, in, opts...)
}

func (s *switchable) UpdateItem(ctx context.Context, in *dynamodb.UpdateItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	if s.down {
		return nil, errThrottled
	}
	return s.DB.UpdateItem(ctx, in, opts...)
}

// sendLargest delivers n of the largest envelopes to m's device.
func (h *harness) sendLargest(t *testing.T, m member, n int) {
	t.Helper()
	_, out := h.as(t, m, http.MethodPost, "/mailboxes", map[string]any{"count": MailboxBatch}, false)
	boxes := out["mailboxes"].([]any)
	largest := make([]byte, envelope.MaxLen)
	largest[0], largest[1] = envelope.Suite, envelope.MaxWraps
	for i := range n {
		if status, out := h.post(t, "/send", map[string]any{"mailbox": boxes[i%len(boxes)], "envelope": base64.RawURLEncoding.EncodeToString(largest), "tokens": mintTokens(t, h.now, envelope.MaxTokens)}); status != http.StatusOK {
			t.Fatalf("send: %d %v", status, out)
		}
	}
}

// A device's read budget holds across instances: one that knows nothing of
// the minute yet reads no more than the first two items before the
// budget refuses it.
func TestInboxBudgetAcrossInstances(t *testing.T) {
	h, tb := newDeliveryTables(t)
	owner := h.account(t, userID)
	h.sendLargest(t, owner, 50)
	tb.meter.Reset()
	pages := 0
	for ; pages < 100; pages++ {
		if status, _ := h.as(t, owner, http.MethodGet, "/inbox", nil, false); status == http.StatusTooManyRequests {
			break
		}
	}
	m, _ := tb.cost(t, "GET /inbox, the largest envelopes, until refused")
	t.Logf("  %d pages served", pages)
	if m.Read > InboxUnitsPerMinute {
		t.Fatalf("one instance read %v units in a minute", m.Read)
	}

	served := 0
	for range 20 {
		tb.wire(h)
		if status, _ := h.as(t, owner, http.MethodGet, "/inbox", nil, false); status == http.StatusOK {
			served++
		}
	}
	m, e := tb.cost(t, "  the same minute, each on a fresh instance")
	t.Logf("  %d of 20 served", served)
	if served > 0 || m.Read > 0 || e.Write > 0 {
		t.Fatalf("20 fresh instances served %d pages, messages %v, ephemeral %v", served, m, e)
	}
}

// Fetches at once, on as many instances, can't read more than the minute
// allows: a page's worst cost is reserved, with a conditional write, before
// it is read past its first two items.
func TestInboxBudgetConcurrent(t *testing.T) {
	h, tb := newDeliveryTables(t)
	owner := h.account(t, userID)
	h.sendLargest(t, owner, 50)
	const n = 40
	routers := make([]*httpapi.Router, n)
	for i := range routers {
		routers[i] = tb.instance(h)
	}
	tb.meter.Reset()
	var wg sync.WaitGroup
	statuses := make([]int, n)
	for i, r := range routers {
		wg.Go(func() { statuses[i], _ = serve(r, owner, http.MethodGet, "/inbox", nil) })
	}
	wg.Wait()
	served := 0
	for _, s := range statuses {
		if s == http.StatusOK {
			served++
		}
	}
	m, e := tb.cost(t, "GET /inbox, the largest envelopes, 40 at once on 40 instances")
	t.Logf("  %d of %d served", served, n)
	// Pages within the minute, plus the first reads (two items, 5 units) of
	// those refused.
	if served == 0 || m.Read > InboxUnitsPerMinute+float64((n-served)*5) || e.Write > 3*n {
		t.Fatalf("%d served, messages %v, ephemeral %v", served, m, e)
	}
}

// A device fetched at once from 100 instances, every minute: each instance
// starts each minute knowing nothing of it, and all of them read its count
// before any writes it (atOnce). After the first minute, those instances
// take the page before reading anything. Every page counts what it read
// against the person's day, and every fetch refused after it read messages
// or wrote a count at least MinRequestUnits: so the day bounds what it all
// reads, and the writes of the fetches refused; then it costs nothing.
func TestInboxConcurrentEveryMinute(t *testing.T) {
	for _, tc := range []struct {
		name string
		fill func(h *harness, m member)
	}{
		{"the largest envelopes", func(h *harness, m member) { h.sendLargest(t, m, 50) }},
		{"3 small envelopes", func(h *harness, m member) { h.fill(t, m, 3) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			h, tb := newDeliveryTables(t)
			owner := h.account(t, userID)
			tc.fill(h, owner)
			const c = 100
			gate := &atOnce{DB: tb.meter}
			routers := make([]*httpapi.Router, c)
			for i := range routers {
				routers[i] = tb.instanceOn(h, gate)
			}
			// Until every instance knows that the day is over, a minute
			// serves at most InboxUnitsPerMinute/MinRequestUnits of the
			// fetches (each leaves at least MinRequestUnits counted in it).
			// All of them found the minute empty, so it refuses the others
			// after a write, each counting at least MinRequestUnits on the
			// day. An instance holds back less than a batch of what it
			// counts (ephemeral's tallyBatch, 50). So the table has the
			// day's count within dayBy minutes. In the next, an instance may
			// still go by a count it learned the minute before; in the one
			// after, every instance has asked again (CheckAt trusts a count
			// for a minute), and the minute costs nothing.
			const perMinute = (c - InboxUnitsPerMinute/MinRequestUnits) * MinRequestUnits
			const dayBy = (InboxUnitsPerDay + c*(50-1) + perMinute - 1) / perMinute
			var total, first, steady dynamotest.Units
			minutes, free := 0, false
			for ; minutes < dayBy+2 && !free; minutes++ {
				if minutes%10 == 0 {
					owner.token = h.token(t, owner.d)
				}
				tb.meter.Reset()
				gate.minute(c)
				var wg sync.WaitGroup
				var ended atomic.Int32 // fetches answered daily_limit
				for _, r := range routers {
					wg.Go(func() {
						ctx, done := gate.fetch()
						defer done()
						if resp, _ := serveIn(ctx, r, owner, http.MethodGet, "/inbox", nil); httpapi.ErrorCode(resp) == "daily_limit" {
							ended.Add(1)
						}
					})
				}
				wg.Wait()
				m, e := tb.meter.Units(tb.messages), tb.meter.Units(tb.ephemeral)
				total.Read += m.Read
				total.Write += e.Write
				if minutes == 0 {
					first = dynamotest.Units{Read: m.Read, Write: e.Write}
				} else if minutes <= 10 {
					steady.Read += m.Read / 10
					steady.Write += e.Write / 10
				}
				// The day ended it: every fetch was told so, and none read or
				// wrote anything. (A minute in which DynamoDB Local failed
				// every call costs nothing either.)
				free = minutes > 0 && ended.Load() == c && m.Read == 0 && e.Write == 0
				h.now = h.now.Add(time.Minute)
			}
			t.Logf("first minute: %.1f R messages, %.0f W ephemeral; then about %.1f R and %.0f W a minute; %d minutes (free: %v), %.0f R and %.0f W in all",
				first.Read, first.Write, steady.Read, steady.Write, minutes, free, total.Read, total.Write)
			// The pages of a minute read at most InboxUnitsPerMinute, however
			// many instances fetch at once. On top come the first reads (two
			// of the largest envelopes: firstRead units) of fetches refused on
			// an instance that doesn't know yet that the minute is full. An
			// instance makes one each time it has forgotten that the device
			// needed a page (after pagedFor), so at most twice in these 10
			// minutes: c units a minute on average, a bound timing can't
			// exceed. Without these limits a minute read 600 to 680.
			const firstRead = 5
			margin := float64(firstRead*c*(10*60/pagedFor)) / 10
			if steady.Read > InboxUnitsPerMinute+margin || total.Read > InboxUnitsPerDay {
				t.Fatalf("reads: %v a minute, %v in all", steady.Read, total.Read)
			}
			if !free {
				t.Fatal("the day's count didn't end it")
			}
		})
	}
}

// atOnce is the ephemeral table as the rate limits of fetches that all
// start at once see it: no write to a device's minute counter goes through
// until each fetch of the minute has read the counter, or ended without
// it. So every instance new to the minute finds it empty, whatever order
// DynamoDB Local serves the calls in. Left to that order, some fetches read
// the counter after others have reserved it full, and are refused there,
// having written nothing and read no messages, which the day doesn't count:
// how many differs from run to run, and so does how long the day takes to
// end it (60 to past 150 minutes, measured).
type atOnce struct {
	ephemeral.DB

	mu      sync.Mutex
	waiting int           // fetches of the minute yet to arrive
	open    chan struct{} // closed once none is
}

// arrival is one fetch's place at the gate, in its context.
type arrival struct {
	once sync.Once
	gate *atOnce
}

type arrivalKey struct{}

// minute starts a minute of n fetches.
func (g *atOnce) minute(n int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.waiting, g.open = n, make(chan struct{})
}

// fetch returns the context of one of the minute's fetches, and what to
// call once it has ended.
func (g *atOnce) fetch() (context.Context, func()) {
	a := &arrival{gate: g}
	return context.WithValue(context.Background(), arrivalKey{}, a), a.arrive
}

func (a *arrival) arrive() {
	a.once.Do(func() {
		g := a.gate
		g.mu.Lock()
		defer g.mu.Unlock()
		if g.waiting--; g.waiting == 0 {
			close(g.open)
		}
	})
}

// minuteCounter reports whether key is a device's minute of inbox fetches
// (rateName "inbox"; the person's day is "inboxday").
func minuteCounter(key map[string]types.AttributeValue) bool {
	pk, ok := key["pk"].(*types.AttributeValueMemberS)
	return ok && strings.HasPrefix(pk.Value, "R#inbox#")
}

// GetItem arrives once a fetch has read the minute's count.
func (g *atOnce) GetItem(ctx context.Context, in *dynamodb.GetItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	out, err := g.DB.GetItem(ctx, in, opts...)
	if a, ok := ctx.Value(arrivalKey{}).(*arrival); ok && minuteCounter(in.Key) {
		a.arrive()
	}
	return out, err
}

// UpdateItem holds a fetch's write to the minute's count until every fetch
// of the minute has arrived. It arrives first itself, so none waits on
// another that is waiting too.
func (g *atOnce) UpdateItem(ctx context.Context, in *dynamodb.UpdateItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	if a, ok := ctx.Value(arrivalKey{}).(*arrival); ok && minuteCounter(in.Key) {
		a.arrive()
		g.mu.Lock()
		open := g.open
		g.mu.Unlock()
		select {
		case <-open:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return g.DB.UpdateItem(ctx, in, opts...)
}

// Every fetch that reads something counts, at least MinRequestUnits: an
// inbox of a few small envelopes can't be fetched a thousand times a
// minute.
func TestInboxSmallFetchesCounted(t *testing.T) {
	h, tb := newDeliveryTables(t)
	owner := h.account(t, userID)
	h.fill(t, owner, 6)
	tb.meter.Reset()
	served := 0
	for range 1000 {
		if status, _ := h.as(t, owner, http.MethodGet, "/inbox", nil, false); status == http.StatusOK {
			served++
		}
	}
	m, e := tb.cost(t, "GET /inbox, 6 small envelopes, 1,000 times in a minute")
	t.Logf("  %d served", served)
	if served > InboxUnitsPerMinute/MinRequestUnits || m.Read > 50 || e.Write > float64(4*InboxUnitsPerMinute/MinRequestUnits) {
		t.Fatalf("%d of 1,000 served, messages %v, ephemeral %v", served, m, e)
	}
}

// When the ephemeral table can't be reached, fetches are limited by each
// instance's own count, not let through.
func TestInboxBudgetWithoutEphemeral(t *testing.T) {
	h, tb := newDeliveryTables(t)
	owner := h.account(t, userID)
	h.sendLargest(t, owner, 50)
	h.server.Limits = &ephemeral.Limiter{DB: throttled{}, Table: tb.ephemeral, Now: func() time.Time { return h.now }}
	tb.meter.Reset()
	served := 0
	for range 100 {
		if status, _ := h.as(t, owner, http.MethodGet, "/inbox", nil, false); status == http.StatusOK {
			served++
		}
	}
	m, _ := tb.cost(t, "GET /inbox, the largest envelopes, ephemeral table down")
	t.Logf("  %d of 100 served", served)
	if served != 1 || m.Read > float64(inboxPage.WorstUnits()) {
		t.Fatalf("%d served, messages %v", served, m)
	}
}

// throttled is an ephemeral table that refuses everything.
type throttled struct{}

var errThrottled = errors.New("throttled")

func (throttled) GetItem(context.Context, *dynamodb.GetItemInput, ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	return nil, errThrottled
}

func (throttled) PutItem(context.Context, *dynamodb.PutItemInput, ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error) {
	return nil, errThrottled
}

func (throttled) UpdateItem(context.Context, *dynamodb.UpdateItemInput, ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	return nil, errThrottled
}

func (throttled) DeleteItem(context.Context, *dynamodb.DeleteItemInput, ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error) {
	return nil, errThrottled
}

// The day's misses hold across instances that learned the count earlier:
// they ask again after a minute, instead of going by what they knew. And a
// replayed page misses a few items, not 50: past AckMissesPerRequest, the
// rest are taken without deleting.
func TestAckMissCapAcrossInstances(t *testing.T) {
	h, tb := newDeliveryTables(t)
	owner := h.account(t, userID)
	page := h.fill(t, owner, AckBatch)
	ack := map[string]any{"ids": page}
	if status, out := h.as(t, owner, http.MethodPost, "/ack", ack, false); status != http.StatusOK {
		t.Fatalf("ack: %d %v", status, out)
	}
	// Ten instances each replay it once, and so know the count.
	tb.meter.Reset()
	primed := make([]*httpapi.Router, 10)
	for i := range primed {
		primed[i] = tb.instance(h)
		if status, err := serve(primed[i], owner, http.MethodPost, "/ack", ack); status != http.StatusOK || err != nil {
			t.Fatalf("replay on instance %d: %d, %v", i, status, err)
		}
	}
	m, _ := tb.cost(t, "POST /ack, a gone page replayed on 10 instances")
	if m.Write > 10*(AckMissesPerRequest+9) {
		t.Fatalf("10 replays deleted %v units", m.Write)
	}
	// Another uses up the rest of the day's.
	for range 1000 {
		h.as(t, owner, http.MethodPost, "/ack", ack, false)
		if m, _ := tb.cost(t, "  a replay"); m.Write == 0 {
			break
		}
	}
	h.now = h.now.Add(2 * time.Minute)
	owner.token = h.token(t, owner.d)
	tb.meter.Reset()
	for _, r := range primed {
		if status, err := serve(r, owner, http.MethodPost, "/ack", ack); status != http.StatusOK || err != nil {
			t.Fatalf("replay: %d, %v", status, err)
		}
	}
	m, _ = tb.cost(t, "POST /ack, a gone page on 10 instances that knew the day's count")
	if m.Write != 0 {
		t.Fatalf("past the day's misses, 10 instances deleted %v units", m.Write)
	}
}

// Without the ephemeral table, misses are limited per instance and minute
// (AckLocalMissesPerMinute), not let through.
func TestAckMissesWithoutEphemeral(t *testing.T) {
	h, tb := newDeliveryTables(t)
	owner := h.account(t, userID)
	page := h.fill(t, owner, AckBatch)
	ack := map[string]any{"ids": page}
	if status, out := h.as(t, owner, http.MethodPost, "/ack", ack, false); status != http.StatusOK {
		t.Fatalf("ack: %d %v", status, out)
	}
	h.server.Limits = &ephemeral.Limiter{DB: throttled{}, Table: tb.ephemeral, Now: func() time.Time { return h.now }}
	tb.meter.Reset()
	for range 100 {
		if status, _ := h.as(t, owner, http.MethodPost, "/ack", ack, false); status != http.StatusOK {
			t.Fatalf("replay: %d", status)
		}
	}
	m, _ := tb.cost(t, "POST /ack, a gone page 100 times, ephemeral table down")
	if m.Write > AckLocalMissesPerMinute+AckMissesPerRequest+9 {
		t.Fatalf("100 replays deleted %v units", m.Write)
	}
}

// A confirmation that claims more than AckBatchUnits is refused, before
// anything is deleted. A page never claims that much.
func TestAckLargeBatchRefused(t *testing.T) {
	h, tb := newDeliveryTables(t)
	owner := h.account(t, userID)
	h.sendLargest(t, owner, 40)
	var listed []string
	for after, pages := "", 0; pages < 2; pages++ {
		path := "/inbox"
		if after != "" {
			path += "?after=" + after
		}
		_, out := h.as(t, owner, http.MethodGet, path, nil, false)
		for _, it := range out["items"].([]any) {
			listed = append(listed, it.(map[string]any)["id"].(string))
		}
		after, _ = out["next"].(string)
	}
	tb.meter.Reset()
	status, out := h.as(t, owner, http.MethodPost, "/ack", map[string]any{"ids": listed}, false)
	m, e := tb.cost(t, "POST /ack, two pages of the largest envelopes at once")
	if status != http.StatusBadRequest || m.Write != 0 || e.Write != 0 {
		t.Fatalf("%d IDs: %d %v, messages %v, ephemeral %v", len(listed), status, out, m, e)
	}
	// One page at a time is fine.
	if status, out := h.as(t, owner, http.MethodPost, "/ack", map[string]any{"ids": listed[:len(listed)/2]}, false); status != http.StatusOK {
		t.Fatalf("a page: %d %v", status, out)
	}
}
