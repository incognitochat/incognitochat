// Package directory stores accounts and their devices in DynamoDB.
//
// Everything an account owns lives in one partition, "A#<account ID>", so
// replacing or deleting an account can find all of it:
//
//	A#<account>  A           account: account key (ak), Telegram hash (th)
//	A#<account>  D#<device>  device: signing key (k)
//	A#<account>  F#<fingerprint> marks a link signing key the account has (links.go)
//	A#<account>  I#<code>    marks an invitation code the account made, with its uses (u) and uses left (r) if made since they're kept here (invitations.go)
//	A#<account>  K#<link>    marks a link the account owns (links.go)
//	A#<account>  L           older accounts' signed device list: bytes (b), signature (s), sequence (q); no longer stored
//	A#<account>  M#<mailbox> marks a mailbox the account owns (mailboxes.go)
//	L#<link>     L           a link: owner (a), signing key (k), encryption keys (ek), intro mailbox (m); just its key once it went (links.go)
//	F#<fingerprint> F        a link signing key: the account that has it (a), none once it ended (links.go)
//	I#<code>     I           a code: owner (o), owner's level (l), uses (u), uses left (r), whether its owner's entry keeps them too (m)
//	S#levels     S           invitation allowance per level (m), version (v)
//	S#switches   S           the operator's emergency switches (switches.go)
//	S#use        S           the newest month a login recorded its month of use in (m) (expiry.go)
//	M#<mailbox>  M           a mailbox (mailboxes.go)
//	T#<hash>     T           one account per Telegram user: account ID (a)
//
// The account partition's sort keys sort as listed (accountSortKeys).
// Every logged-in request reads the account item and its device's in one
// query, from "A" to "D#<device>" (Device), so nothing but devices may
// sort between them: a new kind of item needs a sort key after "D#~".
//
// The account item also counts the account's active links (lc), marks each
// change to them with a random value (lq, linkChange), records the month it
// was last used (lu, expiry.go), and, once it joined through an invitation,
// records its level (lv), the invitations granted to it on top of its
// level's allowance (ig) and the uses it has put into codes (ia).
//
// The Telegram hash is a keyed hash of the Telegram user ID (TelegramHash),
// so the table enforces one account per user without holding the ID.
//
// An account ends in a few writes, however much it owns, and what it owns
// goes afterwards, in steps of bounded size that can be repeated or cut
// short (endSome):
//   - Replaced (Replace): its item becomes a marker (g = "r") that, with its
//     device keys, expires after ReplacedTTL, so its devices can be told
//     what happened after checking their signatures; its links and device
//     list (if it has one) go at once. The account that replaced it lists it (ro) until the
//     rest is deleted (CleanUp).
//   - Deleted (DELETE /account, or unused for over ExpireAfter months:
//     Expire): its item is marked (dl) and its link goes in the first step
//     (MarkDeleting), then everything else (Delete), the item last.
//
// Either way, from that first write on, nothing it owns is used: deliveries
// to its mailboxes find no live owner (Recipients), nor do its invitation
// codes (Redeem), and nothing new joins its partition (every write that
// makes something there checks the account item: live). One step at a
// time runs for an account, while it holds the account item's lease (sl,
// Lease). Times are stored rounded up to the hour (attribute e, the
// table's TTL).
package directory

import (
	"cmp"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/awsconf"
	"github.com/incognitochat/incognitochat/backend/internal/devicesig"
)

// accountSortKeys are the sort keys, or their prefixes, of the items in an
// account's partition, in sort order (see the package comment).
var accountSortKeys = []string{skAccount, devicePrefix, keyRecordPrefix, codePrefix, linkPrefix, skDeviceList, mailboxPrefix}

// ReplacedTTL is how long a replaced account's devices are told so.
const ReplacedTTL = 90 * 24 * time.Hour

const (
	skAccount    = "A"
	skDeviceList = "L"
	skTelegram   = "T"
	devicePrefix = "D#"
	goneReplaced = "r"
	// afterDevices sorts after every device's sort key (device IDs are
	// base64url, all below "~") and before every other kind of item but the
	// account's own (accountSortKeys).
	afterDevices = devicePrefix + "~"
	// live is the condition on an account item that every write making
	// something in its partition checks: an account, not the marker of a
	// replaced one (which has no account key), and not being deleted.
	live = "attribute_exists(ak) AND attribute_not_exists(dl)"

	// labelTelegram keys the hash of Telegram user IDs.
	labelTelegram = "incognitochat/v2/telegram-id"
	// batchSize is DynamoDB's limit for BatchWriteItem.
	batchSize = 25
	// maxBatchRetries bounds retries of unprocessed batch items.
	maxBatchRetries = 5
)

var (
	// ErrNotFound is returned when there is no such account or device.
	ErrNotFound = errors.New("directory: not found")
	// ErrConflict is returned when a concurrent change won.
	ErrConflict = errors.New("directory: conflict")
	// ErrNoticesOff is returned for a change to notices that are off
	// (turned off, or refused by Telegram) or were never set up.
	ErrNoticesOff = errors.New("directory: notices are off")
	// errCutShort is returned when a read meant to take one page didn't:
	// something unexpected sorts in its range.
	errCutShort = errors.New("directory: read cut short")
)

