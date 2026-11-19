package awsconf

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	lambdatypes "github.com/aws/aws-sdk-go-v2/service/lambda/types"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"

	"github.com/incognitochat/incognitochat/backend/internal/logx"
)

// responseError is an error as the SDK returns it for an HTTP status.
func responseError(status int, err error) error {
	return &smithy.OperationError{
		ServiceID:     "DynamoDB",
		OperationName: "GetItem",
		Err: &awshttp.ResponseError{
			ResponseError: &smithyhttp.ResponseError{
				Response: &smithyhttp.Response{Response: &http.Response{StatusCode: status}},
				Err:      err,
			},
		},
	}
}

// cancelled is a cancelled transaction with these reasons, one per item.
func cancelled(codes ...string) error {
	reasons := make([]types.CancellationReason, len(codes))
	for i, c := range codes {
		reasons[i] = types.CancellationReason{Code: aws.String(c)}
	}
	return &types.TransactionCanceledException{Message: aws.String("cancelled"), CancellationReasons: reasons}
}

func TestUnavailable(t *testing.T) {
	code := func(c string) error { return &smithy.GenericAPIError{Code: c, Message: "x"} }
	for name, tc := range map[string]struct {
		err  error
		want bool
	}{
		"nil":                       {nil, false},
		"plain":                     {errors.New("boom"), false},
		"table at its cap":          {responseError(400, &types.ProvisionedThroughputExceededException{}), true},
		"table throttling":          {responseError(400, code("ThrottlingException")), true},
		"account request limit":     {responseError(400, &types.RequestLimitExceeded{}), true},
		"function out of instances": {responseError(429, &lambdatypes.TooManyRequestsException{}), true},
		"socket API limit":          {code("LimitExceededException"), true},
		"S3 slow down":              {code("SlowDown"), true},
		"after the last attempt":    {&retry.MaxAttemptsError{Attempt: 2, Err: responseError(400, code("ThrottlingException"))}, true},
		"out of retry quota":        {errors.Join(responseError(400, code("ThrottlingException")), errors.New("retry quota exceeded")), true},
		"503":                       {responseError(503, code("ServiceUnavailable")), true},
		"500":                       {responseError(500, code("InternalServerError")), false},
		"conditional check":         {responseError(400, &types.ConditionalCheckFailedException{}), false},
		"access denied":             {responseError(400, code("AccessDeniedException")), false},
		"transaction throttled":     {responseError(400, cancelled("None", "ThrottlingError", "None")), true},
		"transaction over capacity": {responseError(400, cancelled("ProvisionedThroughputExceeded", "RequestLimitExceeded")), true},
		"transaction conflict":      {responseError(400, cancelled("ThrottlingError", "ConditionalCheckFailed")), false},
		"transaction contended":     {responseError(400, cancelled("TransactionConflict")), false},
		"transaction, no reasons":   {responseError(400, cancelled("None")), false},
		"deadline":                  {fmt.Errorf("get: %w", context.DeadlineExceeded), true},
		"deadline while waiting":    {&aws.RequestCanceledError{Err: context.DeadlineExceeded}, true},
		"canceled":                  {context.Canceled, false},
	} {
		if got := Unavailable(tc.err); got != tc.want {
			t.Errorf("%s: Unavailable = %v, want %v", name, got, tc.want)
		}
	}
}

func TestRetryer(t *testing.T) {
	r := Retryer()
	if r.MaxAttempts() != MaxAttempts {
		t.Fatalf("MaxAttempts = %d", r.MaxAttempts())
	}
	throttle := &types.ProvisionedThroughputExceededException{}
	if !r.IsErrorRetryable(throttle) {
		t.Fatal("a throttle isn't retried")
	}
	seen := map[time.Duration]bool{}
	for attempt := range 50 {
		d, err := r.RetryDelay(1+attempt%3, throttle)
		if err != nil || d < 0 || d >= MaxBackoff {
			t.Fatalf("RetryDelay = %v, %v", d, err)
		}
		seen[d] = true
	}
	if len(seen) < 10 {
		t.Fatalf("the waits aren't jittered: %v", seen)
	}
}

