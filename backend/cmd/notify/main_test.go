package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/lambda"

	"github.com/incognitochat/incognitochat/backend/internal/awsconf"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/logx"
	"github.com/incognitochat/incognitochat/backend/internal/notices"
	"github.com/incognitochat/incognitochat/backend/internal/telegram/botapi"
)

type fakeNotifier struct {
	notified string
	checked  bool
	err      error
}

func (f *fakeNotifier) Notify(_ context.Context, account string) error {
	f.notified = account
	return f.err
}

func (f *fakeNotifier) Check(context.Context) error {
	f.checked = true
	return f.err
}

func TestHandle(t *testing.T) {
	sealer, _ := notices.NewSealer(bytes.Repeat([]byte("k"), 32))
	n := &fakeNotifier{}

	out, err := handle(context.Background(), json.RawMessage(`{"seal":{"chat":4242}}`), sealer, n)
	if err != nil {
		t.Fatal(err)
	}
	sealed, _ := base64.RawURLEncoding.DecodeString(out.(notices.SealResult).Sealed)
	if chat, err := sealer.Open(sealed); err != nil || chat != 4242 {
		t.Fatalf("sealed = %d, %v", chat, err)
	}
	account := ids.New()
	if _, err := handle(context.Background(), json.RawMessage(`{"notify":{"account":"`+account+`"}}`), sealer, n); err != nil || n.notified != account {
		t.Fatalf("notify: %v, %q", err, n.notified)
	}
	n.notified = "untouched"
	if _, err := handle(context.Background(), json.RawMessage(`{"notify":{"account":""}}`), sealer, n); err != nil || n.notified != "untouched" {
		t.Fatalf("empty account: %v, %q", err, n.notified)
	}
	// The deploy's check: a refused call fails the invocation.
	if _, err := handle(context.Background(), json.RawMessage(`{"check":{}}`), sealer, n); err != nil || !n.checked {
		t.Fatalf("check: %v, %v", err, n.checked)
	}
	n.err = errors.New("AccessDenied")
	if _, err := handle(context.Background(), json.RawMessage(`{"check":{}}`), sealer, n); err == nil {
		t.Fatal("a failed check succeeded")
	}
	for _, bad := range []string{`{}`, `[`, `{"seal":{"chat":0}}`, `{"notify":{"account":"x"}}`} {
		if _, err := handle(context.Background(), json.RawMessage(bad), sealer, n); err == nil {
			t.Errorf("%s: accepted", bad)
		}
	}
}

// Whatever fails, Lambda gets awsconf.ErrFailed's constant text, and the
// log the failure's kind and, for a Bot API call, method and answer
// (PRV-4, BOT-8).
func TestInvocationFailsWithConstantText(t *testing.T) {
	sealer, _ := notices.NewSealer(bytes.Repeat([]byte("k"), 32))
	account := ids.New()
	var buf bytes.Buffer
	n := &fakeNotifier{err: errors.Join(
		fmt.Errorf("Quiet %s: %w", account, errors.New("ProvisionedThroughputExceededException")),
		&botapi.Error{Method: "sendMessage", Status: 400, Code: 400},
	)}
	h := lambda.NewHandler(invocation(logx.New(&buf, "notify"), sealer, n))
	_, err := h.Invoke(context.Background(), []byte(`{"notify":{"account":"`+account+`"}}`))
	if err != awsconf.ErrFailed {
		t.Fatalf("Lambda got %v", err)
	}
	logged := buf.String()
	if strings.Contains(logged, account) || strings.Contains(logged, "Provisioned") || !strings.Contains(logged, `"msg":"notify failed"`) ||
		!strings.Contains(logged, `"method":"sendMessage","tg_status":400,"error_code":400`) {
		t.Fatalf("logged %s", logged)
	}
	if _, err := h.Invoke(context.Background(), []byte(`{"seal":{"chat":0}}`)); err != awsconf.ErrFailed {
		t.Fatalf("a bad event: Lambda got %v", err)
	}
	out, err := h.Invoke(context.Background(), []byte(`{"seal":{"chat":4242}}`))
	if err != nil || !strings.Contains(string(out), `"sealed"`) {
		t.Fatalf("seal: %s, %v", out, err)
	}
}

// A notice refused by flood control isn't the function's failure, but
// whatever failed with it (keeping the quiet period, say) is logged and
// returned.
func TestReport(t *testing.T) {
	var buf bytes.Buffer
	log := logx.New(&buf, "notify")
	other := errors.New("table unavailable")
	for _, tc := range []struct {
		err   error
		fails bool
		logs  []string
	}{
		{err: nil},
		{err: notices.ErrRateLimited, logs: []string{"notice refused by flood control"}},
		{err: errors.Join(notices.ErrRateLimited, other), fails: true, logs: []string{"notice refused by flood control", "notify failed"}},
		{err: other, fails: true, logs: []string{"notify failed"}},
	} {
		buf.Reset()
		err := report(log, tc.err)
		if (err != nil) != tc.fails || (err != nil && (!errors.Is(err, other) || errors.Is(err, notices.ErrRateLimited))) {
			t.Errorf("report(%v) = %v", tc.err, err)
		}
		lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
		if len(tc.logs) == 0 && buf.Len() != 0 || len(tc.logs) > 0 && len(lines) != len(tc.logs) {
			t.Errorf("report(%v) logged %q", tc.err, buf.String())
			continue
		}
		for i, msg := range tc.logs {
			if !strings.Contains(lines[i], `"msg":"`+msg+`"`) {
				t.Errorf("report(%v) line %d: %s", tc.err, i, lines[i])
			}
		}
	}
}
