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

	err = session.Check(ctx, login, key, s.Nonces, now)
	if errors.Is(err, session.ErrLogin) {
		return httpapi.Error(http.StatusUnauthorized, "login_refused")
	}
	if err != nil {
		return s.internal(route, err)
	}
	if device.Replaced {
		return httpapi.Error(http.StatusGone, "account_replaced")
	}
	s.recordUse(ctx, route, in.Account, device, now)
	return s.issue(route, in.Account, in.Device, now)
}

// recordUse records that the account is used this month (UTC), if its item
// says an earlier one or none (directory.Store.Used): at a login, which the
// app makes at each launch and every 15 minutes while open (session.TTL),
// so an account in use is never taken for unused (expiry.go), and the
// month is written about once a month per account. Nothing finer than the
// month is stored. Not for an account being deleted. A failure is only
// logged: the next login tries again.
func (s *Server) recordUse(ctx context.Context, route, accountID string, d directory.Device, now time.Time) {
	month := directory.Month(now)
	if d.Deleting || d.LastUse >= month {
		return
	}
	if err := s.Directory.Used(ctx, accountID, month); err != nil {
		s.Log.Warn("recording the month of use failed", slog.String(logx.KeyRoute, route), logx.ErrorKind(err))
	}
}
