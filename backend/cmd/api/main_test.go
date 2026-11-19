package main

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

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
	h := lambda.NewHandler(invocation(logx.New(&buf, "api"), router))
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
