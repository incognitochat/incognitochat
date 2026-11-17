package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/apigatewaymanagementapi"
	apitypes "github.com/aws/aws-sdk-go-v2/service/apigatewaymanagementapi/types"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/lambda"
	lambdatypes "github.com/aws/aws-sdk-go-v2/service/lambda/types"

	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/notices"
	"github.com/incognitochat/incognitochat/backend/internal/push"
	"github.com/incognitochat/incognitochat/backend/internal/telegram/botapi"
)

// The harness's session key (newHarness), from which api and ws derive the
// key that names socket records.
var testSessionKey = bytes.Repeat([]byte("k"), 32)

// sockets is API Gateway for the test: which connections are open, and
// what was posted to them. A post can be made to hang until released.
type sockets struct {
	mu      sync.Mutex
	open    map[string]bool
	posted  []string
	started chan string   // gets each connection a post starts on, if set
	release chan struct{} // if set, posts wait for it to close
}

func (s *sockets) PostToConnection(ctx context.Context, in *apigatewaymanagementapi.PostToConnectionInput, _ ...func(*apigatewaymanagementapi.Options)) (*apigatewaymanagementapi.PostToConnectionOutput, error) {
	if s.started != nil {
		s.started <- *in.ConnectionId
	}
	if s.release != nil {
		<-s.release
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.open[*in.ConnectionId] {
		return nil, &apitypes.GoneException{}
	}
	s.posted = append(s.posted, *in.ConnectionId)
	return &apigatewaymanagementapi.PostToConnectionOutput{}, nil
}

// wsFunction is Lambda running the ws function on api's invokes, as
// cmd/ws does: it pushes, and asks for a notice if no app took it and the
// envelope isn't quiet. Invoked asynchronously, it runs on its own, after
// the invoke has returned; invoked any other way, it fails the test.
type wsFunction struct {
	t       *testing.T
	pusher  *push.Pusher
	notify  func(account string)
	wg      sync.WaitGroup
	mu      sync.Mutex
	invokes []push.Delivery
}

func (w *wsFunction) Invoke(_ context.Context, in *lambda.InvokeInput, _ ...func(*lambda.Options)) (*lambda.InvokeOutput, error) {
	if in.InvocationType != lambdatypes.InvocationTypeEvent {
		w.t.Errorf("ws invoked as %q: the answer would wait for the push", in.InvocationType)
	}
	var e push.Event
	if err := json.Unmarshal(in.Payload, &e); err != nil || e.Push == nil {
		w.t.Errorf("event %s: %v", in.Payload, err)
		return &lambda.InvokeOutput{StatusCode: 202}, nil
	}
	d := *e.Push
	w.mu.Lock()
	w.invokes = append(w.invokes, d)
	w.mu.Unlock()
	w.wg.Go(func() {
		if d.Account == "" {
			return
		}
		took, _ := w.pusher.Push(context.Background(), d.Account)
		if !took && !d.Quiet {
			w.notify(d.Account)
		}
	})
	return &lambda.InvokeOutput{StatusCode: 202}, nil
}

func (w *wsFunction) last() push.Delivery {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.invokes[len(w.invokes)-1]
}

// /send makes the same calls, and answers without waiting for the push,
// whether the mailbox's owner has the app open or not, and whether the
// mailbox exists or ended: a sender can't tell them apart by the answer,
// its time or a failure on the way (findings PRV-2, DLV-6, BOT-4).
func TestSendDoesTheSameWork(t *testing.T) {
	h, tb := newDeliveryTables(t)
	now := func() time.Time { return h.now }
	// ws's own store, unmetered: what it does runs after the answer, and
	// isn't the send's.
	wsSockets := &ephemeral.Sockets{DB: tb.meter.Client, Table: tb.ephemeral, Now: now, Key: ephemeral.SocketKey(testSessionKey)}
	api := &sockets{open: map[string]bool{"conn": true}, started: make(chan string, 1), release: make(chan struct{})}
	var mu sync.Mutex
	var notified []string
	ws := &wsFunction{t: t, pusher: &push.Pusher{Sockets: wsSockets, API: api}, notify: func(account string) {
		mu.Lock()
		defer mu.Unlock()
		notified = append(notified, account)
	}}
	h.server.Push = &push.Client{Lambda: ws, Function: "ws"}
	h.server.Sockets = &ephemeral.Sockets{DB: tb.meter, Table: tb.ephemeral, Now: now, Key: ephemeral.SocketKey(testSessionKey)}

	online, offline := h.account(t, userID), h.account(t, userID+1)
	if err := wsSockets.Open(context.Background(), online.d.account, "conn"); err != nil {
		t.Fatal(err)
	}
	mailbox := func(m member) string {
		t.Helper()
		_, out := h.as(t, m, http.MethodPost, "/mailboxes", map[string]any{"count": 1}, false)
		return out["mailboxes"].([]any)[0].(string)
	}
	onlineBox, offlineBox, discarded := mailbox(online), mailbox(offline), mailbox(offline)
	h.as(t, offline, http.MethodPost, "/mailboxes/"+discarded+"/discard", nil, false)
	env := clientEnvelope(t)

	var first []string
	for _, tc := range []struct {
		name, mailbox, account string
	}{
		{"app open", onlineBox, online.d.account},
		{"app closed", offlineBox, offline.d.account},
		{"no such mailbox", ids.New(), ""},
		{"mailbox ended", discarded, ""},
	} {
		tb.meter.Reset()
		status, out := h.post(t, "/send", map[string]any{"mailbox": tc.mailbox, "envelope": env, "token": mintToken(t, h.now)})
		if status != http.StatusOK || len(out) != 0 {
			t.Fatalf("%s: %d %v", tc.name, status, out)
		}
		calls := tb.meter.Calls()
		t.Logf("%-16s %v", tc.name, calls)
		if first == nil {
			first = calls
		} else if !slices.Equal(calls, first) {
			t.Fatalf("%s made %v, an open app's send %v", tc.name, calls, first)
		}
		if got := ws.last(); got != (push.Delivery{Account: tc.account}) {
			t.Fatalf("%s: ws asked for %+v", tc.name, got)
		}
		if tc.name == "app open" {
			// The answer came while the post to the open app had only
			// started: it didn't wait for it.
			select {
			case c := <-api.started:
				if c != "conn" {
					t.Fatalf("posted to %s", c)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("ws never pushed")
			}
			api.started = nil
		}
	}
	if len(ws.invokes) != 4 {
		t.Fatalf("ws invoked %d times for 4 sends", len(ws.invokes))
	}
	close(api.release)
	ws.wg.Wait()
	if !slices.Equal(api.posted, []string{"conn"}) || !slices.Equal(notified, []string{offline.d.account}) {
		t.Fatalf("posted %v, notified %v", api.posted, notified)
	}
}

// sealingNotices seals chat IDs as notify does.
type sealingNotices struct{ sealer *notices.Sealer }

func (n sealingNotices) Seal(_ context.Context, chat int64) ([]byte, error) {
	return n.sealer.Seal(chat)
}

// A table copy can't be matched with the directory: across a whole flow
// (setting up, links, notices, tokens, sends of each kind, pushes and a
// notice, fetching and confirming, uploads, lookups, deleting the
// account), no key the ephemeral table is given holds a mailbox, link,
// account or device ID, or the hash of a Telegram ID the directory keeps;
// and each row expires at the end of its window (finding PRV-1, also
// PRV-6, CQ-5).
func TestEphemeralRowsNameNoIDs(t *testing.T) {
	h, tb := newDeliveryTables(t)
	ctx := context.Background()
	now := func() time.Time { return h.now }
	wsSockets := &ephemeral.Sockets{DB: tb.meter, Table: tb.ephemeral, Now: now, Key: ephemeral.SocketKey(testSessionKey)}
	h.server.Sockets = &ephemeral.Sockets{DB: tb.meter, Table: tb.ephemeral, Now: now, Key: ephemeral.SocketKey(testSessionKey)}
	h.server.Media = &memMedia{stored: map[string]bool{}}
	h.server.Uploads = &ephemeral.Uploads{DB: tb.meter, Table: tb.ephemeral, Now: now}
	h.server.Switches = &memSwitches{}
	chatKey := bytes.Repeat([]byte("c"), 32)
	sealer, _ := notices.NewSealer(chatKey)
	h.server.Notices = sealingNotices{sealer}
	telegram := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":7}}`))
	}))
	defer telegram.Close()
	notifier := &notices.Notifier{
		Directory: &directory.Store{DB: tb.meter, Table: tb.directory},
		Quiet:     &ephemeral.Quiet{DB: tb.meter, Table: tb.ephemeral, Now: now},
		QuietKey:  notices.QuietKey(chatKey),
		Sealer:    sealer,
		Bot:       botapi.Client{Token: "1:T", API: telegram.URL},
		AppURL:    "https://example.github.io/",
		Now:       now,
	}
	api := &sockets{open: map[string]bool{}}
	var noticeErr error
	ws := &wsFunction{t: t, pusher: &push.Pusher{Sockets: wsSockets, API: api}, notify: func(account string) {
		noticeErr = notifier.Notify(ctx, account)
	}}
	h.server.Push = &push.Client{Lambda: ws, Function: "ws"}
	send := func(mailbox string, quiet bool) {
		t.Helper()
		if status, out := h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": clientEnvelope(t), "token": mintToken(t, h.now), "quiet": quiet}); status != http.StatusOK {
			t.Fatalf("send: %d %v", status, out)
		}
		ws.wg.Wait()
	}
	ok := func(status int, out map[string]any) map[string]any {
		t.Helper()
		if status >= 300 {
			t.Fatalf("%d %v", status, out)
		}
		return out
	}

	owner, sender := h.account(t, userID), h.account(t, userID+1)
	link := newLinkKeys(t)
	intro := ok(h.as(t, owner, http.MethodPost, "/links", link.create(t, h.now), true))["mailbox"].(string)
	ok(h.as(t, owner, http.MethodPost, "/notices", map[string]any{"initData": launchIn(userID, "", "en", h)}, false))
	ownerBoxes := ok(h.as(t, owner, http.MethodPost, "/mailboxes", map[string]any{"count": 2}, false))["mailboxes"].([]any)
	senderBoxes := ok(h.as(t, sender, http.MethodPost, "/mailboxes", map[string]any{"count": 2}, false))["mailboxes"].([]any)
	blinded := randomBytes(t, testIssuer().BlindedLen())
	blinded[0] = 0
	ok(h.as(t, sender, http.MethodPost, "/tokens", map[string]any{"blinded": []string{b64(blinded)}}, false))
	mediaBlinded := randomBytes(t, testMediaIssuer().BlindedLen())
	mediaBlinded[0] = 0
	ok(h.as(t, sender, http.MethodPost, "/tokens/media", map[string]any{"blinded": []string{b64(mediaBlinded)}}, false))

	// The owner's app is open (ws records its socket on connect); the
	// sender's isn't.
	if err := wsSockets.Open(ctx, owner.d.account, "owner-conn"); err != nil {
		t.Fatal(err)
	}
	api.open["owner-conn"] = true
	send(intro, false)                   // a first message, through the link: pushed
	send(ownerBoxes[0].(string), true)   // a receipt
	send(senderBoxes[0].(string), false) // a reply: nobody to push to, and notices are off
	send(ids.New(), false)               // no such mailbox
	h.as(t, sender, http.MethodPost, "/mailboxes/"+senderBoxes[1].(string)+"/discard", nil, false)
	send(senderBoxes[1].(string), false) // an ended one
	// The owner's app closes: the next message brings a notice.
	api.open["owner-conn"] = false
	send(ownerBoxes[1].(string), false)
	if noticeErr != nil || !slices.Equal(api.posted, []string{"owner-conn", "owner-conn"}) {
		t.Fatalf("pushed %v, notice %v", api.posted, noticeErr)
	}
	if target, err := notifier.Directory.Notices(ctx, owner.d.account); err != nil || target.LastMessage != 7 {
		t.Fatalf("no notice went out: %+v, %v", target, err)
	}

	page := ok(h.as(t, owner, http.MethodGet, "/inbox", nil, false))
	var itemIDs []string
	for _, it := range page["items"].([]any) {
		itemIDs = append(itemIDs, it.(map[string]any)["id"].(string))
	}
	ok(h.as(t, owner, http.MethodPost, "/ack", map[string]any{"ids": itemIDs}, false))
	ok(h.as(t, sender, http.MethodGet, "/usage", nil, false))
	ok(h.as(t, sender, http.MethodPost, "/mailboxes/check", map[string]any{"ids": senderBoxes}, false))
	ok(h.post(t, "/accounts/lookup", map[string]any{"initData": launch(t, userID+1, "", h.now)}))
	h.as(t, sender, http.MethodPost, "/invitations/redeem", map[string]any{"code": "ABCDEFGH"}, false)
	upload := ok(h.pay(t, 16<<10, mintMediaToken(t, h.now)))["id"].(string)
	ok(h.call(t, nil, "", http.MethodGet, "/media/"+upload, nil, false))

	// Each row expires at the end of its window: rate counters at the end
	// of their minute, hour or day; socket records on a whole minute; the
	// notice's quiet period on the minute after it ends.
	scan, err := tb.meter.Client.Scan(ctx, &dynamodb.ScanInput{TableName: &tb.ephemeral})
	if err != nil {
		t.Fatal(err)
	}
	windows := map[string]int64{"send": 60, "inbox": 60, "intro": 3600}
	kinds := map[string]bool{}
	for _, it := range scan.Items {
		pk, sk := it["pk"].(*dbtypes.AttributeValueMemberS).Value, it["sk"].(*dbtypes.AttributeValueMemberS).Value
		e, _ := strconv.ParseInt(it["e"].(*dbtypes.AttributeValueMemberN).Value, 10, 64)
		switch {
		case strings.HasPrefix(pk, "R#"):
			kind := strings.SplitN(pk[2:], "#", 2)[0]
			kinds[kind] = true
			window, ok := windows[kind]
			if !ok {
				window = 86400
			}
			start, _ := strconv.ParseInt(sk, 10, 64)
			if start%window != 0 || e != start+window {
				t.Errorf("%s counter of window %d s from %d expires at %d", kind, window, start, e)
			}
		case strings.HasPrefix(pk, "C#"), strings.HasPrefix(pk, "Q#"):
			if e%60 != 0 || e > h.now.Add(ephemeral.SocketTTL+time.Minute).Unix() {
				t.Errorf("%s expires at %d", pk, e)
			}
		}
	}
	for _, kind := range []string{"send", "intro", "inbox", "inboxday", "mbx", "link", "ntc", "tok", "reg", "regtry", "look", "redeem", "mbxcheck", "mtok", "dl"} {
		if !kinds[kind] {
			t.Errorf("no %s counter in the flow", kind)
		}
	}

	// Deleting the account forgets its socket records.
	for {
		status, out := h.as(t, owner, http.MethodDelete, "/account", nil, true)
		if status == http.StatusOK {
			break
		}
		if status != http.StatusConflict {
			t.Fatalf("delete: %d %v", status, out)
		}
	}
	if conns, _ := wsSockets.Connections(ctx, owner.d.account); len(conns) != 0 {
		t.Fatalf("socket records left: %v", conns)
	}

	secret := map[string]string{
		"owner's account": owner.d.account, "owner's device": owner.d.id,
		"sender's account": sender.d.account, "sender's device": sender.d.id,
		"link": link.id, "intro mailbox": intro,
		"owner's Telegram hash":  directory.TelegramHash(h.server.Pepper, userID),
		"sender's Telegram hash": directory.TelegramHash(h.server.Pepper, userID+1),
	}
	for i, mb := range append(ownerBoxes, senderBoxes...) {
		secret["mailbox "+strconv.Itoa(i)] = mb.(string)
	}
	written := tb.meter.Written(tb.ephemeral)
	if len(written) < 30 {
		t.Fatalf("only %d writes to the ephemeral table", len(written))
	}
	for _, key := range written {
		for what, id := range secret {
			if strings.Contains(key, id) {
				t.Errorf("ephemeral key %q holds the %s", key, what)
			}
		}
	}
}
