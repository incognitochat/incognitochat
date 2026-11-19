package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/incognitochat/incognitochat/backend/internal/devicelist"
	"github.com/incognitochat/incognitochat/backend/internal/devicesig"
	"github.com/incognitochat/incognitochat/backend/internal/directory"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/logx"
)

const (
	// RegistrationPrefix starts the start_param of a registration launch;
	// the account key's fingerprint follows it.
	RegistrationPrefix = "reg"
	// RegistrationsPerDay limits new accounts and replacements per Telegram
	// user per UTC day.
	RegistrationsPerDay = 3
	// RegisterAttemptsPerDay limits, per Telegram user and UTC day, the
	// registrations that get as far as reading the directory: retries,
	// refusals and replays of one launch (valid for minutes) included.
	RegisterAttemptsPerDay = 20

	maxInitData = 8 << 10
	// A first device list may be issued this far from the server's clock.
	listIssuedBefore = 2 * time.Hour
	listIssuedAfter  = time.Hour
)

type registerRequest struct {
	InitData      string  `json:"initData"`
	AccountKey    bytes64 `json:"accountKey"`
	Device        string  `json:"device"`
	DeviceKey     bytes64 `json:"deviceKey"`
	DeviceList    bytes64 `json:"deviceList"`
	DeviceListSig bytes64 `json:"deviceListSig"`
	AccountSig    bytes64 `json:"accountSig"`
	DeviceSig     bytes64 `json:"deviceSig"`
	Replace       bool    `json:"replace"`
}

// RegisterParts are the parts both the account key and the device key sign
// to register: the SHA-256 of the raw initData, the account key, the device
// ID and the device key.
func RegisterParts(initData string, accountKey []byte, deviceID string, deviceKey []byte) [][]byte {
	digest := sha256.Sum256([]byte(initData))
	return [][]byte{digest[:], accountKey, []byte(deviceID), deviceKey}
}

