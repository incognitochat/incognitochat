package ids

import "testing"

// An ID has one spelling: whatever Decode accepts, Encode writes back the
// same, and Valid agrees with Decode.
func FuzzDecode(f *testing.F) {
	for _, seed := range []string{
		New(),
		"AAAAAAAAAAAAAAAAAAAAAA",
		"AAAAAAAAAAAAAAAAAAAAAB", // the last character carries unused bits
		"____________________w",
		"AAAAAAAAAA\rAAAAAAAAAAA",
		"AAAAAAAAAAAAAAAAAAAAA=",
		"",
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, id string) {
		b, err := Decode(id)
		if Valid(id) != (err == nil) {
			t.Fatalf("Valid and Decode disagree on %q", id)
		}
		if err != nil {
			return
		}
		if Encode(b) != id {
			t.Fatalf("non-canonical ID %q accepted, which Encode writes %q", id, Encode(b))
		}
	})
}
