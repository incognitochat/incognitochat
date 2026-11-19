package main

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"maps"
	"slices"
	"sync"
	"testing"
	"time"

	awsv2 "github.com/aws/aws-sdk-go-v2/aws"

	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/inbox"
	"github.com/incognitochat/incognitochat/backend/internal/media"
	"github.com/incognitochat/incognitochat/backend/internal/notices"
	"github.com/incognitochat/incognitochat/backend/internal/push"
	"github.com/incognitochat/incognitochat/backend/internal/session"
	"github.com/incognitochat/incognitochat/backend/internal/telegram/initdata"
	"github.com/incognitochat/incognitochat/backend/internal/tokens"
)

// issuerKeys returns three issuer keys as PEM, made once.
var issuerKeys = sync.OnceValue(func() []string {
	var out []string
	for range 3 {
		key, err := rsa.GenerateKey(rand.Reader, tokens.ModulusBits)
		if err != nil {
			panic(err)
		}
		der, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			panic(err)
		}
		out = append(out, string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})))
	}
	return out
})

var (
	sessionKey = bytes.Repeat([]byte("s"), 32)
	pepper     = bytes.Repeat([]byte("p"), 32)
)

// testConfig is a function's environment and the parameters it names, as
// setup would load them.
func testConfig(t *testing.T) (env, params map[string]string) {
	t.Helper()
	keys := issuerKeys()
	env = map[string]string{
		"TABLE_DIRECTORY":                 "t-directory",
		"TABLE_EPHEMERAL":                 "t-ephemeral",
		"TABLE_MESSAGES":                  "t-messages",
		"NOTIFY_FUNCTION":                 "fn-notify",
		"WS_FUNCTION":                     "fn-ws",
		"MEDIA_BUCKET":                    "b-media",
		"PARAM_BOT_ID":                    "/p/bot-id",
		"PARAM_SESSION_KEY":               "/p/session-key",
		"PARAM_TELEGRAM_ID_PEPPER":        "/p/pepper",
		"PARAM_ISSUER_KEY":                "/p/issuer",
		"PARAM_MEDIA_ISSUER_KEY":          "/p/media-issuer",
		"PARAM_PREVIOUS_ISSUER_KEY":       "/p/previous-issuer",
		"PARAM_PREVIOUS_MEDIA_ISSUER_KEY": "/p/previous-media-issuer",
		"ADMIN_TELEGRAM_IDS":              "42, 7",
	}
	params = map[string]string{
		"/p/bot-id":                "123456",
		"/p/session-key":           string(sessionKey),
		"/p/pepper":                string(pepper),
		"/p/issuer":                keys[0],
		"/p/media-issuer":          keys[1],
		"/p/previous-issuer":       tokens.NoKey,
		"/p/previous-media-issuer": tokens.NoKey,
	}
	return env, params
}

func getter(env map[string]string) func(string) string {
	return func(name string) string { return env[name] }
}

func keyID(t *testing.T, pemKey string) [32]byte {
	t.Helper()
	i, err := tokens.NewIssuer([]byte(pemKey), tokens.LabelSend)
	if err != nil {
		t.Fatal(err)
	}
	return i.KeyID()
}

