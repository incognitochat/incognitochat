package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/service/apigatewaymanagementapi"
	apitypes "github.com/aws/aws-sdk-go-v2/service/apigatewaymanagementapi/types"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/logx"
	"github.com/incognitochat/incognitochat/backend/internal/push"
	"github.com/incognitochat/incognitochat/backend/internal/session"
)

type memSockets struct {
	open map[string]string // connection -> account
	fail error
}

func (m *memSockets) Open(_ context.Context, account, conn string) error {
	if m.fail != nil {
		return m.fail
	}
	m.open[conn] = account
	return nil
}

func request(route, conn string, headers map[string]string) events.APIGatewayWebsocketProxyRequest {
	var req events.APIGatewayWebsocketProxyRequest
	req.RequestContext.RouteKey = route
	req.RequestContext.ConnectionID = conn
	req.Headers = headers
	return req
}

func TestHandle(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	issuer, _ := session.NewIssuer(map[byte][]byte{1: bytes.Repeat([]byte("k"), 32)}, 1)
	account, device := ids.New(), ids.New()
	token, _, err := issuer.Issue(account, device, now)
	if err != nil {
		t.Fatal(err)
	}
	logs := &bytes.Buffer{}
	sockets := &memSockets{open: map[string]string{}}
	h := &handler{sessions: issuer, sockets: sockets, now: func() time.Time { return now }, log: logx.New(logs, "ws")}
	ctx := context.Background()

	// A good token: recorded, and the subprotocol echoed (browsers require it).
	resp := h.socket(ctx, request("$connect", "c1", map[string]string{"sec-websocket-protocol": "v1, " + token}))
	if resp.StatusCode != http.StatusOK || resp.Headers["Sec-WebSocket-Protocol"] != "v1" || sockets.open["c1"] != account {
		t.Fatalf("connect: %+v, %v", resp, sockets.open)
	}
	// Heartbeats are answered; a disconnect costs nothing: the record goes
	// when a push finds the socket gone, or when it expires.
	if resp := h.socket(ctx, request("$default", "c1", nil)); resp.StatusCode != http.StatusOK {
		t.Fatalf("heartbeat: %d", resp.StatusCode)
	}
	if resp := h.socket(ctx, request("$disconnect", "c1", nil)); resp.StatusCode != http.StatusOK || len(sockets.open) != 1 {
		t.Fatalf("disconnect: %d %v", resp.StatusCode, sockets.open)
	}
	delete(sockets.open, "c1")

	// Refused: no token, wrong protocol, a bad or expired token.
	for _, protocols := range []string{"", "v1", "v2, " + token, token, "v1, nonsense", "v1, " + token + ", extra"} {
		if resp := h.socket(ctx, request("$connect", "c2", map[string]string{"Sec-WebSocket-Protocol": protocols})); resp.StatusCode != http.StatusForbidden {
			t.Errorf("%q: %d", protocols, resp.StatusCode)
		}
	}
	h.now = func() time.Time { return now.Add(time.Hour) }
	if resp := h.socket(ctx, request("$connect", "c3", map[string]string{"Sec-WebSocket-Protocol": "v1, " + token})); resp.StatusCode != http.StatusForbidden {
		t.Errorf("expired token: %d", resp.StatusCode)
	}
	if len(sockets.open) != 0 {
		t.Fatalf("refused connections recorded: %v", sockets.open)
	}

	// Too many connects: refused, and counted in the logs with nothing about
	// the account, connection or token.
	h.now = func() time.Time { return now }
	sockets.fail = ephemeral.ErrTooManyConnects
	if resp := h.socket(ctx, request("$connect", "c5", map[string]string{"Sec-WebSocket-Protocol": "v1, " + token})); resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("too many connects: %d", resp.StatusCode)
	}
	if !bytes.Contains(logs.Bytes(), []byte("connect refused")) {
		t.Fatalf("not logged: %s", logs.String())
	}
	for _, secret := range []string{"c5", token, account, device} {
		if bytes.Contains(logs.Bytes(), []byte(secret)) {
			t.Fatalf("logs leak %q: %s", secret, logs.String())
		}
	}
	logs.Reset()

	// Recorded, but old records couldn't be deleted: the connect stands
	// (refusing would make the app retry and record another), and it's
	// logged without the connection or token.
	sockets.fail = fmt.Errorf("%w: boom c6 %s", ephemeral.ErrTidy, token)
	resp = h.socket(ctx, request("$connect", "c6", map[string]string{"Sec-WebSocket-Protocol": "v1, " + token}))
	if resp.StatusCode != http.StatusOK || resp.Headers["Sec-WebSocket-Protocol"] != "v1" || logs.Len() == 0 {
		t.Fatalf("tidying failure: %+v, logs %q", resp, logs.String())
	}

	// A store failure: refused, logged without the connection or token.
	sockets.fail = errors.New("boom c4 " + token)
	if resp := h.socket(ctx, request("$connect", "c4", map[string]string{"Sec-WebSocket-Protocol": "v1, " + token})); resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("store failure: %d", resp.StatusCode)
	}
	if bytes.Contains(logs.Bytes(), []byte("c4")) || bytes.Contains(logs.Bytes(), []byte("c6")) || bytes.Contains(logs.Bytes(), []byte(token)) {
		t.Fatalf("logs leak: %s", logs.String())
	}
}

