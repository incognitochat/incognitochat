package ephemeral

import (
	"context"
	"fmt"
	"math/rand/v2"
	"slices"
	"sync"
	"testing"
	"time"
	"unsafe"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
)

// randomKeys returns n distinct keys, the same for the same seed.
func randomKeys(seed uint64, n int) []spentKey {
	r := rand.New(rand.NewPCG(seed, seed))
	seen := map[spentKey]bool{}
	out := make([]spentKey, 0, n)
	for len(out) < n {
		var k spentKey
		for i := range k {
			k[i] = byte(r.Uint32())
		}
		if !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	return out
}

// checkMemory checks the table's invariants: each entry is found from its
// home slot, once; the count is right; it is at least half empty, and
// holds no more than its limit.
func checkMemory(t *testing.T, m *spentMemory) {
	t.Helper()
	held := 0
	for i, s := range m.slots {
		if s.exp == 0 {
			continue
		}
		held++
		if j, ok := m.find(s.key); !ok || j != i {
			t.Fatalf("the entry in slot %d is found at %d, %v", i, j, ok)
		}
	}
	if held != m.held {
		t.Fatalf("%d entries counted, %d in the table", m.held, held)
	}
	if 2*held > len(m.slots) || held > m.limit() || len(m.slots) > m.maxSlots() {
		t.Fatalf("%d entries in %d slots, limit %d", held, len(m.slots), m.limit())
	}
}

// The default memory remembers about a million tokens in at most 40 MiB.
func TestSpentMemorySize(t *testing.T) {
	var m spentMemory
	if got := unsafe.Sizeof(spentSlot{}); got != 20 {
		t.Fatalf("a slot takes %d bytes, want 20", got)
	}
	if m.limit() != 1<<20 || m.maxSlots() != 1<<21 {
		t.Fatalf("limit %d, at most %d slots", m.limit(), m.maxSlots())
	}
	if bytes := m.maxSlots() * int(unsafe.Sizeof(spentSlot{})); bytes > 40<<20 {
		t.Fatalf("the table can take %d bytes", bytes)
	}
	// It starts small.
	m.add(m.key([]byte("a nonce")), 100, 1)
	if len(m.slots) != firstSlots {
		t.Fatalf("a first token made %d slots", len(m.slots))
	}
}

// Filled again and again, the memory stays within its bounds, never starts
// over, and keeps at least seven eighths of its limit.
func TestSpentMemoryBound(t *testing.T) {
	m := spentMemory{most: 3000}
	keys := randomKeys(1, 20_000)
	for i, k := range keys {
		m.add(k, 100, 1)
		if i >= m.most && m.held < m.most-m.most/8 {
			t.Fatalf("after %d tokens it holds %d", i+1, m.held)
		}
		if m.held > m.most || len(m.slots) > m.maxSlots() {
			t.Fatalf("after %d tokens: %d held in %d slots", i+1, m.held, len(m.slots))
		}
	}
	checkMemory(t, &m)
	if len(m.slots) != 8192 {
		t.Fatalf("%d slots, want 8192 (twice 3,000, as a power of two)", len(m.slots))
	}
	remembered := 0
	for _, k := range keys {
		if m.has(k, 1) {
			remembered++
		}
	}
	if remembered != m.held || !m.has(keys[len(keys)-1], 1) {
		t.Fatalf("%d remembered, %d held", remembered, m.held)
	}
}

// Full, the memory forgets expired tokens first, and only those while that
// makes room enough: none that hasn't expired.
func TestSpentMemoryExpiredFirst(t *testing.T) {
	m := spentMemory{most: 1000}
	keys := randomKeys(2, 1001)
	soon, later := keys[:400], keys[400:1000]
	for _, k := range soon {
		m.add(k, 10, 1)
	}
	for _, k := range later {
		m.add(k, 20_000, 1)
	}
	// Full, at minute 15: the first 400 have expired.
	m.add(keys[1000], 20_000, 15)
	checkMemory(t, &m)
	for _, k := range later {
		if !m.has(k, 15) {
			t.Fatal("a token that hadn't expired was forgotten while expired ones were held")
		}
	}
	for _, k := range soon {
		if _, ok := m.find(k); ok {
			t.Fatal("an expired token is still held after making room")
		}
	}
	if m.held != 601 {
		t.Fatalf("holds %d, want 601", m.held)
	}
}

// Full of tokens that haven't expired, it forgets those that expire
// soonest, an eighth of its limit, not everything.
func TestSpentMemorySoonestFirst(t *testing.T) {
	m := spentMemory{most: 1000}
	keys := randomKeys(3, 1001)
	thisWeek, nextWeek := keys[:300], keys[300:1000]
	for _, k := range nextWeek[:350] {
		m.add(k, 2000, 1)
	}
	for _, k := range thisWeek {
		m.add(k, 1000, 1)
	}
	for _, k := range nextWeek[350:] {
		m.add(k, 2000, 1)
	}
	m.add(keys[1000], 3000, 1)
	checkMemory(t, &m)
	for _, k := range nextWeek {
		if !m.has(k, 1) {
			t.Fatal("a token was forgotten while ones expiring sooner were held")
		}
	}
	left := 0
	for _, k := range thisWeek {
		if m.has(k, 1) {
			left++
		}
	}
	// 1,000 less 875 (seven eighths): 125 of those expiring soonest.
	if left != 175 || m.held != 876 {
		t.Fatalf("%d of the soonest left, %d held; want 175 and 876", left, m.held)
	}
}

// Whenever making room forgets tokens that haven't expired, none has
// expired that it kept, and each it forgot expires no later than any it
// kept.
func TestSpentMemoryEvictionOrder(t *testing.T) {
	m := spentMemory{most: 256}
	r := rand.New(rand.NewPCG(4, 4))
	keys := randomKeys(4, 6000)
	held := map[spentKey]uint32{}
	now := uint32(1)
	for _, k := range keys {
		if r.IntN(20) == 0 {
			now++
		}
		exp := now + 1 + uint32(r.IntN(20))
		m.add(k, exp, now)
		var forgot []uint32
		for h, e := range held {
			if _, ok := m.find(h); !ok {
				delete(held, h)
				if e > now {
					forgot = append(forgot, e)
				}
			}
		}
		held[k] = exp
		if len(forgot) == 0 {
			continue
		}
		latest := slices.Max(forgot)
		for h, e := range held {
			if h == k {
				continue // added after room was made
			}
			if e <= now {
				t.Fatalf("minute %d: kept a token that expired at %d while forgetting live ones", now, e)
			}
			if e < latest {
				t.Fatalf("minute %d: forgot one expiring at %d, kept one expiring at %d", now, latest, e)
			}
		}
	}
	checkMemory(t, &m)
}

// Against a map, with random adds, removals and lookups, while the table
// grows: what it says is what the map says, and its invariants hold.
func TestSpentMemoryModel(t *testing.T) {
	m := spentMemory{most: 4096}
	r := rand.New(rand.NewPCG(5, 5))
	keys := randomKeys(5, 3000) // fewer than the limit: nothing is made room for
	want := map[spentKey]uint32{}
	now := uint32(1)
	for step := range 60_000 {
		k := keys[r.IntN(len(keys))]
		switch r.IntN(10) {
		case 0:
			now++
		case 1, 2:
			m.remove(k)
			delete(want, k)
		case 3, 4, 5:
			exp := now + uint32(r.IntN(8))
			m.add(k, exp, now)
			if exp > now {
				want[k] = exp
			}
		default:
			if got := m.has(k, now); got != (want[k] > now) {
				t.Fatalf("step %d: has = %v, want %v", step, got, !got)
			}
		}
		if step%5000 == 0 {
			checkMemory(t, &m)
		}
	}
	checkMemory(t, &m)
	if len(m.slots) <= firstSlots {
		t.Fatal("the table never grew")
	}
}

// Which of the tokens expiring soonest a sweep forgets is left to chance
// each time, not fixed by where their slots are: otherwise the same tokens
// would be forgotten at every sweep, and replaying just those would miss
// every time.
func TestSpentMemorySweepStartsAnywhere(t *testing.T) {
	keys := randomKeys(7, 1001)
	forgotten := map[string]bool{}
	for range 4 {
		m := spentMemory{most: 1000}
		for _, k := range keys {
			m.add(k, 100, 1) // the last one sets off a sweep
		}
		checkMemory(t, &m)
		var gone []byte
		for i, k := range keys {
			if !m.has(k, 1) {
				gone = fmt.Appendf(gone, "%d,", i)
			}
		}
		forgotten[string(gone)] = true
	}
	if len(forgotten) < 2 {
		t.Fatal("four sweeps of the same table forgot the same tokens")
	}
}

// A write that failed for another reason than the token being spent (the
// table throttled it, say) leaves the token unspent, here too: the app
// tries the same send again, and it must go through, on this instance as
// on any other.
func TestSpentFailedWriteNotRemembered(t *testing.T) {
	db := &throttlingDB{failures: 1}
	sp := &Spent{DB: db, Table: "t", Now: func() time.Time { return start }}
	ctx := context.Background()
	nonce := []byte("0123456789abcdef0123456789abcdef")
	forget := start.Add(time.Hour)
	if ok, err := sp.Spend(ctx, nonce, forget); ok || err == nil {
		t.Fatalf("a throttled write: %v, %v", ok, err)
	}
	if ok, err := sp.Spend(ctx, nonce, forget); !ok || err != nil {
		t.Fatalf("tried again: %v, %v; a failed write was remembered as spent", ok, err)
	}
	if ok, err := sp.Spend(ctx, nonce, forget); ok || err != nil {
		t.Fatalf("replayed: %v, %v", ok, err)
	}
	if db.calls != 2 {
		t.Fatalf("%d writes, want 2 (the replay is refused from memory)", db.calls)
	}
	// SpendAll the same.
	db.failures = 1
	batch := []TokenNonce{{[]byte("another nonce, 32 bytes long...."), forget}}
	if ok, err := sp.SpendAll(ctx, batch); ok || err == nil {
		t.Fatalf("a throttled batch: %v, %v", ok, err)
	}
	if ok, err := sp.SpendAll(ctx, batch); !ok || err != nil {
		t.Fatalf("the batch tried again: %v, %v", ok, err)
	}
}

// A token given back is forgotten by the instance that gave it back, so
// it can be spent again there, not only elsewhere.
func TestSpentGivenBackForgottenHere(t *testing.T) {
	client := dynamotest.Client(t)
	sp := &Spent{DB: client, Table: dynamotest.Table(t, client), Now: func() time.Time { return start }}
	ctx := context.Background()
	nonce := []byte("0123456789abcdef0123456789abcdef")
	forget := start.Add(time.Hour)
	if ok, err := sp.Spend(ctx, nonce, forget); !ok || err != nil {
		t.Fatalf("first spend: %v, %v", ok, err)
	}
	if err := sp.Unspend(ctx, nonce); err != nil {
		t.Fatal(err)
	}
	if ok, err := sp.Spend(ctx, nonce, forget); !ok || err != nil {
		t.Fatalf("spent again on the same instance after it was given back: %v, %v", ok, err)
	}
	if ok, _ := sp.Spend(ctx, nonce, forget); ok {
		t.Fatal("spent a third time")
	}
}

// throttlingDB fails its next failures writes as a throttled table does,
// then accepts every one; it counts them.
type throttlingDB struct {
	countingDB
	failures int
	calls    int
}

func (d *throttlingDB) UpdateItem(context.Context, *dynamodb.UpdateItemInput, ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	d.calls++
	if d.failures > 0 {
		d.failures--
		return nil, errThrottled
	}
	return &dynamodb.UpdateItemOutput{}, nil
}

// A key depends on the nonce and on the instance's salt, nothing else.
func TestSpentMemoryKey(t *testing.T) {
	var a, b spentMemory
	n := []byte("0123456789abcdef0123456789abcdef")
	if a.key(n) != a.key(n) {
		t.Fatal("one nonce, two keys")
	}
	if a.key(n) == a.key([]byte("0123456789abcdef0123456789abcdeF")) {
		t.Fatal("two nonces, one key")
	}
	if a.key(n) == b.key(n) {
		t.Fatal("two instances, one key: the salt isn't random")
	}
}

// Looking a token up and remembering it allocates nothing, once the table
// has room.
func TestSpentMemoryAllocs(t *testing.T) {
	var m spentMemory
	nonce := []byte("0123456789abcdef0123456789abcdef")
	m.add(m.key(nonce), 100, 1)
	allocs := testing.AllocsPerRun(1000, func() {
		k := m.key(nonce)
		if !m.has(k, 1) {
			t.Fatal("forgotten")
		}
		m.add(k, 100, 1)
	})
	if allocs != 0 {
		t.Fatalf("%v allocations a token", allocs)
	}
}

// Far more tokens than the old memory held (8,192, then it started over),
// and a replay of any of them still costs the table nothing.
func TestSpentRemembersReplaysAfterMany(t *testing.T) {
	db := &countingDB{}
	sp := &Spent{DB: db, Table: "t", Now: func() time.Time { return start }}
	ctx := context.Background()
	forget := start.Add(7 * 24 * time.Hour)
	const n = 50_000
	nonce := func(i int) []byte { return fmt.Appendf(nil, "nonce %08d, 32 bytes long......", i) }
	for i := range n {
		if ok, err := sp.Spend(ctx, nonce(i), forget); !ok || err != nil {
			t.Fatalf("token %d: %v, %v", i, ok, err)
		}
	}
	if db.writes != n {
		t.Fatalf("%d writes, want %d", db.writes, n)
	}
	for i := range n {
		if ok, err := sp.Spend(ctx, nonce(i), forget); ok || err != nil {
			t.Fatalf("replay of token %d: %v, %v", i, ok, err)
		}
	}
	if db.writes != n {
		t.Fatalf("replays cost %d writes", db.writes-n)
	}
	// Past its expiry it's forgotten, and the table asked again.
	sp.Now = func() time.Time { return forget.Add(time.Minute) }
	if ok, _ := sp.Spend(ctx, nonce(0), forget.Add(time.Hour)); !ok {
		t.Fatal("an expired token is still refused from memory")
	}
	if db.writes != n+1 {
		t.Fatalf("%d writes, want %d", db.writes, n+1)
	}
}

// Many requests at once, each spending the same tokens: each token is
// fresh exactly once, and once all are spent, replaying them writes
// nothing. Run with -race.
func TestSpentConcurrent(t *testing.T) {
	db := &spentDB{spent: map[string]bool{}}
	sp := &Spent{DB: db, Table: "t", Now: func() time.Time { return start }}
	ctx := context.Background()
	forget := start.Add(time.Hour)
	const tokens, workers = 500, 8
	nonce := func(i int) []byte { return fmt.Appendf(nil, "nonce %08d, 32 bytes long......", i) }
	fresh := make([]int, workers)
	var wg sync.WaitGroup
	for w := range workers {
		wg.Go(func() {
			r := rand.New(rand.NewPCG(uint64(w), 0))
			for _, i := range r.Perm(tokens) {
				ok, err := sp.Spend(ctx, nonce(i), forget)
				if err != nil {
					t.Error(err)
					return
				}
				if ok {
					fresh[w]++
				}
				if i%50 == 0 {
					// A batch with it: refused, as it's spent by now.
					if ok, err := sp.SpendAll(ctx, []TokenNonce{{nonce(i), forget}, {nonce(tokens + i), forget}}); ok || err != nil {
						t.Errorf("a batch with a spent token: %v, %v", ok, err)
					}
				}
			}
		})
	}
	wg.Wait()
	total := 0
	for _, f := range fresh {
		total += f
	}
	if total != tokens {
		t.Fatalf("%d spends were fresh, want %d", total, tokens)
	}
	before := db.count()
	for i := range tokens {
		if ok, _ := sp.Spend(ctx, nonce(i), forget); ok {
			t.Fatal("a spent token spent again")
		}
	}
	if w := db.count() - before; w != 0 {
		t.Fatalf("replays wrote %d times", w)
	}
}

// spentDB holds spent tokens as the table would, for Spend alone, and is
// safe for concurrent use.
type spentDB struct {
	countingDB
	mu     sync.Mutex
	spent  map[string]bool
	writes int
}

func (d *spentDB) UpdateItem(_ context.Context, in *dynamodb.UpdateItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.writes++
	pk := in.Key["pk"].(*types.AttributeValueMemberS).Value
	if d.spent[pk] {
		return nil, &types.ConditionalCheckFailedException{}
	}
	d.spent[pk] = true
	return &dynamodb.UpdateItemOutput{}, nil
}

func (d *spentDB) count() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.writes
}

// A replay refused from memory.
func BenchmarkSpentReplay(b *testing.B) {
	sp := &Spent{DB: &countingDB{}, Table: "t", Now: func() time.Time { return start }}
	ctx := context.Background()
	nonce := []byte("0123456789abcdef0123456789abcdef")
	forget := start.Add(time.Hour)
	if ok, err := sp.Spend(ctx, nonce, forget); !ok || err != nil {
		b.Fatal(ok, err)
	}
	b.ReportAllocs()
	for b.Loop() {
		if ok, _ := sp.Spend(ctx, nonce, forget); ok {
			b.Fatal("replay accepted")
		}
	}
}

// Remembering tokens in a full memory, making room as it goes.
func BenchmarkSpentMemoryFull(b *testing.B) {
	var m spentMemory
	keys := randomKeys(6, maxRemembered+1<<16)
	for _, k := range keys[:maxRemembered] {
		m.add(k, 100, 1)
	}
	b.ReportAllocs()
	i := 0
	for b.Loop() {
		m.add(keys[i%len(keys)], 100, 1)
		i++
	}
}
