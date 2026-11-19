package session

import (
	"context"
	"sync"
	"time"
)

// memoryNonces is an in-memory NonceStore for tests. Production uses a
// DynamoDB table with a conditional write and a TTL (ephemeral.Nonces).
type memoryNonces struct {
	mu   sync.Mutex
	used map[string]time.Time
	now  func() time.Time
}

// newMemoryNonces returns an empty store using clock for expiry.
func newMemoryNonces(clock func() time.Time) *memoryNonces {
	return &memoryNonces{used: map[string]time.Time{}, now: clock}
}

// Use implements NonceStore.
func (m *memoryNonces) Use(_ context.Context, nonce string, expires time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if until, ok := m.used[nonce]; ok && m.now().Before(until) {
		return false, nil
	}
	m.used[nonce] = expires
	return true, nil
}
