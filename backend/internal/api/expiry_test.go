package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
)

// Unset is the dry run; a value it doesn't know deletes nothing.
func TestParseExpiryMode(t *testing.T) {
	for in, want := range map[string]ExpiryMode{
		"": ExpiryDryRun, "dry-run": ExpiryDryRun, "on": ExpiryOn, "off": ExpiryOff,
		"ON": ExpiryOff, "true": ExpiryOff, "dry run": ExpiryOff,
	} {
		if got := ParseExpiryMode(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

// newExpiryTables is newDeliveryTables with the directory's last-use index,
// socket records on the ephemeral table, and the expiry's pauses moving
// the clock on instead of waiting.
func newExpiryTables(t *testing.T) (*harness, *deliveryTables) {
	t.Helper()
	client := dynamotest.Client(t)
	tb := &deliveryTables{meter: dynamotest.NewMeter(client),
		directory: dynamotest.DirectoryTable(t, client), messages: dynamotest.Table(t, client), ephemeral: dynamotest.Table(t, client)}
	h := newHarness(t)
	h.server.InviteOnly = false
	tb.wire(h)
	h.server.Unused = h.server.Directory.(*directory.Store)
	h.server.Sockets = &ephemeral.Sockets{DB: tb.meter, Table: tb.ephemeral, Now: func() time.Time { return h.now },
		Key: ephemeral.SocketKey([]byte("socket-socket-socket-socket-key!"))}
	h.server.sleep = func(_ context.Context, d time.Duration) error {
		h.now = h.now.Add(d)
		return nil
	}
	return h, tb
}

// setUpAt sets up an account for a new Telegram user at t (its month of
// use), logged in then, and moves the clock back to now.
func (h *harness) setUpAt(t *testing.T, user int64, at time.Time) member {
	t.Helper()
	now := h.now
	h.now = at
	defer func() { h.now = now }()
	return h.account(t, user)
}

// items returns every item of a table.
func (tb *deliveryTables) items(t *testing.T, table string) []map[string]types.AttributeValue {
	t.Helper()
	var all []map[string]types.AttributeValue
	pages := dynamodb.NewScanPaginator(tb.meter.Client, &dynamodb.ScanInput{TableName: &table, ConsistentRead: aws.Bool(true)})
	for pages.HasMorePages() {
		page, err := pages.NextPage(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		all = append(all, page.Items...)
	}
	return all
}

// loggedCount returns the count logged with msg, or -1 if none was.
func (h *harness) loggedCount(t *testing.T, msg string) int {
	t.Helper()
	for _, line := range strings.Split(strings.TrimSpace(h.logs.String()), "\n") {
		var entry struct {
			Msg   string `json:"msg"`
			Route string `json:"route"`
			Count *int   `json:"count"`
		}
		if line == "" || json.Unmarshal([]byte(line), &entry) != nil {
			continue
		}
		if entry.Msg == msg && entry.Route == expiryRoute && entry.Count != nil {
			return *entry.Count
		}
	}
	return -1
}

// mentions reports whether an item's key or any of its string attributes
// holds s.
func mentions(it map[string]types.AttributeValue, s string) bool {
	for _, v := range it {
		if v, ok := v.(*types.AttributeValueMemberS); ok && strings.Contains(v.Value, s) {
			return true
		}
	}
	return false
}

// An account nobody has used for more than 12 months goes completely, as
// with DELETE /account: its link (only the ID's tombstone stays), mailboxes,
// waiting envelopes, notice data, devices, socket records and the Telegram
// item. One used 11 or 12 months ago stays, and so does one with no month
// (set up before months were stored), however old. The dry run only counts,
// and nothing logged names an account or a month.
func TestExpireAccounts(t *testing.T) {
	h, tb := newExpiryTables(t)
	ctx := context.Background()
	store := h.server.Directory.(*directory.Store)

	// start is in January 2027: accounts last used in December 2025 or
	// before have expired.
	old := h.setUpAt(t, userID, start.AddDate(0, -13, 0))
	elevenMonths := h.setUpAt(t, userID+1, start.AddDate(0, -11, 0))
	twelveMonths := h.setUpAt(t, userID+2, start.AddDate(0, -12, 0))
	noMonth := h.setUpAt(t, userID+3, start.AddDate(-3, 0, 0))
	if _, err := tb.meter.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:        &tb.directory,
		Key:              map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: "A#" + noMonth.d.account}, "sk": &types.AttributeValueMemberS{Value: "A"}},
		UpdateExpression: aws.String("REMOVE lu"),
	}); err != nil {
		t.Fatal(err)
	}

	// The old account has a link, mailboxes, a waiting envelope, notices
	// and an open socket, all from when it was last used.
	h.now = start.AddDate(0, -13, 0)
	l := newLinkKeys(t)
	if status, out := h.as(t, old, http.MethodPost, "/links", l.create(t, h.now), true); status != http.StatusCreated {
		t.Fatalf("link: %d %v", status, out)
	}
	_, out := h.as(t, old, http.MethodPost, "/mailboxes", map[string]any{"count": 3}, false)
	boxes := out["mailboxes"].([]any)
	if err := store.SetNotices(ctx, old.d.account, []byte("sealed chat"), "en"); err != nil {
		t.Fatal(err)
	}
	h.now = start
	if status, out := h.post(t, "/send", map[string]any{"mailbox": boxes[0], "envelope": clientEnvelope(t), "tokens": mintTokens(t, h.now, 1)}); status != http.StatusOK {
		t.Fatalf("send: %d %v", status, out)
	}
	if n := tb.waiting(t, old.d.account, old.d.id); n != 1 {
		t.Fatalf("%d envelopes wait", n)
	}
	sockets := h.server.Sockets.(*ephemeral.Sockets)
	if err := sockets.Open(ctx, old.d.account, "connection-1"); err != nil {
		t.Fatal(err)
	}

	// The dry run counts it, and deletes nothing.
	before := len(tb.items(t, tb.directory))
	h.server.Expiry = ExpiryDryRun
	if err := h.server.ExpireAccounts(ctx); err != nil {
		t.Fatal(err)
	}
	if n := h.loggedCount(t, "account expiry dry run: accounts it would delete"); n != 1 {
		t.Fatalf("the dry run counted %d: %s", n, h.logs)
	}
	if after := len(tb.items(t, tb.directory)); after != before {
		t.Fatalf("the dry run changed the directory: %d items, then %d", before, after)
	}
	if d, err := store.AccountState(ctx, old.d.account); err != nil || d.Deleting {
		t.Fatalf("after the dry run: %+v, %v", d, err)
	}
	// Off does nothing at all.
	h.server.Expiry = ExpiryOff
	h.logs.Reset()
	if err := h.server.ExpireAccounts(ctx); err != nil || h.logs.Len() != 0 {
		t.Fatalf("off: %v, logged %s", err, h.logs)
	}

	h.server.Expiry = ExpiryOn
	if err := h.server.ExpireAccounts(ctx); err != nil {
		t.Fatal(err)
	}
	if n := h.loggedCount(t, "account expiry: accounts deleted"); n != 1 {
		t.Fatalf("deleted %d: %s", n, h.logs)
	}

	// Nothing of it is left but its link ID's and signing key's tombstones,
	// which name nobody.
	for _, it := range tb.items(t, tb.directory) {
		if mentions(it, old.d.account) || mentions(it, directory.TelegramHash(h.server.Pepper, userID)) {
			t.Errorf("left behind: %v %v", it["pk"], it["sk"])
		}
	}
	if _, err := store.Bundle(ctx, l.id); !errors.Is(err, directory.ErrNotFound) {
		t.Fatalf("its link: %v", err)
	}
	for _, b := range boxes {
		if _, err := store.Mailbox(ctx, b.(string)); !errors.Is(err, directory.ErrNotFound) {
			t.Fatalf("its mailbox: %v", err)
		}
	}
	if n := tb.waiting(t, old.d.account, old.d.id); n != 0 {
		t.Fatalf("%d envelopes still wait", n)
	}
	if conns, err := sockets.Connections(ctx, old.d.account); err != nil || len(conns) != 0 {
		t.Fatalf("its sockets: %v, %v", conns, err)
	}
	status, out := h.post(t, "/session", old.d.login(t, h.now))
	wantError(t, status, out, http.StatusUnauthorized, "login_refused")

	// The others stay, and can log in.
	for name, m := range map[string]member{"11 months": elevenMonths, "12 months": twelveMonths, "no month": noMonth} {
		if status, out := h.post(t, "/session", m.d.login(t, h.now)); status != http.StatusOK {
			t.Fatalf("%s: %d %v", name, status, out)
		}
	}

	// Nothing logged names an account or a month.
	for _, s := range []string{old.d.account, elevenMonths.d.account, "2025-12", "2026-01", "2026-02"} {
		if strings.Contains(h.logs.String(), s) {
			t.Fatalf("the log names %s: %s", s, h.logs)
		}
	}
}

