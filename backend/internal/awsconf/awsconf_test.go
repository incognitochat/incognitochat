package awsconf

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	lambdatypes "github.com/aws/aws-sdk-go-v2/service/lambda/types"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
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
