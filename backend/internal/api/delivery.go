package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"log/slog"
	"math"
	"math/rand/v2"
	"net/http"
	"strconv"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/devicesig"
	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/envelope"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/inbox"
	"github.com/incognitochat/incognitochat/backend/internal/links"
	"github.com/incognitochat/incognitochat/backend/internal/logx"
)

const (
	// MaxMailboxes is how many pool and conversation mailboxes one account can own.
	MaxMailboxes = 4000
	// MailboxBatch is the most mailboxes one request creates.
	MailboxBatch = 10
	// MailboxesPerDay limits how many mailboxes an account creates per UTC
	// day: each new chat it starts or answers takes one.
	MailboxesPerDay = 100
	// SendsPerMailboxPerMinute caps messages to one mailbox.
	SendsPerMailboxPerMinute = 30
	// IntroSendsPerHour caps first messages through one link.
	IntroSendsPerHour = 60
	// InboxPage is the most items one GET /inbox returns.
	InboxPage = 50
	// InboxBytes is about what one GET /inbox reads, as stored
	// (inbox.Store.List).
	InboxBytes = 128 << 10
	// AckBatch is the most items one POST /ack confirms: a page.
	AckBatch = InboxPage
	// AckBatchUnits is the most write units (one deletes 1 KiB, or an item
	// that isn't there) one POST /ack may claim to cost: what a page claims
	// at most. A confirmation that claims more is refused.
	AckBatchUnits = 300
	// InboxUnitsPerMinute limits what one device's inbox fetches may read
	// in a minute, in the table's read units (one reads 8 KiB here): about
	// 2 MiB, as stored.
	InboxUnitsPerMinute = 300
	// InboxUnitsPerDay limits what one person's (Telegram user's) inbox
	// fetches may read in a UTC day, by the read units they took. A page of
	// 50 small envelopes takes about 5, so this is some 500,000 of them; the
	// largest envelopes take about 2.8 each, so about 18,000 of them, read
	// once each (the app confirms what it reads before reading on, and
	// stops reading once three pages wait to be confirmed). One sender's
	// day of tokens spent on the largest envelopes is 1,000 of them.
	InboxUnitsPerDay = 50_000
	// MinRequestUnits is the least one counted fetch counts against its
	// minute, whatever it read: each writes its counter, so a device
	// writes at most 30 a minute.
	MinRequestUnits = 10
	// AckMissesPerDay limits, per person (Telegram user) and UTC day, the
	// confirmations of items that weren't there, or by IDs too old: each of
	// the first still costs the table a write unit. An app makes them only
	// when a fetch lists again what it has just confirmed, reads being
	// eventually consistent, and it skips IDs it confirmed recently;
	// replaying old confirmations makes nothing else. As many as the day's
	// send tokens (TokensPerDay), each of which costs the table at least a
	// write unit too. Past them, confirmations delete nothing until the next
	// day, and what wasn't deleted is listed and confirmed again then.
	// Confirming items that are there isn't limited: they were delivered,
	// and senders paid for that with tokens.
	AckMissesPerDay = TokensPerDay
	// ItemIDHours is how long an item ID from GET /inbox is good for: the
	// hour it was listed in, and the next. Older ones are confirmed without
	// deleting anything, and count as misses, so replaying a confirmation
	// needs fresh IDs.
	ItemIDHours = 1
)

// Inbox stores undelivered envelopes.
type Inbox interface {
	Deliver(ctx context.Context, accountID string, devices []string, mailbox string, envelope []byte, now time.Time) error
	// List returns a page of a device's envelopes from after (the start if
	// empty), within limits; once its first read shows there is more, it
	// calls more before reading on (inbox.Store.List).
	List(ctx context.Context, accountID, deviceID, after string, limits inbox.PageLimits, now time.Time, more func() error) (inbox.Page, error)
	// Ack deletes a device's items. It reports how many weren't there, and
	// which it couldn't delete.
	Ack(ctx context.Context, accountID, deviceID string, itemIDs []string) (missing int, failed []string)
	// Clear deletes up to max of a device's items; it reports how many, and
	// whether more may be left.
	Clear(ctx context.Context, accountID, deviceID string, max int) (int, bool, error)
}

