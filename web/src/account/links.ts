// This account's link (design §8). An account has one link at a time, which
// it can replace: the new link has a new address (ID) and new encryption
// keys, but the same signing key, whose fingerprint is in the link. Senders'
// tags are made from that fingerprint, so after a replacement the same
// people get the same labels, and blocked people stay blocked. Keys are
// generated here and sealed in the vault (they are copied to new devices
// later).

import {
  exportPublicKey,
  fingerprint,
  generateCopyableAgreementKey,
  generateCopyableSigningKey,
  importSigningPublicKey,
  SIGNING_IMPORT,
} from '../crypto/keys';
import { LABEL_LINK_KEY, sign } from '../crypto/signing';
import { fromBase64Url, toBase64Url } from '../crypto/encoding';
import { seal, unseal } from '../crypto/vault';
import { ApiError, checkObject, type Api } from '../net/api';
import type { Session } from '../net/session';
import { hourFloor } from '../protocol/device-list';
import { BundleMismatch, checkBundle, KEY_VALIDITY_SECONDS, keyParts, newLinkId, verifyBundle, type Bundle, type LinkRef } from '../protocol/link';
import { deleteMeta, deleteSealed, getKey, getMeta, getSealed, listSealed, putMeta, putSealed, type Database } from '../storage/db';
import { withLock } from '../sync/locks';
import {
  hasKey,
  indexedNames,
  indexKey,
  KEY_RETENTION_MS,
  linkKeysMailbox,
  scheduleKeyDeletion,
  setLinkKeysMailbox,
  unindexKeys,
  type KeyEntry,
} from '../messaging/keys';

const META_LINKS = 'links';
/** A link change sent whose outcome isn't known yet (LinkChange). */
const META_CHANGE = 'link-change';
/** The account's link signing key (sealed), and its public key (meta). */
const SIGNING = 'link-signing';
const META_SIGNING_PUBLIC = 'link-signing-public';
const KEY_VAULT = 'vault-key';
const LOCK = 'links';
const ID_ATTEMPTS = 3;
const ID = /^[A-Za-z0-9_-]{11}$/;
const FP = /^[A-Za-z0-9_-]{43}$/;
const MAILBOX = /^[A-Za-z0-9_-]{22}$/;

export interface LinkRecord extends LinkRef {
  /** The encryption keys sealed for this link: validity window and public key (base64url). */
  keys: { from: number; until: number; pub?: string }[];
  /** Unix seconds when the link next gets a new encryption key (weekly, jittered). */
  rotateAt?: number;
  /**
   * Its intro mailbox, where first messages arrive: the only one an envelope
   * written for its keys counts through. Missing for a link made before it
   * was kept, until the link's bundle says (messaging/engine.ts).
   */
  mailbox?: string;
}

/** Link encryption keys are replaced every 6 to 9 days (design D11). */
const ROTATE_MIN = 6 * 24 * 3600;
const ROTATE_SPREAD = 3 * 24 * 3600;
const nextRotation = (now: number) => now + ROTATE_MIN + Math.floor(Math.random() * ROTATE_SPREAD);

/**
 * How long a new link the server doesn't show is still looked for at upkeep:
 * well past any request that could still be under way (the app stops
 * waiting for an answer after 15 seconds, the server works on a request for
 * at most 10) and the second or so its bundle reads can lag.
 */
const CHANGE_SETTLES_AFTER = 10 * 60;

/** A link encryption key as it was sent: the public key and signature in base64url. */
interface SentKey {
  key: string;
  from: number;
  until: number;
  signature: string;
}

/**
 * A change sent to the server whose outcome isn't known: its answer was
 * lost (a timeout, a dropped connection, a failure on the way back), or the
 * app closed meanwhile. Either a new link `id` (in place of `replaces`, if
 * set) or a new encryption key for link `id`; `at` is when it was first
 * sent, in Unix seconds. Its key is sealed and indexed before it's sent, so
 * whatever the server did, first messages written for it can be opened; the
 * next upkeep (or link action) asks the link's bundle what the server has
 * and takes that (settle). At most one at a time.
 */
