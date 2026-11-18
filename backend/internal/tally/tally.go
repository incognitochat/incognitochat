// Package tally counts the api function's answers, and logs the counts once
// a minute, so the operator can see limits being hit, refusals and how many
// accounts and tokens are being given out, without any access log.
//
// An instance counts the answers it gives in each minute (UTC): all of
// them, by route and status, and by error code. Lambda freezes an instance
// between requests, so a minute's counts are logged with the first request
// after it ends, or when the instance shuts down (Flush). That's one line
// per instance for each minute it answered anything, and none while idle.
// The line's time is the start of the minute it counts.
//
// Counts are all it holds: route patterns (never paths, which carry IDs),
// statuses and the handlers' error codes, never anything that identifies a
// person, device, account, link, mailbox, address or request.
package tally

import (
	"context"
	"log/slog"
	"maps"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/logx"
)

// Message is the counts line's message.
const Message = "request counts"

// maxNames bounds each count group. The routes and codes are the server's
// own, so they never reach it; past it, answers count under "other" (one
// more).
const maxNames = 200

// Counter counts one instance's answers. It is safe for concurrent use.
type Counter struct {
	log *slog.Logger

	mu     sync.Mutex
	minute time.Time // the minute being counted
	total  int
	routes map[string]int // by route and status, e.g. "post_send_429"
	errors map[string]int // by error code, e.g. "rate_limited"
}

// New returns a counter that logs to log.
func New(log *slog.Logger) *Counter {
	return &Counter{log: log, routes: map[string]int{}, errors: map[string]int{}}
}

// Add counts an answer given at now: its route pattern ("POST /send"),
// status, and error code ("" if none). If the minute being counted has
// ended, its counts are logged first.
func (c *Counter) Add(now time.Time, route string, status int, code string) {
	minute := now.UTC().Truncate(time.Minute)
	c.mu.Lock()
	defer c.mu.Unlock()
	if !minute.Equal(c.minute) {
		c.flush()
		c.minute = minute
	}
	c.total++
	bump(c.routes, RouteName(route, status))
	if code != "" {
		bump(c.errors, code)
	}
}

// Flush logs the counts not logged yet, if any: for when the instance shuts
// down.
func (c *Counter) Flush() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.flush()
}

func (c *Counter) flush() {
	if c.total == 0 {
		return
	}
	r := slog.NewRecord(c.minute, slog.LevelWarn, Message, 0)
	r.AddAttrs(
		slog.Int(logx.KeyCount, c.total),
		group(logx.KeyErrors, c.errors),
		group(logx.KeyRoutes, c.routes),
	)
	_ = c.log.Handler().Handle(context.Background(), r)
	c.total = 0
	clear(c.routes)
	clear(c.errors)
}

func bump(counts map[string]int, name string) {
	if _, ok := counts[name]; !ok && len(counts) >= maxNames {
		name = "other"
	}
	counts[name]++
}

func group(key string, counts map[string]int) slog.Attr {
	attrs := make([]any, 0, len(counts))
	for _, name := range slices.Sorted(maps.Keys(counts)) {
		attrs = append(attrs, slog.Int(name, counts[name]))
	}
	return slog.Group(key, attrs...)
}

// RouteName names a route pattern and status as the routes group does, in
// lower case letters, digits and "_": "POST /links/{id}/keys" and 204 give
// "post_links_id_keys_204".
func RouteName(route string, status int) string {
	var b strings.Builder
	gap := false
	for _, r := range strings.ToLower(route) {
		if r < 'a' || r > 'z' {
			if r < '0' || r > '9' {
				gap = true
				continue
			}
		}
		if gap && b.Len() > 0 {
			b.WriteByte('_')
		}
		gap = false
		b.WriteRune(r)
	}
	if b.Len() == 0 {
		b.WriteString("route")
	}
	b.WriteByte('_')
	b.WriteString(strconv.Itoa(status))
	return b.String()
}
