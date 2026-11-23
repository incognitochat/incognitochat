package api

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/smithy-go"

	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
)

// directoryTables is a server on DynamoDB Local, with what the directory
// and ephemeral tables consume metered.
type directoryTables struct {
	meter                *dynamotest.Meter
	client               *dynamodb.Client
	directory, ephemeral string
}

func newDirectoryTables(t *testing.T) (*harness, *directoryTables) {
	t.Helper()
	client := dynamotest.Client(t)
	tb := &directoryTables{meter: dynamotest.NewMeter(client), client: client,
		directory: dynamotest.Table(t, client), ephemeral: dynamotest.Table(t, client)}
	h := newHarness(t)
	h.server.InviteOnly = false
	now := func() time.Time { return h.now }
	h.server.Directory = &directory.Store{DB: tb.meter, Table: tb.directory}
	h.server.Limits = &ephemeral.Limiter{DB: tb.meter, Table: tb.ephemeral, Now: now}
	h.server.Nonces = &ephemeral.Nonces{DB: tb.meter, Table: tb.ephemeral, Now: now}
	h.server.Uploads = &ephemeral.Uploads{DB: tb.meter, Table: tb.ephemeral, Now: now}
	h.server.Media = &memMedia{}
	h.router = httpapi.NewRouter()
	h.server.Routes(h.router)
	return h, tb
}

// cost reports and returns what the directory and ephemeral tables
// consumed since the last call.
func (tb *directoryTables) cost(t *testing.T, what string) (dir, eph dynamotest.Units) {
	t.Helper()
	dir, eph = tb.meter.Units(tb.directory), tb.meter.Units(tb.ephemeral)
	t.Logf("%-62s directory R %5.1f W %5.1f | ephemeral R %4.1f W %4.1f", what, dir.Read, dir.Write, eph.Read, eph.Write)
	tb.meter.Reset()
	return dir, eph
}

// grow gives an account n mailbox records, written directly.
func (tb *directoryTables) grow(t *testing.T, account string, n int) {
	t.Helper()
	var requests []types.WriteRequest
	for range n {
		requests = append(requests, types.WriteRequest{PutRequest: &types.PutRequest{Item: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: "A#" + account},
			"sk": &types.AttributeValueMemberS{Value: "M#" + ids.New()},
		}}})
	}
	for len(requests) > 0 {
		k := min(25, len(requests))
		if _, err := tb.client.BatchWriteItem(context.Background(), &dynamodb.BatchWriteItemInput{
			RequestItems: map[string][]types.WriteRequest{tb.directory: requests[:k]},
		}); err != nil {
			t.Fatal(err)
		}
		requests = requests[k:]
	}
}

