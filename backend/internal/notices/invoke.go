package notices

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"

	"github.com/aws/aws-sdk-go-v2/service/lambda"
	"github.com/aws/aws-sdk-go-v2/service/lambda/types"
)

// Event is what the notify function accepts.
type Event struct {
	// Seal asks for a chat ID to be sealed; the answer is SealResult.
	Seal *struct {
		Chat int64 `json:"chat"`
	} `json:"seal,omitempty"`
	// Notify asks for an account's notice to be sent; nothing is answered.
	Notify *struct {
		Account string `json:"account"`
	} `json:"notify,omitempty"`
	// Check asks notify to make its directory calls for a random account
	// that doesn't exist (Notifier.Check), as the deploy does to check its
	// role allows them; it fails if one is refused.
	Check *struct{} `json:"check,omitempty"`
}

// SealResult is the notify function's answer to a Seal event.
type SealResult struct {
	Sealed string `json:"sealed"` // base64url
}

// Invoker is the Lambda client part Client uses.
type Invoker interface {
	Invoke(context.Context, *lambda.InvokeInput, ...func(*lambda.Options)) (*lambda.InvokeOutput, error)
}

// Client asks the notify function: from the api function to seal a chat
// ID, and from the ws function for a notice after a delivery that no open
// app took.
type Client struct {
	Lambda   Invoker
	Function string
}

// Seal has the notify function seal a chat ID, which only it can open.
func (c *Client) Seal(ctx context.Context, chat int64) ([]byte, error) {
	payload, _ := json.Marshal(Event{Seal: &struct {
		Chat int64 `json:"chat"`
	}{Chat: chat}})
	out, err := c.Lambda.Invoke(ctx, &lambda.InvokeInput{FunctionName: &c.Function, Payload: payload})
	if err != nil {
		return nil, err
	}
	if out.FunctionError != nil {
		return nil, errors.New("notices: seal failed")
	}
	var res SealResult
	if err := json.Unmarshal(out.Payload, &res); err != nil {
		return nil, err
	}
	return base64.RawURLEncoding.Strict().DecodeString(res.Sealed)
}

// Notify asks the notify function to send an account's notice, without
// waiting for it.
func (c *Client) Notify(ctx context.Context, account string) error {
	payload, _ := json.Marshal(Event{Notify: &struct {
		Account string `json:"account"`
	}{Account: account}})
	_, err := c.Lambda.Invoke(ctx, &lambda.InvokeInput{
		FunctionName:   &c.Function,
		Payload:        payload,
		InvocationType: types.InvocationTypeEvent,
	})
	return err
}
