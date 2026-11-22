package api

import (
	"bytes"
	"context"
	"encoding/base64"
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
	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
	"github.com/incognitochat/incognitochat/backend/internal/envelope"
	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/inbox"
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

// failingDB is the tables' client, with calls of one kind failing while
// fail names it, as when the table is throttled.
type failingDB struct {
	*dynamotest.Meter
	fail *string
}

func (f failingDB) Query(ctx context.Context, in *dynamodb.QueryInput, opts ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	if *f.fail == "Query" {
		return nil, errThrottled
	}
	return f.Meter.Query(ctx, in, opts...)
}

func (f failingDB) BatchWriteItem(ctx context.Context, in *dynamodb.BatchWriteItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.BatchWriteItemOutput, error) {
	if *f.fail == "BatchWriteItem" {
		return nil, errThrottled
	}
	return f.Meter.BatchWriteItem(ctx, in, opts...)
}

// largestEnvelope is the largest envelope there can be (MaxLen): 19 write
// units to store, 8 tokens.
func largestEnvelope() string {
	largest := make([]byte, envelope.MaxLen)
	largest[0], largest[1] = envelope.Suite, envelope.MaxWraps
	return base64.RawURLEncoding.EncodeToString(largest)
}

// work is what a request did: its calls, in order, and the capacity each
// table took.
type work struct {
	calls                          []string
	directory, messages, ephemeral dynamotest.Units
}

func (w work) equal(o work) bool {
	return slices.Equal(w.calls, o.calls) && w.directory == o.directory && w.messages == o.messages && w.ephemeral == o.ephemeral
}

// /send makes the same calls, with the same capacity, and answers without
// waiting for the push, whether the mailbox's owner has the app open or
// not, and whether the mailbox exists or ended, or its account did
// (replaced, or being deleted, before its mailboxes are); for small and the largest
// envelopes, quiet or not, through conversation and intro mailboxes; and a
// failing table fails it the same way. A sender can't tell them apart by
// the answer, its time or a failure on the way (findings PRV-2, DLV-6,
// BOT-4).
func TestSendDoesTheSameWork(t *testing.T) {
	h, tb := newDeliveryTables(t)
	now := func() time.Time { return h.now }
	fail := ""
	db := failingDB{tb.meter, &fail}
	h.server.Directory = &directory.Store{DB: db, Table: tb.directory}
	h.server.Inbox = &inbox.Store{DB: db, Table: tb.messages}
	// ws's own store, unmetered: what it does runs after the answer, and
	// isn't the send's.
	wsSockets := &ephemeral.Sockets{DB: tb.meter.Client, Table: tb.ephemeral, Now: now, Key: ephemeral.SocketKey(testSessionKey)}
	api := &sockets{open: map[string]bool{"conn": true}, started: make(chan string, 64), release: make(chan struct{})}
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
	intro := func(m member) string {
		t.Helper()
		_, out := h.as(t, m, http.MethodPost, "/links", newLinkKeys(t).create(t, h.now), true)
		return out["mailbox"].(string)
	}
	onlineBox, offlineBox, discarded := mailbox(online), mailbox(offline), mailbox(offline)
	h.as(t, offline, http.MethodPost, "/mailboxes/"+discarded+"/discard", nil, false)
	onlineIntro, offlineIntro := intro(online), intro(offline)
	// Mailboxes of an account replaced (the cleanup that deletes them not
	// run yet), and of one being deleted.
	replaced, deleting := h.account(t, userID+2), h.account(t, userID+3)
	replacedBox, deletingBox := mailbox(replaced), mailbox(deleting)
	ctx := context.Background()
	th := directory.TelegramHash(h.server.Pepper, userID+2)
	old, err := h.server.Directory.ByTelegram(ctx, th, replaced.d.id)
	if err != nil {
		t.Fatal(err)
	}
	fresh := newDevice(t)
	if err := h.server.Directory.Replace(ctx, old, directory.NewAccount{
		ID: ids.New(), TelegramHash: th, AccountKey: raw(t, fresh.ak), DeviceID: fresh.id, DeviceKey: raw(t, fresh.dsk),
	}, h.now); err != nil {
		t.Fatal(err)
	}
	if err := h.server.Directory.MarkDeleting(ctx, deleting.d.account); err != nil {
		t.Fatal(err)
	}
	send := func(mb, env string, tokens int, quiet bool) (int, map[string]any, work) {
		t.Helper()
		tb.meter.Reset()
		status, out := h.post(t, "/send", map[string]any{"mailbox": mb, "envelope": env, "tokens": mintTokens(t, h.now, tokens), "quiet": quiet})
		return status, out, work{tb.meter.Calls(), tb.meter.Units(tb.directory), tb.meter.Units(tb.messages), tb.meter.Units(tb.ephemeral)}
	}

	// The first send to a mailbox that doesn't exist, ever, writes the
	// placeholders the device lookup reads (directory.Store.NoRecipients):
	// two writes more, once per table.
	for i, want := range []int{2, 0} {
		status, _, w := send(ids.New(), clientEnvelope(t), 1, false)
		if status != http.StatusOK || w.directory.Write != float64(want) {
			t.Fatalf("send %d to no mailbox: %d, %+v", i+1, status, w)
		}
	}

	type target struct{ name, mailbox, account string }
	conversations := []target{
		{"app open", onlineBox, online.d.account},
		{"app closed", offlineBox, offline.d.account},
		{"no such mailbox", ids.New(), ""},
		{"mailbox ended", discarded, ""},
		{"account replaced", replacedBox, ""},
		{"account being deleted", deletingBox, ""},
	}
	// A sender knows it writes to an intro mailbox (it's in the link's
	// bundle), and whether the link is gone (GET /links/{id}); the probe to
	// rule out is whether the link's owner has the app open.
	intros := []target{
		{"intro, app open", onlineIntro, online.d.account},
		{"intro, app closed", offlineIntro, offline.d.account},
	}
	posts, notices := 0, 0
	waited := false
	for _, e := range []struct {
		name, env string
		tokens    int
	}{{"small", clientEnvelope(t), 1}, {"largest", largestEnvelope(), envelope.MaxTokens}} {
		for _, quiet := range []bool{false, true} {
			for _, group := range [][]target{conversations, intros} {
				var first *work
				for _, tc := range group {
					status, out, w := send(tc.mailbox, e.env, e.tokens, quiet)
					if status != http.StatusOK || len(out) != 0 {
						t.Fatalf("%s, %s, quiet %v: %d %v", tc.name, e.name, quiet, status, out)
					}
					t.Logf("%-8s quiet %-5v %-18s %v | directory %+v | messages %+v | ephemeral %+v",
						e.name, quiet, tc.name, w.calls, w.directory, w.messages, w.ephemeral)
					if first == nil {
						first = &w
					} else if !w.equal(*first) {
						t.Fatalf("%s, %s, quiet %v: did %+v, %s %+v", tc.name, e.name, quiet, w, group[0].name, *first)
					}
					if got := ws.last(); got != (push.Delivery{Account: tc.account, Quiet: quiet}) {
						t.Fatalf("%s: ws asked for %+v", tc.name, got)
					}
					switch tc.account {
					case online.d.account:
						posts++
					case offline.d.account:
						if !quiet {
							notices++
						}
					}
					if tc.account == online.d.account && !waited {
						// The answer came while the post to the open app
						// had only started: it didn't wait for it.
						select {
						case c := <-api.started:
							if c != "conn" {
								t.Fatalf("posted to %s", c)
							}
						case <-time.After(10 * time.Second):
							t.Fatal("ws never pushed")
						}
						waited = true
					}
				}
			}
		}
	}
	close(api.release)
	ws.wg.Wait()
	if len(api.posted) != posts || len(notified) != notices {
		t.Fatalf("posted %v (want %d), notified %v (want %d)", api.posted, posts, notified, notices)
	}
	for _, account := range notified {
		if account != offline.d.account {
			t.Fatalf("notified %v", notified)
		}
	}

	// A table failing on the way fails every send the same way, whether
	// the mailbox exists or not.
	for _, op := range []string{"Query", "BatchWriteItem"} {
		fail = op
		for _, mb := range []string{onlineBox, offlineBox, ids.New(), discarded} {
			status, out, _ := send(mb, clientEnvelope(t), 1, false)
			wantError(t, status, out, http.StatusInternalServerError, "internal")
		}
	}
	fail = ""
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
	ok(h.as(t, owner, http.MethodPost, "/notices/language", map[string]any{"initData": launchIn(userID, "", "fa", h)}, false))
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
	// of their minute, hour or day (a device's logins and signed requests,
	// dev, in one row for the day); socket records on a whole minute; the
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
	for _, kind := range []string{"send", "intro", "inbox", "inboxday", "mbx", "link", "ntc", "ntl", "tok", "reg", "regtry", "look", "redeem", "mbxcheck", "mtok", "dl", "dev"} {
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
