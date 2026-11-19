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
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/devicesig"
	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/envelope"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/inbox"
	"github.com/incognitochat/incognitochat/backend/internal/keyed"
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
	// day of tokens buys 125 of the largest envelopes (8 tokens each), or
	// 1,000 of 2.5 KiB: some 300 read units either way.
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
	// AckMissesPerRequest is how many items that weren't there stop a
	// confirmation from starting more deletes: the rest are taken without
	// deleting (they're listed again later). Honest confirmations almost
	// never miss; with 10 deletes at a time, a request misses at most 14,
	// so instances that each let one more request through past the day's
	// misses add little.
	AckMissesPerRequest = 5
	// AckLocalMissesPerMinute limits, per person and instance, the misses
	// confirmations may make in a minute while the ephemeral table can't be
	// reached to count them.
	AckLocalMissesPerMinute = 50
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
	// Ack deletes a device's items, starting no more once maxMissing weren't
	// there. It reports how many weren't there, and which it couldn't
	// delete.
	Ack(ctx context.Context, accountID, deviceID string, itemIDs []string, maxMissing int) (missing int, failed []string)
	// Clear deletes up to max of a device's items; it reports how many, and
	// whether more may be left.
	Clear(ctx context.Context, accountID, deviceID string, max int) (int, bool, error)
}

type sendRequest struct {
	Mailbox  string `json:"mailbox"`
	Envelope string `json:"envelope"` // base64url
	// Tokens are anonymous send tokens (base64url), as many as the
	// envelope costs (envelope.TokensFor).
	Tokens []string `json:"tokens"`
	// Token is the one token of an app from before envelopes were priced
	// by size: the same as Tokens with one.
	Token string `json:"token"`
	// Quiet sends trigger no Telegram notice (seen receipts).
	Quiet bool `json:"quiet"`
}

type inboxItem struct {
	ID       string  `json:"id"`
	Mailbox  string  `json:"mailbox"`
	Envelope bytes64 `json:"envelope"`
}

// createMailboxes adds mailboxes to the caller's pool. Clients keep a few
// spare, take one when they need it and top the pool up at random moments,
// so creating one happens right before an anonymous send only rarely: when
// more chats start in one burst than the pool holds (design §9).
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
	ok, err := s.allowN(ctx, "mbx", in.Count, MailboxesPerDay, 24*time.Hour, c.person())
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
// spends anonymous tokens (tokens.go), which can't be linked to the
// account they were issued to: one per started 2.5 KiB of envelope
// (envelope.TokensFor), so the daily budget bounds what a person's sends
// cost the messages table, not just how many there are.
//
// Neither whether the mailbox exists nor whether its owner's app is open
// changes which calls a send makes, the bytes they carry or the capacity
// they use, and so neither changes the answer or how it fails:
//   - A mailbox that doesn't exist (never did, or ended: a block, an ended
//     conversation) takes the same steps for an account that doesn't
//     exist either: its devices are looked up (there are none), and the
//     delivery's write, the same size, goes to a placeholder that holds
//     nothing (inbox.Store.Deliver). ws is asked to push to nobody.
//   - Pushing to open apps, and the notice if none took it, happen in the
//     ws function, which this asks the same way for every send, without
//     waiting (Pusher).
//
// What differs is only what the database finds (the mailbox and a device,
// or the placeholders), and the very first send to a mailbox that doesn't
// exist, which writes the placeholder device. A link's intro mailbox also
// counts the link's first messages; a sender knows whether it writes to
// one, and a link that is gone says so itself (GET /links/{id}).
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
	// Every token is checked, and their number, before any is spent.
	tokens, refused := s.sendTokens(in, len(env), now)
	if refused != nil {
		return *refused
	}
	// A mailbox known to be at its cap is refused before the tokens are
	// spent: retrying, or replaying tokens at it, costs the table nothing.
	// The counter is named by a keyed hash of the mailbox and the minute,
	// so the ephemeral table holds no log of which mailboxes got messages
	// when.
	capName := s.rateName("send", now, time.Minute, in.Mailbox)
	if s.Limits.FullAt(capName, SendsPerMailboxPerMinute, time.Minute, now) {
		return httpapi.Error(http.StatusTooManyRequests, "rate_limited")
	}
	// The tokens are spent before anything is counted, so replayed tokens
	// can't use up a mailbox's limit. One spent already ends the send, and
	// those before it stay spent.
	fresh, err := s.Spent.SpendAll(ctx, tokens)
	if err != nil {
		return s.internal(route, err)
	}
	if !fresh {
		return httpapi.Error(http.StatusUnauthorized, "invalid_token")
	}
	ok, err := s.Limits.AllowNAt(ctx, capName, 1, SendsPerMailboxPerMinute, time.Minute, now)
	if err != nil {
		return s.internal(route, err)
	}
	if !ok {
		// The sender gets the tokens back, each the first time, and can
		// try again later (ephemeral.Spent.Unspend).
		if err := s.unspendAll(ctx, tokens); err != nil {
			return s.internal(route, err)
		}
		return httpapi.Error(http.StatusTooManyRequests, "rate_limited")
	}

	mailbox, err := s.Directory.Mailbox(ctx, in.Mailbox)
	exists := err == nil
	if errors.Is(err, directory.ErrNotFound) {
		err = nil
	}
	if err != nil {
		return s.internal(route, err)
	}
	if mailbox.Link != "" {
		ok, err := s.allow(ctx, "intro", IntroSendsPerHour, time.Hour, mailbox.Link)
		if err != nil {
			return s.internal(route, err)
		}
		if !ok {
			return httpapi.Error(http.StatusTooManyRequests, "rate_limited")
		}
	}
	// A mailbox that doesn't exist takes the same steps for an account
	// that doesn't exist either: the same query for its devices, which
	// finds none (directory.Store.NoRecipients), so the same write, to a
	// placeholder (inbox.Store.Deliver), and a push to nobody. So does a
	// mailbox whose account was replaced or is being deleted: its devices
	// are looked up the same way, and none take deliveries
	// (directory.Store.Recipients), so the send goes nowhere, as to an
	// ended mailbox, before the mailbox itself is deleted.
	var devices []string
	if exists {
		devices, err = s.Directory.Recipients(ctx, mailbox.Owner, now)
	} else {
		err = s.Directory.NoRecipients(ctx, now)
	}
	if err != nil {
		return s.internal(route, err)
	}
	owner := mailbox.Owner
	if len(devices) == 0 {
		owner = ""
	}
	if err := s.Inbox.Deliver(ctx, owner, devices, in.Mailbox, env, now); err != nil {
		return s.internal(route, err)
	}
	// Open apps fetch at once, and a notice goes out if none is open, both
	// from the ws function, which this doesn't wait for. Receipts are
	// pushed too (they update check marks), but never noticed.
	s.push(ctx, owner, in.Quiet)
	return accepted()
}

