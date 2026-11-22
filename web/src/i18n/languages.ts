// Every language the app has, in the order the picker offers them (after
// "Same as Telegram"). A code is kept on devices (the language chosen) and,
// for notices, by the server, which picks from Telegram's language the same
// way (backend/internal/i18n): never rename or remove one. The shared
// vectors in backend/internal/i18n/testdata/languages.json keep both sides
// in step.

export interface LanguageInfo {
  /** Which way its text runs. */
  readonly dir: 'ltr' | 'rtl';
  /** The BCP 47 locale for Intl, which also sets the digits. */
  readonly locale: string;
  /** How units are written: 'long' where short ones read badly, as in right-to-left scripts (کیلوبایت, not kB). */
  readonly unitDisplay: 'short' | 'long';
  /** The lowercase BCP 47 tags that pick it (matchTag). */
  readonly tags: readonly string[];
  /** A noun after a number doesn't change («۲ پیام»), so a counted string may be one plain string. */
  readonly countInvariant?: boolean;
}

export const LANGUAGES = {
  en: { dir: 'ltr', locale: 'en', unitDisplay: 'short', tags: ['en'] },
  fa: { dir: 'rtl', locale: 'fa-IR', unitDisplay: 'long', tags: ['fa'], countInvariant: true },
  ru: { dir: 'ltr', locale: 'ru', unitDisplay: 'short', tags: ['ru'] },
  // Western digits (1, 2, 3), pinned: Intl's default for Arabic differs by version.
  ar: { dir: 'rtl', locale: 'ar-u-nu-latn', unitDisplay: 'long', tags: ['ar'] },
  nl: { dir: 'ltr', locale: 'nl', unitDisplay: 'short', tags: ['nl'] },
  es: { dir: 'ltr', locale: 'es', unitDisplay: 'short', tags: ['es'] },
  'pt-BR': { dir: 'ltr', locale: 'pt-BR', unitDisplay: 'short', tags: ['pt', 'pt-br', 'pt-pt'] },
  // "in" is Indonesian's old code, which some systems still send.
  id: { dir: 'ltr', locale: 'id', unitDisplay: 'short', tags: ['id', 'in'], countInvariant: true },
  tr: { dir: 'ltr', locale: 'tr', unitDisplay: 'short', tags: ['tr'], countInvariant: true },
  uk: { dir: 'ltr', locale: 'uk', unitDisplay: 'short', tags: ['uk'] },
  fr: { dir: 'ltr', locale: 'fr', unitDisplay: 'short', tags: ['fr'] },
  de: { dir: 'ltr', locale: 'de', unitDisplay: 'short', tags: ['de'] },
} as const satisfies Record<string, LanguageInfo>;

export type Language = keyof typeof LANGUAGES;

/** Shown when no other language is known. */
export const FALLBACK: Language = 'en';

/** Whether a value names one of the app's languages. */
export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && Object.hasOwn(LANGUAGES, value);
}

/**
 * The language a tag picks among a registry's: the whole tag (its ASCII
 * letters lowercased, with _ read as -) among their tags, else the tag less
 * its last subtag, down to the first ("zh-hans-cn", "zh-hans", "zh").
 * Undefined if none. Only A–Z are lowercased, as the server does: Go and
 * JavaScript lowercase a few other letters differently (İ).
 */
export function matchTag<L extends string>(tag: string, registry: Readonly<Record<L, { readonly tags: readonly string[] }>>): L | undefined {
  const entries = Object.entries(registry) as [L, { readonly tags: readonly string[] }][];
  let rest = tag.replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/_/g, '-');
  while (rest !== '') {
    for (const [code, info] of entries) if (info.tags.includes(rest)) return code;
    const cut = rest.lastIndexOf('-');
    if (cut < 0) return undefined;
    rest = rest.slice(0, cut);
  }
  return undefined;
}
