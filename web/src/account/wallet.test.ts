import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { i2osp, modPow, os2ip, verify, type IssuerKey } from '../crypto/blindrsa';
import { fromBase64Url, toBase64Url, toHex } from '../crypto/encoding';
import { ApiError } from '../net/api';
import type { Session } from '../net/session';
import { challenge, EPOCH_SECONDS, epochOf, LABEL_MEDIA_TOKEN, TOKEN_INPUT_LENGTH } from '../protocol/token';
import { openDatabase } from '../storage/db';
import { batchFor, budgetLeft, countTokens, refillTokens, rememberLeft, returnToken, returnTokens, takeToken, takeTokens, type TokenIssuer } from './wallet';

let n = 0;
const NOW = 1_800_000_000;

/**
 * An issuer with a fresh key, and a fake session whose POST /tokens signs
 * like the server: with that key, if the request names it, and otherwise
 * refuses before counting anything (unknown_issuer_key).
 */
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
      const { blinded, keyId: named } = body as { blinded: string[]; keyId?: string };
      if (named !== toBase64Url(keyId)) throw new ApiError(409, 'unknown_issuer_key');
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
    expect(await countTokens(db, issuer.keyId, NOW, 'media')).toBe(3);
    // The send wallet is untouched.
    expect(await countTokens(db, issuer.keyId, NOW)).toBe(0);
    expect(await takeToken(db, issuer.keyId, NOW)).toBeNull();

    const t = await takeToken(db, issuer.keyId, NOW, 'media');
    const raw = fromBase64Url(t!.token);
    expect(toHex(raw.slice(34, 66))).toBe(toHex(await challenge(epochOf(NOW), LABEL_MEDIA_TOKEN)));
    expect(toHex(raw.slice(34, 66))).not.toBe(toHex(await challenge(epochOf(NOW))));
    expect(await verify(issuer.key, raw.slice(0, TOKEN_INPUT_LENGTH), raw.slice(TOKEN_INPUT_LENGTH))).toBe(true);
    await returnToken(db, t!.token, t!.epoch, 'media');
    expect(await countTokens(db, issuer.keyId, NOW, 'media')).toBe(3);
  });

  it("knows what's left today: unspent here plus what the server will still sign", async () => {
    const db = await openDatabase(`wallet-test-${n++}`);
    const { issuer, session } = await issuerAndSession();
    expect(await budgetLeft(db, issuer.keyId, NOW)).toBeNull();
    await refillTokens(db, session, issuer, 20, NOW);
    expect(await budgetLeft(db, issuer.keyId, NOW)).toBe(1000);
    await takeToken(db, issuer.keyId, NOW);
    expect(await budgetLeft(db, issuer.keyId, NOW)).toBe(999);
    // The server's count is for its day (UTC): unknown the next.
    expect(await budgetLeft(db, issuer.keyId, NOW + 24 * 60 * 60)).toBeNull();
  });

  it('fills with valid tokens and hands out each once', async () => {
    const db = await openDatabase(`wallet-test-${n++}`);
    const { issuer, session, signed } = await issuerAndSession();
    expect(await refillTokens(db, session, issuer, 3, NOW)).toBe(3);
    expect(signed()).toBe(3);
    expect(await countTokens(db, issuer.keyId, NOW)).toBe(3);

    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const token = (await takeToken(db, issuer.keyId, NOW))!.token;
      expect(seen.has(token)).toBe(false);
      seen.add(token);
      const raw = fromBase64Url(token);
      expect(raw).toHaveLength(TOKEN_INPUT_LENGTH + 256);
      expect(raw.slice(66, 98)).toEqual(issuer.keyId);
      expect(await verify(issuer.key, raw.slice(0, TOKEN_INPUT_LENGTH), raw.slice(TOKEN_INPUT_LENGTH))).toBe(true);
    }
    expect(await takeToken(db, issuer.keyId, NOW)).toBeNull();
  });

  it("keeps last week's tokens and drops older ones", async () => {
    const db = await openDatabase(`wallet-test-${n++}`);
    const { issuer, session } = await issuerAndSession();
    await refillTokens(db, session, issuer, 2, NOW);
    expect(await countTokens(db, issuer.keyId, NOW + EPOCH_SECONDS)).toBe(2);
    expect(await countTokens(db, issuer.keyId, NOW + 2 * EPOCH_SECONDS)).toBe(0);
    expect(await takeToken(db, issuer.keyId, NOW + 2 * EPOCH_SECONDS)).toBeNull();
  });

  it('takes the oldest first and can take one back', async () => {
    const db = await openDatabase(`wallet-test-${n++}`);
    const { issuer, session } = await issuerAndSession();
    await refillTokens(db, session, issuer, 1, NOW - EPOCH_SECONDS);
    await refillTokens(db, session, issuer, 1, NOW);
    const lastWeek = await challenge(epochOf(NOW) - 1);
    const thisWeek = await challenge(epochOf(NOW));
    const first = (await takeToken(db, issuer.keyId, NOW))!;
    expect(fromBase64Url(first.token).slice(34, 66)).toEqual(lastWeek);
    expect(first.epoch).toBe(epochOf(NOW) - 1);
    await returnToken(db, first.token, first.epoch);
    expect(await takeToken(db, issuer.keyId, NOW)).toEqual(first);
    expect(fromBase64Url((await takeToken(db, issuer.keyId, NOW))!.token).slice(34, 66)).toEqual(thisWeek);
  });

  it('takes as many as a send costs, all or none, and takes them all back', async () => {
    const db = await openDatabase(`wallet-test-${n++}`);
    const { issuer, session } = await issuerAndSession();
    await refillTokens(db, session, issuer, 5, NOW);
    expect(await takeTokens(db, issuer.keyId, 6, NOW)).toBeNull();
    expect(await countTokens(db, issuer.keyId, NOW)).toBe(5);
    const four = (await takeTokens(db, issuer.keyId, 4, NOW))!;
    expect(new Set(four.map((t) => t.token)).size).toBe(4);
    expect(await countTokens(db, issuer.keyId, NOW)).toBe(1);
    await returnTokens(db, four);
    expect(await countTokens(db, issuer.keyId, NOW)).toBe(5);
    expect(await takeTokens(db, issuer.keyId, 4, NOW)).toEqual(four);
  });

  it("drops tokens of any key but the build's, even older ones it would hand out first", async () => {
    const db = await openDatabase(`wallet-test-${n++}`);
    // Last week's tokens of the old key, from before the keys were
    // replaced; a standby key published for the next rotation, which this
    // build doesn't name; and the build's own key.
    const old = await issuerAndSession();
    const standby = await issuerAndSession();
    const current = await issuerAndSession();
    await refillTokens(db, old.session, old.issuer, 3, NOW - EPOCH_SECONDS);
    await refillTokens(db, standby.session, standby.issuer, 2, NOW);
    await returnTokens(db, [{ token: 'not base64!', epoch: epochOf(NOW) }, { token: toBase64Url(new Uint8Array(98)), epoch: epochOf(NOW) }]);
    // The build's key: none of those count, or come out.
    expect(await countTokens(db, current.issuer.keyId, NOW)).toBe(0);
    expect(await budgetLeft(db, current.issuer.keyId, NOW)).toBe(998);
    expect(await takeToken(db, current.issuer.keyId, NOW)).toBeNull();

    await refillTokens(db, current.session, current.issuer, 2, NOW);
    expect(await countTokens(db, current.issuer.keyId, NOW)).toBe(2);
    // Its own key's tokens stay good next week too, standby or not.
    expect(await countTokens(db, current.issuer.keyId, NOW + EPOCH_SECONDS)).toBe(2);
    for (let i = 0; i < 2; i++) {
      const raw = fromBase64Url((await takeToken(db, current.issuer.keyId, NOW))!.token);
      expect(raw.slice(66, 98)).toEqual(current.issuer.keyId);
      expect(await verify(current.issuer.key, raw.slice(0, TOKEN_INPUT_LENGTH), raw.slice(TOKEN_INPUT_LENGTH))).toBe(true);
    }
    expect(await takeToken(db, current.issuer.keyId, NOW)).toBeNull();
    // Dropped, not just skipped: gone for a build of either other key too.
    expect(await countTokens(db, old.issuer.keyId, NOW)).toBe(0);
    expect(await countTokens(db, standby.issuer.keyId, NOW)).toBe(0);
  });

  it("names the build's key, and a server without it signs and counts nothing", async () => {
    const db = await openDatabase(`wallet-test-${n++}`);
    const { issuer, session, signed } = await issuerAndSession();
    await refillTokens(db, session, issuer, 2, NOW);
    // A build for a key this server doesn't hold (one it retired).
    const retired = await issuerAndSession();
    await expect(refillTokens(db, session, retired.issuer, 20, NOW)).rejects.toMatchObject({ code: 'unknown_issuer_key' });
    expect(signed()).toBe(2);
    expect(await countTokens(db, issuer.keyId, NOW)).toBe(2);
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