// A login writes the month of use only when the account's item says an
// earlier one: once a month, not at every login.
func TestMonthOfUseWrittenOncePerMonth(t *testing.T) {
	h, tb := newExpiryTables(t)
	ctx := context.Background()
	m := h.account(t, userID)
	store := h.server.Directory.(*directory.Store)
	updates := func() int {
		n := 0
		for _, c := range tb.meter.Calls() {
			if c == "UpdateItem "+tb.directory {
				n++
			}
		}
		return n
	}
	login := func() {
		t.Helper()
		tb.meter.Reset()
		if status, out := h.post(t, "/session", m.d.login(t, h.now)); status != http.StatusOK {
			t.Fatalf("login: %d %v", status, out)
		}
	}

	// Set up in January 2027: that month is stored, and logins in it
	// write nothing.
	if d, err := store.AccountState(ctx, m.d.account); err != nil || d.LastUse != "2027-01" {
		t.Fatalf("set up: %+v, %v", d, err)
	}
	for range 3 {
		h.now = h.now.Add(time.Hour)
		if login(); updates() != 0 {
			t.Fatalf("a login in the same month wrote %v", tb.meter.Calls())
		}
	}
	// The first login of February writes it, once.
	h.now = time.Date(2027, 2, 1, 0, 0, 1, 0, time.UTC)
	if login(); updates() != 1 {
		t.Fatalf("the month's first login: %v", tb.meter.Calls())
	}
	if login(); updates() != 0 {
		t.Fatalf("the month's second login: %v", tb.meter.Calls())
	}
	if d, err := store.AccountState(ctx, m.d.account); err != nil || d.LastUse != "2027-02" {
		t.Fatalf("in February: %+v, %v", d, err)
	}
}

