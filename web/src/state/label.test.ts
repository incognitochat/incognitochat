import { describe, expect, it } from 'vitest';
import { EMOJI_GROUPS } from '../emoji/data';
import { cleanName, isCode, isEmoji, labelParts, NAME_MAX, shownLabel } from './label';

describe('labelParts', () => {
  it('splits a label into its emoji and its code', () => {
    expect(labelParts('🦊 K3F9')).toEqual({ emoji: '🦊', code: 'K3F9' });
    // Emoji that take a variation selector, and single code points from older blocks.
    expect(labelParts('⭐ 0ABC')).toEqual({ emoji: '⭐', code: '0ABC' });
    expect(labelParts('⚓ ZZZZ')).toEqual({ emoji: '⚓', code: 'ZZZZ' });
    expect(labelParts('❤️ ABCD')).toEqual({ emoji: '❤️', code: 'ABCD' });
    // Everything after the first space is the code, as written.
    expect(labelParts('🦊  K3F9')).toEqual({ emoji: '🦊', code: ' K3F9' });
  });

  it('keeps any other label whole, with no emoji', () => {
    for (const label of ['K3F9', '', ' K3F9', 'AB CD', '🦊', '🦊 ', '🦊K3F9', 'a🦊 K3F9', '🦊x K3F9']) {
      expect(labelParts(label)).toEqual({ emoji: null, code: label });
    }
  });

  it('covers every emoji labels are made with', async () => {
    // The list is private to messaging/secret.ts: read it from the source, so a new emoji there can't slip past.
    const source = await import('../messaging/secret.ts?raw');
    const list = /const EMOJI = \[([^\]]+)\]/.exec(source.default)![1]!;
    const emoji = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(emoji).toHaveLength(64);
    for (const e of emoji) expect(labelParts(`${e} K3F9`)).toEqual({ emoji: e, code: 'K3F9' });
  });
});

describe("a chat's own name and picture", () => {
  it('takes every emoji the picker offers as a picture, keycaps and flags too', () => {
    const all = EMOJI_GROUPS.flatMap((g) => g.emoji.split(' '));
    expect(all.length).toBeGreaterThan(1000);
    const unparsed = all.filter((e) => labelParts(`${e} Alex`).emoji !== e);
    expect(unparsed).toEqual([]);
    for (const e of ['1️⃣', '#️⃣', '🇨🇦', '👍🏽', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '👩‍❤️‍👨']) expect(isEmoji(e), e).toBe(true);
    for (const s of ['A', 'AB', '🦊🦊', '🦊 ', '', '1', '🇨']) expect(isEmoji(s), s).toBe(false);
  });

  it('shows the name and picture given, the label standing in for either', () => {
    expect(shownLabel('🦊 K3F9')).toBe('🦊 K3F9');
    expect(shownLabel('🦊 K3F9', {})).toBe('🦊 K3F9');
    expect(shownLabel('🦊 K3F9', { name: 'Alex' })).toBe('🦊 Alex');
    expect(shownLabel('🦊 K3F9', { emoji: '🌻' })).toBe('🌻 K3F9');
    expect(shownLabel('🦊 K3F9', { name: 'Big Alex', emoji: '🇨🇦' })).toBe('🇨🇦 Big Alex');
    // A picture that isn't one emoji is left out; a name that cleans to nothing too.
    expect(shownLabel('🦊 K3F9', { emoji: 'x' })).toBe('🦊 K3F9');
    expect(shownLabel('🦊 K3F9', { name: '\u202e\n ' })).toBe('🦊 K3F9');
    // Read back as a picture and a name.
    expect(labelParts(shownLabel('🦊 K3F9', { name: 'علی رضا', emoji: '1️⃣' }))).toEqual({ emoji: '1️⃣', code: 'علی رضا' });
  });

  it('cleans a typed name: no control or direction characters, one space, trimmed, capped', () => {
    expect(cleanName('  Alex  ')).toBe('Alex');
    expect(cleanName('A\n\tB')).toBe('A B');
    expect(cleanName('\u202eevil\u202c name\u2066')).toBe('evil name');
    expect(cleanName('\u200fعلی')).toBe('علی');
    expect(cleanName('')).toBe('');
    const long = 'x'.repeat(NAME_MAX + 10);
    expect(cleanName(long)).toHaveLength(NAME_MAX);
    // Counted in characters, not code units: an emoji is one.
    expect(Array.from(cleanName('😀'.repeat(NAME_MAX + 1)))).toHaveLength(NAME_MAX);
  });

  it("tells a label's code from a name", () => {
    expect(isCode('K3F9')).toBe(true);
    expect(isCode('0ABZ')).toBe(true);
    for (const s of ['Alex', 'k3f9', 'K3F', 'K3F9X', 'KIL0', 'علی']) expect(isCode(s), s).toBe(false);
  });
});
