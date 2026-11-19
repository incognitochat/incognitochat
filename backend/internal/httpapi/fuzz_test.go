package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"
)

type fuzzBody struct {
	A string   `json:"a"`
	N int      `json:"n"`
	L []string `json:"l"`
	B bool     `json:"b"`
	O *struct {
		X int64 `json:"x"`
	} `json:"o"`
}

// DecodeJSON accepts only one valid JSON value of at most MaxBody bytes,
// sent as application/json, and decodes it as encoding/json does. Anything
// else is ErrMediaType or ErrBadRequest, never another error.
func FuzzDecodeJSON(f *testing.F) {
	f.Add(`{"a":"x","n":1}`, "application/json", false)
	f.Add(`{"a":"x","a":"y"}`, "application/json; charset=utf-8", false)
	f.Add(`{"A":"x","o":{"x":-1},"l":["p"]}`, " APPLICATION/JSON ", false)
	f.Add(`{"a":"x"} {}`, "application/json", false)
	f.Add(`{"a":"x"} ]`, "application/json", false)
	f.Add(`{"unknown":1}`, "application/json", false)
	f.Add(`eyJhIjoieCJ9`, "application/json", true)
	f.Add(`eyJhIjoieCJ9`+"\r\n", "application/json", true)
	f.Add(`{"a":"x"}`, "text/plain", false)
	f.Add(`[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[`, "application/json", false)
	f.Fuzz(func(t *testing.T, body, contentType string, encoded bool) {
		req := Request{Body: body, IsBase64Encoded: encoded, Headers: map[string]string{"content-type": contentType}}
		var got fuzzBody
		err := DecodeJSON(req, &got)
		if err != nil {
			if !errors.Is(err, ErrBadRequest) && !errors.Is(err, ErrMediaType) {
				t.Fatalf("error %v", err)
			}
			if status := DecodeError(err).StatusCode; status != http.StatusBadRequest && status != http.StatusUnsupportedMediaType {
				t.Fatalf("status %d", status)
			}
			return
		}
		raw := []byte(body)
		if encoded {
			if raw, err = base64.StdEncoding.DecodeString(body); err != nil {
				t.Fatalf("accepted a body that isn't base64: %q", body)
			}
		}
		if len(raw) > MaxBody {
			t.Fatalf("accepted a body of %d bytes", len(raw))
		}
		if !json.Valid(raw) {
			t.Fatalf("accepted %q, which isn't one JSON value", raw)
		}
		var want fuzzBody
		if err := json.Unmarshal(raw, &want); err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("%q decoded as %+v, encoding/json gives %+v (%v)", raw, got, want, err)
		}
	})
}

// fuzzRoutes are routes like the API's, with static and parameter patterns
// that overlap.
var fuzzRoutes = []struct{ method, pattern string }{
	{http.MethodGet, "/"},
	{http.MethodPost, "/links"},
	{http.MethodGet, "/links/{id}"},
	{http.MethodDelete, "/links/{id}"},
	{http.MethodPut, "/links/{id}/keys"},
	{http.MethodPost, "/mailboxes/check"},
	{http.MethodPost, "/mailboxes/{id}/discard"},
	{http.MethodGet, "/{x}/{id}"},
	{http.MethodGet, "/media/{id}"},
}

var paramPattern = regexp.MustCompile(`\{([a-z]+)\}`)

// expectRoute is what Serve should do, worked out differently: each pattern
// as a regular expression, statics before patterns with parameters, each
// group in the order patterns were first registered. It returns the index
// of the route and its parameters, or the status of a refusal.
func expectRoute(method, path string) (int, map[string]string, int) {
	path = strings.TrimPrefix(path, "/")
	status := http.StatusNotFound
	for _, static := range []bool{true, false} {
		for i, r := range fuzzRoutes {
			names := paramPattern.FindAllStringSubmatch(r.pattern, -1)
			if (len(names) == 0) != static {
				continue
			}
			segments := strings.Split(strings.TrimPrefix(r.pattern, "/"), "/")
			for j, s := range segments {
				if paramPattern.MatchString(s) {
					segments[j] = `([^/]+)`
				} else {
					segments[j] = regexp.QuoteMeta(s)
				}
			}
			match := regexp.MustCompile("^" + strings.Join(segments, "/") + "$").FindStringSubmatch(path)
			if match == nil {
				continue
			}
			if r.method != strings.ToUpper(method) {
				status = http.StatusMethodNotAllowed
				continue
			}
			params := map[string]string{}
			for j, name := range names {
				params[name[1]] = match[j+1]
			}
			return i, params, http.StatusOK
		}
	}
	return -1, nil, status
}

