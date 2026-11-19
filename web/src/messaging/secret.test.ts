import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { fromHex, toHex, utf8 } from '../crypto/encoding';
import { generateVaultKey } from '../crypto/vault';
import { getSealed, openDatabase, putKey } from '../storage/db';
import vectors from '../../../backend/internal/envelope/testdata/vectors.json';
import { accountSecret, idTag, label, senderTag } from './secret';

let n = 0;
async function db() {
  const d = await openDatabase(`secret-test-${n++}`);
  await putKey(d, 'vault-key', await generateVaultKey());
  return d;
}

describe('account secret', () => {
  it('is created once, sealed, and used through a non-extractable copy', async () => {
    const d = await db();
    const a = await accountSecret(d);
    const b = await accountSecret(d);
    expect(a.extractable).toBe(false);
    expect(await senderTag(a, 'fp')).toEqual(await senderTag(b, 'fp'));
    expect(await getSealed(d, 'account-secret')).toBeDefined();
  });

  it('gives stable tags per link and labels that differ per account', async () => {
    const mine = await accountSecret(await db());
    const theirs = await accountSecret(await db());
    const tag = await senderTag(mine, 'link-1');
    expect(tag).toHaveLength(32);
    expect(await senderTag(mine, 'link-1')).toEqual(tag);
    expect(await senderTag(mine, 'link-2')).not.toEqual(tag);

    const l = await label(mine, 'anon', tag);
    expect(l).toMatch(/^\S+ [0-9A-HJKMNP-TV-Z]{4}$/u);
    expect(await label(mine, 'anon', tag)).toBe(l);
    // Another viewer sees the same person under another label, so viewers can't compare.
    expect(await label(theirs, 'anon', tag)).not.toBe(l);
    // The same bytes as a link fingerprint give an unrelated label.
    expect(await label(mine, 'link', tag)).not.toBe(l);
    expect(await label(mine, 'link', utf8('fp'))).toMatch(/^\S+ [0-9A-Z]{4}$/u);
  });
});

// Fixed-input vectors (backend/internal/envelope/testdata/vectors.json, where
// Go checks the sender and ID tags too). Labels and tags are frozen: changing
// one changes everyone's labels and blocks, and what the device remembers.
describe('vectors', () => {
  const secret = () => crypto.subtle.importKey('raw', fromHex(vectors.accountSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

  it('give the same sender tags', async () => {
    for (const v of vectors.senderTags) expect(toHex(await senderTag(await secret(), v.linkFingerprint))).toBe(v.tag);
  });

  it('give the same labels', async () => {
    for (const v of vectors.labels) expect(await label(await secret(), v.kind as 'anon' | 'link', fromHex(v.data))).toBe(v.label);
  });

  it('give the same ID tags', async () => {
    for (const v of vectors.idTags) expect(await idTag(await secret(), v.conv, v.id)).toBe(v.tag);
  });
});
