package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
	"github.com/incognitochat/incognitochat/backend/internal/envelope"
	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/inbox"
)

// deliveryTables is a server on DynamoDB Local, with what each table
// consumes metered.
type deliveryTables struct {
	meter               *dynamotest.Meter
	directory, messages string
	ephemeral           string
}

func newDeliveryTables(t *testing.T) (*harness, *deliveryTables) {
	t.Helper()
	client := dynamotest.Client(t)
	tb := &deliveryTables{meter: dynamotest.NewMeter(client),
		directory: dynamotest.Table(t, client), messages: dynamotest.Table(t, client), ephemeral: dynamotest.Table(t, client)}
	h := newHarness(t)
	h.server.InviteOnly = false
	tb.wire(h)
	return h, tb
}

// testTimeout is the limiter's timeout in these tests: DynamoDB Local can
// take more than a second under 100 requests at once, which would make
// the limits fall back to each instance's own count.
const testTimeout = 10 * time.Second

// wire gives h's server fresh stores on the tables, with nothing in
// memory: another instance of the function.
func (tb *deliveryTables) wire(h *harness) {
	now := func() time.Time { return h.now }
	h.server.Directory = &directory.Store{DB: tb.meter, Table: tb.directory}
	h.server.Inbox = &inbox.Store{DB: tb.meter, Table: tb.messages}
	h.server.Limits = &ephemeral.Limiter{DB: tb.meter, Table: tb.ephemeral, Now: now, Timeout: testTimeout}
	h.server.Nonces = &ephemeral.Nonces{DB: tb.meter, Table: tb.ephemeral, Now: now}
	h.server.Spent = &ephemeral.Spent{DB: tb.meter, Table: tb.ephemeral, Now: now}
	h.router = httpapi.NewRouter()
	h.server.Routes(h.router)
}

// instance is another instance of the function, alongside h's: its own
// stores on the tables, with nothing in memory, and its own router.
func (tb *deliveryTables) instance(h *harness) *httpapi.Router {
	now := func() time.Time { return h.now }
	o := h.server
	s := Server{
		Telegram: o.Telegram, Sessions: o.Sessions, Nonces: o.Nonces, Pepper: o.Pepper, Log: o.Log, Now: o.Now,
		InviteOnly: o.InviteOnly, Admins: o.Admins, Pause: o.Pause, Issuer: o.Issuer, MediaIssuer: o.MediaIssuer,
		Notices: o.Notices, Push: o.Push, Sockets: o.Sockets, Media: o.Media, Uploads: o.Uploads,
		Switches:  o.Switches,
		Directory: &directory.Store{DB: tb.meter, Table: tb.directory},
		Inbox:     &inbox.Store{DB: tb.meter, Table: tb.messages},
		Limits:    &ephemeral.Limiter{DB: tb.meter, Table: tb.ephemeral, Now: now, Timeout: testTimeout},
		Spent:     &ephemeral.Spent{DB: tb.meter, Table: tb.ephemeral, Now: now},
	}
	r := httpapi.NewRouter()
	s.Routes(r)
	return r
}

// serve makes a logged-in request without a device signature on r, and
// returns its status; it can run alongside others.
func serve(r *httpapi.Router, m member, method, path string, body any) (int, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return 0, err
	}
	var req httpapi.Request
	req.RawPath = path
	req.RequestContext.HTTP.Method = method
	req.Headers = map[string]string{"content-type": "application/json", "x-session": m.token}
	if body != nil {
		req.Body = string(raw)
	}
	resp, err := r.Serve(context.Background(), req)
	return resp.StatusCode, err
}

// cost reports and returns what the messages and ephemeral tables consumed
// since the last call.
func (tb *deliveryTables) cost(t *testing.T, what string) (messages, eph dynamotest.Units) {
	t.Helper()
	messages, eph = tb.meter.Units(tb.messages), tb.meter.Units(tb.ephemeral)
	d := tb.meter.Units(tb.directory)
	t.Logf("%-58s directory R %5.1f | messages R %6.1f W %6.1f | ephemeral R %4.1f W %5.1f",
		what, d.Read, messages.Read, messages.Write, eph.Read, eph.Write)
	tb.meter.Reset()
	return messages, eph
}