type memPusher struct {
	online map[string]bool
	fail   error
	pushed []string
}

func (m *memPusher) Push(_ context.Context, account string) (bool, error) {
	m.pushed = append(m.pushed, account)
	return m.online[account] && m.fail == nil, m.fail
}

type memNotices struct {
	notified []string
	fail     error
}

func (m *memNotices) Notify(_ context.Context, account string) error {
	m.notified = append(m.notified, account)
	return m.fail
}

// After a send, ws pushes to the recipient's open apps, and asks for a
// notice only if none took it and the envelope isn't quiet.
func TestDeliver(t *testing.T) {
	online, offline := ids.New(), ids.New()
	logs := &bytes.Buffer{}
	p := &memPusher{online: map[string]bool{online: true}}
	n := &memNotices{}
	h := &handler{pusher: p, notices: n, log: logx.New(logs, "ws")}
	ctx := context.Background()
	deliver := func(account string, quiet bool) {
		t.Helper()
		p.pushed, n.notified = nil, nil
		if out, err := h.handle(ctx, event{Event: push.Event{Push: &push.Delivery{Account: account, Quiet: quiet}}}); out != nil || err != nil {
			t.Fatalf("handle: %v, %v", out, err)
		}
	}

	for _, tc := range []struct {
		account string
		quiet   bool
		notice  bool
	}{
		{online, false, false}, // an open app took it
		{online, true, false},
		{offline, false, true}, // nobody did: a notice
		{offline, true, false}, // receipts and the like never bring one
	} {
		deliver(tc.account, tc.quiet)
		if !slices.Equal(p.pushed, []string{tc.account}) || (len(n.notified) == 1) != tc.notice ||
			(tc.notice && n.notified[0] != tc.account) {
			t.Fatalf("%+v: pushed %v, notified %v", tc, p.pushed, n.notified)
		}
	}
	// A send to a mailbox that doesn't exist: nothing to push, no notice.
	deliver("", false)
	if len(p.pushed) != 0 || len(n.notified) != 0 {
		t.Fatalf("empty account: pushed %v, notified %v", p.pushed, n.notified)
	}
	// Not an account ID: nothing either.
	deliver("x", false)
	if len(p.pushed) != 0 || len(n.notified) != 0 || !bytes.Contains(logs.Bytes(), []byte("push refused")) {
		t.Fatalf("bad account: pushed %v, notified %v", p.pushed, n.notified)
	}
	// A push that fails counts as taken by nobody: the notice goes out.
	// Failures are logged without the account, and not returned (Lambda
	// would run the event again).
	p.fail = errors.New("throttled " + online)
	n.fail = errors.New("boom " + online)
	deliver(online, false)
	if !slices.Equal(n.notified, []string{online}) {
		t.Fatalf("failed push: notified %v", n.notified)
	}
	if !bytes.Contains(logs.Bytes(), []byte("push failed")) || !bytes.Contains(logs.Bytes(), []byte("notice request failed")) ||
		bytes.Contains(logs.Bytes(), []byte(online)) {
		t.Fatalf("logs: %s", logs.String())
	}
}

