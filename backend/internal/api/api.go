// Package api implements the client's HTTPS API.
//
// Error responses carry a stable code the client acts on:
//
//	bad_request, unsupported_media_type  the request is malformed
//	init_data_rejected                    Telegram's launch data is invalid, too old, the wrong kind of launch, or another user's
//	signature_rejected                    a device or account signature is invalid
//	invalid_device_list                   the device list is malformed or doesn't match the request
//	account_exists                        the Telegram user has another account; repeat with replace to end it
//	conflict                              a concurrent change won; try again
//	rate_limited                          too many attempts; try later
//	daily_limit                           429: a daily limit is used up; try after Retry-After, when the UTC day ends
//	link_busy                             429: POST /send to a link's intro mailbox, past the link's first messages for the hour; try after Retry-After, when the hour ends
//	download_limit                        429: GET /media/{id}, past the file's downloads for the day; try after Retry-After, when the UTC day ends
//	clock_skew                            401: a timestamp, or a new account's device list, is too far from the server's clock, which "now" gives; sign again
//	login_refused                         the device can't log in
//	account_replaced                      the account was replaced by a new registration
//	session_expired                       the session token is missing or expired; log in again
//	invitation_required                   only members and admins can own links while invite-only
//	invalid_link                          the link ID or bundle is malformed or badly signed, or the owner proof doesn't check
//	link_limit                            the account has a link already (replace it instead)
//	signing_key_taken                     another account has (or had) this link signing key: each account's links need their own
//	no_invitations_left                   the member has fewer invitations left than asked for
//	invalid_invitation                    no such invitation code, or it is used up
//	already_member                        the account already joined through an invitation, or is an admin
//	own_invitation                        the code was made by the account redeeming it
//	not_member                            invitations can only be granted to members
//	admin_only                            only admins can do this
//	invalid_envelope                      the envelope's layout can't be valid
//	mailbox_limit                         the account has the most mailboxes allowed
//	invalid_token                         the send token is missing, invalid, from another week, or spent
//	tokens_needed                         402: a send brought more or fewer tokens than its envelope costs, which "needed" gives
//	unknown_issuer_key                    a token batch names, or a token is for, an issuer key the server doesn't hold (an app built for a retired key)
//	uploads_paused                        the operator has paused uploads of attachments for now (switches.go); try later
//	downloads_paused                      the operator has paused downloads of attachments for now (switches.go); try later
//	in_progress                           the account, or what is left of one it replaced, is being deleted in steps (or another step runs now); repeat the request
//	account_deleting                      the account is being deleted: it takes no request but GET and DELETE /account
//	not_found                             no such route, or no such link (revoked links included)
//	method_not_allowed                    the route exists, but not with this method
//	unavailable                           503: the server is overloaded for now (AWS throttled it, or it ran out of time); try again after Retry-After
//	internal                              something failed on the server
package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/awsconf"
	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/links"
	"github.com/incognitochat/incognitochat/backend/internal/logx"
	"github.com/incognitochat/incognitochat/backend/internal/session"
	"github.com/incognitochat/incognitochat/backend/internal/telegram/initdata"
)

