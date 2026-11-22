// Command bot is the Telegram bot (docs/architecture.md, Parts). Telegram's
// webhook reaches it through a Lambda function URL; the deploy invokes it
// directly with a setup event and then a texts event, so the bot token and
// webhook secret never leave the function.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"time"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/service/ssm"

	"github.com/incognitochat/incognitochat/backend/internal/awsconf"
	"github.com/incognitochat/incognitochat/backend/internal/bot"
	"github.com/incognitochat/incognitochat/backend/internal/config"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/i18n"
	"github.com/incognitochat/incognitochat/backend/internal/logx"
)

// event is a function URL request, the deploy's setup call, or its call to
// set the bot's texts. A function URL request can't be either call: its
// HTTP body arrives inside it, never as top-level keys.
type event struct {
	httpapi.Request
	Setup *struct {
		WebhookURL string `json:"webhookUrl"`
	} `json:"setup"`
	Texts *struct{} `json:"texts"`
}

// steps are the deploy's calls the function runs.
type steps struct {
	setup func(context.Context, string) error
	texts func(context.Context) bot.TextsReport
}

func main() {
	log := logx.New(os.Stderr, "bot")
	b, setup, err := load(context.Background())
	if err != nil {
		log.Error("startup failed", logx.ErrorKind(err))
		os.Exit(1)
	}
	lambda.Start(invocation(log, b, steps{
		setup: setup.Run,
		texts: func(ctx context.Context) bot.TextsReport { return setup.SetTexts(ctx, i18n.Languages()) },
	}))
}

// invocation is the function's handler. Lambda gets no error but
// awsconf.ErrFailed: what failed is logged by its kind (and, for a Bot API
// call, its method and Telegram's answer).
func invocation(log *slog.Logger, b *bot.Bot, s steps) func(context.Context, json.RawMessage) (any, error) {
	return awsconf.Guard(log, awsconf.WithDeadline(textsDeadline, func(ctx context.Context, raw json.RawMessage) (any, error) {
		out, err := handle(ctx, raw, b, s)
		if err != nil {
			log.Error("setup failed", logx.ErrorKind(err))
		}
		return out, err
	}))
}

// requestDeadline bounds the setup's calls (to Telegram, two), half the
// function's timeout (10 s, infra/functions.tf). textsDeadline bounds the
// texts step, which makes up to two calls for each of three texts in each
// language, a few at once: longer, with time left to answer.
const (
	requestDeadline = 5 * time.Second
	textsDeadline   = 8 * time.Second
)

// errTwoSteps is returned for an event that asks for both deploy calls.
var errTwoSteps = errors.New("bot: an event runs one step")

// handle routes an event: the deploy's setup call, its texts call, or a
// webhook request. The texts call answers with what it did (its report),
// never an error: a text that couldn't be set leaves the bot working, and
// the deploy only warns.
func handle(ctx context.Context, raw json.RawMessage, b *bot.Bot, s steps) (any, error) {
	var e event
	if err := json.Unmarshal(raw, &e); err != nil {
		return nil, errors.New("bot: unreadable event")
	}
	switch {
	case e.Setup != nil && e.Texts != nil:
		return nil, errTwoSteps
	case e.Setup != nil:
		ctx, cancel := context.WithTimeout(ctx, requestDeadline)
		defer cancel()
		if err := s.setup(ctx, e.Setup.WebhookURL); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	case e.Texts != nil:
		return s.texts(ctx), nil
	}
	return b.Handle(e.Request), nil
}

func load(ctx context.Context) (*bot.Bot, bot.Setup, error) {
	env, err := config.Env(os.Getenv, "PARAM_BOT_TOKEN", "PARAM_WEBHOOK_SECRET", "APP_URL")
	if err != nil {
		return nil, bot.Setup{}, err
	}
	aws, err := awsconf.Load(ctx)
	if err != nil {
		return nil, bot.Setup{}, err
	}
	params, err := config.Load(ctx, ssm.NewFromConfig(aws), env["PARAM_BOT_TOKEN"], env["PARAM_WEBHOOK_SECRET"])
	if err != nil {
		return nil, bot.Setup{}, err
	}
	secret := params[env["PARAM_WEBHOOK_SECRET"]]
	b := &bot.Bot{Secret: secret, AppURL: env["APP_URL"]}
	setup := bot.Setup{Token: params[env["PARAM_BOT_TOKEN"]], Secret: secret, AppURL: env["APP_URL"]}
	return b, setup, nil
}
