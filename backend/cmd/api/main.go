// Command api serves the client's HTTPS API through a Lambda function URL.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"slices"
	"strconv"
	"time"

	"github.com/aws/aws-lambda-go/lambda"
	awsv2 "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	awslambda "github.com/aws/aws-sdk-go-v2/service/lambda"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/ssm"

	"github.com/incognitochat/incognitochat/backend/internal/api"
	"github.com/incognitochat/incognitochat/backend/internal/awsconf"
	"github.com/incognitochat/incognitochat/backend/internal/config"
	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/inbox"
	"github.com/incognitochat/incognitochat/backend/internal/logx"
	"github.com/incognitochat/incognitochat/backend/internal/media"
	"github.com/incognitochat/incognitochat/backend/internal/notices"
	"github.com/incognitochat/incognitochat/backend/internal/push"
	"github.com/incognitochat/incognitochat/backend/internal/session"
	"github.com/incognitochat/incognitochat/backend/internal/tally"
	"github.com/incognitochat/incognitochat/backend/internal/telegram/initdata"
	"github.com/incognitochat/incognitochat/backend/internal/tokens"
)

const (
	// minSecretLen is the shortest acceptable key from Parameter Store.
	minSecretLen = 32
	// slowRequest is how long a request takes before it is logged.
	slowRequest = time.Second
	// requestDeadline cuts off AWS calls a request still waits on, half the
	// function's timeout (10 s, infra/functions.tf), so the request is
	// answered (503 unavailable) and its instance freed. A request takes
	// about 30 ms. A batch of 50 tokens signs for about 3 s at 256 MB
	// (estimated), after its last AWS call, so this doesn't cut it off.
	requestDeadline = 5 * time.Second
	// expiryDeadline cuts off a run of the account expiry, under the
	// function's timeout (10 s); a run stops starting steps 2 s before it
	// (api.Server.ExpireAccounts).
	expiryDeadline = 8 * time.Second
	// noAdmins is what the admins' parameter holds while there are none
	// (infra/parameters.tf): SSM can't store an empty value.
	noAdmins = "none"
)

func main() {
	log := logx.New(os.Stderr, "api")
	server, err := setup(context.Background())
	if err != nil {
		log.Error("startup failed", logx.ErrorKind(err))
		os.Exit(1)
	}
	server.Log = log
	router := httpapi.NewRouter()
	server.Routes(router)
	// Answers are counted by route, status and error code, and the counts
	// logged once a minute (internal/tally), for the alarms on limits,
	// refusals, registrations and tokens. Slow requests are logged, with
	// only their route and duration, to size the function from data.
	counts := tally.New(log)
	// It also counts the messages sent and the media uploaded, for the
	// public statistics.
	server.Counts = counts
	router.Observe = func(route string, status int, code string, elapsed time.Duration) {
		counts.Add(time.Now(), route, status, code)
		if elapsed >= slowRequest {
			log.Warn("slow request",
				slog.String(logx.KeyRoute, route),
				slog.Int(logx.KeyStatus, status),
				slog.Int64(logx.KeyDuration, elapsed.Milliseconds()))
		}
	}
	// SIGTERM, when the instance shuts down, logs the last minute's counts.
	lambda.StartWithOptions(invocation(log, router, server.ExpireAccounts), lambda.WithEnableSIGTERM(counts.Flush))
}

// event is what the function is invoked with: a request through its URL,
// or the account expiry's schedule (infra/functions.tf), whose event is
// {"expireAccounts":{}}. Lambda builds a URL request's event itself, always
// with a path and a method, and a caller sets none of its top-level fields
// (its body, headers and query are strings inside it), so no request can
// pass for the schedule's.
type event struct {
	httpapi.Request
	ExpireAccounts *struct{} `json:"expireAccounts"`
}

// scheduled reports whether e is the account expiry's schedule.
func (e *event) scheduled() bool {
	return e.ExpireAccounts != nil && e.RawPath == "" && e.RequestContext.HTTP.Method == ""
}

