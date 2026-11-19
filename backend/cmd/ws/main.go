// Command ws handles the WebSocket API's routes, and pushes to open apps
// (docs/protocol.md, Delivery). A socket only carries content-free pushes from
// the server ("something arrived"); every action goes through the HTTPS API,
// so a dropped socket loses nothing.
//
// $connect checks the session token, sent as the second subprotocol
// (new WebSocket(url, ["v1", token])) so it never appears in a URL, and
// records the connection (ephemeral.Sockets.Open, which also limits connects);
// anything else is the app's heartbeat, answered so the socket isn't closed
// as idle. $disconnect isn't routed here: a closed socket's record goes when
// a push finds it gone, when a connect needs its place, or once it expires.
//
// After each send, the api function invokes this one without waiting
// (push.Client): it pushes the hint to the recipient's open apps and, if
// none took it and the envelope isn't quiet, asks notify for a notice,
// without waiting either. So the sender's answer doesn't depend on whether
// the recipient's app is open, and notify never touches socket records.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/service/apigatewaymanagementapi"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	awslambda "github.com/aws/aws-sdk-go-v2/service/lambda"
	"github.com/aws/aws-sdk-go-v2/service/ssm"

	"github.com/incognitochat/incognitochat/backend/internal/awsconf"
	"github.com/incognitochat/incognitochat/backend/internal/config"
	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/logx"
	"github.com/incognitochat/incognitochat/backend/internal/notices"
	"github.com/incognitochat/incognitochat/backend/internal/push"
	"github.com/incognitochat/incognitochat/backend/internal/session"
)

// Protocol is the subprotocol the app asks for, echoed on success.
const Protocol = "v1"

// Sockets records open connections (ephemeral.Sockets).
type Sockets interface {
	Open(ctx context.Context, account, connection string) error
}

// Pusher reaches an account's open apps (push.Pusher).
type Pusher interface {
	// Push sends the hint and reports whether any app took it.
	Push(ctx context.Context, account string) (bool, error)
}

// Notices asks the notify function for a notice, without waiting
// (notices.Client).
type Notices interface {
	Notify(ctx context.Context, account string) error
}

type handler struct {
	sessions *session.Issuer
	sockets  Sockets
	pusher   Pusher
	notices  Notices
	now      func() time.Time
	log      *slog.Logger
}

func main() {
	log := logx.New(os.Stderr, "ws")
	h, err := setup(context.Background())
	if err != nil {
		log.Error("startup failed", logx.ErrorKind(err))
		os.Exit(1)
	}
	h.log = log
	lambda.Start(h.invocation())
}

// invocation is the function's handler: handle, under awsconf.Guard, so
// Lambda gets no error but awsconf.ErrFailed (handle returns none) and a
// panic is logged by its kind.
func (h *handler) invocation() func(context.Context, event) (any, error) {
	return awsconf.Guard(h.log, awsconf.WithDeadline(requestDeadline, h.handle))
}

// requestDeadline bounds an invocation's calls (DynamoDB, the socket API,
// invoking notify), well under the function's timeout (5 s,
// infra/functions.tf).
const requestDeadline = 3 * time.Second

// pushDeadline bounds the push within an invocation, so a post to a socket
// that hangs still leaves time to ask for the notice (a variable for tests).
var pushDeadline = 1500 * time.Millisecond

func setup(ctx context.Context) (*handler, error) {
	env, err := config.Env(os.Getenv, "PARAM_SESSION_KEY", "TABLE_EPHEMERAL", "WS_ENDPOINT", "NOTIFY_FUNCTION")
	if err != nil {
		return nil, err
	}
	aws, err := awsconf.Load(ctx)
	if err != nil {
		return nil, err
	}
	params, err := config.Load(ctx, ssm.NewFromConfig(aws), env["PARAM_SESSION_KEY"])
	if err != nil {
		return nil, err
	}
	sessionKey := []byte(params[env["PARAM_SESSION_KEY"]])
	sessions, err := session.NewIssuer(map[byte][]byte{1: sessionKey}, 1)
	if err != nil {
		return nil, err
	}
	sockets := &ephemeral.Sockets{
		DB:    dynamodb.NewFromConfig(aws),
		Table: env["TABLE_EPHEMERAL"],
		Now:   time.Now,
		Key:   ephemeral.SocketKey(sessionKey),
	}
	endpoint := env["WS_ENDPOINT"]
	return &handler{
		sessions: sessions,
		sockets:  sockets,
		pusher: &push.Pusher{
			Sockets: sockets,
			API: apigatewaymanagementapi.NewFromConfig(aws, func(o *apigatewaymanagementapi.Options) {
				o.BaseEndpoint = &endpoint
			}),
		},
		notices: &notices.Client{Lambda: awslambda.NewFromConfig(aws), Function: env["NOTIFY_FUNCTION"]},
		now:     time.Now,
	}, nil
}