// register creates an account for the Telegram user present in initData
// (docs/protocol.md, Registration and sessions). The launch must carry "reg" +
// the account key's fingerprint, which only Telegram sets, so initData
// collected by any other page can't be used to register someone else's keys.
// Nothing from initData is kept except a keyed hash of the user ID.
func (s *Server) register(ctx context.Context, req httpapi.Request) httpapi.Response {
	const route = "POST /register"
	var in registerRequest
	if err := httpapi.DecodeJSON(req, &in); err != nil {
		return httpapi.DecodeError(err)
	}
	now := s.Now()

	if in.InitData == "" || len(in.InitData) > maxInitData || !ids.Valid(in.Device) {
		return httpapi.Error(http.StatusBadRequest, "bad_request")
	}
	accountKey, err := devicesig.ParsePublicKey(in.AccountKey)
	if err != nil {
		return httpapi.Error(http.StatusBadRequest, "bad_request")
	}
	deviceKey, err := devicesig.ParsePublicKey(in.DeviceKey)
	if err != nil {
		return httpapi.Error(http.StatusBadRequest, "bad_request")
	}

	launch, err := s.Telegram.Verify(in.InitData, now)
	if err != nil || launch.StartParam != RegistrationPrefix+devicesig.Fingerprint(in.AccountKey) {
		return httpapi.Error(http.StatusUnauthorized, "init_data_rejected")
	}

	parts := RegisterParts(in.InitData, in.AccountKey, in.Device, in.DeviceKey)
	if devicesig.Verify(accountKey, in.AccountSig, devicesig.LabelRegister, parts...) != nil ||
		devicesig.Verify(deviceKey, in.DeviceSig, devicesig.LabelRegister, parts...) != nil {
		return httpapi.Error(http.StatusUnauthorized, "signature_rejected")
	}

	// The first device list is checked but not stored: with one device per
	// account, nothing reads it.
	list, err := devicelist.Verify(in.DeviceList, in.DeviceListSig, accountKey)
	if err != nil || !isFirstList(list, in.Device, in.DeviceKey) {
		return httpapi.Error(http.StatusBadRequest, "invalid_device_list")
	}
	// Issued by the device's clock: one that is off learns the server's and
	// signs again.
	if list.Issued.Before(now.Add(-listIssuedBefore)) || list.Issued.After(now.Add(listIssuedAfter)) {
		return clockSkew(now)
	}
	if !list.Expires.After(now) {
		return httpapi.Error(http.StatusBadRequest, "invalid_device_list")
	}

	telegramHash := directory.TelegramHash(s.Pepper, launch.UserID)
	account := directory.NewAccount{
		ID:           ids.New(),
		TelegramHash: telegramHash,
		AccountKey:   in.AccountKey,
		DeviceID:     in.Device,
		DeviceKey:    in.DeviceKey,
	}

	// Counted before anything is read, whatever comes of it. Then only the
	// items it needs are read: the Telegram user's account, its account
	// item and this device's, never the whole partition (thousands of
	// mailboxes). A replacement, once counted, reads only the old account's
	// devices and links, and its first cleanup step only what it deletes.
	if resp, ok := s.allowPerDay(ctx, route, "regtry", telegramHash, RegisterAttemptsPerDay); !ok {
		return resp
	}
	existing, err := s.Directory.ByTelegram(ctx, telegramHash, in.Device)
	switch {
	case errors.Is(err, directory.ErrNotFound):
		if resp, ok := s.allowRegistration(ctx, route, telegramHash); !ok {
			return resp
		}
		err = s.Directory.Create(ctx, account)
		if errors.Is(err, directory.ErrConflict) {
			// Another registration for this user got there first.
			return httpapi.Error(http.StatusConflict, "account_exists")
		}
	case err != nil:
		return s.internal(route, err)
	case bytes.Equal(existing.Key, in.AccountKey) && bytes.Equal(existing.DeviceKey, in.DeviceKey):
		// A retry of a registration that already succeeded, e.g. after its
		// response was lost.
		return s.issue(route, existing.ID, in.Device, now)
	case !in.Replace && !existing.Deleting:
		return httpapi.Error(http.StatusConflict, "account_exists")
	default:
		// Replacing asks the user first (replace), unless the account is
		// being deleted: only its own signed DELETE /account marks it, and
		// nothing unmarks it, so it isn't in use, and the user may have
		// deleted it from their device (the server couldn't finish).
		// POST /accounts/lookup doesn't count it either.
		if resp, ok := s.allowRegistration(ctx, route, telegramHash); !ok {
			return resp
		}
		err = s.Directory.Replace(ctx, existing, account, now)
		if errors.Is(err, directory.ErrConflict) {
			return httpapi.Error(http.StatusConflict, "conflict")
		}
		if err == nil {
			// The old account ended with the swap, in a few writes. What is
			// left of it goes in steps: the first here, the rest as the app
			// asks (POST /account/cleanup). One that fails only leaves more
			// for those, so the registration stands.
			if _, err := s.leasedCleanUp(ctx, route, account.ID, append([]string{existing.ID}, existing.Leftovers...)); err != nil {
				s.Log.Warn("cleanup step failed", slog.String(logx.KeyRoute, route), logx.ErrorKind(err))
			}
		}
	}
	if err != nil {
		return s.internal(route, err)
	}
	return s.issue(route, account.ID, in.Device, now)
}

func (s *Server) allowRegistration(ctx context.Context, route, telegramHash string) (httpapi.Response, bool) {
	return s.allowPerDay(ctx, route, "reg", telegramHash, RegistrationsPerDay)
}

func (s *Server) allowPerDay(ctx context.Context, route, kind, who string, limit int) (httpapi.Response, bool) {
	ok, err := s.allow(ctx, kind, limit, 24*time.Hour, who)
	if err != nil {
		return s.internal(route, err), false
	}
	if !ok {
		return httpapi.Error(http.StatusTooManyRequests, "rate_limited"), false
	}
	return httpapi.Response{}, true
}

// isFirstList reports whether list is shaped as a new account's first device
// list: the first in its chain, naming only the registering device. Whether
// it is current is checked apart, since a wrong clock on the device is
// answered differently.
func isFirstList(list devicelist.List, deviceID string, deviceKey []byte) bool {
	if list.Seq != 1 || list.Prev != [32]byte{} || len(list.Entries) != 1 {
		return false
	}
	entry := list.Entries[0]
	return entry.DeviceID == deviceID && bytes.Equal(entry.Key, deviceKey)
}
