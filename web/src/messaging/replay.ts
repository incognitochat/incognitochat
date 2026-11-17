// What a conversation remembers so that envelopes coming again, or late,
// undo nothing (docs/protocol.md, "Replays and order"). The inbox gives
// envelopes in no set order, a stale read or another copy of the app can
// give one already taken in, and a server can keep any envelope and deliver
// it again until it is too old to be taken in (MAX_AGE). So:
//
//   - every envelope taken in is remembered (applied) until it is too old;
//   - their messages deleted here are remembered (gone) until they're too old;
//   - a whole conversation cleared up to a time (clearedBefore) drops
//     anything of theirs sent by then;
//   - only the newest envelope (newest) says which key and mailbox they use.
//
// Remembered IDs are keyed hashes (idTag), grouped by day: no IDs and no
// exact times. All of it is content-free and bounded.

import type { ConversationRecord, IdDays } from '../storage/db';

export const DAY = 24 * 3600 * 1000;
/** Envelopes sent longer ago than this (by their `at`), or later than now plus a day, are dropped (design §10). */
export const MAX_AGE = 31 * DAY;
/**
 * The most envelopes a conversation remembers having taken in. Past it the
 * oldest go: one of those coming again is still harmless, since taking in
 * each kind twice changes nothing (a stored message is found, a deleted one
 * is in `gone`, edits and reactions keep the newest, receipts only mark).
 */
export const MAX_APPLIED = 2000;
/** The most deleted messages of theirs a conversation remembers (each delete names at most 100). */
export const MAX_GONE = 1000;

/** The UTC day a time falls on. */
export function dayOf(at: number): number {
  return Math.floor(at / DAY);
}

/**
 * Whether something from this day could still be taken in at `t`: an
 * envelope whose `at` is on that day is dropped once `t` is more than
 * MAX_AGE after it, so once `t` is more than MAX_AGE after the day ends,
 * none from it can come.
 */
function current(day: number, t: number): boolean {
  return t <= (day + 1) * DAY + MAX_AGE;
}

export function remembers(days: IdDays | undefined, tag: string): boolean {
  return !!days?.some((d) => d.tags.includes(tag));
}

/**
 * Adds a tag under the day of `at` (when it can be forgotten). Past `cap`,
 * the oldest days' tags go first.
 */
export function remember(days: IdDays | undefined, tag: string, at: number, cap: number): IdDays {
  const day = dayOf(at);
  const out = (days ?? []).map((d) => ({ day: d.day, tags: [...d.tags] }));
  let bucket = out.find((d) => d.day === day);
  if (!bucket) {
    bucket = { day, tags: [] };
    out.push(bucket);
    out.sort((a, b) => a.day - b.day);
  }
  if (!bucket.tags.includes(tag)) bucket.tags.push(tag);
  let total = out.reduce((n, d) => n + d.tags.length, 0);
  while (total > cap) {
    out[0]!.tags.shift();
    total--;
    if (out[0]!.tags.length === 0) out.shift();
  }
  return out;
}

/** The days something could still come from at `t`; undefined if none. */
function forgetOld(days: IdDays | undefined, t: number): IdDays | undefined {
  const kept = days?.filter((d) => current(d.day, t));
  return kept && kept.length > 0 ? kept : undefined;
}

/**
 * The conversation without what can no longer matter at `t`: remembered
 * tags from days nothing can still come from, a clearedBefore so old that
 * nothing sent by then can still be taken in, and edits and reactions kept
 * for messages that, being older still, can no longer come. The same object
 * if nothing changed.
 */
export function tidy(c: ConversationRecord, t: number): ConversationRecord {
  const since = t - MAX_AGE;
  const applied = forgetOld(c.applied, t);
  const gone = forgetOld(c.gone, t);
  const cleared = c.clearedBefore !== undefined && c.clearedBefore < since;
  const edits = c.edits?.filter((e) => e.at >= since);
  const reactions = c.reactions?.filter((r) => r.at >= since);
  const same = (a: unknown[] | undefined, b: unknown[] | undefined) => (a?.length ?? 0) === (b?.length ?? 0);
  if (same(applied, c.applied) && same(gone, c.gone) && !cleared && same(edits, c.edits) && same(reactions, c.reactions)) return c;
  const { applied: _a, gone: _g, clearedBefore, edits: _e, reactions: _r, ...rest } = c;
  return {
    ...rest,
    ...(applied ? { applied } : {}),
    ...(gone ? { gone } : {}),
    ...(clearedBefore !== undefined && !cleared ? { clearedBefore } : {}),
    ...(edits?.length ? { edits } : {}),
    ...(reactions?.length ? { reactions } : {}),
  };
}

/**
 * Whether an envelope (its `at` and tag) is newer than the newest taken in:
 * by `at`, their clock, and on the same millisecond by tag, so every copy of
 * the app picks the same one whatever order they come in.
 */
export function isNewer(at: number, tag: string, newest: ConversationRecord['newest']): boolean {
  return !newest || at > newest.at || (at === newest.at && tag > newest.tag);
}
