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
  // The word goes in at string offset `at` of `name` (the caret when it began).
  const compose = (name: string, at: number, word: string) => fitComposed(name, at, at, name.slice(0, at) + word + name.slice(at));
  it('keeps the rest of the name exactly, and only what fits of the word, where it went in', () => {
    const name = 'ABCDEFGHIJ' + 'abcdefghijklmnopqrst';
    expect(compose(name, 10, 'hello')).toEqual({ value: 'ABCDEFGHIJhe' + 'abcdefghijklmnopqrst', caret: 12 });
    // A word that starts like what follows it.
    expect(compose('x'.repeat(25) + 'theory', 25, 'the').value).toBe('x'.repeat(25) + 't' + 'theory');
    expect(compose('a'.repeat(26) + 'night', 26, 'no').value).toBe('a'.repeat(26) + 'n' + 'night');
  });
  it('never takes an emoji, a rare character or a letter with its marks apart', () => {
    const full = '😊'.repeat(NAME_MAX);
    expect(compose(full, 20, '🙏')).toEqual({ value: full, caret: 20 });
    const e31 = '😀'.repeat(31);
    expect(compose(e31, 6, '😀😀')).toEqual({ value: '😀'.repeat(32), caret: 8 });
    expect(compose('😀'.repeat(31), 10, '🙏🙌').value).toBe('😀'.repeat(5) + '🙏' + '😀'.repeat(26));
    expect(compose('𠮷'.repeat(31), 6, '𠮷𠮷').value).toBe('𠮷'.repeat(32));
    // A word ending in a virama, with room: it stays, joined to the letter after it, which stays too.
    const hiRoom = 'x'.repeat(16) + 'ष' + 'y'.repeat(13);
    const kept = fitComposed(hiRoom, 16, 16, 'x'.repeat(16) + 'अक्अअ' + 'ष' + 'y'.repeat(13));
    expect(kept.value).toBe('x'.repeat(16) + 'अक्' + 'ष' + 'y'.repeat(13));
    expect(kept.caret).toBe(16 + 'अक्'.length);
    // A word whose last character joins the next one: the next one stays.
    const hi = 'x'.repeat(16) + 'ष' + 'y'.repeat(15);
    const rh = compose(hi, 16, 'अक्');
    expect(rh.value.startsWith('x'.repeat(16))).toBe(true);
    expect(rh.value.endsWith('ष' + 'y'.repeat(15))).toBe(true);
    for (const [name, at, word] of [
      [hi, 16, 'अक्'],
      ['x'.repeat(29) + 'कि' + 'x', 29, 'कम'],
      ['x'.repeat(30) + '👍🏽', 30, '👍👏'],
      ['a'.repeat(30) + '🇫🇷', 30, 'a🇦'],
    ] as const) {
      const r = compose(name, at, word);
      expect(count(r.value), `${word}`).toBeLessThanOrEqual(NAME_MAX);
      expect(r.value.startsWith(name.slice(0, at)) && r.value.endsWith(name.slice(at)), `${word} keeps the name`).toBe(true);
    }
  });
  it('over a selection; a keyboard that changed more than its place; no start seen', () => {
    // Over a selection: the selected text goes, the word takes its room.
    const full = 'x'.repeat(NAME_MAX);
    expect(compose(full, 0, '')).toEqual({ value: full, caret: 0 });
    expect(fitComposed(full, 0, 3, 'abcd' + full.slice(3))).toEqual({ value: 'abc' + full.slice(3), caret: 3 });
    // Autocorrect: the word being typed ("teh", from the start) became "thereafter".
    const rest = ' ' + 'y'.repeat(NAME_MAX - 4);
    expect(fitComposed(rest, 0, 0, 'thereafter' + rest).value).toBe('the' + rest);
    // The keyboard rewrote a word already there (Android: a suggestion picked
    // after "Jon"), past the cap: no room for it, the name as it was.
    const name = 'Jon from the office, 3rd floor!!';
    expect(fitComposed(name, 3, 3, 'John' + name.slice(3))).toEqual({ value: name, caret: 3 });
    expect(fitComposed('abc', 3, 3, 'XYZ' + 'z'.repeat(NAME_MAX))).toEqual({ value: 'abc', caret: 3 });
    // No start seen (before is empty): the first NAME_MAX characters.
    expect(fitComposed('', 0, 0, 'z'.repeat(NAME_MAX + 5))).toEqual({ value: 'z'.repeat(NAME_MAX), caret: NAME_MAX });
  });
});
