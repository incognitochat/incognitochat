import { describe, expect, it } from 'vitest';
import { labelParts } from './label';

describe('labelParts', () => {
  it('splits a label into its emoji and its code', () => {
    expect(labelParts('🦊 K3F9')).toEqual({ emoji: '🦊', code: 'K3F9' });
    // Emoji that take a variation selector, and single code points from older blocks.
    expect(labelParts('⭐ 0ABC')).toEqual({ emoji: '⭐', code: '0ABC' });
    expect(labelParts('⚓ ZZZZ')).toEqual({ emoji: '⚓', code: 'ZZZZ' });
    expect(labelParts('❤️ ABCD')).toEqual({ emoji: '❤️', code: 'ABCD' });
  });

  it('keeps any other label whole, with no emoji', () => {
    for (const label of ['K3F9', '', ' K3F9', 'AB CD', '🦊', '🦊 ', '🦊K3F9', 'a🦊 K3F9']) {
      expect(labelParts(label)).toEqual({ emoji: null, code: label });
    }
  });

  it('covers every emoji labels are made with', async () => {
    // The list is private to messaging/secret.ts: read it from the source, so a new emoji there can't slip past.
    const source = await import('../messaging/secret.ts?raw');
    const list = /const EMOJI = \[([^\]]+)\]/.exec(source.default)![1]!;
    const emoji = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(emoji).toHaveLength(64);
    for (const e of emoji) expect(labelParts(`${e} K3F9`)).toEqual({ emoji: e, code: 'K3F9' });
  });
});
