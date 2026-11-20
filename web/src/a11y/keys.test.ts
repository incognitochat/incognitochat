import { describe, expect, it, vi } from 'vitest';
import { isMenuKey, menuKeyDown, menuMove, trackKeyboard } from './keys';

const row = {};
const button = {};

function press(key: string, { target = row, shiftKey = false, ctrlKey = false } = {}) {
  return { key, shiftKey, altKey: false, ctrlKey, metaKey: false, target, currentTarget: row, preventDefault: vi.fn() } as unknown as KeyboardEvent;
}

describe('menu keys', () => {
  it('knows the Menu key and Shift+F10', () => {
    expect(isMenuKey(press('ContextMenu'))).toBe(true);
    expect(isMenuKey(press('F10', { shiftKey: true }))).toBe(true);
    expect(isMenuKey(press('F10'))).toBe(false);
    expect(isMenuKey(press('F10', { shiftKey: true, ctrlKey: true }))).toBe(false);
    expect(isMenuKey(press('Enter'))).toBe(false);
  });

  it("opens a message's menu with Enter on it, or the Menu key or Shift+F10 anywhere in it", () => {
    for (const e of [press('Enter'), press('ContextMenu'), press('ContextMenu', { target: button }), press('F10', { shiftKey: true, target: button })]) {
      const open = vi.fn();
      expect(menuKeyDown(e, open, { enter: true })).toBe(true);
      expect(open).toHaveBeenCalledOnce();
      expect(e.preventDefault).toHaveBeenCalled();
    }
  });

  it("leaves Enter to a message's own buttons, and other keys alone", () => {
    for (const e of [press('Enter', { target: button }), press('Enter', { shiftKey: true }), press(' '), press('a'), press('Escape')]) {
      const open = vi.fn();
      expect(menuKeyDown(e, open, { enter: true })).toBe(false);
      expect(open).not.toHaveBeenCalled();
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
  });

  it('leaves Enter to open a chat, and opens its long-press action with the Menu key', () => {
    const open = vi.fn();
    expect(menuKeyDown(press('Enter'), open, { enter: false })).toBe(false);
    expect(menuKeyDown(press('ContextMenu'), open, { enter: false })).toBe(true);
    expect(open).toHaveBeenCalledOnce();
  });
});

describe('menuMove', () => {
  it('moves with the arrows, round the ends, and to the ends with Home and End', () => {
    expect(menuMove('ArrowDown', 0, 3)).toBe(1);
    expect(menuMove('ArrowDown', 2, 3)).toBe(0);
    expect(menuMove('ArrowUp', 0, 3)).toBe(2);
    expect(menuMove('ArrowUp', 2, 3)).toBe(1);
    expect(menuMove('Home', 2, 3)).toBe(0);
    expect(menuMove('End', 0, 3)).toBe(2);
  });

  it('starts from the first or last item when none has focus', () => {
    expect(menuMove('ArrowDown', -1, 3)).toBe(0);
    expect(menuMove('ArrowUp', -1, 3)).toBe(2);
  });

  it('ignores other keys, and menus without items', () => {
    expect(menuMove('ArrowLeft', 1, 3)).toBeNull();
    expect(menuMove('Tab', 1, 3)).toBeNull();
    expect(menuMove('ArrowDown', -1, 0)).toBeNull();
  });
});

describe('trackKeyboard', () => {
  it('marks the page from a Tab until the next tap or click, not while typing', () => {
    const listeners: Record<string, (e: { key?: string }) => void> = {};
    const root = { dataset: {} as Record<string, string> };
    trackKeyboard({ addEventListener: (type: string, f: (e: { key?: string }) => void) => (listeners[type] = f), documentElement: root } as unknown as Document);
    listeners.keydown!({ key: 'a' });
    expect(root.dataset.keyboard).toBeUndefined();
    listeners.keydown!({ key: 'Tab' });
    expect(root.dataset.keyboard).toBe('');
    listeners.pointerdown!({});
    expect(root.dataset.keyboard).toBeUndefined();
  });
});