// DB is the part of the DynamoDB client the store uses.
type DB interface {
	GetItem(context.Context, *dynamodb.GetItemInput, ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
	BatchGetItem(context.Context, *dynamodb.BatchGetItemInput, ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error)
	PutItem(context.Context, *dynamodb.PutItemInput, ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error)
	Query(context.Context, *dynamodb.QueryInput, ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error)
	UpdateItem(context.Context, *dynamodb.UpdateItemInput, ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error)
	DeleteItem(context.Context, *dynamodb.DeleteItemInput, ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error)
	TransactWriteItems(context.Context, *dynamodb.TransactWriteItemsInput, ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error)
	BatchWriteItem(context.Context, *dynamodb.BatchWriteItemInput, ...func(*dynamodb.Options)) (*dynamodb.BatchWriteItemOutput, error)
}

// Store is the directory table.
type Store struct {
	DB    DB
	Table string
}

// TelegramHash is the keyed hash a Telegram user ID is stored as.
func TelegramHash(pepper []byte, userID int64) string {
	mac := hmac.New(sha256.New, pepper)
	mac.Write(devicesig.Message(labelTelegram, []byte(strconv.FormatInt(userID, 10))))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// Account is an existing account, as registration needs it.
type Account struct {
	ID        string
	Key       []byte // account key; nil if the account item is missing
	DeviceKey []byte // the signing key of the device asked about; nil if the account has no such device
	// Leftovers are the accounts it replaced whose items aren't all
	// deleted yet (CleanUp).
	Leftovers []string
	// Deleting: its own DELETE /account has started (MarkDeleting), which
	// is never undone; setting up again replaces it without asking.
	Deleting bool
	// linkChange is the account item's lq as read (nil if none), so
	// Replace can tell whether its links changed since.
	linkChange types.AttributeValue
}

// NewAccount is a registration to store.
type NewAccount struct {
	ID           string
	TelegramHash string
	AccountKey   []byte
	DeviceID     string
	DeviceKey    []byte
	// Month is the month it is set up in (Month), its first month of use
	// (lu); none if empty.
	Month string
}

// Device is a device's signing key, with what requests need to know about
// its account.
type Device struct {
	Key          []byte
	Replaced     bool
	TelegramHash string // "" once replaced
	Member       bool   // joined through an invitation
	Level        int    // 1 for people invited by an admin, and so on; 0 if not a member
	Granted      int    // invitations granted on top of the level's allowance
	Allocated    int    // invitation uses put into codes
	Links        int    // active links
	Mailboxes    int    // pool and conversation mailboxes owned (not the link's intro mailbox), as counted against the most allowed
	Notices      bool   // Telegram notices are set up and not turned off
	// NoticesRefused: notices are off because Telegram refused one (the
	// user blocked the bot, say), not set up again since.
	NoticesRefused bool
	// NoticesLeft: notices are off, but what they need (the sealed chat
	// ID, the language or the last notice's ID) is still stored, for
	// ForgetNotices.
	NoticesLeft bool
	// NoticeLanguage: the language notices are sent in, while they're on
	// ("" otherwise).
	NoticeLanguage string
	// Deleting: DELETE /account has started (MarkDeleting), and the
	// account takes no other request.
	Deleting bool
	// Expired: the deletion was started by the expiry of an account unused
	// for over ExpireAfter months (Expire), not by DELETE /account.
	Expired bool
	// Leftovers are the accounts this one replaced whose items aren't all
	// deleted yet (CleanUp), sorted.
	Leftovers []string
	// LastUse is the month the account was last used (Month, Used); ""
	// for one that has none yet.
	LastUse string
}

// AccountOf returns the ID of the account registered for a Telegram hash,
// reading only the item that keeps one account per Telegram user.
func (s *Store) AccountOf(ctx context.Context, telegramHash string) (string, error) {
	out, err := s.DB.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      &s.Table,
		Key:            key("T#"+telegramHash, skTelegram),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return "", err
	}
	id, ok := str(out.Item, "a")
	if !ok {
		return "", ErrNotFound
	}
	return id, nil
}

// AccountExists reports whether a Telegram user has an account in use: one
// being deleted (MarkDeleting) doesn't count, since setting up again
// replaces it without asking (it can only be marked by its own signed
// DELETE /account, or by the expiry of an account unused for over
// ExpireAfter months, and never unmarked). It reads the Telegram user's item,
// then the account item eventually consistent (half a unit).
func (s *Store) AccountExists(ctx context.Context, telegramHash string) (bool, error) {
	id, err := s.AccountOf(ctx, telegramHash)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	acct, err := s.read(ctx, accountPK(id), skAccount, time.Time{}, false)
	if errors.Is(err, ErrNotFound) {
		// The Telegram item names it, and the read is eventually
		// consistent: an account set up in about the last second may not
		// show yet. Saying there is one is the cautious answer (the app then
		// says "on another device" rather than offer a setup that replaces
		// it).
		return true, nil
	}
	if err != nil {
		return false, err
	}
	_, deleting := acct["dl"]
	return !deleting, nil
}

// ByTelegram returns the account registered for a Telegram hash, with the
// signing key of one of its devices, if it has that device. It reads only
// those items, never the rest of the partition, which can hold thousands
// (nothing lists it all: Replace reads only devices and links, and the
// steps after it, CleanUp and Delete, only what they delete).
func (s *Store) ByTelegram(ctx context.Context, telegramHash, deviceID string) (Account, error) {
	id, err := s.AccountOf(ctx, telegramHash)
	if err != nil {
		return Account{}, err
	}
	acct, dev, err := s.accountAndDevice(ctx, id, deviceID, true)
	if err != nil {
		return Account{}, err
	}
	out := Account{ID: id}
	if _, gone := str(acct, "g"); !gone {
		out.Key, _ = bin(acct, "ak")
		out.Leftovers = stringSet(acct, "ro")
		out.linkChange = acct["lq"]
		_, out.Deleting = acct["dl"]
	}
	out.DeviceKey, _ = bin(dev, "k")
	return out, nil
}

// accountAndDevice reads an account's item and one device's item (either
// nil if missing) in one query, strongly consistent if consistent: the
// device's sort key follows the account's ("A" < "D#…"), and only the
// account's other devices, if any, sort between them (accountSortKeys). A
// result cut short (over 1 MB between them) is an error, never a device
// taken for missing.
func (s *Store) accountAndDevice(ctx context.Context, accountID, deviceID string, consistent bool) (map[string]types.AttributeValue, map[string]types.AttributeValue, error) {
	out, err := s.DB.Query(ctx, &dynamodb.QueryInput{
		TableName:              &s.Table,
		KeyConditionExpression: aws.String("pk = :pk AND sk BETWEEN :a AND :d"),
		ExpressionAttributeValues: attrs{
			":pk": sv(accountPK(accountID)),
			":a":  sv(skAccount),
			":d":  sv(devicePrefix + deviceID),
		},
		ConsistentRead: aws.Bool(consistent),
	})
	if err != nil {
		return nil, nil, err
	}
	if len(out.LastEvaluatedKey) > 0 {
		return nil, nil, errCutShort
	}
	var acct, dev map[string]types.AttributeValue
	for _, it := range out.Items {
		switch sk, _ := str(it, "sk"); sk {
		case skAccount:
			acct = it
		case devicePrefix + deviceID:
			dev = it
		}
	}
	return acct, dev, nil
}

// Create stores a new account. It returns ErrConflict if the Telegram user
// already has one.
func (s *Store) Create(ctx context.Context, n NewAccount) error {
	writes := append([]types.TransactWriteItem{{
		Put: &types.Put{
			TableName:           &s.Table,
			Item:                item("T#"+n.TelegramHash, skTelegram, attrs{"a": sv(n.ID)}),
			ConditionExpression: aws.String("attribute_not_exists(pk)"),
		},
	}}, s.newAccountItems(n, nil)...)
	return s.transact(ctx, writes)
}

// maxSwapLinks and maxSwapDevices bound how many of an account's links and
// devices the one-transaction writes that end it take (Replace,
// MarkDeleting, Delete's last step). An account has one of each (one link
// at a time, one device per account); the steps take any more.
const (
	maxSwapLinks   = 4
	maxSwapDevices = 8
)

// Replace ends old and stores n in its place, atomically, in a few writes
// however much old owns. One transaction moves the Telegram user's item to
// n; turns old's item into a marker (g = "r") that expires after
// ReplacedTTL, and gives its device keys the same expiry, so its devices
// can still be told; deletes its device list (only older accounts have
// one) and its links (their bundles then answer "not found"), and turns
// the items of the signing keys it has into tombstones (endKeys); and lists
// old among n's leftovers, with any old had itself. From then on nothing
// else of old is used either: deliveries to its mailboxes find no live
// owner (Recipients), nor do its invitation codes (Redeem), and nothing new
// joins its partition (making anything there checks its item, now a
// marker). What is left goes in steps (CleanUp). It returns ErrConflict if
// the Telegram user's account changed since old was read, or one of its
// links did.
//
// An old account being deleted (its own DELETE /account started, or the
// expiry of an unused account: Expire) keeps no
// marker: its item and devices become stubs with no keys (dl), so its device
// is refused as after a deletion, and CleanUp deletes them with the rest.
//
// It reads only old's devices and links, never its whole partition, which
// can hold thousands of mailboxes. A link that replaced old's between that
// read and the swap is left to CleanUp, which takes links first; its intro
// mailbox is as dead as the others meanwhile.
func (s *Store) Replace(ctx context.Context, old Account, n NewAccount, now time.Time) error {
	pk := accountPK(old.ID)
	devices, err := s.query(ctx, pk, "begins_with(sk, :v)", devicePrefix, "sk, k", maxSwapDevices)
	if err != nil {
		return err
	}
	links, fingerprints, err := s.endLinks(ctx, old.ID)
	if err != nil {
		return err
	}
	keys, err := s.endKeys(ctx, old.ID, fingerprints)
	if err != nil {
		return err
	}
	leftovers := []string{old.ID}
	for _, id := range old.Leftovers {
		if id != old.ID && id != n.ID {
			leftovers = append(leftovers, id)
		}
	}
	expires := nv(roundUp(now.Add(ReplacedTTL)))
	writes := []types.TransactWriteItem{{
		Update: &types.Update{
			TableName:           &s.Table,
			Key:                 key("T#"+n.TelegramHash, skTelegram),
			UpdateExpression:    aws.String("SET a = :new"),
			ConditionExpression: aws.String("a = :old"),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":new": sv(n.ID),
				":old": sv(old.ID),
			},
		},
	}}
	writes = append(writes, s.newAccountItems(n, leftovers)...)
	// Only if old's links are as they were when it was read: a link made
	// meanwhile isn't left behind.
	unchanged, values := linksUnchanged(old.linkChange)
	// Being deleted, as its own signed DELETE /account asked (or the expiry
	// of an unused account), which keeps
	// nothing: no marker of the replacement, and its devices lose their
	// keys, so its device is refused as for any deleted account, not told it
	// was replaced. Its item and devices stay only as stubs (dl, no keys), so
	// that its mailboxes' lookups read what any account's do (Recipients)
	// and the cleanup finds what waits for its device, until the cleanup
	// deletes them with the rest.
	end := attrs{"g": sv(goneReplaced), "e": expires}
	cond := unchanged
	if old.Deleting {
		end = attrs{"dl": nv(1), "e": expires}
		cond = "attribute_exists(dl) AND " + unchanged
	}
	swap := &types.Put{TableName: &s.Table, Item: item(pk, skAccount, end), ConditionExpression: aws.String(cond)}
	if len(values) > 0 {
		swap.ExpressionAttributeValues = values
	}
	writes = append(writes, types.TransactWriteItem{Put: swap}, types.TransactWriteItem{Delete: &types.Delete{TableName: &s.Table, Key: key(pk, skDeviceList)}})
	for _, d := range devices.items {
		sk, _ := str(d, "sk")
		if old.Deleting {
			// Without its key: it can't log in (Device), but the cleanup
			// still finds it to delete what waits for it.
			writes = append(writes, types.TransactWriteItem{Put: &types.Put{TableName: &s.Table, Item: item(pk, sk, attrs{"e": expires})}})
		} else if k, ok := bin(d, "k"); ok {
			writes = append(writes, types.TransactWriteItem{Put: &types.Put{
				TableName: &s.Table,
				Item:      item(pk, sk, attrs{"k": bv(k), "e": expires}),
			}})
		}
	}
	return s.transact(ctx, append(append(writes, links...), keys...))
}

