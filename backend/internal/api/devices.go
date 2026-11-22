package api

import (
	"context"
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
// sends; past one, 429 device_limit with when its window ends.
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

var (
	loginBudget  = ephemeral.Budget{Kind: "l", Day: "l", PerMinute: LoginsPerMinute, PerQuarter: LoginsPerQuarter, PerDay: LoginsPerDay}
	signedBudget = ephemeral.Budget{Kind: "s", Day: "s", PerMinute: SignedPerMinute, PerQuarter: SignedPerQuarter, PerDay: SignedPerDay}
	stepBudget   = ephemeral.Budget{Kind: "c", Day: "s", PerMinute: StepsPerMinute, PerQuarter: StepsPerQuarter, PerDay: SignedPerDay}
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
