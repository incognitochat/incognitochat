package envelope

import (
	"slices"
	"testing"
)

// Check accepts only the layout docs/protocol.md describes: the suite, 1–16
// wraps, a body of a padded size, and nothing larger than MaxLen, which
// costs no more than MaxTokens.
func FuzzCheck(f *testing.F) {
	f.Add([]byte{})
	f.Add([]byte{Suite, 1})
	smallest := make([]byte, 2+WrapLen+nonceLen+PaddedSizes[0]+tagLen)
	smallest[0], smallest[1] = Suite, 1
	f.Add(smallest)
	wrong := slices.Clone(smallest)
	wrong[1] = 2
	f.Add(wrong)
	largest := make([]byte, MaxLen)
	largest[0], largest[1] = Suite, MaxWraps
	f.Add(largest)
	f.Fuzz(func(t *testing.T, env []byte) {
		n, err := Check(env)
		if err != nil {
			if n != 0 {
				t.Fatalf("refused with %d wraps", n)
			}
			return
		}
		if len(env) > MaxLen || env[0] != Suite || n < 1 || n > MaxWraps || int(env[1]) != n {
			t.Fatalf("accepted %d bytes with %d wraps", len(env), n)
		}
		if body := len(env) - 2 - n*WrapLen - nonceLen - tagLen; !slices.Contains(PaddedSizes, body) {
			t.Fatalf("accepted an inner message of %d bytes", body)
		}
		if tokens := TokensFor(len(env)); tokens < 1 || tokens > MaxTokens {
			t.Fatalf("an accepted envelope costs %d tokens", tokens)
		}
	})
}
