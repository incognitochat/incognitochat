package directory

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
	"github.com/incognitochat/incognitochat/backend/internal/links"
)

// lastUseStore is store with the directory's last-use index.
func lastUseStore(t *testing.T) (*Store, *dynamodb.Client) {
	client := dynamotest.Client(t)
	return &Store{DB: client, Table: dynamotest.DirectoryTable(t, client)}, client
}

// usedIn sets up an account first used in month.
func usedIn(t *testing.T, s *Store, month string) NewAccount {
	t.Helper()
	n := newAccount(t, "th-"+ids.New())
	n.Month = month
	if err := s.Create(context.Background(), n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestMonths(t *testing.T) {
	east := time.FixedZone("UTC+3", 3*3600)
	for _, c := range []struct {
		at                 time.Time
		month, lastExpired string
	}{
		{time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC), "2026-11", "2025-10"},
		// UTC's month, not the clock's zone's.
		{time.Date(2026, 12, 1, 1, 0, 0, 0, east), "2026-11", "2025-10"},
		// Last used in November 2026: kept all through November 2027,
		// deleted from December.
		{time.Date(2027, 11, 30, 23, 59, 59, 0, time.UTC), "2027-11", "2026-10"},
		{time.Date(2027, 12, 1, 0, 0, 0, 0, time.UTC), "2027-12", "2026-11"},
		{time.Date(2027, 1, 31, 0, 0, 0, 0, time.UTC), "2027-01", "2025-12"},
	} {
		if got := Month(c.at); got != c.month {
			t.Errorf("Month(%v) = %s, want %s", c.at, got, c.month)
		}
		if got := LastExpiredMonth(c.at); got != c.lastExpired {
			t.Errorf("LastExpiredMonth(%v) = %s, want %s", c.at, got, c.lastExpired)
		}
	}
	// The month before, whatever the day (March 31st less a month is not
	// March 3rd), across a year.
	for at, want := range map[time.Time]string{
		time.Date(2027, 3, 31, 12, 0, 0, 0, time.UTC): "2027-02",
		time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC):   "2026-12",
	} {
		if got := MonthsBefore(at, 1); got != want {
			t.Errorf("MonthsBefore(%v, 1) = %s, want %s", at, got, want)
		}
	}
}

// RecordedUse is the newest month UseRecorded noted, moving on, never
// back; "" with none. Registrations don't touch it.
func TestRecordedUse(t *testing.T) {
	s, _ := lastUseStore(t)
	ctx := context.Background()
	usedIn(t, s, "2026-11")
	if got, err := s.RecordedUse(ctx); err != nil || got != "" {
		t.Fatalf("none noted: %q %v", got, err)
	}
	for _, c := range []struct{ noted, want string }{{"2026-11", "2026-11"}, {"2026-10", "2026-11"}, {"2026-12", "2026-12"}} {
		if err := s.UseRecorded(ctx, c.noted); err != nil {
			t.Fatal(err)
		}
		if got, err := s.RecordedUse(ctx); err != nil || got != c.want {
			t.Fatalf("noted %s: %q %v, want %s", c.noted, got, err, c.want)
		}
	}
}

