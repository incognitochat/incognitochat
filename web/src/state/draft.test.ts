import { describe, expect, it } from 'vitest';
import { switchEdit, type Box } from './draft';

const at = (start: number, end = start) => ({ start, end });

describe('the draft while a message is edited', () => {
  const draft: Box = { text: 'half a reply', caret: at(4, 6) };

  it('is put aside when an edit starts, and the box shows the message with the cursor at its end', () => {
    expect(switchEdit(draft, null, 'old text')).toEqual({ box: { text: 'old text', caret: at(8) }, kept: draft });
  });

  it('comes back with its cursor when the edit is saved (the box was emptied) or cancelled', () => {
    const { kept } = switchEdit(draft, null, 'old text');
    // Saved: sending empties the box first.
    expect(switchEdit({ text: '', caret: at(0) }, kept, null)).toEqual({ box: draft, kept: null });
    // Cancelled: the edit's text, as changed, goes.
    expect(switchEdit({ text: 'old text, fixed', caret: at(15) }, kept, null)).toEqual({ box: draft, kept: null });
  });

  it("is never replaced by the edit's text, also when the edit moves to another message", () => {
    let state = switchEdit(draft, null, 'first');
    state = switchEdit({ text: 'first, changed', caret: at(14) }, state.kept, 'second');
    expect(state).toEqual({ box: { text: 'second', caret: at(6) }, kept: draft });
    expect(switchEdit(state.box, state.kept, null).box).toEqual(draft);
  });

  it('an empty box comes back empty, and with no edit the box stays as it is', () => {
    const empty: Box = { text: '', caret: at(0) };
    const { kept } = switchEdit(empty, null, 'old text');
    expect(switchEdit({ text: 'old', caret: at(3) }, kept, null).box).toEqual(empty);
    expect(switchEdit(draft, null, null)).toEqual({ box: draft, kept: null });
  });
});