// Directory is the account store.
type Directory interface {
	ByTelegram(ctx context.Context, telegramHash, deviceID string) (directory.Account, error)
	Create(ctx context.Context, n directory.NewAccount) error
	Replace(ctx context.Context, old directory.Account, n directory.NewAccount, now time.Time) error
	Device(ctx context.Context, accountID, deviceID string, now time.Time) (directory.Device, error)
	// LoginDevice is Device for /session, eventually consistent.
	LoginDevice(ctx context.Context, accountID, deviceID string, now time.Time) (directory.Device, error)
	CreateLink(ctx context.Context, accountID string, l directory.Link, max int) error
	Link(ctx context.Context, id string) (directory.Link, error)
	// Bundle is Link for anyone, eventually consistent.
	Bundle(ctx context.Context, id string) (directory.Link, error)
	ReplaceLink(ctx context.Context, accountID, oldID string, l directory.Link) error
	SetLinkKeys(ctx context.Context, accountID, id string, keys []links.Key) error
	SetNotices(ctx context.Context, accountID string, sealedChat []byte, language string) error
	// ForgetNotices removes what notices need from an account whose
	// notices are off, only while they still are.
	ForgetNotices(ctx context.Context, accountID string) error
	DeleteLink(ctx context.Context, accountID, id string) error
	Levels(ctx context.Context) (map[int]int, error)
	SetLevel(ctx context.Context, level, allowance int) error
	CreateInvitation(ctx context.Context, accountID, code string, uses, ownerLevel, maxAllocated int) error
	Invitations(ctx context.Context, accountID string) ([]directory.Invitation, error)
	Redeem(ctx context.Context, accountID, code string) (int, error)
	Grant(ctx context.Context, linkID string, invitations int) error
	CreateMailboxes(ctx context.Context, accountID string, ids []string, max int) error
	Mailbox(ctx context.Context, id string) (directory.Mailbox, error)
	DiscardMailbox(ctx context.Context, accountID, id string) error
	// Devices lists an account's devices whatever became of it, to clear
	// what waits for them; Recipients those a delivery goes to: none
	// unless the account is live.
	Devices(ctx context.Context, accountID string, now time.Time) ([]string, error)
	Recipients(ctx context.Context, accountID string, now time.Time) ([]string, error)
	// NoRecipients looks up the devices of an account that doesn't exist,
	// as Recipients does, at the same cost, and finds none.
	NoRecipients(ctx context.Context, now time.Time) error
	Mailboxes(ctx context.Context, accountID string) ([]string, error)
	MailboxCount(ctx context.Context, accountID string, now time.Time) (int, error)
	// MarkDeleting marks an account as being deleted: from then on it
	// makes and takes nothing (directory.Store.MarkDeleting).
	MarkDeleting(ctx context.Context, accountID string) error
	// Delete deletes about max items of an account per call, and reports
	// whether it has finished (directory.Store.Delete).
	Delete(ctx context.Context, accountID, telegramHash string, max int) (bool, error)
	// CleanUp deletes about max items of what is left of old, an account
	// that accountID replaced, per call, and reports whether it has
	// finished (directory.Store.CleanUp).
	CleanUp(ctx context.Context, accountID, old string, max int) (bool, error)
	// Lease lets one such step run for an account at a time: ok is false
	// while another holds it; release, at the end, lets the next start a
	// moment later, or removes the lease once done (directory.Store.Lease).
	Lease(ctx context.Context, accountID string, now time.Time) (release func(ctx context.Context, now time.Time, done bool) error, ok bool, err error)
	// AccountExists reports whether a Telegram user has an account in use
	// (not one being deleted).
	AccountExists(ctx context.Context, telegramHash string) (bool, error)
}

// Limiter counts uses of a key in fixed windows.
//
// Every method counts in the window that holds at, which the counter is
// named by (rateName: a keyed hash of what it counts and the window), so a
// request counts in one window however long it takes (ephemeral.Limiter).
// Only counts the database returned refuse anything.
type Limiter interface {
	// AllowNAt counts n uses if they fit within limit.
	AllowNAt(ctx context.Context, key string, n, limit int, window time.Duration, at time.Time) (bool, error)
	// RefundAt takes back n uses that AllowNAt reserved and weren't used.
	RefundAt(ctx context.Context, key string, n int, window time.Duration, at time.Time) error
	// FullAt reports whether key's window is known to have reached limit,
	// from memory only, so refusing costs nothing.
	FullAt(key string, limit int, window time.Duration, at time.Time) bool
	// UsedAt reports how many uses the window has counted, as the database
	// says now.
	UsedAt(ctx context.Context, key string, window time.Duration, at time.Time) (int, error)
	// CountedAt is the count the database last returned for the window to
	// this instance, such as just now to AllowNAt.
	CountedAt(key string, window time.Duration, at time.Time) int
	// CheckAt reports whether the window is below limit, from memory, or
	// by reading the count (at least once a minute for longer windows); if
	// the database can't be read, from memory, with the error.
	CheckAt(ctx context.Context, key string, limit int, window time.Duration, at time.Time) (bool, error)
	// Tally counts n uses in batches, writing about once per batch, and
	// reports whether the window is below limit as last written.
	Tally(ctx context.Context, key string, n, limit int, window time.Duration, at time.Time) (bool, error)
	// LocalAt counts n uses in this instance's memory only, for when the
	// database can't be reached, and reports whether they fit in limit.
	LocalAt(key string, n, limit int, window time.Duration, at time.Time) bool
}