// invocation is the function's handler: the router for a request, and
// expire, which runs the account expiry (api.Server.ExpireAccounts), for
// the schedule's event; under awsconf.Guard, so Lambda gets no error but
// awsconf.ErrFailed (Serve returns none) and a panic is logged by its kind.
func invocation(log *slog.Logger, router *httpapi.Router, expire func(context.Context) error) func(context.Context, json.RawMessage) (any, error) {
	serve := awsconf.WithDeadline(requestDeadline, router.Serve)
	run := awsconf.WithDeadline(expiryDeadline, func(ctx context.Context, _ struct{}) (any, error) {
		return nil, expire(ctx)
	})
	return awsconf.Guard(log, func(ctx context.Context, raw json.RawMessage) (any, error) {
		var e event
		if err := json.Unmarshal(raw, &e); err != nil {
			log.Warn("unreadable event", logx.ErrorKind(err))
			return nil, err
		}
		if e.scheduled() {
			return run(ctx, struct{}{})
		}
		return serve(ctx, e.Request)
	})
}

// envNames are the environment variables the function must have.
var envNames = []string{
	"TABLE_DIRECTORY", "TABLE_EPHEMERAL", "TABLE_MESSAGES", "NOTIFY_FUNCTION", "WS_FUNCTION", "MEDIA_BUCKET",
	"PARAM_BOT_ID", "PARAM_SESSION_KEY", "PARAM_TELEGRAM_ID_PEPPER", "PARAM_ISSUER_KEY", "PARAM_MEDIA_ISSUER_KEY",
	"PARAM_PREVIOUS_ISSUER_KEY", "PARAM_PREVIOUS_MEDIA_ISSUER_KEY", "PARAM_ADMIN_TELEGRAM_IDS",
}

func setup(ctx context.Context) (*api.Server, error) {
	env, err := config.Env(os.Getenv, envNames...)
	if err != nil {
		return nil, err
	}
	aws, err := awsconf.Load(ctx)
	if err != nil {
		return nil, err
	}
	params, err := config.Load(ctx, ssm.NewFromConfig(aws),
		env["PARAM_BOT_ID"], env["PARAM_SESSION_KEY"], env["PARAM_TELEGRAM_ID_PEPPER"], env["PARAM_ISSUER_KEY"],
		env["PARAM_MEDIA_ISSUER_KEY"], env["PARAM_PREVIOUS_ISSUER_KEY"], env["PARAM_PREVIOUS_MEDIA_ISSUER_KEY"],
		env["PARAM_ADMIN_TELEGRAM_IDS"])
	if err != nil {
		return nil, err
	}
	return newServer(aws, os.Getenv, params)
}

