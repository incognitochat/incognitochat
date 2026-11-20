import { describe, expect, it, vi } from 'vitest';
import { focusDialog, keepFocusIn, pressWithoutFocus, trapTab, wrapTab } from './focus';

// No DOM here: just enough of the elements and document these use.
const doc = { activeElement: null as unknown };

type Options = { tabIndex?: number; shown?: boolean; insideHidden?: boolean; textField?: boolean; nearestFocusable?: unknown };

function element(name: string, options: Options = {}) {
  const el = {
    name,
    tabIndex: options.tabIndex ?? 0,
    isConnected: true,
    focus: vi.fn(() => (doc.activeElement = el)),
    blur: vi.fn(() => (doc.activeElement = null)),
    getClientRects: () => (options.shown === false ? [] : [{}]),
    // tabbables() asks whether it's inside something hidden; pressWithoutFocus() what takes focus for it.
    closest: (selector: string) => (selector.includes('[inert]') ? (options.insideHidden ? {} : null) : (options.nearestFocusable ?? el)),
    matches: () => options.textField ?? false,
  };
  return el;
}

function dialog(items: ReturnType<typeof element>[]) {
  const d = {
    ...element('dialog', { tabIndex: -1 }),
    querySelectorAll: () => items,
    contains: (other: unknown) => other === d || items.includes(other as ReturnType<typeof element>),
  };
  d.focus = vi.fn(() => (doc.activeElement = d));
  return d;
}

const tab = (shiftKey = false) => ({ key: 'Tab', shiftKey, preventDefault: vi.fn() });
const asElement = (x: unknown) => x as HTMLElement;
const asDoc = doc as unknown as Document;
const asMouse = (e: object) => e as unknown as MouseEvent;

describe('wrapTab', () => {
  const items = ['a', 'b', 'c'];
  it('wraps past the last and before the first', () => {
    expect(wrapTab(items, 'c', false)).toBe('a');
    expect(wrapTab(items, 'a', true)).toBe('c');
  });
  it('goes from the dialog itself to the first, or back to the last', () => {
    expect(wrapTab(items, 'dialog', false)).toBe('a');
    expect(wrapTab(items, 'dialog', true)).toBe('c');
  });
  it("leaves moves that stay inside to the browser", () => {
    expect(wrapTab(items, 'a', false)).toBeNull();
    expect(wrapTab(items, 'b', true)).toBeNull();
    expect(wrapTab([], 'dialog', false)).toBeNull();
  });
});

describe('trapTab', () => {
  const first = element('first');
  const hidden = element('hidden', { shown: false });
  const skipped = element('skipped', { tabIndex: -1 });
  const behindHidden = element('behind', { insideHidden: true });
  const last = element('last');
  const d = dialog([first, hidden, skipped, behindHidden, last]);

  it('keeps Tab inside the dialog, past what is hidden or out of the tab order', () => {
    doc.activeElement = last;
    const forward = tab();
    trapTab(forward, asElement(d), asDoc);
    expect(forward.preventDefault).toHaveBeenCalled();
    expect(doc.activeElement).toBe(first);

    const back = tab(true);
    trapTab(back, asElement(d), asDoc);
    expect(back.preventDefault).toHaveBeenCalled();
    expect(doc.activeElement).toBe(last);
  });

  it('lets Tab move from the dialog to its first control, and between controls', () => {
    doc.activeElement = d;
    trapTab(tab(), asElement(d), asDoc);
    expect(doc.activeElement).toBe(first);
    const between = tab();
    trapTab(between, asElement(d), asDoc);
    expect(between.preventDefault).not.toHaveBeenCalled();
  });

  it('keeps focus on a dialog with nothing to Tab to, and ignores other keys', () => {
    const empty = dialog([]);
    doc.activeElement = empty;
    const e = tab();
    trapTab(e, asElement(empty), asDoc);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(doc.activeElement).toBe(empty);
    const other = { key: 'a', shiftKey: false, preventDefault: vi.fn() };
    trapTab(other, asElement(d), asDoc);
    expect(other.preventDefault).not.toHaveBeenCalled();
  });
});

describe('focusDialog', () => {
  it('focuses the dialog, then gives the focus back to what had it', () => {
    const opener = element('opener');
    const d = dialog([element('inside')]);
    doc.activeElement = opener;
    const restore = focusDialog(asElement(d), asDoc);
    expect(d.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(doc.activeElement).toBe(d);
    restore();
    expect(opener.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(doc.activeElement).toBe(opener);
  });

  it("doesn't give it back to a text field (a phone's keyboard would come up), or to what's gone", () => {
    for (const opener of [element('message box', { textField: true }), { ...element('gone'), isConnected: false }]) {
      doc.activeElement = opener;
      const d = dialog([]);
      const restore = focusDialog(asElement(d), asDoc);
      restore();
      expect(opener.focus).not.toHaveBeenCalled();
      expect(doc.activeElement).toBe(d);
    }
    doc.activeElement = null;
    expect(() => focusDialog(asElement(dialog([])), asDoc)()).not.toThrow();
  });
});

describe('keepFocusIn', () => {
  it('brings focus back to the dialog when what had it is gone', () => {
    const inside = element('inside');
    const d = dialog([inside]);
    doc.activeElement = inside;
    keepFocusIn(asElement(d), asDoc);
    expect(d.focus).not.toHaveBeenCalled();
    doc.activeElement = null;
    keepFocusIn(asElement(d), asDoc);
    expect(d.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});

describe('pressWithoutFocus', () => {
  it("doesn't focus a row on a press, and takes focus from what had it", () => {
    const row = element('row');
    const box = element('message box', { textField: true });
    doc.activeElement = box;
    const press = { target: element('bubble', { nearestFocusable: row }), currentTarget: row, preventDefault: vi.fn() };
    pressWithoutFocus(asMouse(press), asDoc);
    expect(press.preventDefault).toHaveBeenCalled();
    expect(box.blur).toHaveBeenCalled();
    expect(row.focus).not.toHaveBeenCalled();
  });

  it("leaves a press on the row's own buttons to the browser, and a focused row focused", () => {
    const row = element('row');
    const play = element('play');
    const onButton = { target: element('icon', { nearestFocusable: play }), currentTarget: row, preventDefault: vi.fn() };
    pressWithoutFocus(asMouse(onButton), asDoc);
    expect(onButton.preventDefault).not.toHaveBeenCalled();

    doc.activeElement = row;
    const again = { target: row, currentTarget: row, preventDefault: vi.fn() };
    pressWithoutFocus(asMouse(again), asDoc);
    expect(again.preventDefault).toHaveBeenCalled();
    expect(row.blur).not.toHaveBeenCalled();
  });
});