// What inbox fetches, confirmations and capped sends cost, measured. DynamoDB
// Local counts 2 write units for deleting an item that isn't there, where
// DynamoDB charges 1.
func TestDeliveryCapacity(t *testing.T) {
	h, tb := newDeliveryTables(t)
	owner := h.account(t, userID)

	// An empty inbox: polling writes nothing; a fresh instance reads the
	// day's and the minute's counts once.
	tb.meter.Reset()
	h.as(t, owner, http.MethodGet, "/inbox", nil, false)
	if m, e := tb.cost(t, "GET /inbox, empty"); m.Read > 0.5 || e.Write != 0 || e.Read > 1 {
		t.Fatal("polling an empty inbox costs too much")
	}

	// Forged IDs are refused before anything is deleted or counted.
	random := make([]string, 100)
	for i := range random {
		random[i] = ids.New()
	}
	for _, n := range []int{100, AckBatch} {
		status, _ := h.as(t, owner, http.MethodPost, "/ack", map[string]any{"ids": random[:n]}, false)
		if m, e := tb.cost(t, "POST /ack, random IDs"); status != http.StatusBadRequest || m.Write != 0 || e.Write != 0 {
			t.Fatalf("%d random IDs: %d, cost %v %v", n, status, m, e)
		}
	}

	// 50 of the largest envelopes waiting: a page claims at most
	// AckBatchUnits to confirm (15 of them).
	_, out := h.as(t, owner, http.MethodPost, "/mailboxes", map[string]any{"count": 2}, false)
	boxes := out["mailboxes"].([]any)
	largest := make([]byte, envelope.MaxLen)
	largest[0], largest[1] = envelope.Suite, envelope.MaxWraps
	for i := range 50 {
		if status, out := h.post(t, "/send", map[string]any{"mailbox": boxes[i%2], "envelope": base64.RawURLEncoding.EncodeToString(largest), "tokens": mintTokens(t, h.now, envelope.MaxTokens)}); status != http.StatusOK {
			t.Fatalf("send: %d %v", status, out)
		}
	}
	tb.meter.Reset()
	status, out := h.as(t, owner, http.MethodGet, "/inbox", nil, false)
	m, e := tb.cost(t, "GET /inbox, 50 max-size envelopes waiting")
	items := out["items"].([]any)
	t.Logf("  a page of %d items, more %v", len(items), out["more"])
	if status != http.StatusOK || m.Read > float64(inboxPage.WorstUnits()) || e.Write > 3 || out["more"] != true {
		t.Fatalf("inbox: %d, cost %v %v", status, m, e)
	}
	var page []string
	for _, it := range items {
		page = append(page, it.(map[string]any)["id"].(string))
	}
	if status, _ := h.as(t, owner, http.MethodPost, "/ack", map[string]any{"ids": page}, false); status != http.StatusOK {
		t.Fatalf("ack: %d", status)
	}
	if m, e := tb.cost(t, "POST /ack, that page"); m.Write > float64(20*len(page)) || e.Write > 1 {
		t.Fatalf("ack cost %v %v", m, e)
	}

	// Replaying a confirmation costs a write unit per gone item, counted
	// against the person's day of misses (in batches); past it, nothing.
	for range 100 {
		if status, _ := h.as(t, owner, http.MethodPost, "/ack", map[string]any{"ids": page}, false); status != http.StatusOK {
			t.Fatalf("replay: %d", status)
		}
	}
	m, e = tb.cost(t, "POST /ack, that page replayed 100 times")
	if m.Write > AckMissesPerDay+float64(len(page)) || e.Write > AckMissesPerDay/AckBatch+2 {
		t.Fatalf("replays: %v %v", m, e)
	}
	h.as(t, owner, http.MethodPost, "/ack", map[string]any{"ids": page}, false)
	if m, e := tb.cost(t, "POST /ack, past the day's misses"); m.Write != 0 || e.Write != 0 {
		t.Fatalf("past the day's misses, an ack costs %v %v", m, e)
	}

	// One token replayed against a capped mailbox.
	capped := ids.New()
	env := clientEnvelope(t)
	for range SendsPerMailboxPerMinute {
		h.post(t, "/send", map[string]any{"mailbox": capped, "envelope": env, "token": mintToken(t, h.now)})
	}
	token := mintToken(t, h.now)
	tb.meter.Reset()
	for range 20 {
		if status, _ := h.post(t, "/send", map[string]any{"mailbox": capped, "envelope": env, "token": token}); status != http.StatusTooManyRequests {
			t.Fatalf("send at the cap: %d", status)
		}
	}
	if _, e := tb.cost(t, "POST /send, one token 20 times at a capped mailbox"); e.Write != 0 {
		t.Fatalf("replays cost %v write units", e.Write)
	}
	// On 20 instances that know nothing yet: the token is given back once.
	answers := map[int]int{}
	for range 20 {
		tb.wire(h)
		status, _ := h.post(t, "/send", map[string]any{"mailbox": capped, "envelope": env, "token": token})
		answers[status]++
	}
	_, e = tb.cost(t, "  the same, each on a fresh instance")
	t.Logf("  answers %v", answers)
	if e.Write > 25 || answers[http.StatusUnauthorized] < 17 {
		t.Fatalf("fresh instances: %v, %v write units", answers, e.Write)
	}
}
