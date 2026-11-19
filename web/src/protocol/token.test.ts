import { describe, expect, it } from 'vitest';
import { fromBase64Url, fromHex, toHex } from '../crypto/encoding';
import issuerKeys from '../../issuer-keys.json';
import { challenge, epochOf, LABEL_MEDIA_TOKEN, TOKEN_INPUT_LENGTH, tokenInput } from './token';

describe('send tokens', () => {
  it('derive the weekly challenge exactly like the backend', async () => {
    // backend/internal/tokens: TestChallengeVector.
    expect(epochOf(1_800_000_000)).toBe(2976);
    expect(toHex(await challenge(2976))).toBe('3ff2ca2b7e3d94fa8b80f80f0f44814f65decd7bbd029649ed7f22149d457f93');
    // Media tokens have their own label, so their own challenge.
    expect(toHex(await challenge(2976, LABEL_MEDIA_TOKEN))).toBe('59f485cea0cde111a1beb5ce12a245bebc8cc0bd23118181ea14f9de282ea8f6');
  });

  it('build a 98-byte input with a fresh nonce', async () => {
    const keyId = new Uint8Array(32).fill(7);
    const a = await tokenInput(2976, keyId);
    const b = await tokenInput(2976, keyId);
    expect(a).toHaveLength(TOKEN_INPUT_LENGTH);
    expect(toHex(a.slice(0, 2))).toBe('0002');
    expect(toHex(a.slice(34, 66))).toBe('3ff2ca2b7e3d94fa8b80f80f0f44814f65decd7bbd029649ed7f22149d457f93');
    expect(a.slice(66)).toEqual(keyId);
    expect(toHex(a.slice(2, 34))).not.toBe(toHex(b.slice(2, 34)));
  });

  it('publish only keys whose ID matches them', async () => {
    const entries = Object.entries(issuerKeys).filter(([name, entry]) => name !== '_comment' && typeof entry !== 'string');
    for (const [, entry] of entries) {
      if (typeof entry === 'string') continue;
      for (const published of [entry, entry.media]) {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', fromBase64Url(published.spki)));
        expect(digest).toEqual(fromHex(published.keyId));
        const key = await crypto.subtle.importKey('spki', fromBase64Url(published.spki), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
        expect((key.algorithm as RsaHashedKeyAlgorithm).modulusLength).toBe(2048);
      }
    }
    expect(keyClashes(entries.map(([name, entry]) => typeof entry === 'string' ? { name } : { name, send: entry.keyId, media: entry.media.keyId }))).toEqual([]);
  });

  it('may share a key between entries, of the same kind only', () => {
    // A rotation of one kind: the new entry keeps the other kind's key.
    expect(keyClashes([{ name: 'p-2026-11', send: 's1', media: 'm1' }, { name: 'p-2027-01', send: 's2', media: 'm1' }])).toEqual([]);
    expect(keyClashes([{ name: 'a', send: 's1', media: 's1' }])).toEqual(['a: one key for both kinds']);
    expect(keyClashes([{ name: 'p-2026-11', send: 's1', media: 'm1' }, { name: 'p-2027-01', send: 'm1', media: 'm2' }])).toEqual(['m1: a send key and a media key']);
    // Environments never share a key: one's tokens would pay in the other.
    expect(keyClashes([{ name: 'dev-2026-11', send: 's1', media: 'm1' }, { name: 'dev-2027-01', send: 's2', media: 'm1' }])).toEqual([]);
    expect(keyClashes([{ name: 'dev-2026-11', send: 's1', media: 'm1' }, { name: 'production-2026-11', send: 's2', media: 'm1' }])).toEqual([
      'm1: in dev and production',
    ]);
  });
});

/**
 * What's wrong with how the published entries share keys: an entry names
 * one key of each kind, two different keys, and no key is ever both a send
 * key and a media key (a blind signer can't tell them apart, so the two
 * kinds would share one budget). The same key of the same kind may appear
 * in several entries of one environment (named <environment>-<year>-<month>):
 * a rotation of one kind keeps the other kind's key.
 */
function keyClashes(entries: { name: string; send?: string; media?: string }[]): string[] {
  const clashes: string[] = [];
  const send = new Set(entries.map((e) => e.send));
  const environment = new Map<string, string>();
  for (const e of entries) {
    if (!e.send || !e.media) clashes.push(`${e.name}: a key missing`);
    else if (e.send === e.media) clashes.push(`${e.name}: one key for both kinds`);
    else if (send.has(e.media)) clashes.push(`${e.media}: a send key and a media key`);
    const env = e.name.replace(/-\d{4}-\d{2}$/, '');
    for (const key of [e.send, e.media]) {
      if (!key) continue;
      const other = environment.get(key);
      if (other !== undefined && other !== env) clashes.push(`${key}: in ${other} and ${env}`);
      environment.set(key, env);
    }
  }
  return clashes;
}
