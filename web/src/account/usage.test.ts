import { describe, expect, it } from 'vitest';
import { checkUsage, usageView } from './usage';

const info = {
  resetsAt: 1_800_028_800,
  send: { used: 140, limit: 1000 },
  media: { used: 1000, limit: 1024 },
  mailboxes: { used: 15, limit: 100 },
  linkChanges: { used: 1, limit: 5 },
  owned: { used: 148, limit: 2000 },
};

describe('usage', () => {
  it('checks what the server says', () => {
    expect(checkUsage(info)).toEqual(info);
    expect(() => checkUsage({ ...info, send: { used: -1, limit: 1000 } })).toThrow();
    expect(() => checkUsage({ ...info, owned: undefined })).toThrow();
    expect(() => checkUsage({ ...info, resetsAt: 'soon' })).toThrow();
  });

  it("adds what this device holds unused, never past the limit, and doesn't count spares as chats", () => {
    const view = usageView(info, { sendTokens: 12, mediaTokens: 30, spareMailboxes: 5 });
    expect(view.resetsAt).toBe(1_800_028_800_000);
    expect(view.messages).toEqual({ left: 872, limit: 1000 });
    expect(view.files).toEqual({ left: 54 * 1024 * 1024, limit: 1024 * 1024 * 1024 });
    expect(view.newChats).toEqual({ left: 90, limit: 100 });
    expect(view.linkChanges).toEqual({ left: 4, limit: 5 });
    expect(view.chats).toEqual({ used: 143, limit: 2000 });
    // Tokens left from yesterday don't make it more than a day's worth.
    expect(usageView({ ...info, send: { used: 0, limit: 1000 } }, { sendTokens: 40, mediaTokens: 0, spareMailboxes: 0 }).messages.left).toBe(1000);
  });
});
