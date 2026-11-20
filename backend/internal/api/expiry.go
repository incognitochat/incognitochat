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
	// expirySteps bounds a run: at most this many deletion steps that went
	// through, of about DeleteStep write units each, one a second
	// (expiryPace), as one app deleting its account takes them (DeleteStep):
	// a run uses about a quarter of production's write capacity, for a few
	// seconds. A small account goes in one step, a big one carries on in the
	// next runs. Every 15 minutes (infra/functions.tf), that's up to about
	// 480 steps a day.
	expirySteps = 5
	// expiryPace is the pause after each step.
	expiryPace = time.Second
	// expiryRetryPause is the pause after a step that failed (it frees the
	// account's lease at once, so the next try needn't wait for it).
	expiryRetryPause = 250 * time.Millisecond
	// expiryTries is how many failed steps an account gets in a run. Then
	// it's stuck for this run: the run goes on past it, and the next tries
	// it again (it stays in the index). Failed steps don't count against
	// expirySteps, so accounts that always fail can't take every run.
	expiryTries = 2
	// expiryMaxStuck stops a run that finds this many stuck accounts:
	// something wider is wrong.
	expiryMaxStuck = 10
	// expiryStepTime is the time left before the run's deadline that a step
	// needs to start: a step cut short is taken again later, but the run
	// stops in time rather than leave one halfway.
	expiryStepTime = 2 * time.Second
	// expiryBatch is how many unused accounts a run reads, the oldest
	// first: more than it can delete, for those it leaves alone (used
	// since they were listed, another step holds them) or gets stuck on.
	expiryBatch = 50
	// expiryCountMax bounds the dry run's count.
	expiryCountMax = 10_000
	// expiryRoute names the expiry in the logs.
	expiryRoute = "account expiry"
)

// What the expiry logs: constant lines with a count at most, never an
// account or a month. The errors (ExpiryProblems, which an alarm watches:
// infra/metrics.tf) are those at error level with expiryRoute.
const (
	msgExpiryDryRun  = "account expiry dry run: accounts it would delete"
	msgExpiryDeleted = "account expiry: accounts deleted"
	msgExpiryStuck   = "account expiry: accounts stuck"
	msgExpiryFailed  = "account expiry failed"
	msgExpiryPaused  = "account expiry paused: no login has recorded a recent month of use"
)

// errExpiryPaused fails a run that found no login had recorded a month of
// use this month or last (guard, msgExpiryPaused).
var errExpiryPaused = errors.New("api: account expiry paused: no recent month of use")

// ExpireAccounts deletes some of the accounts nobody has used for over
// directory.ExpireAfter months (no login since: the app logs in at every
// launch), in the steps DELETE /account takes (deleteStep), or, in the dry
// run, only counts them (Expiry). The function runs it every 15 minutes,
// on a schedule's event (backend/cmd/api, infra/functions.tf); nothing
// else reaches it.
//
// Whenever accounts are due, the dry run as well, it first checks that
// logins still record their month (guard): one must have this month or
// last (directory.Store.RecordedUse, which only a login's write moves on;
// a registration doesn't). If none has, logins have stopped recording it (a
// fault, or nobody used the deployment for a month), and accounts in use
// could look unused: it deletes nothing, logs msgExpiryPaused and fails,
// for the alarm.
//
// A run is bounded (expirySteps, paced) and the next carries on: an account
// whose deletion started stays in the last-use index until it's gone, and,
// last used the earliest, comes first again. An account used since it was
// listed (a login moved its month on) is left alone: Expire marks it only
// while its month is the one read. One another step holds (its own app
// deleting it) is left to that step. One whose steps keep failing is
// passed over after expiryTries, and counted as stuck. It returns an error
// if anything failed (logged by its kind, as an error).
func (s *Server) ExpireAccounts(ctx context.Context) error {
	if s.Unused == nil || (s.Expiry != ExpiryOn && s.Expiry != ExpiryDryRun) {
		return nil
	}
	now := s.Now()
	lastExpired := directory.LastExpiredMonth(now)
	if s.Expiry == ExpiryDryRun {
		n, more, err := s.Unused.CountUnused(ctx, lastExpired, expiryCountMax)
		if err != nil {
			return s.expiryFailed(err)
		}
		msg := msgExpiryDryRun
		if more {
			msg += " (at least)"
		}
		s.Log.Warn(msg, slog.String(logx.KeyRoute, expiryRoute), slog.Int(logx.KeyCount, n))
		if n > 0 {
			return s.guard(ctx, now)
		}
		return nil
	}

	accounts, err := s.Unused.Unused(ctx, lastExpired, expiryBatch)
	if err != nil {
		return s.expiryFailed(err)
	}
	if len(accounts) > 0 {
		if err := s.guard(ctx, now); err != nil {
			return err
		}
	}
	run := expiryRun{lastExpired: lastExpired}
	deleted, stuck := 0, 0
	var first error
	for _, a := range accounts {
		if run.over() || stuck >= expiryMaxStuck || ctx.Err() != nil {
			break
		}
		done, err := s.expire(ctx, &run, a)
		switch {
		case err != nil:
			first = cmp.Or(first, err)
			if ctx.Err() == nil {
				stuck++
			}
		case done:
			deleted++
		}
	}
	s.Log.Warn(msgExpiryDeleted, slog.String(logx.KeyRoute, expiryRoute), slog.Int(logx.KeyCount, deleted))
	switch {
	case stuck > 0:
		s.Log.Error(msgExpiryStuck, slog.String(logx.KeyRoute, expiryRoute), slog.Int(logx.KeyCount, stuck), logx.ErrorKind(first))
	case first != nil:
		s.Log.Error(msgExpiryFailed, slog.String(logx.KeyRoute, expiryRoute), logx.ErrorKind(first))
	}
	return first
}

