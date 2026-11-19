package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/devicesig"
	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/links"
)

// linkKey is an encryption key in a bundle, as JSON.
type linkKey struct {
	Key       bytes64 `json:"key"`
	From      int64   `json:"from"`  // Unix seconds, on a whole hour
	Until     int64   `json:"until"` // Unix seconds, on a whole hour
	Signature bytes64 `json:"signature"`
}

type createLinkRequest struct {
	ID         string    `json:"id"`
	SigningKey bytes64   `json:"signingKey"`
	Keys       []linkKey `json:"keys"`
	// Replaces, if set, is the account's link this one takes the place of,
	// in one step: the old link stops working.
	Replaces string `json:"replaces,omitempty"`
	// Proof shows the caller holds the signing key's private half: its
	// signature over the link ID and the caller's account ID
	// (links.CheckOwner).
	Proof bytes64 `json:"proof"`
}

type linkKeysRequest struct {
	Keys []linkKey `json:"keys"`
	// Proof is as for createLinkRequest, for this link: the keys' own
	// signatures don't show it, since anyone can copy them from a bundle.
	Proof bytes64 `json:"proof"`
}

// bundleResponse is what anyone with a link ID can read. It says nothing
// about the owner.
type bundleResponse struct {
	SigningKey bytes64   `json:"signingKey"`
	Keys       []linkKey `json:"keys"`
	Mailbox    string    `json:"mailbox"` // where first messages go
}

type accountResponse struct {
	CanCreateLinks bool `json:"canCreateLinks"`
	Admin          bool `json:"admin"`
	Links          int  `json:"links"`
	MaxLinks       int  `json:"maxLinks"`
	// Notices says whether Telegram notices are set up and not turned off.
	Notices bool `json:"notices"`
	// Deleting says the account is being deleted (DELETE /account has
	// started): the app carries on with it.
	Deleting bool `json:"deleting"`
	// Cleanup says what is left of an account this one replaced is still
	// to be deleted: the app asks for that (POST /account/cleanup).
	Cleanup bool `json:"cleanup"`
}

// mayOwnLinks says whether an account may create links: while invite-only,
// only members (who joined through an invitation) and admins can.
func (s *Server) mayOwnLinks(d directory.Device) bool {
	return !s.InviteOnly || d.Member || s.isAdmin(d)
}

func (s *Server) isAdmin(d directory.Device) bool {
	return d.TelegramHash != "" && s.Admins[d.TelegramHash]
}

// account describes the logged-in account to its own device.
func (s *Server) account(_ context.Context, _ httpapi.Request, c caller) httpapi.Response {
	return httpapi.JSON(http.StatusOK, accountResponse{
		CanCreateLinks: s.mayOwnLinks(c.device),
		Admin:          s.isAdmin(c.device),
		Links:          c.device.Links,
		MaxLinks:       links.MaxActive,
		Notices:        c.device.Notices,
		Deleting:       c.device.Deleting,
		Cleanup:        len(c.device.Leftovers) > 0,
	})
}

// LinkChangesPerDay limits how often a person (Telegram user) creates or
// replaces their link per UTC day. Each new link is a new intro mailbox.
const LinkChangesPerDay = 5

