package invitations

import (
	"strings"
	"testing"
)

// Whatever Normalize accepts comes out canonical ("abcd-efgh" in the
// alphabet), normalizes to itself, and survives the trip through an
// invitation link.
func FuzzNormalize(f *testing.F) {
	for _, seed := range []string{
		"abcd-efgh",
		" ABCD EFGH ",
		"abcdefgh",
		"invabcdefgh",
		"https://t.me/bot/app?startapp=invabcdefgh",
		"https://t.me/bot?startapp=invabcdefgh",
		"https://t.me/bot/app?startapp=inv&startapp=abcdefgh",
		"abcd-efg\u212a", // the Kelvin sign lowers to k
		"abcd-efgi",      // i isn't in the alphabet
		"http://[::1",
		"",
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, in string) {
		code, ok := Normalize(in)
		if !ok {
			if code != "" {
				t.Fatalf("refused %q but returned %q", in, code)
			}
			return
		}
		if len(code) != 2*half+1 || code[half] != '-' {
			t.Fatalf("%q normalized to %q", in, code)
		}
		for i, c := range code {
			if i != half && !strings.ContainsRune(Alphabet, c) {
				t.Fatalf("%q normalized to %q", in, code)
			}
		}
		if again, ok := Normalize(code); !ok || again != code {
			t.Fatalf("%q normalizes to %q", code, again)
		}
		if again, ok := Normalize("https://t.me/bot?startapp=" + payload(code)); !ok || again != code {
			t.Fatalf("the link for %q normalizes to %q", code, again)
		}
	})
}
