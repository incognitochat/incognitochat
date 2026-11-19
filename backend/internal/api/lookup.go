package api

import (
	"context"
	"net/http"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
)

// LookupsPerDay limits account lookups per Telegram user.
const LookupsPerDay = 30

type lookupRequest struct {
	InitData string `json:"initData"`
}

type lookupResponse struct {
	Exists bool `json:"exists"`
}

// lookupAccount tells a device that has no account whether its Telegram user
// has one, which then lives on another device (one device per account:
// docs/architecture.md, Accounts). The app asks on a plain launch, so a second
// device (say Telegram Desktop, opened from a notice) can say so instead of
// offering setup, which would replace the account. Only plain launches are
// accepted, as for notices, so this never tells the server whose link someone
// opened. Nothing is stored but the Telegram user's daily count of lookups
// (LookupsPerDay).
func (s *Server) lookupAccount(ctx context.Context, req httpapi.Request) httpapi.Response {
	const route = "POST /accounts/lookup"
	var in lookupRequest
	if err := httpapi.DecodeJSON(req, &in); err != nil {
		return httpapi.DecodeError(err)
	}
	if in.InitData == "" || len(in.InitData) > maxInitData {
		return httpapi.Error(http.StatusBadRequest, "bad_request")
	}
	launch, err := s.Telegram.Verify(in.InitData, s.Now())
	if err != nil || !PlainLaunch(launch.StartParam) {
		return httpapi.Error(http.StatusUnauthorized, "init_data_rejected")
	}
	telegramHash := directory.TelegramHash(s.Pepper, launch.UserID)
	ok, err := s.allow(ctx, "look", LookupsPerDay, 24*time.Hour, telegramHash)
	if err != nil {
		return s.internal(route, err)
	}
	if !ok {
		return httpapi.Error(http.StatusTooManyRequests, "rate_limited")
	}
	// An account being deleted doesn't count: setting up again replaces it
	// without asking (register).
	exists, err := s.Directory.AccountExists(ctx, telegramHash)
	if err != nil {
		return s.internal(route, err)
	}
	return httpapi.JSON(http.StatusOK, lookupResponse{Exists: exists})
}
