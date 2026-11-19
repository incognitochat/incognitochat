package push

import (
	"context"
	"encoding/json"

	"github.com/aws/aws-sdk-go-v2/service/lambda"
	"github.com/aws/aws-sdk-go-v2/service/lambda/types"
)

// Event is what the api function invokes the ws function with after a
// send (Client).
type Event struct {
	Push *Delivery `json:"push,omitempty"`
}

// Delivery is one send's push: whose open apps to tell, and whether the
// envelope is quiet (a receipt, a reaction, an edit…), which never brings a
// notice. Account is empty for a send to a mailbox that doesn't exist:
// there is nobody to tell, and ws drops it.
type Delivery struct {
	Account string `json:"account"`
	Quiet   bool   `json:"quiet"`
}

// Invoker is the Lambda client part Client uses.
type Invoker interface {
	Invoke(context.Context, *lambda.InvokeInput, ...func(*lambda.Options)) (*lambda.InvokeOutput, error)
}

// Client hands sends to the ws function, from the api function.
type Client struct {
	Lambda   Invoker
	Function string
}

// Push asks the ws function to push a hint to an account's open apps, and
// to ask notify for a notice if none took it and the envelope isn't quiet.
// It returns once Lambda has queued the request (an asynchronous invoke),
// without waiting for either: so how long a send takes doesn't depend on
// whether the recipient's app is open. A send to a mailbox that doesn't
// exist makes the same request, for an empty account.
func (c *Client) Push(ctx context.Context, account string, quiet bool) error {
	payload, err := json.Marshal(Event{Push: &Delivery{Account: account, Quiet: quiet}})
	if err != nil {
		return err
	}
	_, err = c.Lambda.Invoke(ctx, &lambda.InvokeInput{
		FunctionName:   &c.Function,
		Payload:        payload,
		InvocationType: types.InvocationTypeEvent,
	})
	return err
}