// endLinks returns the transaction items that end an account's links (at
// most maxSwapLinks; the steps take any more): each link the account owns
// becomes its tombstone, only while the account still owns it, and the
// account's record of it goes, with the fingerprints of those links'
// signing keys (for endKeys). A record that names a link the account
// doesn't own (which nothing makes) goes without it.
func (s *Store) endLinks(ctx context.Context, accountID string) ([]types.TransactWriteItem, []string, error) {
	pk := accountPK(accountID)
	records, err := s.query(ctx, pk, "begins_with(sk, :v)", linkPrefix, "sk", maxSwapLinks)
	if err != nil {
		return nil, nil, err
	}
	var writes []types.TransactWriteItem
	var fingerprints []string
	for _, r := range records.items {
		sk, _ := str(r, "sk")
		id := strings.TrimPrefix(sk, linkPrefix)
		l, err := s.get(ctx, linkPK(id), skLink, time.Time{})
		if err != nil && !errors.Is(err, ErrNotFound) {
			return nil, nil, err
		}
		if owner, _ := str(l, "a"); owner == accountID {
			writes = append(writes, s.endLinkWrite(accountID, id))
			if k, ok := bin(l, "k"); ok {
				fingerprints = append(fingerprints, devicesig.Fingerprint(k))
			}
		}
		writes = append(writes, types.TransactWriteItem{Delete: &types.Delete{TableName: &s.Table, Key: key(pk, sk)}})
	}
	return writes, fingerprints, nil
}

