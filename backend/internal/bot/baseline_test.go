package bot

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

// What the bot says, recorded before its texts came from one table of
// languages: each Telegram language code's reply and button, and the
// setup's calls. A difference here is a change people would see.
func TestBaselineReplies(t *testing.T) {
	const (
		enWelcome = "Incognito Chat lets people message you anonymously, end-to-end encrypted. Open the app to set up or to read your messages."
		enOpen    = "Open Incognito Chat"
		faWelcome = "با چت ناشناس دیگران می‌توانند ناشناس و با رمزنگاری سرتاسری به شما پیام بدهند. برای راه‌اندازی یا خواندن پیام‌ها، برنامه را باز کنید."
		faOpen    = "باز کردن چت ناشناس"
	)
	b := &Bot{Secret: secret, AppURL: "https://example.github.io/"}
	for _, tc := range []struct{ from, text, button string }{
		{`"from":{"id":1,"language_code":"en"},`, enWelcome, enOpen},
		{`"from":{"id":1,"language_code":"fa"},`, faWelcome, faOpen},
		{`"from":{"id":1,"language_code":"fa-IR"},`, faWelcome, faOpen},
		{`"from":{"id":1,"language_code":"FA"},`, faWelcome, faOpen},
		{`"from":{"id":1,"language_code":"qaa"},`, enWelcome, enOpen},
		{`"from":{"id":1,"language_code":""},`, enWelcome, enOpen},
		{`"from":{"id":1},`, enWelcome, enOpen},
		{``, enWelcome, enOpen},
		// Telegram writes codes with "-"; one with "_" is English here (notices
		// read it as Persian).
		{`"from":{"id":1,"language_code":"fa_IR"},`, enWelcome, enOpen},
	} {
		out := reply(t, b.Handle(request(secret, `{"message":{"message_id":5,"chat":{"id":42,"type":"private"},`+tc.from+`"text":"/start"}}`)))
		button := out["reply_markup"].(map[string]any)["inline_keyboard"].([]any)[0].([]any)[0].(map[string]any)
		if out["text"] != tc.text || button["text"] != tc.button {
			t.Errorf("%s: text %q, button %q", tc.from, out["text"], button["text"])
		}
	}
}

func TestBaselineSetup(t *testing.T) {
	var bodies []map[string]any
	var paths []string
	telegram := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		bodies = append(bodies, body)
		_, _ = w.Write([]byte(`{"ok":true,"result":true}`))
	}))
	defer telegram.Close()
	s := Setup{Token: "1:T", Secret: secret, AppURL: "https://example.github.io/", API: telegram.URL}
	if err := s.Run(context.Background(), "https://abc.lambda-url.us-east-1.on.aws/"); err != nil {
		t.Fatal(err)
	}
	want := []map[string]any{
		{"url": "https://abc.lambda-url.us-east-1.on.aws/", "secret_token": secret, "allowed_updates": []any{"message"}, "max_connections": float64(10)},
		{"menu_button": map[string]any{"type": "web_app", "text": "Open", "web_app": map[string]any{"url": "https://example.github.io/"}}},
		{"commands": []any{map[string]any{"command": "start", "description": "Open Incognito Chat"}}},
		{"commands": []any{map[string]any{"command": "start", "description": "باز کردن چت ناشناس"}}, "language_code": "fa"},
	}
	if len(paths) != 4 || paths[0] != "/bot1:T/setWebhook" || paths[1] != "/bot1:T/setChatMenuButton" || paths[2] != "/bot1:T/setMyCommands" || paths[3] != "/bot1:T/setMyCommands" {
		t.Fatalf("calls = %v", paths)
	}
	if !reflect.DeepEqual(bodies, want) {
		t.Fatalf("bodies = %v", bodies)
	}
}
