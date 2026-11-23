// Package awsconf is what the four functions share about calling AWS: few,
// quick retries, a deadline for each invocation, telling throttling apart
// from failure, and giving the Lambda runtime nothing it would log.
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
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	"github.com/aws/aws-sdk-go-v2/config"
	dynamotypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	smithyhttp "github.com/aws/smithy-go/transport/http"

	"github.com/incognitochat/incognitochat/backend/internal/logx"
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
	if Throttled(err) {
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

// Throttled reports whether err is a throttle: AWS refused the call
// outright, doing nothing (a table at its cap, any other rate limit). Unlike
// a time-out or a 5xx, such a call wasn't applied, so even a write that
// mustn't be applied twice can be tried again.
func Throttled(err error) bool {
	return err != nil && retry.IsErrorThrottles(retry.DefaultThrottles).IsErrorThrottle(err) == aws.TrueTernary
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

// ErrFailed is the only error, and the only panic value, the functions give
// the Lambda runtime (Guard).
var ErrFailed = errors.New("invocation failed")

// Guard wraps a Lambda handler so that the runtime gets no error but
// ErrFailed. The runtime (aws-lambda-go) writes an error it gets, or a
// panic's value, to the function's log as they are, outside logx. So an
// error the handler returns becomes ErrFailed (the handler logs it, by
// kind, itself). A panic, in the handler or in a goroutine it ran with
// Workers, is logged by its kind and where it happened (no values), and
// then the handler panics again with ErrFailed: the runtime logs that, with
// the stack's functions, files and lines (no values either), and ends the
// instance as after any panic, so the next invocation starts from a clean
// state rather than one the panic left halfway.
//
// What happens before the handler runs, decoding the event, can still fail
// with the decoder's error, which the runtime logs: the events come from
// AWS (function URLs, API Gateway) and the functions themselves, so they
// decode.
func Guard[In, Out any](log *slog.Logger, handler func(context.Context, In) (Out, error)) func(context.Context, In) (Out, error) {
	return func(ctx context.Context, in In) (Out, error) {
		defer func() {
			if v := recover(); v != nil {
				kind, at := fmt.Sprintf("%T", v), panicAt()
				if p, ok := v.(*workerPanic); ok {
					kind, at = p.kind, p.at
				}
				log.Error("handler panicked", slog.String(logx.KeyErrorKind, kind), slog.String(logx.KeyPanicAt, at))
				panic(ErrFailed)
			}
		}()
		out, err := handler(ctx, in)
		if err != nil {
			err = ErrFailed
		}
		return out, err
	}
}

// Workers runs a handler's goroutines, as a sync.WaitGroup does, so that a
// panic in one reaches Guard: it is recovered there, and Wait, once all
// have ended, panics with its kind and where it happened (not its value) in
// the goroutine that waits, which runs the handler. A panic left in a
// goroutine would end the process with Go's own report, which shows each
// frame's arguments, outside logx.
type Workers struct {
	wg       sync.WaitGroup
	mu       sync.Mutex
	panicked *workerPanic
}

// workerPanic is a goroutine's panic, as Workers carries it to Guard.
type workerPanic struct{ kind, at string }

// Go runs f in a goroutine.
func (w *Workers) Go(f func()) {
	w.wg.Go(func() {
		defer func() {
			if v := recover(); v != nil {
				p := &workerPanic{kind: fmt.Sprintf("%T", v), at: panicAt()}
				w.mu.Lock()
				if w.panicked == nil {
					w.panicked = p
				}
				w.mu.Unlock()
			}
		}()
		f()
	})
}

// Wait waits for the goroutines to end, and panics if one did.
func (w *Workers) Wait() {
	w.wg.Wait()
	if w.panicked != nil {
		panic(w.panicked)
	}
}

// panicAt is where the panic being recovered happened: the function and
// line (the package's base name, e.g. "api.(*Server).send:42"), of the
// first frame outside the runtime past its panic. Called from the deferred
// function that recovers.
func panicAt() string {
	pc := make([]uintptr, 32)
	frames := runtime.CallersFrames(pc[:runtime.Callers(1, pc)])
	panicking := false
	for {
		f, more := frames.Next()
		if panicking && !strings.HasPrefix(f.Function, "runtime.") {
			return fmt.Sprintf("%s:%d", f.Function[strings.LastIndexByte(f.Function, '/')+1:], f.Line)
		}
		if f.Function == "runtime.gopanic" {
			panicking = true
		}
		if !more {
			return ""
		}
	}
}