// Serve picks the route the patterns say, with the right parameters, or
// answers 404 or 405, and tells Observe the pattern, never the path.
func FuzzRouter(f *testing.F) {
	r := NewRouter()
	var gotRoute int
	var gotParams map[string]string
	for i, rt := range fuzzRoutes {
		r.Handle(rt.method, rt.pattern, func(ctx context.Context, req Request) Response {
			gotRoute = i
			gotParams = map[string]string{}
			for _, name := range paramPattern.FindAllStringSubmatch(rt.pattern, -1) {
				gotParams[name[1]] = Param(ctx, name[1])
			}
			return JSON(http.StatusOK, map[string]bool{"ok": true})
		})
	}
	var observed string
	r.Observe = func(route string, _ int, _ string, _ time.Duration) { observed = route }
	for _, seed := range [][2]string{
		{"GET", "/links/abc"}, {"get", "links/abc"}, {"DELETE", "/links/abc"}, {"POST", "/links/abc"},
		{"POST", "/mailboxes/check"}, {"POST", "/mailboxes/x/discard"}, {"GET", "/mailboxes/check"},
		{"GET", "/media/m"}, {"GET", "/a/b"}, {"POST", "//"}, {"GET", ""}, {"GET", "/"},
		{"GET", "/links/"}, {"GET", "/links//keys"}, {"PUT", "/links/{id}/keys"},
	} {
		f.Add(seed[0], seed[1])
	}
	f.Fuzz(func(t *testing.T, method, path string) {
		gotRoute, gotParams, observed = -1, nil, ""
		req := Request{RawPath: path}
		req.RequestContext.HTTP.Method = method
		resp, err := r.Serve(context.Background(), req)
		if err != nil {
			t.Fatal(err)
		}
		route, params, status := expectRoute(method, path)
		if resp.StatusCode != status {
			t.Fatalf("%s %q: status %d, want %d", method, path, resp.StatusCode, status)
		}
		if status != http.StatusOK {
			if gotRoute != -1 || observed != "" {
				t.Fatalf("%s %q: refused, but ran route %d (observed %q)", method, path, gotRoute, observed)
			}
			return
		}
		if gotRoute != route || !reflect.DeepEqual(gotParams, params) {
			t.Fatalf("%s %q: route %d with %v, want %d with %v", method, path, gotRoute, gotParams, route, params)
		}
		if want := fuzzRoutes[route].method + " " + fuzzRoutes[route].pattern; observed != want {
			t.Fatalf("observed %q, want %q", observed, want)
		}
	})
}

var codePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)

// ErrorCode only ever returns a short snake_case code, from an error
// response, whatever the body.
func FuzzErrorCode(f *testing.F) {
	f.Add(400, `{"error":"rate_limited"}`, false)
	f.Add(200, `{"error":"rate_limited"}`, false)
	f.Add(404, `{"error":"Not Found"}`, false)
	f.Add(500, `{"error":"a_`+strings.Repeat("b", 40)+`"}`, false)
	f.Add(429, `{"error":"x","error":"y"}`, true)
	f.Fuzz(func(t *testing.T, status int, body string, encoded bool) {
		code := ErrorCode(Response{StatusCode: status, Body: body, IsBase64Encoded: encoded})
		if code == "" {
			return
		}
		if status < http.StatusBadRequest || encoded || !codePattern.MatchString(code) {
			t.Fatalf("code %q from %d %q", code, status, body)
		}
	})
}
