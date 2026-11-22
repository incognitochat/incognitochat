import { describe, expect, it } from 'vitest';
import { LANGUAGES, t, type Language } from './i18n';
import { ADMIN_NOTICE_TEXT, ERROR_TEXT, INVITATIONS_NOTICE_TEXT, NOTICE_TEXT, SEND_ERROR_TEXT } from './texts';

describe("what the server's limit on this device's logins and signed requests says", () => {
  const maps = { ERROR_TEXT, NOTICE_TEXT, INVITATIONS_NOTICE_TEXT, SEND_ERROR_TEXT, ADMIN_NOTICE_TEXT };

  it('says "in a minute" for a minute or less, and "later" for longer, wherever it is shown', () => {
    for (const [name, map] of Object.entries(maps)) {
      expect([name, map['device-limit']]).toEqual([name, 'errorDeviceLimit']);
      expect([name, map['device-limit-later']]).toEqual([name, 'errorDeviceLimitLater']);
    }
    expect(t('en', 'errorDeviceLimit')).toBe('Too many tries. Try again in a minute.');
    expect(t('en', 'errorDeviceLimitLater')).toBe('Too many tries. Try again later.');
  });

  it("never says a route's own limit (tomorrow, a day's tokens or chats), in any language", () => {
    for (const language of Object.keys(LANGUAGES) as Language[]) {
      const said = [t(language, 'errorDeviceLimit'), t(language, 'errorDeviceLimitLater')];
      expect(said[0], language).not.toBe(said[1]);
      for (const key of ['noticeRateLimited', 'errorRateLimited', 'errorNoTokens', 'errorNoMailboxes', 'errorTooFast'] as const) {
        expect(said, `${language}: ${key}`).not.toContain(t(language, key));
      }
    }
  });
});
