// Several copies of the app can run at once on one device: a reopened Mini
// App, Telegram Desktop windows, Telegram Web tabs. They share storage, so
// anything that must not interleave (creating keys, registering, rotating
// keys, syncing) runs under an exclusive lock, and copies tell each other
// about changes on a broadcast channel.

const PREFIX = 'incognitochat:';

// Each local profile (one per Telegram account, storage/profile.ts) has its
// own locks and channel, like its own database.
let namespace = '';

/** Scopes locks and the channel to one local profile. Call once at start. */
export function useProfile(profile: string): void {
  namespace = profile ? `${profile}:` : '';
}

export interface LockManagerLike {
  request<T>(name: string, options: { mode: 'exclusive'; ifAvailable?: boolean }, callback: (lock: unknown) => Promise<T>): Promise<T>;
}

/** The device's Web Locks, or null where the engine has none. */
function defaultLocks(): LockManagerLike | null {
  return (typeof navigator !== 'undefined' ? (navigator.locks as LockManagerLike | undefined) : undefined) ?? null;
}

/**
 * Where Web Locks are missing (rare: Safari before 15.4, some webviews),
 * locks are held in this copy of the app only, each name's holders in turn.
 * What is kept for a name settles once its last holder so far is done; a
 * name nobody holds or waits for isn't kept.
 */
const held = new Map<string, Promise<void>>();
/** How many requests for each name wait for an earlier holder (pendingLocks). */
const waiting = new Map<string, number>();

function holdHere<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const before = held.get(name);
  let done!: () => void;
  const mine = new Promise<void>((resolve) => (done = resolve));
  const last = (before ?? Promise.resolve()).then(() => mine);
  held.set(name, last);
  if (before) waiting.set(name, (waiting.get(name) ?? 0) + 1);
  const turn = before?.then(() => {
    const left = waiting.get(name)! - 1;
    if (left > 0) waiting.set(name, left);
    else waiting.delete(name);
  });
  return (turn ?? Promise.resolve()).then(fn).finally(() => {
    done();
    if (held.get(name) === last) held.delete(name);
  });
}

/**
 * For tests: the names of the locks that requests wait for, where Web Locks
 * are missing (as navigator.locks.query() lists them where they aren't).
 */
export function pendingLocks(): string[] {
  return [...waiting.keys()];
}

/**
 * Runs fn while holding the named lock across every copy of the app on this
 * device. Engines without Web Locks hold it in this copy only: other copies
 * aren't kept out then, but everything in this one still takes turns.
 */
export function withLock<T>(name: string, fn: () => Promise<T>, locks: LockManagerLike | null = defaultLocks()): Promise<T> {
  if (!locks) return holdHere(PREFIX + namespace + name, fn);
  return locks.request(PREFIX + namespace + name, { mode: 'exclusive' }, fn);
}

/**
 * Like withLock, but only if nobody holds the lock now: then fn runs holding
 * it, and this resolves to its result; otherwise to null at once, without
 * waiting. Without Web Locks, nobody in this copy.
 */
export function withLockIfFree<T>(name: string, fn: () => Promise<T>, locks: LockManagerLike | null = defaultLocks()): Promise<{ value: T } | null> {
  if (!locks) {
    const full = PREFIX + namespace + name;
    return held.has(full) ? Promise.resolve(null) : holdHere(full, async () => ({ value: await fn() }));
  }
  return locks.request(PREFIX + namespace + name, { mode: 'exclusive', ifAvailable: true }, async (lock) => (lock ? { value: await fn() } : null));
}

export type SyncEvent = { type: 'account-changed' } | { type: 'keys-changed' } | { type: 'data-changed' };

/** A channel to the other copies of the app. Returns null where unsupported. */
export function openChannel(onEvent: (event: SyncEvent) => void): { send(event: SyncEvent): void; close(): void } | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const channel = new BroadcastChannel(PREFIX + namespace + 'sync');
  channel.onmessage = (e: MessageEvent<unknown>) => {
    const data = e.data as { type?: unknown } | null;
    if (data && (data.type === 'account-changed' || data.type === 'keys-changed' || data.type === 'data-changed')) {
      onEvent({ type: data.type });
    }
  };
  return {
    send: (event) => channel.postMessage(event),
    close: () => channel.close(),
  };
}
