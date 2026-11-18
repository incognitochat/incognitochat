package api

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
)

// mailboxes gives an account n mailboxes, written straight to the table as
// POST /mailboxes makes them (at its daily limit, the API would take weeks).
func (tb *deliveryTables) mailboxes(t *testing.T, account string, n int) []string {
	t.Helper()
	var made []string
	var requests []types.WriteRequest
	for range n {
		id := ids.New()
		made = append(made, id)
		requests = append(requests,
			types.WriteRequest{PutRequest: &types.PutRequest{Item: map[string]types.AttributeValue{
				"pk": &types.AttributeValueMemberS{Value: "A#" + account},
				"sk": &types.AttributeValueMemberS{Value: "M#" + id},
			}}},
			types.WriteRequest{PutRequest: &types.PutRequest{Item: map[string]types.AttributeValue{
				"pk": &types.AttributeValueMemberS{Value: "M#" + id},
				"sk": &types.AttributeValueMemberS{Value: "M"},
				"o":  &types.AttributeValueMemberS{Value: account},
			}}},
		)
	}
	for len(requests) > 0 {
		k := min(25, len(requests))
		if _, err := tb.meter.Client.BatchWriteItem(context.Background(), &dynamodb.BatchWriteItemInput{
			RequestItems: map[string][]types.WriteRequest{tb.directory: requests[:k]},
		}); err != nil {
			t.Fatal(err)
		}
		requests = requests[k:]
	}
	return made
}

// waiting is how many envelopes the messages table holds for a device.
func (tb *deliveryTables) waiting(t *testing.T, account, device string) int {
	t.Helper()
	out, err := tb.meter.Client.Query(context.Background(), &dynamodb.QueryInput{
		TableName:                 &tb.messages,
		KeyConditionExpression:    aws.String("pk = :pk"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":pk": &types.AttributeValueMemberS{Value: "D#" + account + "#" + device}},
		Select:                    types.SelectCount,
		ConsistentRead:            aws.Bool(true),
	})
	if err != nil {
		t.Fatal(err)
	}
	return int(out.Count)
}

