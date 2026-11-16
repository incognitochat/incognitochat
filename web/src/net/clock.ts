// The server's clock, as this device knows it. The times the server checks
// (logins, signed requests, a new account's device list) are taken from here,
// so a device whose own clock is off still works: the server answers such a
// time with clock_skew and its own clock, the app learns how far apart the two
// are and asks again, once. Kept in memory only: each launch learns it anew
// the first time it's needed.

import { ApiError } from './api';

export interface Clock {
  /** The server's time now, in Unix milliseconds, as near as this device knows it. */
  now(): number;
  /** The server's time now, in whole Unix seconds. */
  seconds(): number;
  /** How far the server's clock is ahead of this device's, in milliseconds. */
  offset(): number;
  /**
   * Learns the server's clock from a clock_skew answer. Returns whether err
   * was one, so asking again with this clock's time will do.
   */
  learn(err: unknown): boolean;
}

/** A clock that starts out as the device's own (local: Unix milliseconds). */
export function createClock(local: () => number = () => Date.now()): Clock {
  let offset = 0;
  const now = () => local() + offset;
  return {
    now,
    seconds: () => Math.floor(now() / 1000),
    offset: () => offset,
    learn(err) {
      if (!(err instanceof ApiError && err.code === 'clock_skew' && err.serverTime !== undefined)) return false;
      // The server says whole seconds: take the middle of that second.
      offset = err.serverTime * 1000 + 500 - local();
      return true;
    },
  };
}

/**
 * Sends a request that carries a time the server checks. If the server says
 * this device's clock is off, learns the server's and sends it once more;
 * send must take the time afresh (and a fresh nonce).
 */
export async function withServerTime<T>(clock: Clock, send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (err) {
    if (!clock.learn(err)) throw err;
    return send();
  }
}