type sendRequest struct {
	Mailbox  string `json:"mailbox"`
	Envelope string `json:"envelope"` // base64url
	Token    string `json:"token"`    // base64url, an anonymous send token
	// Quiet sends trigger no Telegram notice (seen receipts).
	Quiet bool `json:"quiet"`
}

type inboxItem struct {
	ID       string  `json:"id"`
	Mailbox  string  `json:"mailbox"`
	Envelope bytes64 `json:"envelope"`
}

// createMailboxes adds mailboxes to the caller's pool. Clients keep a few
// spare and take one when they need it, so creating one never happens right
// before an anonymous send (design §9).
func (s *Server) createMailboxes(ctx context.Context, req httpapi.Request, c caller) httpapi.Response {
	const route = "POST /mailboxes"
	var in struct {
		Count int `json:"count"`
	}
	if err := httpapi.DecodeJSON(req, &in); err != nil {
		return httpapi.DecodeError(err)
	}
	if in.Count < 1 || in.Count > MailboxBatch {
		return httpapi.Error(http.StatusBadRequest, "bad_request")
	}
	ok, err := s.Limits.AllowN(ctx, "mbx#"+c.person(), in.Count, MailboxesPerDay, 24*time.Hour)
	if err != nil {
		return s.internal(route, err)
	}
	if !ok {
		return httpapi.Error(http.StatusTooManyRequests, "rate_limited")
	}
	created := make([]string, in.Count)
	for i := range created {
		created[i] = ids.New()
	}
	err = s.Directory.CreateMailboxes(ctx, c.AccountID, created, MaxMailboxes)
	switch {
	case errors.Is(err, directory.ErrLimit):
		return httpapi.Error(http.StatusConflict, "mailbox_limit")
	case errors.Is(err, directory.ErrConflict):
		return httpapi.Error(http.StatusConflict, "conflict")
	case err != nil:
		return s.internal(route, err)
	}
	return httpapi.JSON(http.StatusCreated, map[string][]string{"mailboxes": created})
}

