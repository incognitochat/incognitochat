package api

import (
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"maps"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/devicesig"
	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/links"
	"github.com/incognitochat/incognitochat/backend/internal/session"
)

func TestSignedRequestsRejects(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	d := newDevice(t)
	token := h.loggedIn(t, d, false)
	body := newLinkKeys(t).create(t, h.now)

	// No token, or an expired one.
	status, out := h.call(t, d, "", http.MethodPost, "/links", body, true)
	wantError(t, status, out, http.StatusUnauthorized, "session_expired")
	h.now = h.now.Add(session.TTL + time.Second)
	status, out = h.call(t, d, token, http.MethodGet, "/account", nil, false)
	wantError(t, status, out, http.StatusUnauthorized, "session_expired")
	h.now = start
	token = h.token(t, d)

	// A token in Authorization, as apps before X-Session sent it: no more
	// (AUTH-7).
	var bearer httpapi.Request
	bearer.RawPath = "/account"
	bearer.RequestContext.HTTP.Method = http.MethodGet
	bearer.Headers = map[string]string{"authorization": "Bearer " + token}
	if resp, _ := h.router.Serve(context.Background(), bearer); resp.StatusCode != http.StatusUnauthorized || resp.Body != `{"error":"session_expired"}` {
		t.Fatalf("a token in Authorization: %d %s", resp.StatusCode, resp.Body)
	}

	// A token without a signature.
	status, out = h.call(t, d, token, http.MethodPost, "/links", body, false)
	wantError(t, status, out, http.StatusUnauthorized, "signature_rejected")

	// A signature over another body.
	raw, _ := json.Marshal(body)
	var req httpapi.Request
	req.RawPath = "/links"
	req.RequestContext.HTTP.Method = http.MethodPost
	signed := session.SignedRequest{AccountID: d.account, DeviceID: d.id, Method: http.MethodPost, Path: "/links",
		Body: []byte("{}"), Timestamp: h.now.Unix(), Nonce: b64(randomBytes(t, 16))}
	sig := signP1363(t, d.dsk, devicesig.Message(devicesig.LabelRequest, session.RequestParts(signed)...))
	req.Headers = map[string]string{
		"content-type":       "application/json",
		"x-session":          token,
		"x-device-signature": strconv.FormatInt(signed.Timestamp, 10) + "." + signed.Nonce + "." + b64(sig),
	}
	req.Body = string(raw)
	resp, _ := h.router.Serve(context.Background(), req)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("signature over another body: %d %s", resp.StatusCode, resp.Body)
	}
	// The refused attempt didn't use up the nonce: with the signed body the
	// request gets past authentication (and fails as a link)...
	req.Body = "{}"
	resp, _ = h.router.Serve(context.Background(), req)
	if resp.StatusCode != http.StatusBadRequest || resp.Body != `{"error":"invalid_link"}` {
		t.Fatalf("signed body: %d %s", resp.StatusCode, resp.Body)
	}
	// ...and sending it again is a replay.
	resp, _ = h.router.Serve(context.Background(), req)
	if resp.StatusCode != http.StatusUnauthorized || resp.Body != `{"error":"signature_rejected"}` {
		t.Fatalf("replayed signature: %d %s", resp.StatusCode, resp.Body)
	}
}

func TestReplacedAccountIsCutOffAtOnce(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	old := newDevice(t)
	oldToken := h.loggedIn(t, old, false)
	l := newLinkKeys(t)
	if status, out := h.call(t, old, oldToken, http.MethodPost, "/links", l.create(t, h.now), true); status != http.StatusCreated {
		t.Fatalf("create: %d %v", status, out)
	}

	h.loggedIn(t, newDevice(t), true)

	// The old token hasn't expired, but the account is gone.
	status, out := h.call(t, old, oldToken, http.MethodGet, "/account", nil, false)
	wantError(t, status, out, http.StatusGone, "account_replaced")
	status, out = h.call(t, old, oldToken, http.MethodPost, "/links", newLinkKeys(t).create(t, h.now), true)
	wantError(t, status, out, http.StatusGone, "account_replaced")
	status, out = h.call(t, nil, "", http.MethodGet, "/links/"+l.id, nil, false)
	wantError(t, status, out, http.StatusNotFound, "not_found")
}

