import { describe, expect, it } from 'vitest';
import vectors from '../../../backend/internal/i18n/testdata/languages.json';
import { confirmationMatches } from '../state/app';
import { en, type Key } from './en';
import { clockTime, DIRECTION, LANGUAGES, locale, matchTag, nextUtc, pickLanguage, relativeTime, STRINGS, t, type Language, type Text } from './index';

const KEYS = Object.keys(en) as Key[];
const ALL = Object.keys(LANGUAGES) as Language[];

/** Every form of a string: itself, or each of its plural forms. */
const forms = (text: Text): string[] => (typeof text === 'string' ? [text] : Object.values(text));

/** The {placeholders} in a string's forms, sorted. */
const placeholders = (text: Text): string[] => [...new Set(forms(text).flatMap((f) => [...f.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)))].sort();

describe('i18n', () => {
  it('has every string in every language, none empty, with the same placeholders', () => {
    for (const language of ALL) {
      expect(Object.keys(STRINGS[language]).sort(), language).toEqual(Object.keys(en).sort());
      for (const key of KEYS) {
        const text = STRINGS[language][key];
        for (const f of forms(text)) expect(f.trim(), `${language} ${key}`).not.toBe('');
        expect(placeholders(text), `${language} ${key}`).toEqual(placeholders(STRINGS.en[key]));
        // Each form of a counted string says the same things.
        for (const f of forms(text)) expect(placeholders(f), `${language} ${key}`).toEqual(placeholders(text));
        if (typeof text !== 'string') expect(placeholders(text), `${language} ${key}`).toContain('count');
      }
    }
  });

  it('takes the form a count needs: English has one and other', () => {
    expect([0, 1, 2, 5, 1000].map((count) => t('en', 'newMessages', { count }))).toEqual([
      '0 new messages',
      '1 new message',
      '2 new messages',
      '5 new messages',
      '1,000 new messages',
    ]);
    expect(t('en', 'invitationsRemaining', { count: 1 })).toBe('You can invite 1 more person.');
    expect(t('en', 'invitationsRemaining', { count: 2 })).toBe('You can invite 2 more people.');
    // Without a count, the general form.
    expect(t('en', 'newMessages')).toBe('{count} new messages');
  });

  it('keeps a noun after a number singular in Persian', () => {
    expect([0, 1, 2, 1000].map((count) => t('fa', 'newMessages', { count }))).toEqual(['۰ پیام جدید', '۱ پیام جدید', '۲ پیام جدید', '۱٬۰۰۰ پیام جدید']);
    expect(t('fa', 'invitationsRemaining', { count: 1 })).toBe('می‌توانید ۱ نفر دیگر را دعوت کنید.');
    expect(t('fa', 'invitationsRemaining', { count: 3 })).toBe('می‌توانید ۳ نفر دیگر را دعوت کنید.');
  });

  it('fills every counted string, for any count, in every language', () => {
    const counted = KEYS.filter((key) => placeholders(en[key]).includes('count'));
    expect(counted).toEqual(expect.arrayContaining(['newMessages', 'invitationsRemaining', 'unreadMessagesCount', 'messagesLeftToday', 'blockedCount']));
    for (const language of ALL) {
      for (const key of counted) {
        for (const count of [0, 1, 2, 3, 5, 11, 21, 101, 1000]) {
          const values = Object.fromEntries(placeholders(en[key]).map((name) => [name, name === 'count' ? count : 'x']));
          expect(t(language, key, values), `${language} ${key} ${count}`).not.toMatch(/[{}]/);
        }
      }
    }
  });

  it('picks the first known language, defaulting to English', () => {
    expect(pickLanguage(undefined, 'fa', 'en-US')).toBe('fa');
    expect(pickLanguage('', 'FA-ir')).toBe('fa');
    expect(pickLanguage('fa_IR')).toBe('fa');
    // qaa–qtz are private-use codes: never a real language, so never one the app gains.
    expect(pickLanguage('qaa', 'en-GB', 'fa')).toBe('en');
    expect(pickLanguage('qaa', 'qab')).toBe('en');
    expect(pickLanguage()).toBe('en');
  });

  it('fills placeholders, with Persian digits in Persian', () => {
    expect(t('en', 'replaceType', { phrase: 'start over' })).toBe('To continue, type start over');
    expect(t('fa', 'replaceType', { phrase: 'شروع دوباره' })).toBe('برای ادامه، عبارت شروع دوباره را بنویسید');
    expect(t('en', 'replaceType')).toBe('To continue, type {phrase}');
    expect(t('fa', 'replaceType', { phrase: 3 })).toBe('برای ادامه، عبارت ۳ را بنویسید');
  });

  it('says what the unread count and the delivery marks show', () => {
    expect(t('en', 'unreadMessagesCount', { count: 3 })).toBe('3 unread');
    expect(t('fa', 'unreadMessagesCount', { count: 3 })).toBe('۳ پیام خوانده‌نشده');
    expect(t('en', 'unreadMessages')).toBe('Unread messages');
    expect([t('en', 'sending'), t('en', 'sent'), t('en', 'seen'), t('en', 'notSent')]).toEqual(['Sending…', 'Sent', 'Seen', 'Not sent']);
  });

  it('formats relative times', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    expect(relativeTime('en', new Date('2026-11-10T11:57:00Z'), now)).toBe('3 minutes ago');
    expect(relativeTime('fa', new Date('2026-11-10T11:57:00Z'), now)).toBe('۳ دقیقه پیش');
    expect(relativeTime('en', new Date('2026-11-10T12:00:00Z'), now)).toBe('now');
  });

  it('says from when a busy link or a file downloaded as often as a day allows can be tried again', () => {
    const hour = 3_600_000;
    const at = Date.parse('2026-11-10T11:30:00Z');
    expect(nextUtc(hour, at)).toBe(Date.parse('2026-11-10T12:00:00Z'));
    expect(nextUtc(24 * hour, at)).toBe(Date.parse('2026-11-11T00:00:00Z'));
    expect(nextUtc(hour, Date.parse('2026-11-10T12:00:00Z'))).toBe(Date.parse('2026-11-10T13:00:00Z'));
    expect(t('en', 'errorLinkBusy', { time: '3:30 PM' })).toBe('Too many messages through this link right now. Try again at 3:30 PM.');
    expect(t('fa', 'errorLinkBusy', { time: '۱۵:۳۰' })).toBe('فعلاً پیام زیادی از طریق این لینک فرستاده شده است. از ساعت ۱۵:۳۰ دوباره امتحان کنید.');
    expect(t('en', 'errorDownloadLimit', { time: '3:30 AM' })).toBe('This file has been downloaded too many times today. Try again at 3:30 AM.');
    expect(t('fa', 'errorDownloadLimit', { time: '۳:۳۰' })).toBe('این فایل امروز به سقف دفعات دریافت رسیده است. از ساعت ۳:۳۰ دوباره امتحان کنید.');
    // A time of day, in the reader's numerals.
    expect(clockTime('fa', at)).toMatch(/^[۰-۹]{1,2}:[۰-۹]{2}/);
    expect(clockTime('en', at)).toMatch(/^\d{1,2}:\d{2}/);
  });

  it('counts in Russian with its three forms', () => {
    expect([1, 2, 5, 21].map((count) => t('ru', 'newMessages', { count }))).toEqual(['1 новое сообщение', '2 новых сообщения', '5 новых сообщений', '21 новое сообщение']);
  });

  it('counts in Arabic with its six forms, in Western digits', () => {
    expect([0, 1, 2, 3, 11, 100].map((count) => t('ar', 'newMessages', { count }))).toEqual(['0 رسالة جديدة', '1 رسالة جديدة', '2 رسالتان جديدتان', '3 رسائل جديدة', '11 رسالة جديدة', '100 رسالة جديدة']);
  });

  it('counts in Dutch with one and other', () => {
    expect([0, 1, 2, 1000].map((count) => t('nl', 'newMessages', { count }))).toEqual(['0 nieuwe berichten', '1 nieuw bericht', '2 nieuwe berichten', '1.000 nieuwe berichten']);
  });

  it('counts in Spanish, with "de" after a round million', () => {
    expect([0, 1, 2, 1000, 1_000_000].map((count) => t('es', 'newMessages', { count }))).toEqual(['0 mensajes nuevos', '1 mensaje nuevo', '2 mensajes nuevos', '1000 mensajes nuevos', '1.000.000 de mensajes nuevos']);
  });

  it('counts in Portuguese, with "de" after round millions', () => {
    expect([1, 2, 1_000_000, 1_500_000].map((count) => t('pt-BR', 'newMessages', { count }))).toEqual(['1 nova mensagem', '2 novas mensagens', '1.000.000 de novas mensagens', '1.500.000 novas mensagens']);
  });

  it('keeps a noun after a number unchanged in Indonesian', () => {
    expect([0, 1, 2, 1000].map((count) => t('id', 'newMessages', { count }))).toEqual(['0 pesan baru', '1 pesan baru', '2 pesan baru', '1.000 pesan baru']);
    expect(t('id', 'invitationsRemaining', { count: 3 })).toBe('Anda bisa mengundang 3 orang lagi.');
  });

  it('keeps a noun after a number singular in Turkish', () => {
    expect([0, 1, 2, 1000].map((count) => t('tr', 'newMessages', { count }))).toEqual(['0 yeni mesaj', '1 yeni mesaj', '2 yeni mesaj', '1.000 yeni mesaj']);
  });

  it('sets right-to-left for Persian and Arabic', () => {
    expect(DIRECTION.ar).toBe('rtl');
    expect(DIRECTION.fa).toBe('rtl');
    expect(DIRECTION.en).toBe('ltr');
  });
});

