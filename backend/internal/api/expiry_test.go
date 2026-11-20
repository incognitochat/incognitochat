package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
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
	// Someone uses the app this month (TestExpiryPausesWithoutRecentUse).
	h.setUpAt(t, userID+4, start)
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
	h.setUpAt(t, userID+11, start)
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

// accountItem reads an account's item as stored.
func (tb *deliveryTables) accountItem(t *testing.T, accountID string) map[string]types.AttributeValue {
	t.Helper()
	out, err := tb.meter.Client.GetItem(context.Background(), &dynamodb.GetItemInput{
		TableName:      &tb.directory,
		Key:            map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: "A#" + accountID}, "sk": &types.AttributeValueMemberS{Value: "A"}},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		t.Fatal(err)
	}
	return out.Item
}

// logged returns the log lines with msg, decoded.
func (h *harness) logged(t *testing.T, msg string) []map[string]any {
	t.Helper()
	var lines []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(h.logs.String()), "\n") {
		var entry map[string]any
		if line != "" && json.Unmarshal([]byte(line), &entry) == nil && entry["msg"] == msg {
			lines = append(lines, entry)
		}
	}
	return lines
}

// An account whose own deletion holds it is left to that. One used after
// the run read it (a login during the pause before its step) isn't marked,
// and keeps nothing of the expiry: no lease time on its item.
func TestExpiryLeavesAccountsAlone(t *testing.T) {
	h, tb := newExpiryTables(t)
	ctx := context.Background()
	h.server.Expiry = ExpiryOn
	store := h.server.Directory.(*directory.Store)
	first := h.setUpAt(t, userID, start.AddDate(0, -15, 0))
	held := h.setUpAt(t, userID+1, start.AddDate(0, -13, 0))
	h.setUpAt(t, userID+2, start)
	release, ok, err := store.Lease(ctx, held.d.account, h.now)
	if err != nil || !ok {
		t.Fatalf("lease: %v %v", ok, err)
	}
	if err := h.server.ExpireAccounts(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AccountState(ctx, first.d.account); !errors.Is(err, directory.ErrNotFound) {
		t.Fatalf("the first account: %v", err)
	}
	if d, err := store.AccountState(ctx, held.d.account); err != nil || d.Deleting {
		t.Fatalf("an account another step holds: %+v, %v", d, err)
	}
	if err := release(ctx, h.now, true); err != nil {
		t.Fatal(err)
	}

	// Read as unused, then used while the run pauses before its step: kept.
	another := h.setUpAt(t, userID+3, start.AddDate(0, -14, 0))
	used := false
	h.server.sleep = func(ctx context.Context, d time.Duration) error {
		h.now = h.now.Add(d)
		if !used {
			used = true
			return store.Used(ctx, held.d.account, directory.Month(h.now))
		}
		return nil
	}
	if err := h.server.ExpireAccounts(ctx); err != nil {
		t.Fatal(err)
	}
	if !used {
		t.Fatal("the run didn't pause before the second account")
	}
	if _, err := store.AccountState(ctx, another.d.account); !errors.Is(err, directory.ErrNotFound) {
		t.Fatalf("the account before it: %v", err)
	}
	it := tb.accountItem(t, held.d.account)
	if _, marked := it["dl"]; marked || it["lu"].(*types.AttributeValueMemberS).Value != "2027-01" {
		t.Fatalf("an account used since: %v", it)
	}
	if _, lease := it["sl"]; lease {
		t.Fatalf("the expiry left its lease's time on an account in use: %v", it["sl"])
	}
}

// Logins that stop recording their month would make every account look
// unused a year later. So a run deletes nothing unless some account was
// used this month or last: otherwise it logs an error, constant, and
// fails, for the alarm. Once a login records a month, it carries on.
func TestExpiryPausesWithoutRecentUse(t *testing.T) {
	h, _ := newExpiryTables(t)
	ctx := context.Background()
	h.server.Expiry = ExpiryOn
	store := h.server.Directory.(*directory.Store)
	due := h.setUpAt(t, userID, start.AddDate(0, -13, 0))
	recent := h.setUpAt(t, userID+1, start.AddDate(0, -2, 0))

	if err := h.server.ExpireAccounts(ctx); !errors.Is(err, errExpiryPaused) {
		t.Fatalf("a run with no recent month: %v", err)
	}
	if d, err := store.AccountState(ctx, due.d.account); err != nil || d.Deleting {
		t.Fatalf("deleted while no month is recent: %+v, %v", d, err)
	}
	lines := h.logged(t, msgExpiryPaused)
	if len(lines) != 1 || lines[0]["level"] != "ERROR" || lines[0]["route"] != expiryRoute || len(lines[0]) != 5 {
		t.Fatalf("logged %s", h.logs)
	}

	// Last month's will do.
	if err := store.Used(ctx, recent.d.account, directory.MonthsBefore(h.now, 1)); err != nil {
		t.Fatal(err)
	}
	if err := h.server.ExpireAccounts(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AccountState(ctx, due.d.account); !errors.Is(err, directory.ErrNotFound) {
		t.Fatalf("after a recent login: %v", err)
	}
}

// failingExpire fails Expire for some accounts, every time.
type failingExpire struct {
	*directory.Store
	fail  map[string]bool
	tries map[string]int
}

func (f *failingExpire) Expire(ctx context.Context, accountID, lastUse string) error {
	if f.fail[accountID] {
		f.tries[accountID]++
		return errors.New("expire failed")
	}
	return f.Store.Expire(ctx, accountID, lastUse)
}

// Accounts whose steps always fail don't hold up the rest: each is tried
// expiryTries times in a run, then passed over (still listed, for the next
// run), and the run counts them as stuck, in an error line, and fails.
// Their failed steps leave no lease time on them, and don't count against
// the run's steps.
func TestExpiryPassesStuckAccounts(t *testing.T) {
	h, tb := newExpiryTables(t)
	ctx := context.Background()
	h.server.Expiry = ExpiryOn
	store := h.server.Directory.(*directory.Store)
	failing := &failingExpire{Store: store, fail: map[string]bool{}, tries: map[string]int{}}
	h.server.Unused = failing
	var stuck []member
	for i := range expirySteps + 1 {
		m := h.setUpAt(t, userID+int64(i), start.AddDate(0, -20, 0))
		failing.fail[m.d.account] = true
		stuck = append(stuck, m)
	}
	behind := h.setUpAt(t, userID+20, start.AddDate(0, -14, 0))
	h.setUpAt(t, userID+21, start)

	if err := h.server.ExpireAccounts(ctx); err == nil {
		t.Fatal("a run with stuck accounts didn't fail")
	}
	if _, err := store.AccountState(ctx, behind.d.account); !errors.Is(err, directory.ErrNotFound) {
		t.Fatalf("the account behind the stuck ones: %v", err)
	}
	for _, m := range stuck {
		if n := failing.tries[m.d.account]; n != expiryTries {
			t.Fatalf("a stuck account was tried %d times", n)
		}
		it := tb.accountItem(t, m.d.account)
		if _, lease := it["sl"]; lease {
			t.Fatalf("a failed step left its lease: %v", it["sl"])
		}
	}
	lines := h.logged(t, msgExpiryStuck)
	if len(lines) != 1 || lines[0]["level"] != "ERROR" || lines[0]["count"] != float64(len(stuck)) {
		t.Fatalf("logged %s", h.logs)
	}
	if n := h.loggedCount(t, msgExpiryDeleted); n != 1 {
		t.Fatalf("deleted %d", n)
	}

	// Still listed: once their steps work, a run takes them.
	clear(failing.fail)
	h.now = h.now.Add(15 * time.Minute)
	if err := h.server.ExpireAccounts(ctx); err != nil {
		t.Fatal(err)
	}
	if n, _, err := store.CountUnused(ctx, directory.LastExpiredMonth(h.now), 100); err != nil || n > 1 {
		t.Fatalf("%d left, %v", n, err)
	}
}

// The metric filters behind the account-expiry alarm (infra/metrics.tf)
// read the lines the expiry and logins log as errors: a renamed line would
// leave the alarm quiet for good.
func TestExpiryMetricFiltersMatchTheLogs(t *testing.T) {
	src, err := os.ReadFile("../../../infra/metrics.tf")
	if err != nil {
		t.Fatal(err)
	}
	tf := string(src)
	for _, want := range []string{
		`expiry-problems  = { metric = "ExpiryProblems", pattern = "{ ($.route = \"` + expiryRoute + `\") && ($.level = \"ERROR\") }" }`,
		`use-not-recorded = { metric = "UseNotRecorded", pattern = "{ ($.msg = \"` + MsgUseNotRecorded + `\") && ($.level = \"ERROR\") }" }`,
	} {
		if !strings.Contains(tf, want) {
			t.Errorf("infra/metrics.tf doesn't read %s", want)
		}
	}
}

// failingUsed fails every Used.
type failingUsed struct{ Directory }

func (failingUsed) Used(context.Context, string, string) error { return errors.New("used failed") }

// A login whose month of use can't be recorded still goes through, and
// logs an error line with a constant message that a metric filter counts
// (infra/metrics.tf), with the error's kind only.
func TestMonthOfUseFailureIsLoggedAsAnError(t *testing.T) {
	h := newHarness(t)
	m := h.account(t, userID)
	h.server.Directory = failingUsed{h.server.Directory}
	h.logs.Reset()

	// The same month: nothing to record, nothing logged.
	h.token(t, m.d)
	if h.logs.Len() != 0 {
		t.Fatalf("logged %s", h.logs)
	}
	// The next month's first login can't record it, and still logs in.
	h.now = time.Date(2027, 2, 1, 0, 0, 1, 0, time.UTC)
	h.token(t, m.d)
	lines := h.logged(t, MsgUseNotRecorded)
	if len(lines) != 1 || lines[0]["level"] != "ERROR" || lines[0]["route"] != "POST /session" || lines[0]["error_kind"] != "*errors.errorString" {
		t.Fatalf("logged %s", h.logs)
	}
	if strings.Contains(h.logs.String(), m.d.account) || strings.Contains(h.logs.String(), "2027-02") {
		t.Fatalf("the log names the account or the month: %s", h.logs)
	}
}

// While the expiry deletes an account, the app is told it's that, not its
// user's own deletion (GET /account: expired), so it doesn't say something
// may be wrong.
func TestExpiringAccountSaysSo(t *testing.T) {
	h, tb := newExpiryTables(t)
	ctx := context.Background()
	h.server.Expiry = ExpiryOn
	old := h.setUpAt(t, userID, start.AddDate(0, -13, 0))
	tb.mailboxes(t, old.d.account, 400)
	own := h.account(t, userID+1)
	tb.mailboxes(t, own.d.account, 400)

	if err := h.server.ExpireAccounts(ctx); err != nil {
		t.Fatal(err)
	}
	again := member{d: old.d, token: h.token(t, old.d)}
	if status, out := h.as(t, again, http.MethodGet, "/account", nil, false); status != http.StatusOK || out["deleting"] != true || out["expired"] != true {
		t.Fatalf("an expiring account: %d %v", status, out)
	}
	// Its user's own deletion is no expiry.
	status, out := h.as(t, own, http.MethodDelete, "/account", nil, true)
	wantError(t, status, out, http.StatusConflict, "in_progress")
	if status, out := h.as(t, own, http.MethodGet, "/account", nil, false); status != http.StatusOK || out["deleting"] != true || out["expired"] != false {
		t.Fatalf("an account its user deletes: %d %v", status, out)
	}
}
