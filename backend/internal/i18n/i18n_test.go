package i18n

import (
	"encoding/json"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"
)

type vectors struct {
	Languages []string          `json:"languages"`
	Pick      map[string]string `json:"pick"`
}

func readVectors(t *testing.T) vectors {
	t.Helper()
	raw, err := os.ReadFile("testdata/languages.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil || len(v.Languages) == 0 || len(v.Pick) == 0 {
		t.Fatalf("vectors: %v", err)
	}
	return v
}

// The app lists the same languages in the same order, and picks the same
// one from each code (web/src/i18n/i18n.test.ts reads the same file).
func TestSameAsTheApp(t *testing.T) {
	v := readVectors(t)
	var codes []string
	for _, l := range Languages() {
		codes = append(codes, l.Code)
	}
	if !slices.Equal(codes, v.Languages) {
		t.Fatalf("languages %v, the app's %v", codes, v.Languages)
	}
	for code, want := range v.Pick {
		if got := Pick(code); got != want {
			t.Errorf("Pick(%q) = %q, want %q", code, got, want)
		}
	}
}

func TestTags(t *testing.T) {
	v := readVectors(t)
	seen := map[string]string{}
	for _, l := range Languages() {
		if len(l.Tags) == 0 {
			t.Errorf("%s has no tags", l.Code)
		}
		for _, tag := range l.Tags {
			if tag != strings.ToLower(tag) {
				t.Errorf("%s: tag %q isn't lowercase", l.Code, tag)
			}
			if other, ok := seen[tag]; ok {
				t.Errorf("tag %q picks both %s and %s", tag, other, l.Code)
			}
			seen[tag] = l.Code
			// Each tag has a vector, so the app is checked to pick it the same way.
			if v.Pick[tag] != l.Code {
				t.Errorf("tag %q has no vector picking %s", tag, l.Code)
			}
		}
	}
}

func TestPick(t *testing.T) {
	for code, want := range map[string]string{
		"fa": "fa", "fa-": "fa", "fa-IR-x": "fa", "fa__IR": "fa", "fax": "en", "-fa": "en", " fa": "en", "-": "en", "": "en",
	} {
		if got := Pick(code); got != want {
			t.Errorf("Pick(%q) = %q, want %q", code, got, want)
		}
	}
	if For("qaa") != english.Texts || For("") != english.Texts || For("fa") != persian.Texts {
		t.Error("For doesn't fall back to English")
	}
}

func TestBotCodes(t *testing.T) {
	two := regexp.MustCompile(`^[a-z]{2}$`)
	seen := map[string]bool{}
	for _, l := range Languages() {
		if l.Code == Fallback {
			if l.BotCode != "" {
				t.Errorf("English is the bot's default: BotCode %q", l.BotCode)
			}
			continue
		}
		if !two.MatchString(l.BotCode) || seen[l.BotCode] {
			t.Errorf("%s: BotCode %q isn't two letters, or isn't unique", l.Code, l.BotCode)
		}
		seen[l.BotCode] = true
	}
	if Languages()[0].Code != Fallback {
		t.Error("English isn't first")
	}
}

// Telegram's limits, and nothing about an environment in any text: the
// repository is public, and every environment gets the same texts.
func TestTexts(t *testing.T) {
	envData := regexp.MustCompile(`(?i)@|t\.me|://|\b[a-z0-9-]+\.(com|org|net|me|io|app|dev|bot)\b`)
	for _, l := range Languages() {
		for name, text := range map[string]string{"Welcome": l.Texts.Welcome, "Open": l.Texts.Open, "Command": l.Texts.Command, "Notice": l.Texts.Notice, "NoticeOpen": l.Texts.NoticeOpen} {
			n := utf8.RuneCountInString(text)
			if strings.TrimSpace(text) == "" {
				t.Errorf("%s %s is empty", l.Code, name)
			}
			limit := map[string]int{"Welcome": 4096, "Open": 64, "Command": 256, "Notice": 4096, "NoticeOpen": 64}[name]
			if n > limit {
				t.Errorf("%s %s: %d characters, more than %d", l.Code, name, n, limit)
			}
			if envData.MatchString(text) {
				t.Errorf("%s %s names an environment: %q", l.Code, name, text)
			}
		}
	}
}