/** Counted keys whose number stands alone ("Blocked (3)", "Level 2: 5"): no noun agrees with it, so they may stay plain in any language. */
const COUNT_STANDS_ALONE: readonly Key[] = ['unreadCount', 'usageCount', 'blockedCount', 'levelLine', 'messagesLeftToday'];

/** Shown in Telegram's own popups (app.tsx: confirmSwitch, confirmDeleteHereOnly, confirmReplace, and clearing media): at most 256 characters for a message and 64 for a button. A new popup's keys go here. */
const POPUP_MESSAGES: readonly Key[] = ['clearMediaConfirm', 'confirmPauseUploads', 'confirmPauseDownloads', 'confirmResumeUploads', 'confirmResumeDownloads', 'deleteHereOnlyConfirm', 'newLinkConfirm'];
const POPUP_BUTTONS: readonly Key[] = ['clearMedia', 'pause', 'resume', 'deleteHereOnly', 'newLink'];

/** What the app says about safety and privacy: a translation must keep exactly what each says (checked by back-translation before a language ships). */
const SECURITY_KEYS: readonly Key[] = [
  'welcomeBody', 'homeIntro', 'newLinkConfirm', 'revokeConfirm', 'noticeReplaced', 'noticeNewSigningKey', 'joinBody',
  'linkVerified', 'linkExisting', 'linkExistingHint', 'linkMismatch', 'noticesAsk', 'firstMessageHint',
  'aboutOwnerConversation', 'aboutSenderConversation', 'deleteConfirm', 'deleteConfirmBoth', 'alsoDeleteFor', 'alsoBlock',
  'blockConfirmOwner', 'blockConfirmSender', 'noticeBlocked', 'blockedConversation', 'noticeUnblocked', 'storageNote',
  'deleteMessageConfirm', 'elsewhereBody', 'elsewhereLost', 'replaceBody', 'replaceWarning', 'deleteBody', 'deleteWarning',
  'deletingAccount', 'deletingElsewhereBody', 'deleteHereOnlyNote', 'accountDeletedHere', 'deleteHereOnlyConfirm',
  'deletionPausedNotice', 'accountDeleted', 'replacedBody', 'expiredBody', 'signedOutBody', 'signedOutKept', 'resetBody',
  'resetWarning', 'errorClock', 'autoDownloadNote', 'noticeDeleted',
];

