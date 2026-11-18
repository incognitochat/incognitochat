// What a conversation remembers so that envelopes coming again, or late,
// undo nothing (docs/protocol.md, "Replays and order"). The inbox gives
// envelopes in no set order, a stale read or another copy of the app can
// give one already taken in, and a server can keep any envelope and deliver
// it again until it is too old to be taken in (MAX_AGE). So:
//
//   - every envelope taken in is remembered (applied) until it is too old;
//   - messages deleted one by one are remembered until they're too old:
//     theirs they deleted (gone), theirs the user deleted here (dropped),
//     and the user's own deleted here (mine), each with a budget of its
//     own, so the other side can't push the user's deletes out;
//   - a conversation cleared up to a time on their clock (clearedBefore: by
//     their delete of the whole conversation, or ours for both sides) drops
//     anything of theirs sent by then;
//   - only the newest envelope (newest) says which key and mailbox they use.
//
// Remembered IDs are keyed hashes (idTag), grouped by day: no IDs and no
// exact times. They're kept in `meta`, a record per conversation and kind
// (messaging/store.ts), not on the conversation record. All of it is
// content-free and bounded.

import type { ConversationRecord, IdDays } from '../storage/db';

export const DAY = 24 * 3600 * 1000;
/** Envelopes sent longer ago than this (by their `at`), or later than now plus a day, are dropped (design §10). */
export const MAX_AGE = 31 * DAY;
/**
 * The most envelopes a conversation remembers having taken in. Past it the
 * oldest go: one of those coming again is still harmless, since taking in
 * each kind twice changes nothing (a stored message is found, a deleted one
 * is in `gone` or `dropped`, edits and reactions keep the newest, receipts
 * only mark).
 */
export const MAX_APPLIED = 2000;
/** The most of their messages they deleted that a conversation remembers (each delete names at most 100). */
export const MAX_GONE = 1000;
/**
 * The most messages the user deleted here that a conversation remembers.
 * Past it (MAX_DROPPED in 31 days), the oldest go, and their messages up to
 * the end of that day are dropped instead (droppedBefore).
 */
export const MAX_DROPPED = 5000;
/**
 * The most of the user's own messages deleted here that a conversation
 * remembers, so their edits and reactions naming one aren't kept for later.
 * Past it the oldest go, and such a reaction may wait (31 days at most).
 */
export const MAX_MINE = 1000;

/** The UTC day a time falls on. */
export function dayOf(at: number): number {
  return Math.floor(at / DAY);
}

/** The last millisecond of a UTC day. */
export function endOf(day: number): number {
  return (day + 1) * DAY - 1;
}

/**
 * Whether something from this day could still be taken in at `t`: an
 * envelope whose `at` is on that day is dropped once `t` is more than
 * MAX_AGE after it, so once `t` is more than MAX_AGE after the day ends,
 * none from it can come.
 */
export function couldCome(day: number, t: number): boolean {
  return t <= (day + 1) * DAY + MAX_AGE;
}

export function remembers(days: IdDays | undefined, tag: string): boolean {
  return !!days?.some((d) => d.tags.includes(tag));
}

/**
 * Adds a tag under the day of `at` (when it can be forgotten). At `cap`, the
 * oldest day's tags go first; if the new tag's day is that oldest day (or
 * older), it's the one left out. `lost` is the latest day a tag was left out
 * or let go from, if any: what's remembered no longer covers that day fully.
 */
export function remember(days: IdDays | undefined, tag: string, at: number, cap: number): { days: IdDays; lost?: number } {
  const day = dayOf(at);
  if (days && remembers(days, tag)) return { days };
  const out = (days ?? []).map((d) => ({ day: d.day, tags: [...d.tags] }));
  let lost: number | undefined;
  let total = out.reduce((n, d) => n + d.tags.length, 0);
  if (total >= cap) {
    if (out.length === 0 || day <= out[0]!.day) return { days: out, lost: day };
    while (total >= cap) {
      out[0]!.tags.shift();
      total--;
      lost = Math.max(lost ?? -Infinity, out[0]!.day);
      if (out[0]!.tags.length === 0) out.shift();
    }
  }
  let bucket = out.find((d) => d.day === day);
  if (!bucket) {
    bucket = { day, tags: [] };
    out.push(bucket);
    out.sort((a, b) => a.day - b.day);
  }
  bucket.tags.push(tag);
  return lost === undefined ? { days: out } : { days: out, lost };
}

/** The days something could still come from at `t`, undefined if none; the same array if nothing went. */
export function forgetOld(days: IdDays | undefined, t: number): IdDays | undefined {
  if (!days) return undefined;
  const kept = days.filter((d) => couldCome(d.day, t));
  if (kept.length === days.length) return days;
  return kept.length > 0 ? kept : undefined;
}

/**
 * The conversation without what can no longer matter at `t`: times it's
 * cleared up to that are so old that nothing sent by then can still be
 * taken in, and edits and reactions kept for messages that, being older
 * still, can no longer come. The same object if nothing changed.
 */
export function tidy(c: ConversationRecord, t: number): ConversationRecord {
  const since = t - MAX_AGE;
  const old = (at: number | undefined) => at !== undefined && at < since;
  const edits = c.edits?.filter((e) => e.at >= since);
  const reactions = c.reactions?.filter((r) => r.at >= since);
  const same = (a: unknown[] | undefined, b: unknown[] | undefined) => (a?.length ?? 0) === (b?.length ?? 0);
  if (!old(c.clearedBefore) && !old(c.theirClear?.upTo) && !old(c.droppedBefore) && same(edits, c.edits) && same(reactions, c.reactions)) return c;
  const { clearedBefore, theirClear, droppedBefore, edits: _e, reactions: _r, ...rest } = c;
  return {
    ...rest,
    ...(clearedBefore !== undefined && !old(clearedBefore) ? { clearedBefore } : {}),
    ...(theirClear && !old(theirClear.upTo) ? { theirClear } : {}),
    ...(droppedBefore !== undefined && !old(droppedBefore) ? { droppedBefore } : {}),
    ...(edits?.length ? { edits } : {}),
    ...(reactions?.length ? { reactions } : {}),
  };
}

/**
 * Whether an envelope (its `at` and tag) is newer than the newest taken in:
 * by `at`, their clock, and in the same second (times are whole seconds) by
 * being taken in after it. The same envelope again is never newer.
 */
export function isNewer(at: number, tag: string, newest: ConversationRecord['newest']): boolean {
  return !newest || at > newest.at || (at === newest.at && tag !== newest.tag);
}
