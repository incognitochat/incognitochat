package logx

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"strings"
	"testing"
)

func lines(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("not JSON: %q", line)
		}
		out = append(out, m)
	}
	return out
}

func TestDropsEverythingNotAllowed(t *testing.T) {
	var buf bytes.Buffer
	log := New(&buf, "api")
	log.Warn("request failed",
		slog.String(KeyRoute, "POST /session"),
		slog.Int(KeyStatus, 500),
		ErrorKind(&fs.PathError{Op: "open", Path: "/secret/account-123", Err: errors.New("x")}),
		slog.String("account_id", "AAAAAAAAAAAAAAAAAAAAAA"),
		slog.String("ip", "203.0.113.7"),
		slog.Group("request", slog.String(KeyRoute, "hidden in a group")),
	)
	log.WithGroup("g").Warn("grouped", slog.String(KeyRoute, "x"))

	got := lines(t, &buf)
	if len(got) != 2 {
		t.Fatalf("got %d lines: %s", len(got), buf.String())
	}
	first := got[0]
	for key, want := range map[string]any{
		"msg": "request failed", "fn": "api", "route": "POST /session",
		"status": float64(500), "error_kind": "*fs.PathError",
	} {
		if first[key] != want {
			t.Errorf("%s = %v, want %v", key, first[key], want)
		}
	}
	for _, key := range []string{"account_id", "ip", "request"} {
		if _, ok := first[key]; ok {
			t.Errorf("%s was logged", key)
		}
	}
	if strings.Contains(buf.String(), "account-123") || strings.Contains(buf.String(), "203.0.113.7") {
		t.Errorf("an identifier leaked: %s", buf.String())
	}
	if _, ok := got[1]["g"]; ok {
		t.Errorf("a group was logged: %v", got[1])
	}
}

func TestCountGroupsHoldOnlyCounts(t *testing.T) {
	var buf bytes.Buffer
	log := New(&buf, "api")
	log.Warn("request counts",
		slog.Group(KeyRoutes,
			slog.Int("post_send_429", 3),
			slog.String("post_send_200", "AAAAAAAAAAAAAAAAAAAAAA"),
			slog.Int("POST /links/abc", 1),
			slog.Int("9lives_200", 1),
			slog.Int(strings.Repeat("a", 61)+"_200", 1),
			slog.Int("post_send", 1),
			slog.Int("post_send_42", 1),
			slog.Int("post_send_600", 1),
			slog.Int("post_send_2x0", 1),
			slog.Int("rate_limited", 1),
		),
		slog.Group(KeyErrors,
			slog.Int("rate_limited", 3),
			slog.Float64("ratio", 0.5),
			slog.Int(strings.Repeat("a", 41), 1),
			slog.Int("Account123", 1),
		),
		slog.Group("other", slog.Int("count", 1)),
		slog.Int(KeyRoutes, 7),
	)
	// A group within a count group is dropped.
	log.Warn("nested", slog.Group(KeyRoutes, slog.Group(KeyErrors, slog.Int("deep", 1))))
	got := lines(t, &buf)[0]
	routes, _ := got[KeyRoutes].(map[string]any)
	if len(routes) != 1 || routes["post_send_429"] != float64(3) {
		t.Errorf("routes = %v", got[KeyRoutes])
	}
	errs, _ := got[KeyErrors].(map[string]any)
	if len(errs) != 1 || errs["rate_limited"] != float64(3) {
		t.Errorf("errors = %v", got[KeyErrors])
	}
	if _, ok := got["other"]; ok {
		t.Errorf("another group was logged: %v", got)
	}
	if strings.Contains(buf.String(), "AAAA") || strings.Contains(buf.String(), "abc") ||
		strings.Contains(buf.String(), "deep") {
		t.Errorf("more than counts was logged: %s", buf.String())
	}
}

func TestLevelIsWarning(t *testing.T) {
	var buf bytes.Buffer
	log := New(&buf, "api")
	log.Info("routine")
	log.Debug("noise")
	if buf.Len() != 0 {
		t.Fatalf("logged below warning: %s", buf.String())
	}
	log.Error("bad")
	if len(lines(t, &buf)) != 1 {
		t.Fatal("error not logged")
	}
}

func TestLongValuesAreCut(t *testing.T) {
	var buf bytes.Buffer
	New(&buf, "api").Warn("x", slog.String(KeyRoute, strings.Repeat("r", 500)))
	if got := lines(t, &buf)[0]["route"].(string); len(got) != 100 {
		t.Fatalf("route length = %d", len(got))
	}
}

func TestErrorKindNil(t *testing.T) {
	var buf bytes.Buffer
	New(&buf, "api").Warn("x", ErrorKind(nil))
	if _, ok := lines(t, &buf)[0]["error_kind"]; ok {
		t.Fatal("nil error logged")
	}
}