// Server holds what the handlers need.
type Server struct {
	Telegram  initdata.Verifier
	Sessions  *session.Issuer
	Directory Directory
	Nonces    session.NonceStore
	Limits    Limiter
	Pepper    []byte // keys the hash of Telegram user IDs, inbox item IDs (itemID) and the names of rate counters (rateName)
	Log       *slog.Logger
	Now       func() time.Time

	// InviteOnly limits owning links to members and admins.
	InviteOnly bool
	// Admins holds the Telegram hashes (directory.TelegramHash) of admins.
	Admins map[string]bool

	// Inbox stores undelivered envelopes.
	Inbox Inbox

	// Issuer signs and checks anonymous send tokens, MediaIssuer media
	// tokens (uploads); Spent remembers spent ones of both kinds.
	Issuer      Issuer
	MediaIssuer Issuer
	Spent       Spent

	// Notices, if set, seals the chat IDs Telegram notices go to.
	Notices Notices
	// Push, if set, hands each send to the ws function, which tells open
	// apps that something arrived, and asks for a Telegram notice if none
	// took it.
	Push Pusher
	// Sockets, if set, holds the records of open apps' sockets; an account's
	// go when it is deleted.
	Sockets SocketRecords

	// Media and Uploads, if set, hold encrypted attachments.
	Media   Media
	Uploads Uploads

	// Switches, if set, holds the operator's emergency switches, which
	// pause uploads or downloads of attachments (switches.go).
	Switches    SwitchStore
	switchCache switchCache
	// paged remembers devices whose inbox needed more than a first read
	// here lately (listInbox).
	paged paged
}

// SocketRecords are the records of open apps' sockets (ephemeral.Sockets).
type SocketRecords interface {
	ForgetAll(ctx context.Context, account string) error
}

// Pusher hands a send to the ws function (push.Client), without waiting:
// ws pushes a content-free hint to the account's open apps, and asks
// notify for a notice if none took it and quiet is false. So the api
// function never learns, and a sender can't time, whether the recipient's
// app is open. An empty account (a mailbox that doesn't exist) makes the
// same request, for nobody.
type Pusher interface {
	Push(ctx context.Context, account string, quiet bool) error
}