// A run takes a bounded number of steps, about DeleteStep write units each,
// and the next carries on where it stopped: a big account takes several
// runs, then the small ones behind it go.
func TestExpiryIsBoundedAndResumable(t *testing.T) {
	h, tb := newExpiryTables(t)
	ctx := context.Background()
	h.server.Expiry = ExpiryOn
	big := h.setUpAt(t, userID, start.AddDate(0, -20, 0))
	tb.mailboxes(t, big.d.account, 300)
	var small []member
	for i := range 3 {
		small = append(small, h.setUpAt(t, userID+1+int64(i), start.AddDate(0, -14, 0)))
	}
	kept := h.setUpAt(t, userID+10, start.AddDate(0, -2, 0))
	store := h.server.Directory.(*directory.Store)

	runs := 0
	for {
		if runs++; runs > 20 {
			t.Fatal("the expiry never finishes")
		}
		tb.meter.Reset()
		if err := h.server.ExpireAccounts(ctx); err != nil {
			t.Fatal(err)
		}
		u := tb.meter.Units(tb.directory)
		t.Logf("run %d: directory %+v", runs, u)
		// The run's steps, with their leases and the marks.
		if u.Write > expirySteps*(DeleteStep+10) {
			t.Fatalf("run %d wrote %.1f units", runs, u.Write)
		}
		if runs == 1 {
			// The big account, last used the earliest, comes first and
			// takes the run; the others wait.
			if d, err := store.AccountState(ctx, big.d.account); err != nil || !d.Deleting {
				t.Fatalf("the big account after the first run: %+v, %v", d, err)
			}
			for _, m := range small {
				if d, err := store.AccountState(ctx, m.d.account); err != nil || d.Deleting {
					t.Fatalf("a small account after the first run: %+v, %v", d, err)
				}
			}
		}
		n, _, err := store.CountUnused(ctx, directory.LastExpiredMonth(h.now), 100)
		if err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			break
		}
		h.now = h.now.Add(15 * time.Minute)
	}
	// 300 mailboxes are about 13 steps of 50 writes: three runs at least.
	if runs < 3 {
		t.Fatalf("finished in %d runs", runs)
	}
	for _, m := range append(small, big) {
		if _, err := store.AccountState(ctx, m.d.account); !errors.Is(err, directory.ErrNotFound) {
			t.Fatalf("an expired account is still there: %v", err)
		}
	}
	for _, it := range tb.items(t, tb.directory) {
		if mentions(it, big.d.account) {
			t.Fatalf("left of the big account: %v %v", it["pk"], it["sk"])
		}
	}
	if d, err := store.AccountState(ctx, kept.d.account); err != nil || d.Deleting {
		t.Fatalf("the account in use: %+v, %v", d, err)
	}
}

// An account whose own deletion holds it is left to that; one used since
// it was listed isn't marked.
func TestExpiryLeavesAccountsAlone(t *testing.T) {
	h, _ := newExpiryTables(t)
	ctx := context.Background()
	h.server.Expiry = ExpiryOn
	store := h.server.Directory.(*directory.Store)
	held := h.setUpAt(t, userID, start.AddDate(0, -13, 0))
	release, ok, err := store.Lease(ctx, held.d.account, h.now)
	if err != nil || !ok {
		t.Fatalf("lease: %v %v", ok, err)
	}
	if err := h.server.ExpireAccounts(ctx); err != nil {
		t.Fatal(err)
	}
	if d, err := store.AccountState(ctx, held.d.account); err != nil || d.Deleting {
		t.Fatalf("an account another step holds: %+v, %v", d, err)
	}
	if err := release(ctx, h.now, false); err != nil {
		t.Fatal(err)
	}

	// Listed as unused, then used: not marked, and kept.
	h.now = h.now.Add(time.Minute)
	if err := store.Used(ctx, held.d.account, directory.Month(h.now)); err != nil {
		t.Fatal(err)
	}
	if err := h.server.expireStepFor(ctx, held.d.account, "2025-12"); err != nil {
		t.Fatal(err)
	}
	if d, err := store.AccountState(ctx, held.d.account); err != nil || d.Deleting || d.LastUse != "2027-01" {
		t.Fatalf("an account used since: %+v, %v", d, err)
	}
}

// expireStepFor takes a step of expiring an account as a run that listed
// it last used in lastUse would, whatever its item says now.
func (s *Server) expireStepFor(ctx context.Context, accountID, lastUse string) error {
	d, err := s.Unused.AccountState(ctx, accountID)
	if err != nil {
		return err
	}
	d.LastUse = lastUse
	_, err = s.expireStep(ctx, accountID, d)
	return err
}
