package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/incognitochat/incognitochat/backend/internal/devicesig"
	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/session"
)

type sessionRequest struct {
	Account   string  `json:"account"`
	Device    string  `json:"device"`
	Timestamp int64   `json:"timestamp"`
	Nonce     string  `json:"nonce"`
	Signature bytes64 `json:"signature"`
}

// session logs a device in (design §7). A device of a replaced account learns
// so only after its signature checks out. Whatever can be refused without
// the device's key (a timestamp out of range, a malformed nonce or
// signature) is refused before the directory is read.
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
	return s.issue(route, in.Account, in.Device, now)
}
