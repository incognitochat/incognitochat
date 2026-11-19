package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/lambda"

	"github.com/incognitochat/incognitochat/backend/internal/awsconf"
	"github.com/incognitochat/incognitochat/backend/internal/bot"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/logx"
	"github.com/incognitochat/incognitochat/backend/internal/telegram/botapi"
)

func TestHandleRoutesEvents(t *testing.T) {
	b := &bot.Bot{Secret: "s", AppURL: "https://example.github.io/"}
	var setupURL string
	setup := func(_ context.Context, url string) error { setupURL = url; return nil }

	out, err := handle(context.Background(), json.RawMessage(`{"setup":{"webhookUrl":"https://x.lambda-url.us-east-1.on.aws/"}}`), b, setup)
	if err != nil || setupURL != "https://x.lambda-url.us-east-1.on.aws/" {
		t.Fatalf("setup: %v, %v, %q", out, err, setupURL)
	}

	// A function URL request without the secret is a 404, and never a setup.
	setupURL = ""
	out, err = handle(context.Background(), json.RawMessage(`{"rawPath":"/","requestContext":{"http":{"method":"POST"}},"body":"{}"}`), b, setup)
	if err != nil || out.(httpapi.Response).StatusCode != http.StatusNotFound || setupURL != "" {
		t.Fatalf("webhook: %v, %v", out, err)
	}
	out, _ = handle(context.Background(), json.RawMessage(`{"rawPath":"/","requestContext":{"http":{"method":"POST"}},"headers":{"x-telegram-bot-api-secret-token":"s"},"body":"{\"message\":{\"message_id\":1,\"chat\":{\"id\":2,\"type\":\"private\"},\"text\":\"/start\"}}"}`), b, setup)
	if resp := out.(httpapi.Response); resp.StatusCode != http.StatusOK || resp.Body == "" {
		t.Fatalf("start: %+v", resp)
	}

	if _, err := handle(context.Background(), json.RawMessage(`[`), b, setup); err == nil {
		t.Fatal("accepted a broken event")
	}
}

// A failed setup reaches Lambda as awsconf.ErrFailed's constant text, and
// is logged by its kind and, for a Bot API call, method and answer
// (PRV-4, BOT-8).
func TestInvocationFailsWithConstantText(t *testing.T) {
	b := &bot.Bot{Secret: "s", AppURL: "https://example.github.io/"}
	var buf bytes.Buffer
	failing := func(context.Context, string) error {
		return fmt.Errorf("123:SECRET-TOKEN: %w", &botapi.Error{Method: "setWebhook", Status: 401, Code: 401})
	}
	h := lambda.NewHandler(invocation(logx.New(&buf, "bot"), b, failing))
	_, err := h.Invoke(context.Background(), []byte(`{"setup":{"webhookUrl":"https://x.lambda-url.us-east-1.on.aws/"}}`))
	if err != awsconf.ErrFailed {
		t.Fatalf("Lambda got %v", err)
	}
	logged := buf.String()
	if strings.Contains(logged, "SECRET") || !strings.Contains(logged, `"msg":"setup failed"`) ||
		!strings.Contains(logged, `"method":"setWebhook","status":401,"error_code":401`) {
		t.Fatalf("logged %s", logged)
	}
	ok := func(context.Context, string) error { return nil }
	out, err := lambda.NewHandler(invocation(logx.New(&buf, "bot"), b, ok)).Invoke(context.Background(), []byte(`{"setup":{"webhookUrl":"https://x.lambda-url.us-east-1.on.aws/"}}`))
	if err != nil || string(out) != `{"ok":true}` {
		t.Fatalf("setup: %s, %v", out, err)
	}
}