type LinkChange =
  | { kind: 'link'; id: string; fingerprint: string; signingKey: string; key: SentKey; replaces?: string; at: number }
  | { kind: 'key'; id: string; key: SentKey; at: number };

/**
 * The server turned the request down, so it changed nothing. Anything else
 * (no answer, one that can't be read, the server failing) may come after it
 * made the change.
 */
const refused = (err: unknown): err is ApiError => err instanceof ApiError && err.status >= 400 && err.status < 500;

/** What the server says about this account's links. */
export interface AccountInfo {
  canCreateLinks: boolean;
  admin: boolean;
  links: number;
  maxLinks: number;
  /** Whether Telegram notices are set up and not turned off. */
  notices: boolean;
}

export function checkAccountInfo(value: unknown): AccountInfo {
  const v = checkObject(value);
  const { canCreateLinks, admin, links, maxLinks, notices } = v;
  if (typeof canCreateLinks !== 'boolean' || typeof admin !== 'boolean') throw new Error('bad account');
  if (!Number.isSafeInteger(links) || !Number.isSafeInteger(maxLinks)) throw new Error('bad account');
  return { canCreateLinks, admin, links: links as number, maxLinks: maxLinks as number, notices: notices === true };
}

/** Vault names for a link's keys (signingName: links made when each had its own signing key). */
const signingName = (id: string) => `link:${id}:signing`;
const keyPrefix = (id: string) => `link:${id}:key:`;
export const keyName = (id: string, from: number) => `${keyPrefix(id)}${from}`;
const changeName = (change: LinkChange) => keyName(change.id, change.key.from);

export async function listLinks(db: Database): Promise<LinkRecord[]> {
  const value = await getMeta<unknown>(db, META_LINKS);
  if (!Array.isArray(value)) return [];
  return value.filter(
    (r): r is LinkRecord =>
      !!r &&
      typeof r === 'object' &&
      ID.test((r as LinkRecord).id) &&
      FP.test((r as LinkRecord).fingerprint) &&
      Array.isArray((r as LinkRecord).keys),
  );
}

/** The account's link signing key, created with its first link and kept for every link after it. */
async function linkSigningKey(db: Database, vaultKey: CryptoKey): Promise<{ privateKey: CryptoKey; publicKey: Uint8Array<ArrayBuffer>; fp: string }> {
  const sealed = await getSealed(db, SIGNING);
  const pub = await getMeta<unknown>(db, META_SIGNING_PUBLIC);
  if (sealed && typeof pub === 'string') {
    const publicKey = fromBase64Url(pub);
    return {
      privateKey: await unseal(vaultKey, sealed, SIGNING, SIGNING_IMPORT, ['sign']),
      publicKey,
      fp: await fingerprint(await importSigningPublicKey(publicKey)),
    };
  }
  const pair = await generateCopyableSigningKey();
  const publicKey = await exportPublicKey(pair.publicKey);
  await putSealed(db, SIGNING, await seal(vaultKey, pair.privateKey, SIGNING));
  await putMeta(db, META_SIGNING_PUBLIC, toBase64Url(publicKey));
  return { privateKey: pair.privateKey, publicKey, fp: await fingerprint(pair.publicKey) };
}

/**
 * Creates this account's link. Throws ApiError invitation_required, or
 * link_limit if it has one. A link change whose answer was lost is settled
 * first: if the server made it, its link is the one created.
 */
export function createLink(db: Database, session: Session, api: Api, now: () => number = () => Math.floor(Date.now() / 1000)): Promise<LinkRecord> {
  return withLock(LOCK, async () => (await settle(db, session, api, now(), true)) ?? makeLink(db, session, now, null));
}

/**
 * Replaces this account's link with a new one (or creates one if there is
 * none): the old link stops working at once. Conversations carry on, since
 * they no longer go through the link. A link change whose answer was lost
 * is settled first: if the server made it, its link is the replacement.
 */
