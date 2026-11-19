package notices

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/lambda"
	"github.com/aws/aws-sdk-go-v2/service/lambda/types"
)

// fakeLambda records invocations and answers each with out (or err).
type fakeLambda struct {
	in  []*lambda.InvokeInput
	out *lambda.InvokeOutput
	err error
}

func (f *fakeLambda) Invoke(_ context.Context, in *lambda.InvokeInput, _ ...func(*lambda.Options)) (*lambda.InvokeOutput, error) {
	f.in = append(f.in, in)
	return f.out, f.err
}

// api asks notify to seal a chat ID and waits for the answer: the sealed
// bytes, base64url without padding. Anything else is an error.
func TestClientSeal(t *testing.T) {
	sealed := []byte{0xfb, 0xff, 0x01, 0x02}
	l := &fakeLambda{out: &lambda.InvokeOutput{StatusCode: 200, Payload: []byte(`{"sealed":"-_8BAg"}`)}}
	c := &Client{Lambda: l, Function: "fn-notify"}
	got, err := c.Seal(context.Background(), 4242)
	if err != nil || !bytes.Equal(got, sealed) {
		t.Fatalf("Seal = %x, %v", got, err)
	}
	in := l.in[0]
	if aws.ToString(in.FunctionName) != "fn-notify" || (in.InvocationType != "" && in.InvocationType != types.InvocationTypeRequestResponse) {
		t.Fatalf("invoked %s as %q", aws.ToString(in.FunctionName), in.InvocationType)
	}
	if string(in.Payload) != `{"seal":{"chat":4242}}` {
		t.Fatalf("payload %s", in.Payload)
	}

	for name, out := range map[string]*lambda.InvokeOutput{
		"function error": {StatusCode: 200, FunctionError: aws.String("Unhandled"), Payload: []byte(`{"errorMessage":"failed"}`)},
		"padded":         {StatusCode: 200, Payload: []byte(`{"sealed":"-_8BAg=="}`)},
		"standard":       {StatusCode: 200, Payload: []byte(`{"sealed":"+/8BAg"}`)},
		"unreadable":     {StatusCode: 200, Payload: []byte(`{"sealed":`)},
	} {
		l.out = out
		if got, err := c.Seal(context.Background(), 4242); err == nil {
			t.Errorf("%s: Seal = %x", name, got)
		}
	}
	l.out, l.err = nil, errors.New("TooManyRequestsException")
	if _, err := c.Seal(context.Background(), 4242); err == nil {
		t.Error("a failed invoke sealed")
	}
}

// ws asks notify for an account's notice without waiting: an asynchronous
// invoke, whose failure to be accepted is returned.
func TestClientNotify(t *testing.T) {
	l := &fakeLambda{out: &lambda.InvokeOutput{StatusCode: 202}}
	c := &Client{Lambda: l, Function: "fn-notify"}
	if err := c.Notify(context.Background(), "AAAAAAAAAAAAAAAAAAAAAA"); err != nil {
		t.Fatal(err)
	}
	in := l.in[0]
	if aws.ToString(in.FunctionName) != "fn-notify" || in.InvocationType != types.InvocationTypeEvent {
		t.Fatalf("invoked %s as %q", aws.ToString(in.FunctionName), in.InvocationType)
	}
	if string(in.Payload) != `{"notify":{"account":"AAAAAAAAAAAAAAAAAAAAAA"}}` {
		t.Fatalf("payload %s", in.Payload)
	}
	l.out, l.err = nil, errors.New("TooManyRequestsException")
	if err := c.Notify(context.Background(), "AAAAAAAAAAAAAAAAAAAAAA"); err == nil {
		t.Error("a refused invoke succeeded")
	}
}