// CleanUp deletes, in steps of about max writes, what is left of old, an
// account that accountID replaced: its mailboxes, invitation codes, any
// links and its device list, with its records of them (endSome). Its marker
// and device keys stay, to tell its devices, until they expire
// (ReplacedTTL); a device the swap didn't take (past maxSwapDevices) gets
// the marker's expiry here. Nothing of old is used any more meanwhile
// (Replace), so this only frees what it held.
//
// Each call takes one step and reports whether it has finished: then old is
// no longer one of accountID's leftovers. A step can be repeated, or cut
// short anywhere: the next finds what it left. An old account that is
// somehow live (it has an account key) is never touched, only forgotten.
func (s *Store) CleanUp(ctx context.Context, accountID, old string, max int) (bool, error) {
	marker, err := s.get(ctx, accountPK(old), skAccount, time.Time{})
	if err != nil && !errors.Is(err, ErrNotFound) {
		return false, err
	}
	if _, live := marker["ak"]; !live {
		more, err := s.endSome(ctx, old, max)
		if err != nil || more {
			return false, err
		}
		if err := s.expireDevices(ctx, old, marker); err != nil {
			return false, err
		}
		// The stubs of an account that was being deleted (Replace): they
		// stood in only while its mailboxes and envelopes were left, and go
		// with them, its devices first.
		if _, stub := marker["dl"]; stub {
			devices, err := s.prefixed(ctx, old, devicePrefix, "sk")
			if err != nil {
				return false, err
			}
			requests := make([]types.WriteRequest, 0, len(devices))
			for _, d := range devices {
				sk, _ := str(d, "sk")
				requests = append(requests, types.WriteRequest{DeleteRequest: &types.DeleteRequest{Key: key(accountPK(old), sk)}})
			}
			if err := s.batchWrite(ctx, requests); err != nil {
				return false, err
			}
			_, err = s.DB.DeleteItem(ctx, &dynamodb.DeleteItemInput{
				TableName:           &s.Table,
				Key:                 key(accountPK(old), skAccount),
				ConditionExpression: aws.String("attribute_exists(dl) AND attribute_not_exists(ak)"),
			})
			var failed *types.ConditionalCheckFailedException
			if err != nil && !errors.As(err, &failed) {
				return false, err
			}
		}
	}
	_, err = s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 &s.Table,
		Key:                       key(accountPK(accountID), skAccount),
		UpdateExpression:          aws.String("DELETE ro :old"),
		ConditionExpression:       aws.String("attribute_exists(ro)"),
		ExpressionAttributeValues: attrs{":old": &types.AttributeValueMemberSS{Value: []string{old}}},
	})
	var failed *types.ConditionalCheckFailedException
	if errors.As(err, &failed) {
		// Forgotten already, or the account itself was replaced since,
		// and its successor lists old now.
		return true, nil
	}
	return err == nil, err
}

// expireDevices gives a replaced account's devices that have no expiry the
// marker's, or deletes them if the marker has expired. The swap takes up to
// maxSwapDevices, and an account has one, so this normally finds nothing
// to do.
func (s *Store) expireDevices(ctx context.Context, accountID string, marker map[string]types.AttributeValue) error {
	devices, err := s.prefixed(ctx, accountID, devicePrefix, "sk, k, e")
	if err != nil {
		return err
	}
	expires, ok := marker["e"]
	var requests []types.WriteRequest
	for _, d := range devices {
		if _, has := d["e"]; has {
			continue
		}
		sk, _ := str(d, "sk")
		if k, hasKey := bin(d, "k"); ok && hasKey {
			requests = append(requests, types.WriteRequest{PutRequest: &types.PutRequest{
				Item: item(accountPK(accountID), sk, attrs{"k": bv(k), "e": expires}),
			}})
		} else {
			requests = append(requests, types.WriteRequest{DeleteRequest: &types.DeleteRequest{Key: key(accountPK(accountID), sk)}})
		}
	}
	return s.batchWrite(ctx, requests)
}

// MarkDeleting marks an account as being deleted (dl), ends its link,
// leaving the ID's tombstone (endLinks: its bundle then answers "not
// found"), and turns the items of the signing keys it has into tombstones
// (endKeys), in one transaction of a few
// writes: the first thing DELETE /account does. From then on nothing is
// delivered to it (Recipients), its invitation codes stop working
// (Redeem), nothing new joins its partition (live), and it takes no request
// but the rest of its deletion (api), which Delete carries out in steps. It
// isn't undone. It returns ErrNotFound if the account is gone or replaced,
// and ErrConflict if its links changed since it read them (lq): a link made
// meanwhile isn't left behind; asking again marks it.
func (s *Store) MarkDeleting(ctx context.Context, accountID string) error {
	return s.markDeleting(ctx, accountID, "")
}

// markDeleting is MarkDeleting, and, if lastUse isn't empty, only while
// the account's last-use month (lu) is still lastUse (Expire): it returns
// ErrConflict if it was used since, and marks it as deleted for going
// unused (dl = deletingUnused, Device.Expired).
func (s *Store) markDeleting(ctx context.Context, accountID, lastUse string) error {
	acct, err := s.get(ctx, accountPK(accountID), skAccount, time.Time{})
	if err != nil {
		return err
	}
	if _, ok := acct["ak"]; !ok {
		return ErrNotFound
	}
	links, fingerprints, err := s.endLinks(ctx, accountID)
	if err != nil {
		return err
	}
	keys, err := s.endKeys(ctx, accountID, fingerprints)
	if err != nil {
		return err
	}
	unchanged, values := linksUnchanged(acct["lq"])
	values[":dl"], values[":lq"] = nv(deletingAsked), newLinkChange()
	cond := "attribute_exists(ak) AND " + unchanged
	if lastUse != "" {
		cond += " AND lu = :lu"
		values[":lu"], values[":dl"] = sv(lastUse), nv(deletingUnused)
	}
	writes := append([]types.TransactWriteItem{{Update: &types.Update{
		TableName:                 &s.Table,
		Key:                       key(accountPK(accountID), skAccount),
		UpdateExpression:          aws.String("SET dl = :dl, " + linkChange),
		ConditionExpression:       aws.String(cond),
		ExpressionAttributeValues: values,
	}}}, links...)
	writes = append(writes, keys...)
	reasons, err := s.transactReasons(ctx, writes)
	if errors.Is(err, ErrConflict) && len(reasons) > 0 && reasons[0] == "ConditionalCheckFailed" {
		// Gone or replaced since, or its links changed.
		acct, err := s.get(ctx, accountPK(accountID), skAccount, time.Time{})
		if _, ok := acct["ak"]; errors.Is(err, ErrNotFound) || (err == nil && !ok) {
			return ErrNotFound
		}
		return ErrConflict
	}
	return err
}

// leaseFor is how long a step of deleting an account, or what is left of
// one it replaced, may hold the account (Lease): longer than the api
// function may run (its timeout, 10 s in infra/functions.tf, and 5 s
// more), so no step outlives its lease, and one that dies halfway holds
// the account no longer.
const leaseFor = 15 * time.Second

// stepGap is how long after a step ends the next may start (release): the
// server's own pacing, whatever the app does.
const stepGap = time.Second

// Lease lets one step of deleting an account, or what is left of accounts
// it replaced, run at a time: it records on the account item (sl) that a
// step holds it, until leaseFor from now, unless another step does (or a
// concurrent transaction on the item: taken as held), and reports whether
// it did. So requests sent at once can't each write the same deletes.
// Release, at the end of the step, lets the next one in stepGap later, or,
// once the work is done, removes the lease from the item; a step that dies
// halfway holds the account until its lease expires. An account that is
// gone isn't leased. A release that fails (a concurrent transaction)
// returns its error, and the lease expires on its own.
func (s *Store) Lease(ctx context.Context, accountID string, now time.Time) (release func(ctx context.Context, now time.Time, done bool) error, ok bool, err error) {
	until := nv(now.Add(leaseFor).UnixMilli())
	_, err = s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 &s.Table,
		Key:                       key(accountPK(accountID), skAccount),
		UpdateExpression:          aws.String("SET sl = :until"),
		ConditionExpression:       aws.String("attribute_exists(pk) AND (attribute_not_exists(sl) OR sl <= :now)"),
		ExpressionAttributeValues: attrs{":until": until, ":now": nv(now.UnixMilli())},
	})
	var failed *types.ConditionalCheckFailedException
	var busy *types.TransactionConflictException
	if errors.As(err, &failed) || errors.As(err, &busy) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return func(ctx context.Context, now time.Time, done bool) error {
		// Only this step's lease: one that outlived it is another's now.
		// Gone with the account after a deletion's last step.
		in := &dynamodb.UpdateItemInput{
			TableName:                 &s.Table,
			Key:                       key(accountPK(accountID), skAccount),
			UpdateExpression:          aws.String("SET sl = :next"),
			ConditionExpression:       aws.String("sl = :until"),
			ExpressionAttributeValues: attrs{":until": until, ":next": nv(now.Add(stepGap).UnixMilli())},
		}
		if done {
			in.UpdateExpression = aws.String("REMOVE sl")
			in.ExpressionAttributeValues = attrs{":until": until}
		}
		_, err := s.DB.UpdateItem(ctx, in)
		if errors.As(err, &failed) {
			return nil
		}
		return err
	}, true, nil
}

