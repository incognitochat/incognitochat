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

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The first `max` characters of a text (a joined emoji or a flag is one, and is never split). */
export function firstCharacters(text: string, max: number): string {
  let out = '';
  let n = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (n++ === max) break;
    out += segment;
  }
  return out;
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
