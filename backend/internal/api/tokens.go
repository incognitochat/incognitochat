package api

import (
	"context"
	"encoding/base64"
	"net/http"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
)

const (
	// TokenBatch is the most tokens one request signs.
	TokenBatch = 50
	// TokensPerDay limits the send tokens an account gets per UTC day, and
	// with them the messages it can send to other people.
	TokensPerDay = 200
	// MediaTokensPerDay limits the media tokens an account gets per UTC day.
	// One pays for a started MiB of upload, so this is 1 GiB a day.
	MediaTokensPerDay = 1024
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
	// Unspend gives back a token Spend just took.
	Unspend(ctx context.Context, nonce []byte) error
}

// issueTokens signs a batch of blinded send tokens for a logged-in device.
// The issuer can't see the tokens, so it can't link their later use to the
// account.
func (s *Server) issueTokens(ctx context.Context, req httpapi.Request, c caller) httpapi.Response {
	return s.signTokens(ctx, req, "POST /tokens", s.Issuer, "tok#"+c.AccountID, TokensPerDay)
}

// issueMediaTokens does the same for media tokens, which pay for uploads.
// They have their own issuer key and their own daily budget.
func (s *Server) issueMediaTokens(ctx context.Context, req httpapi.Request, c caller) httpapi.Response {
	if s.MediaIssuer == nil {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	return s.signTokens(ctx, req, "POST /tokens/media", s.MediaIssuer, "mtok#"+c.AccountID, MediaTokensPerDay)
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
	return httpapi.JSON(http.StatusOK, map[string][]string{"signatures": signatures})
}
