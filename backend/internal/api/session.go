package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/devicesig"
	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/logx"
	"github.com/incognitochat/incognitochat/backend/internal/session"
)

type sessionRequest struct {
	Account   string  `json:"account"`
	Device    string  `json:"device"`
	Timestamp int64   `json:"timestamp"`
	Nonce     string  `json:"nonce"`
	Signature bytes64 `json:"signature"`
}

// session logs a device in (docs/protocol.md, Registration and sessions). A
// device of a replaced account learns so only after its signature checks out.
// Whatever can be refused without the device's key (a timestamp out of range,
// a malformed nonce or signature) is refused before the directory is read.
// Nothing is written before the signature checks out, and nothing at all
// for a replaced account; then the device's limits are counted (429
// device_limit past them), and only then is the nonce written.
func (s *Server) session(ctx context.Context, req httpapi.Request) httpapi.Response {
	const route = "POST /session"
	var in sessionRequest
	if err := httpapi.DecodeJSON(req, &in); err != nil {
		return httpapi.DecodeError(err)
	}
	if !ids.Valid(in.Account) || !ids.Valid(in.Device) {
		return httpapi.Error(http.StatusBadRequest, "bad_request")
	}
	now := s.Now()
	login := session.Login{
		AccountID: in.Account,
		DeviceID:  in.Device,
		Timestamp: in.Timestamp,
		Nonce:     in.Nonce,
		Signature: in.Signature,
	}
	// Before the directory is read, so the answer says nothing about the
	// device: first the clock, then the rest that needs no key.
	if err := session.Precheck(login, now); errors.Is(err, session.ErrClockSkew) {
		return clockSkew(now)
	} else if err != nil {
		return httpapi.Error(http.StatusUnauthorized, "login_refused")
	}

	// Eventually consistent, at half the cost: every request with the token
	// reads the device again, strongly, so one just replaced is refused then.
	device, err := s.Directory.LoginDevice(ctx, in.Account, in.Device, now)
	if errors.Is(err, directory.ErrNotFound) {
		return httpapi.Error(http.StatusUnauthorized, "login_refused")
	}
	if err != nil {
		return s.internal(route, err)
	}
	key, err := devicesig.ParsePublicKey(device.Key)
	if err != nil {
		return s.internal(route, err)
	}

	// Once the signature checks out, and before the nonce is written: a
	// replaced account's device is told so, writing nothing; any other
	// login counts against the device's limits (deviceLimit), a replayed
	// one too.
	err = session.Check(ctx, login, key, s.Nonces, now, func() error {
		if device.Replaced {
			return refusal{httpapi.Error(http.StatusGone, "account_replaced")}
		}
		return s.deviceLimit(ctx, route, loginBudget, in.Account, in.Device, now)
	})
	var stopped refusal
	if errors.As(err, &stopped) {
		return stopped.resp
	}
	if errors.Is(err, session.ErrLogin) {
		return httpapi.Error(http.StatusUnauthorized, "login_refused")
	}
	if err != nil {
		return s.internal(route, err)
	}
	s.recordUse(ctx, route, in.Account, device, now)
	return s.issue(route, in.Account, in.Device, now)
}

// recordUse records that the account is used this month (UTC), if its item
// says an earlier one or none (directory.Store.Used): at a login, which the
// app makes at each launch and every 15 minutes while open (session.TTL),
// so an account in use is never taken for unused (expiry.go), and the
// month is written about once a month per account. Nothing finer than the
// month is stored. Not for an account being deleted.
//
// The first such write of a month in this instance also notes the month on
// the settings item the expiry's guard reads (directory.Store.UseRecorded),
// which only a login's write moves on: the expiry deletes nothing unless
// it's this month's or last month's, so logins that stop recording, for
// whatever reason, can't make accounts in use look unused a year later.
//
// A failure doesn't refuse the login (the next one tries again), but is
// logged as an error, UseNotRecorded, which an alarm watches
// (infra/metrics.tf).
func (s *Server) recordUse(ctx context.Context, route, accountID string, d directory.Device, now time.Time) {
	month := directory.Month(now)
	if d.Deleting || d.LastUse >= month {
		return
	}
	written, err := s.Directory.Used(ctx, accountID, month)
	if err == nil && written && s.noteUse(month) {
		if err = s.Directory.UseRecorded(ctx, month); err != nil {
			s.forgetUse(month)
		}
	}
	if err != nil {
		s.Log.Error(MsgUseNotRecorded, slog.String(logx.KeyRoute, route), logx.ErrorKind(err))
	}
}

// noteUse reports whether this instance has yet to note month (useNoted),
// and takes it.
func (s *Server) noteUse(month string) bool {
	s.useNoted.Lock()
	defer s.useNoted.Unlock()
	if s.useNoted.month >= month {
		return false
	}
	s.useNoted.month = month
	return true
}

// forgetUse lets the next login note month again, after a failed note.
func (s *Server) forgetUse(month string) {
	s.useNoted.Lock()
	defer s.useNoted.Unlock()
	if s.useNoted.month == month {
		s.useNoted.month = ""
	}
}

// MsgUseNotRecorded is logged, as an error, when a login couldn't record
// its account's month of use, or note it for the expiry's guard. A metric
// filter counts it
// (infra/metrics.tf): keep the two the same.
const MsgUseNotRecorded = "month of use not recorded"