// Delete removes an account and everything it owns, keeping nothing
// (unlike Replace): its links (whose bundles then answer "not found"),
// mailboxes (sends to them then go nowhere), invitation codes, device list,
// devices, the account item, and the Telegram item, so the same Telegram
// user can set up again later. It returns ErrNotFound if the account is
// already gone or replaced.
//
// It works in steps of about max writes (endSome), so an account with many
// mailboxes neither outlasts a request nor takes the table's whole write
// capacity: it reports whether it finished, and the caller asks again until
// it has. The account is marked as being deleted first (MarkDeleting, which
// the caller normally did already), so nothing new joins it meanwhile and
// nothing is delivered to it. Last come the account, the Telegram item (if
// it still names the account) and the devices, in one transaction, and only
// once nothing is left of the accounts it replaced (CleanUp), which
// deleting its item would forget. If another write to the account cancels
// that last step, or something of them is left, it reports not finished,
// and asking again finishes it: that is never taken for "already gone".
func (s *Store) Delete(ctx context.Context, accountID, telegramHash string, max int) (bool, error) {
	acct, err := s.get(ctx, accountPK(accountID), skAccount, time.Time{})
	if err != nil {
		return false, err
	}
	if _, replaced := acct["g"]; replaced {
		return false, ErrNotFound
	}
	if _, deleting := acct["dl"]; !deleting {
		err := s.MarkDeleting(ctx, accountID)
		if errors.Is(err, ErrConflict) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
	}
	if more, err := s.endSome(ctx, accountID, max); err != nil || more {
		return false, err
	}
	pk := accountPK(accountID)
	devices, err := s.prefixed(ctx, accountID, devicePrefix, "sk")
	if err != nil {
		return false, err
	}
	// Past what a transaction takes (an account has one), the rest first.
	var extra []types.WriteRequest
	for len(devices) > maxSwapDevices {
		sk, _ := str(devices[len(devices)-1], "sk")
		extra = append(extra, types.WriteRequest{DeleteRequest: &types.DeleteRequest{Key: key(pk, sk)}})
		devices = devices[:len(devices)-1]
	}
	if err := s.batchWrite(ctx, extra); err != nil {
		return false, err
	}
	return s.deleteLast(ctx, accountID, telegramHash, devices)
}

// deleteLast deletes an account's item, its Telegram item and its devices,
// in one transaction (Delete's last step). A Telegram item that names
// another account, or none, isn't this one's to delete: the account goes
// without it.
func (s *Store) deleteLast(ctx context.Context, accountID, telegramHash string, devices []map[string]types.AttributeValue) (bool, error) {
	pk := accountPK(accountID)
	writes := []types.TransactWriteItem{{Delete: &types.Delete{
		TableName:           &s.Table,
		Key:                 key(pk, skAccount),
		ConditionExpression: aws.String("attribute_exists(pk) AND attribute_not_exists(g) AND attribute_not_exists(ro)"),
	}}}
	if telegramHash != "" {
		writes = append(writes, types.TransactWriteItem{Delete: &types.Delete{
			TableName:                 &s.Table,
			Key:                       key("T#"+telegramHash, skTelegram),
			ConditionExpression:       aws.String("a = :id"),
			ExpressionAttributeValues: attrs{":id": sv(accountID)},
		}})
	}
	for _, d := range devices {
		sk, _ := str(d, "sk")
		writes = append(writes, types.TransactWriteItem{Delete: &types.Delete{TableName: &s.Table, Key: key(pk, sk)}})
	}
	reasons, err := s.transactReasons(ctx, writes)
	if err == nil {
		return true, nil
	}
	if !errors.Is(err, ErrConflict) || !slices.Contains(reasons, "ConditionalCheckFailed") {
		// Another write to the account got there first (a notice): nothing
		// went, and asking again finishes it.
		return false, ignoreConflict(err)
	}
	if telegramHash != "" && len(reasons) > 1 && reasons[1] == "ConditionalCheckFailed" &&
		!slices.Contains(slices.Delete(slices.Clone(reasons), 1, 2), "ConditionalCheckFailed") {
		return s.deleteLast(ctx, accountID, "", devices)
	}
	// A condition failed: the account is gone already or was replaced, or
	// something of the accounts it replaced is left (asking again, the
	// caller cleans that up first).
	acct, err := s.get(ctx, pk, skAccount, time.Time{})
	if errors.Is(err, ErrNotFound) {
		return false, ErrNotFound
	}
	if err != nil {
		return false, err
	}
	if _, replaced := acct["g"]; replaced {
		return false, ErrNotFound
	}
	return false, nil
}

// ignoreConflict is err, unless it says a concurrent write won.
func ignoreConflict(err error) error {
	if errors.Is(err, ErrConflict) {
		return nil
	}
	return err
}

// sharedParallel is how many shared items a step deletes at once: each is
// a conditional delete of its own, so a step of 25 takes a few round trips.
const sharedParallel = 8

