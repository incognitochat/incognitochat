package config

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	"github.com/aws/aws-sdk-go-v2/service/ssm/types"
	"github.com/aws/smithy-go"
)

type fakeSSM struct {
	values map[string]string
	calls  int
}

func (f *fakeSSM) GetParameters(_ context.Context, in *ssm.GetParametersInput, _ ...func(*ssm.Options)) (*ssm.GetParametersOutput, error) {
	f.calls++
	if len(in.Names) > maxPerCall || !aws.ToBool(in.WithDecryption) {
		return nil, fmt.Errorf("bad request")
	}
	out := &ssm.GetParametersOutput{}
	for _, name := range in.Names {
		if v, ok := f.values[name]; ok {
			out.Parameters = append(out.Parameters, types.Parameter{Name: aws.String(name), Value: aws.String(v)})
		} else {
			out.InvalidParameters = append(out.InvalidParameters, name)
		}
	}
	return out, nil
}

func TestEnv(t *testing.T) {
	env := map[string]string{"A": "1", "B": "2"}
	got, err := Env(func(k string) string { return env[k] }, "A", "B")
	if err != nil || got["A"] != "1" || got["B"] != "2" {
		t.Fatalf("Env = %v, %v", got, err)
	}
	if _, err := Env(func(k string) string { return env[k] }, "A", "C", "D"); err == nil || !strings.Contains(err.Error(), "C, D") {
		t.Fatalf("missing: %v", err)
	}
}

func TestLoad(t *testing.T) {
	f := &fakeSSM{values: map[string]string{}}
	var names []string
	for i := range 12 {
		name := fmt.Sprintf("/p/%d", i)
		f.values[name] = "secret-" + name
		names = append(names, name)
	}
	got, err := Load(context.Background(), f, names...)
	if err != nil || len(got) != 12 || got["/p/11"] != "secret-/p/11" || f.calls != 2 {
		t.Fatalf("Load = %d values, %v, %d calls", len(got), err, f.calls)
	}

	_, err = Load(context.Background(), f, "/p/1", "/missing")
	if err == nil || !strings.Contains(err.Error(), "/missing") || strings.Contains(err.Error(), "secret") {
		t.Fatalf("missing parameter: %v", err)
	}

	f.values["/empty"] = ""
	if _, err := Load(context.Background(), f, "/empty"); err == nil {
		t.Fatal("accepted an empty parameter")
	}
}

// flakySSM fails its first calls with err, then answers as fakeSSM.
type flakySSM struct {
	fakeSSM
	failures int
	err      error
}

func (f *flakySSM) GetParameters(ctx context.Context, in *ssm.GetParametersInput, opts ...func(*ssm.Options)) (*ssm.GetParametersOutput, error) {
	// The SDK mustn't retry as well.
	var o ssm.Options
	for _, opt := range opts {
		opt(&o)
	}
	if o.RetryMaxAttempts != 1 {
		return nil, fmt.Errorf("RetryMaxAttempts = %d", o.RetryMaxAttempts)
	}
	if _, ok := ctx.Deadline(); !ok {
		return nil, errors.New("no deadline")
	}
	if f.failures > 0 {
		f.failures--
		f.calls++
		return nil, f.err
	}
	return f.fakeSSM.GetParameters(ctx, in)
}

// waits records Load's waits instead of sleeping.
func waits(t *testing.T) *[]time.Duration {
	t.Helper()
	var got []time.Duration
	old := wait
	wait = func(_ context.Context, d time.Duration) error {
		got = append(got, d)
		return nil
	}
	t.Cleanup(func() { wait = old })
	return &got
}

func TestLoadRetries(t *testing.T) {
	throttled := &smithy.GenericAPIError{Code: "ThrottlingException", Message: "Rate exceeded"}
	values := map[string]string{"/a": "1"}

	// Throttled twice, then answered: within its first two waits.
	waited := waits(t)
	f := &flakySSM{fakeSSM: fakeSSM{values: values}, failures: 2, err: throttled}
	got, err := Load(context.Background(), f, "/a")
	if err != nil || got["/a"] != "1" || f.calls != 3 {
		t.Fatalf("Load = %v, %v after %d calls", got, err, f.calls)
	}
	if len(*waited) != 2 || (*waited)[0] >= firstWait || (*waited)[1] >= 2*firstWait {
		t.Fatalf("waits %v", *waited)
	}

	// Throttled throughout: loadAttempts calls, the waits within the
	// budget, and the throttle as the error.
	waited = waits(t)
	f = &flakySSM{fakeSSM: fakeSSM{values: values}, failures: 100, err: throttled}
	if _, err := Load(context.Background(), f, "/a"); !errors.Is(err, throttled) || f.calls != loadAttempts {
		t.Fatalf("Load = %v after %d calls", err, f.calls)
	}
	var total time.Duration
	for _, d := range *waited {
		total += d
	}
	if len(*waited) != loadAttempts-1 || total >= loadBudget {
		t.Fatalf("waits %v", *waited)
	}

	// Errors that won't pass aren't tried again.
	for _, permanent := range []error{
		&smithy.GenericAPIError{Code: "AccessDeniedException", Message: "no"},
		&smithy.GenericAPIError{Code: "ValidationException", Message: "bad name"},
		errors.New("something else"),
	} {
		waited = waits(t)
		f = &flakySSM{fakeSSM: fakeSSM{values: values}, failures: 1, err: permanent}
		if _, err := Load(context.Background(), f, "/a"); err == nil || f.calls != 1 || len(*waited) != 0 {
			t.Fatalf("%v: tried %d times, %v", permanent, f.calls, err)
		}
	}

	// A call that hangs is cut off and tried again.
	waited = waits(t)
	f = &flakySSM{fakeSSM: fakeSSM{values: values}, failures: 1, err: fmt.Errorf("send: %w", context.DeadlineExceeded)}
	if got, err := Load(context.Background(), f, "/a"); err != nil || got["/a"] != "1" || f.calls != 2 {
		t.Fatalf("after a timeout: %v, %v, %d calls", got, err, f.calls)
	}
}

func TestInviteOnly(t *testing.T) {
	for value, want := range map[string]bool{"": true, "true": true, "yes": true, "false": false, " FALSE ": false} {
		if InviteOnly(value) != want {
			t.Errorf("InviteOnly(%q) = %v", value, !want)
		}
	}
}

func TestTelegramIDs(t *testing.T) {
	got, err := TelegramIDs(" 12, 34 ,,56")
	if err != nil || len(got) != 3 || got[0] != 12 || got[2] != 56 {
		t.Fatalf("TelegramIDs = %v, %v", got, err)
	}
	if got, err := TelegramIDs(""); err != nil || len(got) != 0 {
		t.Fatalf("empty: %v, %v", got, err)
	}
	for _, bad := range []string{"12,abc", "-5", "0", "1.5"} {
		if _, err := TelegramIDs(bad); err == nil {
			t.Errorf("TelegramIDs(%q) accepted", bad)
		}
	}
}
