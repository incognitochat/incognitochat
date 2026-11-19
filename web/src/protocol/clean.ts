// Cleaning names the other side chose (an attachment's file name) before
// they're shown, shared or saved. Done there, never when a message is taken
// in: a message refused then is acked and lost (docs/protocol.md, Media).
//
// What goes: characters that change how the text around them is laid out
// or shown without being seen themselves. Bidi controls can make
// "photo<U+202E>gpj.exe" read as "photoexe.jpg"; control characters and the
// byte-order mark show as nothing or as boxes. Line breaks and tabs become
// a space, as a name is one line. ZWNJ and ZWJ (U+200C, U+200D) stay:
// Persian words and emoji sequences need them. So do the emoji's own
// marks: variation selectors, skin tones, keycaps and flag tags.

/** The longest name, in UTF-16 units, as in a message. */
export const MAX_NAME = 255;

/** Line breaks and tabs: a space in a name. */
const BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
/**
 * C0 and C1 control characters; bidi marks, embeddings, overrides and
 * isolates (U+200E/F, U+202A–202E, U+2066–2069) and the Arabic letter mark
 * (U+061C); the byte-order mark (U+FEFF).
 */
const HIDDEN = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** A name of one line, as it's shown: line breaks and tabs are spaces, and what's hidden is gone. */
export function cleanLine(text: string): string {
  return text.replace(BREAKS, ' ').replace(HIDDEN, '');
}

/**
 * A file name, cleaned for showing and saving: one line (cleanLine), with
 * no folders ("/" and "\" are "_"), at most MAX_NAME long. Empty if nothing
 * but spaces is left, so the caller uses a name of its own.
 */
export function cleanFileName(name: string): string {
  let clean = cleanLine(name).replace(/[/\\]/g, '_');
  if (clean.length > MAX_NAME) {
    clean = clean.slice(0, MAX_NAME);
    // Not half an emoji or other character outside the BMP.
    if (/[\uD800-\uDBFF]$/.test(clean)) clean = clean.slice(0, -1);
  }
  return clean.trim() === '' ? '' : clean;
}
