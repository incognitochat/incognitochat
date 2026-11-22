package bot

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/incognitochat/incognitochat/backend/internal/awsconf"
	"github.com/incognitochat/incognitochat/backend/internal/i18n"
)

// TextsReport says what SetTexts did, in counts: texts it set, texts that
// were set already, and texts it couldn't set (or didn't try, after an
// error). Nothing in it names a language or a text.
type TextsReport struct {
	OK        bool `json:"ok"`
	Set       int  `json:"set"`
	Unchanged int  `json:"unchanged"`
	Failed    int  `json:"failed"`
}

// textsParallel bounds the Bot API calls SetTexts makes at once.
const textsParallel = 4

// botText is one of the bot's texts in one language: how to read what
// Telegram has, and how to set it.
type botText struct {
	get, set string
	params   map[string]any // the language_code, if any
	// same reports whether what Telegram has (get's result) is the text.
	same func(raw map[string]any) bool
	// value is set's parameters besides the language_code.
	value map[string]any
}

// SetTexts sets, in each language, the bot's /start command, description
// and short description: English as the default (no language_code), every
// other language under its two-letter code. The deploy runs it as a step of
// its own, after the webhook setup: Telegram keeps these texts between
// deploys, so one that fails stays as it was, and the next deploy tries
// again. It reads each text first and sets only one that differs (ignoring
// spaces at either end), so a deploy that changes no text makes no change.
// At the first error (a 429 from Telegram's flood control included) it
// starts no more calls.
func (s Setup) SetTexts(ctx context.Context, languages []i18n.Language) TextsReport {
	var texts []botText
	for _, l := range languages {
		code := map[string]any{}
		if l.BotCode != "" {
			code["language_code"] = l.BotCode
		}
		command, description, about := l.Texts.Command, l.Texts.Description, l.Texts.About
		texts = append(texts,
			botText{get: "getMyCommands", set: "setMyCommands", params: code,
				same: func(raw map[string]any) bool {
					list, _ := raw["commands"].([]any)
					if len(list) != 1 {
						return false
					}
					c, _ := list[0].(map[string]any)
					return c["command"] == "start" && trimmed(c["description"]) == strings.TrimSpace(command)
				},
				value: map[string]any{"commands": []map[string]string{{"command": "start", "description": command}}}},
			botText{get: "getMyDescription", set: "setMyDescription", params: code,
				same:  func(raw map[string]any) bool { return trimmed(raw["description"]) == strings.TrimSpace(description) },
				value: map[string]any{"description": description}},
			botText{get: "getMyShortDescription", set: "setMyShortDescription", params: code,
				same:  func(raw map[string]any) bool { return trimmed(raw["short_description"]) == strings.TrimSpace(about) },
				value: map[string]any{"short_description": about}},
		)
	}

	var (
		workers awsconf.Workers
		mu      sync.Mutex
		report  TextsReport
		stopped atomic.Bool
	)
	slots := make(chan struct{}, textsParallel)
	for _, t := range texts {
		slots <- struct{}{}
		if stopped.Load() || ctx.Err() != nil {
			<-slots
			mu.Lock()
			report.Failed++
			mu.Unlock()
			continue
		}
		workers.Go(func() {
			defer func() { <-slots }()
			changed, err := s.setText(ctx, t)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err != nil:
				stopped.Store(true)
				report.Failed++
			case changed:
				report.Set++
			default:
				report.Unchanged++
			}
		})
	}
	workers.Wait()
	report.OK = report.Failed == 0
	return report
}

// setText sets one text if what Telegram has differs, and says whether it did.
func (s Setup) setText(ctx context.Context, t botText) (bool, error) {
	var current any
	if err := s.client().Call(ctx, t.get, t.params, &current); err != nil {
		return false, err
	}
	// getMyCommands answers with a list; the others with an object.
	raw, ok := current.(map[string]any)
	if list, isList := current.([]any); isList {
		raw, ok = map[string]any{"commands": list}, true
	}
	if ok && t.same(raw) {
		return false, nil
	}
	params := map[string]any{}
	for k, v := range t.params {
		params[k] = v
	}
	for k, v := range t.value {
		params[k] = v
	}
	return true, s.client().Call(ctx, t.set, params, nil)
}

func trimmed(v any) string {
	str, _ := v.(string)
	return strings.TrimSpace(str)
}
