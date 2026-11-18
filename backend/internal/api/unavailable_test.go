package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/smithy-go"

	"github.com/incognitochat/incognitochat/backend/internal/tokens"
)

// AWS throttling, or a deadline that passed, is answered 503 unavailable
// with Retry-After, so apps back off; other failures stay 500 internal.
func TestThrottlingAnswersUnavailable(t *testing.T) {
	h := newHarness(t)
	h.dir.fail = &smithy.OperationError{ServiceID: "DynamoDB", OperationName: "GetItem", Err: &types.ProvisionedThroughputExceededException{}}
	status, out := h.register(t, newDevice(t), false)
	wantError(t, status, out, http.StatusServiceUnavailable, "unavailable")
	if logs := h.logs.String(); !strings.Contains(logs, `"route":"POST /register"`) || !strings.Contains(logs, `"status":503`) {
		t.Fatalf("logs = %s", logs)
	}

	resp := h.server.internal("GET /inbox", fmt.Errorf("list: %w", context.DeadlineExceeded))
	if resp.StatusCode != http.StatusServiceUnavailable || resp.Headers["retry-after"] != strconv.Itoa(RetryAfter) || !strings.Contains(resp.Body, `"unavailable"`) {
		t.Fatalf("after a deadline: %d %v %s", resp.StatusCode, resp.Headers, resp.Body)
	}
	resp = h.server.internal("GET /inbox", errors.New("boom"))
	if resp.StatusCode != http.StatusInternalServerError || resp.Headers["retry-after"] != "" {
		t.Fatalf("after a failure: %d %v", resp.StatusCode, resp.Headers)
	}
}

// faultyIssuer's signatures all fail their check (tokens.ErrSign).
type faultyIssuer struct{ Issuer }

func (faultyIssuer) Sign([32]byte, []byte) ([]byte, error) { return nil, tokens.ErrSign }

// A signature that fails its check is a server failure, and none is sent;
// a message that can't be signed is the client's.
func TestFaultySignatureIsInternal(t *testing.T) {
	h := newHarness(t)
	m := h.account(t, userID)
	blinded := randomBytes(t, testIssuer().BlindedLen())
	blinded[0] = 0
	h.server.Issuer = faultyIssuer{keyring(testIssuer(), nil)}
	status, out := h.as(t, m, http.MethodPost, "/tokens", map[string]any{"blinded": []string{b64(blinded)}}, false)
	wantError(t, status, out, http.StatusInternalServerError, "internal")
	if _, ok := out["signatures"]; ok {
		t.Fatalf("signatures sent: %v", out)
	}

	h.server.Issuer = keyring(testIssuer(), nil)
	tooBig := make([]byte, testIssuer().BlindedLen())
	for i := range tooBig {
		tooBig[i] = 0xff
	}
	status, out = h.as(t, m, http.MethodPost, "/tokens", map[string]any{"blinded": []string{b64(tooBig)}}, false)
	wantError(t, status, out, http.StatusBadRequest, "bad_request")
}
