import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { i2osp, modPow, os2ip, verify, type IssuerKey } from '../crypto/blindrsa';
import { fromBase64Url, toBase64Url, toHex } from '../crypto/encoding';
import type { Session } from '../net/session';
import { challenge, EPOCH_SECONDS, epochOf, LABEL_MEDIA_TOKEN, TOKEN_INPUT_LENGTH } from '../protocol/token';
import { openDatabase } from '../storage/db';
import { batchFor, budgetLeft, countTokens, refillTokens, rememberLeft, returnToken, returnTokens, takeToken, takeTokens, type TokenIssuer } from './wallet';

let n = 0;
const NOW = 1_800_000_000;

/** An issuer with a fresh key, and a fake session whose POST /tokens signs like the server. */
async function issuerAndSession(route = '/tokens'): Promise<{ issuer: TokenIssuer; session: Session; signed: () => number }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-384' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const big = (s: string) => os2ip(fromBase64Url(s));
  const key: IssuerKey = { key: pair.publicKey, n: big(jwk.n!), e: big(jwk.e!), k: 256 };
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const keyId = new Uint8Array(await crypto.subtle.digest('SHA-256', spki));
  let count = 0;
  const session: Session = {
    use: () => {},
      token: async () => 'v1.test.token',
    async call(_method, path, body, check) {
      if (path !== route) throw new Error(path);
      const blinded = (body as { blinded: string[] }).blinded;
      count += blinded.length;
      const d = big(jwk.d!);
      return check({ signatures: blinded.map((b) => toBase64Url(i2osp(modPow(os2ip(fromBase64Url(b)), d, key.n), 256))), left: 1000 - count });
    },
  };
  return { issuer: { key, keyId }, session, signed: () => count };
}

describe('token wallet', () => {
  it('keeps media tokens apart: their own route, label and wallet', async () => {
    const db = await openDatabase(`wallet-test-${n++}`);
    const { issuer, session, signed } = await issuerAndSession('/tokens/media');
    expect(await refillTokens(db, session, issuer, 3, NOW, 'media')).toBe(3);
    expect(signed()).toBe(3);
    expect(await countTokens(db, NOW, 'media')).toBe(3);
    // The send wallet is untouched.
    expect(await countTokens(db, NOW)).toBe(0);
    expect(await takeToken(db, NOW)).toBeNull();

    const t = await takeToken(db, NOW, 'media');
    const raw = fromBase64Url(t!.token);
    expect(toHex(raw.slice(34, 66))).toBe(toHex(await challenge(epochOf(NOW), LABEL_MEDIA_TOKEN)));
    expect(toHex(raw.slice(34, 66))).not.toBe(toHex(await challenge(epochOf(NOW))));
    expect(await verify(issuer.key, raw.slice(0, TOKEN_INPUT_LENGTH), raw.slice(TOKEN_INPUT_LENGTH))).toBe(true);
    await returnToken(db, t!.token, t!.epoch, 'media');
    expect(await countTokens(db, NOW, 'media')).toBe(3);
  });

  it("knows what's left today: unspent here plus what the server will still sign", async () => {
    const db = await openDatabase(`wallet-test-${n++}`);
    const { issuer, session } = await issuerAndSession();
    expect(await budgetLeft(db, NOW)).toBeNull();
    await refillTokens(db, session, issuer, 20, NOW);
    expect(await budgetLeft(db, NOW)).toBe(1000);
    await takeToken(db, NOW);
    expect(await budgetLeft(db, NOW)).toBe(999);
    // The server's count is for its day (UTC): unknown the next.
    expect(await budgetLeft(db, NOW + 24 * 60 * 60)).toBeNull();
  });

  it('fills with valid tokens and hands out each once', async () => {
    const db = await openDatabase(`wallet-test-${n++}`);
    const { issuer, session, signed } = await issuerAndSession();
    expect(await refillTokens(db, session, issuer, 3, NOW)).toBe(3);
    expect(signed()).toBe(3);
    expect(await countTokens(db, NOW)).toBe(3);

    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const token = (await takeToken(db, NOW))!.token;
      expect(seen.has(token)).toBe(false);
      seen.add(token);
      const raw = fromBase64Url(token);
      expect(raw).toHaveLength(TOKEN_INPUT_LENGTH + 256);
      expect(raw.slice(66, 98)).toEqual(issuer.keyId);
      expect(await verify(issuer.key, raw.slice(0, TOKEN_INPUT_LENGTH), raw.slice(TOKEN_INPUT_LENGTH))).toBe(true);
    }
    expect(await takeToken(db, NOW)).toBeNull();
  });

  it("keeps last week's tokens and drops older ones", async () => {
    const db = await openDatabase(`wallet-test-${n++}`);
    const { issuer, session } = await issuerAndSession();
    await refillTokens(db, session, issuer, 2, NOW);
    expect(await countTokens(db, NOW + EPOCH_SECONDS)).toBe(2);
    expect(await countTokens(db, NOW + 2 * EPOCH_SECONDS)).toBe(0);
    expect(await takeToken(db, NOW + 2 * EPOCH_SECONDS)).toBeNull();
  });

  it('takes the oldest first and can take one back', async () => {
    const db = await openDatabase(`wallet-test-${n++}`);
    const { issuer, session } = await issuerAndSession();
    await refillTokens(db, session, issuer, 1, NOW - EPOCH_SECONDS);
    await refillTokens(db, session, issuer, 1, NOW);
    const lastWeek = await challenge(epochOf(NOW) - 1);
    const thisWeek = await challenge(epochOf(NOW));
    const first = (await takeToken(db, NOW))!;
    expect(fromBase64Url(first.token).slice(34, 66)).toEqual(lastWeek);
    expect(first.epoch).toBe(epochOf(NOW) - 1);
    await returnToken(db, first.token, first.epoch);
    expect(await takeToken(db, NOW)).toEqual(first);
    expect(fromBase64Url((await takeToken(db, NOW))!.token).slice(34, 66)).toEqual(thisWeek);
  });

  it('takes as many as a send costs, all or none, and takes them all back', async () => {
    const db = await openDatabase(`wallet-test-${n++}`);
    const { issuer, session } = await issuerAndSession();
    await refillTokens(db, session, issuer, 5, NOW);
    expect(await takeTokens(db, 6, NOW)).toBeNull();
    expect(await countTokens(db, NOW)).toBe(5);
    const four = (await takeTokens(db, 4, NOW))!;
    expect(new Set(four.map((t) => t.token)).size).toBe(4);
    expect(await countTokens(db, NOW)).toBe(1);
    await returnTokens(db, four);
    expect(await countTokens(db, NOW)).toBe(5);
    expect(await takeTokens(db, 4, NOW)).toEqual(four);
  });

  it("asks for no more than the server will still sign today", async () => {
    const db = await openDatabase(`wallet-test-${n++}`);
    expect(await batchFor(db, 20, NOW)).toBe(20);
    await rememberLeft(db, 'send', 5, NOW);
    expect(await batchFor(db, 20, NOW)).toBe(5);
    expect(await batchFor(db, 3, NOW)).toBe(3);
    // Another day: unknown again.
    expect(await batchFor(db, 20, NOW + 24 * 60 * 60)).toBe(20);
  });
});