/** Fills every placeholder of a key with a long value, and {count} with a number. */
const filled = (language: Language, key: Key, count = 1000) =>
  t(language, key, Object.fromEntries(placeholders(en[key]).map((name) => [name, name === 'count' ? count : 'x'.repeat(24)])));

describe('every language', () => {
  it('is listed with its tags, the same as the server lists them', () => {
    // backend/internal/i18n/testdata/languages.json, which the server's tests read too.
    expect(ALL).toEqual(vectors.languages);
    const tags = ALL.flatMap((language) => LANGUAGES[language].tags.map((tag) => [tag, language] as const));
    for (const [tag, language] of tags) {
      // Lowercase, subtags joined by -, as matchTag compares them.
      expect(tag, language).toMatch(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/);
      // Each tag has a vector, so the server is checked to pick it the same way.
      expect((vectors.pick as Record<string, string>)[tag], tag).toBe(language);
    }
    expect(new Set(tags.map(([tag]) => tag)).size, 'a tag picks one language only').toBe(tags.length);
  });

  it('picks the same language from a tag as the server does', () => {
    for (const [tag, language] of Object.entries(vectors.pick)) expect(pickLanguage(tag), tag).toBe(language);
  });

  it('picks each language from its own code, as the choice kept on the device is read', () => {
    // A choice is kept as the code ("pt-BR") and read back through pickLanguage.
    for (const language of ALL) expect(pickLanguage(language), language).toBe(language);
  });

  it('matches a tag whole, then less its last subtag, down to the first', () => {
    const registry = { hans: { tags: ['zh-hans', 'zh'] }, hant: { tags: ['zh-hant', 'zh-tw'] }, pt: { tags: ['pt', 'pt-br'] } };
    expect(matchTag('zh-Hans-CN', registry)).toBe('hans');
    expect(matchTag('zh_hant_HK', registry)).toBe('hant');
    expect(matchTag('zh-TW', registry)).toBe('hant');
    expect(matchTag('zh-HK', registry)).toBe('hans');
    expect(matchTag('pt-PT', registry)).toBe('pt');
    expect(matchTag('pt', registry)).toBe('pt');
    expect(matchTag('qaa-pt', registry)).toBeUndefined();
    expect(matchTag('', registry)).toBeUndefined();
    expect(matchTag('-', registry)).toBeUndefined();
    // Only A–Z are lowercased, as on the server: full Unicode lowercasing
    // would turn the Kelvin sign (U+212A) into k.
    expect(matchTag('\u212Ak', { kk: { tags: ['kk'] } })).toBeUndefined();
    expect(matchTag('KK', { kk: { tags: ['kk'] } })).toBe('kk');
  });

  it('names itself in its own language, each differently', () => {
    const names = ALL.map((language) => t(language, 'languageName'));
    expect(new Set(names).size).toBe(names.length);
  });

  it('has a form for every plural category its counted strings need', () => {
    const counted = KEYS.filter((key) => placeholders(en[key]).includes('count'));
    for (const language of ALL) {
      const categories = new Intl.PluralRules(locale(language)).resolvedOptions().pluralCategories;
      for (const key of counted) {
        const text = STRINGS[language][key];
        // Any counted string written with forms has them all; a missing one would silently read as "other".
        if (typeof text !== 'string') for (const c of categories) expect(text[c], `${language} ${key} ${c}`).toBeDefined();
        // Where a noun agrees with its number, each such string needs its forms (not English: the source, which has what it needs).
        const plainAllowed = language === 'en' || (LANGUAGES[language] as { countInvariant?: boolean }).countInvariant === true || COUNT_STANDS_ALONE.includes(key) || categories.length === 1;
        if (!plainAllowed) expect(typeof text, `${language} ${key} needs plural forms`).toBe('object');
      }
    }
  });

  it("fits Telegram's popups", () => {
    for (const language of ALL) {
      for (const key of POPUP_MESSAGES) expect(filled(language, key).length, `${language} ${key}`).toBeLessThanOrEqual(256);
      for (const key of POPUP_BUTTONS) expect(filled(language, key).length, `${language} ${key}`).toBeLessThanOrEqual(64);
    }
  });

  it('has typed phrases that match themselves and not each other', () => {
    const phrases: Key[] = ['replacePhrase', 'resetPhrase', 'deletePhrase'];
    for (const language of ALL) {
      for (const a of phrases) {
        expect(confirmationMatches(t(language, a), t(language, a)), `${language} ${a}`).toBe(true);
        for (const b of phrases) if (a !== b) expect(confirmationMatches(t(language, a), t(language, b)), `${language} ${a} ${b}`).toBe(false);
      }
    }
  });

  it('leaves bidi isolation to the code', () => {
    // The app wraps names and phrases where it shows them; a mark in a string file would wrap them twice.
    for (const language of ALL) for (const key of KEYS) for (const f of forms(STRINGS[language][key])) expect(f, `${language} ${key}`).not.toMatch(/[\u2066-\u2069]/);
  });

  it('still has every string that speaks about safety and privacy', () => {
    for (const key of SECURITY_KEYS) expect(KEYS, key).toContain(key);
  });

  it('writes each counted string out for reviewers', async () => {
    const counts = [0, 1, 2, 3, 5, 11, 21, 100, 101, 102, 1_000_000];
    const counted = KEYS.filter((key) => placeholders(en[key]).includes('count'));
    for (const language of ALL) {
      const lines = counted.flatMap((key) => [`${key}:`, ...counts.map((count) => `  ${count}: ${filled(language, key, count)}`)]);
      await expect(lines.join('\n') + '\n').toMatchFileSnapshot(`__plurals__/${language}.txt`);
    }
  });
});
