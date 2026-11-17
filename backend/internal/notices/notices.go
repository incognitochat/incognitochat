// Package notices sends the Telegram "New message" notices (design §12).
//
// Notices are generic: "New message" in the user's language with a button
// that opens the app. No labels, counts or names. At most one per account
// every few minutes, and the previous one is deleted once a new one went
// out. A notice that couldn't be sent (Telegram's flood control among
// other reasons) leaves the previous one in place and uses up no quiet
// period, so the next message can notify.
//
// The chat ID (the user's Telegram ID) is kept sealed with a key only the
// notify function holds, so neither the api function nor a copy of the
// directory table can read it. notify is asked for a notice by the ws
// function, after a delivery no open app took; it has no access to socket
// records.
package notices

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"strings"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/keyed"
	"github.com/incognitochat/incognitochat/backend/internal/telegram/botapi"
)

// Interval is the least time between two notices to one account.
const Interval = 3 * time.Minute

// Lease is how long an account's quiet period first lasts, while its notice
// is being sent: longer than the notify function may run (10 s,
// infra/functions.tf), so a second invocation can't send one meanwhile.
// Once the notice is out, the quiet period runs Interval from then; if it
// didn't go out, it ends. Rounded up to the minute, as quiet periods are.
const Lease = 30 * time.Second

// MaxRetryWait is the longest notify waits, once, when Telegram's flood
// control refuses a notice and says when to try again. Asked to wait
// longer, it gives up (ErrRateLimited).
const MaxRetryWait = 3 * time.Second

const (
	// reserve is kept at the end of an invocation, after the Bot API
	// calls, to record what happened.
	reserve = time.Second
	// minCall is the least time left for the call after a wait.
	minCall = time.Second
)

const label = "incognitochat/v2/chat-id"

var (
	// ErrSealed is returned for a sealed chat ID that doesn't open.
	ErrSealed = errors.New("notices: sealed chat ID doesn't open")
	// ErrRateLimited is returned when Telegram's flood control refused a
	// notice, and notify couldn't wait to try again or was refused again.
	// The notice is dropped and the previous one stays; the account's
	// quiet period was ended, so the next message can notify.
	ErrRateLimited = errors.New("notices: refused by Telegram's flood control")
)

// Sealer seals chat IDs with AES-256-GCM under a key derived from a secret.
type Sealer struct{ aead cipher.AEAD }