// What logins, logged-in requests, registrations and public lookups cost,
// measured.
func TestDirectoryCapacity(t *testing.T) {
	h, tb := newDirectoryTables(t)

	// Any logged-in request: one read of the device and account.
	m := h.account(t, userID)
	tb.meter.Reset()
	if status, _ := h.as(t, m, http.MethodGet, "/account", nil, false); status != http.StatusOK {
		t.Fatalf("account: %d", status)
	}
	if d, _ := tb.cost(t, "GET /account (any logged-in request)"); d.Read != 1 {
		t.Fatalf("a logged-in request read %.1f units", d.Read)
	}

	// A 4,000-mailbox account: registering again reads only what it needs.
	big := newDevice(t)
	big.user = userID + 1
	h.loggedIn(t, big, false)
	tb.grow(t, big.account, 4000)
	tb.meter.Reset()
	if status, _ := h.post(t, "/register", big.registration(t, h.now, nil)); status != http.StatusOK {
		t.Fatalf("retry: %d", status)
	}
	if d, e := tb.cost(t, "POST /register retry, 4,000-mailbox account"); d.Read > 2 || e.Write > 1 {
		t.Fatalf("retry cost %v %v", d, e)
	}
	other := newDevice(t)
	other.user = big.user
	if status, _ := h.post(t, "/register", other.registration(t, h.now, nil)); status != http.StatusConflict {
		t.Fatalf("another key: %d", status)
	}
	if d, e := tb.cost(t, "POST /register another key, 4,000-mailbox account (409)"); d.Read > 2 || e.Write > 1 {
		t.Fatalf("409 cost %v %v", d, e)
	}
	if status, _ := h.post(t, "/accounts/lookup", map[string]any{"initData": launch(t, big.user, "", h.now)}); status != http.StatusOK {
		t.Fatalf("lookup: %d", status)
	}
	// The Telegram item, and the account item eventually consistent (to tell
	// one being deleted).
	if d, _ := tb.cost(t, "POST /accounts/lookup, 4,000-mailbox account"); d.Read != 1.5 {
		t.Fatalf("lookup read %.1f units", d.Read)
	}

	// A replacement refused by the day's limit doesn't list the partition.
	for {
		if ok, _ := h.server.allow(context.Background(), "reg", RegistrationsPerDay, 24*time.Hour, directory.TelegramHash(h.server.Pepper, big.user)); !ok {
			break
		}
	}
	replace := other.registration(t, h.now, nil)
	replace["replace"] = true
	tb.meter.Reset()
	status, out := h.post(t, "/register", replace)
	wantError(t, status, out, http.StatusTooManyRequests, "rate_limited")
	if d, _ := tb.cost(t, "POST /register replace, refused by the daily limit"); d.Read > 2 {
		t.Fatalf("a refused replacement read %.1f units", d.Read)
	}

	// Replays of one launch are counted, the retries and refusals too, and
	// once the day's attempts are used up nothing is read.
	body := big.registration(t, h.now, nil)
	refused := 0
	for range RegisterAttemptsPerDay {
		if status, _ := h.post(t, "/register", body); status == http.StatusTooManyRequests {
			refused++
		}
	}
	tb.meter.Reset()
	status, out = h.post(t, "/register", body)
	wantError(t, status, out, http.StatusTooManyRequests, "rate_limited")
	if d, _ := tb.cost(t, "POST /register, attempts used up"); refused == 0 || d.Read != 0 {
		t.Fatalf("%d refused; refusal read %.1f units", refused, d.Read)
	}

	// Logins: one eventually consistent read, and what can be refused
	// without the device's key reads nothing.
	if status, _ := h.post(t, "/session", m.d.login(t, h.now)); status != http.StatusOK {
		t.Fatalf("login: %d", status)
	}
	if d, _ := tb.cost(t, "POST /session"); d.Read != 0.5 {
		t.Fatalf("a login read %.1f units", d.Read)
	}
	stranger := newDevice(t)
	stranger.account = ids.New()
	if status, _ := h.post(t, "/session", stranger.login(t, h.now)); status != http.StatusUnauthorized {
		t.Fatalf("stranger: %d", status)
	}
	// DynamoDB Local reports nothing for a query that finds nothing;
	// DynamoDB charges the minimum, half a unit.
	if d, _ := tb.cost(t, "POST /session, random IDs"); d.Read > 0.5 {
		t.Fatalf("a login read %.1f units", d.Read)
	}
	stale := m.d.login(t, h.now.Add(-time.Hour))
	badNonce := m.d.login(t, h.now)
	badNonce["nonce"] = "short"
	shortSig := m.d.login(t, h.now)
	shortSig["signature"] = b64(make([]byte, 10))
	for name, c := range map[string]struct {
		body map[string]any
		code string
	}{
		"stale time":      {stale, "clock_skew"},
		"bad nonce":       {badNonce, "login_refused"},
		"short signature": {shortSig, "login_refused"},
	} {
		status, out := h.post(t, "/session", c.body)
		wantError(t, status, out, http.StatusUnauthorized, c.code)
		if d, _ := tb.cost(t, "POST /session, "+name); d.Read != 0 {
			t.Fatalf("%s: read %.1f units", name, d.Read)
		}
	}

	// Public lookups of random IDs: half a unit.
	h.call(t, nil, "", http.MethodGet, "/links/"+b64(randomBytes(t, 8)), nil, false)
	if d, _ := tb.cost(t, "GET /links/{random}"); d.Read != 0.5 {
		t.Fatalf("bundle read %.1f units", d.Read)
	}
	h.call(t, nil, "", http.MethodGet, "/media/"+ids.New(), nil, false)
	if _, e := tb.cost(t, "GET /media/{random}"); e.Read != 0.5 {
		t.Fatalf("download lookup read %.1f units", e.Read)
	}
	// A delete with a random ID: half a unit too (the firewall's
	// lookups-total is sized by these). A fresh upload URL reads strongly,
	// a whole unit, and writes nothing for a random ID either.
	secret := map[string]any{"secret": b64(randomBytes(t, 16))}
	if status, out := h.post(t, "/media/"+ids.New()+"/delete", secret); status != http.StatusNotFound {
		t.Fatalf("delete: %d %v", status, out)
	}
	if d, e := tb.cost(t, "POST /media/{random}/delete"); e.Read != 0.5 || e.Write != 0 || d.Read != 0 {
		t.Fatalf("delete lookup: ephemeral %+v, directory %+v", e, d)
	}
	if status, out := h.post(t, "/media/"+ids.New()+"/upload", secret); status != http.StatusNotFound {
		t.Fatalf("renew: %d %v", status, out)
	}
	if d, e := tb.cost(t, "POST /media/{random}/upload"); e.Read != 1 || e.Write != 0 || d.Read != 0 {
		t.Fatalf("renew lookup: ephemeral %+v, directory %+v", e, d)
	}
}