// createLink stores a link's bundle. The client chooses the link ID, so it
// can sign and keep the link's keys before asking. An account has one link;
// replacing it gives a new address, and the client keeps the signing key, so
// senders' tags (and so blocks and labels) carry over. A signing key is one
// account's for good, or senders' tags would match across accounts: only
// whoever holds its private half can use it (the owner proof, checked
// first), and another account than the first to use it gets
// signing_key_taken.
func (s *Server) createLink(ctx context.Context, req httpapi.Request, c caller) httpapi.Response {
	const route = "POST /links"
	var in createLinkRequest
	if err := httpapi.DecodeJSON(req, &in); err != nil {
		return httpapi.DecodeError(err)
	}
	signingKey, err := devicesig.ParsePublicKey(in.SigningKey)
	if !links.ValidID(in.ID) || err != nil || links.CheckOwner(signingKey, in.Proof, in.ID, c.AccountID) != nil {
		return httpapi.Error(http.StatusBadRequest, "invalid_link")
	}
	if !s.mayOwnLinks(c.device) {
		return httpapi.Error(http.StatusForbidden, "invitation_required")
	}
	keys := toKeys(in.Keys)
	if links.Check(signingKey, keys, s.Now()) != nil {
		return httpapi.Error(http.StatusBadRequest, "invalid_link")
	}

	if in.Replaces != "" && !links.ValidID(in.Replaces) {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	ok, err := s.allow(ctx, "link", LinkChangesPerDay, 24*time.Hour, c.person())
	if err != nil {
		return s.internal(route, err)
	}
	if !ok {
		return httpapi.Error(http.StatusTooManyRequests, "rate_limited")
	}

	link := directory.Link{ID: in.ID, SigningKey: in.SigningKey, Keys: keys, Mailbox: ids.New()}
	if in.Replaces != "" {
		err = s.Directory.ReplaceLink(ctx, c.AccountID, in.Replaces, link)
	} else {
		err = s.Directory.CreateLink(ctx, c.AccountID, link, links.MaxActive)
	}
	switch {
	case errors.Is(err, directory.ErrNotFound):
		// The link to replace is gone, or someone else's.
		return httpapi.Error(http.StatusNotFound, "not_found")
	case errors.Is(err, directory.ErrLimit):
		return httpapi.Error(http.StatusConflict, "link_limit")
	case errors.Is(err, directory.ErrKeyTaken):
		// Another account has (or had) this signing key.
		return httpapi.Error(http.StatusConflict, "signing_key_taken")
	case errors.Is(err, directory.ErrConflict):
		// The ID is taken (or a concurrent change won): pick another and retry.
		return httpapi.Error(http.StatusConflict, "conflict")
	case err != nil:
		return s.internal(route, err)
	}
	return httpapi.JSON(http.StatusCreated, map[string]string{"id": in.ID, "mailbox": link.Mailbox})
}

// setLinkKeys replaces a link's encryption keys (weekly rotation), with an
// owner proof for the link, which also claims the key of a link from before
// keys were claimed (signing_key_taken if another account did first).
func (s *Server) setLinkKeys(ctx context.Context, req httpapi.Request, c caller) httpapi.Response {
	const route = "PUT /links/{id}/keys"
	id := httpapi.Param(ctx, "id")
	var in linkKeysRequest
	if err := httpapi.DecodeJSON(req, &in); err != nil {
		return httpapi.DecodeError(err)
	}
	if !links.ValidID(id) {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	link, err := s.Directory.Link(ctx, id)
	if errors.Is(err, directory.ErrNotFound) {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	if err != nil {
		return s.internal(route, err)
	}
	signingKey, err := devicesig.ParsePublicKey(link.SigningKey)
	if err != nil {
		return s.internal(route, err)
	}
	if links.CheckOwner(signingKey, in.Proof, id, c.AccountID) != nil {
		return httpapi.Error(http.StatusBadRequest, "invalid_link")
	}
	keys := toKeys(in.Keys)
	if links.Check(signingKey, keys, s.Now()) != nil {
		return httpapi.Error(http.StatusBadRequest, "invalid_link")
	}
	err = s.Directory.SetLinkKeys(ctx, c.AccountID, id, keys)
	switch {
	case errors.Is(err, directory.ErrNotFound):
		// Someone else's link answers exactly like a missing one.
		return httpapi.Error(http.StatusNotFound, "not_found")
	case errors.Is(err, directory.ErrKeyTaken):
		// A link from before keys were claimed, whose key another account
		// claimed first.
		return httpapi.Error(http.StatusConflict, "signing_key_taken")
	case errors.Is(err, directory.ErrConflict):
		return httpapi.Error(http.StatusConflict, "conflict")
	case err != nil:
		return s.internal(route, err)
	}
	return httpapi.JSON(http.StatusOK, map[string]string{})
}

// revokeLink deletes a link; its bundle then answers like one that never existed.
func (s *Server) revokeLink(ctx context.Context, _ httpapi.Request, c caller) httpapi.Response {
	const route = "DELETE /links/{id}"
	id := httpapi.Param(ctx, "id")
	if !links.ValidID(id) {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	err := s.Directory.DeleteLink(ctx, c.AccountID, id)
	if errors.Is(err, directory.ErrNotFound) {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	if errors.Is(err, directory.ErrConflict) {
		// A concurrent change to the account's links won: try again.
		return httpapi.Error(http.StatusConflict, "conflict")
	}
	if err != nil {
		return s.internal(route, err)
	}
	return httpapi.JSON(http.StatusOK, map[string]string{})
}

// linkBundle returns a link's public bundle, without logging in: senders
// check it against the fingerprint in the link before encrypting.
func (s *Server) linkBundle(ctx context.Context, _ httpapi.Request) httpapi.Response {
	const route = "GET /links/{id}"
	id := httpapi.Param(ctx, "id")
	if !links.ValidID(id) {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	link, err := s.Directory.Bundle(ctx, id)
	if errors.Is(err, directory.ErrNotFound) {
		return httpapi.Error(http.StatusNotFound, "not_found")
	}
	if err != nil {
		return s.internal(route, err)
	}
	out := bundleResponse{SigningKey: link.SigningKey, Keys: make([]linkKey, len(link.Keys)), Mailbox: link.Mailbox}
	for i, k := range link.Keys {
		out.Keys[i] = linkKey{Key: k.Key, From: k.From.Unix(), Until: k.Until.Unix(), Signature: k.Signature}
	}
	return httpapi.JSON(http.StatusOK, out)
}

func toKeys(in []linkKey) []links.Key {
	keys := make([]links.Key, len(in))
	for i, k := range in {
		keys[i] = links.Key{Key: k.Key, From: time.Unix(k.From, 0), Until: time.Unix(k.Until, 0), Signature: k.Signature}
	}
	return keys
}
