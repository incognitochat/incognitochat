package tally

import (
	"bytes"
	"strconv"
	"testing"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/logx"
)

func TestOneLinePerMinute(t *testing.T) {
	var buf bytes.Buffer
	c := New(logx.New(&buf, "api"))
	start := time.Date(2026, 11, 18, 10, 2, 0, 0, time.UTC)

	c.Add(start.Add(5*time.Second), "POST /register", 200, "")
	c.Add(start.Add(10*time.Second), "POST /send", 429, "rate_limited")
	c.Add(start.Add(20*time.Second), "POST /send", 429, "rate_limited")
	c.Add(start.Add(30*time.Second), "PUT /links/{id}/keys", 401, "signature_rejected")
	if buf.Len() != 0 {
		t.Fatalf("logged before the minute ended: %s", buf.String())
	}

	// Idle for minutes: nothing for them. The next answer logs the minute
	// it counted, dated by that minute's start.
	c.Add(start.Add(5*time.Minute+time.Second), "GET /inbox", 200, "")
	want := `{"time":"2026-11-18T10:02:00Z","level":"WARN","msg":"request counts","fn":"api","count":4,` +
		`"errors":{"rate_limited":2,"signature_rejected":1},` +
		`"routes":{"post_register_200":1,"post_send_429":2,"put_links_id_keys_401":1}}` + "\n"
	if buf.String() != want {
		t.Fatalf("logged\n%s\nwant\n%s", buf.String(), want)
	}

	// At shutdown, what is left; then nothing more.
	buf.Reset()
	c.Flush()
	want = `{"time":"2026-11-18T10:07:00Z","level":"WARN","msg":"request counts","fn":"api","count":1,` +
		`"routes":{"get_inbox_200":1}}` + "\n"
	if buf.String() != want {
		t.Fatalf("flushed\n%s\nwant\n%s", buf.String(), want)
	}
	buf.Reset()
	c.Flush()
	if buf.Len() != 0 {
		t.Fatalf("flushed twice: %s", buf.String())
	}
}

func TestNothingWhenIdle(t *testing.T) {
	var buf bytes.Buffer
	New(logx.New(&buf, "api")).Flush()
	if buf.Len() != 0 {
		t.Fatalf("logged with nothing counted: %s", buf.String())
	}
}

func TestRouteName(t *testing.T) {
	for route, want := range map[string]string{
		"POST /register":       "post_register_200",
		"POST /tokens/media":   "post_tokens_media_200",
		"PUT /links/{id}/keys": "put_links_id_keys_200",
		"GET /media/{id}":      "get_media_id_200",
		"":                     "route_200",
	} {
		if got := RouteName(route, 200); got != want {
			t.Errorf("RouteName(%q) = %q, want %q", route, got, want)
		}
	}
}

func TestBounded(t *testing.T) {
	var buf bytes.Buffer
	c := New(logx.New(&buf, "api"))
	now := time.Date(2026, 11, 18, 10, 2, 0, 0, time.UTC)
	for i := range maxNames + 10 {
		c.Add(now, "GET /r"+strconv.Itoa(i), 200, "")
	}
	// A name counted before the bound still counts after it.
	c.Add(now, "GET /r0", 200, "")
	if len(c.routes) != maxNames || c.total != maxNames+11 || c.routes["get_r0_200"] != 2 {
		t.Fatalf("%d names, total %d, get_r0_200 %d", len(c.routes), c.total, c.routes["get_r0_200"])
	}
}