// What blocking costs (POST /mailboxes/{id}/discard), measured. An ID that
// isn't the caller's to discard (random, someone else's, a link's intro
// mailbox, one discarded already) reads half a directory unit more than
// any logged-in request and writes nothing, so a device's requests can't
// spend the directory's writes this way. Only a mailbox of its own is
// deleted, which it had to make first (MailboxesPerDay).
func TestDiscardCapacity(t *testing.T) {
	h, tb := newDirectoryTables(t)
	ctx := context.Background()
	owner := h.account(t, userID)
	other := h.account(t, userID+1)
	mailboxes := func(m member) []any {
		t.Helper()
		status, out := h.as(t, m, http.MethodPost, "/mailboxes", map[string]any{"count": 2}, false)
		if status != http.StatusCreated {
			t.Fatalf("mailboxes: %d %v", status, out)
		}
		return out["mailboxes"].([]any)
	}
	mine, theirs := mailboxes(owner), mailboxes(other)
	l := newLinkKeys(t)
	status, out := h.as(t, owner, http.MethodPost, "/links", l.create(t, h.now), true)
	if status != http.StatusCreated {
		t.Fatalf("link: %d %v", status, out)
	}
	intro := out["mailbox"].(string)

	// Each reads what any logged-in request does (one unit) and, for a
	// well-formed ID, the mailbox (half a unit). Only the caller's own
	// mailbox is then deleted, by one conditional delete (a write unit),
	// and its record and count go in two more single-item writes: 3 write
	// units in all. Before, every well-formed ID went straight to one
	// transaction of three items, which DynamoDB bills two write units an
	// item even when its condition cancels it: 6 for any ID. The ephemeral
	// table takes at most the device's count of requests, in batches.
	written := len(tb.meter.Written(tb.directory))
	for _, c := range []struct {
		what   string
		id     string
		status int
		read   float64
		calls  []string // the directory's
		items  int      // the directory's items written
	}{
		{"own mailbox (a block)", mine[0].(string), http.StatusOK, 1.5, []string{"Query", "GetItem", "DeleteItem", "DeleteItem", "UpdateItem"}, 3},
		{"the same again (a replay)", mine[0].(string), http.StatusNotFound, 1.5, []string{"Query", "GetItem"}, 0},
		{"someone else's mailbox", theirs[0].(string), http.StatusNotFound, 1.5, []string{"Query", "GetItem"}, 0},
		{"own link's intro mailbox", intro, http.StatusNotFound, 1.5, []string{"Query", "GetItem"}, 0},
		{"random ID", ids.New(), http.StatusNotFound, 1.5, []string{"Query", "GetItem"}, 0},
		{"malformed ID", "x", http.StatusNotFound, 1, []string{"Query"}, 0},
	} {
		tb.meter.Reset()
		status, out := h.as(t, owner, http.MethodPost, "/mailboxes/"+c.id+"/discard", nil, false)
		calls := tb.directoryCalls()
		d, e := tb.cost(t, "POST /mailboxes/{id}/discard, "+c.what)
		if status != c.status || (status != http.StatusOK && out["error"] != "not_found") {
			t.Errorf("%s: %d %v, want %d", c.what, status, out, c.status)
		}
		items := len(tb.meter.Written(tb.directory)) - written
		written += items
		t.Logf("  directory calls %v, items written %d: %d write units at DynamoDB's prices", calls, items, billed(calls))
		if d.Read != c.read || !slices.Equal(calls, c.calls) || items != c.items || (c.items == 0 && d.Write != 0) ||
			e.Read != 0 || e.Write > 1 {
			t.Errorf("%s: directory %+v, calls %v, %d items, ephemeral %+v; want directory R %.1f, calls %v, %d items",
				c.what, d, calls, items, e, c.read, c.calls, c.items)
		}
	}

	// A block does what it did: the mailbox is gone and its place freed;
	// someone else's, and the intro mailbox, are untouched.
	if _, err := h.server.Directory.Mailbox(ctx, mine[0].(string)); !errors.Is(err, directory.ErrNotFound) {
		t.Fatalf("discarded mailbox: %v", err)
	}
	for _, id := range []string{mine[1].(string), theirs[0].(string), intro} {
		if _, err := h.server.Directory.Mailbox(ctx, id); err != nil {
			t.Fatalf("mailbox %s: %v", id, err)
		}
	}
	if d, err := h.server.Directory.Device(ctx, owner.d.account, owner.d.id, h.now); err != nil || d.Mailboxes != 1 {
		t.Fatalf("mailboxes owned after a discard: %d, %v", d.Mailboxes, err)
	}
}

