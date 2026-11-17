import { describe, expect, it } from 'vitest';
import type { ConversationRecord, IdDays } from '../storage/db';
import { DAY, forgetOld, isNewer, MAX_AGE, remember, remembers, tidy } from './replay';

const base: ConversationRecord = {
  id: 'c',
  wire: 'w',
  role: 'owner',
  link: { id: 'l', fingerprint: 'f' },
  label: 'x',
  peerKey: 'p',
  myKey: null,
  sendTo: 's',
  myMailbox: null,
  lastAt: 0,
  unread: 0,
  status: 'active',
  lastReceived: null,
};

describe('what a conversation remembers against repeats', () => {
  it('orders envelopes by their time, and the same millisecond by tag, the same way whatever comes first', () => {
    expect(isNewer(5, 'a', undefined)).toBe(true);
    expect(isNewer(6, 'a', { at: 5, tag: 'z' })).toBe(true);
    expect(isNewer(4, 'z', { at: 5, tag: 'a' })).toBe(false);
    expect(isNewer(5, 'b', { at: 5, tag: 'a' })).toBe(true);
    expect(isNewer(5, 'a', { at: 5, tag: 'b' })).toBe(false);
    // The same envelope again is never newer than itself.
    expect(isNewer(5, 'a', { at: 5, tag: 'a' })).toBe(false);
  });

  it('keeps each tag once, by day, and lets the oldest day go first past the cap, saying which', () => {
    let days: IdDays | undefined;
    for (const [tag, at] of [['x', 2 * DAY + 5], ['x', 2 * DAY + 9], ['y', 1 * DAY], ['z', 3 * DAY]] as const) {
      const r = remember(days, tag, at, 3);
      expect(r.lost).toBeUndefined();
      days = r.days;
    }
    expect(days).toEqual([
      { day: 1, tags: ['y'] },
      { day: 2, tags: ['x'] },
      { day: 3, tags: ['z'] },
    ]);
    // Once known, the same array: nothing to write.
    expect(remember(days, 'x', 2 * DAY, 3).days).toBe(days);
    // Full: a newer one pushes out the oldest day's, and says that day isn't covered any more.
    const pushed = remember(days, 'w', 3 * DAY, 3);
    expect(pushed).toEqual({ days: [{ day: 2, tags: ['x'] }, { day: 3, tags: ['z', 'w'] }], lost: 1 });
    expect(remembers(pushed.days, 'y')).toBe(false);
    // Full, and the new one is from the oldest day (or older): it's the one left out.
    expect(remember(pushed.days, 'v', 2 * DAY, 3)).toEqual({ days: pushed.days, lost: 2 });
    expect(remember(pushed.days, 'u', 0, 3)).toEqual({ days: pushed.days, lost: 0 });
  });

  it('forgets a day only once nothing from it can be taken in, and a clear once nothing that old can', () => {
    const days = remember(undefined, 'x', 10 * DAY + 1, 10).days;
    expect(forgetOld(days, 11 * DAY + MAX_AGE)).toBe(days);
    expect(forgetOld(days, 11 * DAY + MAX_AGE + 1)).toBeUndefined();
    const c: ConversationRecord = { ...base, clearedBefore: 10 * DAY + 1, theirClear: { upTo: 10 * DAY + 1, here: 10 * DAY + 5 }, droppedBefore: 10 * DAY + 1 };
    // Something sent at the clear is still taken in until MAX_AGE after it.
    expect(tidy(c, 10 * DAY + 1 + MAX_AGE)).toBe(c);
    const later = tidy(c, 10 * DAY + 2 + MAX_AGE);
    expect([later.clearedBefore, later.theirClear, later.droppedBefore]).toEqual([undefined, undefined, undefined]);
  });
});