// Setting up again over an account with 4,000 mailboxes ends it at once
// (a send to one of its mailboxes goes nowhere, its link is gone, its
// device is told) in one request of bounded cost; the new device's app
// then deletes the rest in steps of about 50 writes, and GET /account
// says when there is nothing left.
func TestReplaceABigAccount(t *testing.T) {
	h, tb := newDeliveryTables(t)
	ctx := context.Background()
	old := h.account(t, userID)
	l := newLinkKeys(t)
	if status, out := h.as(t, old, http.MethodPost, "/links", l.create(t, h.now), true); status != http.StatusCreated {
		t.Fatalf("link: %d %v", status, out)
	}
	boxes := tb.mailboxes(t, old.d.account, 4000)
	send := func(mailbox string) {
		t.Helper()
		if status, out := h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": clientEnvelope(t), "tokens": mintTokens(t, h.now, 1)}); status != http.StatusOK || len(out) != 0 {
			t.Fatalf("send: %d %v", status, out)
		}
	}
	send(boxes[0])
	if n := tb.waiting(t, old.d.account, old.d.id); n != 1 {
		t.Fatalf("%d envelopes wait for the old device", n)
	}

	fresh := newDevice(t)
	tb.meter.Reset()
	if status, out := h.register(t, fresh, true); status != http.StatusOK {
		t.Fatalf("replace: %d %v", status, out)
	}
	dir := tb.meter.Units(tb.directory)
	t.Logf("POST /register replacing 4,000 mailboxes: directory %+v, messages %+v", dir, tb.meter.Units(tb.messages))
	// The swap, and the first step.
	if dir.Write > DeleteStep+30 || dir.Read > 12 {
		t.Fatalf("the replacement cost %+v", dir)
	}

	// Ended at once: what waited for the old device went with the first
	// step, and a send to one of its mailboxes still there goes nowhere.
	if n := tb.waiting(t, old.d.account, old.d.id); n != 0 {
		t.Fatalf("%d envelopes still wait for the old device", n)
	}
	alive := ""
	for _, b := range boxes {
		if _, err := h.server.Directory.Mailbox(ctx, b); err == nil {
			alive = b
			break
		}
	}
	if alive == "" {
		t.Fatal("the first step took every mailbox")
	}
	send(alive)
	if n := tb.waiting(t, old.d.account, old.d.id); n != 0 {
		t.Fatalf("a send to the old account was stored for its device (%d)", n)
	}
	status, out := h.call(t, nil, "", http.MethodGet, "/links/"+l.id, nil, false)
	wantError(t, status, out, http.StatusNotFound, "not_found")
	status, out = h.post(t, "/session", old.d.login(t, h.now))
	wantError(t, status, out, http.StatusGone, "account_replaced")

	// The new device's app carries on.
	current := member{d: fresh, token: h.token(t, fresh)}
	if status, out := h.as(t, current, http.MethodGet, "/account", nil, false); status != http.StatusOK || out["cleanup"] != true || out["deleting"] != false {
		t.Fatalf("account: %d %v", status, out)
	}
	steps := 0
	var most dynamotest.Units
	for {
		if steps++; steps > 400 {
			t.Fatal("the cleanup never finishes")
		}
		h.now = h.now.Add(time.Second)
		tb.meter.Reset()
		status, out := h.as(t, current, http.MethodPost, "/account/cleanup", nil, true)
		u := tb.meter.Units(tb.directory)
		most.Read, most.Write = max(most.Read, u.Read), max(most.Write, u.Write)
		if status == http.StatusOK {
			break
		}
		wantError(t, status, out, http.StatusConflict, "in_progress")
	}
	t.Logf("POST /account/cleanup: %d steps, each at most directory %+v", steps, most)
	// The step, its lease (taken and let go), and the device's read.
	if most.Write > DeleteStep+3 || most.Read > 10 {
		t.Fatalf("a step cost up to %+v", most)
	}
	if status, out := h.as(t, current, http.MethodGet, "/account", nil, false); status != http.StatusOK || out["cleanup"] != false {
		t.Fatalf("account after the cleanup: %d %v", status, out)
	}
	if _, err := h.server.Directory.Mailbox(ctx, alive); !errors.Is(err, directory.ErrNotFound) {
		t.Fatalf("the old mailbox after the cleanup: %v", err)
	}
	// Asking again (an answer lost) is done at once.
	if status, out := h.as(t, current, http.MethodPost, "/account/cleanup", nil, true); status != http.StatusOK {
		t.Fatalf("cleanup again: %d %v", status, out)
	}
	// Nothing left of the steps' lease on the account item.
	got, err := tb.meter.Client.GetItem(ctx, &dynamodb.GetItemInput{TableName: &tb.directory, Key: map[string]types.AttributeValue{
		"pk": &types.AttributeValueMemberS{Value: "A#" + fresh.account}, "sk": &types.AttributeValueMemberS{Value: "A"},
	}})
	if _, held := got.Item["sl"]; err != nil || held {
		t.Fatalf("the steps' lease stayed: %v, %v", got.Item["sl"], err)
	}
	// The old device is still told, for the marker's 90 days.
	status, out = h.post(t, "/session", old.d.login(t, h.now))
	wantError(t, status, out, http.StatusGone, "account_replaced")
}

// One step at a time runs for an account: while one holds it, another is
// answered in_progress having done nothing, however many are sent at once.
func TestStepsOneAtATime(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	first := h.account(t, userID)
	for range 3 {
		h.now = h.now.Add(time.Second)
		if status, out := h.as(t, first, http.MethodPost, "/mailboxes", map[string]any{"count": MailboxBatch}, false); status != http.StatusCreated {
			t.Fatalf("mailboxes: %d %v", status, out)
		}
	}
	owner := h.account(t, userID+1)

	h.dir.leased = map[string]bool{owner.d.account: true}
	status, out := h.as(t, owner, http.MethodDelete, "/account", nil, true)
	wantError(t, status, out, http.StatusConflict, "in_progress")
	if h.dir.accounts[owner.d.account].deleting {
		t.Fatal("a step ran while another held the account")
	}

	// The same for the cleanup after a replacement.
	second := newDevice(t)
	h.dir.leased = map[string]bool{}
	m := member{d: second, token: h.loggedIn(t, second, true)}
	boxes := len(h.dir.boxes)
	h.dir.leased = map[string]bool{second.account: true}
	status, out = h.as(t, m, http.MethodPost, "/account/cleanup", nil, true)
	wantError(t, status, out, http.StatusConflict, "in_progress")
	if len(h.dir.boxes) != boxes {
		t.Fatal("a cleanup step ran while another held the account")
	}

	// Once it's let go, the next goes ahead.
	delete(h.dir.leased, second.account)
	for steps := 0; ; steps++ {
		if steps > 10 {
			t.Fatal("never finishes")
		}
		if status, _ := h.as(t, m, http.MethodPost, "/account/cleanup", nil, true); status == http.StatusOK {
			break
		}
	}
	if len(h.dir.leased) != 0 {
		t.Fatalf("leases left held: %v", h.dir.leased)
	}
}