func TestLoad(t *testing.T) {
	t.Setenv("AWS_REGION", "eu-west-1")
	t.Setenv("AWS_ACCESS_KEY_ID", "test")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test")
	cfg, err := Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Retryer == nil || cfg.Retryer().MaxAttempts() != MaxAttempts {
		t.Fatal("Load doesn't use Retryer")
	}
}

func TestWithDeadline(t *testing.T) {
	h := WithDeadline(50*time.Millisecond, func(ctx context.Context, in int) (time.Duration, error) {
		deadline, ok := ctx.Deadline()
		if !ok {
			return 0, errors.New("no deadline")
		}
		return time.Until(deadline), nil
	})
	left, err := h(context.Background(), 1)
	if err != nil || left <= 0 || left > 50*time.Millisecond {
		t.Fatalf("deadline in %v, %v", left, err)
	}
	// The function's own deadline wins if it is sooner.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if left, _ := h(ctx, 1); left > 10*time.Millisecond {
		t.Fatalf("deadline in %v, past the function's", left)
	}
}

const secret = "account-AAAAAAAAAAAAAAAAAAAAAA"

// invoke runs a handler as the runtime does (lambda.NewHandler), and
// returns its error, or what it panicked with.
func invoke(handler func(context.Context, string) (string, error), payload string) (err error, panicked any) {
	defer func() { panicked = recover() }()
	_, err = lambda.NewHandler(handler).Invoke(context.Background(), []byte(payload))
	return err, nil
}

// Whatever a handler returns or panics with, in itself or in a goroutine it
// ran with Workers, the Lambda runtime gets only ErrFailed's constant text,
// returned or panicked with, and the log only the panic's kind and place
// (PRV-4).
func TestGuard(t *testing.T) {
	var buf bytes.Buffer
	log := logx.New(&buf, "api")
	var index []int
	for _, tc := range []struct {
		name    string
		handler func(context.Context, string) (string, error)
		kind    string // what the log says panicked; "" for a returned error
	}{
		{"returned", func(context.Context, string) (string, error) {
			return "", fmt.Errorf("lookup %s: %w", secret, errors.New("denied"))
		}, ""},
		{"panicked", func(context.Context, string) (string, error) { panic(errors.New(secret)) }, "*errors.errorString"},
		{"panicked value", func(context.Context, string) (string, error) { panic(secret) }, "string"},
		{"out of range", func(_ context.Context, in string) (string, error) {
			return in + fmt.Sprint(index[len(in)]), nil
		}, "runtime.boundsError"},
		{"in a goroutine", func(_ context.Context, in string) (string, error) {
			var w Workers
			for i := range 3 {
				w.Go(func() {
					if i == 1 {
						panic(errors.New(in))
					}
				})
			}
			w.Wait()
			return in, nil
		}, "*errors.errorString"},
	} {
		buf.Reset()
		err, panicked := invoke(Guard(log, tc.handler), `"`+secret+`"`)
		if strings.Contains(buf.String(), secret) || strings.Contains(buf.String(), "denied") {
			t.Errorf("%s: logged %s", tc.name, buf.String())
		}
		if tc.kind == "" {
			if err != ErrFailed || err.Error() != "invocation failed" || panicked != nil || buf.Len() != 0 {
				t.Errorf("%s: the runtime got %v, %v; logged %s", tc.name, err, panicked, buf.String())
			}
			continue
		}
		if panicked != ErrFailed {
			t.Errorf("%s: the runtime got %v, %v", tc.name, err, panicked)
		}
		var line map[string]any
		if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
			t.Fatalf("%s: %q", tc.name, buf.String())
		}
		at, _ := line[logx.KeyPanicAt].(string)
		if line["msg"] != "handler panicked" || line[logx.KeyErrorKind] != tc.kind || !strings.HasPrefix(at, "awsconf.TestGuard.func") {
			t.Errorf("%s: logged %v", tc.name, line)
		}
	}
	// What works is untouched.
	out, err := Guard(log, func(_ context.Context, in string) (string, error) { return in + "!", nil })(context.Background(), "ok")
	if out != "ok!" || err != nil {
		t.Fatalf("%q, %v", out, err)
	}
}

