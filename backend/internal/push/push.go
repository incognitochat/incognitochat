// Package push tells an account's open apps that something arrived, through
// their WebSocket connections (design §12). The push carries no content: the
// app then fetches its inbox over HTTPS, so a lost push loses nothing.
//
// The api function doesn't push: after a send it asks the ws function to
// (Client), without waiting, and ws pushes (Pusher) and asks for a notice
// if no app took it. So /send answers in the same time whether or not the
// recipient's app is open, and api can't post to sockets at all.
package push

import (
	"context"
	"errors"
	"sync"

	"github.com/aws/aws-sdk-go-v2/service/apigatewaymanagementapi"
	"github.com/aws/aws-sdk-go-v2/service/apigatewaymanagementapi/types"

	"github.com/incognitochat/incognitochat/backend/internal/awsconf"
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

// Push sends the hint to an account's open connections, newest first, and
// reports whether any took it. It posts to Fanout records at once, round
// after round, until at least Fanout have taken it (a few more may, which
// is harmless) or none are left. Records of sockets that have closed
// (their $disconnect isn't recorded) answer gone and are forgotten, so an
// open copy of the app isn't crowded out by others that closed. A round
// takes as long as its slowest post, so closed sockets on record add a
// round per Fanout of them, about MaxRecords/Fanout rounds at most (all in
// the ws function, after /send has answered).
func (p *Pusher) Push(ctx context.Context, account string) (bool, error) {
	delivered, _, err := p.push(ctx, account)
	return delivered > 0, err
}

// push is Push, reporting how many took the hint and in how many rounds.
func (p *Pusher) push(ctx context.Context, account string) (delivered, rounds int, _ error) {
	conns, err := p.Sockets.Connections(ctx, account)
	var errs []error
	switch {
	case errors.Is(err, ephemeral.ErrTidy):
		errs = append(errs, err) // only old records left over: push anyway
	case err != nil:
		return 0, 0, err
	}
	for len(conns) > 0 && delivered < Fanout {
		rounds++
		round := conns[:min(Fanout, len(conns))]
		conns = conns[len(round):]
		var mu sync.Mutex
		var workers awsconf.Workers
		for _, c := range round {
			workers.Go(func() {
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
		workers.Wait()
	}
	return delivered, rounds, errors.Join(errs...)
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
