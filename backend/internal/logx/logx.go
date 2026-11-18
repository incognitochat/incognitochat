// Package logx is the only way the backend logs.
//
// It writes JSON at warning level and above, and drops every attribute that
// isn't on a short allow-list (and every group but the count groups, which
// hold integers only), so identifiers, IP addresses and request data can't
// end up in the logs by mistake. Messages must be constant strings: never
// format values into them.
package logx

import (
	"fmt"
	"io"
	"log/slog"
)

// Allowed attribute keys. Values must never identify a person, device,
// account, link, mailbox or request.
const (
	KeyFunction  = "fn"          // which Lambda function
	KeyRoute     = "route"       // route pattern, e.g. "POST /session"
	KeyStatus    = "status"      // HTTP status returned
	KeyErrorKind = "error_kind"  // Go type of an error, never its message
	KeyDuration  = "duration_ms" // how long something took
	KeyCount     = "count"       // how many items were involved
)

var allowed = map[string]bool{
	KeyFunction: true, KeyRoute: true, KeyStatus: true,
	KeyErrorKind: true, KeyDuration: true, KeyCount: true,
}

// Allowed groups, of counts only. Each member is an integer, named in lower
// case letters, digits and "_" (at most 64), starting with a letter: by a
// route pattern and status, or by an error code, never by anything from a
// request.
const (
	KeyRoutes = "routes" // answers by route and status, e.g. "post_send_429"
	KeyErrors = "errors" // answers by error code, e.g. "rate_limited"
)

var countGroups = map[string]bool{KeyRoutes: true, KeyErrors: true}

// New returns a logger for one function writing to w.
func New(w io.Writer, function string) *slog.Logger {
	h := slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level: slog.LevelWarn,
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			if len(groups) > 0 {
				if len(groups) == 1 && countGroups[groups[0]] && isCount(a) {
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

// isCount is whether a is a count group's member: an integer with a name
// of lower case letters, digits and "_", starting with a letter.
func isCount(a slog.Attr) bool {
	if k := a.Value.Kind(); k != slog.KindInt64 && k != slog.KindUint64 {
		return false
	}
	if a.Key == "" || len(a.Key) > 64 || a.Key[0] < 'a' || a.Key[0] > 'z' {
		return false
	}
	for _, c := range []byte(a.Key) {
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '_' {
			return false
		}
	}
	return true
}

// ErrorKind describes an error by its Go type only. Error messages can carry
// keys or values from the request, so they are never logged.
func ErrorKind(err error) slog.Attr {
	if err == nil {
		return slog.Attr{}
	}
	return slog.String(KeyErrorKind, fmt.Sprintf("%T", err))
}
