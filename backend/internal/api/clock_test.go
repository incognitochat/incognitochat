package api

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/devicelist"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/session"
)

// wantClockSkew checks the answer to a time outside the window: 401
// clock_skew with the server's clock, and nothing else.
func wantClockSkew(t *testing.T, status int, out map[string]any, now time.Time) {
	t.Helper()
	wantError(t, status, out, http.StatusUnauthorized, "clock_skew")
	if out["now"] != float64(now.Unix()) || len(out) != 2 {
		t.Fatalf("clock_skew answer %v, want now %d", out, now.Unix())
	}
}

// A device whose clock is off is told so, with the server's clock, before
// anything about it is read; with the corrected time it logs in.
func TestLoginWithClockOff(t *testing.T) {
	h := newHarness(t)
	d := newDevice(t)
	if status, out := h.register(t, d, false); status != http.StatusOK {
		t.Fatalf("register: %d %v", status, out)
	}

	for _, off := range []time.Duration{5 * time.Minute, -3*time.Hour - 30*time.Minute, time.Minute + time.Second} {
		reads := h.dir.deviceReads
		status, out := h.post(t, "/session", d.login(t, h.now.Add(off)))
		wantClockSkew(t, status, out, h.now)
		if h.dir.deviceReads != reads {
			t.Fatalf("%v off: the directory was read", off)
		}
	}

	// A device that doesn't exist gets the very same answer: it says
	// nothing about whether one does.
	unknown := newDevice(t)
	unknown.account = ids.New()
	status, out := h.post(t, "/session", unknown.login(t, h.now.Add(5*time.Minute)))
	wantClockSkew(t, status, out, h.now)

	// With the server's time, the device logs in.
	server := time.Unix(int64(out["now"].(float64)), 0)
	if status, out := h.post(t, "/session", d.login(t, server)); status != http.StatusOK || out["account"] != d.account {
		t.Fatalf("login with the server's time: %d %v", status, out)
	}
	// Within the window, as before.
	if status, out := h.post(t, "/session", d.login(t, h.now.Add(time.Minute))); status != http.StatusOK {
		t.Fatalf("login a minute fast: %d %v", status, out)
	}
}

// A signed request is told the same, before the device is read.
func TestSignedRequestWithClockOff(t *testing.T) {
	h := newHarness(t)
	owner := h.account(t, userID)
	l := newLinkKeys(t)

	reads := h.dir.deviceReads
	status, out := h.callAt(t, owner.d, owner.token, http.MethodPost, "/links", l.create(t, h.now), h.now.Add(5*time.Minute))
	wantClockSkew(t, status, out, h.now)
	if h.dir.deviceReads != reads {
		t.Fatal("the directory was read")
	}
	if len(h.dir.links) != 0 {
		t.Fatal("the link was created")
	}

	// Signed again with the server's time, it goes through.
	server := time.Unix(int64(out["now"].(float64)), 0)
	if status, out := h.callAt(t, owner.d, owner.token, http.MethodPost, "/links", l.create(t, h.now), server); status != http.StatusCreated {
		t.Fatalf("signed with the server's time: %d %v", status, out)
	}
}

// Registration signs a device list with the device's clock: one too far off
// is told the server's, and registers once it signs with that.
func TestRegisterWithClockOff(t *testing.T) {
	h := newHarness(t)
	d := newDevice(t)
	fast := h.now.Add(3*time.Hour + 30*time.Minute)
	status, out := h.post(t, "/register", d.registration(t, h.now, func(_ map[string]any, list *devicelist.List, _ *string) {
		*list = d.firstList(t, fast)
	}))
	wantClockSkew(t, status, out, h.now)
	if len(h.dir.accounts) != 0 {
		t.Fatal("an account was stored")
	}
	server := time.Unix(int64(out["now"].(float64)), 0)
	status, out = h.post(t, "/register", d.registration(t, h.now, func(_ map[string]any, list *devicelist.List, _ *string) {
		*list = d.firstList(t, server)
	}))
	if status != http.StatusOK {
		t.Fatalf("register with the server's time: %d %v", status, out)
	}
}

// Registration answers a device list dated by a wrong clock before it reads
// the Telegram user's item: nothing about whether they have an account.
func TestRegisterClockSkewBeforeTheTelegramRead(t *testing.T) {
	h := newHarness(t)
	d := newDevice(t)
	h.dir.fail = errors.New("the Telegram item was read")
	status, out := h.post(t, "/register", d.registration(t, h.now, func(_ map[string]any, list *devicelist.List, _ *string) {
		*list = d.firstList(t, h.now.Add(-3*time.Hour))
	}))
	wantClockSkew(t, status, out, h.now)
}

// The time of a signed request is answered before its session token is
// checked: an unknown or invalid token gets the very same answer.
func TestSignedRequestClockSkewWithAnyToken(t *testing.T) {
	h := newHarness(t)
	owner := h.account(t, userID)
	fast := h.now.Add(5 * time.Minute)
	body := newLinkKeys(t).create(t, h.now)
	for name, token := range map[string]string{"valid": owner.token, "invalid": "v1.garbage.mac", "none": ""} {
		status, out := h.callAt(t, owner.d, token, http.MethodPost, "/links", body, fast)
		if status != http.StatusUnauthorized || out["error"] != "clock_skew" || out["now"] != float64(h.now.Unix()) || len(out) != 2 {
			t.Errorf("%s token: %d %v", name, status, out)
		}
	}
}

// Both checks of a signed request's time use one reading of the clock: one
// right at the edge of the window, while the clock moves on during the
// request, passes both rather than failing the second as signature_rejected.
func TestSignedRequestAtTheEdgeOfTheWindow(t *testing.T) {
	h := newHarness(t)
	owner := h.account(t, userID)
	base := h.now
	reads := 0
	h.server.Now = func() time.Time {
		reads++
		return base.Add(time.Duration(reads-1) * time.Second)
	}
	status, out := h.callAt(t, owner.d, owner.token, http.MethodPost, "/links", newLinkKeys(t).create(t, base), base.Add(-session.MaxSkew))
	if status != http.StatusCreated {
		t.Fatalf("signed at the edge: %d %v (clock read %d times)", status, out, reads)
	}
}
