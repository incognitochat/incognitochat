package main

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/lambda"

	"github.com/incognitochat/incognitochat/backend/internal/awsconf"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/logx"
)

// The function's handler is under awsconf.Guard: a route that panics
// reaches Lambda as awsconf.ErrFailed, logged by its kind only, and one
// that answers is untouched (PRV-4).
func TestInvocationIsGuarded(t *testing.T) {
	var buf bytes.Buffer
	router := httpapi.NewRouter()
	router.Handle(http.MethodGet, "/panics", func(_ context.Context, req httpapi.Request) httpapi.Response {
		panic(errors.New("account-AAAAAAAAAAAAAAAAAAAAAA " + req.RawPath))
	})
	router.Handle(http.MethodGet, "/answers", func(context.Context, httpapi.Request) httpapi.Response {
		return httpapi.JSON(http.StatusOK, map[string]string{})
	})
	h := lambda.NewHandler(invocation(logx.New(&buf, "api"), router, func(context.Context) error { return nil }))
	call := func(path string) (out []byte, err error, panicked any) {
		defer func() { panicked = recover() }()
		out, err = h.Invoke(context.Background(), []byte(`{"rawPath":"`+path+`","requestContext":{"http":{"method":"GET"}}}`))
		return out, err, nil
	}

	if _, _, panicked := call("/panics"); panicked != awsconf.ErrFailed {
		t.Fatalf("Lambda got %v", panicked)
	}
	if logged := buf.String(); strings.Contains(logged, "account-") || !strings.Contains(logged, `"msg":"handler panicked"`) {
		t.Fatalf("logged %s", logged)
	}
	out, err, panicked := call("/answers")
	if err != nil || panicked != nil || !strings.Contains(string(out), `"statusCode":200`) {
		t.Fatalf("an answer: %s, %v, %v", out, err, panicked)
	}
}

// The account expiry's schedule sends {"expireAccounts":{}}, which runs
// the expiry, under the guard and with its own deadline; a request through
// the URL never does, even one that names the field (Lambda builds a URL
// request's event, with a path and a method, and a caller sets none of its
// top-level fields).
func TestScheduleRunsTheExpiry(t *testing.T) {
	var buf bytes.Buffer
	router := httpapi.NewRouter()
	router.Handle(http.MethodGet, "/answers", func(context.Context, httpapi.Request) httpapi.Response {
		return httpapi.JSON(http.StatusOK, map[string]string{})
	})
	runs := 0
	var fail error
	var deadline time.Time
	h := lambda.NewHandler(invocation(logx.New(&buf, "api"), router, func(ctx context.Context) error {
		runs++
		deadline, _ = ctx.Deadline()
		return fail
	}))

	out, err := h.Invoke(context.Background(), []byte(`{"expireAccounts":{}}`))
	if err != nil || runs != 1 || string(out) != "null" {
		t.Fatalf("schedule: %s, %v, %d runs", out, err, runs)
	}
	if left := time.Until(deadline); left <= 0 || left > expiryDeadline {
		t.Fatalf("the run's deadline is %v away", left)
	}
	// A failed run reaches Lambda as awsconf.ErrFailed, nothing of its own.
	fail = errors.New("account-AAAAAAAAAAAAAAAAAAAAAA")
	if _, err := h.Invoke(context.Background(), []byte(`{"expireAccounts":{}}`)); err == nil || err.Error() != awsconf.ErrFailed.Error() {
		t.Fatalf("a failed run: %v", err)
	}
	if strings.Contains(buf.String(), "account-") {
		t.Fatalf("logged %s", buf.String())
	}

	for _, event := range []string{
		`{"rawPath":"/answers","requestContext":{"http":{"method":"GET"}},"expireAccounts":{}}`,
		`{"rawPath":"/answers","requestContext":{"http":{"method":"GET"}}}`,
	} {
		runs = 0
		out, err := h.Invoke(context.Background(), []byte(event))
		if err != nil || runs != 0 || !strings.Contains(string(out), `"statusCode":200`) {
			t.Fatalf("%s: %s, %v, %d runs", event, out, err, runs)
		}
	}
	// No schedule's field: the router's answer (404, no path), never a run.
	runs = 0
	out, err = h.Invoke(context.Background(), []byte(`{"expireAccounts":null}`))
	if err != nil || runs != 0 || !strings.Contains(string(out), `"statusCode":404`) {
		t.Fatalf("null: %s, %v, %d runs", out, err, runs)
	}
}
