package api

import (
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
)

// get is a logged-in GET of path with token, as the app sends it.
func get(token, path string) httpapi.Request {
	var req httpapi.Request
	req.RawPath = path
	req.RequestContext.HTTP.Method = http.MethodGet
	req.Headers = map[string]string{"x-session": token}
	return req
}

// setRow sets attributes of the device's row for the day that holds now in
// the fake limiter, as if it had counted them.
func (h *harness) setRow(m member, attrs map[string]int64) {
	l := h.server.Limits.(*memLimiter)
	key := h.server.rateName("dev", h.now, 24*time.Hour, m.d.account, m.d.id)
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.rows == nil {
		l.rows = map[string]map[string]int64{}
	}
	if l.rows[key] == nil {
		l.rows[key] = map[string]int64{}
	}
	for k, v := range attrs {
		l.rows[key][k] = v
	}
}

// A device's requests with a session count once its token checks out, and
// before anything is read for them: past the limit, 429 device_limit
// without reading the directory, on signed routes too. A token that is
// missing, forged or over is refused 401 whatever the count, and counts
// nothing, so nobody without the token can use up the limit or learn of it.
func TestSessionLimitBeforeTheRead(t *testing.T) {
	h := newHarness(t)
	limits := h.server.Limits.(*memLimiter)
	m := h.account(t, userID)
	ok := answer{status: http.StatusOK}
	for range SessionRequestsPerMinute {
		wantAnswer(t, "GET /account", h.send(t, get(m.token, "/account")), ok)
	}
	reads, counted := h.dir.deviceReads, limits.spent("td")
	wantAnswer(t, "past the minute", h.send(t, get(m.token, "/account")), limited(time.Minute))
	wantAnswer(t, "past the minute, GET /usage", h.send(t, get(m.token, "/usage")), limited(time.Minute))
	wantAnswer(t, "past the minute, signed", h.revoke(t, m), limited(time.Minute))
	if h.dir.deviceReads != reads || limits.spent("td") != counted || limits.spent("sd") != 0 {
		t.Fatalf("refused requests read the device %d times, counted %d", h.dir.deviceReads-reads, limits.spent("td")-counted)
	}

	// The day used up: only a token that checks out learns of it.
	h.setRow(m, map[string]int64{"td": SessionRequestsPerDay})
	midnight := start.Truncate(24 * time.Hour).Add(24 * time.Hour)
	wantAnswer(t, "past the day", h.send(t, get(m.token, "/account")), limited(midnight.Sub(h.now)))
	expired := answer{status: http.StatusUnauthorized, code: "session_expired"}
	forged := m.token[:len(m.token)-2] + "AA"
	if forged == m.token {
		forged = m.token[:len(m.token)-2] + "BB"
	}
	wantAnswer(t, "forged token", h.send(t, get(forged, "/account")), expired)
	wantAnswer(t, "no token", h.send(t, get("", "/account")), expired)
	h.now = h.now.Add(16 * time.Minute)
	wantAnswer(t, "expired token", h.send(t, get(m.token, "/account")), expired)
	if h.dir.deviceReads != reads || limits.spent("td") != SessionRequestsPerDay {
		t.Fatal("a token that didn't check out read or counted something")
	}
}

// Requests with a session count in a minute, a quarter of an hour and the
// UTC day, by the server's clock, every logged-in route together (signed
// ones too); past one, 429 device_limit until it ends, as Retry-After
// says.
func TestSessionLimits(t *testing.T) {
	h := newHarness(t)
	limits := h.server.Limits.(*memLimiter)
	m := h.account(t, userID) // at 08:00:00 UTC
	ok := answer{status: http.StatusOK}
	notFound := answer{status: http.StatusNotFound, code: "not_found"}

	// Each route counts; a signed request in both its budgets.
	wantAnswer(t, "revoke", h.revoke(t, m), notFound)
	wantAnswer(t, "GET /usage", h.send(t, get(m.token, "/usage")), ok)
	if limits.spent("td") != 2 || limits.spent("sd") != 1 {
		t.Fatalf("counted %d requests, %d signed", limits.spent("td"), limits.spent("sd"))
	}
	for range SessionRequestsPerMinute - 2 {
		wantAnswer(t, "GET /invitations", h.send(t, get(m.token, "/invitations")), ok)
	}
	h.now = start.Add(20 * time.Second)
	wantAnswer(t, "past the minute", h.send(t, get(m.token, "/inbox")), limited(40*time.Second))

	// The next minutes, up to the quarter's limit, then until it ends.
	for minute := 1; limits.spent("td") < SessionRequestsPerQuarter; minute++ {
		h.now = start.Add(time.Duration(minute) * time.Minute)
		for i := 0; i < SessionRequestsPerMinute && limits.spent("td") < SessionRequestsPerQuarter; i++ {
			wantAnswer(t, "GET /account", h.send(t, get(m.token, "/account")), ok)
		}
	}
	wantAnswer(t, "past the quarter", h.send(t, get(m.token, "/account")), limited(ephemeral.Quarter-h.now.Sub(start)))
	h.now = start.Add(ephemeral.Quarter)
	m.token = h.token(t, m.d) // sessions last 15 minutes
	wantAnswer(t, "the next quarter", h.send(t, get(m.token, "/account")), ok)

	// The day, up to its limit (counted as by quarters before), then until
	// midnight UTC.
	h.setRow(m, map[string]int64{"td": SessionRequestsPerDay - 1})
	wantAnswer(t, "the day's last", h.send(t, get(m.token, "/account")), ok)
	midnight := start.Truncate(24 * time.Hour).Add(24 * time.Hour)
	wantAnswer(t, "past the day", h.send(t, get(m.token, "/account")), limited(midnight.Sub(h.now)))
	h.now = midnight
	m.token = h.token(t, m.d)
	wantAnswer(t, "the next day", h.send(t, get(m.token, "/account")), ok)

	// Devices count apart.
	other := h.account(t, userID+1)
	wantAnswer(t, "another device", h.send(t, get(other.token, "/account")), ok)
}

