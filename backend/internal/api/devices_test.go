package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/devicesig"
	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/session"
)

// answer is a response's status, Retry-After and error code.
type answer struct {
	status     int
	retryAfter string
	code       string
}

func answerOf(t *testing.T, resp httpapi.Response) answer {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(resp.Body), &out); err != nil {
		t.Fatalf("response body %q: %v", resp.Body, err)
	}
	code, _ := out["error"].(string)
	return answer{resp.StatusCode, resp.Headers["retry-after"], code}
}

// logIn posts a login, as signed in body.
func (h *harness) logIn(t *testing.T, body map[string]any) answer {
	t.Helper()
	return answerOf(t, h.serve(t, http.MethodPost, "/session", body))
}

// signedRequest is a request as m's device signs it at h.now (with m's
// token), to send once, or again as a replay.
func (h *harness) signedRequest(t *testing.T, m member, method, path string) httpapi.Request {
	t.Helper()
	var req httpapi.Request
	req.RawPath = path
	req.RequestContext.HTTP.Method = method
	req.Headers = map[string]string{"content-type": "application/json", "x-session": m.token}
	signed := session.SignedRequest{
		AccountID: m.d.account, DeviceID: m.d.id, Method: method, Path: path,
		Timestamp: h.now.Unix(), Nonce: b64(randomBytes(t, 16)),
	}
	sig := signP1363(t, m.d.dsk, devicesig.Message(devicesig.LabelRequest, session.RequestParts(signed)...))
	req.Headers["x-device-signature"] = strconv.FormatInt(signed.Timestamp, 10) + "." + signed.Nonce + "." + b64(sig)
	return req
}

