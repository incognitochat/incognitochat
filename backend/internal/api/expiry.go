package api

import (
	"cmp"
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/logx"
)

// ExpiryMode says what the scheduled account expiry does (ACCOUNT_EXPIRY in
// infra/functions.tf; docs/deployment.md, Account expiry).
type ExpiryMode string

const (
	// ExpiryOff does nothing.
	ExpiryOff ExpiryMode = "off"
	// ExpiryDryRun counts the accounts it would delete, and logs how many;
	// it deletes nothing.
	ExpiryDryRun ExpiryMode = "dry-run"
	// ExpiryOn deletes them.
	ExpiryOn ExpiryMode = "on"
)

// ParseExpiryMode reads ACCOUNT_EXPIRY: unset is the dry run, and a value it
// doesn't know is off, so a mistake deletes nothing.
func ParseExpiryMode(v string) ExpiryMode {
	switch m := ExpiryMode(v); m {
	case ExpiryOff, ExpiryDryRun, ExpiryOn:
		return m
	case "":
		return ExpiryDryRun
	}
	return ExpiryOff
}

const (
	// expirySteps bounds a run: at most this many deletion steps, of about
	// DeleteStep write units each, one a second (expiryPace), as one app
	// deleting its account takes them (DeleteStep): a run uses about a
	// quarter of production's write capacity, for a few seconds. A small
	// account goes in one step, a big one carries on in the next runs. Every
	// 15 minutes (infra/functions.tf), that's up to about 480 steps a day.
	expirySteps = 5
	// expiryPace is the pause after each step.
	expiryPace = time.Second
	// expiryStepTime is the time left before the run's deadline that a step
	// needs to start: a step cut short is taken again later, but the run
	// stops in time rather than leave one halfway.
	expiryStepTime = 2 * time.Second
	// expiryBatch is how many unused accounts a run reads, the oldest
	// first: more than it can delete, for those it leaves alone (used
	// since they were listed, or another step holds them).
	expiryBatch = 25
	// expiryCountMax bounds the dry run's count.
	expiryCountMax = 10_000
	// expiryRoute names the expiry in the logs.
	expiryRoute = "account expiry"
)

// ExpireAccounts deletes some of the accounts nobody has used for over
// directory.ExpireAfter months (no login since: the app logs in at every
// launch), in the steps DELETE /account takes (deleteStep), or, in the dry
// run, only counts them (Expiry). The function runs it every 15 minutes,
// on a schedule's event (backend/cmd/api, infra/functions.tf); nothing
// else reaches it.
//
// A run is bounded (expirySteps, paced) and the next carries on: an account
// whose deletion started stays in the last-use index until it's gone, and,
// last used the earliest, comes first again. An account used since it was
// listed (a login moved its month on) is left alone: Expire marks it only
// while its month is the one read. One another step holds (its own app
// deleting it) is left to that step. It logs counts only, never an account
// or a month, and returns an error if anything failed (each account's is
// logged by its kind).
func (s *Server) ExpireAccounts(ctx context.Context) error {
	if s.Unused == nil || (s.Expiry != ExpiryOn && s.Expiry != ExpiryDryRun) {
		return nil
	}
	lastExpired := directory.LastExpiredMonth(s.Now())
	if s.Expiry == ExpiryDryRun {
		n, more, err := s.Unused.CountUnused(ctx, lastExpired, expiryCountMax)
		if err != nil {
			s.Log.Warn("account expiry failed", slog.String(logx.KeyRoute, expiryRoute), logx.ErrorKind(err))
			return err
		}
		msg := "account expiry dry run: accounts it would delete"
		if more {
			msg += " (at least)"
		}
		s.Log.Warn(msg, slog.String(logx.KeyRoute, expiryRoute), slog.Int(logx.KeyCount, n))
		return nil
	}

	accounts, err := s.Unused.Unused(ctx, lastExpired, expiryBatch)
	if err != nil {
		s.Log.Warn("account expiry failed", slog.String(logx.KeyRoute, expiryRoute), logx.ErrorKind(err))
		return err
	}
	steps, deleted, failed := 0, 0, 0
	var first error
	for _, a := range accounts {
		done, err := s.expire(ctx, a, lastExpired, &steps)
		if err != nil {
			failed++
			first = cmp.Or(first, err)
		}
		if done {
			deleted++
		}
		if steps >= expirySteps || ctx.Err() != nil {
			break
		}
	}
	s.Log.Warn("account expiry: accounts deleted", slog.String(logx.KeyRoute, expiryRoute), slog.Int(logx.KeyCount, deleted))
	if failed > 0 {
		s.Log.Warn("account expiry: accounts that failed", slog.String(logx.KeyRoute, expiryRoute),
			slog.Int(logx.KeyCount, failed), logx.ErrorKind(first))
	}
	return first
}

// expire takes steps of deleting an unused account while the run has steps
// left (steps counts the run's), each after a pause (expiryPace) if
// another came before it, and reports whether the account is gone. A big
// account takes the rest of the run's steps, and the next run carries on.
func (s *Server) expire(ctx context.Context, a directory.UnusedAccount, lastExpired string, steps *int) (bool, error) {
	for *steps < expirySteps {
		d, err := s.Unused.AccountState(ctx, a.ID)
		if errors.Is(err, directory.ErrNotFound) {
			return false, nil // gone already
		}
		if err != nil {
			return false, err
		}
		// Used since it was listed (the index lags), or no account to
		// expire (a replaced account's marker, or the stub of one replaced
		// while it was being deleted, which has no month): left alone. An
		// account being deleted keeps its month (Used writes none then).
		if d.Replaced || d.LastUse == "" || d.LastUse > lastExpired {
			return false, nil
		}
		if *steps > 0 {
			if err := s.pause(ctx, expiryPace); err != nil {
				return false, err
			}
		}
		if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < expiryStepTime {
			*steps = expirySteps
			return false, nil
		}
		release, ok, err := s.lease(ctx, expiryRoute, a.ID)
		if err != nil || !ok {
			return false, err
		}
		*steps++
		done, err := s.expireStep(ctx, a.ID, d)
		release(false)
		if err != nil || done {
			return done, err
		}
	}
	return false, nil
}

// expireStep takes one step of deleting an unused account, whose lease the
// caller holds: the first marks it as being deleted (directory.Store.Expire,
// only if it wasn't used since), as DELETE /account's first does; each
// then deletes what it can (deleteStep). It reports whether the account is
// gone.
func (s *Server) expireStep(ctx context.Context, accountID string, d directory.Device) (bool, error) {
	if !d.Deleting {
		err := s.Unused.Expire(ctx, accountID, d.LastUse)
		switch {
		case errors.Is(err, directory.ErrNotFound), errors.Is(err, directory.ErrConflict):
			// Gone or replaced, used since, or its link changed meanwhile
			// (the next run reads it again).
			return false, nil
		case err != nil:
			return false, err
		}
		d.Deleting = true
	}
	return s.deleteStep(ctx, expiryRoute, accountID, d)
}

// pause waits d, or until ctx ends.
func (s *Server) pause(ctx context.Context, d time.Duration) error {
	if s.sleep != nil {
		return s.sleep(ctx, d)
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
