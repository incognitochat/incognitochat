// Keys for what a long press or a right click does: rows open their menus
// from the keyboard, and menus move with the arrow keys.

type Key = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>;

/** Whether a key asks for the focused element's context menu: the Menu key, or Shift+F10. */
export function isMenuKey(e: Key): boolean {
  return e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey);
}

/**
 * A row's keydown handler, opening what its long press opens: on the Menu key
 * or Shift+F10 anywhere in it, and (with `enter`) on Enter on the row itself,
 * not on a button of its own. Returns whether it opened it.
 */
export function menuKeyDown(e: Key & Pick<KeyboardEvent, 'target' | 'currentTarget' | 'preventDefault'>, open: () => void, { enter }: { enter: boolean }): boolean {
  const plainEnter = enter && e.key === 'Enter' && e.target === e.currentTarget && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
  if (!plainEnter && !isMenuKey(e)) return false;
  e.preventDefault();
  open();
  return true;
}

/**
 * Where a key moves in a menu of `count` items, from item `index` (-1 when
 * none has focus): the arrows go to the next or previous one, round the
 * ends; Home and End to the first and last. null for other keys.
 */
export function menuMove(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown':
      return index < 0 ? 0 : (index + 1) % count;
    case 'ArrowUp':
      return index < 0 ? count - 1 : (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * A keydown handler for a menu, or the dialog holding one: the arrow keys,
 * Home and End move between its menu items (from the dialog itself too).
 */
export function moveInMenu(e: KeyboardEvent): void {
  const menu = e.currentTarget as HTMLElement;
  const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
  const to = menuMove(e.key, items.indexOf(document.activeElement as HTMLElement), items.length);
  if (to === null) return;
  e.preventDefault();
  items[to]!.focus();
}

/**
 * Marks the page (data-keyboard on its root) from a Tab until the next tap
 * or click. :focus-visible tells keyboard focus from a tap everywhere but in
 * text fields, which match it on a tap too: this lets the message box show a
 * focus ring only to keyboard users. Only Tab counts, not typing, so a
 * phone's own keyboard never sets it.
 */
export function trackKeyboard(doc: Pick<Document, 'addEventListener' | 'documentElement'> = document): void {
  const root = doc.documentElement;
  doc.addEventListener('keydown', (e) => e.key === 'Tab' && (root.dataset.keyboard = ''), true);
  doc.addEventListener('pointerdown', () => delete root.dataset.keyboard, true);
}
