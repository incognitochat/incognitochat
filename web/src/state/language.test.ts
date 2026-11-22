import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '../i18n';
import { openDatabase, putMeta } from '../storage/db';
import { getLanguageChoice, LANGUAGE_CHOICES, loadLanguageSetting } from './language';

/** A stand-in for the page: only its language and direction are read. */
const page = () => {
  const root = { lang: '', dir: '' };
  return { root, doc: { documentElement: root } as unknown as Document };
};

describe('the language setting', () => {
  it('follows Telegram until a language is chosen', async () => {
    const db = await openDatabase(`language-${crypto.randomUUID()}`);
    const { root, doc } = page();
    const setting = await loadLanguageSetting(db, ['fa', 'en-US'], doc);
    expect(setting.choice.value).toBe('telegram');
    expect(setting.language.value).toBe('fa');
    expect(root).toEqual({ lang: 'fa', dir: 'rtl' });
  });

  it('switches at once, with the direction, and is remembered on this device', async () => {
    const db = await openDatabase(`language-${crypto.randomUUID()}`);
    const { root, doc } = page();
    const setting = await loadLanguageSetting(db, ['en'], doc);
    expect(root).toEqual({ lang: 'en', dir: 'ltr' });

    await setting.choose('fa');
    expect(setting.language.value).toBe('fa');
    expect(root).toEqual({ lang: 'fa', dir: 'rtl' });
    expect(await getLanguageChoice(db)).toBe('fa');

    // Opened again, it starts in the chosen language, whatever Telegram's.
    const again = page();
    const reopened = await loadLanguageSetting(db, ['en'], again.doc);
    expect(reopened.choice.value).toBe('fa');
    expect(reopened.language.value).toBe('fa');
    expect(again.root).toEqual({ lang: 'fa', dir: 'rtl' });
  });

  it('follows Telegram again after Same as Telegram, and keeps no choice', async () => {
    const db = await openDatabase(`language-${crypto.randomUUID()}`);
    const { root, doc } = page();
    const setting = await loadLanguageSetting(db, ['fa'], doc);
    await setting.choose('en');
    expect(root).toEqual({ lang: 'en', dir: 'ltr' });

    await setting.choose('telegram');
    expect(setting.language.value).toBe('fa');
    expect(root).toEqual({ lang: 'fa', dir: 'rtl' });
    expect(await getLanguageChoice(db)).toBe('telegram');
    // With Telegram in another language next time, that's the one.
    expect((await loadLanguageSetting(db, ['en-GB'], page().doc)).language.value).toBe('en');
  });

  it('offers Same as Telegram first, then every language once', () => {
    expect(LANGUAGE_CHOICES[0]).toBe('telegram');
    expect([...LANGUAGE_CHOICES.slice(1)].sort()).toEqual(Object.keys(LANGUAGES).sort());
    expect(new Set(LANGUAGE_CHOICES).size).toBe(LANGUAGE_CHOICES.length);
  });

  it('offers Same as Telegram first, then each language in the registry order', () => {
    expect(LANGUAGE_CHOICES).toEqual(['telegram', 'en', 'fa', 'ru', 'ar', 'nl', 'es', 'pt-BR', 'id', 'tr', 'uk', 'fr', 'de', 'pl']);
  });

  it('reads stored values that only look like a language as Same as Telegram', async () => {
    for (const stored of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'EN', 'fa-IR', ['fa'], 1, null, { en: true }]) {
      const db = await openDatabase(`language-${crypto.randomUUID()}`);
      await putMeta(db, 'language', stored);
      expect(await getLanguageChoice(db), String(stored)).toBe('telegram');
    }
  });

  it('reads anything else stored as Same as Telegram', async () => {
    const db = await openDatabase(`language-${crypto.randomUUID()}`);
    // A private-use code (qaa–qtz): never a language the app gains.
    await putMeta(db, 'language', 'qaa');
    expect(await getLanguageChoice(db)).toBe('telegram');
    expect((await loadLanguageSetting(db, ['fa'], page().doc)).language.value).toBe('fa');
  });
});