// Under the runtime itself (aws-lambda-go's, in a process of its own,
// against a stand-in for Lambda's runtime API), a handler that fails or
// panics, in itself or in a goroutine, has nothing of its values reported
// or logged: the report says "invocation failed", with a panic's stack as
// functions, files and lines. After a panic the process ends, as without
// Guard; after an error it asks for the next invocation (PRV-4).
func TestGuardUnderTheRuntime(t *testing.T) {
	if mode := os.Getenv("AWSCONF_GUARD_MODE"); mode != "" {
		lambda.Start(Guard(logx.New(os.Stderr, "test"), func(_ context.Context, in string) (string, error) {
			switch mode {
			case "panic":
				panic(errors.New(in))
			case "goroutine":
				var w Workers
				w.Go(func() { panic(errors.New(in)) })
				w.Wait()
			}
			return "", errors.New(in)
		}))
		return
	}
	for _, mode := range []string{"error", "panic", "goroutine"} {
		t.Run(mode, func(t *testing.T) {
			var mu sync.Mutex
			nexts := 0
			var report []byte
			var cause string
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				switch {
				case r.Method == http.MethodGet && r.URL.Path == "/2018-06-01/runtime/invocation/next":
					if nexts++; nexts > 1 {
						w.WriteHeader(http.StatusGone) // ends the runtime
						return
					}
					w.Header().Set("Lambda-Runtime-Aws-Request-Id", "request-1")
					w.Header().Set("Lambda-Runtime-Deadline-Ms", strconv.FormatInt(time.Now().Add(time.Minute).UnixMilli(), 10))
					_, _ = w.Write([]byte(`"` + secret + `"`))
				case r.Method == http.MethodPost && r.URL.Path == "/2018-06-01/runtime/invocation/request-1/error":
					report, _ = io.ReadAll(r.Body)
					cause = r.Header.Get("Lambda-Runtime-Function-Xray-Error-Cause")
					w.WriteHeader(http.StatusAccepted)
				default:
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer api.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestGuardUnderTheRuntime$")
			cmd.Env = append(os.Environ(), "AWSCONF_GUARD_MODE="+mode, "AWS_LAMBDA_RUNTIME_API="+strings.TrimPrefix(api.URL, "http://"))
			out, err := cmd.CombinedOutput()
			if err == nil {
				t.Fatalf("the runtime didn't end: %s", out)
			}
			mu.Lock()
			defer mu.Unlock()
			for name, text := range map[string]string{"report": string(report), "X-Ray cause": cause, "output": string(out)} {
				if strings.Contains(text, secret) {
					t.Errorf("the %s holds the handler's value: %s", name, text)
				}
			}
			var got struct {
				Message string           `json:"errorMessage"`
				Type    string           `json:"errorType"`
				Stack   []map[string]any `json:"stackTrace"`
			}
			if err := json.Unmarshal(report, &got); err != nil || got.Message != "invocation failed" || got.Type != "errorString" {
				t.Fatalf("report %s (%v)", report, err)
			}
			for _, frame := range got.Stack {
				for key := range frame {
					if key != "path" && key != "line" && key != "label" {
						t.Errorf("a stack frame holds %s: %v", key, frame)
					}
				}
			}
			panicked := mode != "error"
			if wantNexts := map[bool]int{true: 1, false: 2}[panicked]; nexts != wantNexts || (len(got.Stack) > 0) != panicked ||
				strings.Contains(string(out), `"msg":"handler panicked"`) != panicked {
				t.Fatalf("%d invocations asked for, report %s, output %s", nexts, report, out)
			}
		})
	}
}
