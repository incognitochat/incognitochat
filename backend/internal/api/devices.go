package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
)

// Each login and signed request writes its nonce to the ephemeral table,
// which every login, send and signed request shares (200 writes a second
// in production). So each device's are limited, in a minute, a quarter of
// an hour and a UTC day, after its signature checks out and before its
// nonce is written (deviceLimit). The limits sit well above what the app
// sends; past one, 429 device_limit with when its window ends. They go by
// the device, so by the account: setting up again (RegistrationsPerDay)
// starts a new device with days of its own, so one Telegram user has at
// most that many days' worth more in a day.
//
// Logins: the app logs in at each launch (opening a link or a notice
// starts it again), and every 15 minutes while it shows; a login that
// fails for want of the server waits 5 to 10 seconds, then longer each
// time. Tapping through links as fast as Telegram opens them makes 10 to
// 15 a minute; a few copies of the app on one device (windows, tabs) share
// its key, and so its limits. Being refused means no messages until the
// window ends, and for a day's limit that is UTC midnight: a copy left
// showing all day logs in about 100 times, so the day allows ten times
// that.
const (
	LoginsPerMinute  = 20
	LoginsPerQuarter = 60
	LoginsPerDay     = 1000
)

// Signed requests: a link change is one, or a few (a conflict tried again,
// an old link revoked with it); a key rotation one every few days; an
// invitation or an admin's change one per tap. Deleting an account, or
// what is left of one it replaced, takes a step about every second and a
// half while it runs (the app pauses a second after each answer; 4,000
// mailboxes take some 160 steps), at most 400 a run of 10 minutes, and
// every copy of the app open runs it, the others answered in_progress
// while one step holds the account (DeleteStep): those steps count apart,
// in StepsPerMinute and StepsPerQuarter, while the account item says there
// is such work, so a cleanup never holds up the link change after it, and
// two copies are slowed, not stopped. All of them share SignedPerDay.
const (
	SignedPerMinute  = 30
	SignedPerQuarter = 60
	SignedPerDay     = 2000
	StepsPerMinute   = 90
	StepsPerQuarter  = 900
)

// Every request with a session token (every logged-in route, signed ones
// too) reads the device and its account from the directory, strongly, a
// read unit, before anything else; the directory takes 400 a second in
// production, and logins, sends and every logged-in request need it. So
// each device's are limited too, once its token checks out and before
// that read (sessionLimit). The app makes: an inbox fetch every 20
// seconds without a push socket (every 2 minutes with one), per copy
// open; 2 at each home screen, 4 to 9 at a launch; a deletion or cleanup
// step about every second and a half while one runs (StepsPerMinute holds
// two copies to 90); and little else (tokens, mailboxes, the Usage
// screen, by taps). What others make it do is paced on the whole device,
// whatever the copies open (web/src/sync/pace.ts): the syncs pushes ask
// for, a page and its confirmation, at most one every 5 seconds, and one
// every 15 once a flood has lasted half an hour; so however many messages
// come in, at most about 24 a minute, 360 a quarter and 12,000 a day,
// well under half of each limit. Tapping through links makes about 60 to
// 90 a minute, 2 copies deleting about 120; a copy left showing all day
// without a socket about 4,300 a day. Being refused holds up the inbox
// until the window ends, for the day's limit until UTC midnight, so the
// day allows several copies open all day and a heavy day's use.
//
// The table isn't written for each one: each instance counts a device's
// requests in memory and writes them SessionBatch at a time (ephemeral
// Budget.Batch), or at once when they might reach a limit. So a window
// lets through, past its limit, at most what other instances hold
// unwritten, fewer than SessionBatch each.
const (
	SessionRequestsPerMinute  = 180
	SessionRequestsPerQuarter = 1200
	SessionRequestsPerDay     = 30000
	SessionBatch              = 10
	// While the counts can't be written (sessionLimit), each instance
	// lets a device make SessionRequestsLocalPerMinute a minute, and all
	// devices together UncountedPerMinute, on its own counts. Each reads
	// at most 1.5 directory units (GET /invitations with codes; most read
	// 1), so 100 instances read at most half the directory's 400 a second
	// for them, however many accounts there are.
	SessionRequestsLocalPerMinute = 30
	UncountedPerMinute            = 80
)

