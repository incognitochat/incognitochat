package directory

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// Account expiry (docs/data.md): an account nobody has used for more than
// ExpireAfter months is deleted, in the steps DELETE /account takes, by a
// scheduled run of the api function (api.Server.ExpireAccounts).
//
// The account item records the month, UTC, the account was last used (lu,
// "2026-11"): nothing finer. Registration stores the month it is set up in
// (NewAccount.Month), and a login in a later month replaces it (Used), so
// it is written about once a month per account in use. Accounts set up
// before this was stored have none until their next login, and the expiry
// doesn't see them meanwhile (they are kept, never deleted early).
//
// The table's lastUseIndex (infra/tables.tf) holds the items that have a
// month, which are account items alone: their keys and that month, nothing
// else. The expiry reads it from the oldest month on, up to the newest
// month that has expired (LastExpiredMonth), so a run reads only the
// accounts it deletes, however many there are. An account that ends
// (deleted, or replaced: its marker has no month) leaves the index.

// lastUseIndex is the directory table's index of account items by their
// last-use month (infra/tables.tf): hash key sk ("A" for every account
// item), range key lu, keys only.
const lastUseIndex = "lastUse"

// ExpireAfter is how many whole months an account may go unused: one last
// used in a month is deleted from the first day of the month ExpireAfter+1
// months later (last used in November 2026, deleted from December 2027).
const ExpireAfter = 12

// monthLayout is how a month is written (lu).
const monthLayout = "2006-01"

// What marks an account as being deleted (dl): its own DELETE /account
// (MarkDeleting), or the expiry, for going unused (Expire).
const (
	deletingAsked  = 1
	deletingUnused = 2
)

// Month is the month t falls in, UTC, as the account item records it.
func Month(t time.Time) string {
	return t.UTC().Format(monthLayout)
}

// MonthsBefore is the month n months before the one t falls in, UTC.
func MonthsBefore(t time.Time, n int) string {
	y, m, _ := t.UTC().Date()
	return time.Date(y, m-time.Month(n), 1, 0, 0, 0, 0, time.UTC).Format(monthLayout)
}

// LastExpiredMonth is the newest last-use month whose accounts have gone
// unused for more than ExpireAfter months at now: ExpireAfter+1 months
// before now's month.
func LastExpiredMonth(now time.Time) string {
	return MonthsBefore(now, ExpireAfter+1)
}

// Used records that an account was used in month (Month), unless it says
// so already or later: one conditional write. The api calls it at a login
// whose read of the account (Device.LastUse) showed an earlier month, so
// it writes about once a month per account in use. Only a live account (not
// replaced, and not being deleted: an expiry that started stays started).
// It reports whether it wrote the month.
func (s *Store) Used(ctx context.Context, accountID, month string) (bool, error) {
	_, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 &s.Table,
		Key:                       key(accountPK(accountID), skAccount),
		UpdateExpression:          aws.String("SET lu = :m"),
		ConditionExpression:       aws.String(live + " AND (attribute_not_exists(lu) OR lu < :m)"),
		ExpressionAttributeValues: attrs{":m": sv(month)},
	})
	var failed *types.ConditionalCheckFailedException
	if errors.As(err, &failed) {
		return false, nil // recorded already, or the account is gone or ending
	}
	return err == nil, err
}

// usePK is the settings item that keeps the newest month a login recorded
// its account's month of use in (m), and nothing else: it names nobody.
// Only a login's write (Used, then UseRecorded) moves it on; registration,
// which stores its own month, never does. The expiry deletes nothing unless
// it says this month or last (RecordedUse): so a fault that stops logins
// recording their month, silently or not, can't make accounts in use look
// unused a year later, whoever signs up meanwhile.
const usePK = "S#use"

// UseRecorded notes that a login recorded its account's month of use in
// month, unless the item says so already or later: one conditional write,
// which the api makes at most once a month per instance.
func (s *Store) UseRecorded(ctx context.Context, month string) error {
	_, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 &s.Table,
		Key:                       key(usePK, skSettings),
		UpdateExpression:          aws.String("SET m = :m"),
		ConditionExpression:       aws.String("attribute_not_exists(m) OR m < :m"),
		ExpressionAttributeValues: attrs{":m": sv(month)},
	})
	var failed *types.ConditionalCheckFailedException
	if errors.As(err, &failed) {
		return nil // noted already, this month
	}
	return err
}