// endSome deletes up to about max items an account owns, never its item or
// its devices: links first, so first messages stop at once, then the rest
// in sort order (signing keys, invitation codes, the device list,
// mailboxes). Each goes with its shared item, if any (a link's bundle, a
// code, a mailbox), which is deleted first, and only if the account owns it
// (a record that names someone else's goes without it), so a step that
// fails halfway leaves the record, and the next one finds and finishes it.
// A link's item and a signing key's aren't deleted but become tombstones
// (links.go).
//
// It reads only what one step deletes, so a step costs about the same
// however much is left: about max write units and a few read units. It
// reports whether more may be left.
func (s *Store) endSome(ctx context.Context, accountID string, max int) (bool, error) {
	pk := accountPK(accountID)
	links, err := s.query(ctx, pk, "begins_with(sk, :v)", linkPrefix, "sk", max)
	if err != nil {
		return false, err
	}
	rest, err := s.query(ctx, pk, "sk > :v", afterDevices, "sk", max)
	if err != nil {
		return false, err
	}
	var sks []string
	listed := map[string]bool{}
	for _, it := range append(links.items, rest.items...) {
		if sk, ok := str(it, "sk"); ok && !listed[sk] {
			listed[sk] = true
			sks = append(sks, sk)
		}
	}
	var shared []ownedItem
	var own []types.WriteRequest
	n, i := 0, 0
	for ; i < len(sks) && (n == 0 || n+2 <= max); i++ {
		sk := sks[i]
		switch {
		case strings.HasPrefix(sk, linkPrefix):
			shared = append(shared, ownedItem{key: key(linkPK(strings.TrimPrefix(sk, linkPrefix)), skLink), owner: "a", keep: true})
			n++
		case strings.HasPrefix(sk, mailboxPrefix):
			shared = append(shared, ownedItem{key: key(mailboxPK(strings.TrimPrefix(sk, mailboxPrefix)), skMailbox), owner: "o"})
			n++
		case strings.HasPrefix(sk, codePrefix):
			shared = append(shared, ownedItem{key: key(codePK(strings.TrimPrefix(sk, codePrefix)), skCode), owner: "o"})
			n++
		case strings.HasPrefix(sk, keyRecordPrefix):
			shared = append(shared, ownedItem{key: key(keyPK(strings.TrimPrefix(sk, keyRecordPrefix)), skKey), owner: "a", keep: true})
			n++
		}
		own = append(own, types.WriteRequest{DeleteRequest: &types.DeleteRequest{Key: key(pk, sk)}})
		n++
	}
	if err := s.deleteOwned(ctx, accountID, shared); err != nil {
		return false, err
	}
	if err := s.batchWrite(ctx, own); err != nil {
		return false, err
	}
	return i < len(sks) || links.more || rest.more, nil
}

// ownedItem is a shared item, and the attribute that names its owner. One
// to keep is stripped to its key, a tombstone (a link's, or a signing
// key's).
type ownedItem struct {
	key   map[string]types.AttributeValue
	owner string
	keep  bool
}

// deleteOwned deletes the items that accountID owns (or, those to keep,
// strips them to their key), sharedParallel at a time; an item it doesn't
// own, or that is gone, stays as it is. It returns the first error, once
// all have been tried.
func (s *Store) deleteOwned(ctx context.Context, accountID string, items []ownedItem) error {
	var mu sync.Mutex
	var first error
	var workers awsconf.Workers
	// All queued at once, so a worker that panics (awsconf.Workers) can't
	// leave this waiting on it.
	next := make(chan ownedItem, len(items))
	for _, it := range items {
		next <- it
	}
	close(next)
	for range min(sharedParallel, len(items)) {
		workers.Go(func() {
			for it := range next {
				var err error
				if it.keep {
					_, err = s.DB.PutItem(ctx, &dynamodb.PutItemInput{
						TableName:                 &s.Table,
						Item:                      it.key,
						ConditionExpression:       aws.String("#o = :a"),
						ExpressionAttributeNames:  map[string]string{"#o": it.owner},
						ExpressionAttributeValues: attrs{":a": sv(accountID)},
					})
				} else {
					_, err = s.DB.DeleteItem(ctx, &dynamodb.DeleteItemInput{
						TableName:                 &s.Table,
						Key:                       it.key,
						ConditionExpression:       aws.String("#o = :a"),
						ExpressionAttributeNames:  map[string]string{"#o": it.owner},
						ExpressionAttributeValues: attrs{":a": sv(accountID)},
					})
				}
				var failed *types.ConditionalCheckFailedException
				if err != nil && !errors.As(err, &failed) {
					mu.Lock()
					first = cmp.Or(first, err)
					mu.Unlock()
				}
			}
		})
	}
	workers.Wait()
	return first
}

// page is one page of a query: its items, and whether more may follow.
type page struct {
	items []map[string]types.AttributeValue
	more  bool
}

// query reads one page, strongly consistent, of at most limit items of the
// partition pk whose sort keys meet cond (against :v), with only the
// attributes in projection.
func (s *Store) query(ctx context.Context, pk, cond, value, projection string, limit int) (page, error) {
	out, err := s.DB.Query(ctx, &dynamodb.QueryInput{
		TableName:                 &s.Table,
		KeyConditionExpression:    aws.String("pk = :pk AND " + cond),
		ExpressionAttributeValues: attrs{":pk": sv(pk), ":v": sv(value)},
		ProjectionExpression:      aws.String(projection),
		ConsistentRead:            aws.Bool(true),
		Limit:                     aws.Int32(int32(max(limit, 1))),
	})
	if err != nil {
		return page{}, err
	}
	return page{out.Items, len(out.LastEvaluatedKey) > 0}, nil
}

// prefixed lists the items of an account's partition whose sort keys start
// with prefix, strongly consistent, with only the attributes in projection.
func (s *Store) prefixed(ctx context.Context, accountID, prefix, projection string) ([]map[string]types.AttributeValue, error) {
	pages := dynamodb.NewQueryPaginator(s.DB, &dynamodb.QueryInput{
		TableName:                 &s.Table,
		KeyConditionExpression:    aws.String("pk = :pk AND begins_with(sk, :v)"),
		ExpressionAttributeValues: attrs{":pk": sv(accountPK(accountID)), ":v": sv(prefix)},
		ProjectionExpression:      aws.String(projection),
		ConsistentRead:            aws.Bool(true),
	})
	var items []map[string]types.AttributeValue
	for pages.HasMorePages() {
		page, err := pages.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		items = append(items, page.Items...)
	}
	return items, nil
}

// Device returns a device's signing key, and whether its account was
// replaced. It returns ErrNotFound if the device or its account is gone.
// Every logged-in request asks, so it is one strongly consistent read of
// both items (a replaced or deleted account is refused at once), not two.
func (s *Store) Device(ctx context.Context, accountID, deviceID string, now time.Time) (Device, error) {
	return s.device(ctx, accountID, deviceID, now, true)
}

// LoginDevice is Device for a login, eventually consistent at half the
// cost: anyone can ask, with any IDs. A device replaced or removed in about
// the last second may still get a token, but every request with it reads
// strongly (Device) and is refused.
func (s *Store) LoginDevice(ctx context.Context, accountID, deviceID string, now time.Time) (Device, error) {
	return s.device(ctx, accountID, deviceID, now, false)
}

func (s *Store) device(ctx context.Context, accountID, deviceID string, now time.Time, consistent bool) (Device, error) {
	acct, dev, err := s.accountAndDevice(ctx, accountID, deviceID, consistent)
	if err != nil {
		return Device{}, err
	}
	if acct == nil || dev == nil || expired(acct, now) || expired(dev, now) {
		return Device{}, ErrNotFound
	}
	k, ok := bin(dev, "k")
	if !ok {
		return Device{}, ErrNotFound
	}
	d := accountState(acct)
	d.Key = k
	return d, nil
}

