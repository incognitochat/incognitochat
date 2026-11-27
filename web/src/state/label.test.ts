import { describe, expect, it } from 'vitest';
import { EMOJI_GROUPS } from '../emoji/data';
import { cleanName, firstCharacters, fitComposed, insertInto, isCode, isEmoji, labelParts, NAME_MAX, shownLabel } from './label';

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
    // Counted in characters as people count them: an emoji, a flag, a joined emoji is one, never split.
    expect(Array.from(cleanName('😀'.repeat(NAME_MAX + 1)))).toHaveLength(NAME_MAX);
    expect(cleanName('🇨🇦'.repeat(NAME_MAX + 1))).toBe('🇨🇦'.repeat(NAME_MAX));
    expect(cleanName('a' + '👩‍❤️‍👨'.repeat(NAME_MAX))).toBe('a' + '👩‍❤️‍👨'.repeat(NAME_MAX - 1));
    expect(firstCharacters('ab🇨🇦c', 3)).toBe('ab🇨🇦');
    expect(firstCharacters('ab', 5)).toBe('ab');
  });

  it("tells a label's code from a name", () => {
    expect(isCode('K3F9')).toBe(true);
    expect(isCode('0ABZ')).toBe(true);
    for (const s of ['Alex', 'k3f9', 'K3F', 'K3F9X', 'KIL0', 'علی']) expect(isCode(s), s).toBe(false);
  });
});

describe('typing into a name, at most NAME_MAX characters', () => {
  const full = 'x'.repeat(NAME_MAX);
  it('takes what fits where it goes, and keeps the rest of the name whole', () => {
    expect(insertInto('Alex', 4, 4, ' B')).toEqual({ value: 'Alex B', caret: 6 });
    // At the cap: nothing goes in, the caret stays.
    expect(insertInto(full, 5, 5, 'Q')).toEqual({ value: full, caret: 5 });
    // A paste in the middle: as much as fits, the end of the name kept.
    const name = 'a'.repeat(NAME_MAX - 3);
    expect(insertInto(name, 0, 0, '12345678')).toEqual({ value: '123' + name, caret: 3 });
    // Over a selection: it makes room.
    expect(insertInto(full, 0, 3, 'abc')).toEqual({ value: 'abc' + full.slice(3), caret: 3 });
    expect(insertInto(full, 0, 3, 'abcd')).toEqual({ value: 'abc' + full.slice(3), caret: 3 });
    // Flags and joined emoji: whole or not at all.
    expect(insertInto('x'.repeat(NAME_MAX - 1), NAME_MAX - 1, NAME_MAX - 1, '🇨🇦🇨🇦').value).toBe('x'.repeat(NAME_MAX - 1) + '🇨🇦');
  });
});

describe('a word a keyboard put together, at most NAME_MAX characters', () => {
  const count = (s: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].length;
  // The word goes in at `at` (characters) of `name`; what's left of it, and the rest of the name.
  const compose = (name: string, at: number, word: string) => {
    const chars = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name)].map((s) => s.segment);
    return fitComposed(name, [...chars.slice(0, at), word, ...chars.slice(at)].join(''));
  };
  it('keeps the rest of the name whole, and only what fits of the word, where it went in', () => {
    const name = 'ABCDEFGHIJ' + 'abcdefghijklmnopqrst';
    const r = compose(name, 10, 'hello');
    expect(r.value).toBe('ABCDEFGHIJhe' + 'abcdefghijklmnopqrst');
    expect(r.caret).toBe(12);
  });
  it('never takes an emoji, a rare character or a letter with its marks for part of the word', () => {
    // An emoji next to one sharing its first UTF-16 half.
    const full = '😊'.repeat(NAME_MAX);
    expect(compose(full, 10, '🙏').value).toBe(full);
    const e31 = '😀'.repeat(31);
    const r = compose(e31, 5, '🙏🙌');
    expect(r.value).toBe('😀'.repeat(5) + '🙏' + '😀'.repeat(26));
    expect(r.caret).toBe('😀'.repeat(5).length + '🙏'.length);
    const k31 = '𠮷'.repeat(31);
    expect(compose(k31, 3, '𠮷𠮷').value).toBe('𠮷'.repeat(32));
    // Hindi, Thai, a skin tone: the letter after the word keeps its marks.
    const hi = 'x'.repeat(29) + 'कि' + 'x';
    expect(compose(hi, 29, 'कम').value).toBe('x'.repeat(29) + 'क' + 'कि' + 'x');
    const th = 'x'.repeat(29) + 'กี่' + 'x';
    expect(compose(th, 29, 'กา').value).toBe('x'.repeat(29) + 'ก' + 'กี่' + 'x');
    const tone = 'x'.repeat(30) + '👍🏽';
    expect(compose(tone, 30, '👍👏').value).toBe('x'.repeat(30) + '👍' + '👍🏽');
    for (const v of [hi, th, tone]) expect(count(v)).toBeLessThanOrEqual(NAME_MAX);
  });
  it('over a selection, with a word that replaces text, and with no start seen', () => {
    // Autocorrect replacing a shorter word with a longer one, at the cap.
    const name = 'teh ' + 'y'.repeat(NAME_MAX - 4);
    // ("t" is shared; of "hereafter" only "he" fits beside the rest.)
    expect(fitComposed(name, 'thereafter ' + 'y'.repeat(NAME_MAX - 4)).value).toBe('the ' + 'y'.repeat(NAME_MAX - 4));
    // No start seen: the whole field counts as the word; the first NAME_MAX characters stay.
    const long = 'z'.repeat(NAME_MAX + 5);
    expect(fitComposed('', long)).toEqual({ value: 'z'.repeat(NAME_MAX), caret: NAME_MAX });
  });
});
