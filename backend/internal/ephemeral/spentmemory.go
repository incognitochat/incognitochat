package ephemeral

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"maps"
	"math"
	"slices"
	"time"
)

const (
	// maxRemembered is the most spent tokens an instance remembers
	// (spentMemory).
	maxRemembered = 1 << 20
	// firstSlots is the table's size when a first token is remembered.
	firstSlots = 1 << 10
)

type spentKey [16]byte

type spentSlot struct {
	key spentKey
	exp uint32 // the minute its record expires, since the Unix epoch; 0 if empty
}

// spentMemory is what an instance remembers of the tokens it has seen
// spent (Spent), so that a replay costs the table nothing: a hash table of a
// 16-byte key for each token and the minute its record expires.
//
// A token is remembered until it expires. Only a full memory forgets one
// sooner: it then forgets every token that has expired and, if that leaves
// it more than seven eighths full, those that expire soonest, down to seven
// eighths. It never starts over. So each spent token costs the table at
// most one write unit per instance while it is accepted, unless more
// tokens than the memory holds are replayed to one instance.
//
// Tokens carry no identity, so nothing limits replays per person. A
// Telegram account gets 1,500 tokens a day (send and media), and the
// issuer can't see which week it signs a token for, so an account can mint
// weeks ahead for one fortnight: 21,000 minted within it, 84,000 over 8
// weeks. maxRemembered holds about 700 account-days of minting (13
// accounts that minted for 8 weeks).
//
// The table starts small and doubles as it fills, up to twice
// maxRemembered slots: 2^21 slots of 20 bytes, 40 MiB, in the api
// function's 256 MB. Slots hold no pointers, so the garbage collector
// doesn't scan them.
//
// A token's key is a SHA-256 of the instance's own random salt and the
// token's nonce, cut to 16 bytes, and its slot comes from the key. Holders
// choose their tokens' nonces, but without the salt they can't make keys
// collide or crowd one part of the table.
//
// Not safe for concurrent use: Spent holds its lock around every call.
type spentMemory struct {
	most  int // the most tokens held: maxRemembered, unless a test sets fewer
	salt  [32]byte
	salty bool
	slots []spentSlot // a power of two long, at least half empty
	held  int         // slots in use, expired ones included
}

// key returns a nonce's key.
func (m *spentMemory) key(nonce []byte) spentKey {
	if !m.salty {
		rand.Read(m.salt[:])
		m.salty = true
	}
	buf := make([]byte, 0, len(m.salt)+64)
	sum := sha256.Sum256(append(append(buf, m.salt[:]...), nonce...))
	return spentKey(sum[:16])
}

// has reports whether k is remembered and hasn't expired by minute now.
func (m *spentMemory) has(k spentKey, now uint32) bool {
	if m.slots == nil {
		return false
	}
	i, ok := m.find(k)
	return ok && m.slots[i].exp > now
}

// add remembers k until minute exp, or until a new minute exp if it's
// remembered already. One expired by minute now is left out.
func (m *spentMemory) add(k spentKey, exp, now uint32) {
	if exp <= now {
		return
	}
	if m.slots == nil {
		m.slots = make([]spentSlot, min(firstSlots, m.maxSlots()))
	}
	i, ok := m.find(k)
	if ok {
		m.slots[i].exp = exp
		return
	}
	if m.held >= len(m.slots)/2 && len(m.slots) < m.maxSlots() {
		m.resize(2*len(m.slots), now)
		i, _ = m.find(k)
	}
	if m.held >= m.limit() {
		m.sweep(now)
		i, _ = m.find(k)
	}
	m.slots[i] = spentSlot{key: k, exp: exp}
	m.held++
}

// remove forgets k.
func (m *spentMemory) remove(k spentKey) {
	if m.slots == nil {
		return
	}
	if i, ok := m.find(k); ok {
		m.removeAt(i)
	}
}

func (m *spentMemory) limit() int {
	if m.most > 0 {
		return m.most
	}
	return maxRemembered
}

// maxSlots is the table's largest size: a power of two at least twice the
// limit, so that it is always at least half empty.
func (m *spentMemory) maxSlots() int {
	n := 2
	for n < 2*m.limit() {
		n *= 2
	}
	return n
}

func (m *spentMemory) home(k spentKey) int {
	return int(binary.LittleEndian.Uint64(k[:8]) & uint64(len(m.slots)-1))
}

// find returns k's slot, or the empty slot where it would go (linear
// probing: there is always one, as the table is at least half empty).
func (m *spentMemory) find(k spentKey) (int, bool) {
	mask := len(m.slots) - 1
	for i := m.home(k); ; i = (i + 1) & mask {
		switch s := &m.slots[i]; {
		case s.exp == 0:
			return i, false
		case s.key == k:
			return i, true
		}
	}
}

// removeAt empties slot i, and moves back the entries after it that would
// otherwise no longer be found from their home slot, so the table needs no
// markers for removed entries.
func (m *spentMemory) removeAt(i int) {
	mask := len(m.slots) - 1
	for j := (i + 1) & mask; m.slots[j].exp != 0; j = (j + 1) & mask {
		// The entry at j stays unless its home is outside (i, j], going
		// round.
		h := m.home(m.slots[j].key)
		if (i < j && (h <= i || h > j)) || (i > j && h <= i && h > j) {
			m.slots[i] = m.slots[j]
			i = j
		}
	}
	m.slots[i] = spentSlot{}
	m.held--
}

// resize moves what is remembered into a table of size slots, leaving out
// what has expired by minute now.
func (m *spentMemory) resize(size int, now uint32) {
	old := m.slots
	m.slots = make([]spentSlot, size)
	m.held = 0
	for _, s := range old {
		if s.exp > now {
			i, _ := m.find(s.key)
			m.slots[i] = s
			m.held++
		}
	}
}

// sweep makes room in a full table: it forgets everything that has expired
// by minute now and then, if more than seven eighths of the limit is left,
// what expires soonest, down to seven eighths. It looks at the whole table
// twice, and runs at most once for each eighth of the limit added, so each
// token added pays for about 32 slots looked at (2 × 2^21 / 2^17).
func (m *spentMemory) sweep(now uint32) {
	keep := m.limit() - max(1, m.limit()/8)
	live := map[uint32]int{} // entries by the minute they expire, of those that haven't
	expired := 0
	for _, s := range m.slots {
		switch {
		case s.exp == 0:
		case s.exp <= now:
			expired++
		default:
			live[s.exp]++
		}
	}
	// Those expiring before cut go too, and quota of those expiring at cut.
	var cut uint32
	quota := 0
	if over := m.held - expired - keep; over > 0 {
		for _, exp := range slices.Sorted(maps.Keys(live)) {
			if live[exp] >= over {
				cut, quota = exp, over
				break
			}
			over -= live[exp]
		}
	}
	// From an empty slot, once round: entries never move back past one, so
	// removing an entry moves none that was looked at already, and an entry
	// moved into the slot just emptied is looked at next.
	start := 0
	for m.slots[start].exp != 0 {
		start++
	}
	mask := len(m.slots) - 1
	for i, seen := (start+1)&mask, 1; seen < len(m.slots); {
		exp := m.slots[i].exp
		gone := exp != 0 && (exp <= now || exp < cut)
		if !gone && quota > 0 && exp == cut {
			gone = true
			quota--
		}
		if gone {
			m.removeAt(i)
			continue
		}
		i = (i + 1) & mask
		seen++
	}
}

// minuteOf is the minute t falls in, since the Unix epoch.
func minuteOf(t time.Time) uint32 {
	return uint32(min(max(t.Unix()/60, 0), math.MaxUint32))
}