// call sends a request as a logged-in device; sign adds a device signature.
func (h *harness) call(t *testing.T, d *device, token, method, path string, body any, sign bool) (int, map[string]any) {
	t.Helper()
	var at time.Time
	if sign {
		at = h.now
	}
	return h.callAt(t, d, token, method, path, body, at)
}

// callAt is call with a device signature made at signedAt by the device's
// clock (none if zero).
func (h *harness) callAt(t *testing.T, d *device, token, method, path string, body any, signedAt time.Time) (int, map[string]any) {
	t.Helper()
	sign := !signedAt.IsZero()
	body = signProof(t, body, d, path)
	var raw []byte
	if body != nil {
		var err error
		if raw, err = json.Marshal(body); err != nil {
			t.Fatal(err)
		}
	}
	var req httpapi.Request
	req.RawPath, req.RawQueryString, _ = strings.Cut(path, "?")
	if query, err := url.ParseQuery(req.RawQueryString); err == nil && len(query) > 0 {
		req.QueryStringParameters = map[string]string{}
		for k := range query {
			req.QueryStringParameters[k] = query.Get(k)
		}
	}
	req.RequestContext.HTTP.Method = method
	req.Headers = map[string]string{"content-type": "application/json"}
	if token != "" {
		req.Headers["x-session"] = token
	}
	req.Body = string(raw)
	if sign {
		signed := session.SignedRequest{
			AccountID: d.account, DeviceID: d.id, Method: method, Path: req.RawPath, Body: raw,
			Timestamp: signedAt.Unix(), Nonce: b64(randomBytes(t, 16)),
		}
		sig := signP1363(t, d.dsk, devicesig.Message(devicesig.LabelRequest, session.RequestParts(signed)...))
		req.Headers["x-device-signature"] = strconv.FormatInt(signed.Timestamp, 10) + "." + signed.Nonce + "." + b64(sig)
	}
	resp, err := h.router.Serve(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(resp.Body), &out); err != nil {
		t.Fatalf("response body %q: %v", resp.Body, err)
	}
	return resp.StatusCode, out
}

// loggedIn registers a device and returns a session token for it.
func (h *harness) loggedIn(t *testing.T, d *device, replace bool) string {
	t.Helper()
	if status, out := h.register(t, d, replace); status != http.StatusOK {
		t.Fatalf("register: %d %v", status, out)
	}
	return h.token(t, d)
}

// token logs a registered device in.
func (h *harness) token(t *testing.T, d *device) string {
	t.Helper()
	status, out := h.post(t, "/session", d.login(t, h.now))
	if status != http.StatusOK {
		t.Fatalf("login: %d %v", status, out)
	}
	return out["token"].(string)
}

type linkKeys struct {
	id  string
	lsk *ecdsa.PrivateKey
}

func newLinkKeys(t *testing.T) linkKeys {
	lsk, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	return linkKeys{id: b64(randomBytes(t, 8)), lsk: lsk}
}

// encryptionKey returns a signed encryption key valid from the hour of at for four weeks.
func (l linkKeys) encryptionKey(t *testing.T, at time.Time) map[string]any {
	t.Helper()
	ek, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	k := links.Key{Key: ek.PublicKey().Bytes(), From: at.Truncate(time.Hour), Until: at.Truncate(time.Hour).Add(28 * 24 * time.Hour)}
	sig := signP1363(t, l.lsk, devicesig.Message(devicesig.LabelLinkKey, links.KeyParts(k)...))
	return map[string]any{"key": b64(k.Key), "from": k.From.Unix(), "until": k.Until.Unix(), "signature": b64(sig)}
}

func (l linkKeys) create(t *testing.T, at time.Time) map[string]any {
	return map[string]any{"id": l.id, "signingKey": b64(raw(t, l.lsk)), "keys": []any{l.encryptionKey(t, at)}, "proof": l.proof()}
}

// ownerProof stands for a link request's owner proof in a test body:
// callAt signs it for the calling account and the link the body (or, for
// PUT /links/{id}/keys, the path) names.
type ownerProof struct{ lsk *ecdsa.PrivateKey }

func (l linkKeys) proof() ownerProof { return ownerProof{l.lsk} }

// proofFor is an owner proof by a link signing key for a link and account.
func proofFor(t *testing.T, lsk *ecdsa.PrivateKey, linkID, accountID string) string {
	return b64(signP1363(t, lsk, devicesig.Message(devicesig.LabelLinkOwner, links.OwnerParts(linkID, accountID)...)))
}

