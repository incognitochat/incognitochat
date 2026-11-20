package notices

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
	"github.com/incognitochat/incognitochat/backend/internal/telegram/botapi"
)

var now = time.Unix(1_800_000_000, 0)

func TestSealer(t *testing.T) {
	s, err := NewSealer(bytes.Repeat([]byte("k"), 32))
	if err != nil {
		t.Fatal(err)
	}
	a, _ := s.Seal(123456789)
	b, _ := s.Seal(123456789)
	if bytes.Equal(a, b) {
		t.Fatal("sealing is deterministic: equal chats would show")
	}
	if chat, err := s.Open(a); err != nil || chat != 123456789 {
		t.Fatalf("Open = %d, %v", chat, err)
	}
	other, _ := NewSealer(bytes.Repeat([]byte("j"), 32))
	if _, err := other.Open(a); err == nil {
		t.Fatal("another key opened it")
	}
	a[len(a)-1] ^= 1
	if _, err := s.Open(a); err == nil {
		t.Fatal("a tampered seal opened")
	}
	if _, err := NewSealer([]byte("short")); err == nil {
		t.Fatal("accepted a short secret")
	}
}

type memDirectory struct {
	mu     sync.Mutex
	target directory.NoticeTarget
	found  bool
	sent   []int64
	off    bool
	stale  bool // off because the sealed chat ID didn't open, not a refusal
}

func (m *memDirectory) Notices(context.Context, string) (directory.NoticeTarget, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.found {
		return directory.NoticeTarget{}, directory.ErrNotFound
	}
	t := m.target
	t.Off = m.off
	if len(m.sent) > 0 {
		t.LastMessage = m.sent[len(m.sent)-1]
	}
	return t, nil
}
func (m *memDirectory) NoticeSent(_ context.Context, _ string, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sent = append(m.sent, id)
	return nil
}
func (m *memDirectory) NoticesOff(context.Context, string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.off = true
	return nil
}
func (m *memDirectory) NoticesStale(context.Context, string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.off, m.stale = true, true
	return nil
}

type memQuiet struct {
	mu     sync.Mutex
	until  map[string]time.Time
	tokens map[string]string
	starts int
	now    *time.Time
}

func newMemQuiet(now *time.Time) *memQuiet {
	return &memQuiet{until: map[string]time.Time{}, tokens: map[string]string{}, now: now}
}

func (q *memQuiet) Start(_ context.Context, key string, until time.Time) (string, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if u, ok := q.until[key]; ok && q.now.Before(u) {
		return "", nil
	}
	q.starts++
	q.until[key], q.tokens[key] = until, "token-"+strconv.Itoa(q.starts)
	return q.tokens[key], nil
}

func (q *memQuiet) Move(_ context.Context, key, token string, until time.Time) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.tokens[key] == token {
		q.until[key] = until
	}
	return nil
}

// telegram is a fake Bot API. reply answers each call by method name and
// how many calls of that method came before it since they were last seen;
// a reply of "" (or no reply func) is a success with a new message ID.
type telegram struct {
	*httptest.Server
	mu     sync.Mutex
	calls  []string
	bodies []map[string]any
	given  int // message IDs given, from 10
	reply  func(method string, n int) (int, string)
}

func newTelegram(t *testing.T) *telegram {
	tg := &telegram{}
	tg.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		tg.mu.Lock()
		n := 0
		for _, c := range tg.calls {
			if c == method {
				n++
			}
		}
		tg.calls = append(tg.calls, method)
		tg.bodies = append(tg.bodies, body)
		reply := tg.reply
		tg.mu.Unlock()
		if reply != nil {
			if status, out := reply(method, n); out != "" {
				w.WriteHeader(status)
				_, _ = w.Write([]byte(out))
				return
			}
		}
		tg.mu.Lock()
		id := 10 + tg.given
		tg.given++
		tg.mu.Unlock()
		_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":` + strconv.Itoa(id) + `}}`))
	}))
	t.Cleanup(tg.Close)
	return tg
}

// seen returns the calls so far, and forgets them.
func (tg *telegram) seen() ([]string, []map[string]any) {
	tg.mu.Lock()
	defer tg.mu.Unlock()
	calls, bodies := tg.calls, tg.bodies
	tg.calls, tg.bodies = nil, nil
	return calls, bodies
}

func (tg *telegram) answer(reply func(method string, n int) (int, string)) {
	tg.mu.Lock()
	defer tg.mu.Unlock()
	tg.reply = reply
}

const (
	refused     = `{"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}`
	serverError = `{"ok":false,"error_code":500,"description":"Internal Server Error"}`
)

