// Package config reads a function's settings at startup: names from its
// environment, secrets from SSM Parameter Store. Errors name what is missing,
// never a value.
package config

import (
	"context"
	"fmt"
	"math/rand/v2"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	"github.com/aws/aws-sdk-go-v2/service/ssm"

	"github.com/incognitochat/incognitochat/backend/internal/awsconf"
)

const (
	// maxPerCall is SSM's limit for GetParameters.
	maxPerCall = 10

	// loadAttempts is how many times Load tries each call to SSM.
	loadAttempts = 5
	// loadBudget bounds all of Load, waits included: well under the
	// shortest function timeout (ws, 5 s; infra/functions.tf) and the 10 s
	// Lambda gives an instance to start.
	loadBudget = 4 * time.Second
	// attemptTimeout bounds each try.
	attemptTimeout = time.Second
	// firstWait is the most Load waits before trying again the first time;
	// each wait after that may be twice as long, up to maxWait.
	firstWait = 200 * time.Millisecond
	maxWait   = time.Second
)

// wait sleeps for d, or until ctx ends (tests replace it).
var wait = func(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Parameters is the part of the SSM client Load uses.
type Parameters interface {
	GetParameters(context.Context, *ssm.GetParametersInput, ...func(*ssm.Options)) (*ssm.GetParametersOutput, error)
}

// Env returns the named environment variables. Every one must be set.
func Env(getenv func(string) string, names ...string) (map[string]string, error) {
	values := make(map[string]string, len(names))
	var missing []string
	for _, name := range names {
		v := getenv(name)
		if v == "" {
			missing = append(missing, name)
		}
		values[name] = v
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("config: environment variables not set: %s", strings.Join(missing, ", "))
	}
	return values, nil
}

// Load reads parameters by name, decrypted. Every one must exist and be
// non-empty.
//
// Every function calls it at every cold start, and SSM serves the whole
// account 40 calls a second by default, so when many instances start at
// once (a deploy, a sudden rise in use) some calls are throttled. A
// function that can't load exits, and the request that started it fails.
// So each call is tried up to loadAttempts times, after random waits that
// grow, all within loadBudget. Errors that won't change (access denied, a
// bad name) aren't tried again.
func Load(ctx context.Context, client Parameters, names ...string) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(ctx, loadBudget)
	defer cancel()
	values := make(map[string]string, len(names))
	for len(names) > 0 {
		batch := names[:min(maxPerCall, len(names))]
		names = names[len(batch):]
		out, err := getParameters(ctx, client, batch)
		if err != nil {
			return nil, err
		}
		if len(out.InvalidParameters) > 0 {
			return nil, fmt.Errorf("config: parameters not found: %s", strings.Join(out.InvalidParameters, ", "))
		}
		for _, p := range out.Parameters {
			values[aws.ToString(p.Name)] = aws.ToString(p.Value)
		}
		for _, name := range batch {
			if values[name] == "" {
				return nil, fmt.Errorf("config: parameter %s is empty", name)
			}
		}
	}
	return values, nil
}

// getParameters makes one GetParameters call, tried again (here only, not
// by the SDK as well) while it fails in a way that may pass.
func getParameters(ctx context.Context, client Parameters, names []string) (*ssm.GetParametersOutput, error) {
	ceiling := firstWait
	for attempt := 1; ; attempt++ {
		try, cancel := context.WithTimeout(ctx, attemptTimeout)
		out, err := client.GetParameters(try, &ssm.GetParametersInput{
			Names:          names,
			WithDecryption: aws.Bool(true),
		}, oneAttempt)
		cancel()
		if err == nil || attempt == loadAttempts || ctx.Err() != nil || !transient(err) {
			return out, err
		}
		if wait(ctx, rand.N(ceiling)) != nil {
			return nil, err
		}
		ceiling = min(2*ceiling, maxWait)
	}
}

// oneAttempt turns off the SDK's retries for a call that is retried here.
func oneAttempt(o *ssm.Options) { o.RetryMaxAttempts = 1 }

// transient reports whether a call may work if tried again: throttled, out
// of time, or anything else the SDK would retry (a 5xx, a broken
// connection).
func transient(err error) bool {
	return awsconf.Unavailable(err) || retry.IsErrorRetryables(retry.DefaultRetryables).IsErrorRetryable(err) == aws.TrueTernary
}

// InviteOnly reads the INVITE_ONLY setting: on unless explicitly "false".
func InviteOnly(value string) bool {
	return !strings.EqualFold(strings.TrimSpace(value), "false")
}

// TelegramIDs reads a comma-separated list of Telegram user IDs, such as the
// admins. An empty list is fine; a malformed entry is an error.
func TelegramIDs(value string) ([]int64, error) {
	var out []int64
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		id, err := strconv.ParseInt(part, 10, 64)
		if err != nil || id <= 0 {
			return nil, fmt.Errorf("config: %q is not a Telegram user ID", part)
		}
		out = append(out, id)
	}
	return out, nil
}