// signProof returns body with any ownerProof in it signed for the calling
// device's account, as a copy.
func signProof(t *testing.T, body any, d *device, path string) any {
	m, ok := body.(map[string]any)
	if !ok {
		return body
	}
	p, ok := m["proof"].(ownerProof)
	if !ok {
		return body
	}
	id, _ := m["id"].(string)
	if id == "" {
		id = strings.TrimSuffix(strings.TrimPrefix(path, "/links/"), "/keys")
	}
	account := ""
	if d != nil {
		account = d.account
	}
	out := maps.Clone(m)
	out["proof"] = proofFor(t, p.lsk, id, account)
	return out
}

func (h *harness) makeAdmin(user int64) {
	if h.server.Admins == nil {
		h.server.Admins = map[string]bool{}
	}
	h.server.Admins[directory.TelegramHash(h.server.Pepper, user)] = true
}

func TestLinksNeedAnInvitation(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = true
	d := newDevice(t)
	token := h.loggedIn(t, d, false)

	status, out := h.call(t, d, token, http.MethodGet, "/account", nil, false)
	if status != http.StatusOK || out["canCreateLinks"] != false || out["admin"] != false {
		t.Fatalf("account: %d %v", status, out)
	}
	status, out = h.call(t, d, token, http.MethodPost, "/links", newLinkKeys(t).create(t, h.now), true)
	wantError(t, status, out, http.StatusForbidden, "invitation_required")

	h.server.InviteOnly = false
	if status, out := h.call(t, d, token, http.MethodPost, "/links", newLinkKeys(t).create(t, h.now), true); status != http.StatusCreated {
		t.Fatalf("open mode: %d %v", status, out)
	}
}

func TestLinkLifecycle(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = true
	h.makeAdmin(userID)
	d := newDevice(t)
	token := h.loggedIn(t, d, false)

	status, out := h.call(t, d, token, http.MethodGet, "/account", nil, false)
	if status != http.StatusOK || out["canCreateLinks"] != true || out["admin"] != true || out["maxLinks"] != float64(links.MaxActive) {
		t.Fatalf("account: %d %v", status, out)
	}

	l := newLinkKeys(t)
	create := l.create(t, h.now)
	if status, out := h.call(t, d, token, http.MethodPost, "/links", create, true); status != http.StatusCreated || out["id"] != l.id {
		t.Fatalf("create: %d %v", status, out)
	}
	status, out = h.call(t, d, token, http.MethodPost, "/links", create, true)
	wantError(t, status, out, http.StatusConflict, "conflict")

	// Anyone can read the bundle, which says nothing about the owner.
	status, out = h.call(t, nil, "", http.MethodGet, "/links/"+l.id, nil, false)
	if status != http.StatusOK || out["signingKey"] != b64(raw(t, l.lsk)) || len(out) != 3 || !ids.Valid(out["mailbox"].(string)) {
		t.Fatalf("bundle: %d %v", status, out)
	}
	if keys := out["keys"].([]any); len(keys) != 1 || keys[0].(map[string]any)["key"] != create["keys"].([]any)[0].(map[string]any)["key"] {
		t.Fatalf("bundle keys: %v", out["keys"])
	}

	// Rotation.
	next := l.encryptionKey(t, h.now)
	if status, out := h.call(t, d, token, http.MethodPut, "/links/"+l.id+"/keys", map[string]any{"keys": []any{next}, "proof": l.proof()}, true); status != http.StatusOK {
		t.Fatalf("rotate: %d %v", status, out)
	}
	_, out = h.call(t, nil, "", http.MethodGet, "/links/"+l.id, nil, false)
	if out["keys"].([]any)[0].(map[string]any)["key"] != next["key"] {
		t.Fatal("keys not rotated")
	}
	forged := newLinkKeys(t).encryptionKey(t, h.now) // signed by another link's key
	status, out = h.call(t, d, token, http.MethodPut, "/links/"+l.id+"/keys", map[string]any{"keys": []any{forged}, "proof": l.proof()}, true)
	wantError(t, status, out, http.StatusBadRequest, "invalid_link")

	// Revocation: afterwards the link looks like it never existed.
	if status, out := h.call(t, d, token, http.MethodDelete, "/links/"+l.id, nil, true); status != http.StatusOK {
		t.Fatalf("revoke: %d %v", status, out)
	}
	status, out = h.call(t, nil, "", http.MethodGet, "/links/"+l.id, nil, false)
	wantError(t, status, out, http.StatusNotFound, "not_found")
	status, out = h.call(t, nil, "", http.MethodGet, "/links/"+newLinkKeys(t).id, nil, false)
	wantError(t, status, out, http.StatusNotFound, "not_found")
	status, out = h.call(t, d, token, http.MethodDelete, "/links/"+l.id, nil, true)
	wantError(t, status, out, http.StatusNotFound, "not_found")
}