// directoryCalls returns the operations of the calls made to the directory
// since the last Reset, in order.
func (tb *directoryTables) directoryCalls() []string {
	var ops []string
	for _, c := range tb.meter.Calls() {
		if op, table, _ := strings.Cut(c, " "); table == tb.directory {
			ops = append(ops, op)
		}
	}
	return ops
}

// billed is what a discard's directory writes cost at DynamoDB's prices: a
// write unit for each delete or update of a small item, refused or not. (A
// discard makes no transaction; one would cost two units an item, which
// DynamoDB Local doesn't report.)
func billed(calls []string) int {
	units := 0
	for _, op := range calls {
		switch op {
		case "DeleteItem", "UpdateItem":
			units++
		case "TransactWriteItems":
			units += 1000 // not expected: fail the bounds
		}
	}
	return units
}

// recordWrites is the directory's DB with the deletes of the accounts'
// mailbox records (sort key M#<mailbox>) failing.
type recordWrites struct {
	*dynamotest.Meter
	fail error
}

func (r *recordWrites) DeleteItem(ctx context.Context, in *dynamodb.DeleteItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error) {
	if sk, ok := in.Key["sk"].(*types.AttributeValueMemberS); ok && strings.HasPrefix(sk.Value, "M#") {
		return nil, r.fail
	}
	return r.Meter.DeleteItem(ctx, in, opts...)
}

// mailboxReads is the directory's DB with the reads of one mailbox failing,
// or held until n of them are in, so that all of them find it.
type mailboxReads struct {
	*dynamotest.Meter
	pk   string // the mailbox item's
	fail error
	n    int

	mu   sync.Mutex
	seen int
	all  chan struct{}
}

func (m *mailboxReads) GetItem(ctx context.Context, in *dynamodb.GetItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	if pk, ok := in.Key["pk"].(*types.AttributeValueMemberS); !ok || pk.Value != m.pk {
		return m.Meter.GetItem(ctx, in, opts...)
	}
	if m.fail != nil {
		return nil, m.fail
	}
	out, err := m.Meter.GetItem(ctx, in, opts...)
	m.mu.Lock()
	if m.seen++; m.seen == m.n {
		close(m.all)
	}
	m.mu.Unlock()
	select {
	case <-m.all:
	case <-time.After(10 * time.Second):
	}
	return out, err
}