func flood(seconds int) string {
	return `{"ok":false,"error_code":429,"description":"Too Many Requests","parameters":{"retry_after":` + strconv.Itoa(seconds) + `}}`
}

// notifier returns a Notifier with an in-memory directory (notices set up,
// in Persian) and quiet periods, its clock, and the waits it took.
func notifier(t *testing.T, tg *telegram) (*Notifier, *memDirectory, *time.Time, *[]time.Duration) {
	sealer, _ := NewSealer(bytes.Repeat([]byte("k"), 32))
	sealed, _ := sealer.Seal(4242)
	clock := now
	var waits []time.Duration
	dir := &memDirectory{target: directory.NoticeTarget{SealedChat: sealed, Language: "fa"}, found: true}
	return &Notifier{
		Directory: dir,
		Quiet:     newMemQuiet(&clock),
		QuietKey:  QuietKey(bytes.Repeat([]byte("k"), 32)),
		Sealer:    sealer,
		Bot:       botapi.Client{Token: "1:T", API: tg.URL},
		AppURL:    "https://example.github.io/",
		Now:       func() time.Time { return clock },
		Sleep: func(_ context.Context, d time.Duration) error {
			waits = append(waits, d)
			return nil
		},
	}, dir, &clock, &waits
}

func TestNotify(t *testing.T) {
	tg := newTelegram(t)
	n, dir, clock, _ := notifier(t, tg)
	ctx := context.Background()

	if err := n.Notify(ctx, "acct"); err != nil {
		t.Fatal(err)
	}
	calls, bodies := tg.seen()
	if !slices.Equal(calls, []string{"sendMessage"}) || bodies[0]["chat_id"] != float64(4242) || bodies[0]["text"] != "پیام جدید" {
		t.Fatalf("first notice: %v %v", calls, bodies)
	}
	// The quiet period is named by a keyed hash of the account, not its ID.
	for key := range n.Quiet.(*memQuiet).until {
		if !strings.HasPrefix(key, "notice#") || strings.Contains(key, "acct") {
			t.Fatalf("quiet period %q", key)
		}
	}
	// Within the quiet period: nothing, also once the hold taken while
	// sending would have run out.
	for _, at := range []time.Duration{0, Lease + time.Second, 2 * time.Minute} {
		*clock = now.Add(at)
		if err := n.Notify(ctx, "acct"); err != nil {
			t.Fatal(err)
		}
		if calls, _ := tg.seen(); len(calls) != 0 {
			t.Fatalf("second notice inside the interval, after %v: %v", at, calls)
		}
	}
	// After it: a new one is sent, then the old one deleted.
	*clock = now.Add(Interval + time.Second)
	if err := n.Notify(ctx, "acct"); err != nil {
		t.Fatal(err)
	}
	calls, bodies = tg.seen()
	if !slices.Equal(calls, []string{"sendMessage", "deleteMessage"}) || bodies[1]["message_id"] != float64(10) || !slices.Equal(dir.sent, []int64{10, 11}) {
		t.Fatalf("calls = %v, delete = %v, sent %v", calls, bodies, dir.sent)
	}
	// The old notice failing to delete (older than 48 hours, say) changes nothing.
	tg.answer(func(method string, _ int) (int, string) {
		if method == "deleteMessage" {
			return http.StatusBadRequest, `{"ok":false,"error_code":400,"description":"Bad Request: message can't be deleted"}`
		}
		return 0, ""
	})
	*clock = clock.Add(Interval + time.Second)
	if err := n.Notify(ctx, "acct"); err != nil || len(dir.sent) != 3 {
		t.Fatalf("undeletable old notice: %v, sent %v", err, dir.sent)
	}
	tg.seen()
	// Telegram refusing turns notices off; then none are tried.
	tg.answer(func(string, int) (int, string) { return http.StatusForbidden, refused })
	*clock = clock.Add(Interval + time.Second)
	if err := n.Notify(ctx, "acct"); err != nil || !dir.off || dir.stale {
		t.Fatalf("forbidden: %v, off %v, stale %v", err, dir.off, dir.stale)
	}
	if calls, _ := tg.seen(); !slices.Equal(calls, []string{"sendMessage"}) {
		t.Fatalf("forbidden: %v", calls)
	}
	*clock = clock.Add(Interval + time.Second)
	_ = n.Notify(ctx, "acct")
	if calls, _ := tg.seen(); len(calls) != 0 {
		t.Fatal("a notice was tried with notices off")
	}
	// A chat ID sealed under another key turns notices off too, but not
	// as a refusal: the app sets them up again by itself.
	stale, _ := NewSealer(bytes.Repeat([]byte("o"), 32))
	old, _ := stale.Seal(4242)
	staleDir := &memDirectory{target: directory.NoticeTarget{SealedChat: old}, found: true}
	n2 := &Notifier{Directory: staleDir, Quiet: newMemQuiet(clock), QuietKey: n.QuietKey, Sealer: n.Sealer, Bot: n.Bot, Now: n.Now}
	if err := n2.Notify(ctx, "acct"); err != nil || !staleDir.off || !staleDir.stale {
		t.Fatalf("stale seal: %v, off %v, stale %v", err, staleDir.off, staleDir.stale)
	}
	if calls, _ := tg.seen(); len(calls) != 0 {
		t.Fatalf("stale seal: %v", calls)
	}
	// No notice setup at all: nothing, no error.
	if err := (&Notifier{Directory: &memDirectory{}, Now: n.Now}).Notify(ctx, "other"); err != nil {
		t.Fatal(err)
	}
}