// If the count can't be written, each instance lets a device make
// SessionRequestsLocalPerMinute a minute on its own count, then refuses
// it (429 device_limit) until the minute ends: neither every logged-in
// route down with the ephemeral table, nor no limit. Logged without
// anything about the request.
func TestSessionLimitWithoutTheTable(t *testing.T) {
	h := newHarness(t)
	limits := h.server.Limits.(*memLimiter)
	m := h.account(t, userID)
	limits.spendErr = errors.New("throttled")
	ok := answer{status: http.StatusOK}
	for range SessionRequestsLocalPerMinute {
		wantAnswer(t, "GET /account", h.send(t, get(m.token, "/account")), ok)
	}
	reads := h.dir.deviceReads
	h.now = start.Add(45 * time.Second)
	wantAnswer(t, "past this instance's minute", h.send(t, get(m.token, "/account")), limited(15*time.Second))
	if h.dir.deviceReads != reads {
		t.Fatal("a refused request read the device")
	}
	h.now = start.Add(time.Minute)
	wantAnswer(t, "the next minute", h.send(t, get(m.token, "/account")), ok)
	for _, id := range []string{m.d.account, m.d.id} {
		if strings.Contains(h.logs.String(), id) {
			t.Fatal("a log line names the account or the device")
		}
	}
	if !strings.Contains(h.logs.String(), "rate count failed") {
		t.Fatalf("not logged: %s", h.logs.String())
	}
}

// What the limit costs, measured: a device's requests are written a batch
// (SessionBatch) at a time, in its one row for the day; past the limit,
// refused reading and writing nothing once the instance knows, and on
// another instance after one write.
func TestSessionLimitCapacity(t *testing.T) {
	h, tb := newDirectoryTables(t)
	m := h.account(t, userID)
	tb.meter.Reset()
	for range 3 * SessionBatch {
		wantAnswer(t, "GET /account", h.send(t, get(m.token, "/account")), answer{status: http.StatusOK})
	}
	if d, e := tb.cost(t, "GET /account, 30 times"); d.Read != 3*SessionBatch || e.Write != 3 || e.Read != 0 {
		t.Fatalf("30 requests cost the directory %+v, the ephemeral table %+v", d, e)
	}
	allowed := 3 * SessionBatch
	for {
		resp := h.send(t, get(m.token, "/account"))
		if resp.status != http.StatusOK {
			wantAnswer(t, "past the minute", resp, limited(time.Minute))
			break
		}
		allowed++
	}
	tb.cost(t, "GET /account, up to the minute's limit")
	if allowed != SessionRequestsPerMinute {
		t.Fatalf("let %d through in a minute", allowed)
	}
	for range 20 {
		wantAnswer(t, "past the minute", h.send(t, get(m.token, "/usage")), limited(time.Minute))
	}
	if d, e := tb.cost(t, "GET /account and /usage past the minute, 20 times"); d.Read != 0 || e.Read != 0 || e.Write != 0 {
		t.Fatalf("refusals cost the directory %+v, the ephemeral table %+v", d, e)
	}
	// Another instance lets up to a batch less one through before it writes
	// and learns: its first write guesses the row wrong (it knows nothing
	// of it), which the refused write teaches it, then counts.
	tb.wire(h)
	for range SessionBatch - 1 {
		wantAnswer(t, "another instance", h.send(t, get(m.token, "/account")), answer{status: http.StatusOK})
	}
	wantAnswer(t, "another instance, its first write", h.send(t, get(m.token, "/account")), limited(time.Minute))
	wantAnswer(t, "another instance, knowing", h.send(t, get(m.token, "/account")), limited(time.Minute))
	if d, e := tb.cost(t, "GET /account past the minute, on another instance"); e.Write != 2 || d.Read != SessionBatch-1 {
		t.Fatalf("another instance wrote %v units to learn the minute is used up, and read %v", e.Write, d.Read)
	}
}