// Copies of a block of one's own mailbox sent at once all find it when they
// read it, and one conditional delete decides: one is answered 200, the
// rest not_found, each refused for a write unit. With one transaction of
// three items, each copy's was cancelled, and billed 6 write units.
// (DynamoDB Local reports single-item writes as DynamoDB bills them, so the
// meter's write units are what these cost.)
func TestDiscardRaceCapacity(t *testing.T) {
	h, tb := newDirectoryTables(t)
	ctx := context.Background()
	owner := h.account(t, userID)
	status, out := h.as(t, owner, http.MethodPost, "/mailboxes", map[string]any{"count": 1}, false)
	if status != http.StatusCreated {
		t.Fatalf("mailboxes: %d %v", status, out)
	}
	mailbox := out["mailboxes"].([]any)[0].(string)
	const copies = 20
	h.server.Directory = &directory.Store{DB: &mailboxReads{Meter: tb.meter, pk: "M#" + mailbox, n: copies, all: make(chan struct{})}, Table: tb.directory}

	tb.meter.Reset()
	var wg sync.WaitGroup
	answers := make(chan int, copies)
	for range copies {
		wg.Go(func() {
			status, err := serve(h.router, owner, http.MethodPost, "/mailboxes/"+mailbox+"/discard", nil)
			if err != nil {
				t.Error(err)
			}
			answers <- status
		})
	}
	wg.Wait()
	close(answers)
	byStatus := map[int]int{}
	for status := range answers {
		byStatus[status]++
	}
	calls := tb.directoryCalls()
	d, e := tb.cost(t, "POST /mailboxes/{id}/discard, 20 copies of a block at once")
	counts := map[string]int{}
	for _, op := range calls {
		counts[op]++
	}
	t.Logf("  answers %v, directory calls %v: %d write units at DynamoDB's prices (one transaction of three items each: %d)",
		byStatus, counts, billed(calls), copies*6)
	if byStatus[http.StatusOK] != 1 || byStatus[http.StatusNotFound] != copies-1 ||
		counts["DeleteItem"] != copies+1 || counts["UpdateItem"] != 1 || counts["TransactWriteItems"] != 0 ||
		billed(calls) != copies+2 || d.Write != float64(billed(calls)) ||
		d.Read != copies*1.5 || e.Read != 0 || e.Write > copies/SessionBatch+1 {
		t.Fatalf("answers %v, calls %v, directory %+v, ephemeral %+v", byStatus, counts, d, e)
	}
	if got, err := h.server.Directory.Device(ctx, owner.d.account, owner.d.id, h.now); err != nil || got.Mailboxes != 0 {
		t.Fatalf("mailboxes owned after the block: %d, %v", got.Mailboxes, err)
	}
}

// Blocks of different mailboxes of one's own at once each cost 3 write
// units: their records and counts go in single-item writes, which take
// turns on the account item, where transactions naming it at once would
// cancel each other, each cancelled one billed and tried again.
func TestDiscardManyCapacity(t *testing.T) {
	h, tb := newDirectoryTables(t)
	ctx := context.Background()
	owner := h.account(t, userID)
	var mailboxes []string
	for range 2 {
		status, out := h.as(t, owner, http.MethodPost, "/mailboxes", map[string]any{"count": MailboxBatch}, false)
		if status != http.StatusCreated {
			t.Fatalf("mailboxes: %d %v", status, out)
		}
		for _, id := range out["mailboxes"].([]any) {
			mailboxes = append(mailboxes, id.(string))
		}
	}

	tb.meter.Reset()
	var wg sync.WaitGroup
	answers := make(chan int, len(mailboxes))
	for _, id := range mailboxes {
		wg.Go(func() {
			status, err := serve(h.router, owner, http.MethodPost, "/mailboxes/"+id+"/discard", nil)
			if err != nil {
				t.Error(err)
			}
			answers <- status
		})
	}
	wg.Wait()
	close(answers)
	byStatus := map[int]int{}
	for status := range answers {
		byStatus[status]++
	}
	calls := tb.directoryCalls()
	d, _ := tb.cost(t, "POST /mailboxes/{id}/discard, blocks of 20 mailboxes at once")
	counts := map[string]int{}
	for _, op := range calls {
		counts[op]++
	}
	n := len(mailboxes)
	t.Logf("  answers %v, directory calls %v: %d write units at DynamoDB's prices", byStatus, counts, billed(calls))
	if byStatus[http.StatusOK] != n || counts["DeleteItem"] != 2*n || counts["UpdateItem"] != n || counts["TransactWriteItems"] != 0 ||
		billed(calls) != 3*n || d.Write != float64(3*n) {
		t.Fatalf("answers %v, calls %v, directory %+v", byStatus, counts, d)
	}
	if got, err := h.server.Directory.Device(ctx, owner.d.account, owner.d.id, h.now); err != nil || got.Mailboxes != 0 {
		t.Fatalf("mailboxes owned after the blocks: %d, %v", got.Mailboxes, err)
	}
}