func TestLinkLimitAndOwnership(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	d := newDevice(t)
	token := h.loggedIn(t, d, false)
	var first linkKeys
	for i := range links.MaxActive {
		l := newLinkKeys(t)
		if i == 0 {
			first = l
		}
		if status, out := h.call(t, d, token, http.MethodPost, "/links", l.create(t, h.now), true); status != http.StatusCreated {
			t.Fatalf("link %d: %d %v", i+1, status, out)
		}
	}
	status, out := h.call(t, d, token, http.MethodPost, "/links", newLinkKeys(t).create(t, h.now), true)
	wantError(t, status, out, http.StatusConflict, "link_limit")

	// Another Telegram user can't touch the first one's links: they answer
	// exactly like links that don't exist.
	other := newDevice(t)
	other.user = userID + 1
	otherToken := h.loggedIn(t, other, false)
	status, out = h.call(t, other, otherToken, http.MethodDelete, "/links/"+first.id, nil, true)
	wantError(t, status, out, http.StatusNotFound, "not_found")
	status, out = h.call(t, other, otherToken, http.MethodPut, "/links/"+first.id+"/keys",
		map[string]any{"keys": []any{first.encryptionKey(t, h.now)}, "proof": first.proof()}, true)
	wantError(t, status, out, http.StatusNotFound, "not_found")
	if status, _ := h.call(t, nil, "", http.MethodGet, "/links/"+first.id, nil, false); status != http.StatusOK {
		t.Fatal("the link was changed by another account")
	}
}

func TestReplaceLink(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	owner := h.account(t, userID)
	old := newLinkKeys(t)
	_, out := h.as(t, owner, http.MethodPost, "/links", old.create(t, h.now), true)
	oldIntro := out["mailbox"].(string)

	// Same signing key, new ID: a new address for the same link identity.
	next := linkKeys{id: b64(randomBytes(t, 8)), lsk: old.lsk}
	body := next.create(t, h.now)
	body["replaces"] = old.id
	status, out := h.as(t, owner, http.MethodPost, "/links", body, true)
	if status != http.StatusCreated || out["id"] != next.id {
		t.Fatalf("replace: %d %v", status, out)
	}
	if status, _ := h.call(t, nil, "", http.MethodGet, "/links/"+old.id, nil, false); status != http.StatusNotFound {
		t.Fatalf("old link still answers: %d", status)
	}
	if _, bundle := h.call(t, nil, "", http.MethodGet, "/links/"+next.id, nil, false); bundle["signingKey"] != b64(raw(t, old.lsk)) {
		t.Fatalf("new bundle = %v", bundle)
	}
	// First messages to the old intro mailbox go nowhere now.
	h.post(t, "/send", map[string]any{"mailbox": oldIntro, "envelope": clientEnvelope(t), "token": mintToken(t, h.now)})
	if _, out := h.as(t, owner, http.MethodGet, "/inbox", nil, false); len(out["items"].([]any)) != 0 {
		t.Fatalf("the old intro mailbox delivered: %v", out)
	}

	// Replacing a link that's gone, or someone else's, or with a bad ID.
	for _, replaces := range []string{old.id, "bad"} {
		b := newLinkKeys(t).create(t, h.now)
		b["replaces"] = replaces
		status, out := h.as(t, owner, http.MethodPost, "/links", b, true)
		wantError(t, status, out, http.StatusNotFound, "not_found")
	}
	other := h.account(t, userID+1)
	b := newLinkKeys(t).create(t, h.now)
	b["replaces"] = next.id
	status, out = h.as(t, other, http.MethodPost, "/links", b, true)
	wantError(t, status, out, http.StatusNotFound, "not_found")
	// It has to be signed.
	status, out = h.as(t, owner, http.MethodPost, "/links", b, false)
	if status != http.StatusUnauthorized {
		t.Fatalf("unsigned replace: %d %v", status, out)
	}
}