// accountState is what an account item says about its account (Device,
// without a device's key).
func accountState(acct map[string]types.AttributeValue) Device {
	g, _ := str(acct, "g")
	th, _ := str(acct, "th")
	lu, _ := str(acct, "lu")
	_, member := acct["lv"].(*types.AttributeValueMemberN)
	_, chat := acct["cid"]
	lg, language := str(acct, "lg")
	_, last := acct["nm"]
	_, off := acct["no"]
	if !chat || off {
		lg = ""
	}
	_, deleting := acct["dl"]
	return Device{
		Replaced:       g == goneReplaced,
		TelegramHash:   th,
		Member:         member,
		Level:          int(num(acct, "lv")),
		Granted:        int(num(acct, "ig")),
		Allocated:      int(num(acct, "ia")),
		Links:          int(num(acct, "lc")),
		Mailboxes:      int(num(acct, "mc")),
		Notices:        chat && !off,
		NoticesRefused: num(acct, "no") == noticesRefused,
		NoticesLeft:    off && (chat || language || last),
		NoticeLanguage: lg,
		Deleting:       deleting,
		Expired:        deleting && num(acct, "dl") == deletingUnused,
		Leftovers:      stringSet(acct, "ro"),
		LastUse:        lu,
	}
}

// newAccountItems stores a new account: its item, listing leftovers (the
// accounts it replaced whose items are still to be deleted) and the month
// it is set up in (its first use), and its device. Its device list is
// checked at registration, and not stored.
func (s *Store) newAccountItems(n NewAccount, leftovers []string) []types.TransactWriteItem {
	pk := accountPK(n.ID)
	account := attrs{"ak": bv(n.AccountKey), "th": sv(n.TelegramHash)}
	if len(leftovers) > 0 {
		account["ro"] = &types.AttributeValueMemberSS{Value: leftovers}
	}
	if n.Month != "" {
		account["lu"] = sv(n.Month)
	}
	return []types.TransactWriteItem{
		{Put: &types.Put{
			TableName:           &s.Table,
			Item:                item(pk, skAccount, account),
			ConditionExpression: aws.String("attribute_not_exists(pk)"),
		}},
		{Put: &types.Put{
			TableName: &s.Table,
			Item:      item(pk, devicePrefix+n.DeviceID, attrs{"k": bv(n.DeviceKey)}),
		}},
	}
}

// get reads one item, strongly consistent, treating an expired item as
// missing: TTL deletion can lag by days.
func (s *Store) get(ctx context.Context, pk, sk string, now time.Time) (map[string]types.AttributeValue, error) {
	return s.read(ctx, pk, sk, now, true)
}

// read is get, eventually consistent unless consistent: at half the cost,
// it may miss a write made in about the last second.
func (s *Store) read(ctx context.Context, pk, sk string, now time.Time, consistent bool) (map[string]types.AttributeValue, error) {
	out, err := s.DB.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      &s.Table,
		Key:            key(pk, sk),
		ConsistentRead: aws.Bool(consistent),
	})
	if err != nil {
		return nil, err
	}
	if out.Item == nil || expired(out.Item, now) {
		return nil, ErrNotFound
	}
	return out.Item, nil
}

func (s *Store) transact(ctx context.Context, writes []types.TransactWriteItem) error {
	_, err := s.transactReasons(ctx, writes)
	return err
}

// transactReasons runs a transaction. When it is cancelled because a
// condition failed or a concurrent transaction won, it returns ErrConflict
// and each item's cancellation code ("None" for items that were fine).
func (s *Store) transactReasons(ctx context.Context, writes []types.TransactWriteItem) ([]string, error) {
	_, err := s.DB.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: writes})
	var canceled *types.TransactionCanceledException
	if errors.As(err, &canceled) {
		reasons := make([]string, len(canceled.CancellationReasons))
		conflict := false
		for i, r := range canceled.CancellationReasons {
			reasons[i] = aws.ToString(r.Code)
			conflict = conflict || reasons[i] == "ConditionalCheckFailed" || reasons[i] == "TransactionConflict"
		}
		if conflict {
			return reasons, ErrConflict
		}
	}
	return nil, err
}

func (s *Store) batchWrite(ctx context.Context, requests []types.WriteRequest) error {
	for len(requests) > 0 {
		n := min(batchSize, len(requests))
		pending := map[string][]types.WriteRequest{s.Table: requests[:n]}
		requests = requests[n:]
		for attempt := 0; len(pending[s.Table]) > 0; attempt++ {
			if attempt == maxBatchRetries {
				return errors.New("directory: batch write left items unprocessed")
			}
			if attempt > 0 {
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(time.Duration(50<<attempt) * time.Millisecond):
				}
			}
			out, err := s.DB.BatchWriteItem(ctx, &dynamodb.BatchWriteItemInput{RequestItems: pending})
			if err != nil {
				return err
			}
			pending = out.UnprocessedItems
		}
	}
	return nil
}

func accountPK(id string) string { return "A#" + id }

func key(pk, sk string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{"pk": sv(pk), "sk": sv(sk)}
}

type attrs = map[string]types.AttributeValue

// item is a whole item: its key plus other attributes.
func item(pk, sk string, a attrs) attrs {
	a["pk"] = sv(pk)
	a["sk"] = sv(sk)
	return a
}

func sv(v string) types.AttributeValue { return &types.AttributeValueMemberS{Value: v} }
func bv(v []byte) types.AttributeValue { return &types.AttributeValueMemberB{Value: v} }
func nv(v int64) types.AttributeValue {
	return &types.AttributeValueMemberN{Value: strconv.FormatInt(v, 10)}
}

// stringSet returns a string set attribute, sorted; nil if missing.
func stringSet(item map[string]types.AttributeValue, name string) []string {
	v, ok := item[name].(*types.AttributeValueMemberSS)
	if !ok || len(v.Value) == 0 {
		return nil
	}
	return slices.Sorted(slices.Values(v.Value))
}

func str(item map[string]types.AttributeValue, name string) (string, bool) {
	v, ok := item[name].(*types.AttributeValueMemberS)
	if !ok {
		return "", false
	}
	return v.Value, true
}

func bin(item map[string]types.AttributeValue, name string) ([]byte, bool) {
	v, ok := item[name].(*types.AttributeValueMemberB)
	if !ok {
		return nil, false
	}
	return v.Value, true
}

func num(item map[string]types.AttributeValue, name string) int64 {
	v, ok := item[name].(*types.AttributeValueMemberN)
	if !ok {
		return 0
	}
	n, _ := strconv.ParseInt(v.Value, 10, 64)
	return n
}

func expired(item map[string]types.AttributeValue, now time.Time) bool {
	v, ok := item["e"].(*types.AttributeValueMemberN)
	if !ok {
		return false
	}
	e, err := strconv.ParseInt(v.Value, 10, 64)
	return err != nil || e <= now.Unix()
}

