// A chat's label, as messaging/secret.ts makes it ("🦊 K3F9": one of 64
// emoji, a space, four characters), in its two parts: the emoji, shown as the
// chat's picture, and the code beside it.

/** An emoji, maybe with variation selectors or joined to others. */
const EMOJI = /^\p{Extended_Pictographic}(?:\u{FE0F}|\u{200D}\p{Extended_Pictographic})*$/u;

/** The label's emoji and code; a label of another shape is all code, with no emoji. */
export function labelParts(label: string): { emoji: string | null; code: string } {
  const space = label.indexOf(' ');
  const emoji = space > 0 ? label.slice(0, space) : '';
  const code = label.slice(space + 1);
  if (!EMOJI.test(emoji) || code.trim() === '') return { emoji: null, code: label };
  return { emoji, code };
}
