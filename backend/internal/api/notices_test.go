package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/telegram/initdata/initdatatest"
)

type memNotices struct {
	fail error
}

func (m *memNotices) Seal(_ context.Context, chat int64) ([]byte, error) {
	if m.fail != nil {
		return nil, m.fail
	}
	return []byte("sealed:" + strconv.FormatInt(chat, 10)), nil
}

// launchIn signs launch data with a language, as Telegram does.
func launchIn(user int64, startParam, language string, h *harness) string {
	fields := map[string]string{
		"auth_date": strconv.FormatInt(h.now.Unix(), 10),
		"user":      `{"id":` + strconv.FormatInt(user, 10) + `,"first_name":"A","language_code":"` + language + `","allows_write_to_pm":true}`,
	}
	if startParam != "" {
		fields["start_param"] = startParam
	}
	return initdatatest.Sign(botID, fields)
}

func TestSetNotices(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	n := &memNotices{}
	h.server.Notices = n
	m := h.account(t, userID)

	if _, out := h.as(t, m, http.MethodGet, "/account", nil, false); out["notices"] != false {
		t.Fatalf("before: %v", out)
	}
	status, out := h.as(t, m, http.MethodPost, "/notices", map[string]any{"initData": launchIn(userID, "", "fa-IR", h)}, false)
	if status != http.StatusOK {
		t.Fatalf("notices: %d %v", status, out)
	}
	a := h.dir.accounts[h.dir.telegram[directory.TelegramHash(h.server.Pepper, userID)]]
	if string(a.chat) != "sealed:"+strconv.FormatInt(userID, 10) || a.language != "fa" {
		t.Fatalf("stored %q %q", a.chat, a.language)
	}
	if _, out := h.as(t, m, http.MethodGet, "/account", nil, false); out["notices"] != true {
		t.Fatalf("after: %v", out)
	}
	// A registration launch works too.
	if status, out := h.as(t, m, http.MethodPost, "/notices", map[string]any{"initData": launchIn(userID, "reg"+"abc", "en", h)}, false); status != http.StatusOK {
		t.Fatalf("registration launch: %d %v", status, out)
	}
}

func TestSetNoticesRejects(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	n := &memNotices{}
	h.server.Notices = n
	m := h.account(t, userID)
	try := func(initData string) (int, map[string]any) {
		return h.as(t, m, http.MethodPost, "/notices", map[string]any{"initData": initData}, false)
	}

	// Launches that name a link or an invitation, or another user, or nothing.
	for _, bad := range []string{
		launchIn(userID, "1"+ids.New()[:11]+"x", "en", h),
		launchIn(userID, "invABCDEFGH", "en", h),
		launchIn(userID+1, "", "en", h),
		"auth_date=1&user=%7B%22id%22%3A1%7D&hash=00",
	} {
		status, out := try(bad)
		wantError(t, status, out, http.StatusUnauthorized, "init_data_rejected")
	}
	status, out := try("")
	wantError(t, status, out, http.StatusBadRequest, "bad_request")
	// Without a login.
	status, out = h.call(t, nil, "", http.MethodPost, "/notices", map[string]any{"initData": launchIn(userID, "", "en", h)}, false)
	wantError(t, status, out, http.StatusUnauthorized, "session_expired")

	// Rate limited.
	for range NoticeSetupsPerDay {
		try(launchIn(userID, "", "en", h))
	}
	status, out = try(launchIn(userID, "", "en", h))
	wantError(t, status, out, http.StatusTooManyRequests, "rate_limited")

	// Notices not configured on this server.
	h.server.Notices = nil
	status, out = try(launchIn(userID, "", "en", h))
	wantError(t, status, out, http.StatusNotFound, "not_found")
}

type pushed struct {
	account string
	quiet   bool
}

type memPush struct {
	mu     sync.Mutex
	pushed []pushed
	fail   error
}

func (m *memPush) Push(_ context.Context, account string, quiet bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pushed = append(m.pushed, pushed{account, quiet})
	return m.fail
}

func (m *memPush) last() pushed {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.pushed[len(m.pushed)-1]
}

// Every send is handed to ws once, quiet or not, for the owner, and for
// nobody when the mailbox doesn't exist: ws pushes, and asks for the notice.
func TestSendHandsPushToWs(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	p := &memPush{}
	h.server.Push = p
	owner := h.account(t, userID)
	_, out := h.as(t, owner, http.MethodPost, "/mailboxes", map[string]any{"count": 2}, false)
	mailbox := out["mailboxes"].([]any)[0].(string)
	discarded := out["mailboxes"].([]any)[1].(string)
	h.as(t, owner, http.MethodPost, "/mailboxes/"+discarded+"/discard", nil, false)
	env := clientEnvelope(t)
	send := func(mb string, quiet bool) pushed {
		t.Helper()
		before := len(p.pushed)
		if status, out := h.post(t, "/send", map[string]any{"mailbox": mb, "envelope": env, "token": mintToken(t, h.now), "quiet": quiet}); status != http.StatusOK {
			t.Fatalf("send: %d %v", status, out)
		}
		if len(p.pushed) != before+1 {
			t.Fatalf("handed to ws %d times", len(p.pushed)-before)
		}
		return p.last()
	}

	if got := send(mailbox, false); !ids.Valid(got.account) || got.quiet {
		t.Fatalf("a message: %+v", got)
	}
	account := p.last().account
	// Receipts are pushed too, and marked quiet: ws never asks for a notice.
	if got := send(mailbox, true); got != (pushed{account, true}) {
		t.Fatalf("a receipt: %+v", got)
	}
	// Mailboxes that don't exist, or ended, make the same request, for nobody.
	for _, mb := range []string{ids.New(), discarded} {
		if got := send(mb, false); got != (pushed{}) {
			t.Fatalf("no mailbox: %+v", got)
		}
	}
	// A failing request doesn't fail the send, and is logged without details.
	p.fail = errors.New("boom " + account)
	send(mailbox, false)
	if !strings.Contains(h.logs.String(), "push request failed") || strings.Contains(h.logs.String(), account) {
		t.Fatalf("logs: %s", h.logs.String())
	}
}
