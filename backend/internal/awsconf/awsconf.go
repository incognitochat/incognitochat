// Package awsconf is what the four functions share about calling AWS: few,
// quick retries, a deadline for each invocation, and telling throttling
// apart from failure.
//
// The SDK's default retryer tries a call three times, and after a throttle
// waits up to 2 s, then up to 4 s. A function has a fixed number of
// instances (its reserved concurrency), so one throttled table would hold
// them for seconds per call, and every route would be refused for want of
// an instance. Here a throttled call is tried once more, soon, and then
// fails: the api answers 503 unavailable (Unavailable), and the app waits.
package awsconf

import (
	"context"
	"errors"
	"math/rand/v2"
	"net/http"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	"github.com/aws/aws-sdk-go-v2/config"
	dynamotypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

const (
	// MaxAttempts is how many times a call is tried: once more after a
	// throttle or a transient error.
	MaxAttempts = 2
	// MaxBackoff is the longest wait before trying a call again.
	MaxBackoff = 200 * time.Millisecond
)

// Load returns the default AWS configuration (the function's role, its
// region) with Retryer.
func Load(ctx context.Context) (aws.Config, error) {
	return config.LoadDefaultConfig(ctx, config.WithRetryer(Retryer))
}

// Retryer is the SDK's standard retryer (what it retries, its retry quota),
// with MaxAttempts and a fully jittered wait of at most MaxBackoff.
func Retryer() aws.Retryer {
	return retry.NewStandard(func(o *retry.StandardOptions) {
		o.MaxAttempts = MaxAttempts
		o.MaxBackoff = MaxBackoff
		o.Backoff = backoff{}
	})
}

// backoff waits a random time up to MaxBackoff. (The SDK's own, given a
// MaxBackoff under a second, always waits exactly MaxBackoff, so instances
// throttled together would try again together.)
type backoff struct{}

func (backoff) BackoffDelay(int, error) (time.Duration, error) {
	return rand.N(MaxBackoff), nil
}

// Unavailable reports whether err means AWS refused or couldn't serve the
// call for now, or the call ran out of time: a throttle (a table at its
// cap, a function out of concurrency, any other service's rate limit), a
// 503 or 429 from AWS, or a passed deadline. Such a request may well work a
// moment later, so it isn't a failure of the request.
func Unavailable(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	if retry.IsErrorThrottles(retry.DefaultThrottles).IsErrorThrottle(err) == aws.TrueTernary {
		return true
	}
	// A transaction DynamoDB cancelled only because items were throttled
	// says so in each item's reason, not in its error code.
	var canceled *dynamotypes.TransactionCanceledException
	if errors.As(err, &canceled) {
		return throttledOnly(canceled.CancellationReasons)
	}
	var resp *smithyhttp.ResponseError
	if errors.As(err, &resp) {
		status := resp.HTTPStatusCode()
		return status == http.StatusServiceUnavailable || status == http.StatusTooManyRequests
	}
	return false
}

// throttledOnly reports whether a cancelled transaction's reasons are all
// throttling or capacity ("None" for the items that were fine), and at least
// one is.
func throttledOnly(reasons []dynamotypes.CancellationReason) bool {
	throttled := false
	for _, r := range reasons {
		switch aws.ToString(r.Code) {
		case "None", "":
		case "ThrottlingError", "ProvisionedThroughputExceeded", "RequestLimitExceeded":
			throttled = true
		default:
			return false
		}
	}
	return throttled
}

// WithDeadline wraps a Lambda handler so that each invocation's context
// ends after d, or at the function's own deadline if that comes first: a
// call stuck on AWS is cut off in time for the handler to answer, rather
// than the function timing out, and an instance is held at most about d.
func WithDeadline[In, Out any](d time.Duration, handler func(context.Context, In) (Out, error)) func(context.Context, In) (Out, error) {
	return func(ctx context.Context, in In) (Out, error) {
		ctx, cancel := context.WithTimeout(ctx, d)
		defer cancel()
		return handler(ctx, in)
	}
}
