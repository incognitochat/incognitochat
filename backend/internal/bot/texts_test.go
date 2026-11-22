package bot

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/i18n"
)

// fakeTexts is the Bot API's side of the bot's texts: what each get answers
// and each set keeps, by method and language_code ("" for the default).
type fakeTexts struct {
	mu      sync.Mutex
	stored  map[string]any
	calls   []string
	bodies  map[string]map[string]any // the last set's body, by method and language_code
	delay   time.Duration
	refuse  string // a set method refused with 429
	started atomic.Int32
}

func newFakeTexts() *fakeTexts {
	return &fakeTexts{stored: map[string]any{}, bodies: map[string]map[string]any{}}
}

func (f *fakeTexts) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.started.Add(1)
	method := r.URL.Path[strings.LastIndexByte(r.URL.Path, '/')+1:]
	raw, _ := io.ReadAll(r.Body)
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	lang, _ := body["language_code"].(string)
	// A refusal comes at once; anything else takes the delay.
	if method != f.refuse || lang != "" {
		time.Sleep(f.delay)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, method+" "+lang)
	key := strings.TrimPrefix(strings.TrimPrefix(method, "get"), "set") + " " + lang
	var result any
	switch {
	case method == f.refuse && lang == "":
		_, _ = w.Write([]byte(`{"ok":false,"error_code":429,"description":"Too Many Requests","parameters":{"retry_after":3}}`))
		return
	case strings.HasPrefix(method, "set"):
		f.bodies[method+" "+lang] = body
		switch method {
		case "setMyCommands":
			f.stored[key] = body["commands"]
		case "setMyDescription":
			f.stored[key] = map[string]any{"description": body["description"]}
		case "setMyShortDescription":
			f.stored[key] = map[string]any{"short_description": body["short_description"]}
		}
		result = true
	default:
		result = f.stored[key]
		if result == nil {
			result = map[string]any{"getMyCommands": []any{}, "getMyDescription": map[string]any{"description": ""}, "getMyShortDescription": map[string]any{"short_description": ""}}[method]
		}
	}
	out, _ := json.Marshal(map[string]any{"ok": true, "result": result})
	_, _ = w.Write(out)
}

func (f *fakeTexts) count(prefix string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

// languages returns n made-up languages: English as the default, then
// others with two-letter codes.
func languages(n int) []i18n.Language {
	out := []i18n.Language{{Code: "en", Tags: []string{"en"}, Texts: i18n.Texts{Command: "Open", Description: "About", About: "Short"}}}
	for i := 1; i < n; i++ {
		code := fmt.Sprintf("%c%c", 'a'+i/26, 'a'+i%26)
		out = append(out, i18n.Language{Code: code, BotCode: code, Tags: []string{code}, Texts: i18n.Texts{Command: "Open " + code, Description: "About " + code, About: "Short " + code}})
	}
	return out
}

func TestSetTexts(t *testing.T) {
	f := newFakeTexts()
	f.delay = 200 * time.Millisecond
	telegram := httptest.NewServer(f)
	defer telegram.Close()
	s := Setup{Token: "1:T", API: telegram.URL}
	langs := languages(9)

	// Within the step's time, as the deploy runs it.
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	start := time.Now()
	report := s.SetTexts(ctx, langs)
	if want := (TextsReport{OK: true, Set: 27}); report != want {
		t.Fatalf("first run: %+v", report)
	}
	if took := time.Since(start); took > 4*time.Second {
		t.Fatalf("took %v", took)
	}
	// English is the default: no language_code.
	if body := f.bodies["setMyDescription "]; body["description"] != "About" || body["language_code"] != nil {
		t.Fatalf("default description: %v", body)
	}
	if body := f.bodies["setMyShortDescription ab"]; body["short_description"] != "Short ab" || body["language_code"] != "ab" {
		t.Fatalf("short description: %v", body)
	}

	// Nothing changed: reads only.
	sets := f.count("set")
	if report := s.SetTexts(context.Background(), langs); report != (TextsReport{OK: true, Unchanged: 27}) || f.count("set") != sets {
		t.Fatalf("second run: %+v, %d sets", report, f.count("set")-sets)
	}

	// One text changed (spaces at either end don't count): only it is set.
	langs[3].Texts.About += " now"
	langs[4].Texts.Command = "  " + langs[4].Texts.Command + " "
	if report := s.SetTexts(context.Background(), langs); report != (TextsReport{OK: true, Set: 1, Unchanged: 26}) {
		t.Fatalf("one change: %+v", report)
	}
}

// Telegram's flood control refuses a call: no more calls start, those
// running set nothing, and the report says so, as the deploy's output, not
// an error, with the first error kept for the log.
func TestSetTextsStopsAtAnError(t *testing.T) {
	f := newFakeTexts()
	f.refuse = "getMyCommands"
	f.delay = 50 * time.Millisecond
	telegram := httptest.NewServer(f)
	defer telegram.Close()
	report := Setup{Token: "1:T", API: telegram.URL}.SetTexts(context.Background(), languages(9))
	if report.OK || report.Set != 0 || report.Failed+report.Unchanged != 27 || report.Err == nil {
		t.Fatalf("report: %+v", report)
	}
	// Only the first few reads, which started together; no set.
	if started := int(f.started.Load()); started > textsParallel || f.count("set") != 0 {
		t.Fatalf("kept calling: %d calls, %d sets", started, f.count("set"))
	}
}

// The /start commands are set as the webhook setup set them before they
// moved here: the same bodies, English as the default, Persian under "fa".
func TestSetTextsCommandsAsBefore(t *testing.T) {
	f := newFakeTexts()
	telegram := httptest.NewServer(f)
	defer telegram.Close()
	if report := (Setup{Token: "1:T", API: telegram.URL}).SetTexts(context.Background(), i18n.Languages()); !report.OK {
		t.Fatalf("report: %+v", report)
	}
	want := map[string]map[string]any{
		"setMyCommands ":   {"commands": []any{map[string]any{"command": "start", "description": "Open Incognito Chat"}}},
		"setMyCommands fa": {"commands": []any{map[string]any{"command": "start", "description": "باز کردن چت ناشناس"}}, "language_code": "fa"},
	}
	for key, body := range want {
		if !reflect.DeepEqual(f.bodies[key], body) {
			t.Errorf("%s: %v", key, f.bodies[key])
		}
	}
}

// A run cut off by the step's deadline reports what it couldn't do.
func TestSetTextsDeadline(t *testing.T) {
	f := newFakeTexts()
	f.delay = 300 * time.Millisecond
	telegram := httptest.NewServer(f)
	defer telegram.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	report := Setup{Token: "1:T", API: telegram.URL}.SetTexts(ctx, languages(9))
	if report.OK || report.Failed == 0 || report.Set+report.Unchanged+report.Failed != 27 {
		t.Fatalf("report: %+v", report)
	}
}
