package notices

import (
	"encoding/json"
	"os"
	"testing"
)

// What notices say, recorded before their texts came from one table of
// languages. A difference here is a change people would see.
func TestBaselineTexts(t *testing.T) {
	for language, want := range map[string]texts{
		"en":  {notice: "New message", open: "Open"},
		"fa":  {notice: "پیام جدید", open: "باز کردن"},
		"qaa": {notice: "New message", open: "Open"}, // a stored value the code doesn't know
		"":    {notice: "New message", open: "Open"},
	} {
		if got := textFor(language); got != want {
			t.Errorf("%q: %+v", language, got)
		}
	}
}

// The notice language picked from Telegram's code, for every shared vector
// (../i18n/testdata/languages.json, which the app's tests read too).
func TestBaselineLanguage(t *testing.T) {
	raw, err := os.ReadFile("../i18n/testdata/languages.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Pick map[string]string `json:"pick"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil || len(vectors.Pick) == 0 {
		t.Fatalf("vectors: %v", err)
	}
	for code, want := range vectors.Pick {
		if got := Language(code); got != want {
			t.Errorf("Language(%q) = %q, want %q", code, got, want)
		}
	}
}