// The function tells api's events from API Gateway's by their shape: only
// API Gateway's have a route.
func TestHandleEvents(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	issuer, _ := session.NewIssuer(map[byte][]byte{1: bytes.Repeat([]byte("k"), 32)}, 1)
	account := ids.New()
	token, _, _ := issuer.Issue(account, ids.New(), now)
	sockets := &memSockets{open: map[string]string{}}
	p := &memPusher{online: map[string]bool{}}
	n := &memNotices{}
	h := &handler{sessions: issuer, sockets: sockets, pusher: p, notices: n, now: func() time.Time { return now }, log: logx.New(&bytes.Buffer{}, "ws")}
	ctx := context.Background()
	decode := func(raw string) event {
		t.Helper()
		var e event
		if err := json.Unmarshal([]byte(raw), &e); err != nil {
			t.Fatal(err)
		}
		return e
	}

	out, err := h.handle(ctx, decode(`{"requestContext":{"routeKey":"$connect","connectionId":"c1"},"headers":{"Sec-WebSocket-Protocol":"v1, `+token+`"}}`))
	if resp, ok := out.(events.APIGatewayProxyResponse); err != nil || !ok || resp.StatusCode != http.StatusOK || sockets.open["c1"] != account {
		t.Fatalf("connect: %v, %v", out, err)
	}
	if out, err := h.handle(ctx, decode(`{"push":{"account":"`+account+`","quiet":false}}`)); out != nil || err != nil ||
		!slices.Equal(p.pushed, []string{account}) || !slices.Equal(n.notified, []string{account}) {
		t.Fatalf("push: %v, %v; pushed %v, notified %v", out, err, p.pushed, n.notified)
	}
	// Something with a route is a socket's, whatever else it carries.
	out, _ = h.handle(ctx, decode(`{"requestContext":{"routeKey":"$default","connectionId":"c1"},"push":{"account":"`+account+`"}}`))
	if resp, ok := out.(events.APIGatewayProxyResponse); !ok || resp.StatusCode != http.StatusOK || len(p.pushed) != 1 {
		t.Fatalf("heartbeat: %v; pushed %v", out, p.pushed)
	}
}

// liveAPI answers like API Gateway: gone for sockets that have closed.
type liveAPI struct {
	open map[string]bool
	sent []string
}

func (l *liveAPI) PostToConnection(_ context.Context, in *apigatewaymanagementapi.PostToConnectionInput, _ ...func(*apigatewaymanagementapi.Options)) (*apigatewaymanagementapi.PostToConnectionOutput, error) {
	if !l.open[*in.ConnectionId] {
		return nil, &apitypes.GoneException{}
	}
	l.sent = append(l.sent, *in.ConnectionId)
	return &apigatewaymanagementapi.PostToConnectionOutput{}, nil
}

// End to end on DynamoDB Local: a socket recorded on connect is found by
// the push, under a name that isn't the account's ID; an account whose
// sockets have closed gets a notice instead.
func TestConnectThenDeliver(t *testing.T) {
	client := dynamotest.Client(t)
	table := dynamotest.Table(t, client)
	now := time.Unix(1_800_000_000, 0)
	sessionKey := bytes.Repeat([]byte("k"), 32)
	issuer, _ := session.NewIssuer(map[byte][]byte{1: sessionKey}, 1)
	sockets := &ephemeral.Sockets{DB: client, Table: table, Now: func() time.Time { return now }, Key: ephemeral.SocketKey(sessionKey)}
	api := &liveAPI{open: map[string]bool{}}
	n := &memNotices{}
	h := &handler{sessions: issuer, sockets: sockets, pusher: &push.Pusher{Sockets: sockets, API: api}, notices: n,
		now: func() time.Time { return now }, log: logx.New(&bytes.Buffer{}, "ws")}
	ctx := context.Background()

	account := ids.New()
	token, _, _ := issuer.Issue(account, ids.New(), now)
	if resp := h.socket(ctx, request("$connect", "c1", map[string]string{"Sec-WebSocket-Protocol": "v1, " + token})); resp.StatusCode != http.StatusOK {
		t.Fatalf("connect: %d", resp.StatusCode)
	}
	api.open["c1"] = true
	out, err := client.Scan(ctx, &dynamodb.ScanInput{TableName: &table})
	if err != nil || len(out.Items) != 1 {
		t.Fatalf("scan: %d items, %v", len(out.Items), err)
	}
	if pk := out.Items[0]["pk"].(*dbtypes.AttributeValueMemberS).Value; !strings.HasPrefix(pk, "C#") || strings.Contains(pk, account) {
		t.Fatalf("socket record %q", pk)
	}

	h.deliver(ctx, push.Delivery{Account: account})
	if !slices.Equal(api.sent, []string{"c1"}) || len(n.notified) != 0 {
		t.Fatalf("open app: sent %v, notified %v", api.sent, n.notified)
	}
	// The app closed: the push finds its socket gone, forgets it, and
	// asks for a notice.
	api.open["c1"] = false
	h.deliver(ctx, push.Delivery{Account: account})
	if !slices.Equal(n.notified, []string{account}) {
		t.Fatalf("closed app: notified %v", n.notified)
	}
	if conns, _ := sockets.Connections(ctx, account); len(conns) != 0 {
		t.Fatalf("left on record: %v", conns)
	}
}
