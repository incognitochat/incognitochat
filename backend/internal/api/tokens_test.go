package api

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"net/http"
	"testing"
	"time"

	"github.com/cloudflare/circl/blindsign/blindrsa"

	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/tokens"
)

func TestSendNeedsAFreshToken(t *testing.T) {
	h := newHarness(t)
	env := clientEnvelope(t)
	mailbox := ids.New()

	status, out := h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": env})
	wantError(t, status, out, http.StatusUnauthorized, "invalid_token")
	status, out = h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": env, "token": b64(randomBytes(t, 354))})
	wantError(t, status, out, http.StatusUnauthorized, "invalid_token")

	token := mintToken(t, h.now)
	if status, out := h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": env, "token": token}); status != http.StatusOK {
		t.Fatalf("send: %d %v", status, out)
	}
	status, out = h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": env, "token": token})
	wantError(t, status, out, http.StatusUnauthorized, "invalid_token") // spent

	// Last week's tokens still work; older ones don't.
	if status, _ := h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": env, "token": mintToken(t, h.now.Add(-tokens.Epoch))}); status != http.StatusOK {
		t.Fatalf("last week's token: %d", status)
	}
	status, out = h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": env, "token": mintToken(t, h.now.Add(-2*tokens.Epoch))})
	wantError(t, status, out, http.StatusUnauthorized, "invalid_token")
}

func TestRateLimitedSendKeepsItsToken(t *testing.T) {
	h := newHarness(t)
	env := clientEnvelope(t)
	mailbox := ids.New()
	for range SendsPerMailboxPerMinute {
		h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": env, "token": mintToken(t, h.now)})
	}
	token := mintToken(t, h.now)
	status, out := h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": env, "token": token})
	wantError(t, status, out, http.StatusTooManyRequests, "rate_limited")
	// Another mailbox, a minute later: the same token is still good.
	h.now = h.now.Add(time.Minute)
	if status, out := h.post(t, "/send", map[string]any{"mailbox": ids.New(), "envelope": env, "token": token}); status != http.StatusOK {
		t.Fatalf("token after a rate-limited send: %d %v", status, out)
	}
}

// A spent token replayed at a mailbox must not use up the mailbox's limit
// for everyone else.
func TestReplayedTokenDoesNotCountAgainstTheMailbox(t *testing.T) {
	h := newHarness(t)
	env := clientEnvelope(t)
	mailbox := ids.New()
	spent := mintToken(t, h.now)
	if status, out := h.post(t, "/send", map[string]any{"mailbox": ids.New(), "envelope": env, "token": spent}); status != http.StatusOK {
		t.Fatalf("send: %d %v", status, out)
	}
	for range 2 * SendsPerMailboxPerMinute {
		status, out := h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": env, "token": spent})
		wantError(t, status, out, http.StatusUnauthorized, "invalid_token")
	}
	if status, out := h.post(t, "/send", map[string]any{"mailbox": mailbox, "envelope": env, "token": mintToken(t, h.now)}); status != http.StatusOK {
		t.Fatalf("send after replays: %d %v", status, out)
	}
}