// Once the mailbox is deleted the block holds, and is answered 200 even if
// its record and count can't then be put right: the app records the block.
// The failure is logged with the route and the error's kind, never the
// mailbox or the account.
func TestDiscardForgetFailureAnswersOK(t *testing.T) {
	h, tb := newDirectoryTables(t)
	ctx := context.Background()
	owner := h.account(t, userID)
	status, out := h.as(t, owner, http.MethodPost, "/mailboxes", map[string]any{"count": 1}, false)
	if status != http.StatusCreated {
		t.Fatalf("mailboxes: %d %v", status, out)
	}
	mailbox := out["mailboxes"].([]any)[0].(string)
	store := h.server.Directory
	throttled := &smithy.OperationError{ServiceID: "DynamoDB", OperationName: "DeleteItem", Err: &types.ProvisionedThroughputExceededException{}}
	h.server.Directory = &directory.Store{DB: &recordWrites{Meter: tb.meter, fail: throttled}, Table: tb.directory}
	h.logs.Reset()
	status, out = h.as(t, owner, http.MethodPost, "/mailboxes/"+mailbox+"/discard", nil, false)
	if status != http.StatusOK {
		t.Fatalf("a block whose record couldn't be forgotten: %d %v", status, out)
	}
	logs := h.logs.String()
	if !strings.Contains(logs, `"msg":"mailbox discarded, its record not forgotten"`) || !strings.Contains(logs, `"route":"POST /mailboxes/{id}/discard"`) ||
		!strings.Contains(logs, `"error_kind":"*smithy.OperationError"`) || strings.Contains(logs, mailbox) || strings.Contains(logs, owner.d.account) {
		t.Fatalf("logs = %s", logs)
	}
	if _, err := store.Mailbox(ctx, mailbox); !errors.Is(err, directory.ErrNotFound) {
		t.Fatalf("the mailbox after a block answered 200: %v", err)
	}
	// What it leaves: the record, and the count with it.
	if owned, err := store.Mailboxes(ctx, owner.d.account); err != nil || !slices.Contains(owned, mailbox) {
		t.Fatalf("records after a failed forget: %v, %v", owned, err)
	}
}

// A read of the mailbox that fails is answered 503, never not_found: the
// app takes not_found for a block done, and would record one that
// discarded nothing.
func TestDiscardReadFailureAnswersUnavailable(t *testing.T) {
	h, tb := newDirectoryTables(t)
	owner := h.account(t, userID)
	status, out := h.as(t, owner, http.MethodPost, "/mailboxes", map[string]any{"count": 1}, false)
	if status != http.StatusCreated {
		t.Fatalf("mailboxes: %d %v", status, out)
	}
	mailbox := out["mailboxes"].([]any)[0].(string)
	store := h.server.Directory
	throttled := &smithy.OperationError{ServiceID: "DynamoDB", OperationName: "GetItem", Err: &types.ProvisionedThroughputExceededException{}}
	h.server.Directory = &directory.Store{DB: &mailboxReads{Meter: tb.meter, pk: "M#" + mailbox, fail: throttled}, Table: tb.directory}
	status, out = h.as(t, owner, http.MethodPost, "/mailboxes/"+mailbox+"/discard", nil, false)
	wantError(t, status, out, http.StatusServiceUnavailable, "unavailable")
	if _, err := store.Mailbox(context.Background(), mailbox); err != nil {
		t.Fatalf("mailbox after a failed read: %v", err)
	}
}

// Every registration attempt that reaches the directory counts, retries
// and account_exists refusals included.
func TestRegisterAttemptsAreCounted(t *testing.T) {
	h := newHarness(t)
	d := newDevice(t)
	body := d.registration(t, h.now, nil)
	if status, out := h.post(t, "/register", body); status != http.StatusOK {
		t.Fatalf("register: %d %v", status, out)
	}
	other := newDevice(t)
	for i := 1; i < RegisterAttemptsPerDay; i++ {
		b := body
		want := http.StatusOK
		if i%2 == 0 {
			b, want = other.registration(t, h.now, nil), http.StatusConflict
		}
		if status, out := h.post(t, "/register", b); status != want {
			t.Fatalf("attempt %d: %d %v", i+1, status, out)
		}
	}
	status, out := h.post(t, "/register", body)
	wantError(t, status, out, http.StatusTooManyRequests, "rate_limited")
	// Attempts that fail before the directory, like a bad signature, don't count.
	h2 := newHarness(t)
	bad := newDevice(t).registration(t, h2.now, nil)
	bad["deviceSig"] = b64(make([]byte, 64))
	for range RegisterAttemptsPerDay + 1 {
		status, out := h2.post(t, "/register", bad)
		wantError(t, status, out, http.StatusUnauthorized, "signature_rejected")
	}
}