// A notice that fails to send leaves the previous one in the chat: the
// new notice goes out before the old one is deleted (finding BOT-6). Refused
// outright, it uses up no quiet period, and the next message can notify at
// once. If it may have gone out (a server error, no answer), the short
// hold taken while sending runs out first, so no second notice follows
// at once that would never be recorded or deleted.
func TestNotifyFailedSendKeepsOldNotice(t *testing.T) {
	for _, tc := range []struct {
		name     string
		reply    string // to sendMessage; "" for no answer
		status   int
		mayHave  bool
		wantCode int
	}{
		{name: "refused", status: http.StatusBadRequest, reply: `{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}`, wantCode: 400},
		{name: "server error", status: http.StatusInternalServerError, reply: serverError, mayHave: true, wantCode: 500},
		{name: "no answer", mayHave: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tg := newTelegram(t)
			n, dir, clock, _ := notifier(t, tg)
			ctx := context.Background()
			if err := n.Notify(ctx, "acct"); err != nil {
				t.Fatal(err)
			}
			tg.seen()

			*clock = now.Add(Interval + time.Second)
			tg.answer(func(method string, _ int) (int, string) {
				if method == "sendMessage" {
					return tc.status, tc.reply
				}
				return 0, ""
			})
			bot := n.Bot
			if tc.reply == "" {
				n.Bot = botapi.Client{Token: "1:T", API: "http://127.0.0.1:1"} // nothing listens
			}
			var apiErr *botapi.Error
			if err := n.Notify(ctx, "acct"); !errors.As(err, &apiErr) || apiErr.Code != tc.wantCode {
				t.Fatalf("failed send: %v", err)
			}
			n.Bot = bot
			calls, _ := tg.seen()
			if want := map[bool]int{true: 1, false: 0}[tc.reply != ""]; len(calls) != want || slices.Contains(calls, "deleteMessage") || !slices.Equal(dir.sent, []int64{10}) {
				t.Fatalf("after a failed send: calls %v, sent %v", calls, dir.sent)
			}

			tg.answer(nil)
			if tc.mayHave {
				// The next message, right away, brings nothing; once the
				// hold ran out, it brings the notice.
				if err := n.Notify(ctx, "acct"); err != nil {
					t.Fatal(err)
				}
				if calls, _ := tg.seen(); len(calls) != 0 {
					t.Fatalf("a second notice right after one that may have gone out: %v", calls)
				}
				*clock = clock.Add(Lease + time.Second)
			}
			// The next message brings the notice, which replaces the one
			// still there.
			if err := n.Notify(ctx, "acct"); err != nil {
				t.Fatal(err)
			}
			calls, bodies := tg.seen()
			if !slices.Equal(calls, []string{"sendMessage", "deleteMessage"}) || bodies[1]["message_id"] != float64(10) || len(dir.sent) != 2 {
				t.Fatalf("the next notice: %v %v, sent %v", calls, bodies, dir.sent)
			}
		})
	}
}