func TestIssueTokens(t *testing.T) {
	h := newHarness(t)
	m := h.account(t, userID)
	blinded := func(n int) []string {
		out := make([]string, n)
		for i := range out {
			// Any value below the modulus can be signed; a real client blinds a token input.
			b := randomBytes(t, testIssuer().BlindedLen())
			b[0] = 0
			out[i] = b64(b)
		}
		return out
	}
	status, out := h.as(t, m, http.MethodPost, "/tokens", map[string]any{"blinded": blinded(3)}, false)
	if status != http.StatusOK || len(out["signatures"].([]any)) != 3 || out["left"] != float64(TokensPerDay-3) {
		t.Fatalf("tokens: %d %v", status, out)
	}

	status, out = h.as(t, m, http.MethodPost, "/tokens", map[string]any{"blinded": blinded(TokenBatch + 1)}, false)
	wantError(t, status, out, http.StatusBadRequest, "bad_request")
	status, out = h.as(t, m, http.MethodPost, "/tokens", map[string]any{"blinded": []string{b64(randomBytes(t, 10))}}, false)
	wantError(t, status, out, http.StatusBadRequest, "bad_request")

	// The daily allowance: 3 used, so 197 more, then nothing.
	for range (TokensPerDay - 3) / TokenBatch {
		h.as(t, m, http.MethodPost, "/tokens", map[string]any{"blinded": blinded(TokenBatch)}, false)
	}
	rest := (TokensPerDay - 3) % TokenBatch
	if status, _ := h.as(t, m, http.MethodPost, "/tokens", map[string]any{"blinded": blinded(rest)}, false); status != http.StatusOK {
		t.Fatalf("last %d of the day: %d", rest, status)
	}
	status, out = h.as(t, m, http.MethodPost, "/tokens", map[string]any{"blinded": blinded(1)}, false)
	wantError(t, status, out, http.StatusTooManyRequests, "rate_limited")

	// Needs a login.
	status, out = h.call(t, nil, "", http.MethodPost, "/tokens", map[string]any{"blinded": blinded(1)}, false)
	wantError(t, status, out, http.StatusUnauthorized, "session_expired")

	// Media tokens have a budget of their own, untouched by the send tokens
	// above.
	for range MediaTokensPerDay / TokenBatch {
		if status, _ := h.as(t, m, http.MethodPost, "/tokens/media", map[string]any{"blinded": blinded(TokenBatch)}, false); status != http.StatusOK {
			t.Fatalf("media tokens: %d", status)
		}
	}
	if rest = MediaTokensPerDay % TokenBatch; rest > 0 {
		if status, out := h.as(t, m, http.MethodPost, "/tokens/media", map[string]any{"blinded": blinded(rest)}, false); status != http.StatusOK || len(out["signatures"].([]any)) != rest {
			t.Fatalf("last %d media tokens of the day: %d", rest, status)
		}
	}
	status, out = h.as(t, m, http.MethodPost, "/tokens/media", map[string]any{"blinded": blinded(1)}, false)
	wantError(t, status, out, http.StatusTooManyRequests, "rate_limited")
	status, out = h.call(t, nil, "", http.MethodPost, "/tokens/media", map[string]any{"blinded": blinded(1)}, false)
	wantError(t, status, out, http.StatusUnauthorized, "session_expired")
}

// fetchToken gets one token from path as an app does: it blinds a token
// input for key, asks for it to be signed with the key named (keyId; none
// if empty), and unblinds the signature, which fails unless key made it.
func fetchToken(t *testing.T, h *harness, m member, path, label string, key *tokens.Issuer, named string) (string, error) {
	t.Helper()
	id := key.KeyID()
	challenge := tokens.Challenge(label, tokens.EpochOf(h.now))
	input := binary.BigEndian.AppendUint16(nil, tokens.Type)
	input = append(append(append(input, randomBytes(t, 32)...), challenge[:]...), id[:]...)
	client, err := blindrsa.NewClient(blindrsa.SHA384PSSDeterministic, key.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	blinded, state, err := client.Blind(rand.Reader, input)
	if err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"blinded": []string{b64(blinded)}}
	if named != "" {
		body["keyId"] = named
	}
	status, out := h.as(t, m, http.MethodPost, path, body, false)
	if status != http.StatusOK {
		t.Fatalf("%s: %d %v", path, status, out)
	}
	sig, err := base64.RawURLEncoding.DecodeString(out["signatures"].([]any)[0].(string))
	if err != nil {
		t.Fatal(err)
	}
	final, err := client.Finalize(state, sig)
	if err != nil {
		return "", err
	}
	return b64(append(input, final...)), nil
}

