// The token wallets: tokens fetched while logged in and spent without
// logging in (design §11). Send tokens pay one per message to another
// person; media tokens pay one per started MiB of an upload, from a budget
// of their own. Kept on the device only.
//
// Tokens are fetched in batches, never right before a send: the issuer would
// otherwise see an account fetch one and, a moment later, an anonymous send.

import { blind, finalize, type IssuerKey } from '../crypto/blindrsa';
import { concat, fromBase64Url, toBase64Url } from '../crypto/encoding';
import type { Session } from '../net/session';
import { checkObject } from '../net/api';
import { epochOf, LABEL_MEDIA_TOKEN, LABEL_SEND_TOKEN, tokenInput } from '../protocol/token';
import { getMeta, putMeta, type Database } from '../storage/db';
import { withLock } from '../sync/locks';

export type TokenKind = 'send' | 'media';

/** Where each kind is kept, fetched, and how it is labelled. */
const KINDS: Record<TokenKind, { meta: string; lock: string; path: string; label: string }> = {
  send: { meta: 'send-tokens', lock: 'send-tokens', path: '/tokens', label: LABEL_SEND_TOKEN },
  media: { meta: 'media-tokens', lock: 'media-tokens', path: '/tokens/media', label: LABEL_MEDIA_TOKEN },
};

/** The most tokens the server signs in one request. */
export const MAX_BATCH = 50;
/** Batch size for send tokens. */
export const TOKEN_BATCH = 20;
/** Refill send tokens when fewer than this many are left. */
export const LOW_WATER = 10;
/** Batch size for media tokens: more than the largest upload costs (26). */
export const MEDIA_BATCH = 30;
/** Refill media tokens when fewer than the largest upload costs are left. */
export const MEDIA_LOW_WATER = 26;

export interface StoredToken {
  token: string;
  epoch: number;
}

export interface TokenIssuer {
  key: IssuerKey;
  keyId: Uint8Array<ArrayBuffer>;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

async function stored(db: Database, kind: TokenKind): Promise<StoredToken[]> {
  const value = await getMeta<unknown>(db, KINDS[kind].meta);
  if (!Array.isArray(value)) return [];
  return value.filter((t): t is StoredToken => !!t && typeof t.token === 'string' && Number.isSafeInteger(t.epoch));
}

/** Tokens still accepted: this week's and last week's. */
function usable(tokens: StoredToken[], now: number): StoredToken[] {
  const epoch = epochOf(now);
  return tokens.filter((t) => t.epoch === epoch || t.epoch === epoch - 1);
}

export async function countTokens(db: Database, now = nowSeconds(), kind: TokenKind = 'send'): Promise<number> {
  return usable(await stored(db, kind), now).length;
}

/** Fetches a batch of tokens for this week: blinded, signed, unblinded. */
export function refillTokens(
  db: Database,
  session: Session,
  issuer: TokenIssuer,
  count = TOKEN_BATCH,
  now = nowSeconds(),
  kind: TokenKind = 'send',
): Promise<number> {
  const { meta, lock, path, label } = KINDS[kind];
  return withLock(lock, async () => {
    const epoch = epochOf(now);
    const inputs: Uint8Array<ArrayBuffer>[] = [];
    const states: Awaited<ReturnType<typeof blind>>['state'][] = [];
    const blinded: string[] = [];
    for (let i = 0; i < count; i++) {
      const input = await tokenInput(epoch, issuer.keyId, label);
      const b = await blind(issuer.key, input);
      inputs.push(input);
      states.push(b.state);
      blinded.push(toBase64Url(b.blinded));
    }
    const { signatures } = await session.call('POST', path, { blinded }, (v) => {
      const s = checkObject(v).signatures;
      if (!Array.isArray(s) || s.length !== count || !s.every((x) => typeof x === 'string')) throw new Error('bad signatures');
      return { signatures: s as string[] };
    });
    const fresh: StoredToken[] = [];
    for (let i = 0; i < count; i++) {
      const sig = await finalize(issuer.key, inputs[i]!, fromBase64Url(signatures[i]!), states[i]!);
      fresh.push({ token: toBase64Url(concat(inputs[i]!, sig)), epoch });
    }
    const kept = usable(await stored(db, kind), now);
    await putMeta(db, meta, [...kept, ...fresh]);
    return kept.length + fresh.length;
  });
}

/** Takes one token to spend (the oldest still accepted), or null if none are left. */
export function takeToken(db: Database, now = nowSeconds(), kind: TokenKind = 'send'): Promise<StoredToken | null> {
  return withLock(KINDS[kind].lock, async () => {
    const tokens = usable(await stored(db, kind), now).sort((a, b) => a.epoch - b.epoch);
    const next = tokens.shift();
    await putMeta(db, KINDS[kind].meta, tokens);
    return next ?? null;
  });
}

/** Puts back a token that wasn't spent (the send failed before reaching the server). */
export function returnToken(db: Database, token: string, epoch: number, kind: TokenKind = 'send'): Promise<void> {
  return withLock(KINDS[kind].lock, async () => {
    await putMeta(db, KINDS[kind].meta, [{ token, epoch }, ...(await stored(db, kind))]);
  });
}