func TestLinkChangesPerDay(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	owner := h.account(t, userID)
	current := newLinkKeys(t)
	if status, out := h.as(t, owner, http.MethodPost, "/links", current.create(t, h.now), true); status != http.StatusCreated {
		t.Fatalf("create: %d %v", status, out)
	}
	replace := func() (int, map[string]any) {
		next := linkKeys{id: b64(randomBytes(t, 8)), lsk: current.lsk}
		body := next.create(t, h.now)
		body["replaces"] = current.id
		status, out := h.as(t, owner, http.MethodPost, "/links", body, true)
		if status == http.StatusCreated {
			current = next
		}
		return status, out
	}
	// Creating counts, and so does each replacement.
	for range LinkChangesPerDay - 1 {
		if status, out := replace(); status != http.StatusCreated {
			t.Fatalf("replace: %d %v", status, out)
		}
	}
	status, out := replace()
	wantError(t, status, out, http.StatusTooManyRequests, "rate_limited")
	// The link is untouched.
	if status, _ := h.call(t, nil, "", http.MethodGet, "/links/"+current.id, nil, false); status != http.StatusOK {
		t.Fatalf("link after the limit: %d", status)
	}
}

// Creating, replacing or rotating a link needs an owner proof: a signature
// by the link signing key over the link ID and the caller's account ID. A
// copied bundle, whose signed keys anyone can read, doesn't make one; nor
// does a proof made for another account or another link, checked before
// anything else.
func TestLinksNeedAnOwnerProof(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	owner, other := h.account(t, userID), h.account(t, userID+1)
	l := newLinkKeys(t)
	body := l.create(t, h.now)
	refused := func(what string, status int, out map[string]any) {
		t.Helper()
		if status != http.StatusBadRequest || out["error"] != "invalid_link" {
			t.Fatalf("%s: %d %v", what, status, out)
		}
	}
	bad := map[string]any{
		"none":                  nil,
		"another key":           proofFor(t, newLinkKeys(t).lsk, l.id, owner.d.account),
		"another account":       proofFor(t, l.lsk, l.id, other.d.account),
		"another link":          proofFor(t, l.lsk, newLinkKeys(t).id, owner.d.account),
		"an encryption key's":   body["keys"].([]any)[0].(map[string]any)["signature"],
		"garbage of the length": b64(randomBytes(t, 64)),
	}
	for name, proof := range bad {
		b := maps.Clone(body)
		if proof == nil {
			delete(b, "proof")
		} else {
			b["proof"] = proof
		}
		status, out := h.as(t, owner, http.MethodPost, "/links", b, true)
		refused("create, "+name, status, out)
	}
	if status, out := h.as(t, owner, http.MethodPost, "/links", body, true); status != http.StatusCreated {
		t.Fatalf("create: %d %v", status, out)
	}

	// Replacing.
	next := linkKeys{id: b64(randomBytes(t, 8)), lsk: l.lsk}
	replace := next.create(t, h.now)
	replace["replaces"] = l.id
	delete(replace, "proof")
	status, out := h.as(t, owner, http.MethodPost, "/links", replace, true)
	refused("replace without a proof", status, out)
	replace["proof"] = proofFor(t, l.lsk, l.id, owner.d.account) // the old link's
	status, out = h.as(t, owner, http.MethodPost, "/links", replace, true)
	refused("replace with the old link's proof", status, out)

	// Rotating: the new keys' signatures alone don't do, since a copy of a
	// bundle has keys signed by the same key.
	rotate := map[string]any{"keys": []any{l.encryptionKey(t, h.now)}}
	status, out = h.as(t, owner, http.MethodPut, "/links/"+l.id+"/keys", rotate, true)
	refused("rotate without a proof", status, out)
	rotate["proof"] = proofFor(t, l.lsk, l.id, other.d.account)
	status, out = h.as(t, owner, http.MethodPut, "/links/"+l.id+"/keys", rotate, true)
	refused("rotate with another account's proof", status, out)
	rotate["proof"] = l.proof()
	if status, out := h.as(t, owner, http.MethodPut, "/links/"+l.id+"/keys", rotate, true); status != http.StatusOK {
		t.Fatalf("rotate: %d %v", status, out)
	}
}