// While a rotation lasts the api holds the new key and the old one. Each
// batch is signed with the key the app names, so an app still open on the
// old build keeps getting tokens it can use, and tokens of both keys pay
// for sends. A key it doesn't hold is refused before the batch counts
// against the day's budget. Once the old key is retired, its tokens are
// refused.
func TestIssuerKeyRotation(t *testing.T) {
	h := newHarness(t)
	m := h.account(t, userID)
	env := clientEnvelope(t)
	current, previous := testIssuer(), newTestIssuer(tokens.LabelSend)
	h.server.Issuer = keyring(current, previous)
	named := func(key *tokens.Issuer) string { id := key.KeyID(); return b64(id[:]) }

	oldToken, err := fetchToken(t, h, m, "/tokens", tokens.LabelSend, previous, named(previous))
	if err != nil {
		t.Fatalf("a batch for the previous key wasn't signed with it: %v", err)
	}
	newToken, err := fetchToken(t, h, m, "/tokens", tokens.LabelSend, current, named(current))
	if err != nil {
		t.Fatalf("a batch for the current key wasn't signed with it: %v", err)
	}
	// An app from before keys were named gets the current key.
	if _, err := fetchToken(t, h, m, "/tokens", tokens.LabelSend, current, ""); err != nil {
		t.Fatalf("a batch naming no key wasn't signed with the current one: %v", err)
	}
	unspent, err := fetchToken(t, h, m, "/tokens", tokens.LabelSend, previous, named(previous))
	if err != nil {
		t.Fatal(err)
	}
	for name, token := range map[string]string{"current": newToken, "previous": oldToken} {
		if status, out := h.post(t, "/send", map[string]any{"mailbox": ids.New(), "envelope": env, "token": token}); status != http.StatusOK {
			t.Fatalf("send with the %s key's token: %d %v", name, status, out)
		}
	}

	// Unknown and malformed key IDs cost nothing: 4 counted so far.
	blinded := make([]string, TokenBatch)
	for i := range blinded {
		b := randomBytes(t, current.BlindedLen())
		b[0] = 0
		blinded[i] = b64(b)
	}
	status, out := h.as(t, m, http.MethodPost, "/tokens", map[string]any{"blinded": blinded, "keyId": b64(randomBytes(t, 32))}, false)
	wantError(t, status, out, http.StatusConflict, "unknown_issuer_key")
	for _, bad := range []string{b64(randomBytes(t, 31)), b64(randomBytes(t, 33)), "not base64!"} {
		status, out := h.as(t, m, http.MethodPost, "/tokens", map[string]any{"blinded": blinded, "keyId": bad}, false)
		wantError(t, status, out, http.StatusBadRequest, "bad_request")
	}
	// Nor is another kind's key one of these: the media key isn't a send
	// key, nor the send key a media key.
	mediaID := testMediaIssuer().KeyID()
	status, out = h.as(t, m, http.MethodPost, "/tokens", map[string]any{"blinded": blinded, "keyId": b64(mediaID[:])}, false)
	wantError(t, status, out, http.StatusConflict, "unknown_issuer_key")
	status, out = h.as(t, m, http.MethodPost, "/tokens/media", map[string]any{"blinded": blinded, "keyId": named(current)}, false)
	wantError(t, status, out, http.StatusConflict, "unknown_issuer_key")
	status, out = h.as(t, m, http.MethodPost, "/tokens", map[string]any{"blinded": blinded[:1], "keyId": named(current)}, false)
	if status != http.StatusOK || out["left"] != float64(TokensPerDay-5) {
		t.Fatalf("send tokens after refused key IDs: %d %v", status, out)
	}
	status, out = h.as(t, m, http.MethodPost, "/tokens/media", map[string]any{"blinded": blinded[:1], "keyId": b64(mediaID[:])}, false)
	if status != http.StatusOK || out["left"] != float64(MediaTokensPerDay-1) {
		t.Fatalf("media tokens after a refused key ID: %d %v", status, out)
	}

	// The previous key retired: its tokens, even unspent ones, are refused,
	// and so is a batch for it.
	h.server.Issuer = keyring(current, nil)
	status, out = h.post(t, "/send", map[string]any{"mailbox": ids.New(), "envelope": env, "token": unspent})
	wantError(t, status, out, http.StatusUnauthorized, "invalid_token")
	status, out = h.as(t, m, http.MethodPost, "/tokens", map[string]any{"blinded": blinded[:1], "keyId": named(previous)}, false)
	wantError(t, status, out, http.StatusConflict, "unknown_issuer_key")
	if status, out := h.post(t, "/send", map[string]any{"mailbox": ids.New(), "envelope": env, "token": mintToken(t, h.now)}); status != http.StatusOK {
		t.Fatalf("send with the current key's token after retiring the previous: %d %v", status, out)
	}
}