export function replaceLink(db: Database, session: Session, api: Api, now: () => number = () => Math.floor(Date.now() / 1000)): Promise<LinkRecord> {
  return withLock(LOCK, async () => {
    const settled = await settle(db, session, api, now(), true);
    if (settled) return settled;
    const links = await listLinks(db);
    const current = links[links.length - 1];
    // Links from when an account could have several: only one stays.
    for (const extra of links.slice(0, -1)) await revoke(db, session, extra.id);
    if (!current) return makeLink(db, session, now, null);
    try {
      return await makeLink(db, session, now, current);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'not_found')) throw err;
      // Gone already (revoked elsewhere): just make a new one.
      await revoke(db, session, current.id);
      return makeLink(db, session, now, null);
    }
  });
}

/** New encryption keys, sealed here first, then the bundle on the server (in place of replaces, if set). */
async function makeLink(db: Database, session: Session, now: () => number, replaces: LinkRecord | null): Promise<LinkRecord> {
  const vaultKey = await getKey(db, KEY_VAULT);
  if (!vaultKey) throw new Error('no vault key');
  const signing = await linkSigningKey(db, vaultKey);
  const encryption = await generateCopyableAgreementKey();
  const encryptionKey = await exportPublicKey(encryption.publicKey);
  // Back-date by a random few hours, so the keys of two links made around
  // the same time don't carry the same times.
  const from = hourFloor(now()) - 3600 * Math.floor(Math.random() * 12);
  const until = from + KEY_VALIDITY_SECONDS;
  const signature = await sign(signing.privateKey, LABEL_LINK_KEY, ...keyParts(encryptionKey, from, until));

  for (let attempt = 1; ; attempt++) {
    const change: LinkChange & { kind: 'link' } = {
      kind: 'link',
      id: newLinkId(),
      fingerprint: signing.fp,
      signingKey: toBase64Url(signing.publicKey),
      key: { key: toBase64Url(encryptionKey), from, until, signature: toBase64Url(signature) },
      ...(replaces ? { replaces: replaces.id } : {}),
      at: now(),
    };
    // Kept before the server knows the link, so a link never exists without
    // its keys on this device, and one whose answer is lost is found later.
    await begin(db, vaultKey, encryption.privateKey, change, { id: change.id, fingerprint: change.fingerprint });
    let created: Record<string, unknown>;
    try {
      created = await sendLink(session, change);
    } catch (err) {
      // Without a clear refusal the server may have made it: kept, to settle.
      if (!refused(err)) throw err;
      await forget(db, change, null);
      if (err.code === 'conflict' && attempt < ID_ATTEMPTS) continue;
      throw err;
    }
    return adoptLink(db, change, mailboxOf(created), now());
  }
}

/** Sends a new link to the server, exactly as its change notes it. */
function sendLink(session: Session, change: LinkChange & { kind: 'link' }): Promise<Record<string, unknown>> {
  const { id, signingKey, key, replaces } = change;
  return session.call('POST', '/links', { id, signingKey, keys: [key], ...(replaces ? { replaces } : {}) }, checkObject, { sign: true });
}

/**
 * The intro mailbox the server picked for a new link. Without a valid one
 * here, it's learned from the bundle later, as for a link from before it
 * was kept.
 */
function mailboxOf(created: Record<string, unknown>): string | undefined {
  return typeof created.mailbox === 'string' && MAILBOX.test(created.mailbox) ? created.mailbox : undefined;
}

/**
 * Gives the link a new encryption key when its turn comes (design D11). The
 * bundle then lists only the new key, so new first messages go to it; the
 * old key is kept until anything written to it has expired from the inbox.
 * Senders not answered yet fetch the current key before writing again. Run
 * at upkeep, after settleLinkChange; not while a change is still unsettled.
 * `now` in Unix seconds. Returns whether it rotated.
 */
