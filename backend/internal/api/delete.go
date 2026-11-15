package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
)

// DeleteStep is about how many items one DELETE /account call deletes. A
// table takes at most 100 writes a second (infra: table_max_write_units), so
// a step of 150 takes it about a second and a half and leaves room for
// everyone else; the app waits a second between steps. An account with
// 2,000 mailboxes needs about 30 steps.
const DeleteStep = 150

// deleteAccount deletes what the server holds for the caller's account: its
// waiting envelopes, links, mailboxes, invitation codes, devices and the
// account itself, and the Telegram item, so the same Telegram user can set
// up again (DELETE /account, signed). Nothing is kept, not even a marker.
// Short-lived records (rate counters, socket records) expire on their own
// within a day.
//
// It works in steps: while more is left, it answers 409 in_progress and the
// app repeats the request; the last step answers 200. Links go in the first
// step, so first messages stop at once, and the account and its devices
// last, so every step can log in. Apps from before steps show an error
// instead, and trying again carries on.
func (s *Server) deleteAccount(ctx context.Context, _ httpapi.Request, c caller) httpapi.Response {
	const route = "DELETE /account"
	devices, err := s.Directory.Devices(ctx, c.AccountID, s.Now())
	if err != nil {
		return s.internal(route, err)
	}
	budget := DeleteStep
	// Envelopes first: once the account is gone, the device can't ask again.
	for _, d := range devices {
		n, more, err := s.Inbox.Clear(ctx, c.AccountID, d, budget)
		if err != nil {
			return s.internal(route, err)
		}
		if more || n >= budget {
			return inProgress()
		}
		budget -= n
	}
	done, err := s.Directory.Delete(ctx, c.AccountID, c.device.TelegramHash, budget)
	if errors.Is(err, directory.ErrNotFound) {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	if err != nil {
		return s.internal(route, err)
	}
	if !done {
		return inProgress()
	}
	return httpapi.JSON(http.StatusOK, map[string]string{})
}

func inProgress() httpapi.Response {
	return httpapi.Error(http.StatusConflict, "in_progress")
}
