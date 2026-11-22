// What English and Persian readers see, recorded before languages came from
// one registry: every string, the digits and units, times, sizes and which
// language a tag picks. A difference here is a change people would see:
// never update these snapshots to make a change pass. (The exceptions: a
// Node upgrade that changes Intl's own wording or data, checked by eye; and
// a change made on purpose, line by line: the product's name in Persian,
// "Incognito Chat", in appName, openInTelegram and elsewhereBody.)
import { describe, expect, it } from 'vitest';
import { en, type Key } from './en';
import { clockTime, formatSaveSize, formatSize, locale, pickLanguage, relativeTime, t, type Language, type Text } from './index';

// clockTime shows the reader's own time: pin it.
(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = 'UTC';

const LANGUAGES: Language[] = ['en', 'fa'];
const KEYS = Object.keys(en) as Key[];
const COUNTS = [0, 1, 2, 5, 21, 1000];

const forms = (text: Text): string[] => (typeof text === 'string' ? [text] : Object.values(text));
const names = (key: Key): string[] => [...new Set(forms(en[key]).flatMap((f) => [...f.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)))];

describe('what English and Persian readers see', () => {
  for (const language of LANGUAGES) {
    it(`every string, filled, in ${language}`, () => {
      const out: Record<string, string | string[]> = {};
      for (const key of KEYS) {
        const fill = (count?: number) => Object.fromEntries(names(key).map((n) => [n, n === 'count' ? count! : `<${n}>`]));
        out[key] = names(key).includes('count') ? COUNTS.map((c) => t(language, key, fill(c))) : t(language, key, fill());
        // And unfilled: placeholders stay as written.
        out[`${key} (unfilled)`] = t(language, key);
      }
      expect(out).toMatchSnapshot();
    });

    it(`numbers, times and sizes in ${language}`, () => {
      const now = new Date('2026-11-10T12:00:00Z');
      const ago = [-5, -59, -180, -7_200, -259_200, -3_456_000, -34_560_000, 7_200].map((s) => relativeTime(language, new Date(now.getTime() + s * 1000), now));
      const clock = ['2026-11-10T03:05:00Z', '2026-11-10T15:30:00Z', '2026-11-10T00:00:00Z'].map((at) => clockTime(language, Date.parse(at)));
      const bytes = [0, 1, 1023 * 1024, 1.5 * 1024 * 1024, 2 * 1024 * 1024 * 1024];
      expect({
        locale: locale(language),
        ago,
        clock,
        size: bytes.map((b) => formatSize(language, b)),
        saveSize: bytes.map((b) => formatSaveSize(language, b)),
      }).toMatchSnapshot();
    });
  }

  it('which language a tag picks', () => {
    const tags = ['fa', 'fa-IR', 'fa_IR', 'FA', 'FA-ir', 'fa-', 'fax', '-fa', ' fa', 'en', 'en-GB', 'en_US', 'EN', 'qaa', 'qaa-x', ''];
    expect(Object.fromEntries(tags.map((tag) => [tag, pickLanguage(tag)]))).toMatchSnapshot();
    expect([pickLanguage(), pickLanguage(null, undefined, 'fa'), pickLanguage('qaa', 'fa', 'en'), pickLanguage('en', 'fa')]).toMatchSnapshot();
  });
});