// Used moves the month on, never back, and writes nothing to an account
// being deleted, replaced or gone.
func TestUsed(t *testing.T) {
	s, client := lastUseStore(t)
	ctx := context.Background()
	n := usedIn(t, s, "2027-01")
	month := func(id string) string {
		t.Helper()
		d, err := s.AccountState(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return d.LastUse
	}
	if d, err := s.Device(ctx, n.ID, n.DeviceID, now); err != nil || d.LastUse != "2027-01" {
		t.Fatalf("a login reads %+v, %v", d, err)
	}
	for _, c := range []struct {
		used, want string
		written    bool
	}{{"2027-01", "2027-01", false}, {"2027-03", "2027-03", true}, {"2027-02", "2027-03", false}} {
		if written, err := s.Used(ctx, n.ID, c.used); err != nil || written != c.written {
			t.Fatalf("used in %s: wrote %v, %v", c.used, written, err)
		}
		if got := month(n.ID); got != c.want {
			t.Fatalf("used in %s: %s, want %s", c.used, got, c.want)
		}
	}

	// An account set up before months were stored gets one.
	older := newAccount(t, "th-older")
	if err := s.Create(ctx, older); err != nil {
		t.Fatal(err)
	}
	if got := month(older.ID); got != "" {
		t.Fatalf("no month: %q", got)
	}
	if written, err := s.Used(ctx, older.ID, "2027-01"); err != nil || !written || month(older.ID) != "2027-01" {
		t.Fatalf("its first month: %v", err)
	}

	// Being deleted: kept as it was, so an expiry that started stays
	// started.
	if err := s.MarkDeleting(ctx, n.ID); err != nil {
		t.Fatal(err)
	}
	if written, err := s.Used(ctx, n.ID, "2027-04"); err != nil || written || month(n.ID) != "2027-03" {
		t.Fatalf("being deleted: %v", err)
	}
	// Replaced, or gone: nothing is written, not even an item.
	repl := newAccount(t, older.TelegramHash)
	acct, err := s.ByTelegram(ctx, older.TelegramHash, older.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Replace(ctx, acct, repl, now); err != nil {
		t.Fatal(err)
	}
	if written, err := s.Used(ctx, older.ID, "2027-05"); err != nil || written || month(older.ID) != "" {
		t.Fatalf("replaced: %v", err)
	}
	out, err := client.Scan(ctx, &dynamodb.ScanInput{TableName: aws.String(s.Table), Select: "COUNT"})
	if err != nil {
		t.Fatal(err)
	}
	if written, err := s.Used(ctx, "AAAAAAAAAAAAAAAAAAAAAA", "2027-05"); err != nil || written {
		t.Fatal(err)
	}
	again, err := client.Scan(ctx, &dynamodb.ScanInput{TableName: aws.String(s.Table), Select: "COUNT"})
	if err != nil || again.Count != out.Count {
		t.Fatalf("a missing account: %d items, then %d (%v)", out.Count, again.Count, err)
	}
}

// Unused lists the accounts last used in the month given or before, the
// oldest first, up to its limit, and CountUnused counts them: accounts
// with no month, and replaced ones (whose markers have none), aren't
// there.
func TestUnused(t *testing.T) {
	s, _ := lastUseStore(t)
	ctx := context.Background()
	a := usedIn(t, s, "2025-11")
	b := usedIn(t, s, "2025-09")
	c := usedIn(t, s, "2025-12")
	usedIn(t, s, "2026-01")
	if err := s.Create(ctx, newAccount(t, "th-no-month")); err != nil {
		t.Fatal(err)
	}
	replaced := usedIn(t, s, "2025-10")
	acct, err := s.ByTelegram(ctx, replaced.TelegramHash, replaced.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	fresh := newAccount(t, replaced.TelegramHash)
	fresh.Month = "2027-01"
	if err := s.Replace(ctx, acct, fresh, now); err != nil {
		t.Fatal(err)
	}

	got, err := s.Unused(ctx, "2025-12", 10)
	if err != nil {
		t.Fatal(err)
	}
	want := []UnusedAccount{{b.ID, "2025-09"}, {a.ID, "2025-11"}, {c.ID, "2025-12"}}
	if !slices.Equal(got, want) {
		t.Fatalf("unused: %v, want %v", got, want)
	}
	if got, err := s.Unused(ctx, "2025-12", 2); err != nil || !slices.Equal(got, want[:2]) {
		t.Fatalf("the oldest two: %v, %v", got, err)
	}
	if got, err := s.Unused(ctx, "2025-08", 10); err != nil || len(got) != 0 {
		t.Fatalf("none that old: %v, %v", got, err)
	}
	if n, more, err := s.CountUnused(ctx, "2025-12", 100); err != nil || n != 3 || more {
		t.Fatalf("count: %d %v %v", n, more, err)
	}
}

// Expire marks an account as being deleted and ends its link, as
// MarkDeleting does, only while it is still last used in the month the
// expiry read.
func TestExpire(t *testing.T) {
	s, _ := lastUseStore(t)
	ctx := context.Background()
	n := usedIn(t, s, "2025-12")
	l := testLink(t)
	if err := s.CreateLink(ctx, n.ID, l, links.MaxActive); err != nil {
		t.Fatal(err)
	}

	// Used since it was listed: kept.
	if _, err := s.Used(ctx, n.ID, "2027-01"); err != nil {
		t.Fatal(err)
	}
	if err := s.Expire(ctx, n.ID, "2025-12"); !errors.Is(err, ErrConflict) {
		t.Fatalf("expire one used since: %v", err)
	}
	if err := s.Expire(ctx, n.ID, ""); !errors.Is(err, ErrConflict) {
		t.Fatalf("expire with no month: %v", err)
	}
	if d, err := s.AccountState(ctx, n.ID); err != nil || d.Deleting {
		t.Fatalf("kept: %+v, %v", d, err)
	}
	if _, err := s.Link(ctx, l.ID); err != nil {
		t.Fatalf("its link: %v", err)
	}

	if err := s.Expire(ctx, n.ID, "2027-01"); err != nil {
		t.Fatal(err)
	}
	if d, err := s.AccountState(ctx, n.ID); err != nil || !d.Deleting || !d.Expired || d.LastUse != "2027-01" {
		t.Fatalf("expired: %+v, %v", d, err)
	}
	if _, err := s.Link(ctx, l.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("its link once expired: %v", err)
	}
	// It stays in the index, with its month, until Delete is done.
	if got, err := s.Unused(ctx, "2027-01", 10); err != nil || len(got) != 1 || got[0].ID != n.ID {
		t.Fatalf("listed while being deleted: %v, %v", got, err)
	}
	if done, err := s.Delete(ctx, n.ID, n.TelegramHash, 100); err != nil || !done {
		t.Fatalf("delete: %v %v", done, err)
	}
	if got, err := s.Unused(ctx, "2027-01", 10); err != nil || len(got) != 0 {
		t.Fatalf("listed once deleted: %v, %v", got, err)
	}
	if err := s.Expire(ctx, n.ID, "2027-01"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expire one gone: %v", err)
	}

	// Its user's own deletion is no expiry.
	own := usedIn(t, s, "2025-12")
	if err := s.MarkDeleting(ctx, own.ID); err != nil {
		t.Fatal(err)
	}
	if d, err := s.AccountState(ctx, own.ID); err != nil || !d.Deleting || d.Expired {
		t.Fatalf("deleted by its user: %+v, %v", d, err)
	}
}