// An account whose deletion stopped halfway (the app closed) takes no
// request but GET /account, which says so, and DELETE /account, which
// carries on; nothing is delivered to it meanwhile.
func TestDeleteAccountResumes(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	owner := h.account(t, userID)
	l := newLinkKeys(t)
	if status, out := h.as(t, owner, http.MethodPost, "/links", l.create(t, h.now), true); status != http.StatusCreated {
		t.Fatalf("create link: %d %v", status, out)
	}
	for range MailboxesPerDay/MailboxBatch - 1 {
		h.now = h.now.Add(time.Second)
		if status, out := h.as(t, owner, http.MethodPost, "/mailboxes", map[string]any{"count": MailboxBatch}, false); status != http.StatusCreated {
			t.Fatalf("mailboxes: %d %v", status, out)
		}
	}

	status, out := h.as(t, owner, http.MethodDelete, "/account", nil, true)
	wantError(t, status, out, http.StatusConflict, "in_progress")

	// The next launch: a new login, and the account says it's being deleted.
	again := member{d: owner.d, token: h.token(t, owner.d)}
	if status, out := h.as(t, again, http.MethodGet, "/account", nil, false); status != http.StatusOK || out["deleting"] != true {
		t.Fatalf("account: %d %v", status, out)
	}
	for _, r := range []struct {
		method, path string
		body         any
		sign         bool
	}{
		{http.MethodPost, "/mailboxes", map[string]any{"count": 1}, false},
		{http.MethodPost, "/links", newLinkKeys(t).create(t, h.now), true},
		{http.MethodGet, "/inbox", nil, false},
		{http.MethodGet, "/invitations", nil, false},
		{http.MethodPost, "/tokens", map[string]any{"blinded": []string{}}, false},
		{http.MethodPost, "/account/cleanup", nil, true},
	} {
		status, out := h.as(t, again, r.method, r.path, r.body, r.sign)
		if status != http.StatusConflict || out["error"] != "account_deleting" {
			t.Fatalf("%s %s while deleting: %d %v", r.method, r.path, status, out)
		}
	}
	mailbox := ""
	for id := range h.dir.boxes {
		mailbox = id // one the first step left
	}
	if mailbox == "" {
		t.Fatal("the first step took every mailbox")
	}
	if status, out := h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": clientEnvelope(t), "token": mintToken(t, h.now)}); status != http.StatusOK || len(out) != 0 {
		t.Fatalf("send: %d %v", status, out)
	}
	for key, items := range h.inbox.items {
		if len(items) != 0 {
			t.Fatalf("delivered to %s while deleting", key)
		}
	}

	for steps := 1; ; steps++ {
		if steps > 10 {
			t.Fatal("never finishes")
		}
		h.now = h.now.Add(time.Second)
		status, out := h.as(t, again, http.MethodDelete, "/account", nil, true)
		if status == http.StatusOK {
			break
		}
		wantError(t, status, out, http.StatusConflict, "in_progress")
	}
	if len(h.dir.accounts) != 0 || len(h.dir.boxes) != 0 || len(h.dir.telegram) != 0 {
		t.Fatalf("left behind: accounts %d, mailboxes %d, telegram %d", len(h.dir.accounts), len(h.dir.boxes), len(h.dir.telegram))
	}
}