// RecordedUse is the newest month a login recorded its month of use in
// (UseRecorded), strongly consistent: "" if none has.
func (s *Store) RecordedUse(ctx context.Context) (string, error) {
	it, err := s.get(ctx, usePK, skSettings, time.Time{})
	if errors.Is(err, ErrNotFound) {
		return "", nil
	}
	m, _ := str(it, "m")
	return m, err
}

// UnusedAccount is an account found unused (Unused): its ID and the month
// it was last used.
type UnusedAccount struct {
	ID      string
	LastUse string
}

// Unused lists up to limit accounts last used in lastExpired or before, the
// oldest first, from the last-use index (eventually consistent, as an index
// is: one used or deleted in about the last second may still show, which
// Expire and the deletion's steps check). It reads only those accounts'
// keys and months. An account's partly done deletion keeps it in the index,
// so the next run carries on with it.
func (s *Store) Unused(ctx context.Context, lastExpired string, limit int) ([]UnusedAccount, error) {
	out, err := s.DB.Query(ctx, &dynamodb.QueryInput{
		TableName:                 &s.Table,
		IndexName:                 aws.String(lastUseIndex),
		KeyConditionExpression:    aws.String("sk = :a AND lu <= :m"),
		ExpressionAttributeValues: attrs{":a": sv(skAccount), ":m": sv(lastExpired)},
		Limit:                     aws.Int32(int32(max(limit, 1))),
	})
	if err != nil {
		return nil, err
	}
	accounts := make([]UnusedAccount, 0, len(out.Items))
	for _, it := range out.Items {
		pk, _ := str(it, "pk")
		lu, _ := str(it, "lu")
		if id, ok := strings.CutPrefix(pk, "A#"); ok && id != "" && lu != "" {
			accounts = append(accounts, UnusedAccount{ID: id, LastUse: lu})
		}
	}
	return accounts, nil
}

// CountUnused counts the accounts last used in lastExpired or before, from
// the last-use index, reading only their keys: up to about max, and whether
// there are more than it counted. For the expiry's dry run.
func (s *Store) CountUnused(ctx context.Context, lastExpired string, max int) (int, bool, error) {
	in := &dynamodb.QueryInput{
		TableName:                 &s.Table,
		IndexName:                 aws.String(lastUseIndex),
		KeyConditionExpression:    aws.String("sk = :a AND lu <= :m"),
		ExpressionAttributeValues: attrs{":a": sv(skAccount), ":m": sv(lastExpired)},
		Select:                    types.SelectCount,
	}
	n := 0
	for {
		out, err := s.DB.Query(ctx, in)
		if err != nil {
			return 0, false, err
		}
		n += int(out.Count)
		if len(out.LastEvaluatedKey) == 0 {
			return n, false, nil
		}
		if n >= max {
			return n, true, nil
		}
		in.ExclusiveStartKey = out.LastEvaluatedKey
	}
}

// AccountState reads an account's item, strongly consistent, for what
// deleting it needs: what Device says, without a device's key. It returns
// ErrNotFound if the account is gone.
func (s *Store) AccountState(ctx context.Context, accountID string) (Device, error) {
	acct, err := s.get(ctx, accountPK(accountID), skAccount, time.Time{})
	if err != nil {
		return Device{}, err
	}
	return accountState(acct), nil
}

// Expire starts deleting an account unused since lastUse, its last-use
// month as read: it marks it as being deleted and ends its link, as
// MarkDeleting does, only while that month is still the account's. It
// returns ErrConflict if the account was used since (Used), or its links
// changed (the next run reads it again), and ErrNotFound if it is gone or
// replaced. Delete, in steps, does the rest, as for DELETE /account.
func (s *Store) Expire(ctx context.Context, accountID, lastUse string) error {
	if lastUse == "" {
		return ErrConflict
	}
	return s.markDeleting(ctx, accountID, lastUse)
}
