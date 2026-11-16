// Package push tells an account's open apps that something arrived, through
// their WebSocket connections (design §12). The push carries no content: the
// app then fetches its inbox over HTTPS, so a lost push loses nothing.
package push

import (
	"context"
	"errors"
	"sync"

	"github.com/aws/aws-sdk-go-v2/service/apigatewaymanagementapi"
	"github.com/aws/aws-sdk-go-v2/service/apigatewaymanagementapi/types"

	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
)

// Hint is the whole message an app receives.
var Hint = []byte(`{"t":"sync"}`)

// Fanout is the most open sockets of one account a delivery is pushed to,
// which bounds what a delivery costs.
const Fanout = ephemeral.MaxSockets

// Connections is the socket record store (ephemeral.Sockets).
type Connections interface {
	// Connections lists an account's recorded connections, newest first;
	// some may have closed.
	Connections(ctx context.Context, account string) ([]string, error)
	Forget(ctx context.Context, account, connection string) error
}

// Poster sends to a connection (the API Gateway Management API client).
type Poster interface {
	PostToConnection(context.Context, *apigatewaymanagementapi.PostToConnectionInput, ...func(*apigatewaymanagementapi.Options)) (*apigatewaymanagementapi.PostToConnectionOutput, error)
}

// Pusher pushes hints to open apps.
type Pusher struct {
	Sockets Connections
	API     Poster
}

// Push sends the hint to an account's open connections, newest first, until
// Fanout have taken it, and reports whether any did. Records of sockets
// that have closed (their $disconnect isn't recorded) answer gone and are
// forgotten, and the next ones are tried, so an open copy of the app isn't
// crowded out by others that closed. Each round posts at once, so a push
// takes about as long with closed sockets on record as without. An empty
// account looks up nothing, at about the same cost.
func (p *Pusher) Push(ctx context.Context, account string) (bool, error) {
	conns, err := p.Sockets.Connections(ctx, account)
	if err != nil {
		return false, err
	}
	delivered := 0
	var errs []error
	for len(conns) > 0 && delivered < Fanout {
		round := conns[:min(Fanout-delivered, len(conns))]
		conns = conns[len(round):]
		var mu sync.Mutex
		var wg sync.WaitGroup
		for _, c := range round {
			wg.Go(func() {
				err := p.post(ctx, account, c)
				mu.Lock()
				defer mu.Unlock()
				var gone *types.GoneException
				switch {
				case err == nil:
					delivered++
				case errors.As(err, &gone):
				default:
					errs = append(errs, err)
				}
			})
		}
		wg.Wait()
	}
	return delivered > 0, errors.Join(errs...)
}

// post sends the hint to one connection; one that's gone is forgotten, and
// its GoneException returned.
func (p *Pusher) post(ctx context.Context, account, connection string) error {
	_, err := p.API.PostToConnection(ctx, &apigatewaymanagementapi.PostToConnectionInput{ConnectionId: &connection, Data: Hint})
	var gone *types.GoneException
	if errors.As(err, &gone) {
		if ferr := p.Sockets.Forget(ctx, account, connection); ferr != nil {
			return ferr
		}
	}
	return err
}
