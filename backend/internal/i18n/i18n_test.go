package i18n

import (
	"encoding/json"
	"os"
	"reflect"
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

var tagShape = regexp.MustCompile(`^[a-z]{2,3}(-[a-z0-9]{2,8})*$`)

func TestTags(t *testing.T) {
	v := readVectors(t)
	seen := map[string]string{}
	for _, l := range Languages() {
		if len(l.Tags) == 0 {
			t.Errorf("%s has no tags", l.Code)
		}
		for _, tag := range l.Tags {
			// Lowercase, subtags joined by -, as Pick compares them.
			if !tagShape.MatchString(tag) {
				t.Errorf("%s: tag %q isn't lowercase subtags joined by -", l.Code, tag)
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
	// Only ASCII letters are lowercased, as the app does: Go's own
	// lowercasing turns İ into i, JavaScript's into i and a dot.
	if got := asciiLower("İD-Fa_x"); got != "İd-fa_x" {
		t.Errorf("asciiLower = %q", got)
	}
}

func TestLanguagesIsACopy(t *testing.T) {
	l := Languages()
	l[1].Tags[0] = "en"
	l[0].Code = "xx"
	if Pick("fa") != "fa" || Languages()[0].Code != "en" {
		t.Fatal("changing what Languages returned changed the table")
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

// Every text is there and within its limit, counted in characters (a
// command description: Telegram's 1–256; buttons: our own 64, to stay
// short; anything else: a message's 4096), and none names an environment:
// the repository is public, and every environment gets the same texts.
func TestTexts(t *testing.T) {
	limits := map[string]int{"Command": 256, "Open": 64, "NoticeOpen": 64}
	envData := regexp.MustCompile(`(?i)@|t\.me|://|\b[a-z0-9-]+\.[a-z]{2,}\b|\w+_bot\b`)
	for _, l := range Languages() {
		texts := reflect.ValueOf(l.Texts)
		for i := range texts.NumField() {
			name, text := texts.Type().Field(i).Name, texts.Field(i).String()
			if strings.TrimSpace(text) == "" {
				t.Errorf("%s %s is empty", l.Code, name)
			}
			limit, ok := limits[name]
			if !ok {
				limit = 4096
			}
			if n := utf8.RuneCountInString(text); n > limit {
				t.Errorf("%s %s: %d characters, more than %d", l.Code, name, n, limit)
			}
			if envData.MatchString(text) {
				t.Errorf("%s %s names an environment: %q", l.Code, name, text)
			}
		}
	}
	if reflect.TypeFor[Texts]().NumField() < 5 {
		t.Fatal("Texts lost a field the bot or notices use")
	}
}
