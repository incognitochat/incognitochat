package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"net/http"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/envelope"
	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
)

const (
	// TokenBatch is the most tokens one request signs.
	TokenBatch = 50
	// TokensPerDay limits the send tokens a person (Telegram user) gets per
	// UTC day, and with them what it can send to other people: every
	// message, receipt, reaction, edit and delete spends one per started
	// 2.5 KiB of envelope (envelope.TokensFor). All of them but texts
	// longer than about 1,700 bytes cost one, so this is still about 1,000
	// messages; in bytes, at most 2.5 MB of envelopes, about 3,000 write
	// units to store and as many to delete.
	TokensPerDay = 1000
	// MediaTokensPerDay limits the media tokens a person gets per UTC day.
	// One pays for a started MiB of upload, so this is 500 MiB a day.
	MediaTokensPerDay = 500
)

// Issuer signs and checks anonymous send tokens (internal/tokens).
type Issuer interface {
	Sign(blinded []byte) ([]byte, error)
	Check(token []byte, now time.Time) (nonce []byte, forgetAfter time.Time, err error)
	BlindedLen() int
}

// Spent remembers spent tokens.
type Spent interface {
	Spend(ctx context.Context, nonce []byte, forgetAfter time.Time) (bool, error)
	// SpendAll spends several tokens, in order, up to the first spent
	// already; those before it stay spent (ephemeral.Spent.SpendAll).
	SpendAll(ctx context.Context, tokens []ephemeral.TokenNonce) (bool, error)
	// Unspend gives back a token Spend or SpendAll just took.
	Unspend(ctx context.Context, nonce []byte) error
}

// sendTokens checks the send tokens that pay for an envelope of size bytes,
// before any is spent, and returns them to spend, or the answer that
// refuses them:
//   - none at all: invalid_token, as before;
//   - fewer or more than it costs (envelope.TokensFor): tokens_needed, with
//     how many, so the app takes that many and tries again (an app from
//     before envelopes were priced by size sends one, whatever the size; an
//     app from before a price cut sends more);
//   - both token and tokens: bad_request;
//   - any that isn't a valid send token of this week or last, or one twice:
//     invalid_token.
//
// The app sends one token as token, and several as tokens.
func (s *Server) sendTokens(in sendRequest, size int, now time.Time) ([]ephemeral.TokenNonce, *httpapi.Response) {
	refuse := func(r httpapi.Response) ([]ephemeral.TokenNonce, *httpapi.Response) { return nil, &r }
	raw := in.Tokens
	if in.Token != "" {
		if len(raw) > 0 {
			return refuse(httpapi.Error(http.StatusBadRequest, "bad_request"))
		}
		raw = []string{in.Token}
	}
	needed := envelope.TokensFor(size)
	switch {
	case len(raw) == 0:
		return refuse(httpapi.Error(http.StatusUnauthorized, "invalid_token"))
	case len(raw) != needed:
		return refuse(tokensNeeded(needed))
	}
	out := make([]ephemeral.TokenNonce, len(raw))
	for i, t := range raw {
		token, err := base64.RawURLEncoding.Strict().DecodeString(t)
		if err != nil {
			return refuse(httpapi.Error(http.StatusUnauthorized, "invalid_token"))
		}
		nonce, forgetAfter, err := s.Issuer.Check(token, now)
		if err != nil {
			return refuse(httpapi.Error(http.StatusUnauthorized, "invalid_token"))
		}
		for _, prev := range out[:i] {
			if bytes.Equal(prev.Nonce, nonce) {
				return refuse(httpapi.Error(http.StatusUnauthorized, "invalid_token"))
			}
		}
		out[i] = ephemeral.TokenNonce{Nonce: nonce, ForgetAfter: forgetAfter}
	}
	return out, nil
}

// tokensNeeded refuses a send that brought fewer or more tokens than its
// envelope costs, before any is spent: 402 tokens_needed, with how many it
// costs.
func tokensNeeded(n int) httpapi.Response {
	return httpapi.JSON(http.StatusPaymentRequired, map[string]any{"error": "tokens_needed", "needed": n})
}

// unspendAll gives back tokens SpendAll just took, each the first time
// only (ephemeral.Spent.Unspend). It tries every one, and returns the
// first error.
func (s *Server) unspendAll(ctx context.Context, tokens []ephemeral.TokenNonce) error {
	var first error
	for _, t := range tokens {
		if err := s.Spent.Unspend(ctx, t.Nonce); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// issueTokens signs a batch of blinded send tokens for a logged-in device.
// The issuer can't see the tokens, so it can't link their later use to the
// account.
func (s *Server) issueTokens(ctx context.Context, req httpapi.Request, c caller) httpapi.Response {
	return s.signTokens(ctx, req, "POST /tokens", s.Issuer, "tok#"+c.person(), TokensPerDay)
}

// issueMediaTokens does the same for media tokens, which pay for uploads.
// They have their own issuer key and their own daily budget.
func (s *Server) issueMediaTokens(ctx context.Context, req httpapi.Request, c caller) httpapi.Response {
	if s.MediaIssuer == nil {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	return s.signTokens(ctx, req, "POST /tokens/media", s.MediaIssuer, "mtok#"+c.person(), MediaTokensPerDay)
}

func (s *Server) signTokens(ctx context.Context, req httpapi.Request, route string, issuer Issuer, limitKey string, perDay int) httpapi.Response {
	var in struct {
		Blinded []string `json:"blinded"`
	}
	if err := httpapi.DecodeJSON(req, &in); err != nil {
		return httpapi.DecodeError(err)
	}
	if len(in.Blinded) == 0 || len(in.Blinded) > TokenBatch {
		return httpapi.Error(http.StatusBadRequest, "bad_request")
	}
	blinded := make([][]byte, len(in.Blinded))
	for i, b := range in.Blinded {
		raw, err := base64.RawURLEncoding.Strict().DecodeString(b)
		if err != nil || len(raw) != issuer.BlindedLen() {
			return httpapi.Error(http.StatusBadRequest, "bad_request")
		}
		blinded[i] = raw
	}
	ok, err := s.Limits.AllowN(ctx, limitKey, len(blinded), perDay, 24*time.Hour)
	if err != nil {
		return s.internal(route, err)
	}
	if !ok {
		return httpapi.Error(http.StatusTooManyRequests, "rate_limited")
	}
	signatures := make([]string, len(blinded))
	for i, b := range blinded {
		sig, err := issuer.Sign(b)
		if err != nil {
			return httpapi.Error(http.StatusBadRequest, "bad_request")
		}
		signatures[i] = base64.RawURLEncoding.EncodeToString(sig)
	}
	// How many more it can have today, so the app can say when it runs low:
	// as AllowN just counted.
	used := s.Limits.Counted(limitKey, 24*time.Hour)
	return httpapi.JSON(http.StatusOK, map[string]any{"signatures": signatures, "left": max(perDay-used, 0)})
}
