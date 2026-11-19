package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/incognitochat/incognitochat/backend/internal/bot"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
)

// A function URL request, whatever its method, path, headers and body, is
// a webhook request and never the deploy's setup call: nobody outside can
// put a key next to the request's own. It is answered 200 (with nothing,
// or one Bot API method for Telegram to run) or 404.
func FuzzWebhookEvent(f *testing.F) {
	f.Add("POST", "/", "x-telegram-bot-api-secret-token", "s", `{"message":{"message_id":1,"chat":{"id":2,"type":"private"},"text":"/start"}}`, false)
	f.Add("POST", "/", "X-Telegram-Bot-Api-Secret-Token", "s", `{"message":{"message_id":1,"chat":{"id":2,"type":"private"},"write_access_allowed":{}}}`, false)
	f.Add("POST", "", "x-telegram-bot-api-secret-token", "s", base64.StdEncoding.EncodeToString([]byte(`{"message":{"message_id":1,"chat":{"id":2,"type":"private"},"text":"x"}}`)), true)
	f.Add("POST", "/", "setup", `{"webhookUrl":"https://example.invalid/"}`, `{"setup":{"webhookUrl":"https://example.invalid/"}}`, false)
	f.Add("GET", "/setup", "x-telegram-bot-api-secret-token", "wrong", "", false)
	f.Fuzz(func(t *testing.T, method, path, header, value, body string, encoded bool) {
		var req httpapi.Request
		req.RequestContext.HTTP.Method = method
		req.RawPath = path
		req.Headers = map[string]string{header: value}
		req.Body = body
		req.IsBase64Encoded = encoded
		raw, err := json.Marshal(req)
		if err != nil {
			t.Fatal(err)
		}
		b := &bot.Bot{Secret: "s", AppURL: "https://example.invalid/"}
		setup := func(context.Context, string) error {
			t.Fatalf("a function URL request ran the setup: %s", raw)
			return nil
		}
		out, err := handle(context.Background(), raw, b, setup)
		if err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		resp, ok := out.(httpapi.Response)
		if !ok {
			t.Fatalf("answered %#v", out)
		}
		checkAnswer(t, resp)
	})
}

// Any webhook body from Telegram (with the secret) is answered 200, with
// nothing or with one Bot API method, and never makes the bot panic.
func FuzzWebhookUpdate(f *testing.F) {
	f.Add(`{"message":{"message_id":1,"chat":{"id":2,"type":"private"},"text":"/start","from":{"language_code":"fa"}}}`)
	f.Add(`{"message":{"message_id":1,"chat":{"id":2,"type":"private"},"write_access_allowed":{}}}`)
	f.Add(`{"message":{"message_id":1,"chat":{"id":2,"type":"group"},"text":"x"}}`)
	f.Add(`{"message":{"chat":{"type":"private"},"text":"x","from":null}}`)
	f.Add(`{"message":null}`)
	f.Add(`[`)
	f.Fuzz(func(t *testing.T, body string) {
		b := &bot.Bot{Secret: "s", AppURL: "https://example.invalid/"}
		var req httpapi.Request
		req.RequestContext.HTTP.Method = http.MethodPost
		req.RawPath = "/"
		req.Headers = map[string]string{bot.SecretHeader: "s"}
		req.Body = body
		resp := b.Handle(req)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%q answered %d", body, resp.StatusCode)
		}
		checkAnswer(t, resp)
	})
}

// checkAnswer fails for an answer that is neither a 404, an empty 200, nor
// a 200 with one Bot API method the bot uses.
func checkAnswer(t *testing.T, resp httpapi.Response) {
	t.Helper()
	switch {
	case resp.StatusCode == http.StatusNotFound:
	case resp.StatusCode == http.StatusOK && resp.Body == "":
	case resp.StatusCode == http.StatusOK:
		var m map[string]any
		if err := json.Unmarshal([]byte(resp.Body), &m); err != nil {
			t.Fatalf("answered %q", resp.Body)
		}
		if m["method"] != "sendMessage" && m["method"] != "deleteMessage" {
			t.Fatalf("answered with method %v", m["method"])
		}
	default:
		t.Fatalf("answered %d", resp.StatusCode)
	}
}

// Any event the function is invoked with: handle never panics, and runs
// the setup only for an event that has a setup key.
func FuzzEvent(f *testing.F) {
	f.Add(`{"setup":{"webhookUrl":"https://example.invalid/"}}`)
	f.Add(`{"Setup":{}}`)
	f.Add(`{"setup":null}`)
	f.Add(`{"rawPath":"/","requestContext":{"http":{"method":"POST"}},"headers":{"x-telegram-bot-api-secret-token":"s"},"body":"{}"}`)
	f.Add(`[`)
	f.Fuzz(func(t *testing.T, raw string) {
		b := &bot.Bot{Secret: "s", AppURL: "https://example.invalid/"}
		ran := false
		setup := func(context.Context, string) error { ran = true; return nil }
		out, err := handle(context.Background(), json.RawMessage(raw), b, setup)
		if err != nil {
			return
		}
		var e event
		if json.Unmarshal([]byte(raw), &e) != nil || ran != (e.Setup != nil) {
			t.Fatalf("%q: setup ran %v", raw, ran)
		}
		if !ran {
			checkAnswer(t, out.(httpapi.Response))
		}
	})
}
