// Package i18n holds what the bot and notices say, in each of the app's
// languages, and picks a language from a Telegram language code the same
// way the app does (web/src/i18n/languages.ts). The vectors in
// testdata/languages.json, which both sides' tests read, keep them in step.
//
// A language's Code is stored as an account's notice language: never rename
// or remove one. The bot's texts here hold no environment's details (no bot
// name, link or domain): the repository is public, and every environment
// gets the same texts.
package i18n

import (
	"slices"
	"strings"
)

// Language is one of the app's languages.
type Language struct {
	// Code names it as the app does ("en", "pt-BR"); it's stored as an
	// account's notice language.
	Code string
	// BotCode is the Bot API's language_code for it: two letters (ISO
	// 639-1), unique. Empty for English, the default every other language
	// falls back to.
	BotCode string
	// Tags are the lowercase BCP 47 tags that pick it (Pick).
	Tags  []string
	Texts Texts
}

// Texts are what the bot and notices say in a language.
type Texts struct {
	// Welcome answers any message to the bot: what the app is.
	Welcome string
	// Open is the welcome's button, which opens the app.
	Open string
	// Command describes /start in the bot's command menu (1–256 characters).
	Command string
	// Notice says a message arrived, and nothing else.
	Notice string
	// NoticeOpen is the notice's button, which opens the app.
	NoticeOpen string
	// Description is the bot's description, shown in an empty chat with it
	// ("What can this bot do?"): at most 512 characters.
	Description string
	// About is the bot's short description, on its profile and where a
	// link to it is shared: at most 120 characters.
	About string
}

// Fallback is the language for a code no language picks.
const Fallback = "en"

// languages are the app's languages, in its order (English first).
var languages = []Language{english, persian, russian, arabic, dutch, spanish}

// Languages returns the app's languages, in its order, English first: a
// copy, so a caller can't change what Pick reads.
func Languages() []Language {
	out := slices.Clone(languages)
	for i := range out {
		out[i].Tags = slices.Clone(out[i].Tags)
	}
	return out
}

// Pick returns the code of the language a Telegram language code picks:
// the whole tag (with ASCII letters lowercased, as the app does, and _ read
// as -) among the languages' tags, else the tag less its last subtag, down
// to the first. Fallback if none.
func Pick(telegramCode string) string {
	rest := strings.ReplaceAll(asciiLower(telegramCode), "_", "-")
	for rest != "" {
		for _, l := range languages {
			if slices.Contains(l.Tags, rest) {
				return l.Code
			}
		}
		cut := strings.LastIndexByte(rest, '-')
		if cut < 0 {
			break
		}
		rest = rest[:cut]
	}
	return Fallback
}

// asciiLower lowercases A–Z only. Unicode lowercasing differs between Go
// and JavaScript for a few letters (İ), and tags are ASCII: lowering only
// ASCII keeps both sides picking the same language from any input.
func asciiLower(s string) string {
	return strings.Map(func(r rune) rune {
		if 'A' <= r && r <= 'Z' {
			return r + 'a' - 'A'
		}
		return r
	}, s)
}

// For returns a language's texts; English for a code it doesn't know (a
// stored notice language from a newer version, say).
func For(code string) Texts {
	for _, l := range languages {
		if l.Code == code {
			return l.Texts
		}
	}
	return english.Texts
}