export function rotateLinkKey(db: Database, session: Session, now: number): Promise<boolean> {
  return withLock(LOCK, async () => {
    if (await pendingChange(db)) return false;
    const links = await listLinks(db);
    const link = links[links.length - 1];
    if (!link) return false;
    if (link.rotateAt === undefined) {
      // A link from before rotation: start its schedule.
      await putMeta(db, META_LINKS, links.map((l) => (l.id === link.id ? { ...link, rotateAt: nextRotation(now) } : l)));
      return false;
    }
    if (now < link.rotateAt) return false;
    const vaultKey = await getKey(db, KEY_VAULT);
    if (!vaultKey) return false;
    const signingKey = await signingKeyFor(db, vaultKey, link);
    if (!signingKey) return false;

    // Back-dated like a new link's, but after every key this link has had,
    // since senders take the newest, and a key's `from` names it in the
    // vault: a key kept after a change that wasn't taken (forget) is sealed
    // and indexed though not on the record, and must not be overwritten.
    // No hour left after them yet: the next upkeep tries again.
    const newest = Math.max(...(await takenFroms(db, link)));
    if (newest + 3600 > hourFloor(now)) return false;
    const encryption = await generateCopyableAgreementKey();
    const encryptionKey = await exportPublicKey(encryption.publicKey);
    const from = Math.max(hourFloor(now) - 3600 * Math.floor(Math.random() * 12), newest + 3600);
    const until = from + KEY_VALIDITY_SECONDS;
    const signature = await sign(signingKey, LABEL_LINK_KEY, ...keyParts(encryptionKey, from, until));
    const change: LinkChange & { kind: 'key' } = {
      kind: 'key',
      id: link.id,
      key: { key: toBase64Url(encryptionKey), from, until, signature: toBase64Url(signature) },
      at: now,
    };
    // Indexed before it's published: if the answer is lost, the bundle may
    // list only this key, and first messages to it must still open.
    await begin(db, vaultKey, encryption.privateKey, change, { id: link.id, fingerprint: link.fingerprint, ...(link.mailbox ? { mailbox: link.mailbox } : {}) });
    try {
      await session.call('PUT', `/links/${link.id}/keys`, { keys: [change.key] }, checkObject, { sign: true });
    } catch (err) {
      // Without a clear refusal the server may have taken it: kept, to settle.
      if (!refused(err)) throw err;
      await forget(db, change, null);
      // Gone (replaced or revoked elsewhere): nothing to rotate.
      if (err.code === 'not_found') return false;
      throw err;
    }
    return adoptKey(db, change, now);
  });
}

/**
 * Finds out what became of a link change whose answer was lost, from the
 * link's bundle, and takes that: run at upkeep, before anything else that
 * needs the link. `now` in Unix seconds. Returns whether the account's link
 * changed (a new link the server made is now the account's). Throws
 * (keeping the change) while the bundle can't be fetched.
 */
export function settleLinkChange(db: Database, session: Session, api: Api, now: number): Promise<boolean> {
  return withLock(LOCK, async () => (await settle(db, session, api, now, false)) !== null);
}

/** The link change waiting to be settled, if any. */
async function pendingChange(db: Database): Promise<LinkChange | null> {
  const c = await getMeta<Partial<Record<string, unknown>>>(db, META_CHANGE);
  const key = c?.key as Partial<SentKey> | undefined;
  if (!c || typeof c.id !== 'string' || !ID.test(c.id) || !Number.isSafeInteger(c.at)) return null;
  if (!key || typeof key.key !== 'string' || typeof key.signature !== 'string' || !Number.isSafeInteger(key.from) || !Number.isSafeInteger(key.until)) return null;
  if (c.kind === 'key') return c as LinkChange;
  if (c.kind !== 'link' || typeof c.fingerprint !== 'string' || !FP.test(c.fingerprint) || typeof c.signingKey !== 'string') return null;
  return c.replaces === undefined || (typeof c.replaces === 'string' && ID.test(c.replaces)) ? (c as LinkChange) : null;
}

/**
 * Notes a change, then seals and indexes its key, before it's sent: in
 * that order, so whenever the app closes, the change's key is never left
 * without the note that settles it (a note whose key isn't sealed was
 * never sent: settle). Never over a key already kept under the same name.
 */
async function begin(db: Database, vaultKey: CryptoKey, privateKey: CryptoKey, change: LinkChange, link: NonNullable<KeyEntry['link']>): Promise<void> {
  const name = changeName(change);
  if ((await getSealed(db, name)) || (await indexedNames(db)).has(name)) throw new Error(`key ${name} exists`);
  await putMeta(db, META_CHANGE, change);
  await putSealed(db, name, await seal(vaultKey, privateKey, name));
  await indexKey(db, fromBase64Url(change.key.key), { name, link });
}

