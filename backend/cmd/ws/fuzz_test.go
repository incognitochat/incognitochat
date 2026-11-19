package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"

	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/logx"
	"github.com/incognitochat/incognitochat/backend/internal/session"
)

// Any event the function is invoked with, as Lambda decodes it: handle
// never panics; a socket is recorded only on a connect with a session
// token that verifies, for the token's account; a hint is pushed only for
// an event without a route (the api function's), to a well-formed account.
func FuzzEvent(f *testing.F) {
	now := time.Unix(1_800_000_000, 0)
	issuer, err := session.NewIssuer(map[byte][]byte{1: bytes.Repeat([]byte("k"), 32)}, 1)
	if err != nil {
		f.Fatal(err)
	}
	token, _, err := issuer.Issue(ids.New(), ids.New(), now)
	if err != nil {
		f.Fatal(err)
	}
	f.Add(`{"requestContext":{"routeKey":"$connect","connectionId":"c1"},"headers":{"Sec-WebSocket-Protocol":"v1, ` + token + `"}}`)
	f.Add(`{"requestContext":{"routeKey":"$connect","connectionId":"c1"},"headers":{"sec-websocket-protocol":"v1,` + token + `,x"}}`)
	f.Add(`{"requestContext":{"routeKey":"$connect","connectionId":"c1"},"headers":{"Sec-WebSocket-Protocol":" v1 ,  "}}`)
	f.Add(`{"requestContext":{"routeKey":"$default","connectionId":"c1"},"push":{"account":"AAAAAAAAAAAAAAAAAAAAAA"}}`)
	f.Add(`{"push":{"account":"AAAAAAAAAAAAAAAAAAAAAA","quiet":true}}`)
	f.Add(`{"push":{"account":"AAAAAAAAAAAAAAAAAAAAAA\n"}}`)
	f.Add(`{"push":{"account":""}}`)
	f.Fuzz(func(t *testing.T, raw string) {
		var e event
		if json.Unmarshal([]byte(raw), &e) != nil {
			return // Lambda doesn't call the handler
		}
		sockets := &memSockets{open: map[string]string{}}
		p := &memPusher{online: map[string]bool{}}
		n := &memNotices{}
		h := &handler{sessions: issuer, sockets: sockets, pusher: p, notices: n, now: func() time.Time { return now }, log: logx.New(&bytes.Buffer{}, "ws")}
		out, err := h.handle(context.Background(), e)
		if err != nil {
			t.Fatal(err)
		}
		for _, account := range append(p.pushed, n.notified...) {
			if e.RequestContext.RouteKey != "" || e.Push == nil || account != e.Push.Account || !ids.Valid(account) {
				t.Fatalf("%q: pushed %v, notified %v", raw, p.pushed, n.notified)
			}
		}
		if len(n.notified) > 0 && e.Push.Quiet {
			t.Fatalf("%q: a quiet delivery asked for a notice", raw)
		}
		resp, ok := out.(events.APIGatewayProxyResponse)
		if !ok {
			if out != nil || e.RequestContext.RouteKey != "" {
				t.Fatalf("%q: answered %#v", raw, out)
			}
			return
		}
		if len(sockets.open) == 0 {
			if resp.StatusCode == http.StatusOK && e.RequestContext.RouteKey == "$connect" {
				t.Fatalf("%q: connected without recording the socket", raw)
			}
			return
		}
		if e.RequestContext.RouteKey != "$connect" || resp.StatusCode != http.StatusOK || resp.Headers["Sec-WebSocket-Protocol"] != Protocol {
			t.Fatalf("%q: recorded a socket and answered %+v", raw, resp)
		}
		// The socket's account is that of a token the app sent. (Headers
		// that differ only in case are a decoded event's, never API
		// Gateway's: any of them may be the one read.)
		for name, value := range e.Headers {
			if !strings.EqualFold(name, "Sec-WebSocket-Protocol") {
				continue
			}
			tok, ok := tokenFrom(value)
			if !ok {
				continue
			}
			if claims, err := issuer.Verify(tok, now); err == nil && len(sockets.open) == 1 && sockets.open[e.RequestContext.ConnectionID] == claims.AccountID {
				return
			}
		}
		t.Fatalf("%q: recorded %v without a token for it", raw, sockets.open)
	})
}
