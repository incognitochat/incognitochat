// The app's language on this device (Data and storage, Language): one of the
// app's languages (i18n/languages.ts), or the same as Telegram, the default. The choice is kept in this
// profile's meta store and never sent: Telegram notices keep Telegram's
// language, which the server reads from the signed launch data.

import { computed, signal, type ReadonlySignal } from '@preact/signals';
import { applyLanguage, isLanguage, LANGUAGES, pickLanguage, type Language } from '../i18n';
import { deleteMeta, getMeta, putMeta, type Database } from '../storage/db';

const NAME = 'language';

/** One of the app's languages, or 'telegram': the language Telegram reports (else the browser's). */
export type LanguageChoice = Language | 'telegram';

/** The choices, in the order they're offered. */
export const LANGUAGE_CHOICES: readonly LanguageChoice[] = ['telegram', ...(Object.keys(LANGUAGES) as Language[])];

export interface LanguageSetting {
  readonly choice: ReadonlySignal<LanguageChoice>;
  /** The language the app shows. */
  readonly language: ReadonlySignal<Language>;
  /** Shows the app in the chosen language at once, and remembers it on this device. */
  choose(choice: LanguageChoice): Promise<void>;
}

/** The choice remembered on this device; 'telegram' if none. */
export async function getLanguageChoice(db: Database): Promise<LanguageChoice> {
  const stored = await getMeta<unknown>(db, NAME);
  return isLanguage(stored) ? stored : 'telegram';
}

/**
 * The language setting, from the choice remembered on this device, applied
 * to the document (language and direction). telegram: the languages that
 * 'telegram' follows, Telegram's first, then the browser's.
 */
export async function loadLanguageSetting(db: Database, telegram: (string | null | undefined)[], doc: Document = document): Promise<LanguageSetting> {
  const resolve = (c: LanguageChoice) => pickLanguage(c === 'telegram' ? null : c, ...telegram);
  // Unreadable, it's Telegram's: a preference, not worth failing the start over.
  const choice = signal(await getLanguageChoice(db).catch((): LanguageChoice => 'telegram'));
  const language = computed(() => resolve(choice.value));
  applyLanguage(language.value, doc);
  return {
    choice,
    language,
    async choose(next) {
      // The direction first: what's redrawn reads it from the page.
      applyLanguage(resolve(next), doc);
      choice.value = next;
      // The default is no choice at all.
      await (next === 'telegram' ? deleteMeta(db, NAME) : putMeta(db, NAME, next));
    },
  };
}