var (
	loginBudget   = ephemeral.Budget{Kind: "l", Day: "l", PerMinute: LoginsPerMinute, PerQuarter: LoginsPerQuarter, PerDay: LoginsPerDay}
	signedBudget  = ephemeral.Budget{Kind: "s", Day: "s", PerMinute: SignedPerMinute, PerQuarter: SignedPerQuarter, PerDay: SignedPerDay}
	stepBudget    = ephemeral.Budget{Kind: "c", Day: "s", PerMinute: StepsPerMinute, PerQuarter: StepsPerQuarter, PerDay: SignedPerDay}
	sessionBudget = ephemeral.Budget{Kind: "t", Day: "t", PerMinute: SessionRequestsPerMinute, PerQuarter: SessionRequestsPerQuarter, PerDay: SessionRequestsPerDay, Batch: SessionBatch}
)

// budgetFor is the budget a signed request on route counts in: a step of
// deleting the account, or what is left of one it replaced, while the
// account item says there is such work (it is being deleted, or has
// leftovers), counts as a step; anything else as a signed request.
func budgetFor(route string, d directory.Device) ephemeral.Budget {
	step := route == "DELETE /account" || route == "POST /account/cleanup"
	if step && (d.Deleting || len(d.Leftovers) > 0) {
		return stepBudget
	}
	return signedBudget
}

// refusal ends a signature check (session.Gate) with an answer, before
// anything is written for the request.
type refusal struct{ resp httpapi.Response }

func (refusal) Error() string { return "api: refused before the nonce" }

// deviceLimit counts a device's login or signed request in b (session.Gate:
// only once its signature checks out, and before its nonce is written),
// by the server's clock. Its row is named by a keyed hash of the account,
// the device and the UTC day (rateName), never their IDs. It refuses, as a
// refusal, a request past b (429 device_limit, with when the window that
// is used up ends), counting nothing: a device known to be past it is
// refused from memory, for free. A count that can't be taken (the table
// throttled, say) is 503 unavailable: never let through uncounted, nor
// taken for a limit. A request counted here stays counted, whatever
// follows: a replayed nonce, refused next, included.
func (s *Server) deviceLimit(ctx context.Context, route string, b ephemeral.Budget, accountID, deviceID string, now time.Time) error {
	full, err := s.Limits.SpendAt(ctx, s.rateName("dev", now, 24*time.Hour, accountID, deviceID), b, now)
	switch {
	case err != nil:
		s.rateFailed(route, err)
		resp := httpapi.Error(http.StatusServiceUnavailable, "unavailable")
		resp.Headers["retry-after"] = strconv.Itoa(RetryAfter)
		return refusal{resp}
	case full > 0:
		return refusal{limitReached("device_limit", now, full)}
	}
	return nil
}

// sessionLimit counts a request with a session token in its device's
// sessionBudget (in the same row as deviceLimit's), once the token checks
// out and before anything is read for it: a token that doesn't check out,
// or is over, is refused 401 before this, whatever the device's count, so
// only whoever holds the device's token can use up its requests, or learn
// of them. A request past the budget is refused (429 device_limit, with
// when the window ends) reading nothing; from memory, once this instance
// knows, writing nothing either. Counts go to the table in batches
// (SessionBatch). If they can't be written (the table throttled, say), the
// request goes on, uncounted, if this instance alone has let the device
// make fewer than SessionRequestsLocalPerMinute this minute (else 429), and
// all devices fewer than UncountedPerMinute (else 503 unavailable: not the
// device's doing). Refusing them all would turn trouble with the ephemeral
// table into an outage of every logged-in route (the inbox's own limits
// let it go on likewise, listInbox); letting them all through would give
// the directory away to whoever throttles that table. After any count of
// the instance's fails to be written, it tries none for a few seconds,
// and every request goes through these allowances (ephemeral.ErrResting,
// not logged again).
func (s *Server) sessionLimit(ctx context.Context, route, accountID, deviceID string, now time.Time) (httpapi.Response, bool) {
	name := s.rateName("dev", now, 24*time.Hour, accountID, deviceID)
	full, err := s.Limits.SpendAt(ctx, name, sessionBudget, now)
	switch {
	case err != nil:
		if !errors.Is(err, ephemeral.ErrResting) {
			s.rateFailed(route, err)
		}
		minute := s.rateName("dev", now, time.Minute, accountID, deviceID)
		if !s.Limits.LocalAt(minute, 1, SessionRequestsLocalPerMinute, time.Minute, now) {
			return limitReached("device_limit", now, time.Minute), true
		}
		// Every device's, named by the minute (in memory only).
		if !s.Limits.LocalAt("uncounted#"+strconv.FormatInt(now.Truncate(time.Minute).Unix(), 10), 1, UncountedPerMinute, time.Minute, now) {
			unavailable := httpapi.Error(http.StatusServiceUnavailable, "unavailable")
			unavailable.Headers["retry-after"] = strconv.Itoa(RetryAfter)
			return unavailable, true
		}
	case full > 0:
		return limitReached("device_limit", now, full), true
	}
	return httpapi.Response{}, false
}
