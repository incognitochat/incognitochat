package api

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
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

// On the real tables (PRV-5): what notices need is kept only while they're
// on. Once Telegram refused one and notify marked them off, the next
// GET /account says they're off, and refused, and removes the sealed chat
// ID, the language and the last notice's ID. Set up again (POST /notices,
// after the user's tap), they're stored anew, as at first. Off because the
// chat ID no longer opens (a new chat key), they're forgotten the same
// way, but not refused: the app sets them up again by itself.
func TestAccountForgetsNoticesOnceOff(t *testing.T) {
	client := dynamotest.Client(t)
	store := &directory.Store{DB: client, Table: dynamotest.Table(t, client)}
	h := newHarness(t)
	h.server.InviteOnly = false
	h.server.Notices = &memNotices{}
	h.server.Directory = store
	h.router = httpapi.NewRouter()
	h.server.Routes(h.router)
	m := h.account(t, userID)
	ctx := context.Background()
	turnOn := func() {
		t.Helper()
		if status, out := h.as(t, m, http.MethodPost, "/notices", map[string]any{"initData": launchIn(userID, "", "fa", h)}, false); status != http.StatusOK {
			t.Fatalf("notices: %d %v", status, out)
		}
	}
	// notices is what GET /account says: "on", "off", or "refused".
	notices := func() string {
		t.Helper()
		status, out := h.as(t, m, http.MethodGet, "/account", nil, false)
		if status != http.StatusOK {
			t.Fatalf("account: %d %v", status, out)
		}
		switch {
		case out["notices"] == true && out["noticesRefused"] == false:
			return "on"
		case out["notices"] == false && out["noticesRefused"] == false:
			return "off"
		case out["notices"] == false && out["noticesRefused"] == true:
			return "refused"
		}
		t.Fatalf("account: %v", out)
		return ""
	}
	stored := func() []string {
		t.Helper()
		out, err := client.GetItem(ctx, &dynamodb.GetItemInput{
			TableName:      &store.Table,
			Key:            map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: "A#" + m.d.account}, "sk": &types.AttributeValueMemberS{Value: "A"}},
			ConsistentRead: aws.Bool(true),
		})
		if err != nil {
			t.Fatal(err)
		}
		var have []string
		for _, f := range []string{"cid", "lg", "nm", "no"} {
			if _, ok := out.Item[f]; ok {
				have = append(have, f)
			}
		}
		return have
	}

	if got := notices(); got != "off" {
		t.Fatalf("before setting up: %s", got)
	}
	turnOn()
	if err := store.NoticeSent(ctx, m.d.account, 42); err != nil {
		t.Fatal(err)
	}
	if got := notices(); got != "on" || !slices.Equal(stored(), []string{"cid", "lg", "nm"}) {
		t.Fatalf("on: %s %v", got, stored())
	}
	// Telegram refuses a notice (the user blocked the bot): notify marks
	// them off, and may write nothing else.
	if err := store.NoticesOff(ctx, m.d.account); err != nil {
		t.Fatal(err)
	}
	if got := notices(); got != "refused" || !slices.Equal(stored(), []string{"no"}) {
		t.Fatalf("refused, after GET /account: %s %v", got, stored())
	}
	if _, err := store.Notices(ctx, m.d.account); !errors.Is(err, directory.ErrNotFound) {
		t.Fatalf("notify still finds a chat: %v", err)
	}
	// Still refused at the next look, until they're set up again.
	if got := notices(); got != "refused" {
		t.Fatalf("refused, later: %s", got)
	}
	turnOn()
	if got := notices(); got != "on" || !slices.Equal(stored(), []string{"cid", "lg"}) {
		t.Fatalf("on again: %s %v", got, stored())
	}
	if n, err := store.Notices(ctx, m.d.account); err != nil || string(n.SealedChat) != "sealed:"+strconv.FormatInt(userID, 10) || n.Language != "fa" || n.Off {
		t.Fatalf("on again: %+v, %v", n, err)
	}
	// A chat ID that no longer opens: forgotten too, but not refused.
	if err := store.NoticesStale(ctx, m.d.account); err != nil {
		t.Fatal(err)
	}
	if got := notices(); got != "off" || !slices.Equal(stored(), []string{"no"}) {
		t.Fatalf("stale, after GET /account: %s %v", got, stored())
	}
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

