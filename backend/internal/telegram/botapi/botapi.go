// Package botapi calls Telegram's Bot API. Errors never include the request
// URL, which contains the bot token.
package botapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/logx"
)

// DefaultAPI is Telegram's Bot API.
const DefaultAPI = "https://api.telegram.org"

// Client calls the Bot API with one bot's token.
type Client struct {
	Token string
	API   string       // DefaultAPI unless testing
	HTTP  *http.Client // nil for a client with a timeout
}

// maxRetryAfter bounds the wait taken from Telegram's answer (a day), so a
// strange value can't overflow.
const maxRetryAfter = 24 * time.Hour

// Error is a failed call: the method, the HTTP status and Telegram's error code.
type Error struct {
	Method string
	Status int
	Code   int
	// RetryAfter is how long Telegram's flood control asks to wait before
	// the call is made again (error 429); 0 if it didn't say.
	RetryAfter time.Duration
}

func (e *Error) Error() string {
	return fmt.Sprintf("botapi: %s failed (HTTP %d)", e.Method, e.Status)
}

// LogAttrs describes the failure for the logs (logx.Detailed): the method,
// and the HTTP status and Telegram's error code when there was an answer
// that gave them. Never the description, the chat or the token.
func (e *Error) LogAttrs() []slog.Attr {
	attrs := []slog.Attr{slog.String(logx.KeyMethod, e.Method)}
	if e.Status != 0 {
		attrs = append(attrs, slog.Int(logx.KeyStatus, e.Status))
	}
	if e.Code != 0 {
		attrs = append(attrs, slog.Int(logx.KeyErrorCode, e.Code))
	}
	return attrs
}

// Forbidden reports whether the bot may not write to the chat (blocked by
// the user, or never allowed to write).
func (e *Error) Forbidden() bool { return e.Code == http.StatusForbidden }

// TooManyRequests reports whether Telegram's flood control refused the call
// (about 30 messages a second per bot, and one a second per chat).
// RetryAfter says how long to wait.
func (e *Error) TooManyRequests() bool { return e.Code == http.StatusTooManyRequests }

// Call runs a method and decodes its result into result (which may be nil).
func (c Client) Call(ctx context.Context, method string, params any, result any) error {
	body, err := json.Marshal(params)
	if err != nil {
		return err
	}
	api := c.API
	if api == "" {
		api = DefaultAPI
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, api+"/bot"+c.Token+"/"+method, bytes.NewReader(body))
	if err != nil {
		return &Error{Method: method}
	}
	req.Header.Set("Content-Type", "application/json")
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return &Error{Method: method}
	}
	defer resp.Body.Close()
	var out struct {
		OK         bool            `json:"ok"`
		ErrorCode  int             `json:"error_code"`
		Result     json.RawMessage `json:"result"`
		Parameters struct {
			RetryAfter int64 `json:"retry_after"` // seconds
		} `json:"parameters"`
	}
	if json.NewDecoder(resp.Body).Decode(&out) != nil || !out.OK {
		e := &Error{Method: method, Status: resp.StatusCode, Code: out.ErrorCode}
		if ra := out.Parameters.RetryAfter; ra > 0 {
			e.RetryAfter = time.Duration(min(ra, int64(maxRetryAfter/time.Second))) * time.Second
		}
		return e
	}
	if result != nil {
		if err := json.Unmarshal(out.Result, result); err != nil {
			return &Error{Method: method, Status: resp.StatusCode}
		}
	}
	return nil
}
