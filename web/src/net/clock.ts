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
//
// Messages are dated by the server's clock too (messageNow, rounded down to
// the second by stamper), so that they don't carry how far this device's own
// clock is off: that lasts for days and is the same in all of its
// conversations, so recipients who compare could link them (docs/security.md).
// Each session token tells the server's clock to about a second: it expires
// TOKEN_TTL_MS after the server issued it, in whole seconds. Believed only
// within MAX_SKEW_MS of the device's own clock, as far as a login's time may
// be off.

import { ApiError } from './api';

/** The furthest the server's clock is believed to be from this device's: two days. */
export const MAX_OFFSET_MS = 48 * 3600_000;
/**
 * How long a session token lasts (the server's session.TTL, which
 * TestExpiryTellsTheWebAppTheServerClock pins): it expires this long after
 * the server issued it.
 */
export const TOKEN_TTL_MS = 15 * 60_000;
/**
 * How far a login's time may be from the server's clock (the server's
 * session.MaxSkew), and so how far a session token may move the clock
 * messages are dated by from this device's own.
 */
export const MAX_SKEW_MS = 60_000;

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
  /**
   * Sends a login or a registration, and learns from the session token it
   * gets how far the server's clock is from this device's, for messageNow:
   * the server issued it TOKEN_TTL_MS before it expires (in whole seconds,
   * rounded down), while the request was out, so to within half a second
   * plus half the time the request took. Believed only within MAX_SKEW_MS of
   * this device's own clock; further off, messages go back to that.
   */
  timed<T extends { expires: number }>(send: () => Promise<T>): Promise<T>;
  /**
   * The time messages are dated by, in Unix milliseconds: the server's, as
   * the last session token told it, or this device's own until one did.
   */
  messageNow(): number;
}

/** A clock that starts out as the device's own (local: Unix milliseconds). */
export function createClock(local: () => number = () => Date.now()): Clock {
  let offset = 0;
  /** How far ahead the server's clock is, as the last session token told it (ms), for messages: within MAX_SKEW_MS. */
  let tokenOffset = 0;
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
    async timed(send) {
      const sent = local();
      const token = await send();
      const received = local();
      // Issued at some time in [expires - TTL, that + 1 s) by the server's
      // clock, and in [sent, received] by ours: the middle of both.
      const learnt = Math.round(token.expires * 1000 - TOKEN_TTL_MS + 500 - (sent + received) / 2);
      tokenOffset = Math.abs(learnt) <= MAX_SKEW_MS ? learnt : 0;
      return token;
    },
    messageNow: () => local() + tokenOffset,
  };
}

/**
 * The time what this device sends carries (`at`, Unix milliseconds): the
 * time now (from clock, messageNow) rounded down to the whole second, so it
 * says nothing finer about this device's clock. Within a conversation the
 * engine dates each a second after the last at least (store.ts,
 * takeSentAt), and recipients order what came in the same second by when
 * it came (docs/protocol.md, Times).
 */
export function stamper(clock: () => number): () => number {
  return () => Math.floor(clock() / 1000) * 1000;
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