// Each store and client is wired to its own table, function or bucket,
// with the keys from Parameter Store, and admins are known only by the
// keyed hash of their Telegram IDs.
func TestNewServer(t *testing.T) {
	env, params := testConfig(t)
	keys := issuerKeys()
	params["/p/previous-issuer"] = keys[2]
	s, err := newServer(awsv2.Config{Region: "us-east-1"}, getter(env), params)
	if err != nil {
		t.Fatal(err)
	}

	if s.Telegram.BotID != 123456 || !bytes.Equal(s.Telegram.Key, initdata.ProductionKey) {
		t.Errorf("Telegram verifier for bot %d", s.Telegram.BotID)
	}
	// Sessions are those of the session key.
	same, _ := session.NewIssuer(map[byte][]byte{1: sessionKey}, 1)
	token, _, err := same.Issue(ids.New(), ids.New(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Sessions.Verify(token, time.Now()); err != nil {
		t.Errorf("a session of the session key: %v", err)
	}
	if !bytes.Equal(s.Pepper, pepper) || s.Now == nil || !s.InviteOnly {
		t.Errorf("pepper %q, invite-only %v", s.Pepper, s.InviteOnly)
	}

	want := map[string]bool{directory.TelegramHash(pepper, 42): true, directory.TelegramHash(pepper, 7): true}
	if !maps.Equal(s.Admins, want) {
		t.Errorf("admins %v", s.Admins)
	}

	if got := s.Issuer.(*tokens.Keyring).KeyIDs(); !slices.Equal(got, [][32]byte{keyID(t, keys[0]), keyID(t, keys[2])}) {
		t.Errorf("send keys %x", got)
	}
	if got := s.MediaIssuer.(*tokens.Keyring).KeyIDs(); !slices.Equal(got, [][32]byte{keyID(t, keys[1])}) {
		t.Errorf("media keys %x", got)
	}

	dir := s.Directory.(*directory.Store)
	if dir.Table != "t-directory" || s.Switches.(*directory.Store) != dir {
		t.Errorf("directory %q, switches %v", dir.Table, s.Switches)
	}
	for name, table := range map[string]string{
		"nonces":  s.Nonces.(*ephemeral.Nonces).Table,
		"limits":  s.Limits.(*ephemeral.Limiter).Table,
		"spent":   s.Spent.(*ephemeral.Spent).Table,
		"uploads": s.Uploads.(*ephemeral.Uploads).Table,
		"sockets": s.Sockets.(*ephemeral.Sockets).Table,
	} {
		if table != "t-ephemeral" {
			t.Errorf("%s in %q", name, table)
		}
	}
	if table := s.Inbox.(*inbox.Store).Table; table != "t-messages" {
		t.Errorf("messages in %q", table)
	}
	if key := s.Sockets.(*ephemeral.Sockets).Key; !bytes.Equal(key, ephemeral.SocketKey(sessionKey)) {
		t.Errorf("socket key %x", key)
	}
	if fn := s.Notices.(*notices.Client).Function; fn != "fn-notify" {
		t.Errorf("notices to %q", fn)
	}
	if fn := s.Push.(*push.Client).Function; fn != "fn-ws" {
		t.Errorf("pushes to %q", fn)
	}
	if b := s.Media.(*media.Bucket); b.Name != "b-media" || b.Presign == nil || b.S3 == nil {
		t.Errorf("media bucket %q", b.Name)
	}

	env["INVITE_ONLY"] = "false"
	delete(env, "ADMIN_TELEGRAM_IDS")
	if s, err := newServer(awsv2.Config{Region: "us-east-1"}, getter(env), params); err != nil || s.InviteOnly || len(s.Admins) != 0 {
		t.Errorf("open, without admins: %v", err)
	}
}

// A function with a setting or key that can't work doesn't start.
func TestNewServerRefuses(t *testing.T) {
	keys := issuerKeys()
	for name, change := range map[string]func(env, params map[string]string){
		"a missing table":                           func(env, _ map[string]string) { delete(env, "TABLE_MESSAGES") },
		"bot ID 0":                                  func(_, p map[string]string) { p["/p/bot-id"] = "0" },
		"a negative bot ID":                         func(_, p map[string]string) { p["/p/bot-id"] = "-123456" },
		"a bot ID that isn't":                       func(_, p map[string]string) { p["/p/bot-id"] = "bot" },
		"a short pepper":                            func(_, p map[string]string) { p["/p/pepper"] = string(pepper[:31]) },
		"a short session key":                       func(_, p map[string]string) { p["/p/session-key"] = "short" },
		"a broken issuer key":                       func(_, p map[string]string) { p["/p/issuer"] = "-----BEGIN PRIVATE KEY-----" },
		"a broken previous key":                     func(_, p map[string]string) { p["/p/previous-media-issuer"] = "" },
		"the same previous key":                     func(_, p map[string]string) { p["/p/previous-issuer"] = keys[0] },
		"one key for both kinds":                    func(_, p map[string]string) { p["/p/media-issuer"] = keys[0] },
		"a previous send key that is the media key": func(_, p map[string]string) { p["/p/previous-issuer"] = keys[1] },
		"a previous media key that is the send key": func(_, p map[string]string) { p["/p/previous-media-issuer"] = keys[0] },
		"an admin ID that isn't":                    func(env, _ map[string]string) { env["ADMIN_TELEGRAM_IDS"] = "42,@admin" },
	} {
		env, params := testConfig(t)
		change(env, params)
		if _, err := newServer(awsv2.Config{Region: "us-east-1"}, getter(env), params); err == nil {
			t.Errorf("%s: started", name)
		}
	}
}