// discardMailbox ends a mailbox (a block, or a conversation ended): sends to
// it then go nowhere, answered exactly like sends to a mailbox that never existed.
func (s *Server) discardMailbox(ctx context.Context, _ httpapi.Request, c caller) httpapi.Response {
	id := httpapi.Param(ctx, "id")
	if !ids.Valid(id) {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	err := s.Directory.DiscardMailbox(ctx, c.AccountID, id)
	if errors.Is(err, directory.ErrNotFound) {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	if err != nil {
		return s.internal("POST /mailboxes/{id}/discard", err)
	}
	return httpapi.JSON(http.StatusOK, map[string]string{})
}

// send delivers an envelope to a mailbox's owner, without logging in: the
// server learns the recipient (to deliver) but not the sender. Each send
// spends one anonymous token (tokens.go), which can't be linked to the
// account it was issued to. Unknown,
// discarded and blocked mailboxes get the same answer, in similar time, and
// nothing is stored for them.
func (s *Server) send(ctx context.Context, req httpapi.Request) httpapi.Response {
	const route = "POST /send"
	var in sendRequest
	if err := httpapi.DecodeJSON(req, &in); err != nil {
		return httpapi.DecodeError(err)
	}
	if !ids.Valid(in.Mailbox) {
		return httpapi.Error(http.StatusBadRequest, "bad_request")
	}
	env, err := base64.RawURLEncoding.Strict().DecodeString(in.Envelope)
	if err != nil {
		return httpapi.Error(http.StatusBadRequest, "invalid_envelope")
	}
	if _, err := envelope.Check(env); err != nil {
		return httpapi.Error(http.StatusBadRequest, "invalid_envelope")
	}
	now := s.Now()
	token, err := base64.RawURLEncoding.Strict().DecodeString(in.Token)
	if err != nil {
		return httpapi.Error(http.StatusUnauthorized, "invalid_token")
	}
	nonce, forgetAfter, err := s.Issuer.Check(token, now)
	if err != nil {
		return httpapi.Error(http.StatusUnauthorized, "invalid_token")
	}
	// A mailbox known to be at its cap is refused before the token is
	// spent: retrying, or replaying one token at it, costs the table nothing.
	if s.Limits.Full("send#"+in.Mailbox, SendsPerMailboxPerMinute, time.Minute) {
		return httpapi.Error(http.StatusTooManyRequests, "rate_limited")
	}
	// The token is spent before anything is counted, so a replayed token
	// can't use up a mailbox's limit.
	fresh, err := s.Spent.Spend(ctx, nonce, forgetAfter)
	if err != nil {
		return s.internal(route, err)
	}
	if !fresh {
		return httpapi.Error(http.StatusUnauthorized, "invalid_token")
	}
	ok, err := s.Limits.Allow(ctx, "send#"+in.Mailbox, SendsPerMailboxPerMinute, time.Minute)
	if err != nil {
		return s.internal(route, err)
	}
	if !ok {
		// The sender gets the token back, the first time, and can try
		// again later (ephemeral.Spent.Unspend).
		if err := s.Spent.Unspend(ctx, nonce); err != nil {
			return s.internal(route, err)
		}
		return httpapi.Error(http.StatusTooManyRequests, "rate_limited")
	}

	mailbox, err := s.Directory.Mailbox(ctx, in.Mailbox)
	if errors.Is(err, directory.ErrNotFound) {
		if s.Pause != nil {
			s.Pause()
		}
		// The same requests a delivery makes, so the answer takes as long.
		s.push(ctx, "")
		if !in.Quiet {
			s.notify(ctx, "")
		}
		return accepted()
	}
	if err != nil {
		return s.internal(route, err)
	}
	if mailbox.Link != "" {
		ok, err := s.Limits.Allow(ctx, "intro#"+mailbox.Link, IntroSendsPerHour, time.Hour)
		if err != nil {
			return s.internal(route, err)
		}
		if !ok {
			return httpapi.Error(http.StatusTooManyRequests, "rate_limited")
		}
	}
	devices, err := s.Directory.Devices(ctx, mailbox.Owner, now)
	if err != nil {
		return s.internal(route, err)
	}
	if err := s.Inbox.Deliver(ctx, mailbox.Owner, devices, in.Mailbox, env, now); err != nil {
		return s.internal(route, err)
	}
	// Open apps fetch at once; a notice only if none is open. Receipts are
	// pushed too (they update check marks), but never noticed.
	pushed := s.push(ctx, mailbox.Owner)
	if !in.Quiet {
		if pushed {
			s.notify(ctx, "")
		} else {
			s.notify(ctx, mailbox.Owner)
		}
	}
	return accepted()
}

func accepted() httpapi.Response {
	return httpapi.JSON(http.StatusOK, map[string]string{})
}

// RandomPause stands in for the delivery work skipped for unknown mailboxes,
// so their answer takes about as long.
func RandomPause() {
	time.Sleep(time.Duration(15+rand.IntN(25)) * time.Millisecond)
}

// MailboxChecksPerDay limits POST /mailboxes/check per account.
const MailboxChecksPerDay = 20

// checkMailboxes tells the app which of the mailboxes it holds are no longer
// its own, so it stops handing them out as reply addresses. That happens
// when its data outlived the account it was made for (an account replaced
// on the same device, before apps wiped on a new setup). The server already
// knows every account's mailboxes; nothing is stored.
func (s *Server) checkMailboxes(ctx context.Context, req httpapi.Request, c caller) httpapi.Response {
	const route = "POST /mailboxes/check"
	var in struct {
		IDs []string `json:"ids"`
	}
	if err := httpapi.DecodeJSON(req, &in); err != nil {
		return httpapi.DecodeError(err)
	}
	if len(in.IDs) == 0 || len(in.IDs) > MaxMailboxes+links.MaxActive {
		return httpapi.Error(http.StatusBadRequest, "bad_request")
	}
	for _, id := range in.IDs {
		if !ids.Valid(id) {
			return httpapi.Error(http.StatusBadRequest, "bad_request")
		}
	}
	ok, err := s.Limits.Allow(ctx, "mbxcheck#"+c.person(), MailboxChecksPerDay, 24*time.Hour)
	if err != nil {
		return s.internal(route, err)
	}
	if !ok {
		return httpapi.Error(http.StatusTooManyRequests, "rate_limited")
	}
	owned, err := s.Directory.Mailboxes(ctx, c.AccountID)
	if err != nil {
		return s.internal(route, err)
	}
	mine := make(map[string]bool, len(owned))
	for _, id := range owned {
		mine[id] = true
	}
	missing := []string{}
	for _, id := range in.IDs {
		if !mine[id] {
			missing = append(missing, id)
		}
	}
	return httpapi.JSON(http.StatusOK, map[string][]string{"missing": missing})
}

// inboxPage bounds a page of GET /inbox: what it returns, what it may
// claim to cost to confirm (AckBatchUnits), and about what it reads.
var inboxPage = inbox.PageLimits{Items: InboxPage, Units: AckBatchUnits, Bytes: InboxBytes}

// refundAtLeast is the least of a reservation worth a write to give back.
const refundAtLeast = 20

// errLimited ends a page whose cost the device's minute can't take.
var errLimited = errors.New("api: rate limited")

// listInbox returns a page of the calling device's undelivered envelopes,
// from ?after=<next of the page before>. A device's fetches are limited by
// what they read, per minute (InboxUnitsPerMinute) and per person and day
// (InboxUnitsPerDay):
//   - A fetch that reads nothing (an empty inbox) isn't counted, so polling
//     writes nothing.
//   - One whose first read (of two items) is the whole page counts what it
//     read, at least MinRequestUnits, if the minute has room: one write.
//   - One that reads on first reserves what a page can cost at most, with a
//     conditional write, before reading on, and gives back what it didn't
//     use if that's much: however many instances serve a device at once,
//     its pages can't read more than its minute allows.
//   - Before its first read, a fetch on an instance that knows nothing of
//     the device's minute yet reads its count (half a read unit on the
//     ephemeral table), so one that has no room for a page reads nothing.
//     Fetches that start at once while it has room each read their first
//     two items before any is refused.
//   - The day is counted by the units read, in batches (Limiter.Tally), and
//     refused with daily_limit, and when it ends (Retry-After).
//
// If the ephemeral table can't be reached, each instance allows a device
// one page's worth a minute on its own count: failing closed would turn
// trouble with the ephemeral table into an inbox outage for everyone, and
// failing open would drop the limits.
func (s *Server) listInbox(ctx context.Context, req httpapi.Request, c caller) httpapi.Response {
	const route = "GET /inbox"
	after := req.QueryStringParameters["after"]
	if after != "" && !ids.Valid(after) {
		return httpapi.Error(http.StatusBadRequest, "bad_request")
	}
	// One time for every counter: a fetch counts in the minute it started.
	now := s.Now()
	minute := s.rateName("inbox", now, time.Minute, c.AccountID, c.DeviceID)
	day := s.rateName("inboxday", now, 24*time.Hour, c.person())
	if s.Limits.FullAt(day, InboxUnitsPerDay, 24*time.Hour, now) {
		return dailyLimited(now)
	}
	worst := inboxPage.WorstUnits()
	room, err := s.Limits.CheckAt(ctx, minute, InboxUnitsPerMinute-worst+1, time.Minute, now)
	local := err != nil
	s.rateFailed(route, err)
	if !room {
		return httpapi.Error(http.StatusTooManyRequests, "rate_limited")
	}
	// take counts n against the device's minute, or, once the table can't
	// be reached, takes this instance's one page for it.
	reserved := false
	take := func(n int) bool {
		if !local {
			ok, err := s.Limits.AllowNAt(ctx, minute, n, InboxUnitsPerMinute, time.Minute, now)
			if err == nil {
				return ok
			}
			s.rateFailed(route, err)
			local = true
		}
		reserved = s.Limits.LocalAt(minute, worst, worst, time.Minute, now)
		return reserved
	}
	// Without the table, the page is taken before anything is read.
	if local && !take(worst) {
		return httpapi.Error(http.StatusTooManyRequests, "rate_limited")
	}
	page, err := s.Inbox.List(ctx, c.AccountID, c.DeviceID, after, inboxPage, now, func() error {
		if reserved {
			return nil
		}
		if !take(worst) {
			return errLimited
		}
		reserved = true
		return nil
	})
	if errors.Is(err, errLimited) {
		return httpapi.Error(http.StatusTooManyRequests, "rate_limited")
	}
	if err != nil {
		return s.internal(route, err)
	}
	if page.Read > 0 {
		read := int(math.Ceil(page.Units))
		used := max(read, MinRequestUnits)
		switch {
		case reserved && !local && worst-used >= refundAtLeast:
			s.rateFailed(route, s.Limits.RefundAt(ctx, minute, worst-used, time.Minute, now))
		case !reserved && !take(used):
			return httpapi.Error(http.StatusTooManyRequests, "rate_limited")
		}
		_, err := s.Limits.Tally(ctx, day, max(read, 1), InboxUnitsPerDay, 24*time.Hour, now)
		s.rateFailed(route, err)
	}
	out := make([]inboxItem, 0, len(page.Items))
	for _, it := range page.Items {
		if id, ok := s.itemID(c, it, now); ok {
			out = append(out, inboxItem{ID: id, Mailbox: it.Mailbox, Envelope: it.Envelope})
		}
	}
	resp := map[string]any{"items": out, "more": page.After != ""}
	if page.After != "" {
		// The page can be empty and still have more after it (expired
		// envelopes, not yet removed): the next starts here.
		resp["next"] = page.After
	}
	return httpapi.JSON(http.StatusOK, resp)
}

// dailyLimited answers a request past a daily limit: daily_limit, distinct
// from rate_limited, with when the day ends (UTC), so the app waits until
// then rather than trying again within the minute.
func dailyLimited(now time.Time) httpapi.Response {
	resp := httpapi.Error(http.StatusTooManyRequests, "daily_limit")
	end := now.Truncate(24 * time.Hour).Add(24 * time.Hour)
	resp.Headers["retry-after"] = strconv.FormatInt(int64(math.Ceil(end.Sub(now).Seconds())), 10)
	return resp
}

// rateFailed logs a rate counter the ephemeral table couldn't take.
func (s *Server) rateFailed(route string, err error) {
	if err != nil {
		s.Log.Warn("rate count failed", slog.String(logx.KeyRoute, route), logx.ErrorKind(err))
	}
}

// ack deletes envelopes the calling device has stored, by the IDs
// listInbox gave them. Deleting costs the table at least a write unit per
// item, whether or not it's there, so:
//   - IDs the server didn't hand out to this device, or a batch that claims
//     more than a page can (AckBatchUnits), are refused before anything is
//     deleted;
//   - IDs listed before the last hour (ItemIDHours) delete nothing, and
//     count as items that weren't there;
//   - items that weren't there count against the person's day
//     (AckMissesPerDay), past which nothing is deleted.
//
// Deleting items that are there isn't otherwise limited: they were
// delivered, and their senders paid for that with tokens. So an honest
// confirmation writes nothing to the ephemeral table.
//
// The answer lists, as retry, IDs whose delete failed (throttled, say):
// the app sends only those again, so items this request did delete aren't
// confirmed a second time, as missing.
func (s *Server) ack(ctx context.Context, req httpapi.Request, c caller) httpapi.Response {
	const route = "POST /ack"
	var in struct {
		IDs []string `json:"ids"`
	}
	if err := httpapi.DecodeJSON(req, &in); err != nil {
		return httpapi.DecodeError(err)
	}
	if len(in.IDs) == 0 || len(in.IDs) > AckBatch {
		return httpapi.Error(http.StatusBadRequest, "bad_request")
	}
	now := s.Now()
	type listed struct {
		id    string
		units int
		hour  int64
	}
	byKey := make(map[string]listed, len(in.IDs))
	order := make([]string, 0, len(in.IDs))
	for _, id := range in.IDs {
		key, u, hour, ok := s.parseItemID(c, id)
		if !ok {
			return httpapi.Error(http.StatusBadRequest, "bad_request")
		}
		// Once each: a batch can't delete one item twice. Listed twice, the
		// item goes by its latest ID.
		if old, dup := byKey[key]; !dup {
			order = append(order, key)
		} else if old.hour >= hour {
			continue
		}
		byKey[key] = listed{id, u, hour}
	}
	claimed, stale := 0, 0
	var keys []string
	for _, key := range order {
		it := byKey[key]
		claimed += it.units
		// An old ID's item is gone, or will be listed again under a new one.
		if hourOf(now)-it.hour > ItemIDHours {
			stale++
		} else {
			keys = append(keys, key)
		}
	}
	if claimed > AckBatchUnits {
		return httpapi.Error(http.StatusBadRequest, "bad_request")
	}
	// Past the day's misses (as the table last told, at most a minute
	// ago), taken without deleting or counting anything.
	day := s.rateName("ackmiss", now, 24*time.Hour, c.person())
	ok, err := s.Limits.CheckAt(ctx, day, AckMissesPerDay, 24*time.Hour, now)
	s.rateFailed(route, err)
	if !ok {
		return httpapi.JSON(http.StatusOK, map[string]string{})
	}
	missing, failed := 0, []string(nil)
	if len(keys) > 0 {
		missing, failed = s.Inbox.Ack(ctx, c.AccountID, c.DeviceID, keys)
		if len(failed) == len(keys) {
			return s.internal(route, errors.New("inbox: no delete succeeded"))
		}
	}
	if misses := missing + stale; misses > 0 {
		_, err := s.Limits.Tally(ctx, day, misses, AckMissesPerDay, 24*time.Hour, now)
		s.rateFailed(route, err)
	}
	if len(failed) > 0 {
		retry := make([]string, len(failed))
		for i, key := range failed {
			retry[i] = byKey[key].id
		}
		return httpapi.JSON(http.StatusOK, map[string][]string{"retry": retry})
	}
	return httpapi.JSON(http.StatusOK, map[string]string{})
}

const (
	labelInboxItem = "incognitochat/v2/inbox-item"
	labelRateName  = "incognitochat/v2/rate-name"
	itemIDLen      = 16 + 1 + 4 + 16 // key, write units, hour listed, MAC
)

// hourOf is the hour t is in, counted from the Unix epoch.
func hourOf(t time.Time) int64 { return t.Unix() / 3600 }

// itemID is what GET /inbox calls an item for POST /ack: its key, the
// write units deleting it costs, the hour it was listed in, and a MAC over
// those and the device, under a key derived from the pepper, which only
// this function holds. An item listed again within the hour has the same
// ID, so an app can tell what it has just confirmed.
func (s *Server) itemID(c caller, it inbox.Item, now time.Time) (string, bool) {
	key, err := ids.Decode(it.ID)
	if err != nil {
		return "", false
	}
	out := make([]byte, 0, itemIDLen)
	out = append(out, key[:]...)
	out = append(out, byte(min(it.Units(), 255)))
	out = binary.BigEndian.AppendUint32(out, uint32(hourOf(now)))
	out = append(out, s.itemMAC(c, out)...)
	return base64.RawURLEncoding.EncodeToString(out), true
}

// parseItemID checks an item ID from itemID and returns the item's key,
// what deleting it costs, and the hour it was listed in.
func (s *Server) parseItemID(c caller, id string) (key string, units int, listed int64, ok bool) {
	raw, err := base64.RawURLEncoding.Strict().DecodeString(id)
	if err != nil || len(raw) != itemIDLen || raw[16] == 0 {
		return "", 0, 0, false
	}
	if !hmac.Equal(raw[21:], s.itemMAC(c, raw[:21])) {
		return "", 0, 0, false
	}
	return ids.Encode([16]byte(raw[:16])), int(raw[16]), int64(binary.BigEndian.Uint32(raw[17:21])), true
}

func (s *Server) itemMAC(c caller, fields []byte) []byte {
	mac := hmac.New(sha256.New, s.Pepper)
	mac.Write(devicesig.Message(labelInboxItem, []byte(c.AccountID), []byte(c.DeviceID), fields))
	return mac.Sum(nil)[:16]
}

// rateName is the key of a rate counter of kind, for who (a device, or a
// person), in the window that holds now: kind and a keyed hash of who and
// the window. It changes with every window, so the ephemeral table holds
// nothing that ties a counter to an account, or one window's counter to
// the next, and so nothing that tells when an account fetched or
// confirmed its messages.
func (s *Server) rateName(kind string, now time.Time, window time.Duration, who ...string) string {
	parts := [][]byte{[]byte(kind), strconv.AppendInt(nil, now.Truncate(window).Unix(), 10)}
	for _, w := range who {
		parts = append(parts, []byte(w))
	}
	mac := hmac.New(sha256.New, s.Pepper)
	mac.Write(devicesig.Message(labelRateName, parts...))
	return kind + "#" + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)[:16])
}