/**
 * The `from` of every key this link has had that may still be kept: on its
 * record, sealed in the vault, or in the index (a key kept after a change
 * that wasn't taken is on the last two only).
 */
async function takenFroms(db: Database, link: LinkRecord): Promise<number[]> {
  const prefix = keyPrefix(link.id);
  const names = [...(await listSealed(db, prefix)), ...[...(await indexedNames(db))].filter((n) => n.startsWith(prefix))];
  return [...link.keys.map((k) => k.from), ...names.map((n) => Number(n.slice(prefix.length))).filter((from) => Number.isSafeInteger(from))];
}

/**
 * Drops a change that didn't happen. Its key goes at once if nobody can have
 * been offered it (`retireFrom` null); otherwise (a bundle read can lag a
 * moment) it's kept like a replaced key, until 35 days after retireFrom
 * (Unix seconds).
 */
async function forget(db: Database, change: LinkChange, retireFrom: number | null): Promise<void> {
  const name = changeName(change);
  if (retireFrom !== null && (await hasKey(db, change.key.key))) {
    await scheduleKeyDeletion(db, (e) => e.name === name, retireFrom * 1000 + KEY_RETENTION_MS);
  } else {
    await unindexKeys(db, (e) => e.name === name);
    await deleteSealed(db, name);
  }
  await deleteMeta(db, META_CHANGE);
}

/** Takes a new link the server made: it becomes the account's link, in place of the one it replaces. */
async function adoptLink(db: Database, change: LinkChange & { kind: 'link' }, mailbox: string | undefined, now: number): Promise<LinkRecord> {
  const { id, fingerprint, key, replaces } = change;
  const record: LinkRecord = {
    id,
    fingerprint,
    keys: [{ from: key.from, until: key.until, pub: key.key }],
    rotateAt: nextRotation(change.at),
    ...(mailbox ? { mailbox } : {}),
  };
  await putMeta(db, META_LINKS, [...(await listLinks(db)).filter((l) => l.id !== replaces && l.id !== id), record]);
  if (replaces) {
    // Its keys stay until first messages sent before the replacement can
    // no longer be waiting in the inbox; loose ones an older version left
    // open nothing, and go now (backfill no longer looks at the old link).
    await scheduleKeyDeletion(db, (e) => e.link?.id === replaces, now * 1000 + KEY_RETENTION_MS);
    for (const name of await looseLinkKeys(db, replaces)) await deleteSealed(db, name);
  }
  // First messages to the link are wrapped to this key, and come through its intro mailbox.
  await indexKey(db, fromBase64Url(key.key), { name: changeName(change), link: { id, fingerprint, ...(mailbox ? { mailbox } : {}) } });
  await deleteMeta(db, META_CHANGE);
  return record;
}

/** Takes a new key the server published for the link: the others go 35 days on. Returns whether the link is still ours. */
async function adoptKey(db: Database, change: LinkChange & { kind: 'key' }, now: number): Promise<boolean> {
  const links = await listLinks(db);
  const link = links.find((l) => l.id === change.id);
  if (!link) {
    await forget(db, change, now);
    return false;
  }
  const name = changeName(change);
  await scheduleKeyDeletion(db, (e) => e.link?.id === link.id && e.name !== name, now * 1000 + KEY_RETENTION_MS);
  const { from, until, key } = change.key;
  const changed: LinkRecord = {
    ...link,
    // Keys deleted long ago drop off the record.
    keys: [...link.keys.filter((k) => k.until + KEY_RETENTION_MS / 1000 > now && k.from !== from), { from, until, pub: key }],
    rotateAt: nextRotation(change.at),
  };
  await putMeta(db, META_LINKS, links.map((l) => (l.id === link.id ? changed : l)));
  await deleteMeta(db, META_CHANGE);
  return true;
}

