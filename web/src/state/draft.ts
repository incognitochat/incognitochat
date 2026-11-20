// The message box while one of our messages is edited in it: what was typed
// there before (the draft) is put aside, and comes back when the edit ends,
// as in Telegram.

import type { Caret } from '../emoji/edit';

/** What the message box holds: its text, and where the cursor is. */
export interface Box {
  text: string;
  caret: Caret;
}

/**
 * The message box as an edit starts, moves to another message, or ends
 * (`editing` is the text to edit, or null). Starting one puts the box aside
 * (`kept`) and shows the message's text, with the cursor at its end; moving
 * to another keeps what was put aside. Ending one, saved or cancelled, puts
 * back what was put aside, with its cursor: the edit's text never takes its
 * place. With no edit before or after, the box stays as it is.
 */
export function switchEdit(box: Box, kept: Box | null, editing: string | null): { box: Box; kept: Box | null } {
  if (editing !== null) return { box: { text: editing, caret: { start: editing.length, end: editing.length } }, kept: kept ?? box };
  return { box: kept ?? box, kept: null };
}
