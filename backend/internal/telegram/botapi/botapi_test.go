package botapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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
