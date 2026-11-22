// Package logx is the only way the backend logs.
//
// It writes JSON at warning level and above, and drops every attribute that
// isn't on a short allow-list (and every group but the count groups, which
// hold integers only), so identifiers, IP addresses and request data can't
// end up in the logs by mistake. Messages must be constant strings: never
// format values into them.
package logx

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
)

// Allowed attribute keys. Values must never identify a person, device,
// account, link, mailbox or request.
const (
	KeyFunction       = "fn"          // which Lambda function
	KeyRoute          = "route"       // route pattern, e.g. "POST /session"
	KeyStatus         = "status"      // HTTP status returned
	KeyErrorKind      = "error_kind"  // Go type of an error, never its message
	KeyDuration       = "duration_ms" // how long something took
	KeyCount          = "count"       // how many items were involved
	KeyMethod         = "method"      // Bot API method called, e.g. "sendMessage"
	KeyTelegramStatus = "tg_status"   // HTTP status of Telegram's answer to a failed Bot API call
	KeyErrorCode      = "error_code"  // Telegram's error_code for a failed Bot API call
	KeyPanicAt        = "panic_at"    // where a recovered panic happened: function and line
	KeyMessages       = "messages"    // messages sent in a minute (internal/tally), a count
	KeyMediaBytes     = "media_bytes" // padded bytes of uploads paid for in a minute (internal/tally), a sum
)

var allowed = map[string]bool{
	KeyFunction: true, KeyRoute: true, KeyStatus: true,
	KeyErrorKind: true, KeyDuration: true, KeyCount: true,
	KeyMethod: true, KeyTelegramStatus: true, KeyErrorCode: true, KeyPanicAt: true,
	KeyMessages: true, KeyMediaBytes: true,
}

// Allowed groups, of counts only (internal/tally writes them). Each member
// is an integer, named in lower case letters, digits and "_", starting with
// a letter, by the server's own route patterns, statuses and error codes,
// never by anything from a request.
const (
	// Answers by route and status: at most 64 characters, ending in "_"
	// and an HTTP status, e.g. "post_send_429".
	KeyRoutes = "routes"
	// Answers by error code: at most 40 characters, e.g. "rate_limited".
	KeyErrors = "errors"
)

// New returns a logger for one function writing to w.
func New(w io.Writer, function string) *slog.Logger {
	h := slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level: slog.LevelWarn,
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			if len(groups) > 0 {
				if len(groups) == 1 && isCount(groups[0], a) {
					return a
				}
				return slog.Attr{}
			}
			switch a.Key {
			case slog.TimeKey, slog.LevelKey, slog.MessageKey:
				return a
			}
			if !allowed[a.Key] {
				return slog.Attr{}
			}
			if a.Value.Kind() == slog.KindString && len(a.Value.String()) > 100 {
				a.Value = slog.StringValue(a.Value.String()[:100])
			}
			return a
		},
	})
	return slog.New(h).With(slog.String(KeyFunction, function))
}

// isCount is whether a may be a member of the count group named group.
func isCount(group string, a slog.Attr) bool {
	if k := a.Value.Kind(); k != slog.KindInt64 && k != slog.KindUint64 {
		return false
	}
	name := a.Key
	switch group {
	case KeyRoutes:
		// "_" and a status from 100 to 599 at the end.
		n := len(name)
		if n > 64 || n < 5 || name[n-4] != '_' || name[n-3] < '1' || name[n-3] > '5' ||
			!isDigit(name[n-2]) || !isDigit(name[n-1]) {
			return false
		}
	case KeyErrors:
		if len(name) > 40 {
			return false
		}
	default:
		return false
	}
	if name == "" || name[0] < 'a' || name[0] > 'z' {
		return false
	}
	for _, c := range []byte(name) {
		if (c < 'a' || c > 'z') && !isDigit(c) && c != '_' {
			return false
		}
	}
	return true
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// ErrorKind describes an error by its Go type, never its message: error
// messages can carry keys or values from the request. If the error, or one
// it wraps, is Detailed, its details are added.
func ErrorKind(err error) slog.Attr {
	if err == nil {
		return slog.Attr{}
	}
	kind := slog.String(KeyErrorKind, fmt.Sprintf("%T", err))
	var d Detailed
	if !errors.As(err, &d) {
		return kind
	}
	// A group without a key: its attributes are logged at the top level,
	// each kept only if it is on the allow-list.
	return slog.Attr{Value: slog.GroupValue(append([]slog.Attr{kind}, d.LogAttrs()...)...)}
}

// Detailed is an error that can say more about itself than its type, under
// the keys above, with values from the code or from the service that
// answered, never from a request: a failed Bot API call gives its method,
// Telegram's HTTP status and error_code (botapi.Error).
type Detailed interface {
	error
	LogAttrs() []slog.Attr
}