// event is what the function is invoked with: API Gateway's for a socket
// (a connect, or a heartbeat), or the api function's after a send
// (push.Event), which has no route.
type event struct {
	events.APIGatewayWebsocketProxyRequest
	push.Event
}

func (h *handler) handle(ctx context.Context, e event) (any, error) {
	if e.RequestContext.RouteKey == "" && e.Push != nil {
		h.deliver(ctx, *e.Push)
		return nil, nil
	}
	return h.socket(ctx, e.APIGatewayWebsocketProxyRequest), nil
}

// deliver pushes a send's hint to the account's open apps, and, if none
// took it and the envelope isn't quiet, asks notify for a notice, which
// keeps to its quiet period (3 minutes per account). A send to a mailbox
// that doesn't exist names no account: there is nothing to do. A push that
// fails counts as taken by nobody, so the notice goes out. Failures are
// logged, never returned: Lambda would only run the event again (the
// function is set to not retry anyway), pushing the hint twice.
func (h *handler) deliver(ctx context.Context, d push.Delivery) {
	if d.Account == "" {
		return
	}
	if !ids.Valid(d.Account) {
		h.log.Warn("push refused: bad account")
		return
	}
	pushCtx, cancel := context.WithTimeout(ctx, pushDeadline)
	took, err := h.pusher.Push(pushCtx, d.Account)
	cancel()
	if err != nil {
		h.log.Warn("push failed", logx.ErrorKind(err))
	}
	if took || d.Quiet {
		return
	}
	if err := h.notices.Notify(ctx, d.Account); err != nil {
		h.log.Warn("notice request failed", logx.ErrorKind(err))
	}
}

// socket answers a WebSocket route.
func (h *handler) socket(ctx context.Context, req events.APIGatewayWebsocketProxyRequest) events.APIGatewayProxyResponse {
	conn := req.RequestContext.ConnectionID
	switch req.RequestContext.RouteKey {
	case "$connect":
		token, ok := tokenFrom(header(req.Headers, "Sec-WebSocket-Protocol"))
		if !ok {
			return status(http.StatusForbidden)
		}
		claims, err := h.sessions.Verify(token, h.now())
		if err != nil {
			return status(http.StatusForbidden)
		}
		err = h.sockets.Open(ctx, claims.AccountID, conn)
		switch {
		case errors.Is(err, ephemeral.ErrTooManyConnects):
			// The app tries again later, and polls meanwhile. Logged with
			// nothing about the account or connection, to count how often
			// the limit is met.
			h.log.Warn("connect refused: too many")
			return status(http.StatusTooManyRequests)
		case errors.Is(err, ephemeral.ErrTidy):
			// Recorded; only old records are left over. Refusing would make
			// the app retry and record another.
			h.log.Warn("connect tidying failed", logx.ErrorKind(err))
		case err != nil:
			h.log.Warn("connect failed", logx.ErrorKind(err))
			return status(http.StatusInternalServerError)
		}
		resp := status(http.StatusOK)
		resp.Headers = map[string]string{"Sec-WebSocket-Protocol": Protocol}
		return resp
	default:
		// The heartbeat (and $disconnect, if it were routed here): nothing to do.
		return status(http.StatusOK)
	}
}

// tokenFrom reads the session token from the requested subprotocols:
// exactly "v1" and the token.
func tokenFrom(protocols string) (string, bool) {
	parts := strings.Split(protocols, ",")
	if len(parts) != 2 || strings.TrimSpace(parts[0]) != Protocol {
		return "", false
	}
	token := strings.TrimSpace(parts[1])
	return token, token != ""
}

// header finds a header whatever its case.
func header(headers map[string]string, name string) string {
	for k, v := range headers {
		if strings.EqualFold(k, name) {
			return v
		}
	}
	return ""
}

func status(code int) events.APIGatewayProxyResponse {
	return events.APIGatewayProxyResponse{StatusCode: code}
}
