// The token wallets: tokens fetched while logged in and spent without
// logging in (design §11). Send tokens pay for what goes to another person,
// one per started 2.5 KiB of envelope (protocol/envelope.ts, sendTokensFor):
// one for anything but a long text. Media tokens pay one per started MiB of
// an upload, from a budget of their own. Kept on the device only.
//
// Tokens are fetched in batches ahead of time, at random moments, rarely
// right before a send: the issuer would otherwise see an account fetch one
// and, a moment later, an anonymous send. Only a wallet emptied faster than
// that (more spent in one burst than it keeps) has a send fetch first.
//
// Each build names one issuer key of each kind (config.ts): its tokens are
// fetched for that key, which the request names, and only those are counted
// and spent. After the keys are replaced, the server takes the old key's
// tokens only for a while, then not at all (docs/deployment.md, Rotating an
// issuer key), so they would fail sends. Other keys' tokens are kept until
// they expire, all the same: another copy of the app, on the other build,
// may be spending them.

import { blind, finalize, type IssuerKey } from '../crypto/blindrsa';
import { concat, fromBase64Url, toBase64Url } from '../crypto/encoding';
import type { Session } from '../net/session';
import { checkObject } from '../net/api';
import { epochOf, KEY_ID_OFFSET, LABEL_MEDIA_TOKEN, LABEL_SEND_TOKEN, TOKEN_INPUT_LENGTH, tokenInput } from '../protocol/token';
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
/**
 * Refill send tokens when fewer than this many are left: twice what the
 * longest message costs (7), so a refill in the background is almost always
 * done before a send finds the wallet short.
 */
export const LOW_WATER = 14;
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

/** Where what the server last said is left today is kept, per kind. */
const LEFT_META: Record<TokenKind, string> = { send: 'send-tokens-left', media: 'media-tokens-left' };
const DAY_SECONDS = 24 * 60 * 60;

/** Remembers how many more tokens of a kind the server will sign today (UTC). */
export async function rememberLeft(db: Database, kind: TokenKind, left: number, now = nowSeconds()): Promise<void> {
  await putMeta(db, LEFT_META[kind], { day: Math.floor(now / DAY_SECONDS), left });
}

/** How many more tokens of a kind the server said it will sign today; null if it hasn't said today. */
async function signableToday(db: Database, now: number, kind: TokenKind): Promise<number | null> {
  const value = await getMeta<{ day?: unknown; left?: unknown }>(db, LEFT_META[kind]);
  if (!value || value.day !== Math.floor(now / DAY_SECONDS) || !Number.isSafeInteger(value.left)) return null;
  return value.left as number;
}

/**
 * How many tokens of a kind can still be spent today: those here for the
 * build's key (keyId) plus what the server will still sign. Null until the
 * server has said so today.
 */
export async function budgetLeft(db: Database, keyId: Uint8Array, now = nowSeconds(), kind: TokenKind = 'send'): Promise<number | null> {
  const left = await signableToday(db, now, kind);
  return left === null ? null : left + (await countTokens(db, keyId, now, kind));
}

/**
 * How many tokens to ask for: `wanted`, but no more than the server said it
 * will still sign today. It signs a batch whole or not at all, so the day's
 * last few come only in a batch that small.
 */
export async function batchFor(db: Database, wanted: number, now = nowSeconds(), kind: TokenKind = 'send'): Promise<number> {
  const left = await signableToday(db, now, kind);
  return left === null ? wanted : Math.min(wanted, left);
}

async function stored(db: Database, kind: TokenKind): Promise<StoredToken[]> {
  const value = await getMeta<unknown>(db, KINDS[kind].meta);
  if (!Array.isArray(value)) return [];
  return value.filter((t): t is StoredToken => !!t && typeof t.token === 'string' && Number.isSafeInteger(t.epoch));
}

/**
 * Tokens still in date, of any key: this week's and last week's. What the
 * wallet is written back with, so that a copy of the app on another build
 * (another key, while keys are being replaced) keeps its tokens; those of a
 * retired key are gone within two weeks.
 */
function inDate(tokens: StoredToken[], now: number): StoredToken[] {
  const epoch = epochOf(now);
  return tokens.filter((t) => t.epoch === epoch || t.epoch === epoch - 1);
}

/** Tokens still accepted, for the build's issuer key (keyId): the only ones counted or spent. */
function usable(tokens: StoredToken[], now: number, keyId: Uint8Array): StoredToken[] {
  return inDate(tokens, now).filter((t) => forKey(t.token, keyId));
}