// Another account holding the signing key (shared on purpose) and proving
// it still can't use it: signing_key_taken, so a sender's tag never matches
// across accounts. The owner keeps it when it replaces its link.
func TestSigningKeyIsOneAccounts(t *testing.T) {
	h := newHarness(t)
	h.server.InviteOnly = false
	owner, other := h.account(t, userID), h.account(t, userID+1)
	l := newLinkKeys(t)
	if status, out := h.as(t, owner, http.MethodPost, "/links", l.create(t, h.now), true); status != http.StatusCreated {
		t.Fatalf("create: %d %v", status, out)
	}
	shared := linkKeys{id: b64(randomBytes(t, 8)), lsk: l.lsk}
	status, out := h.as(t, other, http.MethodPost, "/links", shared.create(t, h.now), true)
	wantError(t, status, out, http.StatusConflict, "signing_key_taken")
	own := newLinkKeys(t)
	if status, out := h.as(t, other, http.MethodPost, "/links", own.create(t, h.now), true); status != http.StatusCreated {
		t.Fatalf("other's own link: %d %v", status, out)
	}
	body := shared.create(t, h.now)
	body["replaces"] = own.id
	status, out = h.as(t, other, http.MethodPost, "/links", body, true)
	wantError(t, status, out, http.StatusConflict, "signing_key_taken")
	if status, _ := h.call(t, nil, "", http.MethodGet, "/links/"+own.id, nil, false); status != http.StatusOK {
		t.Fatalf("other's link after a refused replacement: %d", status)
	}

	next := linkKeys{id: b64(randomBytes(t, 8)), lsk: l.lsk}
	body = next.create(t, h.now)
	body["replaces"] = l.id
	if status, out := h.as(t, owner, http.MethodPost, "/links", body, true); status != http.StatusCreated {
		t.Fatalf("replace keeping the key: %d %v", status, out)
	}

	// Nor once the owner revoked its link: the key stays the owner's.
	if status, out := h.as(t, owner, http.MethodDelete, "/links/"+next.id, nil, true); status != http.StatusOK {
		t.Fatalf("revoke: %d %v", status, out)
	}
	status, out = h.as(t, other, http.MethodPost, "/links", linkKeys{id: b64(randomBytes(t, 8)), lsk: l.lsk}.create(t, h.now), true)
	wantError(t, status, out, http.StatusConflict, "signing_key_taken")

	// A link from before keys were claimed, whose key another account
	// claimed first, can't be rotated.
	early := newLinkKeys(t)
	h.dir.links[early.id] = &memLink{owner: other.d.account, link: directory.Link{ID: early.id, SigningKey: raw(t, l.lsk), Mailbox: ids.New()}}
	status, out = h.as(t, other, http.MethodPut, "/links/"+early.id+"/keys", map[string]any{"keys": []any{l.encryptionKey(t, h.now)}, "proof": l.proof()}, true)
	wantError(t, status, out, http.StatusConflict, "signing_key_taken")
}

// Through the DynamoDB directory: a copy of a revoked link's bundle can't be
// put back up by another account (it can't prove it holds the key), the
// owner makes its next link with its key, and the key stays the owner's
// for good: no other account, even one holding the private key, gets it,
// while the owner has it or after its account ended.
func TestSigningKeyStaysWithItsAccount(t *testing.T) {
	client := dynamotest.Client(t)
	h := newHarness(t)
	h.server.InviteOnly = false
	h.server.Directory = &directory.Store{DB: client, Table: dynamotest.Table(t, client)}
	h.router = httpapi.NewRouter()
	h.server.Routes(h.router)
	owner, attacker, colluder := h.account(t, userID), h.account(t, userID+1), h.account(t, userID+2)
	l := newLinkKeys(t)
	if status, out := h.as(t, owner, http.MethodPost, "/links", l.create(t, h.now), true); status != http.StatusCreated {
		t.Fatalf("create: %d %v", status, out)
	}
	_, bundle := h.call(t, nil, "", http.MethodGet, "/links/"+l.id, nil, false)
	if status, out := h.as(t, owner, http.MethodDelete, "/links/"+l.id, nil, true); status != http.StatusOK {
		t.Fatalf("revoke: %d %v", status, out)
	}
	copied := map[string]any{"id": b64(randomBytes(t, 8)), "signingKey": bundle["signingKey"], "keys": bundle["keys"]}
	status, out := h.as(t, attacker, http.MethodPost, "/links", copied, true)
	wantError(t, status, out, http.StatusBadRequest, "invalid_link")
	copied["proof"] = proofFor(t, l.lsk, l.id, owner.d.account) // the most it could have seen
	status, out = h.as(t, attacker, http.MethodPost, "/links", copied, true)
	wantError(t, status, out, http.StatusBadRequest, "invalid_link")

	// The owner's next link, with the key it kept.
	again := linkKeys{id: b64(randomBytes(t, 8)), lsk: l.lsk}
	if status, out := h.as(t, owner, http.MethodPost, "/links", again.create(t, h.now), true); status != http.StatusCreated {
		t.Fatalf("the owner's key after a revocation: %d %v", status, out)
	}
	shared := linkKeys{id: b64(randomBytes(t, 8)), lsk: l.lsk}
	status, out = h.as(t, colluder, http.MethodPost, "/links", shared.create(t, h.now), true)
	wantError(t, status, out, http.StatusConflict, "signing_key_taken")

	// The owner sets up again: its old account ends, and its key with it.
	successor := newDevice(t)
	successor.user = userID
	next := member{d: successor, token: h.loggedIn(t, successor, true)}
	for who, m := range map[string]member{"another account": colluder, "the owner's new account": next} {
		status, out := h.as(t, m, http.MethodPost, "/links", linkKeys{id: b64(randomBytes(t, 8)), lsk: l.lsk}.create(t, h.now), true)
		if status != http.StatusConflict || out["error"] != "signing_key_taken" {
			t.Fatalf("%s, after the owner's account ended: %d %v", who, status, out)
		}
	}
}

