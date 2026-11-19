import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../crypto/encoding';
import { checkMessage, isReactionEmoji } from '../protocol/message';
import { findSticker, PACKS, stickerEmoji } from './catalog';

describe('sticker catalog', () => {
  it('has an image for every sticker, and a sticker for every image', () => {
    const art = Object.keys(import.meta.glob('/public/stickers/*/*.webp')).map((path) => path.slice('/public/stickers/'.length, -'.webp'.length));
    const ids = PACKS.flatMap((p) => p.stickers.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...art].sort()).toEqual([...ids].sort());
  });

  it('only has IDs and emoji a message can carry', () => {
    for (const s of PACKS.flatMap((p) => p.stickers)) {
      expect(findSticker(s.id)).toBe(s);
      expect(() =>
        checkMessage({ v: 1, kind: 'message', conv: 'AAAAAAAAAAAAAAAAAAAAAA', id: 'AAAAAAAAAAAAAAAAAAAAAA', at: 1, from: toBase64Url(new Uint8Array(65)), to: 'AAAAAAAAAAA', sticker: s }),
      ).not.toThrow();
    }
  });

  it("shows a sticker's emoji: ours, or the sender's only if it's one emoji", () => {
    for (const s of PACKS.flatMap((p) => p.stickers)) {
      expect(isReactionEmoji(s.e)).toBe(true);
      // Ours, whatever the sender says.
      expect(stickerEmoji({ id: s.id, e: '\u202Eab' })).toBe(s.e);
    }
    // From a newer pack: the sender's emoji, joined sequences, skin tones, flags and keycaps included.
    for (const e of ['😉', '👍🏽', '🇮🇷', '1\uFE0F\u20E3', '👨\u200D👩\u200D👧']) expect(stickerEmoji({ id: 'new_pack/x', e })).toBe(e);
    // Else nothing, so the generic placeholder shows.
    for (const e of [undefined, 'ok', '\u202Eab', '😉😉', '😉' + '\u0301'.repeat(5), '\u202E😉']) expect(stickerEmoji({ id: 'new_pack/x', e })).toBe('');
  });
});
