package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/logx"
)

// DeleteStep is about how many writes one step of deleting an account, or
// what is left of one it replaced, makes (DELETE /account, POST
// /account/cleanup), however much is left: each step reads only what it
// deletes, and one step at a time runs for an account
// (directory.Store.Lease). A table takes at most 200 writes a second in
// production and 100 elsewhere (infra: table_max_write_units): a step of 50
// takes a quarter of a second of production's (half a second elsewhere),
// and with the app's one-second pause between steps a deletion makes about
// 40 writes a second, so two at once, even back to back, leave at least
// half of production's capacity to everyone else. An account with 4,000
// mailboxes (some 8,000 items) takes about 160 steps, three minutes or so.
const DeleteStep = 50

// deleteAccount deletes what the server holds for the caller's account: its
// waiting envelopes, links, mailboxes, invitation codes, devices and the
// account itself, and the Telegram item, so the same Telegram user can set
// up again (DELETE /account, signed). Nothing is kept, not even a marker.
// Short-lived records (rate counters, socket records) expire on their own
// within a day.
//
// It works in steps: while more is left, it answers 409 in_progress and the
// app repeats the request; the last step answers 200. The first step marks
// the account as being deleted and deletes its link
// (directory.Store.MarkDeleting), in one transaction, so from then on
// nothing is delivered to it, its codes stop working, and it takes no
// request but GET /account, which says so, and this one: the app carries on
// at its next launch, and the account is never left in use with part of it
// gone. What is left of accounts it replaced goes next, since deleting its
// item would forget them; then the rest of what it owns; the account and
// its devices last, so every step can log in. Requests sent at once don't
// each delete the same items: while one step runs, and for a second after
// (directory.Store.Lease), another is answered in_progress.
//
// A conflict with another write is answered in_progress too, never as done.
// Once the account is gone, a repeat is refused like any login of a
// removed device (401 login_refused), which the app takes as done (its
// earlier answer was lost).
func (s *Server) deleteAccount(ctx context.Context, _ httpapi.Request, c caller) httpapi.Response {
	const route = "DELETE /account"
	release, ok, err := s.lease(ctx, route, c.AccountID)
	if err != nil {
		return s.internal(route, err)
	}
	if !ok {
		return inProgress()
	}
	// The account item goes with the last step, the lease with it.
	defer release(false)
	if !c.device.Deleting {
		err := s.Directory.MarkDeleting(ctx, c.AccountID)
		switch {
		case errors.Is(err, directory.ErrNotFound):
			// Gone since this request logged in (another request finished
			// it, or a replacement ended it): nothing of it is left to delete.
			return httpapi.JSON(http.StatusOK, map[string]string{})
		case errors.Is(err, directory.ErrConflict):
			// Its link changed meanwhile: marked at the next request.
			return inProgress()
		case err != nil:
			return s.internal(route, err)
		}
	}
	if len(c.device.Leftovers) > 0 {
		if _, err := s.cleanUpStep(ctx, c.AccountID, c.device.Leftovers[0], DeleteStep); err != nil {
			return s.internal(route, err)
		}
		return inProgress()
	}
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
		done, err = true, nil
	}
	if err != nil {
		return s.internal(route, err)
	}
	if !done {
		return inProgress()
	}
	// The app's sockets don't say when they close (there's no $disconnect
	// route), so their records go here. If that fails, they expire within
	// the hour; the account is gone either way.
	if s.Sockets != nil {
		if err := s.Sockets.ForgetAll(ctx, c.AccountID); err != nil {
			s.Log.Warn("socket records not deleted", slog.String(logx.KeyRoute, route), logx.ErrorKind(err))
		}
	}
	return httpapi.JSON(http.StatusOK, map[string]string{})
}

// cleanUp deletes, in steps, what is left of the accounts the caller's
// replaced when it was set up (POST /account/cleanup, signed): the old
// devices' waiting envelopes, and the old accounts' mailboxes, invitation
// codes and the records of them. The replacement ended them at once (none
// of it is used any more: directory.Store.Replace), and its own request
// took the first step, so this only frees what they held. While more is
// left, or another step runs, it answers 409 in_progress and the app
// repeats the request a second later; then 200, also when nothing was
// left. GET /account says whether anything is (cleanup), so an app closed
// halfway carries on at its next launch.
func (s *Server) cleanUp(ctx context.Context, _ httpapi.Request, c caller) httpapi.Response {
	const route = "POST /account/cleanup"
	if len(c.device.Leftovers) == 0 {
		return httpapi.JSON(http.StatusOK, map[string]string{})
	}
	done, err := s.leasedCleanUp(ctx, route, c.AccountID, c.device.Leftovers)
	if err != nil {
		return s.internal(route, err)
	}
	if !done {
		return inProgress()
	}
	return httpapi.JSON(http.StatusOK, map[string]string{})
}

// leasedCleanUp is cleanUpStep, with a full step's budget, on the first of
// leftovers, once it holds the account's lease; it reports whether nothing
// of any of them is left (not done while another step holds it). Once
// nothing is, the lease goes from the account item.
func (s *Server) leasedCleanUp(ctx context.Context, route, accountID string, leftovers []string) (bool, error) {
	release, ok, err := s.lease(ctx, route, accountID)
	if err != nil || !ok {
		return false, err
	}
	done := false
	defer func() { release(done) }()
	first, err := s.cleanUpStep(ctx, accountID, leftovers[0], DeleteStep)
	done = err == nil && first && len(leftovers) == 1
	return done, err
}

// lease takes the account's lease for one step (directory.Store.Lease).
// release ends it: the next step may start a second later, or, done, the
// lease goes from the item. One that fails is logged, and the lease
// expires on its own.
func (s *Server) lease(ctx context.Context, route, accountID string) (release func(done bool), ok bool, err error) {
	end, ok, err := s.Directory.Lease(ctx, accountID, s.Now())
	if err != nil || !ok {
		return nil, ok, err
	}
	return func(done bool) {
		if err := end(ctx, s.Now(), done); err != nil {
			s.Log.Warn("step lease not released", slog.String(logx.KeyRoute, route), logx.ErrorKind(err))
		}
	}, true, nil
}

// cleanUpStep takes one step of deleting what is left of old, an account
// that accountID replaced: what still waits for its devices first (they
// can't fetch it), then its items (directory.Store.CleanUp), within about
// budget writes. It reports whether nothing is left. The caller holds the
// account's lease.
func (s *Server) cleanUpStep(ctx context.Context, accountID, old string, budget int) (bool, error) {
	devices, err := s.Directory.Devices(ctx, old, s.Now())
	if err != nil {
		return false, err
	}
	for _, d := range devices {
		n, more, err := s.Inbox.Clear(ctx, old, d, budget)
		if err != nil {
			return false, err
		}
		if more || n >= budget {
			return false, nil
		}
		budget -= n
	}
	return s.Directory.CleanUp(ctx, accountID, old, budget)
}

func inProgress() httpapi.Response {
	return httpapi.Error(http.StatusConflict, "in_progress")
}