// roundUp returns t rounded up to the next whole hour, in Unix seconds.
func roundUp(t time.Time) int64 {
	return t.Add(time.Hour - time.Nanosecond).Truncate(time.Hour).Unix()
}

// Notices are the Telegram "New message" notices (docs/protocol.md, Notices).
// The account item keeps the chat ID sealed by the notify function (cid),
// which nobody else can read; the language for the notice (lg); the last
// notice's message ID, to delete it when a new one is sent (nm); and, once
// notices are off, why (no): Telegram refused one (noticesRefused: the user
// blocked the bot, say), or the sealed chat ID no longer opens
// (noticesStale: the chat key was replaced). After a refusal the app offers
// to set notices up again rather than doing it by itself, so a block holds;
// after a new chat key it sets them up by itself, as at first. cid, lg and
// nm are kept only while notices are on: once they are off, the api removes
// them (ForgetNotices) the next time the app asks about the account, and
// setting notices up again stores cid and lg anew. While they're on, the
// app keeps lg in step with Telegram's language (SetNoticeLanguage).
//
// The notify function may touch nothing else (infra/functions.tf): it reads
// cid, lg, nm and no, naming them, and writes nm and no, with conditions on
// the key alone and nothing returned. Notices, NoticeSent, NoticesOff and
// NoticesStale are its calls, and must stay within that.

// Why notices are off (no).
const (
	noticesRefused = 1
	noticesStale   = 2
)

// NoticeTarget is what the notify function needs about an account.
type NoticeTarget struct {
	SealedChat  []byte
	Language    string
	LastMessage int64
	Off         bool
}

// SetNotices stores an account's sealed chat ID and language, and turns
// notices back on.
func (s *Store) SetNotices(ctx context.Context, accountID string, sealedChat []byte, language string) error {
	_, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 &s.Table,
		Key:                       key(accountPK(accountID), skAccount),
		UpdateExpression:          aws.String("SET cid = :c, lg = :l REMOVE #no"),
		ConditionExpression:       aws.String("attribute_exists(ak)"),
		ExpressionAttributeNames:  map[string]string{"#no": "no"},
		ExpressionAttributeValues: attrs{":c": bv(sealedChat), ":l": sv(language)},
	})
	var failed *types.ConditionalCheckFailedException
	if errors.As(err, &failed) {
		return ErrNotFound
	}
	return err
}

// SetNoticeLanguage changes the language of an account's notices, and
// nothing else, while they're on. ErrNoticesOff if they're off (turned off,
// or refused by Telegram, even since the caller looked) or were never set
// up: it never turns them back on, as SetNotices does.
func (s *Store) SetNoticeLanguage(ctx context.Context, accountID, language string) error {
	_, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 &s.Table,
		Key:                       key(accountPK(accountID), skAccount),
		UpdateExpression:          aws.String("SET lg = :l"),
		ConditionExpression:       aws.String("attribute_exists(ak) AND attribute_exists(cid) AND attribute_not_exists(#no)"),
		ExpressionAttributeNames:  map[string]string{"#no": "no"},
		ExpressionAttributeValues: attrs{":l": sv(language)},
	})
	var failed *types.ConditionalCheckFailedException
	if errors.As(err, &failed) {
		return ErrNoticesOff
	}
	return err
}

// Notices returns an account's notice settings. ErrNotFound if it has none.
func (s *Store) Notices(ctx context.Context, accountID string) (NoticeTarget, error) {
	out, err := s.DB.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:                &s.Table,
		Key:                      key(accountPK(accountID), skAccount),
		ProjectionExpression:     aws.String("cid, lg, nm, #no"),
		ExpressionAttributeNames: map[string]string{"#no": "no"},
		ConsistentRead:           aws.Bool(true),
	})
	if err != nil {
		return NoticeTarget{}, err
	}
	it := out.Item
	sealed, ok := bin(it, "cid")
	if !ok {
		return NoticeTarget{}, ErrNotFound
	}
	lang, _ := str(it, "lg")
	_, off := it["no"]
	return NoticeTarget{SealedChat: sealed, Language: lang, LastMessage: num(it, "nm"), Off: off}, nil
}

// NoticeSent records the message ID of the latest notice. An account that
// is gone gets nothing (one replaced since may get it on its marker, which
// is harmless and expires with it).
func (s *Store) NoticeSent(ctx context.Context, accountID string, messageID int64) error {
	_, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 &s.Table,
		Key:                       key(accountPK(accountID), skAccount),
		UpdateExpression:          aws.String("SET nm = :m"),
		ConditionExpression:       aws.String("attribute_exists(pk)"),
		ExpressionAttributeValues: attrs{":m": nv(messageID)},
	})
	var failed *types.ConditionalCheckFailedException
	if errors.As(err, &failed) {
		return nil // the account is gone
	}
	return err
}

// NoticesOff records that Telegram refused a notice (the user blocked the
// bot or never let it write), so none are tried until the user turns them
// on again in the app. Like NoticeSent, it writes nothing for an account
// that is gone.
func (s *Store) NoticesOff(ctx context.Context, accountID string) error {
	return s.noticesOff(ctx, accountID, noticesRefused)
}

// NoticesStale records that an account's sealed chat ID no longer opens
// (sealed under a chat key since replaced), so none are tried until the
// app sets them up again, which it does by itself. Like NoticesOff, it
// writes nothing for an account that is gone.
func (s *Store) NoticesStale(ctx context.Context, accountID string) error {
	return s.noticesOff(ctx, accountID, noticesStale)
}

func (s *Store) noticesOff(ctx context.Context, accountID string, why int64) error {
	_, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 &s.Table,
		Key:                       key(accountPK(accountID), skAccount),
		UpdateExpression:          aws.String("SET #no = :why"),
		ConditionExpression:       aws.String("attribute_exists(pk)"),
		ExpressionAttributeNames:  map[string]string{"#no": "no"},
		ExpressionAttributeValues: attrs{":why": nv(why)},
	})
	var failed *types.ConditionalCheckFailedException
	if errors.As(err, &failed) {
		return nil
	}
	return err
}

// ForgetNotices removes what notices need (the sealed chat ID, the
// language and the last notice's ID) from an account whose notices are
// off (Device.NoticesLeft). Only while they still are: if the app turned
// them on again meanwhile (SetNotices), nothing changes. The api's call,
// not notify's, whose role may only write nm and no.
func (s *Store) ForgetNotices(ctx context.Context, accountID string) error {
	_, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                &s.Table,
		Key:                      key(accountPK(accountID), skAccount),
		UpdateExpression:         aws.String("REMOVE cid, lg, nm"),
		ConditionExpression:      aws.String("attribute_exists(#no)"),
		ExpressionAttributeNames: map[string]string{"#no": "no"},
	})
	var failed *types.ConditionalCheckFailedException
	if errors.As(err, &failed) {
		return nil // turned on again, or the account is gone
	}
	return err
}