// On the real tables (DIR-6): once a link goes, revoked, replaced or with
// its account, its ID stays taken. Another account can't put its own keys
// up under it, so whoever opens the old link is told it doesn't exist
// (not_found, as for a link that never did), not shown a link whose keys
// don't match it.
func TestGoneLinkIDsStayTaken(t *testing.T) {
	client := dynamotest.Client(t)
	h := newHarness(t)
	h.server.InviteOnly = false
	h.server.Directory = &directory.Store{DB: client, Table: dynamotest.Table(t, client)}
	h.router = httpapi.NewRouter()
	h.server.Routes(h.router)
	owner, attacker := h.account(t, userID), h.account(t, userID+1)
	gone := func(id, how string) {
		t.Helper()
		status, out := h.call(t, nil, "", http.MethodGet, "/links/"+id, nil, false)
		if status != http.StatusNotFound || out["error"] != "not_found" {
			t.Fatalf("%s link: %d %v", how, status, out)
		}
		// Claimed with the attacker's own key and a valid proof: as for an ID in use.
		status, out = h.as(t, attacker, http.MethodPost, "/links", linkKeys{id: id, lsk: newLinkKeys(t).lsk}.create(t, h.now), true)
		if status != http.StatusConflict || out["error"] != "conflict" {
			t.Fatalf("another account takes a %s link's ID: %d %v", how, status, out)
		}
	}

	revoked := newLinkKeys(t)
	if status, out := h.as(t, owner, http.MethodPost, "/links", revoked.create(t, h.now), true); status != http.StatusCreated {
		t.Fatalf("create: %d %v", status, out)
	}
	if status, out := h.as(t, owner, http.MethodDelete, "/links/"+revoked.id, nil, true); status != http.StatusOK {
		t.Fatalf("revoke: %d %v", status, out)
	}
	gone(revoked.id, "revoked")

	replaced := newLinkKeys(t)
	if status, out := h.as(t, owner, http.MethodPost, "/links", replaced.create(t, h.now), true); status != http.StatusCreated {
		t.Fatalf("create: %d %v", status, out)
	}
	next := linkKeys{id: b64(randomBytes(t, 8)), lsk: replaced.lsk}
	body := next.create(t, h.now)
	body["replaces"] = replaced.id
	if status, out := h.as(t, owner, http.MethodPost, "/links", body, true); status != http.StatusCreated {
		t.Fatalf("replace: %d %v", status, out)
	}
	gone(replaced.id, "replaced")

	// The owner sets up again: its old account ends, with its link.
	successor := newDevice(t)
	successor.user = userID
	h.loggedIn(t, successor, true)
	gone(next.id, "ended account's")

	// The attacker's own link, with an ID never used, is made as usual.
	if status, out := h.as(t, attacker, http.MethodPost, "/links", newLinkKeys(t).create(t, h.now), true); status != http.StatusCreated {
		t.Fatalf("a fresh ID: %d %v", status, out)
	}
}
