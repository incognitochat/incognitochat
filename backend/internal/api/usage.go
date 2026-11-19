package api

import (
	"context"
	"net/http"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
)

// usageItem is how much of one limit is used.
type usageItem struct {
	Used  int `json:"used"`
	Limit int `json:"limit"`
}

// usage tells the caller how much of today's limits they have used, for the
// app's Usage screen (GET /usage): send and media tokens, new mailboxes and
// link changes, counted per Telegram user and reset at 00:00 UTC, and the
// mailboxes the account owns against the most it may. It reads the counters
// the limits keep anyway; nothing is stored.
func (s *Server) usage(ctx context.Context, _ httpapi.Request, c caller) httpapi.Response {
	const route = "GET /usage"
	const day = 24 * time.Hour
	now := s.Now()
	daily := func(kind string, limit int) (usageItem, error) {
		used, err := s.Limits.UsedAt(ctx, s.rateName(kind, now, day, c.person()), day, now)
		return usageItem{Used: min(used, limit), Limit: limit}, err
	}
	var out struct {
		ResetsAt    int64     `json:"resetsAt"`
		Send        usageItem `json:"send"`
		Media       usageItem `json:"media"`
		Mailboxes   usageItem `json:"mailboxes"`
		LinkChanges usageItem `json:"linkChanges"`
		Owned       usageItem `json:"owned"`
	}
	out.ResetsAt = now.Truncate(day).Add(day).Unix()
	var err error
	for _, d := range []struct {
		into  *usageItem
		key   string
		limit int
	}{
		{&out.Send, "tok", TokensPerDay},
		{&out.Media, "mtok", MediaTokensPerDay},
		{&out.Mailboxes, "mbx", MailboxesPerDay},
		{&out.LinkChanges, "link", LinkChangesPerDay},
	} {
		if *d.into, err = daily(d.key, d.limit); err != nil {
			return s.internal(route, err)
		}
	}
	owned, err := s.Directory.MailboxCount(ctx, c.AccountID, now)
	if err != nil {
		return s.internal(route, err)
	}
	out.Owned = usageItem{Used: owned, Limit: MaxMailboxes}
	return httpapi.JSON(http.StatusOK, out)
}
