package initdata_test

import (
	"net/url"
	"regexp"
	"strconv"
	"testing"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/telegram/initdata"
	"github.com/incognitochat/incognitochat/backend/internal/telegram/initdata/initdatatest"
)

const fuzzBot = 123456

var (
	fuzzNow      = time.Unix(1_800_000_000, 0)
	startPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{0,512}$`)
	langPattern  = regexp.MustCompile(`^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})?$`)
)

// signed is launch data Telegram could have sent: user and start_param
// signed with the test key, auth_date age before fuzzNow.
func signed(user, start string, age int64) string {
	fields := map[string]string{
		"auth_date":     strconv.FormatInt(fuzzNow.Unix()-age, 10),
		"chat_instance": "-1",
		"chat_type":     "sender",
		"user":          user,
	}
	if start != "" {
		fields["start_param"] = start
	}
	return initdatatest.Sign(fuzzBot, fields)
}

// checkData fails for accepted data the backend shouldn't get.
func checkData(t *testing.T, v initdata.Verifier, d initdata.Data) {
	t.Helper()
	if d.UserID <= 0 {
		t.Fatalf("accepted user ID %d", d.UserID)
	}
	if !startPattern.MatchString(d.StartParam) {
		t.Fatalf("accepted start parameter %q", d.StartParam)
	}
	if d.LanguageCode != "" && !langPattern.MatchString(d.LanguageCode) {
		t.Fatalf("accepted language %q", d.LanguageCode)
	}
	if d.AuthDate.Before(fuzzNow.Add(-v.MaxAge)) || d.AuthDate.After(fuzzNow.Add(v.MaxSkew)) {
		t.Fatalf("accepted data signed at %s", d.AuthDate)
	}
}

// Any launch data: Verify never panics, and what it accepts is signed, in
// its time window and well formed. The same fields, encoded afresh, give
// the same answer: no field is read one way here and another way there.
func FuzzVerify(f *testing.F) {
	v := initdatatest.Verifier(fuzzBot)
	f.Add(signed(`{"id":42,"first_name":"A"}`, "", 60))
	f.Add(signed(`{"id":42,"allows_write_to_pm":true,"language_code":"fa"}`, "regABC", 0))
	f.Add(signed(`{"id":42}`, "", 3600))
	f.Add("")
	f.Add("signature=" + string(make([]byte, 86)))
	f.Add("a=1&a=2")
	f.Add("%zz")
	f.Add("user=1;signature=2")
	f.Fuzz(func(t *testing.T, raw string) {
		d, err := v.Verify(raw, fuzzNow)
		if err != nil {
			return
		}
		checkData(t, v, d)
		q, err := url.ParseQuery(raw)
		if err != nil {
			t.Fatalf("accepted %q, which doesn't parse", raw)
		}
		again, err := v.Verify(q.Encode(), fuzzNow)
		if err != nil || again != d {
			t.Fatalf("%q gives %+v, encoded afresh %+v (%v)", raw, d, again, err)
		}
	})
}

// Launch data with Telegram's signature over any user JSON, start parameter
// and age: Verify never panics, and returns the user's own ID, the start
// parameter as signed, and only data in its window.
func FuzzVerifySigned(f *testing.F) {
	v := initdatatest.Verifier(fuzzBot)
	f.Add(`{"id":42}`, "", int64(60))
	f.Add(`{"id":42,"id":43}`, "x", int64(0))
	f.Add(`{"id":4.2e1}`, "", int64(0))
	f.Add(`{"id":"42"}`, "", int64(0))
	f.Add(`{"id":42}trailing`, "", int64(0))
	f.Add(`{"id":9223372036854775808}`, "", int64(0))
	f.Add(`{"id":-1}`, "", int64(0))
	f.Add(`{"id":42,"language_code":"fa-IR"}`, "inv-abcd", int64(-60))
	f.Add(`{"id":42}`, "", int64(601))
	f.Fuzz(func(t *testing.T, user, start string, age int64) {
		d, err := v.Verify(signed(user, start, age), fuzzNow)
		if err != nil {
			return
		}
		checkData(t, v, d)
		if d.StartParam != start {
			t.Fatalf("start parameter %q read as %q", start, d.StartParam)
		}
		if d.AuthDate.Unix() != fuzzNow.Unix()-age {
			t.Fatalf("signed %d seconds ago, read as %s", age, d.AuthDate)
		}
	})
}