// Routes registers the API's routes.
func (s *Server) Routes(r *httpapi.Router) {
	r.Handle(http.MethodPost, "/register", s.register)
	r.Handle(http.MethodPost, "/session", s.session)
	r.Handle(http.MethodGet, "/account", s.withDevice("GET /account", s.account))
	r.Handle(http.MethodGet, "/usage", s.withDevice("GET /usage", s.usage))
	r.Handle(http.MethodDelete, "/account", s.withSignature("DELETE /account", s.deleteAccount))
	r.Handle(http.MethodPost, "/account/cleanup", s.withSignature("POST /account/cleanup", s.cleanUp))
	r.Handle(http.MethodPost, "/links", s.withSignature("POST /links", s.createLink))
	r.Handle(http.MethodPut, "/links/{id}/keys", s.withSignature("PUT /links/{id}/keys", s.setLinkKeys))
	r.Handle(http.MethodDelete, "/links/{id}", s.withSignature("DELETE /links/{id}", s.revokeLink))
	r.Handle(http.MethodGet, "/links/{id}", s.linkBundle)
	r.Handle(http.MethodGet, "/invitations", s.withDevice("GET /invitations", s.listInvitations))
	r.Handle(http.MethodPost, "/invitations", s.withSignature("POST /invitations", s.createInvitation))
	r.Handle(http.MethodPost, "/invitations/redeem", s.withDevice("POST /invitations/redeem", s.redeem))
	r.Handle(http.MethodGet, "/admin/levels", s.withDevice("GET /admin/levels", s.withAdmin(s.adminLevels)))
	r.Handle(http.MethodPut, "/admin/levels", s.withSignature("PUT /admin/levels", s.withAdmin(s.adminSetLevel)))
	r.Handle(http.MethodPost, "/admin/grant", s.withSignature("POST /admin/grant", s.withAdmin(s.adminGrant)))
	r.Handle(http.MethodGet, "/admin/switches", s.withDevice("GET /admin/switches", s.withAdmin(s.adminSwitches)))
	r.Handle(http.MethodPut, "/admin/switches", s.withSignature("PUT /admin/switches", s.withAdmin(s.adminSetSwitch)))
	r.Handle(http.MethodPost, "/mailboxes", s.withDevice("POST /mailboxes", s.createMailboxes))
	r.Handle(http.MethodPost, "/mailboxes/{id}/discard", s.withDevice("POST /mailboxes/{id}/discard", s.discardMailbox))
	r.Handle(http.MethodPost, "/mailboxes/check", s.withDevice("POST /mailboxes/check", s.checkMailboxes))
	r.Handle(http.MethodPost, "/send", s.send)
	r.Handle(http.MethodPost, "/tokens", s.withDevice("POST /tokens", s.issueTokens))
	r.Handle(http.MethodPost, "/tokens/media", s.withDevice("POST /tokens/media", s.issueMediaTokens))
	r.Handle(http.MethodGet, "/tokens/keys", s.issuerKeys)
	r.Handle(http.MethodGet, "/inbox", s.withDevice("GET /inbox", s.listInbox))
	r.Handle(http.MethodPost, "/ack", s.withDevice("POST /ack", s.ack))
	r.Handle(http.MethodPost, "/notices", s.withDevice("POST /notices", s.setNotices))
	r.Handle(http.MethodPost, "/accounts/lookup", s.lookupAccount)
	r.Handle(http.MethodPost, "/media", s.upload)
	r.Handle(http.MethodPost, "/media/{id}/upload", s.renewUpload)
	r.Handle(http.MethodGet, "/media/{id}", s.download)
	r.Handle(http.MethodPost, "/media/{id}/delete", s.deleteUpload)
}

// tokenResponse is what a successful registration or login returns.
type tokenResponse struct {
	Account string `json:"account"`
	Token   string `json:"token"`
	Expires int64  `json:"expires"` // Unix seconds
}

func (s *Server) issue(route, accountID, deviceID string, now time.Time) httpapi.Response {
	token, expires, err := s.Sessions.Issue(accountID, deviceID, now)
	if err != nil {
		return s.internal(route, err)
	}
	return httpapi.JSON(http.StatusOK, tokenResponse{Account: accountID, Token: token, Expires: expires.Unix()})
}

// RetryAfter is how many seconds the app is asked to wait after 503
// unavailable.
const RetryAfter = 2

// internal logs a server-side failure, without anything about the request.
// One that may pass in a moment, AWS throttling or a deadline that passed
// (awsconf.Unavailable), is answered 503 unavailable with Retry-After: the
// app's background syncs then back off, rather than everyone's polling
// keeping the load up.
func (s *Server) internal(route string, err error) httpapi.Response {
	status, code := http.StatusInternalServerError, "internal"
	if awsconf.Unavailable(err) {
		status, code = http.StatusServiceUnavailable, "unavailable"
	}
	s.Log.Warn("request failed",
		slog.String(logx.KeyRoute, route),
		slog.Int(logx.KeyStatus, status),
		logx.ErrorKind(err))
	resp := httpapi.Error(status, code)
	if status == http.StatusServiceUnavailable {
		resp.Headers["retry-after"] = strconv.Itoa(RetryAfter)
	}
	return resp
}

// bytes64 is a byte string written in JSON as unpadded base64url.
type bytes64 []byte

func (b bytes64) MarshalJSON() ([]byte, error) {
	return json.Marshal(base64.RawURLEncoding.EncodeToString(b))
}

func (b *bytes64) UnmarshalJSON(data []byte) error {
	var text string
	if err := json.Unmarshal(data, &text); err != nil {
		return err
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(text)
	if err != nil {
		return err
	}
	*b = decoded
	return nil
}
