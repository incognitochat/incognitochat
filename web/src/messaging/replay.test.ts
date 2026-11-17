import { describe, expect, it } from 'vitest';
import type { ConversationRecord } from '../storage/db';
import { DAY, isNewer, MAX_AGE, remember, remembers, tidy } from './replay';

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

  it('keeps each tag once, by day, and lets the oldest go first past the cap', () => {
    let days = remember(undefined, 'x', 2 * DAY + 5, 3);
    days = remember(days, 'x', 2 * DAY + 9, 3);
    days = remember(days, 'y', 1 * DAY, 3);
    days = remember(days, 'z', 3 * DAY, 3);
    expect(days).toEqual([
      { day: 1, tags: ['y'] },
      { day: 2, tags: ['x'] },
      { day: 3, tags: ['z'] },
    ]);
    days = remember(days, 'w', 3 * DAY, 3);
    expect(days.map((d) => d.day)).toEqual([2, 3]);
    expect(remembers(days, 'y')).toBe(false);
    expect(['x', 'z', 'w'].every((t) => remembers(days, t))).toBe(true);
  });

  it('forgets a day only once nothing from it can be taken in, and a clear once nothing that old can', () => {
    const c: ConversationRecord = { ...base, applied: remember(undefined, 'x', 10 * DAY + 1, 10), clearedBefore: 10 * DAY + 1 };
    // Something sent at the clear is still taken in until MAX_AGE after it.
    expect(tidy(c, 10 * DAY + 1 + MAX_AGE)).toBe(c);
    expect(tidy(c, 10 * DAY + 2 + MAX_AGE).clearedBefore).toBeUndefined();
    // An envelope from the end of that day is still taken in until MAX_AGE after it.
    expect(tidy(c, 11 * DAY + MAX_AGE).applied).toEqual(c.applied);
    expect(tidy(c, 11 * DAY + MAX_AGE + 1).applied).toBeUndefined();
  });
});