// An account being deleted (its own signed DELETE /account started) isn't
// in use: a lookup says the Telegram user has none, and setting up again
// replaces it without the replace flag, keeping no marker of it (its
// device is then refused, as for any deleted account); what is left of it
// goes with the new account's cleanup. A live account still needs the flag.
func TestSetUpAgainOverAnAccountBeingDeleted(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	old := h.account(t, userID)
	for range MailboxesPerDay/MailboxBatch - 1 {
		h.now = h.now.Add(time.Second)
		if status, out := h.as(t, old, http.MethodPost, "/mailboxes", map[string]any{"count": MailboxBatch}, false); status != http.StatusCreated {
			t.Fatalf("mailboxes: %d %v", status, out)
		}
	}
	lookup := func() bool {
		t.Helper()
		status, out := h.post(t, "/accounts/lookup", map[string]any{"initData": launch(t, userID, "", h.now)})
		if status != http.StatusOK {
			t.Fatalf("lookup: %d %v", status, out)
		}
		return out["exists"] == true
	}
	if !lookup() {
		t.Fatal("a live account isn't found")
	}
	// Live: setting up again needs the flag.
	status, out := h.register(t, newDevice(t), false)
	wantError(t, status, out, http.StatusConflict, "account_exists")

	// The deletion starts, and stops (the app deleted only on the device).
	status, out = h.as(t, old, http.MethodDelete, "/account", nil, true)
	wantError(t, status, out, http.StatusConflict, "in_progress")
	if lookup() {
		t.Fatal("an account being deleted is found")
	}
	fresh := newDevice(t)
	if status, out := h.register(t, fresh, false); status != http.StatusOK {
		t.Fatalf("set up again: %d %v", status, out)
	}
	status, out = h.post(t, "/session", old.d.login(t, h.now))
	wantError(t, status, out, http.StatusUnauthorized, "login_refused")
	m := member{d: fresh, token: h.token(t, fresh)}
	if status, out := h.as(t, m, http.MethodGet, "/account", nil, false); status != http.StatusOK || out["cleanup"] != true || out["deleting"] != false {
		t.Fatalf("new account: %d %v", status, out)
	}
	for steps := 0; ; steps++ {
		if steps > 10 {
			t.Fatal("never finishes")
		}
		h.now = h.now.Add(time.Second)
		if status, _ := h.as(t, m, http.MethodPost, "/account/cleanup", nil, true); status == http.StatusOK {
			break
		}
	}
	for id, b := range h.dir.boxes {
		if b.Owner == old.d.account {
			t.Fatalf("mailbox %s of the old account left", id)
		}
	}
}

// Deleting an account first finishes deleting what is left of the account
// it replaced, which deleting its item would forget.
func TestDeleteAccountFinishesALeftover(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	first := h.account(t, userID)
	for range MailboxesPerDay/MailboxBatch - 1 {
		h.now = h.now.Add(time.Second)
		if status, out := h.as(t, first, http.MethodPost, "/mailboxes", map[string]any{"count": MailboxBatch}, false); status != http.StatusCreated {
			t.Fatalf("mailboxes: %d %v", status, out)
		}
	}
	second := newDevice(t)
	m := member{d: second, token: h.loggedIn(t, second, true)}
	// The replacement took a first step; 90 mailboxes need two.
	if status, out := h.as(t, m, http.MethodGet, "/account", nil, false); status != http.StatusOK || out["cleanup"] != true {
		t.Fatalf("account: %d %v", status, out)
	}
	status, out := h.as(t, m, http.MethodPost, "/account/cleanup", nil, false)
	wantError(t, status, out, http.StatusUnauthorized, "signature_rejected")

	for steps := 1; ; steps++ {
		if steps > 10 {
			t.Fatal("never finishes")
		}
		h.now = h.now.Add(time.Second)
		status, out := h.as(t, m, http.MethodDelete, "/account", nil, true)
		if status == http.StatusOK {
			break
		}
		wantError(t, status, out, http.StatusConflict, "in_progress")
	}
	if len(h.dir.boxes) != 0 || h.dir.accounts[second.account] != nil {
		t.Fatalf("left behind: mailboxes %d, account %v", len(h.dir.boxes), h.dir.accounts[second.account])
	}
}
