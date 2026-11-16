// The server's clock, as this device knows it. The times the server checks
// to the minute (logins, signed requests, a new account's device list) are
// taken from here, so a device whose own clock is off still works: the server
// answers such a time with clock_skew and its own clock, the app learns how
// far apart the two are and asks again, once. Kept in memory only: each
// launch learns it anew the first time it's needed.
//
// Only within MAX_OFFSET_MS of the device's own clock: a server claiming a
// time further off isn't believed (it could be collecting logins and
// signatures dated far ahead, to replay them later), and the user is asked to
// set the device's clock instead.

import { ApiError } from './api';

/** The furthest the server's clock is believed to be from this device's: two days. */
export const MAX_OFFSET_MS = 48 * 3600_000;

export interface Clock {
  /** The server's time now, in Unix milliseconds, as near as this device knows it. */
  now(): number;
  /** The server's time now, in whole Unix seconds. */
  seconds(): number;
  /** How far the server's clock is ahead of this device's, in milliseconds. */
  offset(): number;
  /**
   * Learns the server's clock from a clock_skew answer. Returns whether err
   * was one within MAX_OFFSET_MS, so asking again with this clock's time will do.
   */
  learn(err: unknown): boolean;
  /** Whether err is a clock_skew answer further from this device's clock than MAX_OFFSET_MS: its clock needs setting. */
  tooFar(err: unknown): boolean;
}

/** A clock that starts out as the device's own (local: Unix milliseconds). */
export function createClock(local: () => number = () => Date.now()): Clock {
  let offset = 0;
  const now = () => local() + offset;
  // The server says whole seconds: take the middle of that second.
  const offsetOf = (err: unknown): number | null =>
    err instanceof ApiError && err.code === 'clock_skew' && err.serverTime !== undefined ? err.serverTime * 1000 + 500 - local() : null;
  return {
    now,
    seconds: () => Math.floor(now() / 1000),
    offset: () => offset,
    learn(err) {
      const learnt = offsetOf(err);
      if (learnt === null || Math.abs(learnt) > MAX_OFFSET_MS) return false;
      offset = learnt;
      return true;
    },
    tooFar(err) {
      const learnt = offsetOf(err);
      return learnt !== null && Math.abs(learnt) > MAX_OFFSET_MS;
    },
  };
}

/**
 * Sends a request that carries a time the server checks. If the server says
 * this device's clock is off (by up to MAX_OFFSET_MS), learns the server's
 * and sends it once more; send must take the time afresh (and a fresh nonce).
 */
export async function withServerTime<T>(clock: Clock, send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (err) {
    if (!clock.learn(err)) throw err;
    return send();
  }
}
