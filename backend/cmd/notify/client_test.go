package main

import (
	"bytes"
	"context"
	"encoding/json"
	"slices"
	"testing"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	awslambda "github.com/aws/aws-sdk-go-v2/service/lambda"
	lambdatypes "github.com/aws/aws-sdk-go-v2/service/lambda/types"

	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/logx"
	"github.com/incognitochat/incognitochat/backend/internal/notices"
)

// lambdaRunning invokes the function's handler as Lambda does: the event's
// JSON in, the answer's JSON out, or a function error. An asynchronous
// invoke is only accepted (202) and answers nothing.
type lambdaRunning struct {
	handler lambda.Handler
	ran     []string // the functions invoked
}

func (l *lambdaRunning) Invoke(ctx context.Context, in *awslambda.InvokeInput, _ ...func(*awslambda.Options)) (*awslambda.InvokeOutput, error) {
	l.ran = append(l.ran, aws.ToString(in.FunctionName))
	out, err := l.handler.Invoke(ctx, in.Payload)
	if in.InvocationType == lambdatypes.InvocationTypeEvent {
		return &awslambda.InvokeOutput{StatusCode: 202}, nil
	}
	if err != nil {
		payload, _ := json.Marshal(map[string]string{"errorMessage": err.Error()})
		return &awslambda.InvokeOutput{StatusCode: 200, FunctionError: aws.String("Unhandled"), Payload: payload}, nil
	}
	return &awslambda.InvokeOutput{StatusCode: 200, Payload: out}, nil
}

// What notices.Client sends is what this function reads, and what it
// answers is what the client reads: a chat ID sealed for the api function
// opens to the same ID, and a notice asked for by ws reaches the notifier
// for the same account.
func TestClientRoundTrip(t *testing.T) {
	sealer, err := notices.NewSealer(bytes.Repeat([]byte("k"), 32))
	if err != nil {
		t.Fatal(err)
	}
	n := &fakeNotifier{}
	l := &lambdaRunning{handler: lambda.NewHandler(invocation(logx.New(&bytes.Buffer{}, "notify"), sealer, n))}
	c := &notices.Client{Lambda: l, Function: "fn-notify"}
	ctx := context.Background()

	sealed, err := c.Seal(ctx, 4242)
	if err != nil {
		t.Fatal(err)
	}
	if chat, err := sealer.Open(sealed); err != nil || chat != 4242 {
		t.Fatalf("sealed %d, %v", chat, err)
	}
	if _, err := c.Seal(ctx, 0); err == nil {
		t.Fatal("sealed chat 0")
	}

	account := ids.New()
	if err := c.Notify(ctx, account); err != nil || n.notified != account {
		t.Fatalf("notify: %v, %q", err, n.notified)
	}
	// Refused by the function, which the asynchronous invoke doesn't wait for.
	n.notified = ""
	if err := c.Notify(ctx, "not-an-id"); err != nil || n.notified != "" {
		t.Fatalf("a bad account: %v, %q", err, n.notified)
	}
	if !slices.Equal(l.ran, []string{"fn-notify", "fn-notify", "fn-notify", "fn-notify"}) {
		t.Fatalf("invoked %v", l.ran)
	}
}
