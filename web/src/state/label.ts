// A chat's label, as messaging/secret.ts makes it ("🦊 K3F9": one of 64
// emoji, a space, four characters), in its two parts: the emoji, shown as the
// chat's picture, and the code beside it. The user may give a chat their own
// name and picture instead (on this device only): shown the same way, as
// "<emoji> <name>".

import type { ChatName } from '../messaging/store';

/**
 * An emoji: a pictograph (maybe with a skin tone, a variation selector,
 * tag characters as in a subdivision flag, or joined to others), a flag (two
 * regional indicators), or a keycap.
 */
const EMOJI =
  /^(?:\p{Regional_Indicator}{2}|[#*0-9]\u{FE0F}?\u{20E3}|\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\u{FE0F}|[\u{E0020}-\u{E007F}])*(?:\u{200D}\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\u{FE0F})*)*)$/u;

/** The label's emoji and code; a label of another shape is all code, with no emoji. */
export function labelParts(label: string): { emoji: string | null; code: string } {
  const space = label.indexOf(' ');
  const emoji = space > 0 ? label.slice(0, space) : '';
  const code = label.slice(space + 1);
  if (!EMOJI.test(emoji) || code.trim() === '') return { emoji: null, code: label };
  return { emoji, code };
}

/** Whether a string is one emoji, as a chat's picture can be. */
export function isEmoji(s: string): boolean {
  return EMOJI.test(s);
}

/** The user's own name and picture for a chat (each optional: the label's stands in). */
export type ChatCustom = ChatName;

/** The longest name the user may give a chat, in characters (as people count them: a flag is one). */
export const NAME_MAX = 32;

// Made when first needed: a web view without it fails only here (code points then), not as the app loads.
let graphemes: Intl.Segmenter | null | undefined;

/** A text's characters as people count them: a joined emoji or a flag is one. */
function characters(text: string): string[] {
  graphemes ??= typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  return graphemes ? Array.from(graphemes.segment(text), (s) => s.segment) : Array.from(text);
}

/** How many characters a text has, as people count them. */
export function characterCount(text: string): number {
  return characters(text).length;
}

/** The first `max` characters of a text (a joined emoji or a flag is one, and is never split). */
export function firstCharacters(text: string, max: number): string {
  return characters(text).slice(0, max).join('');
}

/**
 * A word a keyboard just put together into a name (`now`), against the name
 * as it was when the word began (`before`): what changed is found character
 * by character (as people count them, so an emoji or a letter with its marks
 * is never split), and only as much of it as fits in `max` characters stays,
 * where it went in; the rest of the name is kept whole. The new name, and
 * where the caret goes (after the word).
 */
export function fitComposed(before: string, now: string, max = NAME_MAX): { value: string; caret: number } {
  const was = characters(before);
  const is = characters(now);
  let start = 0;
  while (start < was.length && start < is.length && was[start] === is[start]) start++;
  let end = is.length;
  let kept = was.length;
  while (end > start && kept > start && was[kept - 1] === is[end - 1]) {
    end--;
    kept--;
  }
  const head = is.slice(0, start);
  const tail = is.slice(end);
  const word = is.slice(start, end).slice(0, Math.max(0, max - head.length - tail.length));
  const all = [...head, ...word, ...tail].slice(0, max);
  return { value: all.join(''), caret: all.slice(0, Math.min(head.length + word.length, all.length)).join('').length };
}

/**
 * Text typed or pasted into a name over start..end: as much of it as fits
 * in `max` characters goes in there (none at the cap), and the rest of the
 * name stays whole. The new name, and where the caret goes (after it).
 */
export function insertInto(name: string, start: number, end: number, text: string, max = NAME_MAX): { value: string; caret: number } {
  const head = name.slice(0, start);
  const tail = name.slice(end);
  const fit = firstCharacters(text, Math.max(0, max - characterCount(head + tail)));
  return { value: head + fit + tail, caret: head.length + fit.length };
}

/**
 * A name as typed, made fit to show: control and direction-changing
 * characters out (a name can't reorder what's around it), spaces joined
 * into one, trimmed, at most NAME_MAX characters. Empty: no name.
 */
export function cleanName(typed: string): string {
  const plain = typed
    .replace(/[\p{Cc}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{061C}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return firstCharacters(plain, NAME_MAX).trim();
}

/** What a chat is shown as: the user's own name and picture where they gave one, else the label's. */
export function shownLabel(label: string, custom?: ChatCustom): string {
  if (!custom?.name && !custom?.emoji) return label;
  const { emoji, code } = labelParts(label);
  const picture = custom.emoji && isEmoji(custom.emoji) ? custom.emoji : emoji;
  const name = custom.name ? cleanName(custom.name) || code : code;
  return picture ? `${picture} ${name}` : name;
}

/** Whether a name is a label's code (four of its letters and digits), shown left to right. */
export function isCode(name: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{4}$/.test(name);
}
