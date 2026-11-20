import { describe, expect, it } from 'vitest';
import { en, type Key } from './en';
import { fa } from './fa';
import { clockTime, DIRECTION, nextUtc, pickLanguage, relativeTime, t, type Language, type Text } from './index';

const STRINGS: Record<Language, Record<Key, Text>> = { en, fa };
const KEYS = Object.keys(en) as Key[];

/** Every form of a string: itself, or each of its plural forms. */
const forms = (text: Text): string[] => (typeof text === 'string' ? [text] : Object.values(text));

/** The {placeholders} in a string's forms, sorted. */
const placeholders = (text: Text): string[] => [...new Set(forms(text).flatMap((f) => [...f.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)))].sort();

describe('i18n', () => {
  it('has every string in both languages, none empty, with the same placeholders', () => {
    expect(Object.keys(fa).sort()).toEqual(Object.keys(en).sort());
    for (const language of ['en', 'fa'] as const) {
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

  it('fills every counted string, for any count, in both languages', () => {
    const counted = KEYS.filter((key) => placeholders(en[key]).includes('count'));
    expect(counted).toEqual(expect.arrayContaining(['newMessages', 'invitationsRemaining', 'unreadMessagesCount', 'messagesLeftToday', 'blockedCount']));
    for (const language of ['en', 'fa'] as const) {
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
    expect(pickLanguage('de', 'en-GB', 'fa')).toBe('en');
    expect(pickLanguage('de', 'ru')).toBe('en');
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

  it('sets right-to-left for Persian', () => {
    expect(DIRECTION.fa).toBe('rtl');
    expect(DIRECTION.en).toBe('ltr');
  });
});