/** Whether a token is for the issuer key keyId: the key ID it carries (protocol/token.ts). */
function forKey(token: string, keyId: Uint8Array): boolean {
  let raw: Uint8Array;
  try {
    raw = fromBase64Url(token);
  } catch {
    return false;
  }
  if (raw.length <= TOKEN_INPUT_LENGTH || keyId.length !== TOKEN_INPUT_LENGTH - KEY_ID_OFFSET) return false;
  return keyId.every((b, i) => raw[KEY_ID_OFFSET + i] === b);
}

/** How many tokens of a kind are here for the build's key (keyId). */
export async function countTokens(db: Database, keyId: Uint8Array, now = nowSeconds(), kind: TokenKind = 'send'): Promise<number> {
  return usable(await stored(db, kind), now, keyId).length;
}

/**
 * Fetches a batch of tokens for this week: blinded, signed with the build's
 * issuer key (the request names it), unblinded. If the server doesn't hold
 * that key, it refuses with unknown_issuer_key (ApiError) before counting
 * the batch: this build is for a key it no longer takes, or not yet.
 *
 * With `below`, only if fewer than that of the build's key are here once
 * this holds the wallet's lock (another copy of the app may just have
 * topped it up). Returns how many of the build's key are here.
 */
export function refillTokens(
  db: Database,
  session: Session,
  issuer: TokenIssuer,
  count = TOKEN_BATCH,
  now = nowSeconds(),
  kind: TokenKind = 'send',
  below = Infinity,
): Promise<number> {
  const { meta, lock, path, label } = KINDS[kind];
  return withLock(lock, async () => {
    const held = usable(await stored(db, kind), now, issuer.keyId).length;
    if (held >= below) return held;
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
    const { signatures, left } = await session.call('POST', path, { blinded, keyId: toBase64Url(issuer.keyId) }, (v) => {
      const o = checkObject(v);
      const s = o.signatures;
      if (!Array.isArray(s) || s.length !== count || !s.every((x) => typeof x === 'string')) throw new Error('bad signatures');
      // How many more it will sign today (servers before this didn't say).
      const left = typeof o.left === 'number' && Number.isSafeInteger(o.left) && o.left >= 0 ? o.left : null;
      return { signatures: s as string[], left };
    });
    if (left !== null) await rememberLeft(db, kind, left, now);
    const fresh: StoredToken[] = [];
    for (let i = 0; i < count; i++) {
      const sig = await finalize(issuer.key, inputs[i]!, fromBase64Url(signatures[i]!), states[i]!);
      fresh.push({ token: toBase64Url(concat(inputs[i]!, sig)), epoch });
    }
    const kept = inDate(await stored(db, kind), now);
    await putMeta(db, meta, [...kept, ...fresh]);
    return usable(kept, now, issuer.keyId).length + fresh.length;
  });
}

/**
 * Takes `count` tokens to spend (the oldest still accepted, for the build's
 * key keyId), all or none: null if fewer are left, and then the wallet is
 * left as it is. Other keys' tokens stay, for another copy of the app.
 */
export function takeTokens(db: Database, keyId: Uint8Array, count: number, now = nowSeconds(), kind: TokenKind = 'send'): Promise<StoredToken[] | null> {
  return withLock(KINDS[kind].lock, async () => {
    const all = inDate(await stored(db, kind), now);
    const mine = usable(all, now, keyId).sort((a, b) => a.epoch - b.epoch);
    if (mine.length < count) return null;
    const taken = mine.slice(0, count);
    const gone = new Set(taken);
    await putMeta(db, KINDS[kind].meta, all.filter((t) => !gone.has(t)));
    return taken;
  });
}

/** Takes one token to spend (the oldest still accepted, for keyId), or null if none are left. */
export async function takeToken(db: Database, keyId: Uint8Array, now = nowSeconds(), kind: TokenKind = 'send'): Promise<StoredToken | null> {
  return (await takeTokens(db, keyId, 1, now, kind))?.[0] ?? null;
}

/** Puts back tokens that weren't spent (the send failed before reaching the server, or was refused before any was spent). */
export function returnTokens(db: Database, tokens: StoredToken[], kind: TokenKind = 'send'): Promise<void> {
  return withLock(KINDS[kind].lock, async () => {
    await putMeta(db, KINDS[kind].meta, [...tokens, ...(await stored(db, kind))]);
  });
}

/** Puts back a token that wasn't spent. */
export function returnToken(db: Database, token: string, epoch: number, kind: TokenKind = 'send'): Promise<void> {
  return returnTokens(db, [{ token, epoch }], kind);
}
