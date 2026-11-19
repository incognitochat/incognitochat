// Backing off the app's background requests (the inbox poll, syncs a push
// asks for) while the server is in trouble: when it is overloaded (AWS
// throttles it), every open app polling on a fixed schedule would keep the
// load up. Only background requests wait; what the user does is never held
// back.

import { ApiError, NetworkError } from './api';

/**
 * Whether an error means the server is in trouble, not that the request was
 * wrong: no answer (offline, or the server unreachable), a server error
 * (5xx: 503 unavailable when overloaded), or a refusal for load (429).
 */
export function isServerTrouble(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  return err instanceof ApiError && (err.status === 429 || err.status >= 500);
}

interface BackoffOptions {
  /** The longest first wait (ms); each failure in a row doubles it. */
  baseMs: number;
  /** The longest wait (ms), whatever the server asks. */
  maxMs: number;
  now?: () => number;
  random?: () => number;
}

interface Backoff {
  /** How long background requests should still wait (ms), 0 if not. */
  remaining(): number;
  /**
   * A request failed. If the server is in trouble (isServerTrouble), the
   * wait starts or grows, and it returns true.
   */
  failed(err: unknown): boolean;
  /** A request got through: no more waiting. */
  succeeded(): void;
}

/**
 * Exponential backoff with jitter: after the nth failure in a row, half to
 * all of baseMs·2ⁿ⁻¹ (so apps that failed together don't come back
 * together), at least what the server asked for (Retry-After), at most
 * maxMs.
 */
export function createBackoff(options: BackoffOptions): Backoff {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  let failures = 0;
  let until = 0;
  return {
    remaining() {
      const left = until - now();
      // Longer than the longest wait: the clock was set back since.
      return left > 0 && left <= options.maxMs ? left : 0;
    },
    failed(err) {
      if (!isServerTrouble(err)) return false;
      failures++;
      const ceiling = Math.min(options.maxMs, options.baseMs * 2 ** Math.min(failures - 1, 30));
      let wait = ceiling / 2 + (random() * ceiling) / 2;
      const asked = err instanceof ApiError ? err.retryAfter : undefined;
      if (asked !== undefined) wait = Math.max(wait, Math.min(asked * 1000, options.maxMs));
      until = now() + wait;
      return true;
    },
    succeeded() {
      failures = 0;
      until = 0;
    },
  };
}