/**
 * Settles the link change waiting, if any, by what the link's bundle
 * shows, and returns the new link if it was one the server made.
 * - Its key in the bundle: the server made the change, which is taken as
 *   if the answer had come.
 * - A new key the bundle doesn't list (or no such link): it wasn't taken.
 *   The key is kept 35 days, in case it was offered for a moment, and the
 *   next rotation makes another.
 * - A new link the server doesn't show: when the user asks again (`again`),
 *   sent again as it was, with the same ID, so the server can't make it
 *   twice. Refused, it may have been made after all (its ID taken, the
 *   account at its limit, the link it replaces gone), so the bundle is asked
 *   once more; still not shown, the change is kept and the refusal thrown:
 *   bundle reads can lag a moment behind a change, so "not there" is
 *   believed only at upkeep, 10 minutes after it was last sent.
 * - A link of that ID that isn't ours: ours wasn't made.
 * - A change whose key isn't sealed was never sent (the app closed, or
 *   storage failed, before): dropped.
 */
async function settle(db: Database, session: Session, api: Api, now: number, again: boolean): Promise<LinkRecord | null> {
  const change = await pendingChange(db);
  if (!change) return null;
  if (!(await getSealed(db, changeName(change)))) {
    await forget(db, change, null);
    return null;
  }
  if (change.kind === 'key') {
    const link = (await listLinks(db)).find((l) => l.id === change.id);
    if (link && typeof (await lookUp(api, change, link.fingerprint)) === 'object') await adoptKey(db, change, now);
    else await forget(db, change, now);
    return null;
  }
  const found = await lookUp(api, change, change.fingerprint);
  if (typeof found === 'object') return adoptLink(db, change, found.mailbox, now);
  if (found === 'other') {
    await forget(db, change, null);
    return null;
  }
  if (!again) {
    if (Math.abs(now - change.at) >= CHANGE_SETTLES_AFTER) await forget(db, change, null);
    return null;
  }
  // Sent again now: upkeep's 10 minutes count from here.
  const resent = { ...change, at: now };
  await putMeta(db, META_CHANGE, resent);
  let created: Record<string, unknown> | null = null;
  let refusal: ApiError | null = null;
  try {
    created = await sendLink(session, resent);
  } catch (err) {
    if (!refused(err)) throw err;
    refusal = err;
  }
  if (created) return adoptLink(db, resent, mailboxOf(created), now);
  const after = await lookUp(api, resent, resent.fingerprint);
  if (typeof after === 'object') return adoptLink(db, resent, after.mailbox, now);
  if (after === 'gone') throw refusal!;
  await forget(db, resent, null);
  return null;
}

/**
 * What the server has of a change: the link's bundle, signed by our link
 * signing key, with the change's key in it; 'other' if the link is there
 * without that key, or isn't ours; 'gone' if there is no such link. Throws
 * while that can't be told (out of reach, or refused for now).
 */
async function lookUp(api: Api, change: LinkChange, fingerprint: string): Promise<Bundle | 'other' | 'gone'> {
  let bundle: Bundle;
  try {
    bundle = await api.request('GET', `/links/${change.id}`, {}, checkBundle);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'not_found') return 'gone';
    throw err;
  }
  try {
    // As of its newest key's start, so keys that lapsed meanwhile still check.
    await verifyBundle({ id: change.id, fingerprint }, bundle, Math.max(...bundle.keys.map((k) => k.from)));
  } catch (err) {
    if (err instanceof BundleMismatch) return 'other';
    throw err;
  }
  return bundle.keys.some((k) => toBase64Url(k.key) === change.key.key) ? bundle : 'other';
}

/**
 * Keys sealed for a link that the index doesn't name, other than an
 * unsettled change's: an older version sealed a new key and published it,
 * but the app closed before it indexed the key. Backfill indexes those the
 * link's bundle lists (messaging/engine.ts). Read in this order (index,
 * vault, change), so the key of a change under way, which is noted, sealed
 * and indexed in that order, never shows here.
 */
export async function looseLinkKeys(db: Database, linkId: string): Promise<string[]> {
  const indexed = await indexedNames(db);
  const sealed = await listSealed(db, keyPrefix(linkId));
  const change = await pendingChange(db);
  return sealed.filter((name) => !indexed.has(name) && !(change && name === changeName(change)));
}