// Telegram's flood control: a short wait is taken, once; a long one, a
// second refusal, or a wait the invocation has no time for gives up and
// keeps the previous notice (findings BOT-3, SCL-7). Then the account
// waits as long as Telegram asked, at least FloodQuiet, and the instance
// tries no notice to anyone, without calling Telegram, until Telegram
// allows.
func TestNotifyFloodControl(t *testing.T) {
	ctx := context.Background()
	t.Run("short wait", func(t *testing.T) {
		tg := newTelegram(t)
		n, dir, _, waits := notifier(t, tg)
		tg.answer(func(method string, i int) (int, string) {
			if method == "sendMessage" && i == 0 {
				return http.StatusTooManyRequests, flood(2)
			}
			return 0, ""
		})
		if err := n.Notify(ctx, "acct"); err != nil {
			t.Fatal(err)
		}
		if calls, _ := tg.seen(); !slices.Equal(calls, []string{"sendMessage", "sendMessage"}) || !slices.Equal(*waits, []time.Duration{2 * time.Second}) || len(dir.sent) != 1 {
			t.Fatalf("calls %v, waits %v, sent %v", calls, *waits, dir.sent)
		}
		// It went out: the quiet period holds.
		if err := n.Notify(ctx, "acct"); err != nil {
			t.Fatal(err)
		}
		if calls, _ := tg.seen(); len(calls) != 0 {
			t.Fatalf("inside the quiet period: %v", calls)
		}
	})
	for _, tc := range []struct {
		name    string
		replies []string // to sendMessage, in order
		budget  time.Duration
		calls   int
		waits   []time.Duration
		flood   time.Duration // how long the instance sends nothing
		quiet   time.Duration // how long the account waits
	}{
		{name: "refused again", replies: []string{flood(1), flood(1)}, calls: 2, waits: []time.Duration{time.Second}, flood: time.Second, quiet: FloodQuiet},
		{name: "long wait", replies: []string{flood(30)}, calls: 1, flood: 30 * time.Second, quiet: FloodQuiet},
		{name: "longer than a minute", replies: []string{flood(150)}, calls: 1, flood: 150 * time.Second, quiet: 150 * time.Second},
		{name: "wait without one", replies: []string{`{"ok":false,"error_code":429}`}, calls: 1, flood: time.Second, quiet: FloodQuiet},
		{name: "no time to wait", replies: []string{flood(3)}, budget: 4 * time.Second, calls: 1, flood: 3 * time.Second, quiet: FloodQuiet},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tg := newTelegram(t)
			n, dir, clock, waits := notifier(t, tg)
			if err := n.Notify(ctx, "acct"); err != nil {
				t.Fatal(err)
			}
			tg.seen()
			start := now.Add(Interval + time.Second)
			*clock = start
			tg.answer(func(method string, i int) (int, string) {
				if method == "sendMessage" && i < len(tc.replies) {
					return http.StatusTooManyRequests, tc.replies[i]
				}
				return 0, ""
			})
			c := ctx
			if tc.budget > 0 {
				var cancel context.CancelFunc
				c, cancel = context.WithTimeout(ctx, tc.budget)
				defer cancel()
			}
			if err := n.Notify(c, "acct"); !errors.Is(err, ErrRateLimited) {
				t.Fatalf("err = %v", err)
			}
			calls, _ := tg.seen()
			if len(calls) != tc.calls || slices.Contains(calls, "deleteMessage") || !slices.Equal(*waits, tc.waits) || !slices.Equal(dir.sent, []int64{10}) {
				t.Fatalf("calls %v, waits %v, sent %v", calls, *waits, dir.sent)
			}
			tg.answer(nil)
			starts := n.Quiet.(*memQuiet).starts

			// Until Telegram allows, no notice is tried, for any account:
			// no quiet period started, no call.
			*clock = start.Add(tc.flood - time.Millisecond)
			for _, account := range []string{"acct", "other"} {
				if err := n.Notify(ctx, account); !errors.Is(err, ErrRateLimited) {
					t.Fatalf("%s while flooded: %v", account, err)
				}
			}
			if calls, _ := tg.seen(); len(calls) != 0 || n.Quiet.(*memQuiet).starts != starts {
				t.Fatalf("tried while flooded: %v", calls)
			}
			// Then other accounts may get theirs; this one waits on.
			*clock = start.Add(tc.flood)
			if tc.quiet > tc.flood {
				if err := n.Notify(ctx, "acct"); err != nil {
					t.Fatal(err)
				}
				if calls, _ := tg.seen(); len(calls) != 0 {
					t.Fatalf("a notice inside the wait: %v", calls)
				}
			}
			if err := n.Notify(ctx, "other"); err != nil {
				t.Fatal(err)
			}
			if calls, _ := tg.seen(); !slices.Contains(calls, "sendMessage") {
				t.Fatalf("other account after the flood: %v", calls)
			}
			// Once the wait is over, the next message notifies.
			*clock = start.Add(tc.quiet)
			if err := n.Notify(ctx, "acct"); err != nil {
				t.Fatal(err)
			}
			if calls, _ := tg.seen(); !slices.Equal(calls, []string{"sendMessage", "deleteMessage"}) {
				t.Fatalf("next message: %v", calls)
			}
		})
	}
}

