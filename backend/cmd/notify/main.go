// Command notify sends Telegram "New message" notices (design §12). The api
// function invokes it to seal a chat ID (only notify holds the key), and
// the ws function, without waiting, after a delivery that no open app took
// and that isn't quiet. It can read the bot token and the chat key, and the
// notice fields of accounts (infra/functions.tf: no other attribute, and
// nothing outside account partitions); nothing about messages, and no
// socket records.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"time"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/ssm"

	"github.com/incognitochat/incognitochat/backend/internal/awsconf"
	"github.com/incognitochat/incognitochat/backend/internal/config"
	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/logx"
	"github.com/incognitochat/incognitochat/backend/internal/notices"
	"github.com/incognitochat/incognitochat/backend/internal/telegram/botapi"
)

func main() {
	log := logx.New(os.Stderr, "notify")
	sealer, notifier, err := load(context.Background())
	if err != nil {
		log.Error("startup failed", logx.ErrorKind(err))
		os.Exit(1)
	}
	lambda.Start(awsconf.WithDeadline(requestDeadline, func(ctx context.Context, raw json.RawMessage) (any, error) {
		out, err := handle(ctx, raw, sealer, notifier)
		return out, report(log, err)
	}))
}

// requestDeadline bounds an invocation's calls (DynamoDB, Telegram), under
// the function's timeout (10 s, infra/functions.tf), with room for one wait
// for Telegram's flood control (notices.MaxRetryWait) before the time
// Notifier keeps at the end.
const requestDeadline = 7 * time.Second

// report logs an invocation's failure and returns the error for Lambda. A
// notice refused by Telegram's flood control is dropped as Telegram asked,
// and isn't the function's failure; anything that failed with it is.
func report(log *slog.Logger, err error) error {
	if !errors.Is(err, notices.ErrRateLimited) {
		if err != nil {
			log.Warn("notify failed", logx.ErrorKind(err))
		}
		return err
	}
	log.Warn("notice refused by flood control")
	var rest []error
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		for _, e := range joined.Unwrap() {
			if !errors.Is(e, notices.ErrRateLimited) {
				log.Warn("notify failed", logx.ErrorKind(e))
				rest = append(rest, e)
			}
		}
	}
	return errors.Join(rest...)
}

// notifier is what handle needs of notices.Notifier.
type notifier interface {
	Notify(ctx context.Context, accountID string) error
	Check(ctx context.Context) error
}

func handle(ctx context.Context, raw json.RawMessage, sealer *notices.Sealer, n notifier) (any, error) {
	var e notices.Event
	if err := json.Unmarshal(raw, &e); err != nil {
		return nil, errors.New("notify: unreadable event")
	}
	switch {
	case e.Seal != nil:
		if e.Seal.Chat <= 0 {
			return nil, errors.New("notify: bad chat")
		}
		sealed, err := sealer.Seal(e.Seal.Chat)
		if err != nil {
			return nil, err
		}
		return notices.SealResult{Sealed: base64.RawURLEncoding.EncodeToString(sealed)}, nil
	case e.Notify != nil:
		if e.Notify.Account == "" {
			// Nothing to do (api functions from before ws asked for
			// notices sent this, for sends to mailboxes that don't exist).
			return nil, nil
		}
		if !ids.Valid(e.Notify.Account) {
			return nil, errors.New("notify: bad account")
		}
		return nil, n.Notify(ctx, e.Notify.Account)
	case e.Check != nil:
		// The deploy's check that the function starts and its role
		// allows its directory calls.
		return nil, n.Check(ctx)
	}
	return nil, errors.New("notify: unknown event")
}

func load(ctx context.Context) (*notices.Sealer, *notices.Notifier, error) {
	env, err := config.Env(os.Getenv, "PARAM_BOT_TOKEN", "PARAM_CHAT_KEY", "TABLE_DIRECTORY", "TABLE_EPHEMERAL", "APP_URL")
	if err != nil {
		return nil, nil, err
	}
	aws, err := awsconf.Load(ctx)
	if err != nil {
		return nil, nil, err
	}
	params, err := config.Load(ctx, ssm.NewFromConfig(aws), env["PARAM_BOT_TOKEN"], env["PARAM_CHAT_KEY"])
	if err != nil {
		return nil, nil, err
	}
	chatKey := []byte(params[env["PARAM_CHAT_KEY"]])
	sealer, err := notices.NewSealer(chatKey)
	if err != nil {
		return nil, nil, err
	}
	db := dynamodb.NewFromConfig(aws)
	now := time.Now
	return sealer, &notices.Notifier{
		Directory: &directory.Store{DB: db, Table: env["TABLE_DIRECTORY"]},
		Quiet:     &ephemeral.Quiet{DB: db, Table: env["TABLE_EPHEMERAL"], Now: now},
		QuietKey:  notices.QuietKey(chatKey),
		Sealer:    sealer,
		Bot:       botapi.Client{Token: params[env["PARAM_BOT_TOKEN"]]},
		AppURL:    env["APP_URL"],
		Now:       now,
	}, nil
}