func TestSetNoticeLanguage(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	h.server.Notices = &memNotices{}
	m := h.account(t, userID)
	a := h.dir.accounts[h.dir.telegram[directory.TelegramHash(h.server.Pepper, userID)]]
	change := func(language string) (int, map[string]any) {
		return h.as(t, m, http.MethodPost, "/notices/language", map[string]any{"initData": launchIn(userID, "", language, h)}, false)
	}

	// Off: nothing to change, and the account says no language.
	if _, out := h.as(t, m, http.MethodGet, "/account", nil, false); out["noticeLanguage"] != nil {
		t.Fatalf("off: %v", out)
	}
	status, out := change("fa")
	wantError(t, status, out, http.StatusConflict, "notices_off")
	if a.chat != nil || a.language != "" {
		t.Fatalf("changed notices that were never set up: %q %q", a.chat, a.language)
	}

	if status, out := h.as(t, m, http.MethodPost, "/notices", map[string]any{"initData": launchIn(userID, "", "en", h)}, false); status != http.StatusOK {
		t.Fatalf("notices: %d %v", status, out)
	}
	if _, out := h.as(t, m, http.MethodGet, "/account", nil, false); out["noticeLanguage"] != "en" {
		t.Fatalf("on: %v", out)
	}
	if status, out := change("fa-IR"); status != http.StatusOK {
		t.Fatalf("change: %d %v", status, out)
	}
	if a.language != "fa" || string(a.chat) != "sealed:"+strconv.FormatInt(userID, 10) || a.noticesOff {
		t.Fatalf("stored %q %q %v", a.chat, a.language, a.noticesOff)
	}
	if _, out := h.as(t, m, http.MethodGet, "/account", nil, false); out["noticeLanguage"] != "fa" || out["notices"] != true {
		t.Fatalf("after: %v", out)
	}

	// Nothing to change is done at once, and isn't counted: no language in
	// the launch data (never read as English), or the same language.
	for range NoticeLanguageChangesPerDay + 1 {
		for _, same := range []string{"", "fa", "FA_ir"} {
			if status, out := change(same); status != http.StatusOK || a.language != "fa" {
				t.Fatalf("%q: %d %v, stored %q", same, status, out, a.language)
			}
		}
	}

	// Changes are rate limited.
	languages := []string{"en", "fa"}
	for i := range NoticeLanguageChangesPerDay - 1 {
		if status, out := change(languages[i%2]); status != http.StatusOK {
			t.Fatalf("change %d: %d %v", i, status, out)
		}
	}
	before := a.language
	status, out = change(map[string]string{"en": "fa", "fa": "en"}[before])
	wantError(t, status, out, http.StatusTooManyRequests, "rate_limited")
	if a.language != before {
		t.Fatalf("changed while rate limited: %q", a.language)
	}
}

func TestSetNoticeLanguageLeavesRefusedNoticesOff(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	h.server.Notices = &memNotices{}
	m := h.account(t, userID)
	a := h.dir.accounts[h.dir.telegram[directory.TelegramHash(h.server.Pepper, userID)]]
	if status, out := h.as(t, m, http.MethodPost, "/notices", map[string]any{"initData": launchIn(userID, "", "en", h)}, false); status != http.StatusOK {
		t.Fatalf("notices: %d %v", status, out)
	}
	// Telegram refused a notice (the user blocked the bot): a block holds.
	a.noticesOff = true
	status, out := h.as(t, m, http.MethodPost, "/notices/language", map[string]any{"initData": launchIn(userID, "", "fa", h)}, false)
	wantError(t, status, out, http.StatusConflict, "notices_off")
	if !a.noticesOff || a.language != "en" {
		t.Fatalf("refused notices changed: off %v, language %q", a.noticesOff, a.language)
	}
}

func TestSetNoticeLanguageRejects(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	h.server.Notices = &memNotices{}
	m := h.account(t, userID)
	if status, out := h.as(t, m, http.MethodPost, "/notices", map[string]any{"initData": launchIn(userID, "", "en", h)}, false); status != http.StatusOK {
		t.Fatalf("notices: %d %v", status, out)
	}
	a := h.dir.accounts[h.dir.telegram[directory.TelegramHash(h.server.Pepper, userID)]]
	try := func(initData string) (int, map[string]any) {
		return h.as(t, m, http.MethodPost, "/notices/language", map[string]any{"initData": initData}, false)
	}
	// Launches that name a link or an invitation (they'd tell the server
	// whose link was opened), another user's, or bad data.
	for _, bad := range []string{
		launchIn(userID, "1"+ids.New()[:11]+"x", "fa", h),
		launchIn(userID, "invABCDEFGH", "fa", h),
		launchIn(userID+1, "", "fa", h),
		"auth_date=1&user=%7B%22id%22%3A1%7D&hash=00",
	} {
		status, out := try(bad)
		wantError(t, status, out, http.StatusUnauthorized, "init_data_rejected")
	}
	status, out := try("")
	wantError(t, status, out, http.StatusBadRequest, "bad_request")
	status, out = h.call(t, nil, "", http.MethodPost, "/notices/language", map[string]any{"initData": launchIn(userID, "", "fa", h)}, false)
	wantError(t, status, out, http.StatusUnauthorized, "session_expired")
	h.server.Notices = nil
	status, out = try(launchIn(userID, "", "fa", h))
	wantError(t, status, out, http.StatusNotFound, "not_found")
	if a.language != "en" {
		t.Fatalf("a rejected request changed the language: %q", a.language)
	}
}