// newServer builds the server from the function's environment (getenv) and
// the parameters setup loaded (params, by their names in the environment):
// it checks the keys and wires each store and client to its table,
// function or bucket. It makes no AWS call.
func newServer(aws awsv2.Config, getenv func(string) string, params map[string]string) (*api.Server, error) {
	env, err := config.Env(getenv, envNames...)
	if err != nil {
		return nil, err
	}

	botID, err := strconv.ParseInt(params[env["PARAM_BOT_ID"]], 10, 64)
	if err != nil || botID <= 0 {
		return nil, errors.New("api: invalid bot ID")
	}
	sessionKey := []byte(params[env["PARAM_SESSION_KEY"]])
	pepper := []byte(params[env["PARAM_TELEGRAM_ID_PEPPER"]])
	if len(pepper) < minSecretLen {
		return nil, errors.New("api: Telegram ID pepper too short")
	}
	issuer, err := session.NewIssuer(map[byte][]byte{1: sessionKey}, 1)
	if err != nil {
		return nil, err
	}
	// Each kind's current key and, while a rotation lasts, its previous one
	// (tokens.NoKey while there is none; docs/deployment.md, Rotating an
	// issuer key).
	tokenIssuer, err := tokens.LoadKeyring(params[env["PARAM_ISSUER_KEY"]], params[env["PARAM_PREVIOUS_ISSUER_KEY"]], tokens.LabelSend)
	if err != nil {
		return nil, err
	}
	mediaIssuer, err := tokens.LoadKeyring(params[env["PARAM_MEDIA_ISSUER_KEY"]], params[env["PARAM_PREVIOUS_MEDIA_ISSUER_KEY"]], tokens.LabelMedia)
	if err != nil {
		return nil, err
	}
	// The two kinds of token must not share a key: a blind signer can't
	// tell them apart, so one key would mean one budget.
	for _, send := range tokenIssuer.KeyIDs() {
		if slices.Contains(mediaIssuer.KeyIDs(), send) {
			return nil, errors.New("api: a send issuer key is also a media issuer key")
		}
	}

	// Admins are recognised by the keyed hash of their Telegram ID, the same
	// one their account stores. The plain IDs come from an encrypted
	// parameter, written through a write-only argument (infra/parameters.tf),
	// so they are in neither Terraform state nor the function's
	// configuration, but whoever may read that parameter can read them. It
	// holds noAdmins while there are none.
	adminList := params[env["PARAM_ADMIN_TELEGRAM_IDS"]]
	if adminList == noAdmins {
		adminList = ""
	}
	adminIDs, err := config.TelegramIDs(adminList)
	if err != nil {
		return nil, err
	}
	admins := make(map[string]bool, len(adminIDs))
	for _, id := range adminIDs {
		admins[directory.TelegramHash(pepper, id)] = true
	}

	db := dynamodb.NewFromConfig(aws)
	lambdaClient := awslambda.NewFromConfig(aws)
	// Without this, presigned uploads would carry a checksum of an empty
	// body, and the app's upload would be refused.
	s3Client := s3.NewFromConfig(aws, func(o *s3.Options) {
		o.RequestChecksumCalculation = awsv2.RequestChecksumCalculationWhenRequired
	})
	now := time.Now
	// Only for deleting an account's records: ws records sockets and
	// pushes to them.
	sockets := &ephemeral.Sockets{DB: db, Table: env["TABLE_EPHEMERAL"], Now: now, Key: ephemeral.SocketKey(sessionKey)}
	dir := &directory.Store{DB: db, Table: env["TABLE_DIRECTORY"]}
	return &api.Server{
		Telegram:    initdata.NewVerifier(botID),
		Sessions:    issuer,
		Directory:   dir,
		Nonces:      &ephemeral.Nonces{DB: db, Table: env["TABLE_EPHEMERAL"], Now: now},
		Limits:      &ephemeral.Limiter{DB: db, Table: env["TABLE_EPHEMERAL"], Now: now},
		Pepper:      pepper,
		Now:         now,
		InviteOnly:  config.InviteOnly(getenv("INVITE_ONLY")),
		Admins:      admins,
		Inbox:       &inbox.Store{DB: db, Table: env["TABLE_MESSAGES"]},
		Issuer:      tokenIssuer,
		MediaIssuer: mediaIssuer,
		Spent:       &ephemeral.Spent{DB: db, Table: env["TABLE_EPHEMERAL"], Now: now},
		Notices:     &notices.Client{Lambda: lambdaClient, Function: env["NOTIFY_FUNCTION"]},
		Push:        &push.Client{Lambda: lambdaClient, Function: env["WS_FUNCTION"]},
		Media:       &media.Bucket{Presign: s3.NewPresignClient(s3Client), S3: s3Client, Name: env["MEDIA_BUCKET"]},
		Uploads:     &ephemeral.Uploads{DB: db, Table: env["TABLE_EPHEMERAL"], Now: now},
		Switches:    dir,
		Sockets:     sockets,
		Unused:      dir,
		// Off, dry-run or on; unset, the dry run (docs/deployment.md,
		// Account expiry).
		Expiry: api.ParseExpiryMode(getenv("ACCOUNT_EXPIRY")),
	}, nil
}