// GET /invitations reads the directory once, as any logged-in request
// does, then half a unit for the codes however many there are, and the
// levels at most every half a minute on an instance; for an account that
// never made a code, nothing more. It read a strong unit per code.
func TestInvitationsCapacity(t *testing.T) {
	h, tb := newDirectoryTables(t)
	h.makeAdmin(userID)
	admin := h.account(t, userID)
	member := h.account(t, userID+1)
	var first string
	for i := range 20 {
		status, out := h.as(t, admin, http.MethodPost, "/invitations", map[string]any{"uses": 2}, true)
		if status != http.StatusCreated {
			t.Fatalf("code %d: %d %v", i, status, out)
		}
		if i == 0 {
			first = out["code"].(string)
		}
	}
	if status, out := h.as(t, member, http.MethodPost, "/invitations/redeem", map[string]any{"code": first}, false); status != http.StatusOK {
		t.Fatalf("redeem: %d %v", status, out)
	}
	tb.meter.Reset()
	status, out := h.as(t, admin, http.MethodGet, "/invitations", nil, false)
	codes, _ := out["codes"].([]any)
	if status != http.StatusOK || len(codes) != 20 {
		t.Fatalf("admin's invitations: %d %v", status, out)
	}
	for _, c := range codes {
		if c := c.(map[string]any); c["code"] == first && c["left"] != float64(1) {
			t.Fatalf("the redeemed code shows %v left", c["left"])
		}
	}
	if d, _ := tb.cost(t, "GET /invitations, 20 codes"); d.Read > 1.5 {
		t.Fatalf("listing 20 codes read %v directory units", d.Read)
	}
	// A member who made no code: the levels once, then nothing more.
	h.as(t, member, http.MethodGet, "/invitations", nil, false)
	if d, _ := tb.cost(t, "GET /invitations, a member without codes, first"); d.Read > 2 {
		t.Fatalf("read %v directory units", d.Read)
	}
	h.as(t, member, http.MethodGet, "/invitations", nil, false)
	if d, _ := tb.cost(t, "GET /invitations, a member without codes, again"); d.Read != 1 {
		t.Fatalf("read %v directory units", d.Read)
	}
}

// GET /usage reads the directory once, as any logged-in request does (the
// mailboxes owned are on the account item it reads), and its four counters
// eventually consistent, half a unit each; asked again within half a
// minute on the same instance, nothing more. It used to read the account
// item again and the counters strongly: 2 directory units and 4 ephemeral.
func TestUsageCapacity(t *testing.T) {
	h, tb := newDirectoryTables(t)
	m := h.account(t, userID)
	status, out := h.as(t, m, http.MethodPost, "/mailboxes", map[string]any{"count": 3}, false)
	if status != http.StatusCreated {
		t.Fatalf("mailboxes: %d %v", status, out)
	}
	tb.meter.Reset()
	status, out = h.as(t, m, http.MethodGet, "/usage", nil, false)
	if owned := out["owned"].(map[string]any)["used"]; status != http.StatusOK || owned != float64(3) {
		t.Fatalf("usage: %d %v", status, out)
	}
	if mbx := out["mailboxes"].(map[string]any)["used"]; mbx != float64(3) {
		t.Fatalf("new mailboxes today: %v", mbx)
	}
	if d, e := tb.cost(t, "GET /usage"); d.Read != 1 || e.Read > 2 || e.Write > 1 {
		t.Fatalf("GET /usage read %v directory units, %v ephemeral", d.Read, e.Read)
	}
	h.as(t, m, http.MethodGet, "/usage", nil, false)
	if d, e := tb.cost(t, "GET /usage again"); d.Read != 1 || e.Read != 0 {
		t.Fatalf("GET /usage again read %v directory units, %v ephemeral", d.Read, e.Read)
	}
	h.now = h.now.Add(31 * time.Second)
	h.as(t, m, http.MethodGet, "/usage", nil, false)
	if d, e := tb.cost(t, "GET /usage half a minute later"); d.Read != 1 || e.Read > 2 {
		t.Fatalf("GET /usage half a minute later read %v directory units, %v ephemeral", d.Read, e.Read)
	}
}