func accepted() httpapi.Response {
	return httpapi.JSON(http.StatusOK, map[string]string{})
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
	ok, err := s.allow(ctx, "mbxcheck", MailboxChecksPerDay, 24*time.Hour, c.person())
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
//     A device that needed a page on this instance lately (paged) takes the
//     next page before reading anything. Otherwise fetches that start at
//     once, each on an instance new to the minute, each read their first
//     two items before most are refused.
//   - The day is counted by the units read, and a refused fetch that read
//     or wrote anything by at least MinRequestUnits, in batches
//     (Limiter.Tally), so the day bounds even what refused fetches cost;
//     each instance asks for its count at least once a minute (CheckAt).
//     Past it, daily_limit, with when it ends (Retry-After).
//
// If the ephemeral table can't be reached, each instance allows a device
// one page's worth a minute on its own count, uncounted for the day:
// failing closed would turn trouble with the ephemeral table into an inbox
// outage for everyone, and failing open would drop the limits.
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
	// The day as the table told this instance at most a minute ago: other
	// instances count it too.
	dayOK, err := s.Limits.CheckAt(ctx, day, InboxUnitsPerDay, 24*time.Hour, now)
	s.rateFailed(route, err)
	if !dayOK {
		return dailyLimited(now)
	}
	worst := inboxPage.WorstUnits()
	room, err := s.Limits.CheckAt(ctx, minute, InboxUnitsPerMinute-worst+1, time.Minute, now)
	local := err != nil
	s.rateFailed(route, err)
	if !room {
		return httpapi.Error(http.StatusTooManyRequests, "rate_limited")
	}
	// refused answers a fetch the minute had no room for, once it cost the
	// tables something (what it read, or a refused write): that counts
	// against the person's day, at least MinRequestUnits, so the day bounds
	// even fetches that are refused.
	refused := func(read float64) httpapi.Response {
		if !local {
			_, err := s.Limits.Tally(ctx, day, max(int(math.Ceil(read)), MinRequestUnits), InboxUnitsPerDay, 24*time.Hour, now)
			s.rateFailed(route, err)
		}
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
	// Without the table, or for a device that lately needed more than a
	// first read here, the page is taken before anything is read: fetches
	// that start at once, each on an instance new to the minute, then
	// read nothing before most are refused.
	limits := inboxPage
	device := c.AccountID + "#" + c.DeviceID
	if local || s.paged.recent(device, now) {
		if !take(worst) {
			if local {
				return httpapi.Error(http.StatusTooManyRequests, "rate_limited")
			}
			return refused(0)
		}
		reserved = true
		limits.First = inbox.MinStep
	}
	page, err := s.Inbox.List(ctx, c.AccountID, c.DeviceID, after, limits, now, func() error {
		if reserved {
			return nil
		}
		if !take(worst) {
			return errLimited
		}
		reserved = true
		return nil
	})
	if errors.Is(err, errLimited) || page.Read > inbox.ProbeItems || page.After != "" {
		s.paged.mark(device, now)
	} else {
		s.paged.forget(device)
	}
	if errors.Is(err, errLimited) {
		return refused(page.Units)
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
			return refused(page.Units)
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

// paged remembers, on this instance and for a few minutes, the devices
// whose last fetch here needed more than a first read: their next fetch
// takes a page from the minute before reading anything. Device IDs stay in
// this instance's memory only.
type paged struct {
	mu   sync.Mutex
	last map[string]int64 // device -> when, Unix seconds
}

// pagedFor is how long a device stays remembered.
const pagedFor = 5 * 60 // seconds

func (p *paged) recent(device string, now time.Time) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	at, ok := p.last[device]
	return ok && now.Unix()-at < pagedFor
}

func (p *paged) mark(device string, now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.last == nil || len(p.last) >= 16384 {
		p.last = map[string]int64{}
	}
	p.last[device] = now.Unix()
}

func (p *paged) forget(device string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.last, device)
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
//     (AckMissesPerDay), past which nothing is deleted;
//   - a confirmation starts no more deletes once AckMissesPerRequest
//     missed: the rest are taken without deleting, so instances that let a
//     request through past the day (each at most one) add little;
//   - while the ephemeral table can't be reached to count them, misses are
//     limited per instance and minute (AckLocalMissesPerMinute).
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
	// ago), or past this instance's own count of them while the table
	// can't be reached, taken without deleting or counting anything.
	day := s.rateName("ackmiss", now, 24*time.Hour, c.person())
	ok, err := s.Limits.CheckAt(ctx, day, AckMissesPerDay, 24*time.Hour, now)
	degraded := err != nil
	s.rateFailed(route, err)
	if !ok || !s.Limits.LocalAt(day, 0, AckLocalMissesPerMinute-1, time.Minute, now) {
		return httpapi.JSON(http.StatusOK, map[string]string{})
	}
	missing, failed := 0, []string(nil)
	if len(keys) > 0 {
		missing, failed = s.Inbox.Ack(ctx, c.AccountID, c.DeviceID, keys, AckMissesPerRequest)
		if len(failed) == len(keys) {
			return s.internal(route, errors.New("inbox: no delete succeeded"))
		}
	}
	if misses := missing + stale; misses > 0 {
		if !degraded {
			_, err = s.Limits.Tally(ctx, day, misses, AckMissesPerDay, 24*time.Hour, now)
			degraded = err != nil
			s.rateFailed(route, err)
		}
		if degraded {
			s.Limits.LocalAt(day, misses, math.MaxInt32, time.Minute, now)
		}
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

// rateName is the key of a rate counter of kind, for who (a mailbox, a
// link, a device, a person, an upload), in the window that holds now: kind
// and a keyed hash of who and the window, under the pepper, which only
// this function holds. It changes with every window, so the ephemeral
// table holds nothing that ties a counter to an account, a mailbox or a
// link, or one window's counter to the next: nothing that tells which
// mailboxes got messages when, or when an account fetched or confirmed its
// messages, and nothing to match with the directory. Every rate counter is
// named this way.
func (s *Server) rateName(kind string, now time.Time, window time.Duration, who ...string) string {
	parts := [][]byte{[]byte(kind), strconv.AppendInt(nil, now.Truncate(window).Unix(), 10)}
	for _, w := range who {
		parts = append(parts, []byte(w))
	}
	return kind + "#" + keyed.Name(s.Pepper, labelRateName, parts...)
}

// allow counts one use of kind's limit for who, in the window that holds
// now, and reports whether it fits.
func (s *Server) allow(ctx context.Context, kind string, limit int, window time.Duration, who ...string) (bool, error) {
	return s.allowN(ctx, kind, 1, limit, window, who...)
}

// allowN counts n uses at once, allowing them only if all fit.
func (s *Server) allowN(ctx context.Context, kind string, n, limit int, window time.Duration, who ...string) (bool, error) {
	now := s.Now()
	return s.Limits.AllowNAt(ctx, s.rateName(kind, now, window, who...), n, limit, window, now)
}