// The deploy's check makes the directory calls for an account that
// doesn't exist, and fails when one is refused.
func TestCheck(t *testing.T) {
	ctx := context.Background()
	dir := &memDirectory{}
	if err := (&Notifier{Directory: dir}).Check(ctx); err != nil {
		t.Fatal(err)
	}
	if err := (&Notifier{Directory: refusingDirectory{dir}}).Check(ctx); err == nil {
		t.Fatal("a refused call passed")
	}
	if err := (&Notifier{Directory: &memDirectory{found: true}}).Check(ctx); err == nil {
		t.Fatal("a new account with notices passed")
	}
}

type refusingDirectory struct{ *memDirectory }

func (refusingDirectory) NoticeSent(context.Context, string, int64) error {
	return errors.New("AccessDenied")
}

// Deliveries at once still send one notice, with the real quiet periods
// (a conditional write), and the period then holds past the hold taken
// while sending; a refused send ends the period there too, and flood
// control holds it as long as Telegram asked.
func TestNotifyOnceAtATime(t *testing.T) {
	client := dynamotest.Client(t)
	tg := newTelegram(t)
	n, dir, clock, _ := notifier(t, tg)
	n.Quiet = &ephemeral.Quiet{DB: client, Table: dynamotest.Table(t, client), Now: func() time.Time { return *clock }}
	ctx := context.Background()
	// Each send takes a while, so the others try while it's under way.
	tg.answer(func(method string, _ int) (int, string) {
		if method == "sendMessage" {
			time.Sleep(200 * time.Millisecond)
		}
		return 0, ""
	})

	var wg sync.WaitGroup
	errs := make([]error, 8)
	for i := range errs {
		wg.Go(func() { errs[i] = n.Notify(ctx, "acct") })
	}
	wg.Wait()
	if err := errors.Join(errs...); err != nil {
		t.Fatal(err)
	}
	if calls, _ := tg.seen(); !slices.Equal(calls, []string{"sendMessage"}) || len(dir.sent) != 1 {
		t.Fatalf("calls %v, sent %v", calls, dir.sent)
	}
	// Two minutes on, the hold taken while sending is over; the period isn't.
	quiet := func(at time.Time) {
		t.Helper()
		*clock = at
		if err := n.Notify(ctx, "acct"); err != nil {
			t.Fatal(err)
		}
		if calls, _ := tg.seen(); len(calls) != 0 {
			t.Fatalf("a notice inside the quiet period: %v", calls)
		}
	}
	quiet(now.Add(2 * time.Minute))
	// start notifies at a time, with Telegram answering status and reply
	// to the send (a success if reply is "").
	start := func(at time.Time, status int, reply string) error {
		t.Helper()
		*clock = at
		tg.answer(func(method string, _ int) (int, string) {
			if method == "sendMessage" {
				return status, reply
			}
			return 0, ""
		})
		defer tg.answer(nil)
		return n.Notify(ctx, "acct")
	}

	// After the interval, a refused send ends the period it started: the
	// next message, right away, notifies.
	at := now.Add(Interval + time.Minute)
	if err := start(at, http.StatusBadRequest, `{"ok":false,"error_code":400,"description":"Bad Request"}`); err == nil {
		t.Fatal("a refused send succeeded")
	}
	if err := start(at, 0, ""); err != nil {
		t.Fatal(err)
	}
	if calls, _ := tg.seen(); !slices.Equal(calls, []string{"sendMessage", "sendMessage", "deleteMessage"}) || len(dir.sent) != 2 {
		t.Fatalf("calls %v, sent %v", calls, dir.sent)
	}
	quiet(at.Add(2 * time.Minute))

	// Flood control holds it for as long as Telegram asked (here 90 s,
	// rounded up to the minute), and no longer.
	at = at.Add(Interval + time.Minute)
	if err := start(at, http.StatusTooManyRequests, flood(90)); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("err = %v", err)
	}
	tg.seen()
	quiet(at.Add(90 * time.Second))
	if err := start(at.Add(2*time.Minute), 0, ""); err != nil {
		t.Fatal(err)
	}
	if calls, _ := tg.seen(); !slices.Equal(calls, []string{"sendMessage", "deleteMessage"}) || len(dir.sent) != 3 {
		t.Fatalf("calls %v, sent %v", calls, dir.sent)
	}
}

func TestLanguage(t *testing.T) {
	for code, want := range map[string]string{"fa": "fa", "fa-IR": "fa", "en": "en", "de": "en", "": "en"} {
		if Language(code) != want {
			t.Errorf("Language(%q) = %q", code, Language(code))
		}
	}
}
