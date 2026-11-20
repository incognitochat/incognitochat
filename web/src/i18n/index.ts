// Strings and formatting in English and Persian. Hand-written and typed, so
// both languages always have every string; numbers, dates and relative times
// come from Intl (Persian digits and calendar included), and so does which
// form a counted string takes.

import { en, type Key } from './en';
import { fa } from './fa';

export type Language = 'en' | 'fa';

/**
 * A string that reads differently by its {count}: a form for each plural
 * category the language uses (Intl.PluralRules: "one" and "other" in
 * English), "other" for any it leaves out. Persian needs none: a noun after
 * a number stays singular («۲ پیام»), so its strings stay plain.
 */
export type Plural = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

/** A string as written in en.ts and fa.ts. */
export type Text = string | Plural;

const strings: Record<Language, Record<Key, Text>> = { en, fa };

export const DIRECTION: Record<Language, 'ltr' | 'rtl'> = { en: 'ltr', fa: 'rtl' };

/**
 * Picks the language: an explicit choice wins, then the language Telegram
 * reports for the user, then the browser's. Anything that isn't Persian is
 * shown in English.
 */
export function pickLanguage(...candidates: (string | null | undefined)[]): Language {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const tag = candidate.toLowerCase();
    if (tag === 'fa' || tag.startsWith('fa-') || tag.startsWith('fa_')) return 'fa';
    if (tag === 'en' || tag.startsWith('en-') || tag.startsWith('en_')) return 'en';
  }
  return 'en';
}

/** Translates a key, filling {placeholders}; a counted string takes the form its {count} needs. */
export function t(language: Language, key: Key, values: Record<string, string | number> = {}): string {
  return form(language, strings[language][key], values.count).replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? formatValue(language, values[name]!) : match,
  );
}

const pluralRules = new Map<Language, Intl.PluralRules>();

/** The form of a string for a count: "1 new message", "2 new messages". Without a count, "other". */
function form(language: Language, text: Text, count: string | number | undefined): string {
  if (typeof text === 'string') return text;
  if (typeof count !== 'number') return text.other;
  let rules = pluralRules.get(language);
  if (!rules) pluralRules.set(language, (rules = new Intl.PluralRules(locale(language))));
  return text[rules.select(count)] ?? text.other;
}

function formatValue(language: Language, value: string | number): string {
  return typeof value === 'number' ? new Intl.NumberFormat(locale(language)).format(value) : value;
}

/** The BCP 47 locale used with Intl. */
export function locale(language: Language): string {
  return language === 'fa' ? 'fa-IR' : 'en';
}

/** A time of day (Unix ms), in the reader's own time: "3:30 AM" / «۳:۳۰». */
export function clockTime(language: Language, at: number): string {
  return new Intl.DateTimeFormat(locale(language), { hour: 'numeric', minute: '2-digit' }).format(new Date(at));
}

/** When the UTC hour or day (size, in ms) that holds now ends, in Unix ms: when limits counted by it start over. */
export function nextUtc(size: number, now = Date.now()): number {
  return Math.floor(now / size) * size + size;
}

/** "3 minutes ago" / «۳ دقیقه پیش». */
export function relativeTime(language: Language, from: Date, now = new Date()): string {
  const seconds = Math.round((from.getTime() - now.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale(language), { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.trunc(seconds / size), unit);
  }
  return rtf.format(seconds, 'second');
}

/** Applies the language and direction to the document. */
export function applyLanguage(language: Language, doc: Document = document): void {
  doc.documentElement.lang = language;
  doc.documentElement.dir = DIRECTION[language];
}