// guard checks that logins still record their month of use: some login
// must have noted this month or last (directory.Store.RecordedUse). If none
// has, it logs msgExpiryPaused, as an error, and returns errExpiryPaused:
// the run deletes nothing.
func (s *Server) guard(ctx context.Context, now time.Time) error {
	recorded, err := s.Unused.RecordedUse(ctx)
	if err != nil {
		return s.expiryFailed(err)
	}
	if recorded < directory.MonthsBefore(now, 1) {
		s.Log.Error(msgExpiryPaused, slog.String(logx.KeyRoute, expiryRoute))
		return errExpiryPaused
	}
	return nil
}

// expiryFailed logs a run that failed before deleting anything, and
// returns err.
func (s *Server) expiryFailed(err error) error {
	s.Log.Error(msgExpiryFailed, slog.String(logx.KeyRoute, expiryRoute), logx.ErrorKind(err))
	return err
}

// expiryRun is where a run of the expiry is.
type expiryRun struct {
	// lastExpired is the newest last-use month that has expired.
	lastExpired string
	// steps counts the steps that went through.
	steps int
	// pause is what the next step waits first: none before the run's first.
	pause time.Duration
	// stop: the run's deadline is too near for another step.
	stop bool
}

// over reports whether the run takes no more steps.
func (r *expiryRun) over() bool {
	return r.stop || r.steps >= expirySteps
}

// expire takes steps of deleting an unused account while the run allows,
// and reports whether the account is gone. A big account takes the rest of
// the run's steps, and the next run carries on. A step that fails is tried
// again, up to expiryTries times; then expire returns the last error, and
// the account, still listed, waits for the next run.
func (s *Server) expire(ctx context.Context, run *expiryRun, a directory.UnusedAccount) (bool, error) {
	failed := 0
	for !run.over() {
		done, leave, err := s.expireOnce(ctx, run, a)
		if err != nil {
			run.pause = expiryRetryPause
			if failed++; failed >= expiryTries || ctx.Err() != nil {
				return false, err
			}
			continue
		}
		if done || leave {
			return done, nil
		}
	}
	return false, nil
}

// expireOnce reads an unused account and, unless it's to be left alone
// (leave: gone, replaced, used since it was listed, held by another step,
// or the run is out of time), takes one step of deleting it, after the
// run's pause, holding its lease (expireStep). It reports whether the
// account is gone.
func (s *Server) expireOnce(ctx context.Context, run *expiryRun, a directory.UnusedAccount) (done, leave bool, err error) {
	d, err := s.Unused.AccountState(ctx, a.ID)
	if errors.Is(err, directory.ErrNotFound) {
		return false, true, nil // gone already
	}
	if err != nil {
		return false, false, err
	}
	// Used since it was listed (the index lags), or no account to expire
	// (a replaced account's marker, or the stub of one replaced while it
	// was being deleted, which has no month): left alone. An account being
	// deleted keeps its month (Used writes none then).
	if d.Replaced || d.LastUse == "" || d.LastUse > run.lastExpired {
		return false, true, nil
	}
	if err := s.pause(ctx, run.pause); err != nil {
		return false, false, err
	}
	if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < expiryStepTime {
		run.stop = true
		return false, true, nil
	}
	release, ok, err := s.lease(ctx, expiryRoute, a.ID)
	if err != nil {
		return false, false, err
	}
	if !ok {
		return false, true, nil // another step holds it
	}
	done, leave, err = s.expireStep(ctx, a.ID, d)
	// The lease's time stays on the item only while the deletion goes on:
	// an account left alone (it's in use) keeps nothing of the expiry's,
	// and a failed step frees it at once for the next try.
	release(done || leave || err != nil)
	if err == nil {
		run.steps++
		run.pause = expiryPace
	}
	return done, leave, err
}

// expireStep takes one step of deleting an unused account, whose lease the
// caller holds: the first marks it as being deleted (directory.Store.Expire,
// only if it wasn't used since), as DELETE /account's first does; each
// then deletes what it can (deleteStep). It reports whether the account is
// gone, or is to be left alone (leave: not marked, since it was used, or
// is gone or replaced, or its link changed meanwhile, which the next run
// sees).
func (s *Server) expireStep(ctx context.Context, accountID string, d directory.Device) (done, leave bool, err error) {
	if !d.Deleting {
		err := s.Unused.Expire(ctx, accountID, d.LastUse)
		switch {
		case errors.Is(err, directory.ErrNotFound), errors.Is(err, directory.ErrConflict):
			return false, true, nil
		case err != nil:
			return false, false, err
		}
		d.Deleting = true
	}
	done, err = s.deleteStep(ctx, expiryRoute, accountID, d)
	return done, false, err
}

// pause waits d, or until ctx ends.
func (s *Server) pause(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
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