// NewSealer derives the sealing key from a secret of at least 32 bytes.
func NewSealer(secret []byte) (*Sealer, error) {
	if len(secret) < 32 {
		return nil, errors.New("notices: chat key too short")
	}
	k := sha256.Sum256(append([]byte(label+":"), secret...))
	block, err := aes.NewCipher(k[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Sealer{aead: aead}, nil
}

// Seal encrypts a chat ID: nonce ‖ ciphertext.
func (s *Sealer) Seal(chat int64) ([]byte, error) {
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return s.aead.Seal(nonce, nonce, binary.BigEndian.AppendUint64(nil, uint64(chat)), []byte(label)), nil
}

// Open decrypts a sealed chat ID.
func (s *Sealer) Open(sealed []byte) (int64, error) {
	n := s.aead.NonceSize()
	if len(sealed) < n {
		return 0, ErrSealed
	}
	pt, err := s.aead.Open(nil, sealed[:n], sealed[n:], []byte(label))
	if err != nil || len(pt) != 8 {
		return 0, ErrSealed
	}
	return int64(binary.BigEndian.Uint64(pt)), nil
}

// Directory is what notices need from the directory table.
type Directory interface {
	Notices(ctx context.Context, accountID string) (directory.NoticeTarget, error)
	NoticeSent(ctx context.Context, accountID string, messageID int64) error
	NoticesOff(ctx context.Context, accountID string) error
}

// Quiet holds the quiet period after a notice (ephemeral.Quiet).
type Quiet interface {
	// Start begins a quiet period for key until until, and reports false
	// if one is already running. It is atomic: of two at once, one starts.
	Start(ctx context.Context, key string, until time.Time) (bool, error)
	// Move moves the end of the quiet period Start began until from to
	// until, or ends it if until has passed; another period is left alone.
	Move(ctx context.Context, key string, from, until time.Time) error
}

const (
	labelQuietKey  = "incognitochat/v2/notice-key"
	labelQuietName = "incognitochat/v2/notice-name"
)

// QuietKey derives the key that names quiet periods from the chat key,
// which only the notify function holds: a quiet period is stored under a
// keyed hash of its account, not the account's ID, so a copy of the
// ephemeral table can't be matched with the directory. A new chat key
// gives new names, so an account may get a second notice within Interval,
// once (and its sealed chat ID no longer opens anyway, until the app sets
// notices up again).
func QuietKey(chatKey []byte) []byte { return keyed.Key(chatKey, labelQuietKey) }

// Notifier sends notices.
type Notifier struct {
	Directory Directory
	Quiet     Quiet
	// QuietKey names quiet periods (QuietKey).
	QuietKey []byte
	Sealer   *Sealer
	Bot      botapi.Client
	AppURL   string
	Now      func() time.Time
	// Sleep waits for d or until ctx ends; nil for a timer.
	Sleep func(ctx context.Context, d time.Duration) error
}

// Notify sends an account its notice, unless it has notices off, has none
// set up, or had one within Interval.
//
// The quiet period is started for Lease before sending, so two deliveries
// at once still send one notice. Only once the notice went out does the
// quiet period run its whole Interval, and is the previous notice deleted.
// If it didn't go out, the previous notice stays and the quiet period
// ends, so the next message can notify.
func (n *Notifier) Notify(ctx context.Context, accountID string) error {
	target, err := n.Directory.Notices(ctx, accountID)
	if errors.Is(err, directory.ErrNotFound) || (err == nil && target.Off) {
		return nil
	}
	if err != nil {
		return err
	}
	chat, err := n.Sealer.Open(target.SealedChat)
	if err != nil {
		// Sealed under an earlier key: wait for the app to set it up again.
		return n.Directory.NoticesOff(ctx, accountID)
	}
	key := "notice#" + keyed.Name(n.QuietKey, labelQuietName, []byte(accountID))
	lease := n.Now().Add(Lease)
	ok, err := n.Quiet.Start(ctx, key, lease)
	if err != nil || !ok {
		return err
	}

	id, err := n.send(ctx, chat, target.Language)
	var apiErr *botapi.Error
	if errors.As(err, &apiErr) && apiErr.Forbidden() {
		// Blocked, or never allowed to write: stop until the app turns
		// notices on again. (The quiet period ends with its lease.)
		return n.Directory.NoticesOff(ctx, accountID)
	}
	if err != nil {
		if errors.As(err, &apiErr) && apiErr.TooManyRequests() {
			err = ErrRateLimited
		}
		if endErr := n.Quiet.Move(ctx, key, lease, time.Time{}); endErr != nil {
			return errors.Join(err, endErr)
		}
		return err
	}

	err = errors.Join(
		n.Quiet.Move(ctx, key, lease, n.Now().Add(Interval)),
		n.Directory.NoticeSent(ctx, accountID, id),
	)
	if target.LastMessage > 0 {
		// Only the latest notice stays in the chat. The previous one may
		// be gone already, and Telegram lets bots delete their messages
		// only for 48 hours: an older one stays.
		_ = n.Bot.Call(ctx, "deleteMessage", map[string]any{"chat_id": chat, "message_id": target.LastMessage}, nil)
	}
	return err
}

// send sends a notice and returns its message ID. If Telegram's flood
// control refuses it and asks for a wait of at most MaxRetryWait, which
// the invocation has time for, it waits and tries once more.
func (n *Notifier) send(ctx context.Context, chat int64, language string) (int64, error) {
	if deadline, ok := ctx.Deadline(); ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, deadline.Add(-reserve))
		defer cancel()
	}
	text := textFor(language)
	params := map[string]any{
		"chat_id":              chat,
		"text":                 text.notice,
		"disable_notification": false,
		"reply_markup": map[string]any{
			"inline_keyboard": [][]map[string]any{{{"text": text.open, "web_app": map[string]string{"url": n.AppURL}}}},
		},
	}
	var sent struct {
		MessageID int64 `json:"message_id"`
	}
	err := n.Bot.Call(ctx, "sendMessage", params, &sent)
	var apiErr *botapi.Error
	if errors.As(err, &apiErr) && apiErr.TooManyRequests() && canWait(ctx, apiErr.RetryAfter) && n.sleep(ctx, apiErr.RetryAfter) == nil {
		err = n.Bot.Call(ctx, "sendMessage", params, &sent)
	}
	return sent.MessageID, err
}

// canWait reports whether a wait for flood control is short enough, and
// leaves time to try again.
func canWait(ctx context.Context, wait time.Duration) bool {
	if wait <= 0 || wait > MaxRetryWait {
		return false
	}
	deadline, ok := ctx.Deadline()
	return !ok || time.Until(deadline) >= wait+minCall
}

func (n *Notifier) sleep(ctx context.Context, d time.Duration) error {
	if n.Sleep != nil {
		return n.Sleep(ctx, d)
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

// Language returns the notice language for a Telegram language code.
func Language(code string) string {
	if l := strings.ToLower(code); l == "fa" || strings.HasPrefix(l, "fa-") || strings.HasPrefix(l, "fa_") {
		return "fa"
	}
	return "en"
}

type texts struct{ notice, open string }

func textFor(language string) texts {
	if language == "fa" {
		return texts{notice: "پیام جدید", open: "باز کردن"}
	}
	return texts{notice: "New message", open: "Open"}
}