func (h *harness) send(t *testing.T, req httpapi.Request) answer {
	t.Helper()
	resp, err := h.router.Serve(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	return answerOf(t, resp)
}

// revoke signs a revocation of a link that doesn't exist: a signed request
// that writes nothing but its nonce (404 once it gets to the handler).
func (h *harness) revoke(t *testing.T, m member) answer {
	t.Helper()
	return h.send(t, h.signedRequest(t, m, http.MethodDelete, "/links/"+b64(randomBytes(t, 8))))
}

func wantAnswer(t *testing.T, what string, got, want answer) {
	t.Helper()
	if got != want {
		t.Fatalf("%s: got %+v, want %+v", what, got, want)
	}
}

var limited = func(retryAfter time.Duration) answer {
	return answer{http.StatusTooManyRequests, strconv.Itoa(int(retryAfter.Seconds())), "device_limit"}
}

// Nothing but the device's own key reaches its limits, or learns of them:
// a login forged for a device whose logins are used up, or one with a
// stale timestamp, is refused as before (401), not 429, and neither counts
// or writes anything.
func TestDeviceLimitOnlyAfterTheSignature(t *testing.T) {
	h := newHarness(t)
	limits := h.server.Limits.(*memLimiter)
	nonces := h.server.Nonces.(*memNonces)
	m := h.account(t, userID) // one login
	for range LoginsPerMinute - 1 {
		wantAnswer(t, "login", h.logIn(t, m.d.login(t, h.now)), answer{status: http.StatusOK})
	}
	wantAnswer(t, "past the minute", h.logIn(t, m.d.login(t, h.now)), limited(time.Minute))
	used, counted := len(nonces.used), limits.spent("ld")

	forger := &device{dsk: newDevice(t).dsk, id: m.d.id, account: m.d.account}
	wantAnswer(t, "forged", h.logIn(t, forger.login(t, h.now)), answer{status: http.StatusUnauthorized, code: "login_refused"})
	wantAnswer(t, "stale", h.logIn(t, m.d.login(t, h.now.Add(-2*session.MaxSkew))), answer{status: http.StatusUnauthorized, code: "clock_skew"})
	unknown := m.d.login(t, h.now)
	unknown["device"] = ids.New()
	wantAnswer(t, "unknown device", h.logIn(t, unknown), answer{status: http.StatusUnauthorized, code: "login_refused"})
	if len(nonces.used) != used || limits.spent("ld") != counted {
		t.Fatalf("refused logins wrote %d nonces and counted %d", len(nonces.used)-used, limits.spent("ld")-counted)
	}

	// The same for a signed request: one with a stolen token but another
	// key's signature is refused, and counts nothing.
	for range SignedPerMinute {
		wantAnswer(t, "revoke", h.revoke(t, m), answer{status: http.StatusNotFound, code: "not_found"})
	}
	wantAnswer(t, "past the minute", h.revoke(t, m), limited(time.Minute))
	used, counted = len(nonces.used), limits.spent("sd")
	thief := member{d: &device{dsk: forger.dsk, id: m.d.id, account: m.d.account}, token: m.token}
	wantAnswer(t, "stolen token", h.revoke(t, thief), answer{status: http.StatusUnauthorized, code: "signature_rejected"})
	if len(nonces.used) != used || limits.spent("sd") != counted {
		t.Fatal("a refused signed request wrote or counted")
	}
}

// Logins count in a minute, a quarter of an hour and the UTC day, by the
// server's clock; past one, 429 device_limit until its window ends, which
// Retry-After says. Refused tries count nothing; replays count.
func TestDeviceLoginLimits(t *testing.T) {
	h := newHarness(t)
	limits := h.server.Limits.(*memLimiter)
	nonces := h.server.Nonces.(*memNonces)
	m := h.account(t, userID) // one login, at 08:00:00 UTC
	ok := answer{status: http.StatusOK}

	// A replay passes the signature, so counts, and the nonce refuses it.
	replayed := m.d.login(t, h.now)
	wantAnswer(t, "login", h.logIn(t, replayed), ok)
	wantAnswer(t, "replay", h.logIn(t, replayed), answer{status: http.StatusUnauthorized, code: "login_refused"})
	if limits.spent("ld") != 3 {
		t.Fatalf("counted %d logins, want 3 (the replay too)", limits.spent("ld"))
	}
	for range LoginsPerMinute - 3 {
		wantAnswer(t, "login", h.logIn(t, m.d.login(t, h.now)), ok)
	}
	// Past the minute: refused until it ends, a replay too, counting nothing
	// and writing no nonce.
	used := len(nonces.used)
	h.now = start.Add(15 * time.Second)
	for range 5 {
		wantAnswer(t, "past the minute", h.logIn(t, m.d.login(t, h.now)), limited(45*time.Second))
	}
	wantAnswer(t, "replay past the minute", h.logIn(t, replayed), limited(45*time.Second))
	if limits.spent("ld") != LoginsPerMinute || len(nonces.used) != used {
		t.Fatalf("refused logins counted %d, wrote %d nonces", limits.spent("ld")-LoginsPerMinute, len(nonces.used)-used)
	}
	// A login signed a minute ahead counts in the server's minute, not its
	// own.
	wantAnswer(t, "signed ahead", h.logIn(t, m.d.login(t, h.now.Add(session.MaxSkew))), limited(45*time.Second))

	// The next minutes, up to the quarter's limit.
	for minute := 1; limits.spent("ld") < LoginsPerQuarter; minute++ {
		h.now = start.Add(time.Duration(minute) * time.Minute)
		for range LoginsPerMinute {
			wantAnswer(t, "login", h.logIn(t, m.d.login(t, h.now)), ok)
		}
	}
	wantAnswer(t, "past the quarter", h.logIn(t, m.d.login(t, h.now)), limited(ephemeral.Quarter-h.now.Sub(start)))
	h.now = start.Add(14 * time.Minute)
	wantAnswer(t, "still the quarter", h.logIn(t, m.d.login(t, h.now)), limited(time.Minute))

	// Quarter after quarter, up to the day's limit, then until midnight UTC.
	for quarter := 1; limits.spent("ld") < LoginsPerDay; quarter++ {
		for i := 0; i < LoginsPerQuarter && limits.spent("ld") < LoginsPerDay; i++ {
			h.now = start.Add(time.Duration(quarter)*ephemeral.Quarter + time.Duration(i/LoginsPerMinute)*time.Minute)
			wantAnswer(t, "login", h.logIn(t, m.d.login(t, h.now)), ok)
		}
	}
	midnight := start.Truncate(24 * time.Hour).Add(24 * time.Hour)
	h.now = h.now.Add(ephemeral.Quarter)
	wantAnswer(t, "past the day", h.logIn(t, m.d.login(t, h.now)), limited(midnight.Sub(h.now)))
	h.now = midnight
	wantAnswer(t, "the next day", h.logIn(t, m.d.login(t, h.now)), ok)
}

// Signed requests count apart from logins, in their own minute, quarter and
// day; a replay counts too.
func TestDeviceSignedLimits(t *testing.T) {
	h := newHarness(t)
	limits := h.server.Limits.(*memLimiter)
	m := h.account(t, userID)
	notFound := answer{status: http.StatusNotFound, code: "not_found"}

	req := h.signedRequest(t, m, http.MethodDelete, "/links/"+b64(randomBytes(t, 8)))
	wantAnswer(t, "revoke", h.send(t, req), notFound)
	wantAnswer(t, "replay", h.send(t, req), answer{status: http.StatusUnauthorized, code: "signature_rejected"})
	for range SignedPerMinute - 2 {
		wantAnswer(t, "revoke", h.revoke(t, m), notFound)
	}
	wantAnswer(t, "past the minute", h.revoke(t, m), limited(time.Minute))
	// Logins have their own budget.
	wantAnswer(t, "login", h.logIn(t, m.d.login(t, h.now)), answer{status: http.StatusOK})
	h.now = start.Add(time.Minute)
	for range SignedPerQuarter - SignedPerMinute {
		wantAnswer(t, "revoke", h.revoke(t, m), notFound)
	}
	wantAnswer(t, "past the quarter", h.revoke(t, m), limited(14*time.Minute))
	if limits.spent("sd") != SignedPerQuarter || limits.spent("ld") != 2 {
		t.Fatalf("counted %d signed requests and %d logins", limits.spent("sd"), limits.spent("ld"))
	}
}

// A replaced account's device, or a request an account being deleted
// doesn't take, is refused once the signature checks out, before anything
// is written: no nonce, nothing counted.
func TestRefusedAccountsWriteNothing(t *testing.T) {
	h := newHarness(t)
	limits := h.server.Limits.(*memLimiter)
	nonces := h.server.Nonces.(*memNonces)
	old := h.account(t, userID)
	h.loggedIn(t, newDevice(t), true) // set up again: old is replaced
	used, logins, signed := len(nonces.used), limits.spent("ld"), limits.spent("sd")
	wrote := func(what string) {
		t.Helper()
		if len(nonces.used) != used || limits.spent("ld") != logins || limits.spent("sd") != signed {
			t.Fatalf("%s wrote %d nonces, counted %d logins and %d signed requests", what,
				len(nonces.used)-used, limits.spent("ld")-logins, limits.spent("sd")-signed)
		}
	}

	wantAnswer(t, "replaced, login", h.logIn(t, old.d.login(t, h.now)), answer{status: http.StatusGone, code: "account_replaced"})
	wantAnswer(t, "replaced, signed", h.revoke(t, old), answer{status: http.StatusGone, code: "account_replaced"})
	// Without the key, as before: only refused.
	forger := &device{dsk: newDevice(t).dsk, id: old.d.id, account: old.d.account}
	wantAnswer(t, "replaced, forged", h.logIn(t, forger.login(t, h.now)), answer{status: http.StatusUnauthorized, code: "login_refused"})

	wrote("a replaced account")

	deleting := h.account(t, userID+1)
	used, logins, signed = len(nonces.used), limits.spent("ld"), limits.spent("sd")
	h.dir.mu.Lock()
	h.dir.accounts[deleting.d.account].deleting = true
	h.dir.mu.Unlock()
	wantAnswer(t, "deleting, signed", h.revoke(t, deleting), answer{status: http.StatusConflict, code: "account_deleting"})
	wrote("an account being deleted")
}

// While an account is being deleted, or has what is left of one it
// replaced to delete, its steps have a larger budget of their own: a
// cleanup never holds up the link change after it. They share the signed
// requests' day.
func TestDeviceStepLimits(t *testing.T) {
	h := newHarness(t)
	limits := h.server.Limits.(*memLimiter)
	m := h.account(t, userID)
	inProgress := answer{status: http.StatusConflict, code: "in_progress"}
	h.dir.mu.Lock()
	h.dir.accounts[m.d.account].leftovers = []string{ids.New()}
	h.dir.leased = map[string]bool{m.d.account: true} // another step holds it
	h.dir.mu.Unlock()
	cleanUp := func() answer { return h.send(t, h.signedRequest(t, m, http.MethodPost, "/account/cleanup")) }

	for range StepsPerMinute {
		wantAnswer(t, "cleanup", cleanUp(), inProgress)
	}
	wantAnswer(t, "past the minute", cleanUp(), limited(time.Minute))
	wantAnswer(t, "a link change meanwhile", h.revoke(t, m), answer{status: http.StatusNotFound, code: "not_found"})
	for minute := 1; minute < StepsPerQuarter/StepsPerMinute; minute++ {
		h.now = start.Add(time.Duration(minute) * time.Minute)
		for range StepsPerMinute {
			wantAnswer(t, "cleanup", cleanUp(), inProgress)
		}
	}
	h.now = start.Add(10 * time.Minute)
	wantAnswer(t, "past the quarter", cleanUp(), limited(5*time.Minute))

	// Being deleted: its steps the same; the day is shared.
	h.now = start.Add(ephemeral.Quarter)
	h.dir.mu.Lock()
	h.dir.accounts[m.d.account].leftovers = nil
	h.dir.accounts[m.d.account].deleting = true
	h.dir.mu.Unlock()
	// Logging in again each quarter, as the app does every 15 minutes.
	m.token = h.token(t, m.d)
	deleteStep := func() answer { return h.send(t, h.signedRequest(t, m, http.MethodDelete, "/account")) }
	inMinute, inQuarter := 0, 0
	for limits.spent("sd") < SignedPerDay {
		if inQuarter == StepsPerQuarter {
			h.now, inMinute, inQuarter = h.now.Truncate(ephemeral.Quarter).Add(ephemeral.Quarter), 0, 0
			m.token = h.token(t, m.d)
		}
		if inMinute == StepsPerMinute {
			h.now, inMinute = h.now.Add(time.Minute), 0
		}
		wantAnswer(t, "delete", deleteStep(), inProgress)
		inMinute++
		inQuarter++
	}
	midnight := start.Truncate(24 * time.Hour).Add(24 * time.Hour)
	wantAnswer(t, "past the day", deleteStep(), limited(midnight.Sub(h.now)))

	// Without such work, the steps' routes count as signed requests.
	if budgetFor("POST /account/cleanup", deviceWith(false, nil)) != signedBudget ||
		budgetFor("DELETE /account", deviceWith(false, nil)) != signedBudget ||
		budgetFor("DELETE /links/{id}", deviceWith(true, []string{"x"})) != signedBudget ||
		budgetFor("DELETE /account", deviceWith(true, nil)) != stepBudget ||
		budgetFor("DELETE /account", deviceWith(false, []string{"x"})) != stepBudget {
		t.Fatal("budgetFor")
	}
}

// A count that can't be taken is 503 unavailable with Retry-After, never
// 429 and never let through: no nonce is written, nothing runs.
func TestDeviceLimitFailsClosed(t *testing.T) {
	h := newHarness(t)
	limits := h.server.Limits.(*memLimiter)
	nonces := h.server.Nonces.(*memNonces)
	m := h.account(t, userID)
	used := len(nonces.used)
	limits.spendErr = &types.ProvisionedThroughputExceededException{}
	unavailable := answer{http.StatusServiceUnavailable, strconv.Itoa(RetryAfter), "unavailable"}
	wantAnswer(t, "login", h.logIn(t, m.d.login(t, h.now)), unavailable)
	wantAnswer(t, "signed", h.revoke(t, m), unavailable)
	limits.spendErr = errors.New("something else")
	wantAnswer(t, "login", h.logIn(t, m.d.login(t, h.now)), unavailable)
	if len(nonces.used) != used {
		t.Fatal("a nonce was written for a request that wasn't counted")
	}
	// Logged without anything about the request.
	for _, id := range []string{m.d.account, m.d.id} {
		if strings.Contains(h.logs.String(), id) {
			t.Fatal("a log line names the account or the device")
		}
	}
	if !strings.Contains(h.logs.String(), "rate count failed") {
		t.Fatalf("not logged: %s", h.logs.String())
	}
}

// deviceWith is a device of an account being deleted, or with leftovers.
func deviceWith(deleting bool, leftovers []string) directory.Device {
	return directory.Device{Deleting: deleting, Leftovers: leftovers}
}

// What the limit costs the ephemeral table, measured: an allowed login or
// signed request two write units (its count, its nonce), a replay the
// same; past the limit, one refused write on an instance that didn't know,
// then nothing; and nothing for a forged one or a replaced account's.
func TestDeviceLimitCapacity(t *testing.T) {
	h, tb := newDirectoryTables(t)
	m := h.account(t, userID)
	cost := func(what string, wantWrites float64) {
		t.Helper()
		if _, e := tb.cost(t, what); e.Write != wantWrites || e.Read != 0 {
			t.Fatalf("%s cost the ephemeral table %+v, want %v writes", what, e, wantWrites)
		}
	}
	tb.meter.Reset()
	replayed := m.d.login(t, h.now)
	wantAnswer(t, "login", h.logIn(t, replayed), answer{status: http.StatusOK})
	cost("POST /session", 2)
	wantAnswer(t, "replay", h.logIn(t, replayed), answer{status: http.StatusUnauthorized, code: "login_refused"})
	cost("POST /session, replayed", 2)
	wantAnswer(t, "revoke", h.revoke(t, m), answer{status: http.StatusNotFound, code: "not_found"})
	cost("DELETE /links/{random} (a signed request)", 2)
	forger := &device{dsk: newDevice(t).dsk, id: m.d.id, account: m.d.account}
	wantAnswer(t, "forged", h.logIn(t, forger.login(t, h.now)), answer{status: http.StatusUnauthorized, code: "login_refused"})
	cost("POST /session, forged", 0)

	for range LoginsPerMinute - 3 {
		wantAnswer(t, "login", h.logIn(t, m.d.login(t, h.now)), answer{status: http.StatusOK})
	}
	tb.meter.Reset()
	for range 10 {
		wantAnswer(t, "past the minute", h.logIn(t, m.d.login(t, h.now)), limited(time.Minute))
	}
	cost("POST /session, past the minute, known", 0)
	// Another instance learns it from one refused write.
	tb.wire(h)
	for range 10 {
		wantAnswer(t, "past the minute, another instance", h.logIn(t, m.d.login(t, h.now)), limited(time.Minute))
	}
	cost("POST /session, past the minute, on another instance", 1)

	// Set up again: the old device writes nothing.
	h.loggedIn(t, newDevice(t), true)
	tb.meter.Reset()
	wantAnswer(t, "replaced", h.logIn(t, m.d.login(t, h.now)), answer{status: http.StatusGone, code: "account_replaced"})
	wantAnswer(t, "replaced, signed", h.revoke(t, m), answer{status: http.StatusGone, code: "account_replaced"})
	cost("a replaced account's login and signed request", 0)
}

// wire gives h's server fresh stores on the tables, with nothing in
// memory: another instance of the function.
func (tb *directoryTables) wire(h *harness) {
	now := func() time.Time { return h.now }
	h.server.Directory = &directory.Store{DB: tb.meter, Table: tb.directory}
	h.server.Limits = &ephemeral.Limiter{DB: tb.meter, Table: tb.ephemeral, Now: now}
	h.server.Nonces = &ephemeral.Nonces{DB: tb.meter, Table: tb.ephemeral, Now: now}
	h.router = httpapi.NewRouter()
	h.server.Routes(h.router)
}
