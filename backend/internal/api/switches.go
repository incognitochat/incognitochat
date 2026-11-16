package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/logx"
)

// The operator's emergency switches pause uploads or downloads of
// attachments for everyone, without a release: S3 bills every request to
// the media bucket, and these go past the API. They are one directory item
// (directory.Switches), flipped with the AWS CLI or from the app's admin
// screen (docs/deployment.md, "Emergency switches"). Only the media routes
// look at them; messages, reactions and everything else keep working.

// SwitchesTTL is how long an api instance trusts the switches it last
// read. A flip reaches every instance within about this long, and an
// instance reads the item at most this often, only when a media route is
// called.
const SwitchesTTL = 30 * time.Second

// switchesRetry is how soon an instance reads the switches again after a
// failed read. Meanwhile it keeps what it knew, so a directory that can't be
// read resumes nothing, and isn't asked on every request.
const switchesRetry = 5 * time.Second

// allPaused is what an instance that has never read the switches goes by:
// it fails closed, so making the directory's reads fail (while forcing new
// instances) can't get past a pause. The app takes a refusal of a few
// seconds in its stride.
var allPaused = directory.Switches{UploadsPaused: true, DownloadsPaused: true}

// SwitchStore holds the emergency switches (directory.Store).
type SwitchStore interface {
	Switches(ctx context.Context, consistent bool) (directory.Switches, error)
	SetSwitch(ctx context.Context, sw directory.Switch, paused bool) (directory.Switches, error)
}

// switchCache is one instance's copy of the switches. Until its first read
// succeeds, everything counts as paused (allPaused).
type switchCache struct {
	mu      sync.Mutex
	known   directory.Switches
	read    bool      // known was read (or set) at least once
	next    time.Time // when to read again; zero until read
	reading bool      // a read is under way: others use what's known
}

// current is what's known, or allPaused before the first read: c.mu held.
func (c *switchCache) current() directory.Switches {
	if !c.read {
		return allPaused
	}
	return c.known
}

// switches returns the switches as this instance knows them, reading them
// again once they are SwitchesTTL old. If the read fails, it returns the
// last known ones (everything paused, if it never read them) and tries
// again after switchesRetry.
func (s *Server) switches(ctx context.Context, route string) directory.Switches {
	if s.Switches == nil {
		return directory.Switches{}
	}
	c := &s.switchCache
	now := s.Now()
	c.mu.Lock()
	if c.reading || now.Before(c.next) {
		current := c.current()
		c.mu.Unlock()
		return current
	}
	c.reading = true
	c.mu.Unlock()

	sw, err := s.Switches.Switches(ctx, false)

	c.mu.Lock()
	defer c.mu.Unlock()
	c.reading = false
	if err != nil {
		c.next = now.Add(switchesRetry)
		s.Log.Warn("reading the switches failed", slog.String(logx.KeyRoute, route), logx.ErrorKind(err))
		return c.current()
	}
	s.rememberSwitchesLocked(sw, now)
	return sw
}

// rememberSwitches keeps switches just read or set, as if read now.
func (s *Server) rememberSwitches(sw directory.Switches) {
	s.switchCache.mu.Lock()
	defer s.switchCache.mu.Unlock()
	s.rememberSwitchesLocked(sw, s.Now())
}

func (s *Server) rememberSwitchesLocked(sw directory.Switches, now time.Time) {
	c := &s.switchCache
	// Said once per instance and change, so the logs show when each
	// instance followed a flip.
	if sw.UploadsPaused != c.known.UploadsPaused {
		if sw.UploadsPaused {
			s.Log.Warn("uploads paused")
		} else {
			s.Log.Warn("uploads resumed")
		}
	}
	if sw.DownloadsPaused != c.known.DownloadsPaused {
		if sw.DownloadsPaused {
			s.Log.Warn("downloads paused")
		} else {
			s.Log.Warn("downloads resumed")
		}
	}
	// An operator's typing mistake (say {"S": "true"}) pauses nothing:
	// said once, until it's put right.
	if sw.Malformed && !c.known.Malformed {
		s.Log.Warn("a switch isn't a BOOL: taken as not paused")
	}
	c.known, c.read, c.next = sw, true, now.Add(SwitchesTTL)
}

func switchesJSON(sw directory.Switches) switchesResponse {
	return switchesResponse{UploadsPaused: sw.UploadsPaused, DownloadsPaused: sw.DownloadsPaused}
}

// switchesResponse is how the admin routes show the switches.
type switchesResponse struct {
	UploadsPaused   bool `json:"uploadsPaused"`
	DownloadsPaused bool `json:"downloadsPaused"`
}

type setSwitchRequest struct {
	Switch directory.Switch `json:"switch"` // "uploads" or "downloads"
	Paused *bool            `json:"paused"`
}

// adminSwitches shows the switches as stored now, not as this instance
// last read them.
func (s *Server) adminSwitches(ctx context.Context, _ httpapi.Request, _ caller) httpapi.Response {
	const route = "GET /admin/switches"
	if s.Switches == nil {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	sw, err := s.Switches.Switches(ctx, true)
	if err != nil {
		return s.internal(route, err)
	}
	s.rememberSwitches(sw)
	return httpapi.JSON(http.StatusOK, switchesJSON(sw))
}

// adminSetSwitch pauses or resumes uploads or downloads for everyone. This
// instance follows at once, the others within SwitchesTTL.
func (s *Server) adminSetSwitch(ctx context.Context, req httpapi.Request, _ caller) httpapi.Response {
	const route = "PUT /admin/switches"
	var in setSwitchRequest
	if err := httpapi.DecodeJSON(req, &in); err != nil {
		return httpapi.DecodeError(err)
	}
	if s.Switches == nil {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	if in.Paused == nil || (in.Switch != directory.SwitchUploads && in.Switch != directory.SwitchDownloads) {
		return httpapi.Error(http.StatusBadRequest, "bad_request")
	}
	sw, err := s.Switches.SetSwitch(ctx, in.Switch, *in.Paused)
	if errors.Is(err, directory.ErrUnknownSwitch) {
		return httpapi.Error(http.StatusBadRequest, "bad_request")
	}
	if err != nil {
		return s.internal(route, err)
	}
	s.rememberSwitches(sw)
	return httpapi.JSON(http.StatusOK, switchesJSON(sw))
}
