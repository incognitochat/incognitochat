// Dialogs and sheets for keyboard and screen-reader users: focus moves into
// one when it opens, Tab stays inside it, and focus goes back when it closes.
// On a phone nothing shows: the dialog itself takes the focus (never a field,
// which would bring up the keyboard), and a tap shows no focus ring.

import type { RefObject } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

/** What Tab can reach, before checking it's shown. */
const TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  'audio[controls]',
  'video[controls]',
  '[tabindex]',
].join(', ');

/** Fields that bring up a phone's keyboard when focused. */
const TEXT_FIELD = 'textarea, [contenteditable], input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="file"])';

/** The elements Tab moves through inside a container, in order. */
export function tabbables(container: Element): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) => el.tabIndex >= 0 && !el.closest('[hidden], [inert], [aria-hidden="true"]') && el.getClientRects().length > 0,
  );
}

/**
 * Where Tab should go instead, to keep focus inside: past the last element
 * back to the first, and before the first (or from the dialog itself) to the
 * last. null where the browser's own move stays inside.
 */
export function wrapTab<T>(items: readonly T[], current: unknown, backwards: boolean): T | null {
  if (items.length === 0) return null;
  const at = items.indexOf(current as T);
  if (backwards) return at <= 0 ? items[items.length - 1]! : null;
  return at === -1 || at === items.length - 1 ? items[0]! : null;
}

/** Keeps Tab and Shift+Tab inside the dialog (its keydown handler). */
export function trapTab(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>, dialog: HTMLElement | null, doc: Pick<Document, 'activeElement'> = document): void {
  if (e.key !== 'Tab' || !dialog) return;
  const items = tabbables(dialog);
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const next = wrapTab(items, doc.activeElement, e.shiftKey);
  if (next) {
    e.preventDefault();
    next.focus();
  }
}

/**
 * Focuses the dialog (it needs tabIndex -1) and returns what puts the focus
 * back where it was. Not into a text field, though: no dialog opens from one
 * with the keyboard, only with a tap, and there it would bring the phone's
 * keyboard back up.
 */
export function focusDialog(dialog: HTMLElement, doc: Pick<Document, 'activeElement'> = document): () => void {
  const before = doc.activeElement as HTMLElement | null;
  dialog.focus({ preventScroll: true });
  return () => {
    if (!before || !before.isConnected || typeof before.focus !== 'function' || before.matches(TEXT_FIELD)) return;
    before.focus({ preventScroll: true });
  };
}

/**
 * For a row that takes focus only for the keyboard (its mousedown handler):
 * a press on it, not on a button or field of its own, doesn't focus it, so
 * the page doesn't scroll to show all of it. Focus just leaves what had it,
 * as a press on something that can't take focus does, so a phone's keyboard
 * closes as it did before.
 */
export function pressWithoutFocus(e: Pick<MouseEvent, 'target' | 'currentTarget' | 'preventDefault'>, doc: Pick<Document, 'activeElement'> = document): void {
  const row = e.currentTarget as Element;
  if ((e.target as Element).closest(TABBABLE) !== row) return;
  e.preventDefault();
  const active = doc.activeElement as HTMLElement | null;
  if (active && active !== row && typeof active.blur === 'function') active.blur();
}

/** Moves focus back to the dialog if what had it went away (a view inside it changed). */
export function keepFocusIn(dialog: HTMLElement | null, doc: Pick<Document, 'activeElement'> = document): void {
  if (dialog && !dialog.contains(doc.activeElement)) dialog.focus({ preventScroll: true });
}

/**
 * For a dialog's element (with tabIndex -1): focus moves to it while it's
 * open, Tab stays inside, and focus goes back on close. `view` names what
 * the dialog shows; when it changes, focus that was on a part now gone comes
 * back to the dialog.
 */
export function useDialogFocus<T extends HTMLElement>(view?: unknown): { ref: RefObject<T | null>; onKeyDown: (e: KeyboardEvent) => void } {
  const ref = useRef<T | null>(null);
  useLayoutEffect(() => (ref.current ? focusDialog(ref.current) : undefined), []);
  useLayoutEffect(() => keepFocusIn(ref.current), [view]);
  return { ref, onKeyDown: (e) => trapTab(e, ref.current) };
}
