// The app's language on this device (Settings, Language): one of the
// app's languages (i18n/languages.ts), or the same as Telegram, the default. The choice is kept in this
// profile's meta store and never sent: Telegram notices keep Telegram's
// language, which the server reads from the signed launch data.

import { computed, signal, type ReadonlySignal } from '@preact/signals';
import { applyLanguage, isLanguage, LANGUAGES, pickLanguage, t, type Language } from '../i18n';
import { deleteMeta, getMeta, putMeta, type Database } from '../storage/db';

const NAME = 'language';

/** One of the app's languages, or 'telegram': the language Telegram reports (else the browser's). */
export type LanguageChoice = Language | 'telegram';

/**
 * The choices, in the order they're offered: Same as Telegram, then each
 * language by its own name, as the picker shows it. English collation (the
 * root order, whatever the device's language) puts Latin script A–Z first,
 * then Cyrillic, then Arabic script, as the website's language menu does.
 */
const byName = new Intl.Collator('en');
export const LANGUAGE_CHOICES: readonly LanguageChoice[] = [
  'telegram',
  ...(Object.keys(LANGUAGES) as Language[]).sort((a, b) => byName.compare(t(a, 'languageName'), t(b, 'languageName'))),
];

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