/**
 * Deletes loose keys of a link (looseLinkKeys) that its bundle doesn't list
 * and that are older than its newest key (`newest`, Unix seconds): they can
 * never be offered again, and open nothing. Checked again under the links
 * lock, so a key being published meanwhile is never taken for one.
 */
export function dropLooseLinkKeys(db: Database, linkId: string, names: string[], newest: number): Promise<void> {
  return withLock(LOCK, async () => {
    const loose = new Set(await looseLinkKeys(db, linkId));
    for (const name of names) {
      if (loose.has(name) && Number(name.slice(keyPrefix(linkId).length)) < newest) await deleteSealed(db, name);
    }
  });
}

/**
 * The intro mailbox of one of our links, if known: the current link's, or a
 * replaced one's while its keys are kept (35 days, longer than anything sent
 * to it can wait in the inbox).
 */
export async function introMailbox(db: Database, id: string): Promise<string | undefined> {
  return (await listLinks(db)).find((l) => l.id === id)?.mailbox ?? (await linkKeysMailbox(db, id));
}

/** Records the intro mailbox of a link made before it was kept, on the link and its keys. */
export function setLinkMailbox(db: Database, id: string, mailbox: string): Promise<void> {
  if (!MAILBOX.test(mailbox)) return Promise.reject(new Error('bad mailbox'));
  return withLock(LOCK, async () => {
    const links = await listLinks(db);
    if (links.some((l) => l.id === id && l.mailbox !== mailbox)) {
      await putMeta(db, META_LINKS, links.map((l) => (l.id === id ? { ...l, mailbox } : l)));
    }
    await setLinkKeysMailbox(db, id, mailbox);
  });
}

/** The private key that signs this link's encryption keys. */
async function signingKeyFor(db: Database, vaultKey: CryptoKey, link: LinkRecord): Promise<CryptoKey | null> {
  const account = await linkSigningKey(db, vaultKey);
  if (account.fp === link.fingerprint) return account.privateKey;
  // A link made when each had its own signing key.
  const sealed = await getSealed(db, signingName(link.id));
  return sealed ? unseal(vaultKey, sealed, signingName(link.id), SIGNING_IMPORT, ['sign']) : null;
}

/**
 * Revokes a link and deletes its keys. A link the server no longer has counts
 * as revoked. The signing key stays, for the next link. A replacement of it
 * whose answer was lost is revoked too, first: the server may have made it,
 * and the user asked for the link to stop working.
 */
export function revokeLink(db: Database, session: Session, id: string): Promise<void> {
  return withLock(LOCK, () => revoke(db, session, id));
}

async function revoke(db: Database, session: Session, id: string): Promise<void> {
  const change = await pendingChange(db);
  if (change?.kind === 'link' && change.replaces === id) {
    await deleteLink(session, change.id);
    await forget(db, change, null);
  }
  await deleteLink(session, id);
  const links = await listLinks(db);
  const record = links.find((l) => l.id === id);
  await putMeta(db, META_LINKS, links.filter((l) => l.id !== id));
  // Every key of the link: on its record, indexed, or sealed (loose ones an
  // older version left included).
  const names = new Set([
    ...(record?.keys ?? []).map((k) => keyName(id, k.from)),
    ...(await unindexKeys(db, (e) => e.link?.id === id)).map((e) => e.name),
    ...(await listSealed(db, keyPrefix(id))),
  ]);
  // A new key for it still unsettled goes with the rest.
  if (change?.kind === 'key' && change.id === id) await deleteMeta(db, META_CHANGE);
  // Links made when each had its own signing key.
  await deleteSealed(db, signingName(id));
  for (const name of names) await deleteSealed(db, name);
}

/** Deletes a link on the server; one it doesn't have (any more) counts as deleted. */
async function deleteLink(session: Session, id: string): Promise<void> {
  try {
    await session.call('DELETE', `/links/${id}`, undefined, checkObject, { sign: true });
  } catch (err) {
    if (!(err instanceof ApiError && err.code === 'not_found')) throw err;
  }
}
