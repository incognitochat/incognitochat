package botapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/logx"
)

func TestCall(t *testing.T) {
	limited := `{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 3","parameters":{"retry_after":3}}`
	telegram := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/sendMessage"):
			_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":42}}`))
		case strings.HasSuffix(r.URL.Path, "/sendLimited"):
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(limited))
		default:
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}`))
		}
	}))
	defer telegram.Close()
	c := Client{Token: "123:SECRET-TOKEN", API: telegram.URL}

	var sent struct {
		MessageID int64 `json:"message_id"`
	}
	if err := c.Call(context.Background(), "sendMessage", map[string]any{"chat_id": 1}, &sent); err != nil || sent.MessageID != 42 {
		t.Fatalf("sendMessage = %+v, %v", sent, err)
	}
	err := c.Call(context.Background(), "deleteMessage", map[string]any{}, nil)
	var apiErr *Error
	if !errors.As(err, &apiErr) || !apiErr.Forbidden() || strings.Contains(err.Error(), "SECRET-TOKEN") {
		t.Fatalf("err = %v", err)
	}
	// A refusal by flood control keeps how long to wait.
	err = c.Call(context.Background(), "sendLimited", map[string]any{}, nil)
	if !errors.As(err, &apiErr) || !apiErr.TooManyRequests() || apiErr.Forbidden() || apiErr.RetryAfter != 3*time.Second {
		t.Fatalf("429: %+v", apiErr)
	}
	// One without a wait, or with a strange one, says 0 or at most a day.
	for body, want := range map[string]time.Duration{
		`{"ok":false,"error_code":429}`:                                                  0,
		`{"ok":false,"error_code":429,"parameters":{"retry_after":-5}}`:                  0,
		`{"ok":false,"error_code":429,"parameters":{"retry_after":9223372036854775807}}`: 24 * time.Hour,
	} {
		limited = body
		if err := c.Call(context.Background(), "sendLimited", map[string]any{}, nil); !errors.As(err, &apiErr) || apiErr.RetryAfter != want {
			t.Errorf("%s: %+v", body, apiErr)
		}
	}
	// A transport failure doesn't leak the URL either.
	err = Client{Token: "123:SECRET-TOKEN", API: "http://127.0.0.1:1"}.Call(context.Background(), "getMe", nil, nil)
	if err == nil || strings.Contains(err.Error(), "SECRET-TOKEN") {
		t.Fatalf("err = %v", err)
	}
}

// A failed call is logged by its method, HTTP status and Telegram's error
// code, and nothing else of the call or the answer (BOT-8).
func TestErrorLogged(t *testing.T) {
	telegram := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}`))
	}))
	defer telegram.Close()
	var buf bytes.Buffer
	log := logx.New(&buf, "notify")
	err := Client{Token: "123:SECRET-TOKEN", API: telegram.URL}.Call(context.Background(), "sendMessage", map[string]any{"chat_id": 4242}, nil)
	log.Warn("notify failed", logx.ErrorKind(err))
	// No answer: the method alone.
	err = Client{Token: "123:SECRET-TOKEN", API: "http://127.0.0.1:1"}.Call(context.Background(), "getMe", nil, nil)
	log.Warn("notify failed", logx.ErrorKind(err))

	var lines []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatal(err)
		}
		lines = append(lines, m)
	}
	want := []map[string]any{
		{"fn": "notify", "msg": "notify failed", "error_kind": "*botapi.Error", "method": "sendMessage", "status": float64(403), "error_code": float64(403)},
		{"fn": "notify", "msg": "notify failed", "error_kind": "*botapi.Error", "method": "getMe"},
	}
	for i, line := range lines {
		delete(line, "time")
		delete(line, "level")
		if !maps.Equal(line, want[i]) {
			t.Errorf("line %d = %v, want %v", i, line, want[i])
		}
	}
	if len(lines) != len(want) {
		t.Fatalf("%d lines: %s", len(lines), buf.String())
	}
}
