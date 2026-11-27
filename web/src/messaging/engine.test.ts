import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLink, keyName, listLinks, newKeyToTell, replaceLink, revokeLink, rotateLinkKey, toldNewKey } from '../account/links';
import type { TokenIssuer } from '../account/wallet';
import { i2osp, modPow, os2ip, type IssuerKey } from '../crypto/blindrsa';
import { fromBase64Url, toBase64Url, toHex } from '../crypto/encoding';
import { generateCopyableAgreementKey, importSigningPublicKey } from '../crypto/keys';
import { LABEL_LINK_OWNER, verify } from '../crypto/signing';
import { generateVaultKey, seal } from '../crypto/vault';
import { ApiError, NetworkError, type Api } from '../net/api';
import type { Session } from '../net/session';
import { sendTokensFor } from '../protocol/envelope';
import { checkBundle, ownerParts, type LinkRef } from '../protocol/link';
import { challenge, epochOf, LABEL_MEDIA_TOKEN } from '../protocol/token';
import { countTokens, LOW_WATER, MEDIA_BATCH, MEDIA_LOW_WATER, rememberLeft, returnTokens, takeTokens, TOKEN_BATCH } from '../account/wallet';
import { editable, MAX_TEXT_BYTES, newId, sealMessage } from '../protocol/message';
import { deleteMeta, deleteSealed, getKey, getMeta, getSealed, listSealed, openDatabase, putKey, putMeta, putSealed, type Database } from '../storage/db';
import { POOL_LOW, POOL_REFILL, pooled, poolSize } from './pool';
import { canResend, createMessaging, LINK_KEY_RETRY_MS, MailboxLimit, NoMailboxes, NoTokens, RESEND_WINDOW_MS, SyncFailed, UPLOAD_REUSE_MS, type MessagingDeps } from './engine';
import {
  addMessage,
  answeredAt,
  clearMedia,
  comesAfter,
  earlyFor,
  failStuck,
  forgetUploadDeletes,
  getConversation,
  getIds,
  getMedia,
  getMessage,
  getPendingEdits,
  lastShown,
  listConversations,
  listMessages,
  listRecords,
  MAX_EARLY,
  MAX_EARLY_BYTES,
  mediaUsage,
  patchMessage,
  pendingUploadDeletes,
  putConversation,
  sealChatName,
  putMedia,
  queueUploadDeletes,
  saveConversation,
  setFile,
  setMessageStatus,
  type IdKind,
} from './store';
import { MAX_PENDING_EDIT_BYTES, MAX_PENDING_EDITS } from '../storage/db';
import { TransferError, WrongSize, type Transfer } from '../net/transfer';
import { conversationKey, KEY_RETENTION_MS, scheduleKeyDeletion, sealedMatches, unindexKeys, type KeyEntry } from './keys';
import { pendingLocks, withLock } from '../sync/locks';

// A modified app chooses its IDs: tests make it reuse some (nextIds).
vi.mock('../protocol/message', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../protocol/message')>();
  return { ...actual, newId: vi.fn(actual.newId) };
});

// Storing a message can be held up (pause.before), so a test can run
// something else in the middle of taking a message in, or fail just after
// (pause.after), as if the app closed then; and listing the uploads still to
// delete can be held up (pause.listed), once listed.
const pause = vi.hoisted(() => ({
  before: null as null | ((conv: string, text: string) => Promise<void>),
  after: null as null | ((conv: string, text: string) => Promise<void>),
  listed: null as null | ((count: number) => Promise<void>),
}));
vi.mock('./store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store')>();
  return {
    ...actual,
    addMessage: async (...args: Parameters<typeof actual.addMessage>) => {
      await pause.before?.(args[1].conv, args[2].text);
      await actual.addMessage(...args);
      await pause.after?.(args[1].conv, args[2].text);
    },
    pendingUploadDeletes: async (...args: Parameters<typeof actual.pendingUploadDeletes>) => {
      const list = await actual.pendingUploadDeletes(...args);
      await pause.listed?.(list.length);
      return list;
    },
  };
});

// An app from before messages were dated in whole seconds (older.ms): it
// sends its device's own clock, to the millisecond.
const older = vi.hoisted(() => ({ ms: false }));
vi.mock('../net/clock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../net/clock')>();
  return {
    ...actual,
    stamper: (clock: () => number) => {
      const stamp = actual.stamper(clock);
      return () => (older.ms ? clock() : stamp());
    },
  };
});

// Writing a setting can fail as if the app closed right then (storage.closeAt).
const storage = vi.hoisted(() => ({ closeAt: null as null | string }));
vi.mock('../storage/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage/db')>();
  return {
    ...actual,
    putMeta: async (...args: Parameters<typeof actual.putMeta>) => {
      if (storage.closeAt === args[1]) {
        storage.closeAt = null;
        throw new Error('closed');
      }
      return actual.putMeta(...args);
    },
  };
});

/** Resolves once a request for a lock whose name ends with this is waiting. */
async function waitingFor(lock: string): Promise<void> {
  for (;;) {
    const pending = navigator.locks ? ((await navigator.locks.query()).pending ?? []).map((l) => l.name ?? '') : pendingLocks();
    if (pending.some((name) => name.endsWith(lock))) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Runs a group of tests twice: with Web Locks, and as on an engine without
 * them, where locks hold within one copy of the app only (sync/locks.ts).
 */
function withAndWithoutWebLocks(name: string, tests: () => void): void {
  describe(name, tests);
  describe(`${name} (without Web Locks)`, () => {
    beforeEach(() => vi.stubGlobal('navigator', {}));
    afterEach(() => vi.unstubAllGlobals());
    tests();
  });
}

/** The next IDs the app makes for the wire (conversation, then message, in the order it makes them) are these. */
function nextIds(...ids: string[]): void {
  for (const id of ids) vi.mocked(newId).mockReturnValueOnce(id);
}

/**
 * The clock messages are dated by, for people in a test that doesn't set
 * one: a second later each time it's read, so everything happens in a
 * second of its own, at a person's pace. (Messages are dated in whole
 * seconds; a test about the same second sets its own clock.)
 */
let paceTicks = 0;
const pace = () => Date.now() + 1000 * paceTicks++;

afterEach(() => {
  vi.mocked(newId).mockReset();
  pause.before = null;
  pause.after = null;
  pause.listed = null;
  storage.closeAt = null;
  paceTicks = 0;
  older.ms = false;
});

let n = 0;
const rand = () => toBase64Url(crypto.getRandomValues(new Uint8Array(16)));

/** A fake backend with the real one's delivery rules, and a real issuer key. */
async function fakeBackend() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-384' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const big = (s: string) => os2ip(fromBase64Url(s));
  const key: IssuerKey = { key: pair.publicKey, n: big(jwk.n!), e: big(jwk.e!), k: 256 };
  const issuer: TokenIssuer = { key, keyId: new Uint8Array(await crypto.subtle.digest('SHA-256', await crypto.subtle.exportKey('spki', pair.publicKey))) };
  const d = big(jwk.d!);
  let mediaSigned = 0;
  let signed = 0;

  const mailboxes = new Map<string, string>(); // mailbox -> owner account
  const inboxes = new Map<string, { id: string; mailbox: string; envelope: string }[]>();
  const bundles = new Map<string, Record<string, unknown>>();
  /** The link IDs whose bundles were asked for, in order. */
  const bundleFetches: string[] = [];
  /** The inbox in pages of size (0: all at once), in the order delivered, with `next` or without; and every fetch's path. */
  const paging = { size: 0, next: true };
  const inboxFetches: string[] = [];
  const spent = new Set<string>();
  /**
   * How many send tokens each delivered send paid with, and whether as
   * `token` or `tokens`; and how many more than its size the server asks
   * for (fewer, if negative).
   */
  const sendPayments: number[] = [];
  const sendShapes: ('token' | 'tokens')[] = [];
  const pricing = { extra: 0 };
  /** Work the apps put off for later (MessagingDeps.later), for a test to run. */
  const later: { fn: () => void; ms: number }[] = [];
  const schedule = (fn: () => void, ms: number) => {
    const job = { fn, ms };
    later.push(job);
    return () => {
      const i = later.indexOf(job);
      if (i >= 0) later.splice(i, 1);
    };
  };
  const seenEnvelopes: string[] = [];
  const sendHeaders: (Record<string, string> | undefined)[] = [];
  /**
   * Parts of the server that can't be reached. puts: how the next PUTs go
   * wrong: the bucket can't be reached; the upload is written but the answer
   * is lost; the URL can no longer start one; a delete races the write (409);
   * or the upload is there already (412). renewals: how the next requests
   * for a fresh URL go: refused, out of reach, failing on the server, or
   * paused. uploads and downloads: paused by the operator (the server
   * answers so before looking at anything else). bundles: link bundles are
   * out of reach, refused (rate limited), or another link's comes back.
   * acks: confirmations can't reach the server. deleteLag: how many of the
   * next uploads to delete find nothing, as the server's lookup does for an
   * upload made a moment before (it reads a copy that can lag behind).
   * deletes: the delete routes are out of reach, or (busy) rate limited.
   * failDeletes: uploads the bucket fails to delete, which a batch answers
   * failed. batchDeletes: 405, as an older server, which has no POST
   * /media/delete, answers it; 404, as a server without attachments does.
   * batchMost: the most uploads POST /media/delete takes (more is 400).
   */
  const down = {
    deletes: false as boolean | 'busy',
    deleteLag: 0,
    failDeletes: new Set<string>(),
    batchDeletes: null as null | 404 | 405,
    batchMost: 50,
    bundles: null as null | 'unreachable' | 'busy' | 'wrong',
    puts: [] as ('unreachable' | 'lost' | 'expired' | 'conflict' | 'there')[],
    renewals: [] as ('ok' | 'refused' | 'unreachable' | 'failing' | 'paused')[],
    uploads: false,
    downloads: false,
    acks: false,
  };
  /** Requests to the media routes, as "METHOD path". */
  const mediaCalls: string[] = [];
  /** The upload IDs each POST /media/delete named, and the most of those requests under way at once. */
  const deleteBatches: string[][] = [];
  const deleting = { now: 0, most: 0 };
  const quietSends: boolean[] = [];
  /** Every send the server saw, refused or not: where to, what, and with which tokens. */
  const sendAttempts: { mailbox: string; envelope: string; tokens: string[] }[] = [];
  /** Who owns each link, and how many links an account may have (the real server: one). */
  const linkOwners = new Map<string, string>();
  const linkRules = { max: Infinity };
  /** Each account's ID, which owner proofs name, by the name the tests give it. */
  const accountIds = new Map<string, string>();
  /** The account each link signing key (base64url) is given to, for good, as the server does. */
  const keyOwners = new Map<string, string>();
  /** Checks an owner proof as the server does, then gives the key to the account, or says another has it. */
  async function claim(account: string, linkId: string, signingKey: string, proof: unknown): Promise<void> {
    const key = await importSigningPublicKey(fromBase64Url(signingKey));
    if (typeof proof !== 'string' || !(await verify(key, fromBase64Url(proof), LABEL_LINK_OWNER, ...ownerParts(linkId, accountIds.get(account) ?? '')))) {
      throw new ApiError(400, 'invalid_link');
    }
    const owner = keyOwners.get(signingKey);
    if (owner !== undefined && owner !== account) throw new ApiError(409, 'signing_key_taken');
    keyOwners.set(signingKey, account);
  }
  const uploads = new Map<string, { size: number; deleteHash: string; body: Uint8Array<ArrayBuffer> | null; renewals: number }>();
  /** Every upload URL handed out, every PUT tried, and every wait before trying again. */
  const uploadUrls: string[] = [];
  const puts: string[] = [];
  const waits: number[] = [];
  const uploadId = (url: string) => new URL(url).pathname.split('/').pop()!;
  // The bucket: presigned PUTs must carry exactly the paid-for size, and
  // write only once.
  const transfer: Transfer = {
    async put(url, body, onProgress) {
      puts.push(url);
      const up = uploads.get(uploadId(url));
      if (!up || body.length !== up.size) throw new TransferError(403, 'refused by the bucket');
      const failure = down.puts.shift();
      if (failure === 'unreachable') throw new TransferError(0, 'unreachable');
      if (failure === 'expired') throw new TransferError(403, 'expired');
      if (failure === 'conflict') throw new TransferError(409, 'deleted meanwhile');
      if (failure === 'there') up.body = body;
      if (up.body) throw new TransferError(412, 'already there');
      up.body = body;
      if (failure === 'lost') throw new TransferError(0, 'answer lost');
      onProgress?.(1);
    },
    async get(url, size) {
      const up = uploads.get(uploadId(url));
      // As S3 answers a role that can't list the bucket.
      if (!up?.body) throw new TransferError(403, 'not in the bucket');
      if (up.body.length !== size) throw new WrongSize();
      return up.body;
    },
  };

  const api: Api = {
    post: (path, body, check) => api.request('POST', path, { body: JSON.stringify(body) }, check),
    async request(method, path, init, check) {
      if (method === 'POST' && path === '/send') {
        sendHeaders.push(init.headers);
        const { mailbox, envelope, token, tokens, quiet } = JSON.parse(init.body!) as { mailbox: string; envelope: string; token?: string; tokens?: string[]; quiet?: boolean };
        // A token per started 2.5 KiB of envelope (pricing.extra more), all
        // checked before any is spent, as the server does.
        const paid = tokens ?? (token ? [token] : []);
        sendAttempts.push({ mailbox, envelope, tokens: paid });
        const needed = sendTokensFor(fromBase64Url(envelope).length) + pricing.extra;
        if (paid.length === 0) throw new ApiError(401, 'invalid_token');
        if (paid.length !== needed) throw new ApiError(402, 'tokens_needed', undefined, needed);
        if (paid.some((t) => spent.has(t)) || new Set(paid).size !== paid.length) throw new ApiError(401, 'invalid_token');
        quietSends.push(quiet === true);
        paid.forEach((t) => spent.add(t));
        sendPayments.push(paid.length);
        sendShapes.push(tokens ? 'tokens' : 'token');
        seenEnvelopes.push(envelope!);
        const owner = mailboxes.get(mailbox!);
        if (owner) inboxes.get(owner)!.push({ id: rand(), mailbox: mailbox!, envelope: envelope! });
        return check({});
      }
      if (path.startsWith('/media')) mediaCalls.push(`${method} ${path}`);
      if (method === 'POST' && path === '/media') {
        if (down.uploads) throw new ApiError(503, 'uploads_paused');
        const { size, deleteHash, tokens } = JSON.parse(init.body!) as { size: number; deleteHash: string; tokens: string[] };
        // One media token per started MiB; send tokens don't pay for uploads.
        const media = toHex(await challenge(epochOf(Math.floor(Date.now() / 1000)), LABEL_MEDIA_TOKEN));
        const isMedia = (t: string) => toHex(fromBase64Url(t).slice(34, 66)) === media;
        if (tokens.length !== Math.ceil(size / (1024 * 1024)) || tokens.some((t) => spent.has(t) || !isMedia(t))) throw new ApiError(401, 'invalid_token');
        tokens.forEach((t) => spent.add(t));
        const id = rand();
        uploads.set(id, { size, deleteHash, body: null, renewals: 0 });
        uploadUrls.push(`https://bucket.example/m/${id}?n=0`);
        return check({ id, url: uploadUrls.at(-1) });
      }
      if (method === 'POST' && path.startsWith('/media/') && path.endsWith('/upload')) {
        // For the delete secret, three times at most: a fresh URL, or word
        // that the upload is stored.
        const id = path.split('/')[2]!;
        const { secret } = JSON.parse(init.body!) as { secret: string };
        const hash = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', fromBase64Url(secret))));
        const up = uploads.get(id);
        const how = down.renewals.shift();
        if (down.uploads || how === 'paused') throw new ApiError(503, 'uploads_paused');
        if (how === 'unreachable') throw new NetworkError('unreachable');
        if (how === 'failing') throw new ApiError(500, 'internal');
        if (!up || up.deleteHash !== hash || up.renewals >= 3 || how === 'refused') throw new ApiError(404, 'not_found');
        up.renewals++;
        if (up.body) return check({ uploaded: true });
        uploadUrls.push(`https://bucket.example/m/${id}?n=${up.renewals}`);
        return check({ url: uploadUrls.at(-1) });
      }
      if (method === 'GET' && path.startsWith('/media/')) {
        if (down.downloads) throw new ApiError(503, 'downloads_paused');
        // Its record, paid for, not the file: that may never have been uploaded.
        if (!uploads.has(path.split('/')[2]!)) throw new ApiError(404, 'not_found');
        return check({ url: `https://bucket.example/m/${path.split('/')[2]!}` });
      }
      // An upload is deleted for its delete secret: 'deleted', 'not_found'
      // (unknown, gone, or a wrong secret), or 'failed' (the bucket failed).
      const deleteOne = async (id: string, secret: string): Promise<'deleted' | 'not_found' | 'failed'> => {
        if (down.deleteLag > 0) {
          down.deleteLag--;
          return 'not_found';
        }
        const hash = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', fromBase64Url(secret))));
        if (uploads.get(id)?.deleteHash !== hash) return 'not_found';
        if (down.failDeletes.has(id)) return 'failed';
        uploads.delete(id);
        return 'deleted';
      };
      if (method === 'POST' && path === '/media/delete') {
        if (down.batchDeletes === 405) throw new ApiError(405, 'method_not_allowed');
        if (down.batchDeletes === 404) throw new ApiError(404, 'not_found');
        if (down.deletes === 'busy') throw new ApiError(429, 'rate_limited');
        if (down.deletes) throw new NetworkError('down');
        const { items } = JSON.parse(init.body!) as { items: { id: string; secret: string }[] };
        // As the server: at most 50 a request (or batchMost).
        if (items.length === 0 || items.length > down.batchMost) throw new ApiError(400, 'bad_request');
        deleteBatches.push(items.map((i) => i.id));
        deleting.most = Math.max(deleting.most, ++deleting.now);
        try {
          await new Promise((resolve) => setTimeout(resolve, 1));
          const results: string[] = [];
          for (const { id, secret } of items) results.push(await deleteOne(id, secret));
          return check({ results });
        } finally {
          deleting.now--;
        }
      }
      if (method === 'POST' && path.startsWith('/media/') && path.endsWith('/delete')) {
        if (down.deletes === 'busy') throw new ApiError(429, 'rate_limited');
        if (down.deletes) throw new NetworkError('down');
        const { secret } = JSON.parse(init.body!) as { secret: string };
        const result = await deleteOne(path.split('/')[2]!, secret);
        if (result === 'not_found') throw new ApiError(404, 'not_found');
        if (result === 'failed') throw new ApiError(500, 'internal');
        return check({});
      }
      if (method === 'GET' && path.startsWith('/links/')) {
        bundleFetches.push(path.split('/')[2]!);
        if (down.bundles === 'unreachable') throw new NetworkError('down');
        if (down.bundles === 'busy') throw new ApiError(429, 'rate_limited');
        const id = path.split('/')[2]!;
        const b = down.bundles === 'wrong' ? [...bundles].find(([other]) => other !== id)?.[1] : bundles.get(id);
        if (!b) throw new ApiError(404, 'not_found');
        return check(b);
      }
      throw new ApiError(404, 'not_found');
    },
  };

  /** A logged-in session for one account. */
  function session(account: string): Session {
    inboxes.set(account, []);
    return {
      use: () => {},
      token: async () => 'v1.test.token',
      async call(method, path, body, check) {
        const b = (body ?? {}) as Record<string, unknown>;
        if (path === '/mailboxes') {
          const ids = Array.from({ length: b.count as number }, rand);
          ids.forEach((id) => mailboxes.set(id, account));
          return check({ mailboxes: ids });
        }
        if (path === '/tokens' || path === '/tokens/media') {
          // Signed with the key the request names, the only one held here.
          if (b.keyId !== toBase64Url(issuer.keyId)) throw new ApiError(409, 'unknown_issuer_key');
          if (path === '/tokens/media') mediaSigned += (b.blinded as string[]).length;
          else signed += (b.blinded as string[]).length;
          return check({
            signatures: (b.blinded as string[]).map((x) => toBase64Url(i2osp(modPow(os2ip(fromBase64Url(x)), d, key.n), 256))),
          });
        }
        if (path === '/links') {
          const id = b.id as string;
          await claim(account, id, b.signingKey as string, b.proof);
          if (b.replaces) {
            // The old link and its intro mailbox go.
            const old = bundles.get(b.replaces as string);
            if (!old || linkOwners.get(b.replaces as string) !== account) throw new ApiError(404, 'not_found');
            if (bundles.has(id)) throw new ApiError(409, 'conflict');
            bundles.delete(b.replaces as string);
            linkOwners.delete(b.replaces as string);
            mailboxes.delete(old.mailbox as string);
          } else {
            // As the server counts: the account's limit first, then the ID.
            if ([...linkOwners.values()].filter((a) => a === account).length >= linkRules.max) throw new ApiError(409, 'link_limit');
            if (bundles.has(id)) throw new ApiError(409, 'conflict');
          }
          const intro = rand();
          mailboxes.set(intro, account);
          bundles.set(id, { signingKey: b.signingKey, keys: b.keys, mailbox: intro });
          linkOwners.set(id, account);
          return check({ id, mailbox: intro });
        }
        if (method === 'DELETE' && path.startsWith('/links/')) {
          // The link and its intro mailbox go.
          const old = bundles.get(path.split('/')[2]!);
          if (!old) throw new ApiError(404, 'not_found');
          bundles.delete(path.split('/')[2]!);
          linkOwners.delete(path.split('/')[2]!);
          mailboxes.delete(old.mailbox as string);
          return check({});
        }
        if (method === 'PUT' && path.startsWith('/links/') && path.endsWith('/keys')) {
          const bundle = bundles.get(path.split('/')[2]!);
          if (!bundle) throw new ApiError(404, 'not_found');
          await claim(account, path.split('/')[2]!, bundle.signingKey as string, b.proof);
          bundle.keys = b.keys;
          return check({});
        }
        if (method === 'POST' && path.startsWith('/mailboxes/') && path.endsWith('/discard')) {
          const id = path.split('/')[2]!;
          if (mailboxes.get(id) !== account) throw new ApiError(404, 'not_found');
          mailboxes.delete(id);
          return check({});
        }
        if (method === 'GET' && (path === '/inbox' || path.startsWith('/inbox?'))) {
          inboxFetches.push(path);
          const all = [...inboxes.get(account)!];
          if (paging.size === 0) return check({ items: all, more: false });
          const after = new URLSearchParams(path.split('?')[1] ?? '').get('after');
          const rest = after ? all.slice(all.findIndex((i) => i.id === after) + 1) : all;
          const items = rest.slice(0, paging.size);
          const more = rest.length > items.length;
          return check({ items, more, ...(more && paging.next ? { next: items[items.length - 1]!.id } : {}) });
        }
        if (path === '/mailboxes/check') return check({ missing: (b.ids as string[]).filter((id) => mailboxes.get(id) !== account) });
        if (path === '/ack') {
          if (down.acks) throw new NetworkError('down');
          const done = new Set(b.ids as string[]);
          inboxes.set(account, inboxes.get(account)!.filter((i) => !done.has(i.id)));
          return check({});
        }
        throw new ApiError(404, 'not_found');
      },
    };
  }

  return { api, session, issuer, spent, sendPayments, sendShapes, sendAttempts, pricing, later, schedule, signed: () => signed, seenEnvelopes, sendHeaders, inboxes, quietSends, mailboxes, bundles, linkOwners, linkRules, accountIds, keyOwners, bundleFetches, paging, inboxFetches, uploads, uploadUrls, puts, waits, transfer, down, mediaCalls, deleteBatches, deleting, mediaSigned: () => mediaSigned };
}

async function person(backend: Awaited<ReturnType<typeof fakeBackend>>, account: string, now?: () => number) {
  const db: Database = await openDatabase(`engine-test-${n++}`);
  await putKey(db, 'vault-key', await generateVaultKey());
  // A set-up account, whose ID owner proofs name.
  const accountId = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  backend.accountIds.set(account, accountId);
  await putMeta(db, 'account', { state: 'registered', deviceId: toBase64Url(crypto.getRandomValues(new Uint8Array(16))), fingerprint: 'A'.repeat(43), accountId });
  const session = backend.session(account);
  /** The app on this device, as it starts (again, after it was closed). */
  const open = (extra: Partial<MessagingDeps> = {}) =>
    createMessaging({
      ...extra,
      db,
      api: backend.api,
      session,
      issuer: backend.issuer,
      mediaIssuer: backend.issuer,
      transfer: backend.transfer,
      wait: async (ms) => void backend.waits.push(ms),
      later: backend.schedule,
      ...(now ? { now } : {}),
      ...(now || extra.messageNow ? {} : { messageNow: pace }),
    });
  return { db, session, messaging: open(), open };
}

/**
 * The next of someone's logged-in requests that matches reaches the server,
 * but its answer is lost on the way back (or, with `failure`, the app fails
 * that way just after, as if it closed).
 */
function loseAnswer(who: { session: Session }, method: string, path: RegExp, failure: Error = new NetworkError('answer lost')): void {
  const call = who.session.call;
  who.session.call = async function (m, p, ...rest) {
    if (m !== method || !path.test(p)) return call(m, p, ...rest);
    who.session.call = call;
    await call(m, p, ...rest);
    throw failure;
  } as Session['call'];
}

/** The next of someone's logged-in requests that matches fails as it is: it never reaches the server. */
function failRequest(who: { session: Session }, method: string, path: RegExp, failure: Error): void {
  const call = who.session.call;
  who.session.call = async function (m, p, ...rest) {
    if (m !== method || !path.test(p)) return call(m, p, ...rest);
    who.session.call = call;
    throw failure;
  } as Session['call'];
}

/** A link of the owner's, made now (Unix seconds; the device's clock if not given). */
async function linkOf(backend: Awaited<ReturnType<typeof fakeBackend>>, owner: Awaited<ReturnType<typeof person>>, now?: () => number) {
  const record = await createLink(owner.db, owner.session, backend.api, now);
  const ref: LinkRef = { id: record.id, fingerprint: record.fingerprint };
  const bundle = await backend.api.request('GET', `/links/${record.id}`, {}, checkBundle);
  return { ref, bundle };
}

/**
 * The same conversation on the other side's device. Each device has its own
 * ID for it; they share only the one on the wire.
 */
async function across(from: Database, conv: string, to: Database): Promise<string> {
  const { wire } = (await getConversation(from, conv))!;
  const there = (await listConversations(to)).filter((c) => c.wire === wire);
  expect(there).toHaveLength(1);
  return there[0]!.id;
}

/**
 * Tokens the server saw with two different sends (another envelope, or
 * another mailbox): each would tie those sends together.
 */
function tiedSends(backend: Awaited<ReturnType<typeof fakeBackend>>): string[] {
  const first = new Map<string, string>();
  const tied: string[] = [];
  for (const { mailbox, envelope, tokens } of backend.sendAttempts) {
    for (const t of tokens) {
      const send = `${mailbox} ${envelope}`;
      if ((first.get(t) ?? send) !== send) tied.push(t);
      first.set(t, first.get(t) ?? send);
    }
  }
  return tied;
}

describe('messaging between two people', () => {
  it('keeps the count of what a sync stored before it failed', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    await sender.messaging.startConversation(ref, bundle, 'hello');
    // Stored, then the confirmation fails: the app still has news to show.
    backend.down.acks = true;
    const failed = await owner.messaging.sync().catch((err: unknown) => err);
    expect(failed).toBeInstanceOf(SyncFailed);
    expect(failed).toMatchObject({ received: 1, error: expect.any(NetworkError) });
    // Listed again later: known already, and confirmed.
    backend.down.acks = false;
    expect(await owner.messaging.sync()).toBe(0);
    expect(backend.inboxes.get('owner')).toEqual([]);
  });

  it('starts through a link, then talks on per-conversation keys and mailboxes', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);

    const conv = await sender.messaging.startConversation(ref, bundle, 'سلام! hello');
    expect(await owner.messaging.sync()).toBe(1);

    // Each side has its own ID for the conversation; only the wire ID is shared.
    const [ownerConv] = await listConversations(owner.db);
    const { wire } = (await getConversation(sender.db, conv))!;
    expect(ownerConv).toMatchObject({ wire, role: 'owner', unread: 1, myKey: null, link: { id: ref.id } });
    expect(new Set([conv, wire, ownerConv!.id]).size).toBe(3);
    const mine = ownerConv!.id;
    expect(ownerConv!.label).toMatch(/^\S+ [0-9A-Z]{4}$/u);
    expect((await listMessages(owner.db, mine)).map((m) => [m.out, m.text])).toEqual([[false, 'سلام! hello']]);

    // The owner's first reply brings the owner's own key and mailbox.
    await owner.messaging.send(mine, 'hi back');
    expect(await sender.messaging.sync()).toBe(1);
    const [senderConv] = await listConversations(sender.db);
    const [ownerAfter] = await listConversations(owner.db);
    expect(senderConv!.peerKey).toBe(ownerAfter!.myKey);
    expect(senderConv!.sendTo).toBe(ownerAfter!.myMailbox);
    expect(senderConv!.sendTo).not.toBe(bundle.mailbox);

    await sender.messaging.send(conv, 'how are you?');
    expect(await owner.messaging.sync()).toBe(1);
    expect((await listMessages(owner.db, mine)).map((m) => m.text)).toEqual(['سلام! hello', 'hi back', 'how are you?']);
    expect((await listMessages(sender.db, conv)).map((m) => [m.out, m.status])).toEqual([
      [true, 'sent'],
      [false, 'received'],
      [true, 'sent'],
    ]);

    // The server only ever saw ciphertext, and sends carried no login.
    const plaintexts = ['hello', 'hi back', 'how are you'].map((s) => toBase64Url(new TextEncoder().encode(s)));
    for (const env of backend.seenEnvelopes) {
      const raw = new TextDecoder('latin1').decode(fromBase64Url(env));
      for (const p of ['hello', 'hi back', 'how are you']) expect(raw).not.toContain(p);
      for (const p of plaintexts) expect(env).not.toContain(p);
    }
    expect(backend.sendHeaders.every((h) => !h || !Object.keys(h).some((k) => ['authorization', 'x-session'].includes(k.toLowerCase())))).toBe(true);
  });

  it('ignores replays, and keeps one label per person per link', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const other = await person(backend, 'other');
    const { ref, bundle } = await linkOf(backend, owner);

    const first = await sender.messaging.startConversation(ref, bundle, 'one');
    await owner.messaging.sync();
    // The same envelope delivered again is dropped.
    const again = backend.seenEnvelopes[0]!;
    backend.inboxes.get('owner')!.push({ id: rand(), mailbox: bundle.mailbox, envelope: again });
    expect(await owner.messaging.sync()).toBe(0);
    expect(await listConversations(owner.db)).toHaveLength(1);

    // The same sender starting a second conversation keeps their label; someone else doesn't share it.
    const second = await sender.messaging.startConversation(ref, bundle, 'two');
    await other.messaging.startConversation(ref, bundle, 'three');
    expect(await owner.messaging.sync()).toBe(2);
    const byId = new Map((await listConversations(owner.db)).map((c) => [c.id, c]));
    expect(byId.size).toBe(3);
    const [one, two] = [await across(sender.db, first, owner.db), await across(sender.db, second, owner.db)];
    expect(byId.get(one)!.label).toBe(byId.get(two)!.label);
    const otherConv = [...byId.values()].find((c) => c.id !== one && c.id !== two)!;
    expect(otherConv.label).not.toBe(byId.get(one)!.label);
  });

  it('ignores a message delivered again within a conversation', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    await owner.messaging.send(mine, 'hi');
    await sender.messaging.sync();
    const sent = backend.seenEnvelopes.length;
    await sender.messaging.send(conv, 'once');
    const once = backend.seenEnvelopes[sent]!;
    await sender.messaging.send(conv, 'later');
    expect(await owner.messaging.sync()).toBe(2);
    const before = (await getConversation(owner.db, mine))!;

    // Written for the owner's conversation key, to their mailbox: delivered again, dropped.
    backend.inboxes.get('owner')!.push({ id: rand(), mailbox: before.myMailbox!, envelope: once });
    expect(await owner.messaging.sync()).toBe(0);
    expect((await listMessages(owner.db, mine)).map((m) => m.text)).toEqual(['hello', 'hi', 'once', 'later']);
    // Nothing about the conversation changed: not its unread count, nor the last message it names.
    expect(await getConversation(owner.db, mine)).toEqual(before);
  });

  it('drops messages it cannot open or that claim another conversation', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    await sender.messaging.startConversation(ref, bundle, 'hello');
    // Garbage in the inbox is confirmed and dropped, the real message kept.
    backend.inboxes.get('owner')!.push({ id: rand(), mailbox: bundle.mailbox, envelope: toBase64Url(new Uint8Array(663)) });
    expect(await owner.messaging.sync()).toBe(1);
    expect(backend.inboxes.get('owner')).toHaveLength(0);
  });

  it('pays every send with a fresh token', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'a');
    await sender.messaging.send(conv, 'b');
    await sender.messaging.send(conv, 'c');
    expect(backend.seenEnvelopes).toHaveLength(3);
    expect(await owner.messaging.sync()).toBe(3);
  });

  it('keeps pools topped up, and indexes keys of links made before indexing', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    // Forget the link key's index entry, as for a link made by an older version.
    await putMeta(owner.db, 'recipient-keys', {});

    await owner.messaging.maintain();
    expect(await poolSize(owner.db)).toBeGreaterThanOrEqual(POOL_LOW);
    expect(await countTokens(owner.db, backend.issuer.keyId)).toBeGreaterThanOrEqual(LOW_WATER);

    await sender.messaging.startConversation(ref, bundle, 'still reaches you');
    expect(await owner.messaging.sync()).toBe(1);
  });
});

describe('paying for sends by size', () => {
  async function chat() {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hi');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    /** Send tokens fetched and neither spent nor in a wallet: lost. */
    const lost = async () =>
      backend.signed() - backend.sendPayments.reduce((a, b) => a + b, 0) - (await countTokens(owner.db, backend.issuer.keyId)) - (await countTokens(sender.db, backend.issuer.keyId));
    return { backend, owner, sender, conv, mine, lost };
  }

  it('pays for a long text by its size, and for anything else with one token', async () => {
    const { backend, owner, sender, conv, mine, lost } = await chat();
    await sender.messaging.send(conv, 'short');
    await sender.messaging.send(conv, 'a'.repeat(5000));
    await sender.messaging.send(conv, 'س'.repeat(MAX_TEXT_BYTES / 2));
    expect(backend.sendPayments.slice(-3)).toEqual([1, 4, 7]);
    // One token as `token`, which servers from before sizes were priced take too.
    expect(backend.sendShapes.slice(-3)).toEqual(['token', 'tokens', 'tokens']);
    expect(await owner.messaging.sync()).toBe(3);
    await owner.messaging.markSeen(mine);
    expect(backend.sendPayments.at(-1)).toBe(1);
    expect(await lost()).toBe(0);
  });

  it('sends one receipt however many were read, at one token: the newest 50, and that the earlier ones were read too', async () => {
    const { backend, owner, sender, conv, mine } = await chat();
    for (let i = 0; i < 59; i++) await sender.messaging.send(conv, `m${i}`);
    // One of them is still on its way.
    const [late] = backend.inboxes.get('owner')!.splice(55, 1);
    await owner.messaging.sync();
    const before = backend.sendPayments.length;
    await owner.messaging.markSeen(mine);
    expect(backend.sendPayments.slice(before)).toEqual([1]);
    expect((await listMessages(owner.db, mine)).filter((m) => m.status !== 'read')).toEqual([]);
    // Their side: all seen, but the one still on its way, written after the oldest the receipt names.
    expect(await sender.messaging.sync()).toBe(1);
    const unseen = (await listMessages(sender.db, conv)).filter((m) => m.status !== 'seen').map((m) => m.text);
    expect(unseen).toEqual(['m55']);
    // It comes, and is read: one receipt for it alone.
    backend.inboxes.get('owner')!.push(late!);
    await owner.messaging.sync();
    await owner.messaging.markSeen(mine);
    await sender.messaging.sync();
    expect((await listMessages(sender.db, conv)).filter((m) => m.status !== 'seen')).toEqual([]);
  });

  it('fetches more tokens when the wallet has fewer than a send costs', async () => {
    const { backend, sender, conv, lost } = await chat();
    const held = (await takeTokens(sender.db, backend.issuer.keyId, await countTokens(sender.db, backend.issuer.keyId)))!;
    await returnTokens(sender.db, held.slice(0, 2));
    const signed = backend.signed();
    await sender.messaging.send(conv, 'a'.repeat(5000));
    expect(backend.sendPayments.at(-1)).toBe(4);
    expect(backend.signed()).toBeGreaterThan(signed);
    // The two held back aren't in the wallet any more, nor spent.
    expect(await lost()).toBe(held.length - 2);
  });

  it('pays what the server asks, more or less, once, with the tokens it saw, and drops those of a send it refuses', async () => {
    const { backend, sender, conv, lost } = await chat();
    backend.pricing.extra = 1;
    await sender.messaging.send(conv, 'short');
    expect(backend.sendPayments.at(-1)).toBe(2);
    // Tried again, the same envelope to the same mailbox: the token it saw, and one more.
    const [refused, paid] = backend.sendAttempts.slice(-2);
    expect(paid).toMatchObject({ mailbox: refused!.mailbox, envelope: refused!.envelope });
    expect(paid!.tokens.slice(0, 1)).toEqual(refused!.tokens);
    expect(await lost()).toBe(0);
    // A price cut: four for a text the server now prices at two, two of
    // the four it saw; the other two go to no other send, and are lost.
    backend.pricing.extra = -2;
    await sender.messaging.send(conv, 'a'.repeat(5000));
    expect(backend.sendPayments.at(-1)).toBe(2);
    const [dear, cut] = backend.sendAttempts.slice(-2);
    expect(cut!.tokens).toEqual(dear!.tokens.slice(0, 2));
    expect(await lost()).toBe(2);
    // More than any envelope can cost: refused, and its token dropped.
    backend.pricing.extra = 9;
    const sends = backend.sendPayments.length;
    await expect(sender.messaging.send(conv, 'too dear')).rejects.toMatchObject({ code: 'tokens_needed' });
    expect(backend.sendPayments).toHaveLength(sends);
    expect((await listMessages(sender.db, conv)).at(-1)).toMatchObject({ text: 'too dear', status: 'failed' });
    expect(await lost()).toBe(3);
    expect(tiedSends(backend)).toEqual([]);
  });

  it('gets past the spent tokens of a send whose answer was lost', async () => {
    const { backend, owner, sender, conv } = await chat();
    const request = backend.api.request;
    // Delivered, but the answer doesn't come back: its four tokens may be spent, and are dropped.
    backend.api.request = async (method, path, init, check) => {
      if (method === 'POST' && path === '/send') {
        backend.api.request = request;
        await request(method, path, init, check);
        throw new NetworkError('answer lost');
      }
      return request(method, path, init, check);
    };
    await expect(sender.messaging.send(conv, 'a'.repeat(5000))).rejects.toThrow(NetworkError);
    expect(backend.sendPayments.at(-1)).toBe(4);
    const attempts = backend.sendAttempts.length;
    await sender.messaging.send(conv, 'next');
    // At once, with a fresh token.
    expect(backend.sendAttempts).toHaveLength(attempts + 1);
    expect(backend.sendPayments.at(-1)).toBe(1);
    expect(await owner.messaging.sync()).toBe(2);
    expect(tiedSends(backend)).toEqual([]);
  });

  for (const failure of ['capped', 'unanswered', 'lost'] as const) {
    it(`shows the tokens of a send that was ${failure} with no other send`, async () => {
      const { backend, owner, sender, conv, mine } = await chat();
      // Another conversation of the sender's, to another mailbox.
      const other = await person(backend, 'other');
      const link = await linkOf(backend, other);
      const elsewhere = await sender.messaging.startConversation(link.ref, link.bundle, 'hello there');
      await owner.messaging.send(mine, 'hi back');
      await sender.messaging.sync();
      const request = backend.api.request;
      backend.api.request = async (method, path, init, check) => {
        if (method !== 'POST' || path !== '/send') return request(method, path, init, check);
        backend.api.request = request;
        // Refused for the mailbox's cap (the tokens given back), never
        // reaching the server (as far as the app can tell), or delivered
        // with the answer lost.
        if (failure === 'lost') {
          await request(method, path, init, check);
          throw new NetworkError('answer lost');
        }
        const { mailbox, envelope, token, tokens } = JSON.parse(init.body!) as { mailbox: string; envelope: string; token?: string; tokens?: string[] };
        backend.sendAttempts.push({ mailbox, envelope, tokens: tokens ?? [token!] });
        throw failure === 'capped' ? new ApiError(429, 'rate_limited') : new NetworkError('no answer');
      };
      await expect(sender.messaging.send(conv, 'a'.repeat(5000))).rejects.toThrow();
      const shown = backend.sendAttempts.at(-1)!.tokens;
      expect(shown).toHaveLength(4);
      // The next sends, to the same mailbox and to another: fresh tokens only.
      await sender.messaging.send(conv, 'again');
      await sender.messaging.send(elsewhere, 'and here');
      await sender.messaging.send(conv, 'a'.repeat(5000));
      expect(backend.sendAttempts.slice(-3).flatMap((a) => a.tokens).filter((t) => shown.includes(t))).toEqual([]);
      expect(tiedSends(backend)).toEqual([]);
      expect(await countTokens(sender.db, backend.issuer.keyId)).toBeGreaterThan(0);
    });
  }

  it('fetches more in the background once the wallet runs low, not with a send', async () => {
    const { backend, sender, conv, lost } = await chat();
    const held = (await takeTokens(sender.db, backend.issuer.keyId, await countTokens(sender.db, backend.issuer.keyId)))!;
    await returnTokens(sender.db, held.slice(0, LOW_WATER + 1));
    backend.later.length = 0;
    const signed = backend.signed();
    // Below LOW_WATER after this send: nothing is fetched now, a fetch is put off.
    await sender.messaging.send(conv, 'a'.repeat(5000));
    expect(backend.signed()).toBe(signed);
    expect(backend.later).toHaveLength(1);
    expect(backend.later[0]!.ms).toBeGreaterThanOrEqual(10_000);
    expect(backend.later[0]!.ms).toBeLessThanOrEqual(90_000);
    // Another send meanwhile puts off no second one.
    await sender.messaging.send(conv, 'still low');
    expect(backend.later).toHaveLength(1);
    expect(backend.signed()).toBe(signed);
    // When it runs: a batch, with no send near it.
    backend.later.shift()!.fn();
    await vi.waitFor(async () => expect(await countTokens(sender.db, backend.issuer.keyId)).toBeGreaterThanOrEqual(LOW_WATER));
    expect(backend.signed()).toBeGreaterThan(signed);
    expect(await lost()).toBe(held.length - LOW_WATER - 1);
  });

  it("asks for only the day's last few when fewer than a batch are left", async () => {
    const { backend, sender, conv } = await chat();
    const held = (await takeTokens(sender.db, backend.issuer.keyId, await countTokens(sender.db, backend.issuer.keyId)))!;
    await returnTokens(sender.db, held.slice(0, 2));
    // The server said it will sign 5 more today: a batch of 20 would be refused.
    await rememberLeft(sender.db, 'send', 5);
    const signed = backend.signed();
    await sender.messaging.send(conv, 'a'.repeat(5000));
    expect(backend.sendPayments.at(-1)).toBe(4);
    expect(backend.signed()).toBe(signed + 5);
  });
});

describe('topping up in the background', () => {
  /** Counts someone's requests for new mailboxes. */
  function countNewMailboxes(p: Person) {
    const calls = { count: 0 };
    const call = p.session.call;
    p.session.call = async (method, path, body, check, options) => {
      if (method === 'POST' && path === '/mailboxes') calls.count++;
      return call(method, path, body, check, options);
    };
    return calls;
  }

  it('a reply that leaves the mailbox pool low tops it up at a random moment after, not with the send', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const { ref, bundle } = await linkOf(backend, owner);
    const chats: string[] = [];
    for (let i = 0; i < 3; i++) {
      const sender = await person(backend, `s${i}`);
      const conv = await sender.messaging.startConversation(ref, bundle, 'hi');
      await owner.messaging.sync();
      chats.push(await across(sender.db, conv, owner.db));
    }
    await owner.messaging.maintain();
    await putMeta(owner.db, 'mailbox-pool', (await pooled(owner.db)).slice(0, POOL_LOW));
    const created = countNewMailboxes(owner);
    backend.later.length = 0;
    // The first reply takes one and leaves the pool low: nothing is created
    // now, a top-up is put off to 10 to 90 seconds later.
    await owner.messaging.send(chats[0]!, 'hello');
    expect(created.count).toBe(0);
    expect(await poolSize(owner.db)).toBe(POOL_LOW - 1);
    expect(backend.later).toHaveLength(1);
    expect(backend.later[0]!.ms).toBeGreaterThanOrEqual(10_000);
    expect(backend.later[0]!.ms).toBeLessThanOrEqual(90_000);
    // Another meanwhile puts off no second one.
    await owner.messaging.send(chats[1]!, 'hello');
    expect(backend.later).toHaveLength(1);
    expect(created.count).toBe(0);
    // When it runs: one batch, with no send near it.
    backend.later.shift()!.fn();
    await vi.waitFor(async () => expect(await poolSize(owner.db)).toBe(POOL_LOW - 2 + POOL_REFILL));
    expect(created.count).toBe(1);
    // Only a reply that finds the pool empty creates mailboxes first.
    await putMeta(owner.db, 'mailbox-pool', []);
    await owner.messaging.send(chats[2]!, 'hello');
    expect(created.count).toBe(2);
    expect(await poolSize(owner.db)).toBe(POOL_REFILL - 1);
  });

  /** Holds someone's next logged-in POST to this path at a gate. */
  function holdNext(p: Person, path: string) {
    const g = gate();
    const call = p.session.call;
    p.session.call = async (method, route, body, check, options) => {
      if (method === 'POST' && route === path) {
        p.session.call = call;
        await g.pass();
      }
      return call(method, route, body, check, options);
    };
    return g;
  }

  /** Whether this settles within two seconds. */
  const settlesSoon = (p: Promise<unknown>) => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]);

  /** An owner with chats started through their link, none answered yet. */
  async function ownerWithChats(count: number) {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const { ref, bundle } = await linkOf(backend, owner);
    const chats: string[] = [];
    for (let i = 0; i < count; i++) {
      const sender = await person(backend, `s${i}`);
      const conv = await sender.messaging.startConversation(ref, bundle, 'hi');
      await owner.messaging.sync();
      chats.push(await across(sender.db, conv, owner.db));
    }
    await owner.messaging.maintain();
    return { backend, owner, chats };
  }

  it('says when the account holds all the mailboxes it may, and tops the pool up no more until a block frees one', async () => {
    const { backend, owner, chats } = await ownerWithChats(3);
    await owner.messaging.send(chats[0]!, 'hello');
    // From now on the account is at the limit (4,000).
    const server = { full: true, asked: 0 };
    const call = owner.session.call;
    owner.session.call = async (method, path, body, check, options) => {
      if (method === 'POST' && path === '/mailboxes') {
        server.asked++;
        if (server.full) throw new ApiError(409, 'mailbox_limit');
      }
      return call(method, path, body, check, options);
    };
    // Upkeep finds the pool low and is refused: nothing to do, not a failure.
    await putMeta(owner.db, 'mailbox-pool', (await pooled(owner.db)).slice(0, 1));
    await owner.messaging.maintain();
    expect(server.asked).toBe(1);
    // After that, neither a reply that empties the pool nor upkeep asks
    // again: each try would be refused, and count against the day's.
    backend.later.length = 0;
    await owner.messaging.send(chats[1]!, 'hello');
    expect(await poolSize(owner.db)).toBe(0);
    for (const job of backend.later.splice(0)) job.fn();
    await owner.messaging.maintain();
    expect(server.asked).toBe(1);
    // A reply that finds the pool empty still asks (a block in another copy
    // of the app may have freed one), and says why it can't go.
    await expect(owner.messaging.send(chats[2]!, 'hello')).rejects.toBeInstanceOf(MailboxLimit);
    expect(server.asked).toBe(2);
    // Blocking someone frees one: the pool is topped up again.
    server.full = false;
    await owner.messaging.block(chats[0]!);
    await owner.messaging.maintain();
    expect(server.asked).toBe(3);
    expect(await poolSize(owner.db)).toBe(POOL_REFILL);
    await owner.messaging.send(chats[2]!, 'hello again');
    expect(await poolSize(owner.db)).toBe(POOL_REFILL - 1);
  });

  it("doesn't make a reply wait for a top-up under way: it takes a mailbox the pool has", async () => {
    const { backend, owner, chats } = await ownerWithChats(2);
    await putMeta(owner.db, 'mailbox-pool', (await pooled(owner.db)).slice(0, POOL_LOW));
    backend.later.length = 0;
    await owner.messaging.send(chats[0]!, 'hello');
    expect(backend.later).toHaveLength(1);
    // The top-up runs, and its request is on its way.
    const creating = holdNext(owner, '/mailboxes');
    backend.later.shift()!.fn();
    await creating.reached;
    // A reply meanwhile goes out at once, not just after the account's request is answered.
    const sends = backend.seenEnvelopes.length;
    expect(await settlesSoon(owner.messaging.send(chats[1]!, 'hello'))).toBe(true);
    expect(backend.seenEnvelopes.length).toBe(sends + 1);
    expect(await poolSize(owner.db)).toBe(POOL_LOW - 2);
    creating.release();
    await vi.waitFor(async () => expect(await poolSize(owner.db)).toBe(POOL_LOW - 2 + POOL_REFILL));
  });

  it("doesn't make a send wait for a top-up of send tokens under way", async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hi');
    const held = (await takeTokens(sender.db, backend.issuer.keyId, await countTokens(sender.db, backend.issuer.keyId)))!;
    await returnTokens(sender.db, held.slice(0, LOW_WATER));
    backend.later.length = 0;
    await sender.messaging.send(conv, 'low now');
    expect(backend.later).toHaveLength(1);
    const fetching = holdNext(sender, '/tokens');
    backend.later.shift()!.fn();
    await fetching.reached;
    const sends = backend.seenEnvelopes.length;
    expect(await settlesSoon(sender.messaging.send(conv, 'meanwhile'))).toBe(true);
    expect(backend.seenEnvelopes.length).toBe(sends + 1);
    fetching.release();
    await vi.waitFor(async () => expect(await countTokens(sender.db, backend.issuer.keyId)).toBe(LOW_WATER - 2 + TOKEN_BATCH));
  });

  it('stop() cancels the top-ups put off, and a send still under way then puts off none', async () => {
    const { backend, owner, chats } = await ownerWithChats(2);
    // A reply leaves the pool low, and an upload the media wallet.
    await putMeta(owner.db, 'mailbox-pool', (await pooled(owner.db)).slice(0, POOL_LOW));
    const media = await countTokens(owner.db, backend.issuer.keyId, undefined, 'media');
    await takeTokens(owner.db, backend.issuer.keyId, media - MEDIA_LOW_WATER, undefined, 'media');
    backend.later.length = 0;
    await owner.messaging.send(chats[0]!, 'hello');
    const photo = crypto.getRandomValues(new Uint8Array(300));
    await owner.messaging.sendMedia(chats[0]!, { file: photo, media: { t: 'photo', s: photo.length, w: 3, h: 3, m: 'image/jpeg' } });
    expect(backend.later).toHaveLength(2);
    owner.messaging.stop();
    expect(backend.later).toEqual([]);
    // Stopped while a reply goes out (signed out, say): the reply leaves the
    // pool lower still, but nothing is fetched for a stopped app.
    const app = owner.open();
    const reply = app.send(chats[1]!, 'hello');
    app.stop();
    await reply;
    expect(await poolSize(owner.db)).toBe(POOL_LOW - 2);
    expect(backend.later).toEqual([]);
  });

  it('an upload that leaves the media wallet low tops it up at a random moment after, not with the upload', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await sender.messaging.maintain();
    const media = await countTokens(sender.db, backend.issuer.keyId, undefined, 'media');
    await takeTokens(sender.db, backend.issuer.keyId, media - MEDIA_LOW_WATER, undefined, 'media');
    const signed = backend.mediaSigned();
    backend.later.length = 0;
    const photo = crypto.getRandomValues(new Uint8Array(300));
    await sender.messaging.sendMedia(conv, { file: photo, media: { t: 'photo', s: photo.length, w: 3, h: 3, m: 'image/jpeg' } });
    expect(backend.mediaSigned()).toBe(signed);
    expect(await countTokens(sender.db, backend.issuer.keyId, undefined, 'media')).toBe(MEDIA_LOW_WATER - 1);
    expect(backend.later).toHaveLength(1);
    expect(backend.later[0]!.ms).toBeGreaterThanOrEqual(10_000);
    expect(backend.later[0]!.ms).toBeLessThanOrEqual(90_000);
    backend.later.shift()!.fn();
    await vi.waitFor(async () => expect(await countTokens(sender.db, backend.issuer.keyId, undefined, 'media')).toBe(MEDIA_LOW_WATER - 1 + MEDIA_BATCH));
    expect(backend.mediaSigned()).toBe(signed + MEDIA_BATCH);
  });

  it('two copies running upkeep at once fetch one batch of each, not one each', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const tab = copyOf(backend, owner);
    await owner.messaging.maintain();
    await putMeta(owner.db, 'mailbox-pool', []);
    await takeTokens(owner.db, backend.issuer.keyId, await countTokens(owner.db, backend.issuer.keyId));
    await takeTokens(owner.db, backend.issuer.keyId, await countTokens(owner.db, backend.issuer.keyId, undefined, 'media'), undefined, 'media');
    const created = countNewMailboxes(owner);
    const signed = backend.signed();
    const mediaSigned = backend.mediaSigned();
    await Promise.all([owner.messaging.maintain(), tab.maintain()]);
    expect(created.count).toBe(1);
    expect(await poolSize(owner.db)).toBe(POOL_REFILL);
    expect(backend.signed() - signed).toBe(TOKEN_BATCH);
    expect(backend.mediaSigned() - mediaSigned).toBe(MEDIA_BATCH);
  });

  it('tells other copies when upkeep deletes keys, so they forget them too', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    await linkOf(backend, owner);
    let told = 0;
    const app = owner.open({ onKeysDeleted: () => told++ });
    await app.maintain().catch(() => {});
    expect(told).toBe(0);
    await scheduleKeyDeletion(owner.db, (e) => e.link !== undefined, Date.now() - 1);
    await app.maintain().catch(() => {});
    expect(told).toBe(1);
  });
});

withAndWithoutWebLocks('seen receipts', () => {
  it('tell the sender what was read, once', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'one');
    await sender.messaging.send(conv, 'two');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);

    await owner.messaging.markSeen(mine);
    expect((await listMessages(owner.db, mine)).map((m) => m.status)).toEqual(['read', 'read']);
    const sends = backend.seenEnvelopes.length;
    await owner.messaging.markSeen(mine); // nothing new to report
    expect(backend.seenEnvelopes.length).toBe(sends);

    await sender.messaging.sync();
    expect((await listMessages(sender.db, conv)).map((m) => [m.text, m.status])).toEqual([
      ['one', 'seen'],
      ['two', 'seen'],
    ]);
  });

  it('go one at a time: calls that overlap, here or in another copy, send one receipt', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const tab = copyOf(backend, owner);
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'one');
    await sender.messaging.send(conv, 'two');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    const sends = backend.seenEnvelopes.length;
    // The chat opens as messages arrive: asked again while it runs, the
    // same run answers, not one per call.
    const first = owner.messaging.markSeen(mine);
    expect(owner.messaging.markSeen(mine)).toBe(first);
    expect(owner.messaging.markSeen(mine)).toBe(first);
    await Promise.all([first, tab.markSeen(mine), tab.markSeen(mine)]);
    expect(backend.seenEnvelopes.length).toBe(sends + 1);
    expect((await listMessages(owner.db, mine)).map((m) => m.status)).toEqual(['read', 'read']);
    await sender.messaging.sync();
    expect((await listMessages(sender.db, conv)).map((m) => m.status)).toEqual(['seen', 'seen']);
  });

  it('asked for again while one goes out, run once more after it, for what came meanwhile', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'one');
    await sender.messaging.send(conv, 'two');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    const receipts = () => backend.quietSends.filter(Boolean).length;
    const before = receipts();
    // The first receipt is held on its way.
    const held = gate();
    const request = backend.api.request;
    backend.api.request = async (method, path, init, check) => {
      if (method === 'POST' && path === '/send') {
        backend.api.request = request;
        await held.pass();
      }
      return request(method, path, init, check);
    };
    const first = owner.messaging.markSeen(mine);
    await held.reached;
    // Once it's out, and before the next run: a new message comes in, and
    // their side sees the first receipt named only what came before.
    const between = withLock(`seen:${mine}`, async () => {
      expect(await owner.messaging.sync()).toBe(1);
      await sender.messaging.sync();
      expect((await listMessages(sender.db, conv)).map((m) => [m.text, m.status])).toEqual([
        ['one', 'seen'],
        ['two', 'seen'],
        ['three', 'sent'],
      ]);
    });
    await sender.messaging.send(conv, 'three');
    // Asked again (a message arriving in the open chat) while the first run goes on.
    expect(owner.messaging.markSeen(mine)).toBe(first);
    held.release();
    await between;
    await first;
    expect(receipts()).toBe(before + 2);
    expect((await listMessages(owner.db, mine)).map((m) => m.status)).toEqual(['read', 'read', 'read']);
    await sender.messaging.sync();
    expect((await listMessages(sender.db, conv)).map((m) => [m.text, m.status])).toEqual([
      ['one', 'seen'],
      ['two', 'seen'],
      ['three', 'seen'],
    ]);
  });

  it("take none of the owner's mailboxes: only a reply does", async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'one');
    await owner.messaging.sync();
    const local = await across(sender.db, conv, owner.db);
    const pool = await poolSize(owner.db);

    // Read: the sender sees it, but keeps writing to the link.
    await owner.messaging.markSeen(local);
    expect((await getConversation(owner.db, local))!.myMailbox).toBeNull();
    expect(await poolSize(owner.db)).toBe(pool);
    await sender.messaging.sync();
    expect((await listMessages(sender.db, conv)).map((m) => m.status)).toEqual(['seen']);
    expect((await getConversation(sender.db, conv))!.sendTo).toBe(bundle.mailbox);

    // Their next message still arrives, for the key the receipt brought.
    await sender.messaging.send(conv, 'two');
    expect(await owner.messaging.sync()).toBe(1);
    await owner.messaging.markSeen(local);
    expect((await getConversation(owner.db, local))!.myMailbox).toBeNull();
    expect(await poolSize(owner.db)).toBe(pool);

    // A reply takes one, and they move to it.
    await owner.messaging.send(local, 'hi');
    const mine = (await getConversation(owner.db, local))!.myMailbox;
    expect(mine).not.toBeNull();
    await sender.messaging.sync();
    expect((await getConversation(sender.db, conv))!.sendTo).toBe(mine);
    await sender.messaging.send(conv, 'three');
    expect(await owner.messaging.sync()).toBe(1);
    expect((await listMessages(owner.db, local)).map((m) => m.text)).toEqual(['one', 'two', 'hi', 'three']);
  });

  it('a chat deleted for both before any reply takes no mailbox either', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'spam');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    await owner.messaging.remove(mine, true);
    expect((await getConversation(owner.db, mine))!.myMailbox).toBeNull();
    expect(await sender.messaging.sync()).toBeGreaterThanOrEqual(0);
    expect(await listMessages(sender.db, conv)).toEqual([]);
  });
});

describe('blocks', () => {
  it('silence a person: this conversation, and new ones through the same link', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const other = await person(backend, 'other');
    const { ref, bundle } = await linkOf(backend, owner);

    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    await owner.messaging.send(mine, 'hi');
    await sender.messaging.sync();

    await owner.messaging.block(mine);
    // Their sends still look accepted, but nothing arrives.
    await sender.messaging.send(conv, 'are you there?');
    await sender.messaging.startConversation(ref, bundle, 'it is me again');
    expect(await owner.messaging.sync()).toBe(0);
    // Someone else still gets through.
    await other.messaging.startConversation(ref, bundle, 'hello from someone else');
    expect(await owner.messaging.sync()).toBe(1);
    const statuses = (await listConversations(owner.db)).map((c) => c.status).sort();
    expect(statuses).toEqual(['active', 'blocked']);
  });

  it('work before the owner ever replied', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    await owner.messaging.block(mine);
    // Still writing to the link's intro mailbox, which the owner can't discard.
    await sender.messaging.send(conv, 'more');
    expect(await owner.messaging.sync()).toBe(0);
    expect((await listMessages(owner.db, mine)).map((m) => m.text)).toEqual(['hello']);
  });

  it('ask once more, 2 seconds later, when the server finds no such mailbox', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    await owner.messaging.send(mine, 'hi');
    const mailbox = (await getConversation(owner.db, mine))!.myMailbox!;

    // The first answer is not_found (a mailbox made a moment ago, not seen
    // yet), the second discards it.
    const call = owner.session.call.bind(owner.session);
    let discards = 0;
    owner.session.call = async function (...args) {
      if (args[0] === 'POST' && args[1] === `/mailboxes/${mailbox}/discard` && ++discards === 1) {
        throw new ApiError(404, 'not_found');
      }
      return call(...args);
    } as typeof call;
    await owner.messaging.block(mine);
    expect(discards).toBe(2);
    expect(backend.waits).toEqual([2000]);
    expect(backend.mailboxes.has(mailbox)).toBe(false);
    expect((await getConversation(owner.db, mine))!.status).toBe('blocked');

    // Gone already: not_found twice, and it's blocked all the same.
    await owner.messaging.block(mine);
    expect(discards).toBe(4);
    expect(backend.waits).toEqual([2000, 2000]);
    expect((await getConversation(owner.db, mine))!.status).toBe('blocked');
  });

  it('fail, recording nothing, when the server answers anything but not_found, and work when tried again', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    await owner.messaging.send(mine, 'hi');
    const mailbox = (await getConversation(owner.db, mine))!.myMailbox!;

    // The server couldn't read the mailbox: not a block done.
    const call = owner.session.call.bind(owner.session);
    let discards = 0;
    owner.session.call = async function (...args) {
      if (args[0] === 'POST' && args[1] === `/mailboxes/${mailbox}/discard` && ++discards === 1) {
        throw new ApiError(503, 'unavailable');
      }
      return call(...args);
    } as typeof call;
    await expect(owner.messaging.block(mine)).rejects.toMatchObject({ code: 'unavailable' });
    expect(discards).toBe(1);
    expect(backend.waits).toEqual([]);
    expect(backend.mailboxes.has(mailbox)).toBe(true);
    expect(await getConversation(owner.db, mine)).toMatchObject({ status: 'active', myMailbox: mailbox });

    // Tapping Block again discards it.
    await owner.messaging.block(mine);
    expect(discards).toBe(2);
    expect(backend.mailboxes.has(mailbox)).toBe(false);
    expect((await getConversation(owner.db, mine))!.status).toBe('blocked');
  });

  it('let a sender block a conversation too', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    await sender.messaging.block(conv);
    await owner.messaging.send(await across(sender.db, conv, owner.db), 'please reply');
    expect(await sender.messaging.sync()).toBe(0);
  });
});

describe('the reserved `end` kind', () => {
  /** A modified app: sends `end` in a conversation, to where it writes. */
  async function sendEnd(backend: Awaited<ReturnType<typeof fakeBackend>>, who: Person, conv: string, to: string): Promise<void> {
    const c = (await getConversation(who.db, conv))!;
    const sealed = await sealMessage(
      { kind: 'end', conv: c.wire, id: newId(), at: pace(), ...(c.myMailbox ? { reply: c.myMailbox } : {}) },
      await conversationKey(who.db, c.myKey!),
      fromBase64Url(c.peerKey!),
    );
    backend.inboxes.get(to)!.push({ id: rand(), mailbox: c.sendTo, envelope: toBase64Url(sealed) });
  }

  it('does nothing: the chat stays open for replies', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    await owner.messaging.send(mine, 'hi');
    await sender.messaging.sync();

    await sendEnd(backend, sender, conv, 'owner');
    expect(await owner.messaging.sync()).toBe(0);
    // Taken in (acked), and nothing changed.
    expect(backend.inboxes.get('owner')).toEqual([]);
    expect((await getConversation(owner.db, mine))!.status).toBe('active');
    await owner.messaging.send(mine, 'still here');
    await sender.messaging.sync();
    expect((await listMessages(sender.db, conv)).map((m) => m.text)).toEqual(['hello', 'hi', 'still here']);
  });

  it('a chat an older version ended on one is active again from their next message', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    await owner.messaging.send(mine, 'hi');
    await sender.messaging.sync();
    await putConversation(owner.db, { ...(await getConversation(owner.db, mine))!, status: 'ended' });

    // Another `end` leaves it as it is.
    await sendEnd(backend, sender, conv, 'owner');
    expect(await owner.messaging.sync()).toBe(0);
    expect((await getConversation(owner.db, mine))!.status).toBe('ended');

    await sender.messaging.send(conv, 'are you there?');
    expect(await owner.messaging.sync()).toBe(1);
    expect((await getConversation(owner.db, mine))!.status).toBe('active');
    await owner.messaging.send(mine, 'yes');
    expect(await sender.messaging.sync()).toBe(1);
  });
});

describe('deleting a conversation', () => {
  it('removes it from this device only, until they write again', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    await owner.messaging.send(mine, 'hi');
    await sender.messaging.sync();

    await owner.messaging.remove(mine);
    expect(await listMessages(owner.db, mine)).toEqual([]);
    expect((await listConversations(owner.db)).map((c) => [c.id, c.hidden, c.unread])).toEqual([[mine, true, 0]]);
    // The other side keeps theirs, and can still write: it comes back with only the new message.
    expect((await listMessages(sender.db, conv)).map((m) => m.text)).toEqual(['hello', 'hi']);
    await sender.messaging.send(conv, 'still there?');
    expect(await owner.messaging.sync()).toBe(1);
    expect((await listMessages(owner.db, mine)).map((m) => m.text)).toEqual(['still there?']);
    expect((await listConversations(owner.db))[0]!.hidden).toBe(false);
    // Replying works as before.
    await owner.messaging.send(mine, 'yes');
    expect(await sender.messaging.sync()).toBe(1);
  });
});

describe('where the user first wrote in a chat', () => {
  it('is their first message the server took, noted at once and kept once it is deleted, and forgotten with the chat', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    // Whoever starts a chat writes in it first.
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    const [hello] = await listRecords(sender.db, conv);
    expect(await getMeta(sender.db, `answered:${conv}`)).toEqual({ at: hello!.at, order: 0 });
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    expect(await answeredAt(owner.db, mine)).toBeUndefined();

    // A reply that wasn't sent doesn't count.
    const request = backend.api.request;
    backend.api.request = async (method, path, init, check) => {
      if (method === 'POST' && path === '/send') {
        backend.api.request = request;
        throw new NetworkError('down');
      }
      return request(method, path, init, check);
    };
    await expect(owner.messaging.send(mine, 'not sent')).rejects.toThrow(NetworkError);
    expect(await answeredAt(owner.db, mine)).toBeUndefined();
    // One that was is noted as it's sent, and stays once it's deleted.
    await owner.messaging.send(mine, 'hi');
    const hi = (await listRecords(owner.db, mine)).find((m) => m.out && m.status === 'sent')!;
    const place = { at: hi.at, order: hi.order ?? 0 };
    expect(await getMeta(owner.db, `answered:${mine}`)).toEqual(place);
    // In a chat from before this was kept too: noted before theirs is deleted.
    await deleteMeta(owner.db, `answered:${mine}`);
    await owner.messaging.deleteHere(mine, hi.id);
    expect(await getMeta(owner.db, `answered:${mine}`)).toEqual(place);
    expect(await answeredAt(owner.db, mine)).toEqual(place);

    // Deleting the chat forgets it: written to again, it's a chat the owner hasn't written in.
    await owner.messaging.remove(mine);
    expect(await getMeta(owner.db, `answered:${mine}`)).toBeUndefined();
    await sender.messaging.send(conv, 'still there?');
    expect(await owner.messaging.sync()).toBe(1);
    expect(await answeredAt(owner.db, mine)).toBeUndefined();
  });

  it("is forgotten when they delete the whole chat for both sides: their next photo waits for a tap", async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    await owner.messaging.send(mine, 'hi');
    expect(await answeredAt(owner.db, mine)).toBeDefined();
    await sender.messaging.sync();

    await sender.messaging.remove(conv, true);
    await owner.messaging.sync();
    expect(await listMessages(owner.db, mine)).toEqual([]);
    expect(await getMeta(owner.db, `answered:${mine}`)).toBeUndefined();
    // They write again with a photo: the chat has nothing of the owner's, and it waits.
    const photo = crypto.getRandomValues(new Uint8Array(400));
    await sender.messaging.sendMedia(conv, { file: photo, media: { t: 'photo', s: photo.length, w: 4, h: 4, m: 'image/jpeg' } });
    expect(await owner.messaging.sync()).toBe(1);
    expect(await listMessages(owner.db, mine)).toMatchObject([{ media: { t: 'photo' }, file: 'remote' }]);
    expect(await answeredAt(owner.db, mine)).toBeUndefined();
  });

  it('counts an attachment of theirs that was sent, and not one whose send failed', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    const photo = crypto.getRandomValues(new Uint8Array(500));
    const out = { file: photo, media: { t: 'photo', s: photo.length, w: 5, h: 5, m: 'image/jpeg' } };
    backend.down.uploads = true;
    await expect(owner.messaging.sendMedia(mine, out)).rejects.toThrow();
    expect(await answeredAt(owner.db, mine)).toBeUndefined();
    backend.down.uploads = false;
    await owner.messaging.sendMedia(mine, out);
    const sent = (await listRecords(owner.db, mine)).find((m) => m.out && m.status === 'sent')!;
    expect(await getMeta(owner.db, `answered:${mine}`)).toEqual({ at: sent.at, order: sent.order ?? 0 });
  });
});

describe('a replaced link', () => {
  it('keeps its blocks and labels, and the old one stops working', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const blocked = await person(backend, 'blocked');
    const friend = await person(backend, 'friend');
    const old = await linkOf(backend, owner);
    const spam = await blocked.messaging.startConversation(old.ref, old.bundle, 'spam');
    await friend.messaging.startConversation(old.ref, old.bundle, 'hi, it is me');
    expect(await owner.messaging.sync()).toBe(2);
    await owner.messaging.block(await across(blocked.db, spam, owner.db));
    const labelOf = async (text: string) => {
      for (const c of await listConversations(owner.db)) {
        if ((await listMessages(owner.db, c.id)).some((m) => m.text === text)) return c.label;
      }
      return null;
    };
    const friendLabel = await labelOf('hi, it is me');

    const record = await replaceLink(owner.db, owner.session, backend.api);
    expect(record.fingerprint).toBe(old.ref.fingerprint);
    expect(record.id).not.toBe(old.ref.id);
    expect((await listLinks(owner.db)).map((l) => l.id)).toEqual([record.id]);
    await expect(backend.api.request('GET', `/links/${old.ref.id}`, {}, checkBundle)).rejects.toThrow();
    const next = { ref: { id: record.id, fingerprint: record.fingerprint }, bundle: await backend.api.request('GET', `/links/${record.id}`, {}, checkBundle) };

    // The blocked person writes through the new link: dropped.
    await blocked.messaging.startConversation(next.ref, next.bundle, 'remember me?');
    expect(await owner.messaging.sync()).toBe(0);
    // The friend starts again through the new link: the same label as before.
    await friend.messaging.startConversation(next.ref, next.bundle, 'new link, same me');
    expect(await owner.messaging.sync()).toBe(1);
    expect(await labelOf('new link, same me')).toBe(friendLabel);
  });
});

describe('key rotation', () => {
  const DAY = 24 * 3600 * 1000;
  const convKeys = async (db: Database, conv: string) =>
    Object.values((await getMeta<Record<string, KeyEntry>>(db, 'recipient-keys')) ?? {}).filter((e) => e.conv === conv);
  const linkKeys = async (db: Database, link: string) =>
    Object.values((await getMeta<Record<string, KeyEntry>>(db, 'recipient-keys')) ?? {}).filter((e) => e.link?.id === link);

  it('replaces our conversation key weekly with the next message, and deletes the old one once they use the new', async () => {
    const backend = await fakeBackend();
    let clock = Date.now();
    const now = () => clock;
    const owner = await person(backend, 'owner', now);
    const sender = await person(backend, 'sender', now);
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    await owner.messaging.send(mine, 'hi');
    await sender.messaging.sync();
    const first = (await getConversation(owner.db, mine))!.myKey!;

    // Before it's due: the same key.
    clock += 5 * DAY;
    await owner.messaging.send(mine, 'still the same key');
    expect((await getConversation(owner.db, mine))!.myKey).toBe(first);

    // Due: the next message carries a new key; nothing extra is sent.
    clock += 5 * DAY;
    const sendsBefore = backend.seenEnvelopes.length;
    await owner.messaging.send(mine, 'a new key comes with this');
    expect(backend.seenEnvelopes.length).toBe(sendsBefore + 1);
    const second = (await getConversation(owner.db, mine))!.myKey!;
    expect(second).not.toBe(first);
    expect(await sender.messaging.sync()).toBe(2);
    expect((await getConversation(sender.db, conv))!.peerKey).toBe(second);

    // The old key stays while they haven't written to the new one...
    expect((await convKeys(owner.db, mine)).map((k) => [k.pub, k.deleteAfter])).toEqual([
      [first, undefined],
      [second, undefined],
    ]);
    clock += 40 * DAY;
    await owner.messaging.maintain();
    expect((await convKeys(owner.db, mine)).length).toBe(2);

    // ...and goes 35 days after they have.
    await sender.messaging.send(conv, 'got your new key');
    expect(await owner.messaging.sync()).toBe(1);
    expect((await convKeys(owner.db, mine)).find((k) => k.pub === first)!.deleteAfter).toBe(clock + KEY_RETENTION_MS);
    clock += 34 * DAY;
    await owner.messaging.maintain();
    expect((await convKeys(owner.db, mine)).length).toBe(2);
    clock += 2 * DAY;
    await owner.messaging.maintain();
    expect((await convKeys(owner.db, mine)).map((k) => k.pub)).toEqual([second]);
    expect(await getSealed(owner.db, (await convKeys(owner.db, mine))[0]!.name)).toBeDefined();
    // Still talking.
    await sender.messaging.send(conv, 'still here');
    expect(await owner.messaging.sync()).toBe(1);
  });

  it("doesn't replace a sender's key before the owner has answered", async () => {
    const backend = await fakeBackend();
    let clock = Date.now();
    const owner = await person(backend, 'owner', () => clock);
    const sender = await person(backend, 'sender', () => clock);
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    const key = (await getConversation(sender.db, conv))!.myKey;
    clock += 10 * DAY;
    await sender.messaging.send(conv, 'anyone?');
    expect((await getConversation(sender.db, conv))!.myKey).toBe(key);
    expect(await owner.messaging.sync()).toBe(2);
  });

  it("replaces the link's key weekly; unanswered senders follow it; the old one goes after 35 days", async () => {
    const backend = await fakeBackend();
    let clock = Date.now();
    const now = () => clock;
    const owner = await person(backend, 'owner', now);
    const early = await person(backend, 'early', now);
    const later = await person(backend, 'later', now);
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await early.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const firstKey = bundle.keys[0]!.key;

    await owner.messaging.maintain();
    expect((await linkKeys(owner.db, ref.id)).length).toBe(1);
    clock += 10 * DAY;
    await owner.messaging.maintain();
    const rotated = await backend.api.request('GET', `/links/${ref.id}`, {}, checkBundle);
    expect(rotated.keys).toHaveLength(1);
    expect(toBase64Url(rotated.keys[0]!.key)).not.toBe(toBase64Url(firstKey));
    const keys = await linkKeys(owner.db, ref.id);
    expect(keys.map((k) => k.deleteAfter !== undefined)).toEqual([true, false]);
    // Both are the link's: first messages count only through its intro mailbox.
    expect(keys.map((k) => k.link!.mailbox)).toEqual([bundle.mailbox, bundle.mailbox]);

    // Not answered yet: the early sender fetches the new key before writing again.
    await early.messaging.send(conv, 'me again');
    expect((await getConversation(early.db, conv))!.peerKey).toBe(toBase64Url(rotated.keys[0]!.key));
    // Someone new writes to the new key.
    await later.messaging.startConversation(ref, rotated, 'hi from later');
    expect(await owner.messaging.sync()).toBe(2);

    // 36 days on: the first key is deleted (and the link has moved on again).
    const firstName = keys[0]!.name;
    clock += 36 * DAY;
    await owner.messaging.maintain();
    const after = await linkKeys(owner.db, ref.id);
    expect(after.map((k) => k.pub)).not.toContain(toBase64Url(firstKey));
    expect(await getSealed(owner.db, firstName)).toBeUndefined();
    expect(after.map((k) => k.deleteAfter !== undefined)).toEqual([true, false]);
  });

  it("doesn't fetch the link's key with every send while that fails", async () => {
    const backend = await fakeBackend();
    let clock = Date.now();
    const now = () => clock;
    const owner = await person(backend, 'owner', now);
    const sender = await person(backend, 'sender', now);
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    clock += 2 * 3600_000;

    for (const trouble of ['unreachable', 'busy'] as const) {
      backend.down.bundles = trouble;
      backend.bundleFetches.length = 0;
      // Sent with the key it has; one fetch, not one per send.
      for (const text of ['one', 'two', 'three']) await sender.messaging.send(conv, text);
      expect(backend.bundleFetches).toEqual([ref.id]);
      // Tried again 5 to 10 minutes later.
      clock += LINK_KEY_RETRY_MS / 2 - 1000;
      await sender.messaging.send(conv, 'four');
      expect(backend.bundleFetches).toHaveLength(1);
      clock += LINK_KEY_RETRY_MS / 2 + 1000;
      await sender.messaging.send(conv, 'five');
      expect(backend.bundleFetches).toHaveLength(2);
      clock += LINK_KEY_RETRY_MS;
    }
    backend.down.bundles = null;
    backend.bundleFetches.length = 0;
    await sender.messaging.send(conv, 'six');
    await sender.messaging.send(conv, 'seven');
    expect(backend.bundleFetches).toEqual([ref.id]);
    // Everything arrived, written with the key it had.
    expect(await owner.messaging.sync()).toBe(13);
  });
});

describe('a link signing key another account has', () => {
  const DAY = 24 * 3600 * 1000;
  const bundleOf = (backend: Awaited<ReturnType<typeof fakeBackend>>, id: string) => backend.api.request('GET', `/links/${id}`, {}, checkBundle);
  /** What the server says once another account claimed the key first (it was shared before keys were one account's). */
  const takenBySomeoneElse = async (backend: Awaited<ReturnType<typeof fakeBackend>>, linkId: string) =>
    backend.keyOwners.set(toBase64Url((await bundleOf(backend, linkId)).signingKey), 'someone else');

  it('proves the key for this account and link with every change, which the server checks', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const first = await createLink(owner.db, owner.session, backend.api);
    expect(backend.keyOwners.get(toBase64Url((await bundleOf(backend, first.id)).signingKey))).toBe('owner');
    // A proof for another account doesn't do.
    backend.accountIds.set('owner', toBase64Url(crypto.getRandomValues(new Uint8Array(16))));
    await expect(replaceLink(owner.db, owner.session, backend.api)).rejects.toMatchObject({ code: 'invalid_link' });
    expect((await listLinks(owner.db)).map((l) => l.id)).toEqual([first.id]);
  });

  it('replacing makes the link with a new signing key, and says so', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const first = await createLink(owner.db, owner.session, backend.api);
    await takenBySomeoneElse(backend, first.id);

    expect(await newKeyToTell(owner.db)).toBe(false);
    const next = await replaceLink(owner.db, owner.session, backend.api);
    expect(await newKeyToTell(owner.db)).toBe(true);
    expect(next.fingerprint).not.toBe(first.fingerprint);
    expect(backend.bundles.has(first.id)).toBe(false);
    expect(backend.keyOwners.get(toBase64Url((await bundleOf(backend, next.id)).signingKey))).toBe('owner');
    expect((await listLinks(owner.db)).map((l) => [l.id, l.fingerprint])).toEqual([[next.id, next.fingerprint]]);
    // Told, it's forgotten; from then on the new key is the account's, kept as usual.
    await toldNewKey(owner.db);
    const third = await replaceLink(owner.db, owner.session, backend.api);
    expect(await newKeyToTell(owner.db)).toBe(false);
    expect(third.fingerprint).toBe(next.fingerprint);
  });

  it('creating does the same', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const first = await createLink(owner.db, owner.session, backend.api);
    await takenBySomeoneElse(backend, first.id);
    await revokeLink(owner.db, owner.session, first.id);
    const made = await createLink(owner.db, owner.session, backend.api);
    expect(await newKeyToTell(owner.db)).toBe(true);
    expect(made.fingerprint).not.toBe(first.fingerprint);
    expect((await listLinks(owner.db)).map((l) => l.id)).toEqual([made.id]);
  });

  it('upkeep replaces a link it can no longer rotate, and tells the app; then rotates as usual', async () => {
    const backend = await fakeBackend();
    let clock = Date.now();
    const owner = await person(backend, 'owner', () => clock);
    const onNewLink = vi.fn();
    const onLinks = vi.fn();
    const messaging = owner.open({ onNewLink, onLinks });
    const first = await createLink(owner.db, owner.session, backend.api);
    await takenBySomeoneElse(backend, first.id);

    clock += 10 * DAY;
    await messaging.maintain();
    // Only onNewLink: the app redraws with the notice, which a second redraw could overwrite.
    expect(onNewLink).toHaveBeenCalledOnce();
    expect(onLinks).not.toHaveBeenCalled();
    expect(await newKeyToTell(owner.db)).toBe(true);
    const [link] = await listLinks(owner.db);
    expect(link!.id).not.toBe(first.id);
    expect(link!.fingerprint).not.toBe(first.fingerprint);
    expect(backend.bundles.has(first.id)).toBe(false);

    clock += 10 * DAY;
    expect(await rotateLinkKey(owner.db, owner.session, Math.floor(clock / 1000))).toBe(true);
    expect((await listLinks(owner.db))[0]!.id).toBe(link!.id);
    expect(onNewLink).toHaveBeenCalledOnce();
  });

  it("still tells of the new key when the new link's answer was lost, once upkeep finds the link", async () => {
    const backend = await fakeBackend();
    let clock = Date.now();
    const owner = await person(backend, 'owner', () => clock);
    const onNewLink = vi.fn();
    const onLinks = vi.fn();
    const messaging = owner.open({ onNewLink, onLinks });
    const first = await createLink(owner.db, owner.session, backend.api);
    await takenBySomeoneElse(backend, first.id);
    // The first try is refused (the key is taken); the second, with a new
    // key, is made, but its answer is lost.
    const call = owner.session.call;
    let posts = 0;
    owner.session.call = async function (m, p, ...rest) {
      if (m !== 'POST' || p !== '/links' || ++posts < 2) return call(m, p, ...rest);
      owner.session.call = call;
      await call(m, p, ...rest);
      throw new NetworkError('answer lost');
    } as Session['call'];
    await expect(replaceLink(owner.db, owner.session, backend.api)).rejects.toThrow(NetworkError);
    expect((await listLinks(owner.db)).map((l) => l.id)).toEqual([first.id]);
    expect(await newKeyToTell(owner.db)).toBe(true);

    // The app closed, say; at the next upkeep the link is found and taken.
    clock += 60 * 1000;
    await messaging.maintain();
    const [link] = await listLinks(owner.db);
    expect(link!.id).not.toBe(first.id);
    expect(link!.fingerprint).not.toBe(first.fingerprint);
    expect(onNewLink).toHaveBeenCalledOnce();
    expect(onLinks).not.toHaveBeenCalled();
    // Still to tell until the app has shown it.
    expect(await newKeyToTell(owner.db)).toBe(true);
  });

  it('a stuck link whose replacement failed is replaced at a later upkeep, with the key made then', async () => {
    const backend = await fakeBackend();
    let clock = Date.now();
    const owner = await person(backend, 'owner', () => clock);
    const onNewLink = vi.fn();
    const messaging = owner.open({ onNewLink });
    const first = await createLink(owner.db, owner.session, backend.api);
    await takenBySomeoneElse(backend, first.id);
    clock += 10 * DAY;
    // The replacement never reaches the server.
    failRequest(owner, 'POST', /^\/links$/, new NetworkError('offline'));
    await expect(messaging.maintain()).rejects.toThrow(NetworkError);
    expect((await listLinks(owner.db)).map((l) => l.id)).toEqual([first.id]);
    expect(onNewLink).not.toHaveBeenCalled();
    // Once that change is given up, upkeep replaces the link (whose key it
    // no longer has as the account's) with the account's new key.
    clock += 11 * 60 * 1000;
    await messaging.maintain();
    expect(onNewLink).toHaveBeenCalledOnce();
    const [link] = await listLinks(owner.db);
    expect(link!.id).not.toBe(first.id);
    expect(link!.fingerprint).not.toBe(first.fingerprint);
    expect(backend.bundles.has(first.id)).toBe(false);
  });
});

describe('link changes whose answer was lost', () => {
  const DAY = 24 * 3600 * 1000;
  const linkKeys = async (db: Database, link: string) =>
    Object.values((await getMeta<Record<string, KeyEntry>>(db, 'recipient-keys')) ?? {}).filter((e) => e.link?.id === link);
  const bundleOf = (backend: Awaited<ReturnType<typeof fakeBackend>>, id: string) => backend.api.request('GET', `/links/${id}`, {}, checkBundle);

  it('keep a new link key the server took, so first messages to it arrive, and take it at the next upkeep', async () => {
    const backend = await fakeBackend();
    let clock = Date.now();
    const owner = await person(backend, 'owner', () => clock);
    const { ref, bundle } = await linkOf(backend, owner);
    clock += 10 * DAY;
    loseAnswer(owner, 'PUT', /^\/links\/.+\/keys$/);
    await expect(owner.messaging.maintain()).rejects.toThrow(NetworkError);
    // The server took it: the bundle lists only the new key.
    const rotated = await bundleOf(backend, ref.id);
    expect(rotated.keys).toHaveLength(1);
    expect(toBase64Url(rotated.keys[0]!.key)).not.toBe(toBase64Url(bundle.keys[0]!.key));

    // Someone writes to it before the next upkeep: it arrives.
    const sender = await person(backend, 'sender', () => clock);
    await sender.messaging.startConversation(ref, rotated, 'to the new key');
    expect(await owner.messaging.sync()).toBe(1);

    // The next upkeep takes it as the link's key: no second rotation, and the old key goes in 35 days.
    await owner.messaging.maintain();
    expect(toBase64Url((await bundleOf(backend, ref.id)).keys[0]!.key)).toBe(toBase64Url(rotated.keys[0]!.key));
    const [link] = await listLinks(owner.db);
    expect(link!.keys.map((k) => k.pub)).toContain(toBase64Url(rotated.keys[0]!.key));
    expect(link!.rotateAt).toBeGreaterThan(clock / 1000);
    const keys = await linkKeys(owner.db, ref.id);
    expect(keys.map((k) => [k.pub, k.deleteAfter !== undefined, k.link!.mailbox])).toEqual([
      [toBase64Url(bundle.keys[0]!.key), true, bundle.mailbox],
      [toBase64Url(rotated.keys[0]!.key), false, bundle.mailbox],
    ]);
    expect(await getMeta(owner.db, 'link-change')).toBeUndefined();
    await (await person(backend, 'later', () => clock)).messaging.startConversation(ref, rotated, 'later');
    expect(await owner.messaging.sync()).toBe(1);
  });

  it('keep a new link key when the app closes just after publishing it', async () => {
    const backend = await fakeBackend();
    let clock = Date.now();
    const owner = await person(backend, 'owner', () => clock);
    const { ref } = await linkOf(backend, owner);
    clock += 10 * DAY;
    loseAnswer(owner, 'PUT', /^\/links\/.+\/keys$/, new Error('closed'));
    await expect(owner.messaging.maintain()).rejects.toThrow('closed');
    const rotated = await bundleOf(backend, ref.id);
    await (await person(backend, 'sender', () => clock)).messaging.startConversation(ref, rotated, 'meanwhile');
    // Opened again: what came opens, and the upkeep settles the key.
    const app = owner.open();
    expect(await app.sync()).toBe(1);
    await app.maintain();
    expect((await listLinks(owner.db))[0]!.keys.map((k) => k.pub)).toContain(toBase64Url(rotated.keys[0]!.key));
    expect(await getMeta(owner.db, 'link-change')).toBeUndefined();
  });

  it('index a key an older version published but never indexed, and drop loose ones it no longer offers', async () => {
    const backend = await fakeBackend();
    let clock = Date.now();
    const owner = await person(backend, 'owner', () => clock);
    const { ref, bundle } = await linkOf(backend, owner);
    clock += 10 * DAY;
    loseAnswer(owner, 'PUT', /^\/links\/.+\/keys$/);
    await expect(owner.messaging.maintain()).rejects.toThrow(NetworkError);
    const rotated = await bundleOf(backend, ref.id);
    const fresh = toBase64Url(rotated.keys[0]!.key);
    // As an older version left it, closed between publishing and indexing:
    // sealed, published, but not indexed, and nothing noted.
    await deleteMeta(owner.db, 'link-change');
    await unindexKeys(owner.db, (e) => e.pub === fresh);
    // And a key it sealed once but never published, older than the link's.
    const vaultKey = (await getKey(owner.db, 'vault-key'))!;
    const stray = keyName(ref.id, bundle.keys[0]!.from - 3600);
    await putSealed(owner.db, stray, await seal(vaultKey, (await generateCopyableAgreementKey()).privateKey, stray));

    const sender = await person(backend, 'sender', () => clock);
    await sender.messaging.startConversation(ref, rotated, 'to the key never indexed');
    await owner.messaging.maintain();
    expect((await linkKeys(owner.db, ref.id)).map((k) => k.pub)).toContain(fresh);
    expect(await owner.messaging.sync()).toBe(1);
    expect(await getSealed(owner.db, stray)).toBeUndefined();
    // Nothing loose is left to ask about.
    backend.bundleFetches.length = 0;
    await owner.messaging.maintain();
    expect(backend.bundleFetches).toEqual([]);
  });

  it('find a new link the server made at the next upkeep, instead of leaving it unknown', async () => {
    const backend = await fakeBackend();
    backend.linkRules.max = 1;
    const owner = await person(backend, 'owner');
    loseAnswer(owner, 'POST', /^\/links$/);
    await expect(createLink(owner.db, owner.session, backend.api)).rejects.toThrow(NetworkError);
    expect(await listLinks(owner.db)).toEqual([]);
    const [ghost] = [...backend.bundles.keys()];
    // The app hears of it, to show it.
    let shown = 0;
    await owner.open({ onLinks: () => shown++ }).maintain();
    expect(shown).toBe(1);
    const [link] = await listLinks(owner.db);
    const bundle = await bundleOf(backend, ghost!);
    expect(link).toMatchObject({ id: ghost, mailbox: bundle.mailbox });
    // It works: first messages through it arrive.
    await (await person(backend, 'sender')).messaging.startConversation({ id: link!.id, fingerprint: link!.fingerprint }, bundle, 'hi');
    expect(await owner.messaging.sync()).toBe(1);
  });

  it('take the link the server made when asked again, rather than hit the limit', async () => {
    const backend = await fakeBackend();
    backend.linkRules.max = 1;
    const owner = await person(backend, 'owner');
    loseAnswer(owner, 'POST', /^\/links$/);
    await expect(createLink(owner.db, owner.session, backend.api)).rejects.toThrow(NetworkError);
    const [ghost] = [...backend.bundles.keys()];
    const record = await createLink(owner.db, owner.session, backend.api);
    expect(record.id).toBe(ghost);
    expect((await listLinks(owner.db)).map((l) => l.id)).toEqual([ghost]);
    expect(backend.bundles.size).toBe(1);
  });

  it('send a new link again with the same ID, so the server never makes two', async () => {
    const backend = await fakeBackend();
    backend.linkRules.max = 1;
    const owner = await person(backend, 'owner');
    const ids: string[] = [];
    const call = owner.session.call;
    owner.session.call = async function (method, path, body, ...rest) {
      if (path === '/links') ids.push((body as { id: string }).id);
      return call(method, path, body, ...rest);
    } as Session['call'];
    // Never got there: the server has nothing.
    failRequest(owner, 'POST', /^\/links$/, new NetworkError('offline'));
    await expect(createLink(owner.db, owner.session, backend.api)).rejects.toThrow(NetworkError);
    expect(backend.bundles.size).toBe(0);
    const noted = (await getMeta<{ id: string }>(owner.db, 'link-change'))!.id;
    const first = await createLink(owner.db, owner.session, backend.api);
    expect(first.id).toBe(noted);
    expect(ids).toEqual([noted]);

    // Made, the answer lost, and the bundle read lagging behind: sent again
    // with the same ID, refused (the account has its link), then found.
    await revokeLink(owner.db, owner.session, first.id);
    ids.length = 0;
    loseAnswer(owner, 'POST', /^\/links$/);
    await expect(createLink(owner.db, owner.session, backend.api)).rejects.toThrow(NetworkError);
    const request = backend.api.request;
    let lagging = true;
    backend.api.request = async (method, path, init, check) => {
      if (method === 'GET' && path.startsWith('/links/') && lagging) {
        lagging = false;
        throw new ApiError(404, 'not_found');
      }
      return request(method, path, init, check);
    };
    const second = await createLink(owner.db, owner.session, backend.api);
    expect(ids).toEqual([second.id, second.id]);
    expect([...backend.bundles.keys()]).toEqual([second.id]);
    expect((await listLinks(owner.db)).map((l) => l.id)).toEqual([second.id]);
  });

  it('take a replacement the server made when asked again, keeping the old keys for 35 days', async () => {
    const backend = await fakeBackend();
    backend.linkRules.max = 1;
    const owner = await person(backend, 'owner');
    const old = await linkOf(backend, owner);
    loseAnswer(owner, 'POST', /^\/links$/);
    await expect(replaceLink(owner.db, owner.session, backend.api)).rejects.toThrow(NetworkError);
    const [ghost] = [...backend.bundles.keys()];
    expect(ghost).not.toBe(old.ref.id);
    const record = await replaceLink(owner.db, owner.session, backend.api);
    expect(record.id).toBe(ghost);
    expect((await listLinks(owner.db)).map((l) => l.id)).toEqual([ghost]);
    // The old link's keys stay for what was sent to it before.
    const keys = await linkKeys(owner.db, old.ref.id);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.deleteAfter).toBeDefined();
    expect(await getSealed(owner.db, keys[0]!.name)).toBeDefined();
  });

  it("give up on a new link the server doesn't have, once it can't still be on its way", async () => {
    const backend = await fakeBackend();
    let clock = Date.now();
    const owner = await person(backend, 'owner', () => clock);
    failRequest(owner, 'POST', /^\/links$/, new NetworkError('offline'));
    await expect(createLink(owner.db, owner.session, backend.api, () => Math.floor(clock / 1000))).rejects.toThrow(NetworkError);
    const change = (await getMeta<{ id: string }>(owner.db, 'link-change'))!;
    expect(await listSealed(owner.db, `link:${change.id}:`)).toHaveLength(1);
    await owner.messaging.maintain();
    expect(await getMeta(owner.db, 'link-change')).toBeDefined();
    clock += 11 * 60 * 1000;
    await owner.messaging.maintain();
    expect(await getMeta(owner.db, 'link-change')).toBeUndefined();
    expect(await listSealed(owner.db, `link:${change.id}:`)).toEqual([]);
    expect(await linkKeys(owner.db, change.id)).toEqual([]);
  });

  it('never write a new link key over one kept from a change that was not taken', async () => {
    const backend = await fakeBackend();
    let clock = Date.now();
    const owner = await person(backend, 'owner', () => clock);
    const { ref } = await linkOf(backend, owner);
    clock += 10 * DAY;
    /** The link's keys here: each under a name of its own, sealed as the private half of the key indexed. */
    const ownKeys = async () => {
      const entries = await linkKeys(owner.db, ref.id);
      expect(new Set(entries.map((e) => e.name)).size).toBe(entries.length);
      for (const e of entries) expect(await sealedMatches(owner.db, e.name, fromBase64Url(e.pub))).toBe(true);
      return entries.map((e) => e.pub);
    };
    // No back-dating: keys made in the same hour would get the same name.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      // Never got there; the next upkeep finds it wasn't taken and keeps it
      // 35 days, and in the same hour has no hour free for another.
      failRequest(owner, 'PUT', /^\/links\/.+\/keys$/, new NetworkError('offline'));
      await expect(owner.messaging.maintain()).rejects.toThrow(NetworkError);
      const kept = (await getMeta<{ key: { key: string; from: number } }>(owner.db, 'link-change'))!.key;
      await owner.messaging.maintain();
      expect(await getMeta(owner.db, 'link-change')).toBeUndefined();
      expect(await ownKeys()).toHaveLength(2);
      expect(await ownKeys()).toContain(kept.key);
      // An hour on: rotated, after the kept key.
      clock += 3600_000;
      await owner.messaging.maintain();
      expect(await ownKeys()).toHaveLength(3);
      expect((await bundleOf(backend, ref.id)).keys[0]!.from).toBeGreaterThan(kept.from);
    } finally {
      random.mockRestore();
    }
  });

  it('make a fresh link when the one noted was never sealed, and so never sent', async () => {
    const backend = await fakeBackend();
    backend.linkRules.max = 1;
    const owner = await person(backend, 'owner');
    failRequest(owner, 'POST', /^\/links$/, new NetworkError('offline'));
    await expect(createLink(owner.db, owner.session, backend.api)).rejects.toThrow(NetworkError);
    const noted = (await getMeta<{ id: string; key: { from: number } }>(owner.db, 'link-change'))!;
    // As if the app closed, or storage failed, between noting it and sealing its key.
    await deleteSealed(owner.db, keyName(noted.id, noted.key.from));
    await unindexKeys(owner.db, (e) => e.link?.id === noted.id);
    const record = await createLink(owner.db, owner.session, backend.api);
    expect(record.id).not.toBe(noted.id);
    expect(await sealedMatches(owner.db, keyName(record.id, record.keys[0]!.from), fromBase64Url(record.keys[0]!.pub!))).toBe(true);
    expect([...backend.bundles.keys()]).toEqual([record.id]);
  });

  it('keep a new link that a refused second send and lagging reads leave unseen, and take it once they catch up', async () => {
    const backend = await fakeBackend();
    backend.linkRules.max = 1;
    const owner = await person(backend, 'owner');
    loseAnswer(owner, 'POST', /^\/links$/);
    await expect(createLink(owner.db, owner.session, backend.api)).rejects.toThrow(NetworkError);
    const [ghost] = [...backend.bundles.keys()];
    // Both reads of the bundle lag behind: not found.
    const request = backend.api.request;
    let lagging = 2;
    backend.api.request = async (method, path, init, check) => {
      if (method === 'GET' && path.startsWith('/links/') && lagging > 0) {
        lagging--;
        throw new ApiError(404, 'not_found');
      }
      return request(method, path, init, check);
    };
    await expect(createLink(owner.db, owner.session, backend.api)).rejects.toMatchObject({ code: 'link_limit' });
    expect(lagging).toBe(0);
    expect((await getMeta<{ id: string }>(owner.db, 'link-change'))!.id).toBe(ghost);
    const record = await createLink(owner.db, owner.session, backend.api);
    expect(record.id).toBe(ghost);
    expect((await listLinks(owner.db)).map((l) => l.id)).toEqual([ghost]);
  });

  it('count the 10 minutes from the last time a new link was sent', async () => {
    const backend = await fakeBackend();
    backend.linkRules.max = 1;
    let clock = Date.now();
    const seconds = () => Math.floor(clock / 1000);
    const owner = await person(backend, 'owner', () => clock);
    failRequest(owner, 'POST', /^\/links$/, new NetworkError('offline'));
    await expect(createLink(owner.db, owner.session, backend.api, seconds)).rejects.toThrow(NetworkError);
    // Asked again 20 minutes on: made this time, but the answer lost.
    clock += 20 * 60 * 1000;
    loseAnswer(owner, 'POST', /^\/links$/);
    await expect(createLink(owner.db, owner.session, backend.api, seconds)).rejects.toThrow(NetworkError);
    const [ghost] = [...backend.bundles.keys()];
    // An upkeep at once, its read lagging behind: too soon to give it up.
    const request = backend.api.request;
    backend.api.request = async (method, path, init, check) => {
      if (method !== 'GET' || !path.startsWith('/links/')) return request(method, path, init, check);
      backend.api.request = request;
      throw new ApiError(404, 'not_found');
    };
    await owner.messaging.maintain();
    expect(await getMeta(owner.db, 'link-change')).toBeDefined();
    await owner.messaging.maintain();
    expect((await listLinks(owner.db)).map((l) => l.id)).toEqual([ghost]);
  });

  it('revoke a replacement whose answer was lost along with the link it replaced', async () => {
    const backend = await fakeBackend();
    backend.linkRules.max = 1;
    const owner = await person(backend, 'owner');
    const old = await linkOf(backend, owner);
    loseAnswer(owner, 'POST', /^\/links$/);
    await expect(replaceLink(owner.db, owner.session, backend.api)).rejects.toThrow(NetworkError);
    const [replacement] = [...backend.bundles.keys()];
    expect(replacement).not.toBe(old.ref.id);
    const deletes: string[] = [];
    const call = owner.session.call;
    owner.session.call = async function (method, path, ...rest) {
      if (method === 'DELETE') deletes.push(path);
      return call(method, path, ...rest);
    } as Session['call'];
    await revokeLink(owner.db, owner.session, old.ref.id);
    // The link first, so a replacement still on its way can't outlive it.
    expect(deletes).toEqual([`/links/${old.ref.id}`, `/links/${replacement}`]);
    expect(backend.bundles.size).toBe(0);
    expect(await listLinks(owner.db)).toEqual([]);
    expect(await getMeta(owner.db, 'link-change')).toBeUndefined();
    expect(await listSealed(owner.db, 'link:')).toEqual([]);
    // Nothing comes back at upkeep, and a new link can be made.
    await owner.messaging.maintain();
    expect(await listLinks(owner.db)).toEqual([]);
    await createLink(owner.db, owner.session, backend.api);
    expect(backend.bundles.size).toBe(1);
  });

  it('revoke a link with a new key unsettled, and keep none of its keys, loose ones included', async () => {
    const backend = await fakeBackend();
    let clock = Date.now();
    const owner = await person(backend, 'owner', () => clock);
    const { ref, bundle } = await linkOf(backend, owner);
    clock += 10 * DAY;
    loseAnswer(owner, 'PUT', /^\/links\/.+\/keys$/);
    await expect(owner.messaging.maintain()).rejects.toThrow(NetworkError);
    // And a loose key an older version left.
    const vaultKey = (await getKey(owner.db, 'vault-key'))!;
    const stray = keyName(ref.id, bundle.keys[0]!.from - 3600);
    await putSealed(owner.db, stray, await seal(vaultKey, (await generateCopyableAgreementKey()).privateKey, stray));
    await revokeLink(owner.db, owner.session, ref.id);
    expect(backend.bundles.size).toBe(0);
    expect(await getMeta(owner.db, 'link-change')).toBeUndefined();
    expect(await linkKeys(owner.db, ref.id)).toEqual([]);
    expect(await listSealed(owner.db, 'link:')).toEqual([]);
    await owner.messaging.maintain();
    expect(await listLinks(owner.db)).toEqual([]);
  });

  it('give a refused resend up once the first send is 10 minutes old, and make a new link instead', async () => {
    const backend = await fakeBackend();
    backend.linkRules.max = 1;
    let clock = Date.now();
    const seconds = () => Math.floor(clock / 1000);
    const owner = await person(backend, 'owner', () => clock);
    const old = await linkOf(backend, owner);
    // A replacement that never got there; then the old link goes on the server.
    failRequest(owner, 'POST', /^\/links$/, new NetworkError('offline'));
    await expect(replaceLink(owner.db, owner.session, backend.api, seconds)).rejects.toThrow(NetworkError);
    const noted = (await getMeta<{ id: string; at: number }>(owner.db, 'link-change'))!;
    backend.bundles.delete(old.ref.id);
    backend.linkOwners.delete(old.ref.id);
    // A minute on: sent again, refused, and not shown; kept, its time unchanged.
    clock += 60_000;
    await expect(replaceLink(owner.db, owner.session, backend.api, seconds)).rejects.toMatchObject({ code: 'not_found' });
    expect(await getMeta(owner.db, 'link-change')).toMatchObject({ id: noted.id, at: noted.at });
    // Ten minutes after the first send: given up, and a new link made.
    clock += 10 * 60_000;
    const record = await replaceLink(owner.db, owner.session, backend.api, seconds);
    expect(record.id).not.toBe(noted.id);
    expect(await getMeta(owner.db, 'link-change')).toBeUndefined();
    expect((await listLinks(owner.db)).map((l) => l.id)).toEqual([record.id]);
    expect([...backend.bundles.keys()]).toEqual([record.id]);
  });

  it('leave no key behind when the app closes while revoking', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const { ref } = await linkOf(backend, owner);
    storage.closeAt = 'links';
    await expect(revokeLink(owner.db, owner.session, ref.id)).rejects.toThrow('closed');
    // Its keys went before it left the list; revoking it again finishes.
    expect(await listSealed(owner.db, `link:${ref.id}:`)).toEqual([]);
    expect(await linkKeys(owner.db, ref.id)).toEqual([]);
    expect((await listLinks(owner.db)).map((l) => l.id)).toEqual([ref.id]);
    await revokeLink(owner.db, owner.session, ref.id);
    expect(await listLinks(owner.db)).toEqual([]);
  });

  it('drop the new key at once when the server refuses the change', async () => {
    const backend = await fakeBackend();
    let clock = Date.now();
    const owner = await person(backend, 'owner', () => clock);
    const { ref } = await linkOf(backend, owner);
    clock += 10 * DAY;
    failRequest(owner, 'PUT', /^\/links\/.+\/keys$/, new ApiError(400, 'invalid_link'));
    await expect(owner.messaging.maintain()).rejects.toMatchObject({ code: 'invalid_link' });
    expect(await getMeta(owner.db, 'link-change')).toBeUndefined();
    expect(await linkKeys(owner.db, ref.id)).toHaveLength(1);
    expect(await listSealed(owner.db, `link:${ref.id}:key:`)).toHaveLength(1);
    // The next upkeep rotates.
    await owner.messaging.maintain();
    expect(await linkKeys(owner.db, ref.id)).toHaveLength(2);

    const other = await person(backend, 'other');
    failRequest(other, 'POST', /^\/links$/, new ApiError(403, 'invitation_required'));
    await expect(createLink(other.db, other.session, backend.api)).rejects.toMatchObject({ code: 'invitation_required' });
    expect(await getMeta(other.db, 'link-change')).toBeUndefined();
    expect(Object.values((await getMeta<Record<string, KeyEntry>>(other.db, 'recipient-keys')) ?? {})).toEqual([]);
    expect(await listSealed(other.db, 'link:')).toEqual([]);
  });
});

describe('unblocking', () => {
  it('lets the conversation carry on, through a new mailbox they learn quietly', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    await owner.messaging.send(mine, 'hi');
    await sender.messaging.sync();

    await owner.messaging.block(mine);
    await sender.messaging.send(conv, 'lost while blocked');
    // A new conversation through the link is dropped too.
    await sender.messaging.startConversation(ref, bundle, 'lost as well');
    expect(await owner.messaging.sync()).toBe(0);
    // Blocks used to delete the keys: unblocking copes either way.
    await scheduleKeyDeletion(owner.db, (e) => e.conv === mine, 0);
    await owner.messaging.maintain();

    const before = backend.quietSends.length;
    await owner.messaging.unblock(mine);
    expect((await getConversation(owner.db, mine))!.status).toBe('active');
    // One quiet key update went out: no Telegram notice for them.
    expect(backend.quietSends.slice(before)).toEqual([true]);
    await sender.messaging.sync();
    await sender.messaging.send(conv, 'can you hear me now?');
    expect(await owner.messaging.sync()).toBe(1);
    expect((await listMessages(owner.db, mine)).map((m) => m.text)).toEqual(['hello', 'hi', 'can you hear me now?']);
    // And new conversations through the link get through again.
    const other = await sender.messaging.startConversation(ref, bundle, 'a fresh start');
    expect(await owner.messaging.sync()).toBe(1);
    expect((await getConversation(owner.db, await across(sender.db, other, owner.db)))!.status).toBe('active');
  });

  it('needs nothing sent when the owner never replied', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    await owner.messaging.block(mine);
    const sends = backend.seenEnvelopes.length;
    await owner.messaging.unblock(mine);
    expect(backend.seenEnvelopes.length).toBe(sends);
    await sender.messaging.send(conv, 'still writing to your link');
    expect(await owner.messaging.sync()).toBe(1);
  });
});

describe('healing dead mailboxes', () => {
  it('gives a conversation a new reply mailbox when the server lost ours', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    await owner.messaging.send(mine, 'hi');
    await sender.messaging.sync();
    // The server no longer has the owner's reply mailbox, nor one in the pool
    // (as after an account was replaced on the same device).
    const dead = (await getConversation(owner.db, mine))!.myMailbox!;
    backend.mailboxes.delete(dead);
    const pool = (await getMeta<string[]>(owner.db, 'mailbox-pool'))!;
    backend.mailboxes.delete(pool[0]!);
    await sender.messaging.send(conv, 'lost');
    expect(await owner.messaging.sync()).toBe(0);

    await owner.messaging.maintain();
    expect((await getConversation(owner.db, mine))!.myMailbox).toBeNull();
    expect(await getMeta<string[]>(owner.db, 'mailbox-pool')).not.toContain(pool[0]);
    // The next message carries a new reply mailbox; their answer arrives.
    await owner.messaging.send(mine, 'are you there?');
    expect((await getConversation(owner.db, mine))!.myMailbox).not.toBe(dead);
    await sender.messaging.sync();
    await sender.messaging.send(conv, 'yes!');
    expect(await owner.messaging.sync()).toBe(1);
  });
});

describe('reactions', () => {
  it('sends a reaction quietly; the other side sees it, and the latest wins', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    const [hello] = await listMessages(owner.db, mine);
    const reactionOf = async (who: typeof owner, side: 'mine' | 'theirs') =>
      (await listMessages(who.db, who === owner ? mine : conv))[0]!.reactions?.[side]?.e;

    // The owner reacts to the sender's message: shown at once, sent with no notice.
    const quiet = backend.quietSends.length;
    await owner.messaging.react(mine, hello!.id, '❤️');
    expect(backend.quietSends.slice(quiet)).toEqual([true]);
    expect(await reactionOf(owner, 'mine')).toBe('❤️');
    expect(await sender.messaging.sync()).toBe(1);
    expect(await reactionOf(sender, 'theirs')).toBe('❤️');
    // The message itself is untouched.
    expect((await listMessages(sender.db, conv))[0]).toMatchObject({ text: 'hello', out: true });

    // Changed, then taken back.
    await owner.messaging.react(mine, hello!.id, '👍');
    const thumbs = backend.seenEnvelopes.at(-1)!;
    await owner.messaging.react(mine, hello!.id, '');
    expect(await sender.messaging.sync()).toBe(2);
    expect(await reactionOf(sender, 'theirs')).toBe('');
    // The older one delivered again doesn't bring it back.
    backend.inboxes.get('sender')!.push({ id: rand(), mailbox: [...backend.mailboxes].find(([, o]) => o === 'sender')![0], envelope: thumbs });
    expect(await sender.messaging.sync()).toBe(0);
    expect(await reactionOf(sender, 'theirs')).toBe('');

    // The sender reacts to their own message; the owner sees it as theirs.
    await sender.messaging.react(conv, hello!.id, '🔥');
    expect(await owner.messaging.sync()).toBe(1);
    expect(await reactionOf(owner, 'theirs')).toBe('🔥');
    expect(await reactionOf(owner, 'mine')).toBe('');
  });

  it('refuses a reaction that isn\'t one emoji, or to a message that isn\'t there', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    const [hello] = await listMessages(sender.db, conv);
    await expect(sender.messaging.react(conv, hello!.id, 'ok')).rejects.toThrow();
    await expect(sender.messaging.react(conv, hello!.id, '👍👍')).rejects.toThrow();
    await expect(sender.messaging.react(conv, 'AAAAAAAAAAAAAAAAAAAAAA', '👍')).rejects.toThrow();
    await expect(sender.messaging.react('another', hello!.id, '👍')).rejects.toThrow();
    expect((await listMessages(sender.db, conv))[0]!.reactions).toBeUndefined();
  });
});

describe('deleting for both sides', () => {
  it('deletes our message and its upload on both sides, opened or not', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    const photo = crypto.getRandomValues(new Uint8Array(1000));
    await sender.messaging.sendMedia(conv, { file: photo, media: { t: 'photo', s: photo.length, w: 10, h: 10, m: 'image/jpeg' } });
    await sender.messaging.send(conv, 'oops');
    expect(await owner.messaging.sync()).toBe(3);
    const mine = await across(sender.db, conv, owner.db);
    const [hello, pic, oops] = await listMessages(sender.db, conv);
    // They downloaded the photo; they haven't opened the conversation.
    await owner.messaging.fetchMedia(mine, pic!.id);
    expect(backend.uploads.size).toBe(1);
    const unread = (await getConversation(owner.db, mine))!.unread;

    const quiet = backend.quietSends.length;
    await sender.messaging.deleteForEveryone(conv, oops!.id);
    await sender.messaging.deleteForEveryone(conv, pic!.id);
    expect(backend.quietSends.slice(quiet)).toEqual([true, true]);
    await sender.messaging.flushUploadDeletes();
    // Gone here, and the upload is gone from the server.
    expect((await listMessages(sender.db, conv)).map((m) => m.text)).toEqual(['hello']);
    expect(backend.uploads.size).toBe(0);
    // Gone there too, with the downloaded photo, and from the unread count.
    expect(await owner.messaging.sync()).toBe(2);
    expect((await listMessages(owner.db, mine)).map((m) => m.id)).toEqual([hello!.id]);
    expect(await getMedia(owner.db, mine, pic!.id)).toBeUndefined();
    expect((await getConversation(owner.db, mine))!.unread).toBe(unread - 2);
  });

  it('drops a message whose delete arrives first, and keeps no empty conversation', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    const [hello] = await listMessages(sender.db, conv);
    await sender.messaging.deleteForEveryone(conv, hello!.id);
    expect((await listMessages(sender.db, conv)).length).toBe(0);
    // The delete arrives before the message.
    backend.inboxes.get('owner')!.reverse();
    expect(await owner.messaging.sync()).toBe(0);
    const mine = await across(sender.db, conv, owner.db);
    expect(await listMessages(owner.db, mine)).toEqual([]);
    const c = await getConversation(owner.db, mine);
    expect(c?.hidden).toBe(true);
    // Remembered by a keyed hash, not its ID.
    expect((await getIds(owner.db, mine)).gone?.flatMap((d) => d.tags)).toHaveLength(1);
    expect(JSON.stringify(c)).not.toContain(hello!.id);
    expect((await listConversations(owner.db)).filter((x) => !x.hidden)).toEqual([]);
  });

  it("can't delete the other side's messages, or what never went out", async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const local = await across(sender.db, conv, owner.db);
    await owner.messaging.send(local, 'my reply');
    await sender.messaging.sync();
    const reply = (await listMessages(sender.db, conv)).find((m) => !m.out)!;
    // Their message can't be deleted for both sides from here.
    await expect(sender.messaging.deleteForEveryone(conv, reply.id)).rejects.toThrow();
    // A modified app naming their message in a delete: their app ignores it.
    const record = (await sender.db.get('messages', [conv, reply.id]))!;
    await sender.db.put('messages', { ...record, out: true, status: 'sent' });
    await sender.messaging.deleteForEveryone(conv, reply.id);
    expect(await owner.messaging.sync()).toBe(0);
    expect((await listMessages(owner.db, local)).map((m) => m.text)).toEqual(['hello', 'my reply']);
    // Deleting ours for both sides takes only ours there: theirs stays.
    const [hello] = await listMessages(sender.db, conv);
    await sender.messaging.deleteForEveryone(conv, hello!.id);
    await owner.messaging.sync();
    expect((await listMessages(owner.db, local)).map((m) => m.text)).toEqual(['my reply']);
    // Deleting our own photo only for us keeps the upload, for them to fetch.
    const photo = crypto.getRandomValues(new Uint8Array(500));
    await owner.messaging.sendMedia(local, { file: photo, media: { t: 'photo', s: photo.length, w: 5, h: 5, m: 'image/jpeg' } });
    const mine = (await listMessages(owner.db, local)).at(-1)!;
    await owner.messaging.discardUploads([mine]);
    expect(backend.uploads.size).toBe(1);
  });
});

describe('deleting a whole conversation for both sides', () => {
  it("deletes both sides' messages there too, and late arrivals sent before it", async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    await owner.messaging.send(mine, 'hi back');
    await sender.messaging.sync();
    const photo = crypto.getRandomValues(new Uint8Array(800));
    await sender.messaging.sendMedia(conv, { file: photo, media: { t: 'photo', s: photo.length, w: 8, h: 8, m: 'image/jpeg' } });
    await sender.messaging.send(conv, 'late one');
    // The owner gets the photo, not yet the last message.
    const inbox = backend.inboxes.get('owner')!;
    const late = inbox.pop()!;
    await owner.messaging.sync();
    expect((await listMessages(owner.db, mine)).length).toBe(3);

    // The sender deletes the whole conversation for both sides.
    const quiet = backend.quietSends.length;
    await sender.messaging.remove(conv, true);
    expect(backend.quietSends.slice(quiet)).toEqual([true]);
    expect(await listMessages(sender.db, conv)).toEqual([]);
    await sender.messaging.flushUploadDeletes();
    expect(backend.uploads.size).toBe(0);
    // The owner's side: both sides' messages go, and it leaves the list.
    expect(await owner.messaging.sync()).toBe(1);
    expect(await listMessages(owner.db, mine)).toEqual([]);
    expect((await getConversation(owner.db, mine))!.hidden).toBe(true);
    // The message sent before it, arriving late, is dropped.
    backend.inboxes.get('owner')!.push(late);
    expect(await owner.messaging.sync()).toBe(0);
    expect(await listMessages(owner.db, mine)).toEqual([]);
    // Writing again brings it back, on both sides.
    await sender.messaging.send(conv, 'new start');
    expect(await owner.messaging.sync()).toBe(1);
    expect((await listMessages(owner.db, mine)).map((m) => m.text)).toEqual(['new start']);
    expect((await getConversation(owner.db, mine))!.hidden).toBe(false);
  });

  it('deletes nothing if it cannot be sent', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    await owner.messaging.block(mine);
    await expect(owner.messaging.remove(mine, true)).rejects.toThrow();
    expect((await listMessages(owner.db, mine)).length).toBe(1);
  });
});

withAndWithoutWebLocks('deleting uploads in the background', () => {
  it('keeps them on a list while the server is unreachable, and finishes later', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    await owner.messaging.send(await across(sender.db, conv, owner.db), 'hi');
    await sender.messaging.sync();
    for (let i = 0; i < 9; i++) {
      const photo = crypto.getRandomValues(new Uint8Array(300 + i));
      await sender.messaging.sendMedia(conv, { file: photo, media: { t: 'photo', s: photo.length, w: 3, h: 3, m: 'image/jpeg' } });
    }
    expect(backend.uploads.size).toBe(9);
    // The chat goes for both sides at once, with the server's delete route down.
    backend.down.deletes = true;
    await sender.messaging.remove(conv, true);
    await sender.messaging.flushUploadDeletes();
    expect(await listMessages(sender.db, conv)).toEqual([]);
    expect(backend.uploads.size).toBe(9);
    expect((await pendingUploadDeletes(sender.db)).length).toBe(9);
    // The list is sealed: no delete secret in the clear.
    const stored = await getMeta<Uint8Array>(sender.db, 'upload-deletes');
    const [anyUpload] = await pendingUploadDeletes(sender.db);
    expect(new TextDecoder().decode(stored!).includes(anyUpload!.d)).toBe(false);
    // Back again: the next try deletes them all, and empties the list.
    backend.down.deletes = false;
    await sender.messaging.flushUploadDeletes();
    expect(backend.uploads.size).toBe(0);
    expect(await pendingUploadDeletes(sender.db)).toEqual([]);
  });

  it('runs again for uploads queued as a run was finishing, not at the next start', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const item = () => ({ id: toBase64Url(crypto.getRandomValues(new Uint8Array(16))), d: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) });
    const a = item();
    const b = item();
    // The run has found nothing more to delete, and is about to finish.
    const finishing = gate();
    pause.listed = async (count) => {
      if (count > 0) return;
      pause.listed = null;
      await finishing.pass();
    };
    await queueUploadDeletes(owner.db, [a]);
    const running = owner.messaging.flushUploadDeletes();
    await finishing.reached;
    // Queued then: the run under way answers, and runs once more for it.
    await queueUploadDeletes(owner.db, [b]);
    expect(owner.messaging.flushUploadDeletes()).toBe(running);
    finishing.release();
    await running;
    expect(backend.mediaCalls).toEqual(['POST /media/delete', 'POST /media/delete']);
    expect(backend.deleteBatches).toEqual([[a.id], [b.id]]);
    expect(await pendingUploadDeletes(owner.db)).toEqual([]);
  });

  /** n uploads on the server, queued to delete on the owner's device, as a deleted chat's are. */
  async function queued(backend: Awaited<ReturnType<typeof fakeBackend>>, db: Database, n: number) {
    const items: { id: string; d: string }[] = [];
    for (let i = 0; i < n; i++) {
      const secret = crypto.getRandomValues(new Uint8Array(16));
      const id = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
      backend.uploads.set(id, { size: 16384, deleteHash: toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', secret))), body: null, renewals: 0 });
      items.push({ id, d: toBase64Url(secret) });
    }
    await queueUploadDeletes(db, items);
    return items;
  }

  it('deletes them 50 to a request, one request at a time, pausing between requests', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const items = await queued(backend, owner.db, 120);
    await owner.messaging.flushUploadDeletes();
    expect(backend.deleteBatches.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(backend.deleteBatches.flat()).toEqual(items.map((i) => i.id));
    expect(backend.deleting.most).toBe(1);
    // Two seconds between requests, none before the first or after the last.
    expect(backend.waits).toEqual([2000, 2000]);
    expect(backend.uploads.size).toBe(0);
    expect(await pendingUploadDeletes(owner.db)).toEqual([]);
    expect(backend.mediaCalls.every((c) => c === 'POST /media/delete')).toBe(true);
  });

  it('pauses before the next request when a flush runs again for uploads queued meanwhile', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    await queued(backend, owner.db, 1);
    // Queued while the run's only request is under way, and asked for.
    const request = backend.api.request.bind(backend.api);
    backend.api.request = async function (...args) {
      const answer = await request(...args);
      if (args[1] === '/media/delete' && backend.deleteBatches.length === 1) {
        await queued(backend, owner.db, 1);
        void owner.messaging.flushUploadDeletes();
      }
      return answer;
    } as typeof request;
    await owner.messaging.flushUploadDeletes();
    expect(backend.deleteBatches.map((b) => b.length)).toEqual([1, 1]);
    expect(backend.waits).toEqual([2000]);
    expect(backend.uploads.size).toBe(0);
  });

  it('sends fewer at once to a server that refuses so many (400)', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    backend.down.batchMost = 20;
    await queued(backend, owner.db, 40);
    await owner.messaging.flushUploadDeletes();
    // 40 refused, then 20 at a time for the rest of the run.
    expect(backend.mediaCalls.filter((c) => c === 'POST /media/delete')).toHaveLength(3);
    expect(backend.deleteBatches.map((b) => b.length)).toEqual([20, 20]);
    expect(backend.uploads.size).toBe(0);
    expect(await pendingUploadDeletes(owner.db)).toEqual([]);
    // Even one at a time refused: it stops, keeping the list.
    backend.down.batchMost = 0;
    await queued(backend, owner.db, 2);
    const calls = backend.mediaCalls.length;
    await owner.messaging.flushUploadDeletes();
    expect(backend.mediaCalls.length - calls).toBe(2);
    expect((await pendingUploadDeletes(owner.db)).length).toBe(2);
  });

  it("drops those the server doesn't know, and keeps those it failed to delete for the next try", async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const [deleted, failing, other] = await queued(backend, owner.db, 3);
    // Not on the server: deleted already, or a wrong secret.
    const unknown = { id: toBase64Url(crypto.getRandomValues(new Uint8Array(16))), d: deleted!.d };
    const wrong = { id: other!.id, d: deleted!.d };
    await forgetUploadDeletes(owner.db, [other!.id]);
    await queueUploadDeletes(owner.db, [unknown, wrong]);
    backend.down.failDeletes.add(failing!.id);
    await owner.messaging.flushUploadDeletes();
    expect(backend.deleteBatches).toEqual([[deleted!.id, failing!.id, unknown.id, wrong.id]]);
    expect(await pendingUploadDeletes(owner.db)).toEqual([failing]);
    expect([...backend.uploads.keys()].sort()).toEqual([failing!.id, other!.id].sort());
    // The bucket can again: the next try deletes it.
    backend.down.failDeletes.clear();
    await owner.messaging.flushUploadDeletes();
    expect(backend.deleteBatches.at(-1)).toEqual([failing!.id]);
    expect(await pendingUploadDeletes(owner.db)).toEqual([]);
    expect([...backend.uploads.keys()]).toEqual([other!.id]);
  });

  it('stops at a failure, leaving the rest for the next try, and when rate limited', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const items = await queued(backend, owner.db, 80);
    // The first request's last upload fails: the second isn't sent.
    backend.down.failDeletes.add(items[49]!.id);
    await owner.messaging.flushUploadDeletes();
    expect(backend.deleteBatches.map((b) => b.length)).toEqual([50]);
    expect((await pendingUploadDeletes(owner.db)).length).toBe(31);
    // Turned away by the firewall: all wait.
    backend.down.failDeletes.clear();
    backend.down.deletes = 'busy';
    await owner.messaging.flushUploadDeletes();
    expect(backend.deleteBatches).toHaveLength(1);
    expect((await pendingUploadDeletes(owner.db)).length).toBe(31);
    backend.down.deletes = false;
    await owner.messaging.flushUploadDeletes();
    expect(backend.deleteBatches.slice(1).map((b) => b.length)).toEqual([31]);
    expect(backend.uploads.size).toBe(0);
  });

  it('starts no more requests once the app stops', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    await queued(backend, owner.db, 80);
    // Stopped (signed out, say) while the first request is under way.
    const request = backend.api.request.bind(backend.api);
    backend.api.request = async function (...args) {
      const answer = await request(...args);
      if (args[1] === '/media/delete') owner.messaging.stop();
      return answer;
    } as typeof request;
    await owner.messaging.flushUploadDeletes();
    expect(backend.deleteBatches.map((b) => b.length)).toEqual([50]);
    expect((await pendingUploadDeletes(owner.db)).length).toBe(30);
    // Nor does a flush asked for afterwards.
    await owner.messaging.flushUploadDeletes();
    expect(backend.deleteBatches).toHaveLength(1);
  });

  it('deletes them one at a time from an older server, which answers 405 for the batch route', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    backend.down.batchDeletes = 405;
    const items = await queued(backend, owner.db, 8);
    // One of them it doesn't know: gone, as the batch route would say.
    await queueUploadDeletes(owner.db, [{ id: toBase64Url(crypto.getRandomValues(new Uint8Array(16))), d: items[0]!.d }]);
    await owner.messaging.flushUploadDeletes();
    // Asked once in the run, then one request per upload.
    expect(backend.mediaCalls.filter((c) => c === 'POST /media/delete')).toHaveLength(1);
    expect(backend.mediaCalls.filter((c) => /^POST \/media\/[^/]+\/delete$/.test(c))).toHaveLength(9);
    expect(backend.uploads.size).toBe(0);
    expect(await pendingUploadDeletes(owner.db)).toEqual([]);
    // Updated: the next run asks with the batch route again.
    backend.down.batchDeletes = null;
    await queued(backend, owner.db, 2);
    await owner.messaging.flushUploadDeletes();
    expect(backend.deleteBatches.map((b) => b.length)).toEqual([2]);
    expect(backend.uploads.size).toBe(0);
  });

  it('runs last in upkeep, so a long list never holds up the top-ups', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    await queued(backend, owner.db, 1);
    let signedFirst = -1;
    const request = backend.api.request.bind(backend.api);
    backend.api.request = async function (...args) {
      if (args[1] === '/media/delete') signedFirst = backend.signed() + backend.mediaSigned();
      return request(...args);
    } as typeof request;
    await owner.messaging.maintain();
    expect(signedFirst).toBeGreaterThan(0);
    expect(backend.uploads.size).toBe(0);
  });

  it('drops them when the server answers 404 for a batch (it has no attachments), never asking one at a time', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    backend.down.batchDeletes = 404;
    await queued(backend, owner.db, 60);
    // One of ours just made: not yet, as for a not_found.
    await queueUploadDeletes(owner.db, [{ id: rand(), d: rand(), recent: true }]);
    await owner.messaging.flushUploadDeletes();
    expect(backend.mediaCalls).toEqual(['POST /media/delete', 'POST /media/delete']);
    expect((await pendingUploadDeletes(owner.db)).map((u) => !!u.recent)).toEqual([false]);
  });

  it('asks again later for one just made, unless the app stopped meanwhile', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    // Ours, just made, that the server doesn't find yet.
    const recent = () => ({ id: rand(), d: rand(), recent: true as const });
    backend.later.length = 0;
    await queueUploadDeletes(owner.db, [recent()]);
    await owner.messaging.flushUploadDeletes();
    expect(backend.later.map((job) => job.ms)).toEqual([30_000]);
    backend.later.length = 0;
    await queueUploadDeletes(owner.db, [recent()]);
    const running = owner.messaging.flushUploadDeletes();
    owner.messaging.stop();
    await running;
    expect(backend.later).toEqual([]);
  });
});

describe('editing', () => {
  it('sends an edit quietly; the other side shows the new text, edited, and the latest wins', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'helo');
    await owner.messaging.sync();
    const [mine] = await listMessages(sender.db, conv);
    const quiet = backend.quietSends.length;
    await sender.messaging.edit(conv, mine!.id, 'hello');
    const first = backend.seenEnvelopes.at(-1)!;
    expect(backend.quietSends.slice(quiet)).toEqual([true]);
    expect((await listMessages(sender.db, conv))[0]).toMatchObject({ text: 'hello', edited: expect.any(Number) });
    expect(await owner.messaging.sync()).toBe(1);
    const local = await across(sender.db, conv, owner.db);
    expect((await listMessages(owner.db, local))[0]).toMatchObject({ text: 'hello', edited: expect.any(Number) });
    // A second edit, then the first delivered again: the second stays.
    await sender.messaging.edit(conv, mine!.id, 'hello there');
    await owner.messaging.sync();
    backend.inboxes.get('owner')!.push({ id: rand(), mailbox: bundle.mailbox, envelope: first });
    expect(await owner.messaging.sync()).toBe(0);
    expect((await listMessages(owner.db, local))[0]!.text).toBe('hello there');
    // A text message can't be emptied; the same text sends nothing.
    await expect(sender.messaging.edit(conv, mine!.id, '  ')).rejects.toThrow();
    const sends = backend.quietSends.length;
    await sender.messaging.edit(conv, mine!.id, 'hello there');
    expect(backend.quietSends.length).toBe(sends);
  });

  it('applies an edit that comes before its message, and empties a caption', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hi');
    await owner.messaging.sync();
    const photo = crypto.getRandomValues(new Uint8Array(600));
    await sender.messaging.sendMedia(conv, { file: photo, media: { t: 'photo', s: photo.length, w: 6, h: 6, m: 'image/jpeg' } }, 'a caption');
    const pic = (await listMessages(sender.db, conv)).at(-1)!;
    await sender.messaging.edit(conv, pic.id, '');
    // The edit arrives first.
    backend.inboxes.get('owner')!.reverse();
    await owner.messaging.sync();
    const local = await across(sender.db, conv, owner.db);
    const theirs = (await listMessages(owner.db, local)).at(-1)!;
    expect(theirs).toMatchObject({ id: pic.id, text: '', edited: expect.any(Number), media: { t: 'photo' } });
    expect(await getPendingEdits(owner.db, local)).toEqual([]);
  });

  it('only within a day of sending; their app drops a later edit, even from a modified app', async () => {
    const HOUR = 60 * 60 * 1000;
    let clock = Date.now();
    const now = () => clock;
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner', now);
    const sender = await person(backend, 'sender', now);
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'helo');
    await owner.messaging.sync();
    const local = await across(sender.db, conv, owner.db);
    const [mine] = await listMessages(sender.db, conv);

    // Within the day: fine.
    clock += 23 * HOUR;
    await sender.messaging.edit(conv, mine!.id, 'hello');
    await owner.messaging.sync();
    expect((await listMessages(owner.db, local))[0]!.text).toBe('hello');

    // After it (and past the receiver's hour of grace): refused here.
    clock += 3 * HOUR;
    await expect(sender.messaging.edit(conv, mine!.id, 'hello again')).rejects.toThrow();

    // A modified app that sends it anyway: dropped there.
    const record = (await sender.db.get('messages', [conv, mine!.id]))!;
    await sender.db.put('messages', { ...record, at: clock });
    await sender.messaging.edit(conv, mine!.id, 'hello again');
    await owner.messaging.sync();
    expect((await listMessages(owner.db, local))[0]!.text).toBe('hello');
  });

  it("can't edit the other side's messages, even from a modified app", async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const local = await across(sender.db, conv, owner.db);
    await owner.messaging.send(local, 'my words');
    await sender.messaging.sync();
    const theirs = (await listMessages(sender.db, conv)).find((m) => !m.out)!;
    await expect(sender.messaging.edit(conv, theirs.id, 'not your words')).rejects.toThrow();
    const record = (await sender.db.get('messages', [conv, theirs.id]))!;
    await sender.db.put('messages', { ...record, out: true, status: 'sent' });
    await sender.messaging.edit(conv, theirs.id, 'not your words');
    expect(await owner.messaging.sync()).toBe(0);
    expect((await listMessages(owner.db, local)).map((m) => m.text)).toEqual(['hello', 'my words']);
  });
});

describe('attachments', () => {
  it('sends a file encrypted, and the recipient fetches, keeps and deletes it', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();

    // 6 MiB, padded to 7: seven media tokens, and no send token beyond the
    // message's own; the bucket only takes the padded, encrypted size.
    const sendTokens = await countTokens(sender.db, backend.issuer.keyId);
    const file = crypto.getRandomValues(new Uint8Array(65536));
    const big = new Uint8Array(6 * 1024 * 1024);
    big.set(file);
    const progress: number[] = [];
    await sender.messaging.sendMedia(conv, { file: big, media: { t: 'file', s: big.length, n: 'notes.pdf', m: 'application/pdf' } }, 'see this', undefined, undefined, (f) => progress.push(f));
    expect(progress).toEqual([1]);
    const [upload] = [...backend.uploads.values()];
    expect(upload!.body!.length).toBe(7 * 1024 * 1024);
    expect(backend.mediaSigned()).toBeGreaterThanOrEqual(7);
    expect(await countTokens(sender.db, backend.issuer.keyId)).toBe(sendTokens - 1);
    // What the batch brought beyond the upload's cost stays in the media wallet.
    expect(await countTokens(sender.db, backend.issuer.keyId, undefined, 'media')).toBe(backend.mediaSigned() - 7);
    // The server's copy is ciphertext: the file's bytes aren't in it.
    const needle = toBase64Url(file.slice(0, 48));
    expect(toBase64Url(upload!.body!).includes(needle)).toBe(false);
    // Ours shows at once, from this device.
    const mine = (await listMessages(sender.db, conv)).at(-1)!;
    expect(mine).toMatchObject({ text: 'see this', file: 'local', status: 'sent', media: { t: 'file', n: 'notes.pdf', s: big.length } });
    expect(await getMedia(sender.db, conv, mine.id)).toEqual(big);

    // Theirs arrives without the file, then fetches it.
    expect(await owner.messaging.sync()).toBe(1);
    const local = await across(sender.db, conv, owner.db);
    const theirs = (await listMessages(owner.db, local)).at(-1)!;
    expect(theirs).toMatchObject({ text: 'see this', file: 'remote', media: { t: 'file', n: 'notes.pdf' } });
    expect(await getMedia(owner.db, local, theirs.id)).toBeUndefined();
    expect(await owner.messaging.fetchMedia(local, theirs.id)).toBe('local');
    expect(await getMedia(owner.db, local, theirs.id)).toEqual(big);
    expect((await listMessages(owner.db, local)).at(-1)!.file).toBe('local');
    // Kept in the bucket until it's saved outside the app...
    expect(backend.uploads.size).toBe(1);
    // ...or the conversation is deleted here.
    await owner.messaging.remove(local);
    await owner.messaging.flushUploadDeletes();
    expect(backend.uploads.size).toBe(0);
  });

  it('clears attachments from this device, keeps their messages, and fetches them again on request', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    const photo = crypto.getRandomValues(new Uint8Array(3000));
    const notes = crypto.getRandomValues(new Uint8Array(5000));
    await sender.messaging.sendMedia(conv, { file: photo, media: { t: 'photo', s: photo.length, w: 10, h: 10, m: 'image/jpeg' } });
    await sender.messaging.sendMedia(conv, { file: notes, media: { t: 'file', s: notes.length, n: 'notes.pdf' } });
    await owner.messaging.sync();
    const local = await across(sender.db, conv, owner.db);
    const [first, second] = (await listMessages(owner.db, local)).filter((m) => m.media);
    await owner.messaging.fetchMedia(local, first!.id);
    await owner.messaging.fetchMedia(local, second!.id);
    expect(await mediaUsage(owner.db)).toEqual({ total: 8000, byConversation: { [local]: 8000 } });

    // Only what's older than the cutoff goes.
    expect(await clearMedia(owner.db, { before: first!.at })).toBe(0);
    // A conversation's attachments go; their messages stay, marked cleared.
    expect(await clearMedia(owner.db, { conv: 'another' })).toBe(0);
    expect(await clearMedia(owner.db, { conv: local })).toBe(8000);
    expect(await mediaUsage(owner.db)).toEqual({ total: 0, byConversation: {} });
    expect(await getMedia(owner.db, local, first!.id)).toBeUndefined();
    expect((await listMessages(owner.db, local)).filter((m) => m.media).map((m) => m.file)).toEqual(['cleared', 'cleared']);

    // A tap fetches one again while the server keeps it.
    expect(await owner.messaging.fetchMedia(local, first!.id)).toBe('local');
    expect(await getMedia(owner.db, local, first!.id)).toEqual(photo);
    // Ours too: the sender clears both and fetches one back.
    expect(await clearMedia(sender.db)).toBe(8000);
    const [mine] = (await listMessages(sender.db, conv)).filter((m) => m.media);
    expect(await sender.messaging.fetchMedia(conv, mine!.id)).toBe('local');
    expect(await getMedia(sender.db, conv, mine!.id)).toEqual(photo);
    // Once the upload is gone, a cleared one is gone for good.
    backend.uploads.clear();
    expect(await owner.messaging.fetchMedia(local, second!.id)).toBe('gone');
  });

  it('marks an attachment gone when the upload has expired', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    const photo = crypto.getRandomValues(new Uint8Array(1000));
    await sender.messaging.sendMedia(conv, { file: photo, media: { t: 'photo', s: photo.length, w: 10, h: 10, m: 'image/jpeg' } });
    backend.uploads.clear();
    await owner.messaging.sync();
    const local = await across(sender.db, conv, owner.db);
    const theirs = (await listMessages(owner.db, local)).at(-1)!;
    expect(theirs.media).toMatchObject({ t: 'photo', w: 10, h: 10 });
    expect(await owner.messaging.fetchMedia(local, theirs.id)).toBe('gone');
    expect((await listMessages(owner.db, local)).at(-1)!.file).toBe('gone');
  });
});

describe('IDs from another conversation', () => {
  // A owns a link and got an anonymous message there, from V. A modified app
  // lets A reuse that conversation's IDs in messages to suspects, through
  // their links or in chats A has with them openly. Nothing a suspect's app
  // does in return may depend on whether it holds those IDs: V's app must
  // answer exactly as W's does.
  async function setting() {
    const backend = await fakeBackend();
    const a = await person(backend, 'a');
    const v = await person(backend, 'v');
    const w = await person(backend, 'w');
    const linkA = await linkOf(backend, a);
    const anon = await v.messaging.startConversation(linkA.ref, linkA.bundle, 'guess who');
    expect(await a.messaging.sync()).toBe(1);
    const [m] = await listMessages(a.db, await across(v.db, anon, a.db));
    const suspects = [
      { who: v, link: await linkOf(backend, v) },
      { who: w, link: await linkOf(backend, w) },
    ];
    return { a, v, w, linkV: suspects[0]!.link, suspects, anon, messageId: m!.id, convId: (await getConversation(v.db, anon))!.wire };
  }

  it('a first message through their link that reuses a message ID is shown and seen like any other', async () => {
    const s = await setting();
    for (const { who, link } of s.suspects) {
      nextIds(rand(), s.messageId);
      const probe = await s.a.messaging.startConversation(link.ref, link.bundle, 'hello?');
      expect((await listMessages(s.a.db, probe)).map((m) => m.id)).toEqual([s.messageId]);
      expect(await who.messaging.sync()).toBe(1);
      const there = await across(s.a.db, probe, who.db);
      expect((await listMessages(who.db, there)).map((m) => [m.id, m.text])).toEqual([[s.messageId, 'hello?']]);
      // Opened, it's seen: their receipt names it.
      await who.messaging.markSeen(there);
      expect(await s.a.messaging.sync()).toBe(1);
      expect((await listMessages(s.a.db, probe)).map((m) => m.status)).toEqual(['seen']);
    }
    // V's own conversation is as it was.
    expect((await listMessages(s.v.db, s.anon)).map((m) => [m.id, m.text, m.status])).toEqual([[s.messageId, 'guess who', 'sent']]);
  });

  it('in a chat they already have, a message that reuses a message ID is shown, seen, and named as the last', async () => {
    const s = await setting();
    for (const { who, link } of s.suspects) {
      // A wrote to their link, and they answered.
      const known = await s.a.messaging.startConversation(link.ref, link.bundle, 'hi, it is A');
      await who.messaging.sync();
      const there = await across(s.a.db, known, who.db);
      await who.messaging.send(there, 'hi A');
      await s.a.messaging.sync();
      // A fresh message, then one that reuses the anonymous message's ID.
      await s.a.messaging.send(known, 'one');
      nextIds(s.messageId);
      await s.a.messaging.send(known, 'two');
      expect((await listMessages(s.a.db, known)).at(-1)!.id).toBe(s.messageId);
      expect(await who.messaging.sync()).toBe(2);
      expect((await listMessages(who.db, there)).map((m) => m.text)).toEqual(['hi, it is A', 'hi A', 'one', 'two']);
      // Their next message names it as the last they got.
      expect((await getConversation(who.db, there))!.lastReceived).toBe(s.messageId);
      // Opened, all of it is seen.
      await who.messaging.markSeen(there);
      await s.a.messaging.sync();
      expect((await listMessages(s.a.db, known)).filter((m) => m.out).map((m) => [m.text, m.status])).toEqual([
        ['hi, it is A', 'seen'],
        ['one', 'seen'],
        ['two', 'seen'],
      ]);
    }
    expect((await listMessages(s.v.db, s.anon)).map((m) => [m.id, m.text])).toEqual([[s.messageId, 'guess who']]);
  });

  it('reactions, edits, deletes and attachments under a reused ID reach only their own conversation', async () => {
    const s = await setting();
    // V also sent A a photo, anonymously: it's on V's device, under its ID.
    const mine = crypto.getRandomValues(new Uint8Array(700));
    await s.v.messaging.sendMedia(s.anon, { file: mine, media: { t: 'photo', s: mine.length, w: 7, h: 7, m: 'image/jpeg' } }, 'my cat');
    await s.a.messaging.sync();
    const photoId = (await listMessages(s.v.db, s.anon)).at(-1)!.id;
    // In a chat A starts with V openly, A sends a photo under the same ID.
    const known = await s.a.messaging.startConversation(s.linkV.ref, s.linkV.bundle, 'hi V');
    const theirs = crypto.getRandomValues(new Uint8Array(900));
    nextIds(photoId);
    await s.a.messaging.sendMedia(known, { file: theirs, media: { t: 'photo', s: theirs.length, w: 9, h: 9, m: 'image/jpeg' } }, 'a dog');
    expect(await s.v.messaging.sync()).toBe(2);
    const there = await across(s.a.db, known, s.v.db);
    expect(await s.v.messaging.fetchMedia(there, photoId)).toBe('local');
    expect(await getMedia(s.v.db, there, photoId)).toEqual(theirs);
    // A reacts to it and edits its caption: shown there.
    await s.a.messaging.react(known, photoId, '👍');
    await s.a.messaging.edit(known, photoId, 'a cat?');
    expect(await s.v.messaging.sync()).toBe(2);
    expect(await getMessage(s.v.db, there, photoId)).toMatchObject({ text: 'a cat?', edited: expect.any(Number), reactions: { theirs: { e: '👍' } } });
    // Then deletes it for both sides: gone there, with its file.
    await s.a.messaging.deleteForEveryone(known, photoId);
    expect(await s.v.messaging.sync()).toBe(1);
    expect(await getMessage(s.v.db, there, photoId)).toBeUndefined();
    expect(await getMedia(s.v.db, there, photoId)).toBeUndefined();
    // V's own photo, in the anonymous conversation, is as it was.
    const own = (await getMessage(s.v.db, s.anon, photoId))!;
    expect(own).toMatchObject({ text: 'my cat', file: 'local', out: true });
    expect(own.reactions).toBeUndefined();
    expect(own.edited).toBeUndefined();
    expect(await getMedia(s.v.db, s.anon, photoId)).toEqual(mine);
  });

  it("a first message through their link that reuses a conversation's ID starts a chat of its own", async () => {
    const s = await setting();
    for (const { who, link } of s.suspects) {
      nextIds(s.convId);
      const probe = await s.a.messaging.startConversation(link.ref, link.bundle, 'hello?');
      expect((await getConversation(s.a.db, probe))!.wire).toBe(s.convId);
      const before = await listConversations(who.db);
      expect(await who.messaging.sync()).toBe(1);
      const added = (await listConversations(who.db)).filter((c) => !before.some((b) => b.id === c.id));
      expect(added).toMatchObject([{ role: 'owner', wire: s.convId, unread: 1 }]);
      const there = added[0]!.id;
      expect((await listMessages(who.db, there)).map((m) => m.text)).toEqual(['hello?']);
      // Opened, it's seen; an answer reaches A's probe, nothing else.
      await who.messaging.markSeen(there);
      expect(await s.a.messaging.sync()).toBe(1);
      expect((await listMessages(s.a.db, probe)).map((m) => m.status)).toEqual(['seen']);
      await who.messaging.send(there, 'who is this?');
      expect(await s.a.messaging.sync()).toBe(1);
      expect((await listMessages(s.a.db, probe)).map((m) => m.text)).toEqual(['hello?', 'who is this?']);
    }
    // The anonymous conversation carries on beside it, on both sides.
    const anonAtA = (await listConversations(s.a.db)).find((c) => c.role === 'owner' && c.wire === s.convId)!.id;
    await s.a.messaging.send(anonAtA, 'no idea');
    expect(await s.v.messaging.sync()).toBe(1);
    expect((await listMessages(s.v.db, s.anon)).map((m) => m.text)).toEqual(['guess who', 'no idea']);
    await s.v.messaging.send(s.anon, 'ha');
    expect(await s.a.messaging.sync()).toBe(1);
    expect((await listMessages(s.a.db, anonAtA)).map((m) => m.text)).toEqual(['guess who', 'no idea', 'ha']);
  });

  it('two people who start a conversation through one link with the same ID get a chat each', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const p = await person(backend, 'p');
    const q = await person(backend, 'q');
    const { ref, bundle } = await linkOf(backend, owner);
    const wire = rand();
    nextIds(wire);
    const fromP = await p.messaging.startConversation(ref, bundle, 'from p');
    expect(await owner.messaging.sync()).toBe(1);
    nextIds(wire);
    const fromQ = await q.messaging.startConversation(ref, bundle, 'from q');
    expect(await owner.messaging.sync()).toBe(1);
    const chats = await listConversations(owner.db);
    expect(chats.map((c) => c.wire)).toEqual([wire, wire]);
    const chatOf = async (first: string) => {
      for (const c of chats) if ((await listMessages(owner.db, c.id))[0]!.text === first) return c.id;
      throw new Error('no such chat');
    };
    const [toP, toQ] = [await chatOf('from p'), await chatOf('from q')];

    // More from each lands in their own chat, before an answer and after.
    await p.messaging.send(fromP, 'more from p');
    await q.messaging.send(fromQ, 'more from q');
    expect(await owner.messaging.sync()).toBe(2);
    await owner.messaging.send(toP, 'to p');
    await owner.messaging.send(toQ, 'to q');
    expect(await p.messaging.sync()).toBe(1);
    expect(await q.messaging.sync()).toBe(1);
    await p.messaging.send(fromP, 'p again');
    await q.messaging.send(fromQ, 'q again');
    expect(await owner.messaging.sync()).toBe(2);
    expect((await listMessages(owner.db, toP)).map((m) => m.text)).toEqual(['from p', 'more from p', 'to p', 'p again']);
    expect((await listMessages(owner.db, toQ)).map((m) => m.text)).toEqual(['from q', 'more from q', 'to q', 'q again']);
    expect((await listMessages(q.db, fromQ)).map((m) => m.text)).toEqual(['from q', 'more from q', 'to q', 'q again']);
  });
});

type Person = Awaited<ReturnType<typeof person>>;
const DAY = 24 * 3600 * 1000;

/** A modified app: writes in one of its conversations, but to another mailbox than the conversation's. */
async function sendVia(who: Person, conv: string, mailbox: string, text: string): Promise<void> {
  const c = (await getConversation(who.db, conv))!;
  await putConversation(who.db, { ...c, sendTo: mailbox });
  await who.messaging.send(conv, text);
  await putConversation(who.db, { ...(await getConversation(who.db, conv))!, sendTo: c.sendTo });
}

/** What a device keeps about its chats and keys: taking in an envelope would change some of it. */
async function state(db: Database) {
  const chats = await Promise.all((await listConversations(db)).map(async (c) => ({ ...c, messages: await listMessages(db, c.id), ids: await getIds(db, c.id) })));
  return { chats, keys: await getMeta(db, 'recipient-keys'), links: await getMeta(db, 'links') };
}

/** Forgets one kind of what a chat remembers by keyed hashes: as when it was let go (past its cap), or kept by an older version. */
async function forgetIds(db: Database, conv: string, kind: IdKind): Promise<void> {
  const before = await getIds(db, conv);
  const { [kind]: _, ...rest } = before;
  await saveConversation(db, (await getConversation(db, conv))!, rest, before);
}

describe('envelopes through a mailbox they do not belong to', () => {
  // A owns a link and got an anonymous message there from V, so A knows V's
  // key for that chat, and the mailbox V gets answers at. A modified app
  // seals to what A knows and leaves it where only one suspect would get it.
  // Whoever can open it must do exactly what someone who can't does.
  async function setting() {
    const backend = await fakeBackend();
    const a = await person(backend, 'a');
    const v = await person(backend, 'v');
    const w = await person(backend, 'w');
    const linkA = await linkOf(backend, a);
    const anon = await v.messaging.startConversation(linkA.ref, linkA.bundle, 'guess who');
    await a.messaging.sync();
    const atA = await across(v.db, anon, a.db);
    await a.messaging.send(atA, 'hi, who is this?');
    await v.messaging.sync();
    await v.messaging.markSeen(anon);
    await a.messaging.sync();
    const suspects = [
      { who: v, name: 'v', link: await linkOf(backend, v) },
      { who: w, name: 'w', link: await linkOf(backend, w) },
    ];
    return { backend, a, v, anon, atA, suspects };
  }

  it("a message for an anonymous chat's key, left in a suspect's intro mailbox, is dropped like one that can't be opened", async () => {
    const s = await setting();
    for (const { who, name, link } of s.suspects) {
      const before = await state(who.db);
      await sendVia(s.a, s.atA, link.bundle.mailbox, `is it you, ${name}?`);
      expect(await who.messaging.sync()).toBe(0);
      // Confirmed, like anything it can't open, and nothing changed.
      expect(s.backend.inboxes.get(name)).toEqual([]);
      expect(await state(who.db)).toEqual(before);
      // Opening every chat sends nothing.
      const sends = s.backend.seenEnvelopes.length;
      for (const c of await listConversations(who.db)) await who.messaging.markSeen(c.id);
      expect(s.backend.seenEnvelopes.length).toBe(sends);
    }
    // A learns nothing: neither probe is seen.
    await s.a.messaging.sync();
    expect((await listMessages(s.a.db, s.atA)).filter((m) => m.out).map((m) => [m.text, m.status])).toEqual([
      ['hi, who is this?', 'seen'],
      ['is it you, v?', 'sent'],
      ['is it you, w?', 'sent'],
    ]);
    // The chat itself carries on.
    await s.a.messaging.send(s.atA, 'never mind');
    expect(await s.v.messaging.sync()).toBe(1);
    expect((await listMessages(s.v.db, s.anon)).at(-1)!.text).toBe('never mind');
  });

  it("a first message for a suspect's link key, left in an anonymous chat's mailbox, is dropped", async () => {
    const s = await setting();
    // Where V's anonymous chat gets its answers.
    const replyV = (await getConversation(s.a.db, s.atA))!.sendTo;
    for (const { link } of s.suspects) {
      const before = await state(s.v.db);
      await s.a.messaging.startConversation(link.ref, { ...link.bundle, mailbox: replyV }, 'is this your link?');
      expect(await s.v.messaging.sync()).toBe(0);
      expect(s.backend.inboxes.get('v')).toEqual([]);
      expect(await state(s.v.db)).toEqual(before);
    }
    // Through V's link itself, it starts a chat.
    await s.a.messaging.startConversation(s.suspects[0]!.link.ref, s.suspects[0]!.link.bundle, 'hello V');
    expect(await s.v.messaging.sync()).toBe(1);
  });

  it("a message for the owner's chat key, from the one who wrote to them, left in a suspect's reply mailbox, is dropped", async () => {
    // S wrote to O's link, so S knows O's key for that chat once O has read
    // it. O, X and W are all strangers to S; X and W wrote to S's own link
    // anonymously. S suspects X is O, and leaves envelopes sealed to O's chat
    // key where X's and W's chats with S get their answers. O is X: O's app
    // must do what W's does, which can't open them.
    const backend = await fakeBackend();
    const s = await person(backend, 's');
    const o = await person(backend, 'o');
    const w = await person(backend, 'w');
    const [linkO, linkS] = [await linkOf(backend, o), await linkOf(backend, s)];
    const fromO = await o.messaging.startConversation(linkS.ref, linkS.bundle, 'hi S, guess who');
    await w.messaging.startConversation(linkS.ref, linkS.bundle, 'hi S, from someone');
    expect(await s.messaging.sync()).toBe(2);
    const replyMailboxes = await Promise.all(
      [
        { who: o, name: 'o' },
        { who: w, name: 'w' },
      ].map(async (x) => ({ ...x, mailbox: (await listConversations(x.who.db))[0]!.myMailbox! })),
    );
    const toO = await s.messaging.startConversation(linkO.ref, linkO.bundle, 'hello O');
    await o.messaging.sync();
    const atO = await across(s.db, toO, o.db);
    // O reads it: S now writes for O's chat key.
    await o.messaging.markSeen(atO);
    await s.messaging.sync();

    const probe = async (text: string) => {
      for (const { who, name, mailbox } of replyMailboxes) {
        const before = await state(who.db);
        await sendVia(s, toO, mailbox, `${text} (${name})`);
        expect(await who.messaging.sync()).toBe(0);
        expect(backend.inboxes.get(name)).toEqual([]);
        expect(await state(who.db)).toEqual(before);
        const sends = backend.seenEnvelopes.length;
        for (const c of await listConversations(who.db)) await who.messaging.markSeen(c.id);
        expect(backend.seenEnvelopes.length).toBe(sends);
      }
    };
    // While O has read but not answered: the link's mailbox counts for this chat, nothing else.
    await probe('are you X?');
    // After O answered, before S used O's mailbox: the same.
    await o.messaging.send(atO, 'hi S');
    await probe('really?');

    await s.messaging.sync();
    expect((await listMessages(s.db, toO)).filter((m) => m.out).map((m) => m.status)).toEqual(['seen', 'sent', 'sent', 'sent', 'sent']);
    // The chats themselves carry on.
    await s.messaging.send(toO, 'ok');
    expect(await o.messaging.sync()).toBe(1);
    expect((await listMessages(o.db, fromO)).map((m) => m.text)).toEqual(['hi S, guess who']);
  });

  it("two people one sender wrote to can't cross their chats to learn it's the same person", async () => {
    const backend = await fakeBackend();
    const a = await person(backend, 'a');
    const b = await person(backend, 'b');
    const v = await person(backend, 'v');
    const [linkA, linkB] = [await linkOf(backend, a), await linkOf(backend, b)];
    const toA = await v.messaging.startConversation(linkA.ref, linkA.bundle, 'hi A');
    const toB = await v.messaging.startConversation(linkB.ref, linkB.bundle, 'hi B');
    await a.messaging.sync();
    await b.messaging.sync();
    const [atA, atB] = [await across(v.db, toA, a.db), await across(v.db, toB, b.db)];
    // B tells A where its anonymous sender gets answers; A writes there, for its own chat's key.
    const before = await state(v.db);
    await sendVia(a, atA, (await getConversation(b.db, atB))!.sendTo, 'same person?');
    expect(await v.messaging.sync()).toBe(0);
    expect(await state(v.db)).toEqual(before);
    // Each chat still gets what's written to it.
    await a.messaging.send(atA, 'hello from A');
    await b.messaging.send(atB, 'hello from B');
    expect(await v.messaging.sync()).toBe(2);
  });

  it("a first message for one link's key, left in another link's intro mailbox, is dropped", async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    // Two links, as an account could have before it had one.
    const one = await linkOf(backend, owner);
    const two = await linkOf(backend, owner);
    const before = await state(owner.db);
    await sender.messaging.startConversation(one.ref, { ...one.bundle, mailbox: two.bundle.mailbox }, 'wrong door');
    await sender.messaging.startConversation(two.ref, { ...two.bundle, mailbox: one.bundle.mailbox }, 'wrong door too');
    expect(await owner.messaging.sync()).toBe(0);
    expect(backend.inboxes.get('owner')).toEqual([]);
    expect(await state(owner.db)).toEqual(before);
    await sender.messaging.startConversation(one.ref, one.bundle, 'right door');
    await sender.messaging.startConversation(two.ref, two.bundle, 'right door too');
    expect(await owner.messaging.sync()).toBe(2);
  });
});

describe('envelopes through the mailbox they belong to', () => {
  it("what a sender wrote to the link before hearing of the owner's mailbox still arrives, until well after they use it", async () => {
    const backend = await fakeBackend();
    let clock = Date.now();
    const owner = await person(backend, 'owner', () => clock);
    const sender = await person(backend, 'sender', () => clock);
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'one');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    // Read: from then on the sender writes for the owner's key, still to the link.
    await owner.messaging.markSeen(mine);
    await sender.messaging.sync();
    clock += 1000;
    await sender.messaging.send(conv, 'two');
    // The owner answers before that arrives, from a mailbox of its own, and
    // is away for weeks while it waits.
    clock += 1000;
    await owner.messaging.send(mine, 'hi');
    clock += 20 * DAY;
    expect(await owner.messaging.sync()).toBe(1);
    // That answer never reaches the sender: weeks later, still to the link.
    backend.inboxes.get('sender')!.length = 0;
    clock += 20 * DAY;
    await sender.messaging.send(conv, 'three');
    expect(await owner.messaging.sync()).toBe(1);

    // Once they write to the owner's mailbox, the link's counts 31 days more for this chat.
    clock += 1000;
    await owner.messaging.send(mine, 'hi again');
    await sender.messaging.sync();
    clock += 1000;
    await sender.messaging.send(conv, 'four');
    expect(await owner.messaging.sync()).toBe(1);
    clock += 30 * DAY;
    await sendVia(sender, conv, bundle.mailbox, 'five');
    expect(await owner.messaging.sync()).toBe(1);
    clock += 2 * DAY;
    await sendVia(sender, conv, bundle.mailbox, 'late');
    expect(await owner.messaging.sync()).toBe(0);
    await sender.messaging.send(conv, 'on time');
    expect(await owner.messaging.sync()).toBe(1);
    expect((await listMessages(owner.db, mine)).map((m) => m.text)).toEqual(['one', 'two', 'hi', 'three', 'hi again', 'four', 'five', 'on time']);
  });

  it('a mailbox of ours a chat moved on from still counts until well after they use the new one', async () => {
    const backend = await fakeBackend();
    let clock = Date.now();
    const owner = await person(backend, 'owner', () => clock);
    const sender = await person(backend, 'sender', () => clock);
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    clock += 1000;
    await owner.messaging.send(mine, 'hi');
    await sender.messaging.sync();
    const first = (await getConversation(owner.db, mine))!.myMailbox!;
    // Written to that mailbox, and still waiting, when the owner blocks and unblocks.
    clock += 1000;
    await sender.messaging.send(conv, 'waiting');
    await owner.messaging.block(mine);
    await owner.messaging.unblock(mine);
    expect((await getConversation(owner.db, mine))!.myMailbox).not.toBe(first);
    expect(await owner.messaging.sync()).toBe(1);

    // They move to the new one; 31 days on, the old one no longer counts.
    await sender.messaging.sync();
    clock += 1000;
    await sender.messaging.send(conv, 'moved');
    expect(await owner.messaging.sync()).toBe(1);
    clock += 32 * DAY;
    await sender.messaging.send(conv, 'late');
    const inbox = backend.inboxes.get('owner')!;
    inbox.push({ ...inbox.pop()!, mailbox: first });
    expect(await owner.messaging.sync()).toBe(0);
    expect((await listMessages(owner.db, mine)).map((m) => m.text)).toEqual(['hello', 'hi', 'waiting', 'moved']);
  });

  it('a chat answered before any of this was kept still takes what was on its way through the link', async () => {
    const backend = await fakeBackend();
    let clock = Date.now();
    const owner = await person(backend, 'owner', () => clock);
    const sender = await person(backend, 'sender', () => clock);
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'one');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    await owner.messaging.markSeen(mine);
    await sender.messaging.sync();
    clock += 1000;
    await sender.messaging.send(conv, 'two');
    clock += 1000;
    await owner.messaging.send(mine, 'hi');
    // As an older version kept it.
    const { introUntil: _, formerMailboxes: __, ...old } = (await getConversation(owner.db, mine))!;
    await putConversation(owner.db, old);
    expect(await owner.messaging.sync()).toBe(1);

    // Once they write to the owner's mailbox, the link's counts 31 days more.
    await sender.messaging.sync();
    clock += 1000;
    await sender.messaging.send(conv, 'three');
    expect(await owner.messaging.sync()).toBe(1);
    expect((await getConversation(owner.db, mine))!.introUntil).toBe(clock + 31 * DAY);
    clock += 32 * DAY;
    await sendVia(sender, conv, bundle.mailbox, 'late');
    expect(await owner.messaging.sync()).toBe(0);
    expect((await listMessages(owner.db, mine)).map((m) => m.text)).toEqual(['one', 'two', 'hi', 'three']);
  });

  it('a chat read but not answered still takes what was on its way after the link is revoked', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const [p, q] = [await person(backend, 'p'), await person(backend, 'q')];
    const { ref, bundle } = await linkOf(backend, owner);
    const fromP = await p.messaging.startConversation(ref, bundle, 'from p');
    const fromQ = await q.messaging.startConversation(ref, bundle, 'from q');
    await owner.messaging.sync();
    const [atP, atQ] = [await across(p.db, fromP, owner.db), await across(q.db, fromQ, owner.db)];
    // Q's chat as an older version kept it, until upkeep copies the link's intro mailbox to it.
    const { intro: _, ...old } = (await getConversation(owner.db, atQ))!;
    await putConversation(owner.db, old);
    await owner.messaging.maintain();
    // Read: they write for the owner's key, to the link.
    await owner.messaging.markSeen(atP);
    await owner.messaging.markSeen(atQ);
    await p.messaging.sync();
    await q.messaging.sync();
    await p.messaging.send(fromP, 'more from p');
    await q.messaging.send(fromQ, 'more from q');
    await revokeLink(owner.db, owner.session, ref.id);
    expect(await listLinks(owner.db)).toEqual([]);
    expect(await owner.messaging.sync()).toBe(2);
  });

  it('after the link is replaced, what was on its way through the old one still arrives, and chats carry on', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const [r, p, q, newcomer] = [await person(backend, 'r'), await person(backend, 'p'), await person(backend, 'q'), await person(backend, 'n')];
    const old = await linkOf(backend, owner);
    const fromR = await r.messaging.startConversation(old.ref, old.bundle, 'from r');
    const fromP = await p.messaging.startConversation(old.ref, old.bundle, 'from p');
    expect(await owner.messaging.sync()).toBe(2);
    const [atR, atP] = [await across(r.db, fromR, owner.db), await across(p.db, fromP, owner.db)];
    await owner.messaging.send(atR, 'hi r');
    // Read, not answered: p writes for the owner's key, to the old link.
    await owner.messaging.markSeen(atP);
    await r.messaging.sync();
    await p.messaging.sync();

    // On their way when the link is replaced: a first message, and more from p.
    await q.messaging.startConversation(old.ref, old.bundle, 'from q');
    await p.messaging.send(fromP, 'more from p');
    const record = await replaceLink(owner.db, owner.session, backend.api);
    const next = { ref: { id: record.id, fingerprint: record.fingerprint }, bundle: await backend.api.request('GET', `/links/${record.id}`, {}, checkBundle) };
    expect(record.mailbox).toBe(next.bundle.mailbox);
    expect(await owner.messaging.sync()).toBe(2);
    expect((await listMessages(owner.db, atP)).map((m) => m.text)).toEqual(['from p', 'more from p']);
    expect((await listConversations(owner.db)).length).toBe(3);

    // The answered chat carries on, and the new link takes new chats.
    await r.messaging.send(fromR, 'still here');
    await newcomer.messaging.startConversation(next.ref, next.bundle, 'hello new link');
    expect(await owner.messaging.sync()).toBe(2);

    // One link's key through the other link's mailbox counts for neither.
    const before = await state(owner.db);
    await newcomer.messaging.startConversation(old.ref, { ...old.bundle, mailbox: next.bundle.mailbox }, 'old key, new door');
    await newcomer.messaging.startConversation(next.ref, next.bundle, 'new key, old door');
    const inbox = backend.inboxes.get('owner')!;
    inbox.push({ ...inbox.pop()!, mailbox: old.bundle.mailbox });
    expect(await owner.messaging.sync()).toBe(0);
    expect(await state(owner.db)).toEqual(before);
  });
});

/** Another copy of the app on someone's device: the same storage, its own engine. */
function copyOf(backend: Awaited<ReturnType<typeof fakeBackend>>, p: Person, extra: Partial<MessagingDeps> = {}) {
  return createMessaging({
    db: p.db,
    api: backend.api,
    session: p.session,
    issuer: backend.issuer,
    mediaIssuer: backend.issuer,
    transfer: backend.transfer,
    wait: async () => {},
    later: backend.schedule,
    ...(extra.now ? {} : { messageNow: pace }),
    ...extra,
  });
}

/** A gate: reached once something comes to it, and everything waits there until released. */
function gate() {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  const open = new Promise<void>((r) => (release = r));
  return { reached, release, pass: () => (reach(), open) };
}

/** Holds every send (POST /send) at a gate. */
function holdSends(backend: Awaited<ReturnType<typeof fakeBackend>>) {
  const g = gate();
  const request = backend.api.request;
  backend.api.request = async (method, path, init, check) => {
    if (method === 'POST' && path === '/send') await g.pass();
    return request(method, path, init, check);
  };
  return g;
}

/** Holds someone's requests for new mailboxes at a gate (their pool is emptied, so taking one asks). */
async function holdNewMailboxes(p: Person) {
  await putMeta(p.db, 'mailbox-pool', []);
  const g = gate();
  const call = p.session.call;
  p.session.call = async (method, path, body, check, options) => {
    if (method === 'POST' && path === '/mailboxes') await g.pass();
    return call(method, path, body, check, options);
  };
  return g;
}

/** Fails someone's next request for new mailboxes (their pool is emptied, so taking one asks). */
async function failNewMailboxes(p: Person, err: Error) {
  await putMeta(p.db, 'mailbox-pool', []);
  const call = p.session.call;
  p.session.call = async (method, path, body, check, options) => {
    if (method === 'POST' && path === '/mailboxes') {
      p.session.call = call;
      throw err;
    }
    return call(method, path, body, check, options);
  };
}

withAndWithoutWebLocks('our side changing a chat while something of theirs comes in', () => {
  it('keeps the mailbox and key our first reply takes while a message is being taken in', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'one');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    await sender.messaging.send(conv, 'two');

    // Taking 'two' in stops just before storing it, and the owner's first
    // reply goes out meanwhile, taking a mailbox and a key.
    let reached!: () => void;
    let go!: () => void;
    const atStore = new Promise<void>((r) => (reached = r));
    const resume = new Promise<void>((r) => (go = r));
    pause.before = async (c) => {
      if (c !== mine) return;
      pause.before = null;
      reached();
      await resume;
    };
    const syncing = owner.messaging.sync();
    await atStore;
    const replying = owner.messaging.send(mine, 'hi');
    // Until the reply is out, or waits for the chat.
    await Promise.race([replying, waitingFor(`send:${mine}`)]);
    go();
    expect(await syncing).toBe(1);
    await replying;
    const after = (await getConversation(owner.db, mine))!;
    expect(after.myMailbox).not.toBeNull();
    expect(after.myKey).not.toBeNull();

    // The sender moves to them; what they write there arrives.
    expect(await sender.messaging.sync()).toBe(1);
    expect((await getConversation(sender.db, conv))!.sendTo).toBe(after.myMailbox);
    await sender.messaging.send(conv, 'three');
    expect(await owner.messaging.sync()).toBe(1);
    expect((await listMessages(owner.db, mine)).map((m) => m.text).sort()).toEqual(['hi', 'one', 'three', 'two']);
  });

  it("doesn't wait for a send of ours going out: that chat's message waits for the next sync, and the app is told when", async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const [sender, other] = [await person(backend, 'sender'), await person(backend, 'other')];
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'one');
    const conv2 = await other.messaging.startConversation(ref, bundle, 'x');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    await sender.messaging.send(conv, 'two');
    await other.messaging.send(conv2, 'y');
    let told = 0;
    const app = copyOf(backend, owner, { onWaiting: () => told++ });
    const sending = holdSends(backend);
    const replying = app.send(mine, 'hi');
    await sending.reached;
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('sync waited for the send')), 2000));
    expect(await Promise.race([app.sync(), timeout])).toBe(1);
    expect(backend.inboxes.get('owner')).toHaveLength(1);
    expect(told).toBe(0);
    sending.release();
    await replying;
    await vi.waitFor(() => expect(told).toBe(1));
    expect(await app.sync()).toBe(1);
    expect(backend.inboxes.get('owner')).toEqual([]);
    expect((await listMessages(owner.db, mine)).map((m) => m.text).sort()).toEqual(['hi', 'one', 'two']);
  });
});

withAndWithoutWebLocks('our side changing a chat', () => {
  async function setting() {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'one');
    await sender.messaging.send(conv, 'two');
    expect(await owner.messaging.sync()).toBe(2);
    return { backend, owner, sender, conv, mine: await across(sender.db, conv, owner.db) };
  }

  it('shows a new message at once while one before it is still going out', async () => {
    const { backend, owner, mine } = await setting();
    await owner.messaging.send(mine, 'first reply');
    const sending = holdSends(backend);
    const one = owner.messaging.send(mine, 'a');
    await sending.reached;
    let shown = false;
    const two = owner.messaging.send(mine, 'b', undefined, () => {
      shown = true;
    });
    // 'b' waits for 'a' to go out, but shows already.
    await waitingFor(`send:${mine}`);
    expect(shown).toBe(true);
    sending.release();
    await Promise.all([one, two]);
  });

  it('two quick first replies take one mailbox, which the sender then writes to', async () => {
    const { backend, owner, sender, conv, mine } = await setting();
    // The second is stored only once the first is out, from what the chat was before.
    let firstOut!: () => void;
    const out = new Promise<void>((r) => (firstOut = r));
    pause.before = async (c, text) => {
      if (c === mine && text === 'b') await out;
    };
    await Promise.all([owner.messaging.send(mine, 'a').then(firstOut), owner.messaging.send(mine, 'b')]);
    const c = (await getConversation(owner.db, mine))!;
    expect(c.formerMailboxes ?? []).toEqual([]);
    // Whichever reply the sender takes in last names the mailbox it writes to.
    backend.inboxes.get('sender')!.reverse();
    expect(await sender.messaging.sync()).toBe(2);
    expect((await getConversation(sender.db, conv))!.sendTo).toBe(c.myMailbox);
    await sender.messaging.send(conv, 'got both');
    expect(await owner.messaging.sync()).toBe(1);
  });

  for (const read of ['markRead', 'markSeen'] as const) {
    it(`${read} while our first reply takes a mailbox keeps both`, async () => {
      const { owner, sender, conv, mine } = await setting();
      const taking = await holdNewMailboxes(owner);
      const replying = owner.messaging.send(mine, 'hi');
      await taking.reached;
      const reading = owner.messaging[read](mine);
      await Promise.race([reading, waitingFor(`send:${mine}`)]);
      taking.release();
      await Promise.all([replying, reading]);
      const c = (await getConversation(owner.db, mine))!;
      expect(c.unread).toBe(0);
      expect(c.myMailbox).not.toBeNull();
      await sender.messaging.sync();
      await sender.messaging.send(conv, 'three');
      expect(await owner.messaging.sync()).toBe(1);
    });
  }

  it('blocking while our first reply takes a mailbox discards that mailbox', async () => {
    const { backend, owner, mine } = await setting();
    const taking = await holdNewMailboxes(owner);
    const replying = owner.messaging.send(mine, 'hi');
    await taking.reached;
    const blocking = owner.messaging.block(mine);
    await Promise.race([blocking, waitingFor(`send:${mine}`)]);
    taking.release();
    await Promise.all([replying, blocking]);
    const c = (await getConversation(owner.db, mine))!;
    expect(c.status).toBe('blocked');
    expect(c.myMailbox).not.toBeNull();
    expect(backend.mailboxes.has(c.myMailbox!)).toBe(false);
  });

  for (const failing of ['taking a mailbox', 'sending'] as const) {
    it(`unblocking again after its key update failed (${failing}) still sends it`, async () => {
      const { backend, owner, sender, conv, mine } = await setting();
      await owner.messaging.send(mine, 'hi');
      await sender.messaging.sync();
      await owner.messaging.block(mine);
      if (failing === 'taking a mailbox') {
        await failNewMailboxes(owner, new NetworkError('down'));
      } else {
        const request = backend.api.request;
        backend.api.request = async (method, path, init, check) => {
          if (method === 'POST' && path === '/send') {
            backend.api.request = request;
            throw new NetworkError('down');
          }
          return request(method, path, init, check);
        };
      }
      await expect(owner.messaging.unblock(mine)).rejects.toThrow(NetworkError);
      expect((await getConversation(owner.db, mine))!.status).toBe('blocked');
      const quiet = backend.quietSends.length;
      await owner.messaging.unblock(mine);
      const c = (await getConversation(owner.db, mine))!;
      expect([c.status, c.unblocking]).toEqual(['active', undefined]);
      expect(backend.quietSends.slice(quiet)).toEqual([true]);
      await sender.messaging.sync();
      await sender.messaging.send(conv, 'back?');
      expect(await owner.messaging.sync()).toBe(1);
    });
  }

  it("doesn't get stuck when everything runs at once, across two copies of the app", async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const tab = copyOf(backend, owner);
    const { ref, bundle } = await linkOf(backend, owner);
    const senders: Person[] = [];
    for (let i = 0; i < 4; i++) senders.push(await person(backend, `s${i}`));
    const convs: string[] = [];
    for (const s of senders) convs.push(await s.messaging.startConversation(ref, bundle, 'first'));
    await owner.messaging.sync();
    const mine: string[] = [];
    for (const [i, s] of senders.entries()) mine.push(await across(s.db, convs[i]!, owner.db));
    for (const [i, s] of senders.entries()) for (let k = 0; k < 3; k++) await s.messaging.send(convs[i]!, `m${k}`);
    const ops: Promise<unknown>[] = [owner.messaging.sync(), tab.sync(), owner.messaging.maintain(), tab.maintain()];
    for (const [i, id] of mine.entries()) {
      ops.push(owner.messaging.markSeen(id), tab.markSeen(id), owner.messaging.send(id, `reply ${i}`), tab.send(id, `reply again ${i}`), owner.messaging.markRead(id), tab.sync());
    }
    ops.push(
      (async () => {
        await owner.messaging.block(mine[3]!);
        await tab.unblock(mine[3]!);
      })(),
    );
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stuck')), 20_000));
    const results = await Promise.race([Promise.allSettled(ops), timeout]);
    expect(results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    await owner.messaging.sync();
    for (const s of senders) await s.messaging.sync();
    for (const [i, s] of senders.entries()) await s.messaging.send(convs[i]!, 'after');
    expect(await owner.messaging.sync()).toBe(4);
    for (const [i, s] of senders.entries()) {
      expect((await listMessages(s.db, convs[i]!)).filter((m) => !m.out).map((m) => m.text).sort()).toEqual([`reply ${i}`, `reply again ${i}`].sort());
    }
  }, 30_000);
});

describe('links from before their intro mailbox was kept', () => {
  /** Forgets the intro mailbox on the links, their keys and their chats, as an older version kept them. */
  async function asBefore(db: Database): Promise<void> {
    for (const { intro: _, introUntil: __, formerMailboxes: ___, ...c } of await listConversations(db)) await putConversation(db, c);
    const links = (await getMeta<Record<string, unknown>[]>(db, 'links'))!;
    await putMeta(db, 'links', links.map(({ mailbox: _, ...l }) => l));
    const index = (await getMeta<Record<string, KeyEntry>>(db, 'recipient-keys'))!;
    await putMeta(
      db,
      'recipient-keys',
      Object.fromEntries(Object.entries(index).map(([id, e]) => [id, e.link ? { ...e, link: { id: e.link.id, fingerprint: e.link.fingerprint } } : e])),
    );
  }
  const linkMailboxes = async (db: Database) => ({
    links: (await listLinks(db)).map((l) => l.mailbox),
    keys: Object.values((await getMeta<Record<string, KeyEntry>>(db, 'recipient-keys'))!).flatMap((e) => (e.link ? [e.link.mailbox] : [])),
  });

  it('learn it from the bundle when something comes through the link, and accept nothing through another mailbox', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const [reader, other, newcomer] = [await person(backend, 'reader'), await person(backend, 'other'), await person(backend, 'n')];
    const { ref, bundle } = await linkOf(backend, owner);
    expect(await linkMailboxes(owner.db)).toEqual({ links: [bundle.mailbox], keys: [bundle.mailbox] });
    // A chat the owner has read but not answered, and one answered.
    const read = await reader.messaging.startConversation(ref, bundle, 'read me');
    const answered = await other.messaging.startConversation(ref, bundle, 'answer me');
    await owner.messaging.sync();
    const [atRead, atAnswered] = [await across(reader.db, read, owner.db), await across(other.db, answered, owner.db)];
    await owner.messaging.markSeen(atRead);
    await owner.messaging.send(atAnswered, 'hi');
    await reader.messaging.sync();
    await other.messaging.sync();
    await asBefore(owner.db);
    expect(await linkMailboxes(owner.db)).toEqual({ links: [undefined], keys: [undefined] });

    // Through the link: for its key, and for the owner's key in the chat it read. And to the answered chat's mailbox.
    await newcomer.messaging.startConversation(ref, bundle, 'new here');
    await reader.messaging.send(read, 'more');
    await other.messaging.send(answered, 'and more');
    expect(await owner.messaging.sync()).toBe(3);
    expect(await linkMailboxes(owner.db)).toEqual({ links: [bundle.mailbox], keys: [bundle.mailbox] });

    // Through any other mailbox, nothing.
    await asBefore(owner.db);
    const before = await state(owner.db);
    const wrong = (await getConversation(owner.db, atAnswered))!.myMailbox!;
    await (await person(backend, 'x')).messaging.startConversation(ref, { ...bundle, mailbox: wrong }, 'wrong door');
    expect(await owner.messaging.sync()).toBe(0);
    expect((await state(owner.db)).chats).toEqual(before.chats);
  });

  for (const trouble of ['unreachable', 'busy'] as const) {
    it(`hold back only what needs the link while its bundle is ${trouble}, and take in the rest`, async () => {
      const backend = await fakeBackend();
      const owner = await person(backend, 'owner');
      const [friend, p, q] = [await person(backend, 'friend'), await person(backend, 'p'), await person(backend, 'q')];
      const { ref, bundle } = await linkOf(backend, owner);
      const known = await friend.messaging.startConversation(ref, bundle, 'hi');
      await owner.messaging.sync();
      await owner.messaging.send(await across(friend.db, known, owner.db), 'hello friend');
      await friend.messaging.sync();
      await asBefore(owner.db);

      await p.messaging.startConversation(ref, bundle, 'from p');
      await friend.messaging.send(known, 'still here');
      await q.messaging.startConversation(ref, bundle, 'from q');
      backend.down.bundles = trouble;
      backend.bundleFetches.length = 0;
      // The friend's message is taken in and confirmed; the two through the
      // link wait, unconfirmed, and the bundle is asked for once.
      expect(await owner.messaging.sync()).toBe(1);
      expect(backend.inboxes.get('owner')).toHaveLength(2);
      expect(backend.bundleFetches).toEqual([ref.id]);
      backend.down.bundles = null;
      expect(await owner.messaging.sync()).toBe(2);
      expect(backend.inboxes.get('owner')).toEqual([]);
    });
  }

  /** Two first messages through the link held back (its bundle out of reach), then the friend's: the owner, and how to hold them. */
  async function heldThenFriend() {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const [friend, p, q] = [await person(backend, 'friend'), await person(backend, 'p'), await person(backend, 'q')];
    const { ref, bundle } = await linkOf(backend, owner);
    const known = await friend.messaging.startConversation(ref, bundle, 'hi');
    await owner.messaging.sync();
    await owner.messaging.send(await across(friend.db, known, owner.db), 'hello friend');
    await friend.messaging.sync();
    await asBefore(owner.db);
    await p.messaging.startConversation(ref, bundle, 'from p');
    await q.messaging.startConversation(ref, bundle, 'from q');
    await friend.messaging.send(known, 'still here');
    backend.down.bundles = 'unreachable';
    backend.paging.size = 1;
    backend.inboxFetches.length = 0;
    return { backend, owner };
  }

  it('walk past pages of only what it holds back, and take in what is behind them', async () => {
    const { backend, owner } = await heldThenFriend();
    expect(await owner.messaging.sync()).toBe(1);
    // The two held back stay, unconfirmed; the friend's is confirmed.
    expect(backend.inboxes.get('owner')).toHaveLength(2);
    expect(backend.inboxFetches).toHaveLength(3);
    backend.down.bundles = null;
    expect(await owner.messaging.sync()).toBe(2);
    expect(backend.inboxes.get('owner')).toEqual([]);
  });

  it('not fetch again and again a page of only what it holds back from a server without `next`', async () => {
    const { backend, owner } = await heldThenFriend();
    backend.paging.next = false;
    await owner.messaging.sync();
    expect(backend.inboxFetches).toEqual(['/inbox']);
    expect(backend.inboxes.get('owner')).toHaveLength(3);
  });

  it('ask once per sync for a link gone from the server, and take nothing through it', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const { ref, bundle } = await linkOf(backend, owner);
    await asBefore(owner.db);
    await (await person(backend, 'p')).messaging.startConversation(ref, bundle, 'from p');
    await (await person(backend, 'q')).messaging.startConversation(ref, bundle, 'from q');
    backend.bundles.delete(ref.id);
    backend.bundleFetches.length = 0;
    expect(await owner.messaging.sync()).toBe(0);
    expect(backend.inboxes.get('owner')).toEqual([]);
    expect(backend.bundleFetches).toEqual([ref.id]);
  });

  it("keep nothing from a bundle that isn't the link's", async () => {
    // Someone else's link, or another of ours (signed by the same key).
    for (const whose of ['someone', 'ours'] as const) {
      const backend = await fakeBackend();
      const owner = await person(backend, 'owner');
      const other = whose === 'ours' ? owner : await person(backend, 'someone');
      await linkOf(backend, other);
      const { ref, bundle } = await linkOf(backend, owner);
      await asBefore(owner.db);
      await (await person(backend, 'p')).messaging.startConversation(ref, bundle, 'from p');
      backend.down.bundles = 'wrong';
      expect(await owner.messaging.sync()).toBe(0);
      await owner.messaging.maintain();
      expect((await listLinks(owner.db)).find((l) => l.id === ref.id)!.mailbox).toBeUndefined();
      expect(backend.inboxes.get('owner')).toHaveLength(1);
      backend.down.bundles = null;
      expect(await owner.messaging.sync()).toBe(1);
      expect((await listLinks(owner.db)).find((l) => l.id === ref.id)!.mailbox).toBe(bundle.mailbox);
    }
  });

  it('learn it at upkeep even when another upkeep step fails', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    await asBefore(owner.db);
    // Topping up the mailbox pool is refused today.
    await failNewMailboxes(owner, new ApiError(429, 'rate_limited'));
    await expect(owner.messaging.maintain()).rejects.toThrow(ApiError);
    expect(await linkMailboxes(owner.db)).toEqual({ links: [bundle.mailbox], keys: [bundle.mailbox] });
    expect((await listConversations(owner.db))[0]!.intro).toBe(bundle.mailbox);
  });

  it('learn it at upkeep too, and keep it on chats through the link', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    await asBefore(owner.db);
    expect((await listConversations(owner.db))[0]!.intro).toBeUndefined();
    await owner.messaging.maintain();
    expect(await linkMailboxes(owner.db)).toEqual({ links: [bundle.mailbox], keys: [bundle.mailbox] });
    expect((await listConversations(owner.db))[0]!.intro).toBe(bundle.mailbox);
  });
});

/**
 * A copy of a device's database as version 3 of the app kept it: each
 * conversation under its wire ID, messages and attachments by message ID.
 * Deletes that overtook their messages were kept by ID then (`deleted`, by
 * wire ID here), not as keyed hashes; nor was anything kept against replays.
 */
async function asVersion3(db: Database, name: string, deleted: Record<string, { id: string; at: number }[]> = {}): Promise<void> {
  const conversations = await db.getAll('conversations');
  const wire = new Map(conversations.map((c) => [c.id, c.wire]));
  const v3 = await openDB(name, 3, {
    upgrade(d) {
      for (const store of ['keys', 'vault', 'meta', 'media']) d.createObjectStore(store);
      d.createObjectStore('conversations', { keyPath: 'id' });
      d.createObjectStore('messages', { keyPath: 'id' }).createIndex('byConversation', ['conv', 'at']);
    },
  });
  for (const k of await db.getAllKeys('keys')) await v3.put('keys', await db.get('keys', k), k);
  for (const k of await db.getAllKeys('vault')) await v3.put('vault', await db.get('vault', k), k);
  // Edits waiting for their messages were kept on the conversation record.
  const edits = new Map<string, unknown>();
  for (const k of await db.getAllKeys('meta')) {
    if (String(k).startsWith('ids:')) continue;
    if (String(k).startsWith('edits:')) {
      edits.set(String(k).slice('edits:'.length), await db.get('meta', k));
      continue;
    }
    let value = await db.get('meta', k);
    // Nor did it keep links' intro mailboxes.
    if (k === 'recipient-keys') {
      const index = value as Record<string, KeyEntry>;
      value = Object.fromEntries(
        Object.entries(index).map(([id, e]) => [
          id,
          e.conv ? { ...e, conv: wire.get(e.conv)! } : e.link ? { ...e, link: { id: e.link.id, fingerprint: e.link.fingerprint } } : e,
        ]),
      );
    }
    if (k === 'links') value = (value as Record<string, unknown>[]).map(({ mailbox: _, ...l }) => l);
    await v3.put('meta', value, k);
  }
  for (const { wire: id, firstKey: _, introUntil: __, formerMailboxes: ___, newest: _n, lastMessage: _l, preview: _p, ...c } of conversations) {
    await v3.put('conversations', { ...c, id, ...(deleted[id] ? { deleted: deleted[id] } : {}), ...(edits.has(c.id) ? { edits: edits.get(c.id) } : {}) });
  }
  for (const { legacyFile: _, sent: _s, had: _h, ...m } of await db.getAll('messages')) await v3.put('messages', { ...m, conv: wire.get(m.conv)! });
  for (const key of await db.getAllKeys('media')) await v3.put('media', await db.get('media', key), typeof key === 'string' ? key : key[1]);
  v3.close();
}

describe('a database from before conversations had IDs of their own', () => {
  it('upgrades and carries on: its conversations, attachments, and what was still on its way', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const other = await person(backend, 'other');
    const { ref, bundle } = await linkOf(backend, owner);
    // An answered conversation with a photo, and an edit and a delete that overtook their messages.
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    await owner.messaging.send(await across(sender.db, conv, owner.db), 'hi');
    await sender.messaging.sync();
    const photo = crypto.getRandomValues(new Uint8Array(900));
    await sender.messaging.sendMedia(conv, { file: photo, media: { t: 'photo', s: photo.length, w: 9, h: 9, m: 'image/jpeg' } });
    const inbox = backend.inboxes.get('owner')!;
    await sender.messaging.send(conv, 'helo');
    const typo = inbox.pop()!;
    await sender.messaging.edit(conv, (await listMessages(sender.db, conv)).at(-1)!.id, 'hello again');
    await sender.messaging.send(conv, 'oops');
    const oops = inbox.pop()!;
    const oopsId = (await listMessages(sender.db, conv)).at(-1)!.id;
    await sender.messaging.deleteForEveryone(conv, oopsId);
    // And one not answered yet.
    const unanswered = await other.messaging.startConversation(ref, bundle, 'hey');
    expect(await owner.messaging.sync()).toBe(2);
    const pic = (await listMessages(owner.db, await across(sender.db, conv, owner.db))).at(-1)!;
    expect(await owner.messaging.fetchMedia(pic.conv, pic.id)).toBe('local');

    // The same device as version 3 kept it, opened by this version.
    const name = `engine-v3-${n++}`;
    await asVersion3(owner.db, name, { [(await getConversation(sender.db, conv))!.wire]: [{ id: oopsId, at: Date.now() }] });
    const db = await openDatabase(name);
    const after = createMessaging({ db, api: backend.api, session: owner.session, issuer: backend.issuer, mediaIssuer: backend.issuer, transfer: backend.transfer, later: backend.schedule, messageNow: pace });
    // Its conversations keep the IDs they had: their wire IDs.
    const [answered, waiting] = [(await getConversation(sender.db, conv))!.wire, (await getConversation(other.db, unanswered))!.wire];
    expect((await listConversations(db)).map((c) => c.id).sort()).toEqual([answered, waiting].sort());
    expect((await listMessages(db, answered)).map((m) => m.text)).toEqual(['hello', 'hi', '']);
    // The photo's file stayed where it was, under its message ID, and opens.
    expect(await db.getAllKeys('media')).toEqual([pic.id]);
    expect(await getMedia(db, answered, pic.id)).toEqual(photo);

    // What was still on its way arrives: the edited message edited, the deleted one not at all.
    backend.inboxes.get('owner')!.push(typo, oops);
    expect(await after.sync()).toBe(1);
    // The delete kept by ID is kept as a keyed hash from now on.
    const upgraded = (await getConversation(db, answered))!;
    expect([upgraded.deleted, (await getIds(db, answered)).gone?.flatMap((d) => d.tags).length]).toEqual([undefined, 1]);
    expect((await listMessages(db, answered)).map((m) => [m.text, m.edited !== undefined])).toEqual([
      ['hello', false],
      ['hi', false],
      ['', false],
      ['hello again', true],
    ]);

    // Both conversations carry on, both ways: the one not answered yet still through the link.
    await other.messaging.send(unanswered, 'still me');
    await sender.messaging.send(conv, 'and now?');
    expect(await after.sync()).toBe(2);
    expect((await listMessages(db, waiting)).map((m) => m.text)).toEqual(['hey', 'still me']);
    expect((await listMessages(db, answered)).at(-1)!.text).toBe('and now?');
    await after.send(waiting, 'hi other');
    await after.send(answered, 'yes');
    expect(await other.messaging.sync()).toBe(1);
    expect(await sender.messaging.sync()).toBe(1);
    expect((await listMessages(sender.db, conv)).at(-1)!.text).toBe('yes');

    // The old photo cleared and fetched again: it's kept the current way from then on.
    expect(await clearMedia(db, { conv: answered })).toBe(photo.length);
    expect(await db.getAllKeys('media')).toEqual([]);
    expect(await after.fetchMedia(answered, pic.id)).toBe('local');
    expect(await getMedia(db, answered, pic.id)).toEqual(photo);
    expect(await db.getAllKeys('media')).toEqual([[answered, pic.id]]);

    // Someone new through the link, reusing the ID of an old conversation
    // never answered (its sender's first key is known): a chat of their own.
    const newcomer = await person(backend, 'newcomer');
    nextIds(waiting);
    await newcomer.messaging.startConversation(ref, bundle, 'me too');
    expect(await after.sync()).toBe(1);
    expect(await listConversations(db)).toHaveLength(3);

    // Reusing the ID of an old conversation that was answered before the
    // upgrade (its sender's first key may have changed, so it isn't kept):
    // dropped, as before, so a replay of its first message can't open a
    // second chat. Only who knows that ID (its sender) can try this.
    const late = await person(backend, 'late');
    nextIds(answered);
    await late.messaging.startConversation(ref, bundle, 'me as well');
    expect(await after.sync()).toBe(0);
    expect(await listConversations(db)).toHaveLength(3);
    expect((await listMessages(db, answered)).at(-1)!.text).toBe('yes');
  });
});

describe('uploading and downloading attachments', () => {
  /** Sends a small photo from sender to owner; returns what's needed to check it. */
  async function photoChat() {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    const photo = crypto.getRandomValues(new Uint8Array(2000));
    const send = () => sender.messaging.sendMedia(conv, { file: photo, media: { t: 'photo', s: photo.length, w: 10, h: 10, m: 'image/jpeg' } });
    /** The photo as it arrived on the owner's device. */
    const received = async () => {
      await owner.messaging.sync();
      const local = await across(sender.db, conv, owner.db);
      return { local, theirs: (await listMessages(owner.db, local)).at(-1)! };
    };
    /** The sender's message, and whether its tokens were paid only once. */
    const mine = async () => (await listMessages(sender.db, conv)).at(-1)!;
    const paidOnce = async () => (await countTokens(sender.db, backend.issuer.keyId, undefined, 'media')) === backend.mediaSigned() - 1;
    return { backend, owner, sender, conv, photo, send, received, mine, paidOnce };
  }

  it('tries a failed upload again with fresh URLs, without new tokens', async () => {
    const { backend, owner, photo, send, received, mine, paidOnce } = await photoChat();
    // The bucket can't be reached, then the URL is refused (too late to start).
    backend.down.puts.push('unreachable', 'expired');
    await send();
    const [first, second, third] = backend.uploadUrls;
    expect(backend.uploadUrls).toHaveLength(3);
    expect(backend.puts).toEqual([first, second, third]);
    expect(await paidOnce()).toBe(true);
    expect(await mine()).toMatchObject({ status: 'sent', file: 'local' });
    const { local, theirs } = await received();
    expect(await owner.messaging.fetchMedia(local, theirs.id)).toBe('local');
    expect(await getMedia(owner.db, local, theirs.id)).toEqual(photo);
  });

  it('counts an upload as done when the server says it is stored: a try whose answer was lost', async () => {
    const { backend, send, mine, paidOnce } = await photoChat();
    backend.down.puts.push('lost');
    await send();
    // No second PUT: asked for a fresh URL, the server said it's there.
    expect(backend.puts).toHaveLength(1);
    expect(backend.uploadUrls).toHaveLength(1);
    expect([...backend.uploads.values()][0]!.renewals).toBe(1);
    expect(await paidOnce()).toBe(true);
    expect(await mine()).toMatchObject({ status: 'sent' });
  });

  it('drops the media tokens of an upload whose answer was lost, so the next upload goes through', async () => {
    const { backend, send, mine } = await photoChat();
    const request = backend.api.request;
    // Paid and stored, but the answer doesn't come back: its token is spent.
    backend.api.request = async (method, path, init, check) => {
      if (method !== 'POST' || path !== '/media') return request(method, path, init, check);
      backend.api.request = request;
      await request(method, path, init, check);
      throw new NetworkError('answer lost');
    };
    await expect(send()).rejects.toThrow(NetworkError);
    expect(await mine()).toMatchObject({ status: 'failed' });
    await send();
    expect(await mine()).toMatchObject({ status: 'sent' });
    expect(backend.mediaCalls.filter((c) => c === 'POST /media')).toHaveLength(2);
  });

  it('counts a 412 as done, even on the first try: the URL writes only once', async () => {
    const { backend, send, mine } = await photoChat();
    backend.down.puts.push('there');
    await send();
    expect(backend.puts).toHaveLength(1);
    expect([...backend.uploads.values()][0]!.renewals).toBe(0);
    expect(await mine()).toMatchObject({ status: 'sent' });
  });

  it('tries again after a 409, when a delete raced the write', async () => {
    const { backend, send, mine, paidOnce } = await photoChat();
    backend.down.puts.push('conflict');
    await send();
    expect(backend.puts).toEqual(backend.uploadUrls);
    expect(backend.puts).toHaveLength(2);
    expect(await paidOnce()).toBe(true);
    expect(await mine()).toMatchObject({ status: 'sent' });
  });

  it('fails the message when a fresh URL is refused partway', async () => {
    const { backend, send, mine, paidOnce } = await photoChat();
    backend.down.puts.push('unreachable', 'unreachable');
    backend.down.renewals.push('ok', 'refused');
    await expect(send()).rejects.toMatchObject({ code: 'not_found' });
    expect(backend.puts).toHaveLength(2);
    expect(await paidOnce()).toBe(true);
    expect(await mine()).toMatchObject({ status: 'failed' });
  });

  it('gives up after four tries, and the message is marked failed', async () => {
    const { backend, send, mine, paidOnce } = await photoChat();
    backend.down.puts.push('unreachable', 'unreachable', 'unreachable', 'unreachable');
    await expect(send()).rejects.toBeInstanceOf(TransferError);
    expect(backend.puts).toHaveLength(4);
    expect(backend.uploadUrls).toHaveLength(4);
    // Waiting longer each time.
    expect(backend.waits).toEqual([2_000, 10_000, 30_000]);
    expect(await paidOnce()).toBe(true);
    expect(await mine()).toMatchObject({ status: 'failed' });
  });

  it('counts a fresh-URL request that fails on the way as a failed try, and goes on', async () => {
    const { backend, send, mine, paidOnce } = await photoChat();
    backend.down.puts.push('unreachable');
    // Out of reach, then failing on the server, then a fresh URL.
    backend.down.renewals.push('unreachable', 'failing');
    await send();
    expect(backend.puts).toHaveLength(2);
    expect(backend.uploadUrls).toHaveLength(2);
    expect(backend.waits).toEqual([2_000, 10_000, 30_000]);
    expect(await paidOnce()).toBe(true);
    expect(await mine()).toMatchObject({ status: 'sent' });
  });

  it('runs two uploads at a time, and asks for the next URL only when one is done', async () => {
    const { backend, sender, conv, send } = await photoChat();
    // PUTs that hold until released.
    const held: (() => void)[] = [];
    const put = backend.transfer.put.bind(backend.transfer);
    backend.transfer.put = (url, body, onProgress) =>
      new Promise((resolve, reject) => {
        held.push(() => void put(url, body, onProgress).then(resolve, reject));
      });
    const sends = [send(), send(), send(), send()];
    await vi.waitFor(() => expect(held).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Two URLs asked for, not four: the others would age while waiting.
    expect(backend.uploadUrls).toHaveLength(2);
    held.shift()!();
    await vi.waitFor(() => expect(backend.uploadUrls).toHaveLength(3));
    expect(held).toHaveLength(2);
    // The rest, as each starts.
    for (let done = 0; done < 3; done++) {
      await vi.waitFor(() => expect(held.length).toBeGreaterThan(0));
      held.shift()!();
    }
    await Promise.all(sends);
    expect(backend.uploadUrls).toHaveLength(4);
    expect((await listMessages(sender.db, conv)).filter((m) => m.media).map((m) => m.status)).toEqual(['sent', 'sent', 'sent', 'sent']);
  });

  it('downloads only the padded size the message says, and marks another broken', async () => {
    const { backend, owner, photo, send, received } = await photoChat();
    await send();
    const { local, theirs } = await received();
    // Not the upload the message names: refused, and marked broken, so it
    // isn't fetched again by itself.
    const up = [...backend.uploads.values()][0]!;
    const body = up.body!;
    up.body = new Uint8Array(up.size * 2);
    expect(await owner.messaging.fetchMedia(local, theirs.id)).toBe('broken');
    expect((await listMessages(owner.db, local)).at(-1)!.file).toBe('broken');
    expect(await getMedia(owner.db, local, theirs.id)).toBeUndefined();
    // A tap tries again.
    up.body = body;
    expect(await owner.messaging.fetchMedia(local, theirs.id)).toBe('local');
    expect(await getMedia(owner.db, local, theirs.id)).toEqual(photo);
  });

  it("marks broken an upload that doesn't decrypt with the message's key", async () => {
    const { backend, owner, send, received } = await photoChat();
    await send();
    const { local, theirs } = await received();
    // The right size, but not what the sender's key sealed.
    const up = [...backend.uploads.values()][0]!;
    up.body = crypto.getRandomValues(new Uint8Array(up.size));
    expect(await owner.messaging.fetchMedia(local, theirs.id)).toBe('broken');
    expect((await listMessages(owner.db, local)).at(-1)!.file).toBe('broken');
    expect(await getMedia(owner.db, local, theirs.id)).toBeUndefined();
  });

  it("marks broken an upload the bucket refuses, which a tap asks for again; and leaves one it can't reach to fetch later", async () => {
    const { backend, owner, photo, send, received } = await photoChat();
    await send();
    const { local, theirs } = await received();
    const up = [...backend.uploads.values()][0]!;
    const body = up.body!;
    // The bucket out of reach, or failing: tried again later.
    const get = backend.transfer.get.bind(backend.transfer);
    for (const status of [0, 500, 503]) {
      backend.transfer.get = async () => {
        throw new TransferError(status, 'down');
      };
      await expect(owner.messaging.fetchMedia(local, theirs.id)).rejects.toMatchObject({ status });
      expect((await listMessages(owner.db, local)).at(-1)!.file).toBe('remote');
    }
    // S3 answers 403 (or 404) for a file never uploaded, and as much for a
    // URL that expired before it was used (an app put to sleep in between):
    // broken, so it isn't fetched again by itself...
    backend.transfer.get = async () => {
      throw new TransferError(403, 'expired');
    };
    expect(await owner.messaging.fetchMedia(local, theirs.id)).toBe('broken');
    expect((await listMessages(owner.db, local)).at(-1)!.file).toBe('broken');
    const asked = backend.mediaCalls.length;
    expect(await owner.messaging.fetchMedia(local, theirs.id, undefined, true)).toBe('broken');
    expect(backend.mediaCalls).toHaveLength(asked);
    // ...but a tap asks for a fresh URL, and gets it.
    backend.transfer.get = get;
    up.body = body;
    expect(await owner.messaging.fetchMedia(local, theirs.id)).toBe('local');
    expect(backend.mediaCalls).toHaveLength(asked + 1);
    expect(await getMedia(owner.db, local, theirs.id)).toEqual(photo);
  });

  it('fetches by itself only one still to fetch: not one cleared or broken meanwhile', async () => {
    const { backend, owner, send, received } = await photoChat();
    await send();
    const { local, theirs } = await received();
    // Another fetch found it broken while this one waited.
    await setFile(owner.db, local, theirs.id, 'broken');
    expect(await owner.messaging.fetchMedia(local, theirs.id, undefined, true)).toBe('broken');
    await setFile(owner.db, local, theirs.id, 'cleared');
    expect(await owner.messaging.fetchMedia(local, theirs.id, undefined, true)).toBe('cleared');
    expect(backend.mediaCalls.filter((c) => c.startsWith('GET'))).toEqual([]);
    // A tap does.
    expect(await owner.messaging.fetchMedia(local, theirs.id)).toBe('local');
  });
});

describe('deleting an attachment or message while it goes out', () => {
  async function chat() {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    const photo = crypto.getRandomValues(new Uint8Array(2000));
    const out = { file: photo, media: { t: 'photo', s: photo.length, w: 10, h: 10, m: 'image/jpeg' } };
    /** PUTs that wait until released. */
    const held: (() => void)[] = [];
    const holdPuts = () => {
      const put = backend.transfer.put.bind(backend.transfer);
      backend.transfer.put = (url, body, onProgress) =>
        new Promise((resolve, reject) => {
          held.push(() => void put(url, body, onProgress).then(resolve, reject));
        });
    };
    /** What reached the owner, as texts, after 'hello'. */
    const reached = async () => {
      await owner.messaging.sync();
      const local = await across(sender.db, conv, owner.db);
      return (await listMessages(owner.db, local)).map((m) => (m.media ? `[${m.media.t}]` : m.text));
    };
    return { backend, owner, sender, conv, out, held, holdPuts, reached };
  }

  it("doesn't send an attachment deleted while it uploads, and deletes its upload", async () => {
    const { backend, sender, conv, out, held, holdPuts, reached } = await chat();
    holdPuts();
    let id = '';
    const sending = sender.messaging.sendMedia(conv, out, 'oops', undefined, (stored) => void (id = stored));
    await vi.waitFor(() => expect(held).toHaveLength(1));
    expect(await getMessage(sender.db, conv, id)).toMatchObject({ status: 'sending' });
    const sends = backend.sendAttempts.length;
    await sender.messaging.deleteHere(conv, id);
    held.shift()!();
    await sending;
    // Not sent, no token shown for it, and not back on this device.
    expect(backend.sendAttempts).toHaveLength(sends);
    expect(await getMessage(sender.db, conv, id)).toBeUndefined();
    expect(await getMedia(sender.db, conv, id)).toBeUndefined();
    // Its upload goes from the server.
    await sender.messaging.flushUploadDeletes();
    expect(backend.uploads.size).toBe(0);
    expect(await pendingUploadDeletes(sender.db)).toEqual([]);
    expect(await reached()).toEqual(['hello']);
  });

  it("asks again later to delete an upload the server didn't find just after it was made", async () => {
    const { backend, sender, conv, out, held, holdPuts } = await chat();
    holdPuts();
    let id = '';
    const sending = sender.messaging.sendMedia(conv, out, '', undefined, (stored) => void (id = stored));
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await sender.messaging.deleteHere(conv, id);
    // The server's lookup lags: the first delete finds nothing.
    backend.down.deleteLag = 1;
    held.shift()!();
    await sending;
    await vi.waitFor(() => expect(backend.later.some((job) => job.ms === 30_000)).toBe(true));
    for (const job of backend.later.filter((j) => j.ms === 30_000)) job.fn();
    await sender.messaging.flushUploadDeletes();
    expect(backend.mediaCalls.filter((c) => c.endsWith('/delete'))).toHaveLength(2);
    expect(backend.uploads.size).toBe(0);
    expect(await pendingUploadDeletes(sender.db)).toEqual([]);
  });

  it('says nothing when an attachment deleted while it uploads then fails to upload, and deletes the upload', async () => {
    const { backend, sender, conv, out, reached } = await chat();
    let id = '';
    // Deleted during the first PUT, which fails, and so do the three after it.
    const put = backend.transfer.put.bind(backend.transfer);
    backend.transfer.put = async () => {
      backend.transfer.put = put;
      await sender.messaging.deleteHere(conv, id);
      throw new TransferError(0, 'unreachable');
    };
    backend.down.puts.push('unreachable', 'unreachable', 'unreachable');
    await sender.messaging.sendMedia(conv, out, '', undefined, (stored) => void (id = stored));
    expect(backend.puts).toHaveLength(3);
    expect(await getMessage(sender.db, conv, id)).toBeUndefined();
    await sender.messaging.flushUploadDeletes();
    expect(backend.uploads.size).toBe(0);
    expect(await reached()).toEqual(['hello']);
  });

  it("doesn't upload or pay for an attachment deleted before its upload starts", async () => {
    const { backend, sender, conv, out, reached } = await chat();
    const tokens = await countTokens(sender.db, backend.issuer.keyId, undefined, 'media');
    await sender.messaging.sendMedia(conv, out, '', undefined, (id) => sender.messaging.deleteHere(conv, id));
    expect(backend.mediaCalls).toEqual([]);
    expect(await countTokens(sender.db, backend.issuer.keyId, undefined, 'media')).toBe(tokens);
    expect(await listMessages(sender.db, conv)).toHaveLength(1);
    expect(await reached()).toEqual(['hello']);
  });

  it("doesn't send attachments still uploading when their chat is deleted", async () => {
    const { backend, sender, conv, out, held, holdPuts, reached } = await chat();
    holdPuts();
    const sending = sender.messaging.sendMedia(conv, out);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await sender.messaging.remove(conv);
    held.shift()!();
    await sending;
    expect(await listMessages(sender.db, conv)).toEqual([]);
    await sender.messaging.flushUploadDeletes();
    expect(backend.uploads.size).toBe(0);
    expect(await reached()).toEqual(['hello']);
  });

  it("doesn't send a message deleted before it goes out", async () => {
    const { backend, sender, conv, reached } = await chat();
    const sends = backend.sendAttempts.length;
    let id = '';
    await sender.messaging.send(conv, 'oops', undefined, async () => {
      id = (await listMessages(sender.db, conv)).at(-1)!.id;
      await sender.messaging.deleteHere(conv, id);
    });
    expect(backend.sendAttempts).toHaveLength(sends);
    expect(await getMessage(sender.db, conv, id)).toBeUndefined();
    expect(await reached()).toEqual(['hello']);
    // The next one goes as usual.
    await sender.messaging.send(conv, 'hi');
    expect(await reached()).toEqual(['hello', 'hi']);
  });

  it('sends an attachment as usual when it stays, keeping what changed on it meanwhile', async () => {
    const { sender, conv, out, held, holdPuts, reached } = await chat();
    holdPuts();
    let id = '';
    const sending = sender.messaging.sendMedia(conv, out, 'a cat', undefined, (stored) => void (id = stored));
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await sender.messaging.react(conv, id, '👍');
    held.shift()!();
    await sending;
    const mine = (await getMessage(sender.db, conv, id))!;
    expect(mine).toMatchObject({ status: 'sent', file: 'local', text: 'a cat', media: { t: 'photo' } });
    expect(mine.media!.id).toBeDefined();
    expect(mine.reactions?.mine?.e).toBe('👍');
    expect(await reached()).toEqual(['hello', '[photo]']);
  });
});

describe('a send refused after its upload', () => {
  /** A chat with a photo sent whose message's send fails as given (just once); delivered: it reaches the server first. */
  async function failing(failure: Error, delivered = false) {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    const request = backend.api.request;
    backend.api.request = async (method, path, init, check) => {
      if (method !== 'POST' || path !== '/send') return request(method, path, init, check);
      backend.api.request = request;
      if (delivered) await request(method, path, init, check);
      throw failure;
    };
    const photo = crypto.getRandomValues(new Uint8Array(2000));
    await expect(sender.messaging.sendMedia(conv, { file: photo, media: { t: 'photo', s: photo.length, w: 10, h: 10, m: 'image/jpeg' } })).rejects.toBe(failure);
    expect((await listMessages(sender.db, conv)).at(-1)).toMatchObject({ status: 'failed', media: { t: 'photo' } });
    await sender.messaging.flushUploadDeletes();
    return { backend, owner, sender, conv };
  }

  it('deletes the upload when the server refused the message outright: it never went out', async () => {
    // A mailbox's cap, a bad envelope, tokens of a key it no longer holds.
    for (const refusal of [new ApiError(429, 'rate_limited'), new ApiError(400, 'invalid_envelope'), new ApiError(409, 'unknown_issuer_key')]) {
      const { backend, sender } = await failing(refusal);
      expect(backend.uploads.size).toBe(0);
      expect(await pendingUploadDeletes(sender.db)).toEqual([]);
    }
  });

  it('keeps the upload after a failure that may have delivered the message: no answer, or the server failing', async () => {
    const { backend, owner, sender, conv } = await failing(new NetworkError('answer lost'), true);
    expect(backend.uploads.size).toBe(1);
    expect(await pendingUploadDeletes(sender.db)).toEqual([]);
    // It did arrive, and the other side can fetch it.
    await owner.messaging.sync();
    const local = await across(sender.db, conv, owner.db);
    const theirs = (await listMessages(owner.db, local)).at(-1)!;
    expect(await owner.messaging.fetchMedia(local, theirs.id)).toBe('local');
    const failingServer = await failing(new ApiError(500, 'internal'));
    expect(failingServer.backend.uploads.size).toBe(1);
  });

  it('deletes the upload when it failed before its message could go out', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    // Paid for, but the PUT fails every time.
    backend.down.puts.push('unreachable', 'unreachable', 'unreachable', 'unreachable');
    const photo = crypto.getRandomValues(new Uint8Array(2000));
    await expect(sender.messaging.sendMedia(conv, { file: photo, media: { t: 'photo', s: photo.length, w: 10, h: 10, m: 'image/jpeg' } })).rejects.toBeInstanceOf(
      TransferError,
    );
    const mine = (await listMessages(sender.db, conv)).at(-1)!;
    // Failed, and sent again as a new upload if the user asks.
    expect(mine).toMatchObject({ status: 'failed' });
    expect(canResend(mine, Date.now())).toBe(true);
    await sender.messaging.flushUploadDeletes();
    expect(backend.uploads.size).toBe(0);
  });

  it('deletes the upload when there were no tokens to send it with', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    // The wallet is empty, and the day's send tokens are used up.
    await takeTokens(sender.db, backend.issuer.keyId, await countTokens(sender.db, backend.issuer.keyId));
    failRequest(sender, 'POST', /^\/tokens$/, new ApiError(429, 'rate_limited'));
    const photo = crypto.getRandomValues(new Uint8Array(2000));
    await expect(sender.messaging.sendMedia(conv, { file: photo, media: { t: 'photo', s: photo.length, w: 10, h: 10, m: 'image/jpeg' } })).rejects.toBeInstanceOf(NoTokens);
    await sender.messaging.flushUploadDeletes();
    expect(backend.uploads.size).toBe(0);
  });

  it("deletes the upload of a first reply that had no mailbox to give; keeps it when the server failed on the way", async () => {
    for (const [failure, kept] of [
      [new ApiError(429, 'rate_limited'), 0],
      [new ApiError(409, 'mailbox_limit'), 0],
      [new ApiError(500, 'internal'), 1],
    ] as const) {
      const backend = await fakeBackend();
      const owner = await person(backend, 'owner');
      const sender = await person(backend, 'sender');
      const { ref, bundle } = await linkOf(backend, owner);
      const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
      await owner.messaging.sync();
      const local = await across(sender.db, conv, owner.db);
      expect(await poolSize(owner.db)).toBe(0);
      // The first reply takes a mailbox, and the pool has to be refilled.
      failRequest(owner, 'POST', /^\/mailboxes$/, failure);
      const photo = crypto.getRandomValues(new Uint8Array(2000));
      const sending = owner.messaging.sendMedia(local, { file: photo, media: { t: 'photo', s: photo.length, w: 10, h: 10, m: 'image/jpeg' } });
      if (kept) await expect(sending).rejects.toBe(failure);
      else await expect(sending).rejects.toBeInstanceOf(failure.code === 'mailbox_limit' ? MailboxLimit : NoMailboxes);
      await owner.messaging.flushUploadDeletes();
      expect(backend.uploads.size).toBe(kept);
    }
  });

  it('sends one refused outright again as a new upload: its message no longer names the deleted one', async () => {
    const { backend, owner, sender, conv } = await failing(new ApiError(400, 'invalid_envelope'));
    const failed = (await listMessages(sender.db, conv)).at(-1)!;
    expect(failed.media!.id).toBeUndefined();
    expect(canResend(failed, Date.now())).toBe(true);
    await sender.messaging.resend(conv, failed.id);
    expect((await listMessages(sender.db, conv)).at(-1)).toMatchObject({ id: failed.id, status: 'sent', file: 'local' });
    expect(backend.uploads.size).toBe(1);
    await owner.messaging.sync();
    const local = await across(sender.db, conv, owner.db);
    const theirs = (await listMessages(owner.db, local)).at(-1)!;
    expect(theirs.id).toBe(failed.id);
    expect(await owner.messaging.fetchMedia(local, theirs.id)).toBe('local');
  });

  it('deleted here instead of sent again: an upload that may have arrived stays; a refused one is gone already', async () => {
    const maybe = await failing(new NetworkError('answer lost'), true);
    const kept = (await listMessages(maybe.sender.db, maybe.conv)).at(-1)!;
    expect(kept.media!.id).toBeDefined();
    await maybe.sender.messaging.deleteHere(maybe.conv, kept.id);
    await maybe.sender.messaging.flushUploadDeletes();
    expect(maybe.backend.uploads.size).toBe(1);
    expect(await pendingUploadDeletes(maybe.sender.db)).toEqual([]);

    const refused = await failing(new ApiError(429, 'rate_limited'));
    expect(refused.backend.uploads.size).toBe(0);
    await refused.sender.messaging.deleteHere(refused.conv, (await listMessages(refused.sender.db, refused.conv)).at(-1)!.id);
    expect(await pendingUploadDeletes(refused.sender.db)).toEqual([]);
    expect(refused.backend.mediaCalls.filter((c) => c === 'POST /media/delete')).toHaveLength(1);
  });
});

describe('what a change that stops halfway leaves', () => {
  async function chat() {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    return { backend, owner, sender, ref, bundle };
  }

  it('keeps no file of a message deleted while it downloads', async () => {
    const { backend, owner, sender, ref, bundle } = await chat();
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    const photo = crypto.getRandomValues(new Uint8Array(2000));
    await sender.messaging.sendMedia(conv, { file: photo, media: { t: 'photo', s: photo.length, w: 10, h: 10, m: 'image/jpeg' } });
    await owner.messaging.sync();
    const local = await across(sender.db, conv, owner.db);
    const theirs = (await listMessages(owner.db, local)).at(-1)!;
    // Deleted here once its file has downloaded, before it's kept.
    const get = backend.transfer.get.bind(backend.transfer);
    backend.transfer.get = async (url, size, onProgress) => {
      const body = await get(url, size, onProgress);
      await owner.messaging.deleteHere(local, theirs.id);
      return body;
    };
    expect(await owner.messaging.fetchMedia(local, theirs.id)).toBe('gone');
    expect(await getMessage(owner.db, local, theirs.id)).toBeUndefined();
    expect(await owner.db.getAllKeys('media')).toEqual([]);
  });

  it('stores no file of ours before its message: one whose message could not be stored leaves none', async () => {
    const { backend, sender, ref, bundle } = await chat();
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    pause.before = async (c) => {
      if (c === conv) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
    const photo = crypto.getRandomValues(new Uint8Array(2000));
    await expect(sender.messaging.sendMedia(conv, { file: photo, media: { t: 'photo', s: photo.length, w: 10, h: 10, m: 'image/jpeg' } })).rejects.toThrow();
    pause.before = null;
    expect(await sender.db.getAllKeys('media')).toEqual([]);
    expect(backend.mediaCalls).toEqual([]);
  });

  it('stores a new conversation before its first message: one that failed to be stored is taken in when it comes again', async () => {
    const { owner, sender, ref, bundle } = await chat();
    await sender.messaging.startConversation(ref, bundle, 'hello');
    pause.before = async (_, text) => {
      if (text === 'hello') throw new Error('closed');
    };
    await expect(owner.messaging.sync()).rejects.toThrow('closed');
    pause.before = null;
    // There, out of the list, with nothing in it.
    const [c] = await listConversations(owner.db);
    expect(c).toMatchObject({ hidden: true, unread: 0 });
    expect(await listMessages(owner.db, c!.id)).toEqual([]);
    expect(await owner.messaging.sync()).toBe(1);
    expect(await listConversations(owner.db)).toEqual([expect.objectContaining({ id: c!.id, hidden: false, unread: 1 })]);
    expect((await listMessages(owner.db, c!.id)).map((m) => m.text)).toEqual(['hello']);
  });

  it('shows a first message stored just before the app closed, when it comes again: never one without its conversation', async () => {
    const { owner, sender, ref, bundle } = await chat();
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    const [first] = await listMessages(sender.db, conv);
    // Stored, then the app closes before its conversation is written.
    pause.after = async (_, text) => {
      if (text === 'hello') throw new Error('closed');
    };
    await expect(owner.messaging.sync()).rejects.toThrow('closed');
    pause.after = null;
    const [c] = await listConversations(owner.db);
    expect(c).toMatchObject({ hidden: true, unread: 0 });
    // Delivered again: not dropped as taken in already.
    expect(await owner.messaging.sync()).toBe(1);
    expect(await listConversations(owner.db)).toEqual([expect.objectContaining({ id: c!.id, hidden: false, unread: 1 })]);
    expect((await listMessages(owner.db, c!.id)).map((m) => m.text)).toEqual(['hello']);
    // As newest as on the usual path: our first reply names it as `last`.
    expect(await getConversation(owner.db, c!.id)).toMatchObject({ lastReceived: first!.id, newest: { at: first!.at }, lastMessage: { id: first!.id } });
    // And only once.
    expect(await owner.messaging.sync()).toBe(0);
    expect(await listMessages(owner.db, c!.id)).toHaveLength(1);
  });

  it('upkeep deletes messages whose conversation is gone, and files whose message is, once still so an hour later; on this device only', async () => {
    const { owner } = await chat();
    // Left by an older version, or a change that stopped halfway.
    const media = { t: 'photo', s: 1, w: 1, h: 1, id: 'U'.repeat(22), k: 'K'.repeat(43), d: 'D'.repeat(22) };
    await addMessage(owner.db, { id: 'm1', conv: 'gone', at: 1, out: false, status: 'received', file: 'local' }, { text: 'lost', media });
    await putMedia(owner.db, 'gone', 'm1', new Uint8Array([1]));
    await owner.db.put('media', new Uint8Array([2]), ['gone', 'm2']);
    const left = async () => [await owner.db.getAllKeys('messages'), await owner.db.getAllKeys('media')];
    const all = await left();
    // Found and noted, keys only: nothing goes yet (a write under way, in
    // another copy of the app say, may be about to finish it).
    await owner.messaging.maintain();
    expect(await left()).toEqual(all);
    expect(await owner.db.get('meta', 'sweep')).toMatchObject({ convs: [{ id: 'gone' }], files: [{ key: ['gone', 'm2'] }] });
    // Still so at an upkeep less than an hour later: still nothing.
    const later = (ms: number) => owner.open({ now: () => Date.now() + ms });
    await later(30 * 60_000).maintain();
    expect(await left()).toEqual(all);
    // An hour or more after it was found: it goes, and so do the notes.
    await later(61 * 60_000).maintain();
    expect(await left()).toEqual([[], []]);
    expect(await owner.db.get('meta', 'sweep')).toBeUndefined();
    // Its upload stays: taken in again, the same message may be in a conversation that is here.
    expect(await pendingUploadDeletes(owner.db)).toEqual([]);
  });

  it("upkeep never sweeps a conversation's messages while they're being taken in: only under its lock, looked at again", async () => {
    const { owner } = await chat();
    // A first message stored and its conversation not yet, as an older copy
    // of the app takes it in (under the chat's lock); noted long enough ago.
    await addMessage(owner.db, { id: 'm1', conv: 'new', at: 1, out: false, status: 'received' }, { text: 'hello' });
    await putMeta(owner.db, 'sweep', { convs: [{ id: 'new', seen: Date.now() - 2 * 60 * 60_000 }], files: [] });
    let release!: () => void;
    const held = withLock('send:new', () => new Promise<void>((resolve) => (release = resolve)));
    const upkeep = owner.messaging.maintain();
    await waitingFor('send:new');
    await putConversation(owner.db, {
      id: 'new',
      wire: 'W'.repeat(22),
      role: 'owner',
      link: { id: 'L'.repeat(11), fingerprint: 'F'.repeat(43) },
      label: 'x',
      peerKey: 'k',
      myKey: null,
      sendTo: 'S'.repeat(22),
      myMailbox: null,
      lastAt: 1,
      unread: 1,
      status: 'active',
      lastReceived: null,
    });
    release();
    await held;
    await upkeep;
    expect(await owner.db.getAllKeys('messages')).toEqual([['new', 'm1']]);
    // Not stray any more: no longer noted.
    expect(await owner.db.get('meta', 'sweep')).toBeUndefined();
  });
});

describe('upkeep and stop()', () => {
  it('starts no more steps once stopped: the one under way is the last', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const calls: string[] = [];
    const call = owner.session.call;
    let stopAt: string | null = '/mailboxes';
    owner.session.call = async function (method, path, ...rest) {
      calls.push(`${method} ${path}`);
      // Stopped while it tops up the mailbox pool, a step of its own.
      if (path === stopAt) owner.messaging.stop();
      return call(method, path, ...rest);
    } as Session['call'];
    await queueUploadDeletes(owner.db, [{ id: rand(), d: rand() }]);
    await owner.messaging.maintain();
    // Nothing after it: no tokens fetched, no uploads deleted (the last step).
    expect(calls).toEqual(['POST /mailboxes']);
    expect(backend.mediaCalls).toEqual([]);
    expect(await pendingUploadDeletes(owner.db)).toHaveLength(1);
    // The next start's upkeep runs them all.
    stopAt = null;
    await owner.open().maintain();
    expect(calls).toContain('POST /tokens');
    expect(backend.mediaCalls).toEqual(['POST /media/delete']);
    expect(await pendingUploadDeletes(owner.db)).toEqual([]);
    expect(await poolSize(owner.db)).toBeGreaterThanOrEqual(POOL_LOW);
  });
});

describe('attachments paused by the operator', () => {
  async function photoChat() {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    const photo = crypto.getRandomValues(new Uint8Array(2000));
    const send = () => sender.messaging.sendMedia(conv, { file: photo, media: { t: 'photo', s: photo.length, w: 10, h: 10, m: 'image/jpeg' } }, 'a cat');
    const mine = async () => (await listMessages(sender.db, conv)).at(-1)!;
    /** Every media token signed for the sender is still in its wallet, or paid for exactly the uploads made. */
    const tokensLeft = async () => backend.mediaSigned() - (await countTokens(sender.db, backend.issuer.keyId, undefined, 'media'));
    return { backend, owner, sender, conv, photo, send, mine, tokensLeft };
  }

  it('keeps the message unsent and its tokens, asks once, and sends it again later', async () => {
    const { backend, owner, sender, conv, photo, send, mine, tokensLeft } = await photoChat();
    backend.down.uploads = true;
    await expect(send()).rejects.toMatchObject({ code: 'uploads_paused' });
    // One request, no PUT, no waiting to try again; no token spent.
    expect(backend.mediaCalls).toEqual(['POST /media']);
    expect(backend.puts).toEqual([]);
    expect(backend.waits).toEqual([]);
    expect(await tokensLeft()).toBe(0);
    const failed = await mine();
    expect(failed).toMatchObject({ status: 'failed', file: 'local', text: 'a cat', media: { t: 'photo' } });
    expect(failed.media!.id).toBeUndefined();
    expect(canResend(failed, Date.now())).toBe(true);

    // Still paused: the same, once more.
    await expect(sender.messaging.resend(conv, failed.id)).rejects.toMatchObject({ code: 'uploads_paused' });
    expect(backend.mediaCalls).toEqual(['POST /media', 'POST /media']);
    expect(await tokensLeft()).toBe(0);
    expect(await mine()).toMatchObject({ id: failed.id, status: 'failed' });

    // Resumed: sent as the same message, at the end, paid once, even when
    // tried twice at once (two copies of the app): the second finds it sent
    // and quietly does nothing.
    backend.down.uploads = false;
    const shown: string[] = [];
    await Promise.all([
      sender.messaging.resend(conv, failed.id, async () => void shown.push((await mine()).status)),
      sender.messaging.resend(conv, failed.id, async () => void shown.push('again')),
    ]);
    expect(backend.mediaCalls).toEqual(['POST /media', 'POST /media', 'POST /media']);
    expect(shown).toEqual(['sending']);
    const sent = await mine();
    expect(sent).toMatchObject({ id: failed.id, status: 'sent', file: 'local', text: 'a cat' });
    expect(sent.at).toBeGreaterThanOrEqual(failed.at);
    expect(canResend(sent, Date.now())).toBe(false);
    expect(await tokensLeft()).toBe(1);
    // Nothing more to send again.
    await sender.messaging.resend(conv, failed.id);
    expect(backend.mediaCalls).toHaveLength(3);

    await owner.messaging.sync();
    const local = await across(sender.db, conv, owner.db);
    const theirs = (await listMessages(owner.db, local)).at(-1)!;
    expect(theirs).toMatchObject({ id: failed.id, text: 'a cat', file: 'remote' });
    expect(await owner.messaging.fetchMedia(local, theirs.id)).toBe('local');
    expect(await getMedia(owner.db, local, theirs.id)).toEqual(photo);
  });

  it('stops at once when a fresh URL is refused because uploads were paused meanwhile', async () => {
    const { backend, send, mine, tokensLeft } = await photoChat();
    backend.down.puts.push('unreachable');
    backend.down.renewals.push('paused');
    await expect(send()).rejects.toMatchObject({ code: 'uploads_paused' });
    // One wait before asking for a fresh URL, then no more tries.
    expect(backend.puts).toHaveLength(1);
    expect(backend.waits).toEqual([2_000]);
    expect(backend.mediaCalls.filter((c) => c.endsWith('/upload'))).toHaveLength(1);
    expect(await tokensLeft()).toBe(1);
    expect(await mine()).toMatchObject({ status: 'failed' });
    // Its message never went out, so it can be sent again; like an upload
    // whose four tries all failed, that pays again (the app doesn't keep a
    // paid upload it couldn't finish).
    expect(canResend(await mine(), Date.now())).toBe(true);
  });

  it('leaves an attachment to fetch while downloads are paused', async () => {
    const { backend, owner, sender, conv, photo, send } = await photoChat();
    await send();
    await owner.messaging.sync();
    const local = await across(sender.db, conv, owner.db);
    const theirs = (await listMessages(owner.db, local)).at(-1)!;
    backend.down.downloads = true;
    await expect(owner.messaging.fetchMedia(local, theirs.id)).rejects.toMatchObject({ code: 'downloads_paused' });
    expect((await listMessages(owner.db, local)).at(-1)!.file).toBe('remote');
    backend.down.downloads = false;
    expect(await owner.messaging.fetchMedia(local, theirs.id)).toBe('local');
    expect(await getMedia(owner.db, local, theirs.id)).toEqual(photo);
  });
});

describe('ours left sending, and sending them again', () => {
  async function chat() {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const local = await across(sender.db, conv, owner.db);
    const mine = async () => (await listMessages(sender.db, conv)).at(-1)!;
    const theirs = () => listMessages(owner.db, local);
    const photo = crypto.getRandomValues(new Uint8Array(2000));
    const out = { file: photo, media: { t: 'photo', s: photo.length, w: 10, h: 10, m: 'image/jpeg' } };
    return { backend, owner, sender, conv, local, mine, theirs, photo, out };
  }

  /** The next send (POST /send) fails as given, without reaching the server. */
  function failNextSend(backend: Awaited<ReturnType<typeof fakeBackend>>, failure: Error): void {
    const request = backend.api.request;
    backend.api.request = async (method, path, init, check) => {
      if (method !== 'POST' || path !== '/send') return request(method, path, init, check);
      backend.api.request = request;
      throw failure;
    };
  }

  /** A photo whose message's send failed on the way: it didn't arrive, but may have, so its upload stays. */
  async function failedPhoto({ backend, sender, conv, out, mine }: Awaited<ReturnType<typeof chat>>) {
    failNextSend(backend, new NetworkError('out of reach'));
    await expect(sender.messaging.sendMedia(conv, out, 'a cat')).rejects.toThrow(NetworkError);
    const failed = await mine();
    expect(failed).toMatchObject({ status: 'failed', file: 'local', media: { t: 'photo' } });
    expect(failed.media!.id).toBeDefined();
    expect(failed.uploadedAt).toBeDefined();
    return failed;
  }

  it('shows one the app closed on as not sent; sent again, it goes once, with its ID, and they keep one copy', async () => {
    const { backend, owner, sender, conv, mine, theirs } = await chat();
    // Delivered, then the app closed before it marked it sent.
    await sender.messaging.send(conv, 'did it go?');
    const left = await mine();
    await setMessageStatus(sender.db, conv, left.id, 'sending');
    expect(await owner.messaging.sync()).toBe(1);
    // The app starts again: no copy is sending it.
    expect(await failStuck(sender.db)).toEqual([conv]);
    const failed = await mine();
    expect(failed).toMatchObject({ id: left.id, status: 'failed' });
    expect(canResend(failed, Date.now())).toBe(true);
    // Sent again from two copies of the app at once: once, paid like any
    // send, with fresh tokens, and the same ID.
    const sends = backend.sendPayments.length;
    await Promise.all([sender.messaging.resend(conv, failed.id), copyOf(backend, sender).resend(conv, failed.id)]);
    expect(backend.sendPayments).toHaveLength(sends + 1);
    expect(tiedSends(backend)).toEqual([]);
    const sent = await mine();
    expect(sent).toMatchObject({ id: failed.id, status: 'sent', text: 'did it go?', firstAt: failed.at });
    expect(canResend(sent, Date.now())).toBe(false);
    // They had it: the repeat is dropped (they have a message with its ID).
    expect(await owner.messaging.sync()).toBe(0);
    expect((await theirs()).filter((m) => m.id === failed.id)).toHaveLength(1);
  });

  it('keeps one they deleted deleted when it comes again', async () => {
    const { owner, sender, conv, local, mine, theirs } = await chat();
    await sender.messaging.send(conv, 'deleted there');
    const left = await mine();
    await setMessageStatus(sender.db, conv, left.id, 'sending');
    await owner.messaging.sync();
    await owner.messaging.deleteHere(local, left.id);
    await failStuck(sender.db);
    await sender.messaging.resend(conv, left.id);
    expect(await mine()).toMatchObject({ id: left.id, status: 'sent' });
    await owner.messaging.sync();
    expect((await theirs()).map((m) => m.text)).toEqual(['hello']);
  });

  it('sends one that never went out, and a sticker, with their IDs, when asked', async () => {
    const { owner, sender, conv, mine, theirs } = await chat();
    // Stored as sending, then the app closed before they went out.
    const at = (await mine()).at;
    const [text, sticker] = [rand(), rand()];
    await addMessage(sender.db, { id: text, conv, at: at + 1000, out: true, status: 'sending' }, { text: 'lost on the way', replyTo: (await mine()).id });
    await addMessage(sender.db, { id: sticker, conv, at: at + 2000, out: true, status: 'sending' }, { text: '', sticker: { id: 'faces/winking_face' } });
    expect(await failStuck(sender.db)).toEqual([conv]);
    await sender.messaging.resend(conv, text);
    await sender.messaging.resend(conv, sticker);
    expect((await listMessages(sender.db, conv)).map((m) => [m.id, m.status])).toEqual([
      [expect.any(String), 'sent'],
      [text, 'sent'],
      [sticker, 'sent'],
    ]);
    expect(await owner.messaging.sync()).toBe(2);
    expect((await theirs()).slice(1)).toMatchObject([
      { id: text, text: 'lost on the way', replyTo: (await theirs())[0]!.id },
      { id: sticker, sticker: { id: 'faces/winking_face' } },
    ]);
  });

  withAndWithoutWebLocks('a send under way', () => {
    it('leaves one a copy of the app is sending as it is: a text, or an attachment uploading', async () => {
      await leavesOneUnderWay();
    });
  });

  async function leavesOneUnderWay() {
    const { backend, owner, sender, conv, mine, out } = await chat();
    const held = holdSends(backend);
    const sending = sender.messaging.send(conv, 'slow');
    await held.reached;
    expect(await failStuck(sender.db)).toEqual([]);
    expect(await mine()).toMatchObject({ text: 'slow', status: 'sending' });
    held.release();
    await sending;
    expect(await mine()).toMatchObject({ text: 'slow', status: 'sent' });

    const put = backend.transfer.put.bind(backend.transfer);
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      backend.transfer.put = (url, body, onProgress) => {
        resolve();
        return new Promise<void>((done) => (release = done)).then(() => put(url, body, onProgress));
      };
    });
    const uploading = sender.messaging.sendMedia(conv, out, 'a cat');
    await reached;
    expect(await failStuck(sender.db)).toEqual([]);
    expect(await mine()).toMatchObject({ text: 'a cat', status: 'sending' });
    release();
    await uploading;
    expect(await mine()).toMatchObject({ text: 'a cat', status: 'sent' });
    expect(await owner.messaging.sync()).toBe(2);
  }

  it('sends an uploaded attachment again with its fresh upload, nothing paid twice; a refusal of that keeps the upload', async () => {
    const c = await chat();
    const { backend, owner, sender, conv, local, mine, theirs, photo } = c;
    const failed = await failedPhoto(c);
    expect(canResend(failed, Date.now())).toBe(true);
    const mediaCalls = backend.mediaCalls.length;
    const mediaTokens = await countTokens(sender.db, backend.issuer.keyId, undefined, 'media');

    // Refused this time: that says nothing of the first try, which may have
    // arrived, so the upload stays, for that one and for the next try.
    failNextSend(backend, new ApiError(429, 'rate_limited'));
    await expect(sender.messaging.resend(conv, failed.id)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(await mine()).toMatchObject({ id: failed.id, status: 'failed', media: { id: failed.media!.id }, uploadedAt: failed.uploadedAt });
    await sender.messaging.flushUploadDeletes();
    expect(await pendingUploadDeletes(sender.db)).toEqual([]);
    expect(backend.uploads.size).toBe(1);

    await sender.messaging.resend(conv, failed.id);
    expect(backend.mediaCalls).toHaveLength(mediaCalls);
    expect(await countTokens(sender.db, backend.issuer.keyId, undefined, 'media')).toBe(mediaTokens);
    expect(await mine()).toMatchObject({ id: failed.id, status: 'sent', text: 'a cat', media: { id: failed.media!.id } });
    expect(await owner.messaging.sync()).toBe(1);
    const there = (await theirs()).at(-1)!;
    expect(there).toMatchObject({ id: failed.id, text: 'a cat', file: 'remote' });
    expect(await owner.messaging.fetchMedia(local, there.id)).toBe('local');
    expect(await getMedia(owner.db, local, there.id)).toEqual(photo);
  });

  it('uploads anew one whose upload may be gone: kept by an older version (no time kept), or older than 29 days', async () => {
    for (const uploadedAt of [undefined, Date.now() - UPLOAD_REUSE_MS - 1000]) {
      const c = await chat();
      const failed = await failedPhoto(c);
      // As an older version left it (it deleted some uploads but kept their
      // IDs), or uploaded long ago: gone from the bucket.
      expect(await patchMessage(c.sender.db, c.conv, failed.id, 'failed', { media: failed.media!, ...(uploadedAt !== undefined ? { uploadedAt } : {}) })).toBe(true);
      expect((await c.mine()).uploadedAt).toBe(uploadedAt);
      c.backend.uploads.clear();
      await c.sender.messaging.resend(c.conv, failed.id);
      const sent = await c.mine();
      expect(sent).toMatchObject({ id: failed.id, status: 'sent', text: 'a cat' });
      expect(sent.media!.id).not.toBe(failed.media!.id);
      expect(sent.uploadedAt).toBeGreaterThan(Date.now() - 60_000);
      expect(c.backend.uploads.size).toBe(1);
      await c.owner.messaging.sync();
      const there = (await c.theirs()).at(-1)!;
      expect(there.id).toBe(failed.id);
      expect(await c.owner.messaging.fetchMedia(c.local, there.id)).toBe('local');
      expect(await getMedia(c.owner.db, c.local, there.id)).toEqual(c.photo);
    }
  });

  it('offers to send one again only for 30 days after its first try, however often it was tried', async () => {
    const { backend, sender, conv } = await chat();
    const now = Date.now();
    const [old, retried, recent] = [rand(), rand(), rand()];
    await addMessage(sender.db, { id: old, conv, at: now - RESEND_WINDOW_MS - 1000, out: true, status: 'failed' }, { text: 'too old' });
    await addMessage(sender.db, { id: retried, conv, at: now - 1000, out: true, status: 'failed' }, { text: 'tried again lately', firstAt: now - RESEND_WINDOW_MS - 1000 });
    await addMessage(sender.db, { id: recent, conv, at: now - RESEND_WINDOW_MS + 60_000, out: true, status: 'failed' }, { text: 'just in time' });
    const byId = async (id: string) => (await getMessage(sender.db, conv, id))!;
    expect(canResend(await byId(old), now)).toBe(false);
    expect(canResend(await byId(retried), now)).toBe(false);
    expect(canResend(await byId(recent), now)).toBe(true);
    const sends = backend.sendPayments.length;
    await sender.messaging.resend(conv, old);
    await sender.messaging.resend(conv, retried);
    expect(backend.sendPayments).toHaveLength(sends);
    expect([(await byId(old)).status, (await byId(retried)).status]).toEqual(['failed', 'failed']);
    // Sent again, it keeps when it was first tried.
    await sender.messaging.resend(conv, recent);
    expect(await byId(recent)).toMatchObject({ status: 'sent', firstAt: now - RESEND_WINDOW_MS + 60_000 });
    expect(backend.sendPayments).toHaveLength(sends + 1);
  });

  it('counts the time to edit one sent again from its first try', async () => {
    const { sender, conv } = await chat();
    const id = rand();
    const first = Date.now() - 2 * 24 * 3600 * 1000;
    await addMessage(sender.db, { id, conv, at: first, out: true, status: 'failed' }, { text: 'two days ago' });
    await sender.messaging.resend(conv, id);
    expect(await getMessage(sender.db, conv, id)).toMatchObject({ status: 'sent', firstAt: first });
    await expect(sender.messaging.edit(conv, id, 'changed')).rejects.toThrow('too late to edit');
  });

  it('shows one taken for not sent as sent, or seen, once they show they had it', async () => {
    const { backend, owner, sender, conv, local, mine } = await chat();
    const request = backend.api.request;
    // Delivered, but the answer is lost: it shows as not sent.
    backend.api.request = async (method, path, init, check) => {
      if (method !== 'POST' || path !== '/send') return request(method, path, init, check);
      backend.api.request = request;
      await request(method, path, init, check);
      throw new NetworkError('answer lost');
    };
    await expect(sender.messaging.send(conv, 'arrived')).rejects.toThrow(NetworkError);
    expect(await mine()).toMatchObject({ text: 'arrived', status: 'failed' });
    await owner.messaging.sync();
    await owner.messaging.markSeen(local);
    await sender.messaging.sync();
    const seen = await mine();
    expect(seen).toMatchObject({ text: 'arrived', status: 'seen' });
    expect(canResend(seen, Date.now())).toBe(false);
  });
});

describe('envelopes that come again, or late', () => {
  // The inbox gives envelopes in no set order, a stale read can give one
  // already taken in, and a server can keep any and deliver it again. None
  // of that may undo what was done since: wipe later history, bring back
  // what was deleted, or move us back to an older key or mailbox.
  const HOUR = 3600 * 1000;

  /** A chat both sides have written in: 'hello' from the sender, 'hi' from the owner. */
  async function chat(clocks: { owner?: () => number; sender?: () => number } = {}) {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner', clocks.owner);
    const sender = await person(backend, 'sender', clocks.sender);
    // A link key a few hours old, so a sender whose clock runs behind can use it too.
    const record = await createLink(owner.db, owner.session, backend.api, () => Math.floor(Date.now() / 1000) - 3 * 3600);
    const ref: LinkRef = { id: record.id, fingerprint: record.fingerprint };
    const bundle = await backend.api.request('GET', `/links/${record.id}`, {}, checkBundle);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    await owner.messaging.send(mine, 'hi');
    await sender.messaging.sync();
    /** Delivers an envelope to someone again, through their mailbox for this chat (or another). */
    const again = async (to: 'owner' | 'sender', envelope: string, mailbox?: string) => {
      const c = to === 'owner' ? (await getConversation(owner.db, mine))! : (await getConversation(sender.db, conv))!;
      backend.inboxes.get(to)!.push({ id: rand(), mailbox: mailbox ?? c.myMailbox!, envelope });
    };
    const texts = async (who: 'owner' | 'sender') =>
      (await listMessages(who === 'owner' ? owner.db : sender.db, who === 'owner' ? mine : conv)).map((m) => m.text);
    /** The envelope sent last, by anyone. */
    const last = () => backend.seenEnvelopes.at(-1)!;
    return { backend, owner, sender, conv, mine, bundle, again, texts, last };
  }

  describe('a whole chat deleted for both sides', () => {
    it('delivered again after later messages, leaves them', async () => {
      const { owner, sender, conv, mine, again, texts, last } = await chat();
      await sender.messaging.remove(conv, true);
      const wipe = last();
      expect(await owner.messaging.sync()).toBe(1);
      expect(await texts('owner')).toEqual([]);
      await sender.messaging.send(conv, 'new start');
      await owner.messaging.sync();
      await owner.messaging.send(mine, 'welcome back');
      await sender.messaging.sync();

      await again('owner', wipe);
      expect(await owner.messaging.sync()).toBe(0);
      expect(await texts('owner')).toEqual(['new start', 'welcome back']);
      expect((await getConversation(owner.db, mine))!.hidden).toBe(false);
    });

    it('arriving after later messages from either side, leaves those', async () => {
      const { backend, owner, sender, conv, mine, texts } = await chat();
      await sender.messaging.remove(conv, true);
      await sender.messaging.send(conv, 'sorry, fresh start');
      // Before the owner has seen either, the owner writes too.
      await owner.messaging.send(mine, 'are you there?');
      // Their later message comes first.
      backend.inboxes.get('owner')!.reverse();
      await owner.messaging.sync();
      expect((await texts('owner')).sort()).toEqual(['are you there?', 'sorry, fresh start']);
      const c = (await getConversation(owner.db, mine))!;
      expect([c.hidden, c.unread]).toEqual([false, 1]);
      // Their side agrees: the owner's message written after it stays there too.
      await sender.messaging.sync();
      expect((await texts('sender')).sort()).toEqual(['are you there?', 'sorry, fresh start']);
    });

    it('when their clock runs ahead, what either side wrote after it stays', async () => {
      const base = Date.now();
      let tick = 0;
      const { backend, owner, sender, conv, mine, texts } = await chat({ owner: () => base + tick, sender: () => base + tick + 2 * HOUR });
      tick += 60_000;
      await sender.messaging.remove(conv, true);
      // A minute after it on the real clock (two hours before it on theirs), the owner writes...
      tick += 60_000;
      await owner.messaging.send(mine, 'still here?');
      // ...and so do they.
      tick += 60_000;
      await sender.messaging.send(conv, 'sorry');
      backend.inboxes.get('owner')!.reverse();
      await owner.messaging.sync();
      expect((await texts('owner')).sort()).toEqual(['sorry', 'still here?']);
    });

    it('when their clock runs behind, what they had of ours goes too, and what came after stays', async () => {
      const base = Date.now();
      let tick = 0;
      const { owner, sender, conv, mine, texts } = await chat({ owner: () => base + tick, sender: () => base + tick - 2 * HOUR });
      tick += 60_000;
      await owner.messaging.send(mine, 'did you get this?');
      await sender.messaging.sync();
      tick += 60_000;
      await sender.messaging.remove(conv, true);
      tick += 60_000;
      await owner.messaging.send(mine, 'after');
      await owner.messaging.sync();
      expect(await texts('owner')).toEqual(['after']);
      // Their side: the same.
      await sender.messaging.sync();
      expect(await texts('sender')).toEqual(['after']);
    });

    it("names the newest of the other side's messages it had, so their app takes exactly that much of its own", async () => {
      let clock = Date.now();
      const now = () => clock;
      const { owner, sender, conv, mine, texts } = await chat({ owner: now, sender: now });
      clock += 1000;
      await owner.messaging.send(mine, 'yours?');
      // The owner's newest envelope there is a reaction, not a message.
      clock += 1000;
      await owner.messaging.react(mine, (await listMessages(owner.db, mine))[0]!.id, '👍');
      await sender.messaging.sync();
      clock += 1000;
      await sender.messaging.remove(conv, true);
      clock += 1000;
      await owner.messaging.send(mine, 'after');
      await owner.messaging.sync();
      expect(await texts('owner')).toEqual(['after']);
    });

    it('from a sender before this version, a late receipt takes no more of ours than the delete names: a leftover, never a loss', async () => {
      let clock = Date.now();
      const now = () => clock;
      const { backend, owner, sender, conv, mine, texts } = await chat({ owner: now, sender: now });
      clock += 1000;
      await owner.messaging.send(mine, 'one');
      clock += 1000;
      await owner.messaging.send(mine, 'two');
      await sender.messaging.sync();
      // They read both, delete the second here only, then the whole chat for both.
      clock += 1000;
      await sender.messaging.markSeen(conv);
      await sender.messaging.deleteHere(conv, (await listMessages(sender.db, conv)).at(-1)!.id);
      // As a conversation from before the newest message taken in was kept:
      // the delete names 'one', their newest message from the owner left
      // there, and only the receipt shows they had 'two'.
      const { lastMessage: _, ...before } = (await getConversation(sender.db, conv))!;
      await putConversation(sender.db, before);
      clock += 1000;
      await sender.messaging.remove(conv, true);
      // The delete comes first, then the receipt that shows they had 'two'.
      backend.inboxes.get('owner')!.reverse();
      await owner.messaging.sync();
      // 'two' stays here, though they had it: nothing after what the delete names is taken.
      expect(await texts('owner')).toEqual(['two']);
      expect(await texts('sender')).toEqual([]);
    });

    it("a receipt from before it that comes after it takes what it shows they had, when the delete names none of ours", async () => {
      let clock = Date.now();
      const now = () => clock;
      const { backend, owner, sender, conv, mine, texts } = await chat({ owner: now, sender: now });
      clock += 1000;
      await owner.messaging.send(mine, 'one');
      await sender.messaging.sync();
      clock += 1000;
      await sender.messaging.markSeen(conv);
      // The owner's newest envelope there is a reaction.
      clock += 1000;
      await owner.messaging.react(mine, (await listMessages(owner.db, mine))[0]!.id, '👍');
      await sender.messaging.sync();
      // They delete the owner's messages here, then (as from before the newest
      // message was kept) the whole chat: its `last` names the reaction.
      for (const m of (await listMessages(sender.db, conv)).filter((m) => !m.out)) await sender.messaging.deleteHere(conv, m.id);
      const { lastMessage: _, ...before } = (await getConversation(sender.db, conv))!;
      await putConversation(sender.db, before);
      clock += 1000;
      await sender.messaging.remove(conv, true);
      backend.inboxes.get('owner')!.reverse();
      await owner.messaging.sync();
      expect(await texts('owner')).toEqual([]);
    });

    it('a message of ours on its way when they deleted stays on both sides, even after their clock is set back', async () => {
      const base = Date.now();
      let tick = 0;
      let skew = 2 * HOUR;
      const { backend, owner, sender, conv, mine, texts } = await chat({ owner: () => base + tick, sender: () => base + tick + skew });
      tick += 60_000;
      await owner.messaging.send(mine, 'inflight');
      const inflight = backend.inboxes.get('sender')!.pop()!;
      tick += 60_000;
      await sender.messaging.remove(conv, true);
      await owner.messaging.sync();
      expect(await texts('owner')).toEqual(['inflight']);
      // It reaches them after their delete: newer than the newest of ours they had, so they keep it.
      backend.inboxes.get('sender')!.push(inflight);
      await sender.messaging.sync();
      expect(await texts('sender')).toEqual(['inflight']);
      // Their clock is set right, and they open the chat: the receipt looks older than their delete.
      skew = 0;
      tick += 60_000;
      await sender.messaging.markSeen(conv);
      await owner.messaging.sync();
      expect(await texts('owner')).toEqual(['inflight']);
      expect(await texts('sender')).toEqual(['inflight']);
    });

    it('an older one taken in after a newer one changes nothing', async () => {
      let clock = Date.now();
      const now = () => clock;
      const { backend, owner, sender, conv, texts } = await chat({ owner: now, sender: now });
      clock += 1000;
      await sender.messaging.remove(conv, true);
      clock += 1000;
      await sender.messaging.send(conv, 'between');
      clock += 1000;
      await sender.messaging.remove(conv, true);
      clock += 1000;
      await sender.messaging.send(conv, 'after both');
      // The newest delete first, then the message after it, then the rest.
      const [first, between, second, after] = backend.inboxes.get('owner')!.splice(0);
      backend.inboxes.get('owner')!.push(second!, after!, first!, between!);
      await owner.messaging.sync();
      expect(await texts('owner')).toEqual(['after both']);
    });
  });

  describe('clocks set back, and both sides agreeing', () => {
    for (const named of ['one of ours', 'none of ours']) {
      it(`after their delete (naming ${named}) and their clock set back, what we write after taking the delete in stays`, async () => {
        const base = Date.now();
        let tick = 0;
        let skew = 2 * HOUR;
        const { owner, sender, conv, mine, texts } = await chat({ owner: () => base + tick, sender: () => base + tick + skew });
        // Their delete names 'hi'; deleted here, it names none of ours this side has.
        if (named === 'none of ours') await owner.messaging.deleteHere(mine, (await listMessages(owner.db, mine)).find((m) => m.out)!.id);
        tick += 60_000;
        await sender.messaging.remove(conv, true);
        await owner.messaging.sync();
        // Their clock is set right; everything of theirs is now dated before their delete.
        skew = 0;
        tick += 60_000;
        await owner.messaging.send(mine, 'still here');
        await sender.messaging.sync();
        tick += 60_000;
        // They open the chat: the receipt names the owner's new message.
        await sender.messaging.markSeen(conv);
        await owner.messaging.sync();
        expect(await texts('owner')).toEqual(['still here']);
        expect(await texts('sender')).toEqual(['still here']);
      });
    }

    it('after we delete the chat here and their clock is set back, both sides go on', async () => {
      const base = Date.now();
      let tick = 0;
      let skew = 2 * HOUR;
      const { owner, sender, conv, mine, texts } = await chat({ owner: () => base + tick, sender: () => base + tick + skew });
      tick += 60_000;
      await owner.messaging.remove(mine);
      skew = 0;
      tick += 60_000;
      await owner.messaging.send(mine, 'me again');
      await sender.messaging.sync();
      tick += 60_000;
      await sender.messaging.markSeen(conv);
      tick += 60_000;
      await sender.messaging.send(conv, 'you again');
      await owner.messaging.sync();
      expect(await texts('owner')).toEqual(['me again', 'you again']);
    });

    it('naming the newest of their messages ever taken in, both sides keep the same', async () => {
      let clock = Date.now();
      const now = () => clock;
      const step = () => (clock += 1000);
      const { backend, owner, sender, conv, mine, texts } = await chat({ owner: now, sender: now });
      step();
      await owner.messaging.send(mine, 'r1');
      // r1 is held up on its way.
      const r1 = backend.inboxes.get('sender')!.pop()!;
      step();
      await owner.messaging.send(mine, 'r2');
      await sender.messaging.sync();
      // They read r2, delete it on their side only, then the whole chat for both.
      step();
      await sender.messaging.markSeen(conv);
      await sender.messaging.deleteHere(conv, (await listMessages(sender.db, conv)).find((m) => m.text === 'r2')!.id);
      step();
      expect((await getConversation(sender.db, conv))!.lastMessage).toBeDefined();
      await sender.messaging.remove(conv, true);
      // Named in the delete, so no longer kept.
      expect((await getConversation(sender.db, conv))!.lastMessage).toBeUndefined();
      backend.inboxes.get('sender')!.push(r1);
      await sender.messaging.sync();
      await owner.messaging.sync();
      expect(await texts('sender')).toEqual([]);
      expect(await texts('owner')).toEqual([]);
    });

    it('naming their newest message they still have: not one they deleted for both sides', async () => {
      let clock = Date.now();
      const now = () => clock;
      const step = () => (clock += 1000);
      const { owner, sender, conv, mine, texts } = await chat({ owner: now, sender: now });
      step();
      await sender.messaging.send(conv, 'm2');
      step();
      await sender.messaging.send(conv, 'm3');
      // Taken in, not opened.
      await owner.messaging.sync();
      step();
      await sender.messaging.deleteForEveryone(conv, (await listMessages(sender.db, conv)).at(-1)!.id);
      await owner.messaging.sync();
      step();
      await owner.messaging.remove(mine, true);
      // Once sent, its ID and time aren't kept.
      expect((await getConversation(owner.db, mine))!.lastMessage).toBeUndefined();
      await sender.messaging.sync();
      expect(await texts('owner')).toEqual([]);
      expect(await texts('sender')).toEqual([]);
    });

    for (const forBoth of [false, true]) {
      it(`deleting the chat ${forBoth ? 'for both sides' : 'here'} keeps an edit waiting for a message still on its way`, async () => {
        let clock = Date.now();
        const now = () => clock;
        const step = () => (clock += 1000);
        const { backend, owner, sender, conv, mine, texts } = await chat({ owner: now, sender: now });
        step();
        await sender.messaging.send(conv, 'm5');
        const m5 = backend.inboxes.get('owner')!.pop()!;
        step();
        await sender.messaging.edit(conv, (await listMessages(sender.db, conv)).at(-1)!.id, 'm5 edited');
        await owner.messaging.sync();
        step();
        await owner.messaging.remove(mine, forBoth);
        backend.inboxes.get('owner')!.push(m5);
        await owner.messaging.sync();
        expect(await texts('owner')).toEqual(['m5 edited']);
        if (forBoth) {
          await sender.messaging.sync();
          expect(await texts('sender')).toEqual(['m5 edited']);
        }
      });
    }

    it('our delete for both sides after theirs keeps the later time it was cleared to', async () => {
      let clock = Date.now();
      const now = () => clock;
      const step = () => (clock += 1000);
      const { backend, owner, sender, conv, mine, texts } = await chat({ owner: now, sender: now });
      step();
      await sender.messaging.send(conv, 'm1');
      step();
      await sender.messaging.send(conv, 'm2');
      // m2 is held up on its way.
      const m2 = backend.inboxes.get('owner')!.pop()!;
      step();
      await sender.messaging.remove(conv, true);
      await owner.messaging.sync();
      step();
      await owner.messaging.remove(mine, true);
      // Sent before their delete: dropped, though it's newer than the newest of theirs we had.
      backend.inboxes.get('owner')!.push(m2);
      expect(await owner.messaging.sync()).toBe(0);
      expect(await texts('owner')).toEqual([]);
    });

    it('our delete for both sides leaves the chat in the list if something came meanwhile', async () => {
      let clock = Date.now();
      const now = () => clock;
      const { backend, owner, mine, texts } = await chat({ owner: now, sender: now });
      clock += 1000;
      const sending = holdSends(backend);
      const removing = owner.messaging.remove(mine, true);
      await sending.reached;
      // While its delete goes out, the owner writes again (from another copy of the app, say).
      clock += 1000;
      const writing = owner.messaging.send(mine, 'meanwhile');
      await waitingFor(`send:${mine}`);
      sending.release();
      await Promise.all([removing, writing]);
      expect(await texts('owner')).toEqual(['meanwhile']);
      expect((await getConversation(owner.db, mine))!.hidden).toBe(false);
    });
  });

  describe('a message deleted', () => {
    it("of ours, here, is remembered apart from theirs, and a reaction to it isn't kept for later", async () => {
      const { owner, sender, conv, mine } = await chat();
      await owner.messaging.send(mine, 'mine');
      await sender.messaging.sync();
      const m = (await listMessages(sender.db, conv)).at(-1)!;
      // Their reaction to it is on its way when the owner deletes it.
      await sender.messaging.react(conv, m.id, '👍');
      await owner.messaging.deleteHere(mine, m.id);
      await owner.messaging.sync();
      const ids = await getIds(owner.db, mine);
      expect([ids.dropped, ids.mine?.flatMap((d) => d.tags).length]).toEqual([undefined, 1]);
      expect((await getConversation(owner.db, mine))!.reactions ?? []).toEqual([]);
    });

    it('on this device, deleted twice at once (a double tap), counts once', async () => {
      const { owner, sender, conv, mine } = await chat();
      await sender.messaging.send(conv, 'x');
      await sender.messaging.send(conv, 'y');
      await owner.messaging.sync();
      expect((await getConversation(owner.db, mine))!.unread).toBe(3);
      const x = (await listMessages(owner.db, mine)).find((m) => m.text === 'x')!;
      await Promise.all([owner.messaging.deleteHere(mine, x.id), owner.messaging.deleteHere(mine, x.id)]);
      expect((await getConversation(owner.db, mine))!.unread).toBe(2);
    });

    it('for both sides stays deleted when it, an edit or a reaction comes again', async () => {
      const { owner, sender, conv, mine, again, texts, last } = await chat();
      await sender.messaging.send(conv, 'regret this');
      const regret = last();
      await owner.messaging.sync();
      const m = (await listMessages(sender.db, conv)).at(-1)!;
      await sender.messaging.edit(conv, m.id, 'regret this a lot');
      const edit = last();
      await sender.messaging.react(conv, m.id, '🔥');
      const reaction = last();
      expect(await owner.messaging.sync()).toBe(2);
      const record = (await sender.db.get('messages', [conv, m.id]))!;
      await sender.messaging.deleteForEveryone(conv, m.id);
      expect(await owner.messaging.sync()).toBe(1);
      expect(await texts('owner')).toEqual(['hello', 'hi']);

      for (const e of [edit, reaction, regret, edit]) await again('owner', e);
      expect(await owner.messaging.sync()).toBe(0);
      expect(await texts('owner')).toEqual(['hello', 'hi']);
      expect(await getPendingEdits(owner.db, mine)).toEqual([]);

      // A modified app editing or reacting to it afterwards: nothing comes back, nothing is kept for later.
      await sender.db.put('messages', record);
      await sender.messaging.edit(conv, m.id, 'back from the dead');
      await sender.messaging.react(conv, m.id, '😈');
      expect(await owner.messaging.sync()).toBe(0);
      expect(await texts('owner')).toEqual(['hello', 'hi']);
      expect(await getPendingEdits(owner.db, mine)).toEqual([]);
    });

    it('on this device only stays deleted when it comes again', async () => {
      const { owner, sender, conv, mine, again, texts, last } = await chat();
      await sender.messaging.send(conv, 'forget this');
      const env = last();
      await owner.messaging.sync();
      const m = (await listMessages(owner.db, mine)).at(-1)!;
      await owner.messaging.deleteHere(mine, m.id);
      expect(await texts('owner')).toEqual(['hello', 'hi']);
      await again('owner', env);
      expect(await owner.messaging.sync()).toBe(0);
      expect(await texts('owner')).toEqual(['hello', 'hi']);
      // Its tombstone alone is enough, with nothing remembered of having taken it in.
      await forgetIds(owner.db, mine, 'applied');
      await again('owner', env);
      expect(await owner.messaging.sync()).toBe(0);
      expect(await texts('owner')).toEqual(['hello', 'hi']);
      // And what's remembered of having taken it in alone, with the tombstone gone (past its cap, say).
      await forgetIds(owner.db, mine, 'dropped');
      await again('owner', env);
      expect(await owner.messaging.sync()).toBe(0);
      expect(await texts('owner')).toEqual(['hello', 'hi']);
      // The other side keeps theirs.
      expect(await texts('sender')).toEqual(['hello', 'hi', 'forget this']);
    });
  });

  describe('a deleted chat', () => {
    for (const forBoth of [false, true]) {
      it(`${forBoth ? 'for both sides' : 'on this device'} doesn't come back when its envelopes come again`, async () => {
        const { backend, owner, sender, conv, mine, bundle, again, texts, last } = await chat();
        const [hello, hi] = backend.seenEnvelopes.filter((_, i) => !backend.quietSends[i]);
        await sender.messaging.send(conv, 'later');
        const later = last();
        await owner.messaging.sync();
        await owner.messaging.remove(mine, forBoth);
        await sender.messaging.sync();

        // The first message again through the link, the later one through the owner's mailbox.
        await again('owner', hello!, bundle.mailbox);
        await again('owner', later);
        expect(await owner.messaging.sync()).toBe(0);
        expect(await texts('owner')).toEqual([]);
        expect((await listConversations(owner.db)).map((c) => [c.id, c.hidden])).toEqual([[mine, true]]);
        if (forBoth) {
          // Their side doesn't get the owner's reply back either.
          await again('sender', hi!);
          expect(await sender.messaging.sync()).toBe(0);
          expect(await texts('sender')).toEqual([]);
        }
        // Nor with nothing remembered of having taken them in: what was
        // deleted is cleared up to their newest message here.
        await forgetIds(owner.db, mine, 'applied');
        await again('owner', hello!, bundle.mailbox);
        await again('owner', later);
        expect(await owner.messaging.sync()).toBe(0);
        expect(await texts('owner')).toEqual([]);

        // Something new still brings it back, with only that.
        await sender.messaging.send(conv, 'still there?');
        expect(await owner.messaging.sync()).toBe(1);
        expect(await texts('owner')).toEqual(['still there?']);
        expect((await getConversation(owner.db, mine))!.hidden).toBe(false);
      });
    }
  });

  describe('which key and mailbox they use', () => {
    it("an older envelope taken in after a newer one doesn't move us back to their older key", async () => {
      let clock = Date.now();
      const now = () => clock;
      const { backend, owner, sender, conv, mine, again, last } = await chat({ owner: now, sender: now });
      clock += 1000;
      await owner.messaging.send(mine, 'one');
      const one = last();
      // Due for a new key: it comes with the next message.
      clock += 10 * DAY;
      await owner.messaging.send(mine, 'two');
      const after = (await getConversation(owner.db, mine))!;
      const two = (await listMessages(owner.db, mine)).at(-1)!;
      backend.inboxes.get('sender')!.reverse();
      expect(await sender.messaging.sync()).toBe(2);
      const c = (await getConversation(sender.db, conv))!;
      expect([c.peerKey, c.lastReceived]).toEqual([after.myKey, two.id]);
      // The older one again: still nothing changes.
      await again('sender', one);
      expect(await sender.messaging.sync()).toBe(0);
      expect(await getConversation(sender.db, conv)).toEqual(c);
    });

    it("an older envelope taken in after a newer one doesn't send us back to their older mailbox", async () => {
      let clock = Date.now();
      const now = () => clock;
      const { backend, owner, sender, conv, mine, texts } = await chat({ owner: now, sender: now });
      clock += 1000;
      await owner.messaging.send(mine, 'x');
      clock += 1000;
      await owner.messaging.block(mine);
      clock += 1000;
      await owner.messaging.unblock(mine);
      const moved = (await getConversation(owner.db, mine))!.myMailbox;
      // The key update telling them of the new mailbox comes before the older message.
      backend.inboxes.get('sender')!.reverse();
      await sender.messaging.sync();
      expect((await getConversation(sender.db, conv))!.sendTo).toBe(moved);
      await sender.messaging.send(conv, 'still here');
      expect(await owner.messaging.sync()).toBe(1);
      expect((await texts('owner')).slice(-2)).toEqual(['x', 'still here']);
    });
  });

  describe('edits', () => {
    it('an older edit never replaces a newer one, in whatever order they and the message come', async () => {
      let clock = Date.now();
      const now = () => clock;
      // One chat for all the orders, a message of its own for each: setting
      // up a chat is most of the time this takes (six took over 5 s in CI).
      const { backend, owner, sender, conv, mine } = await chat({ owner: now, sender: now });
      for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1]]) {
        clock += 1000;
        await sender.messaging.send(conv, 'helo');
        const m = (await listMessages(sender.db, conv)).at(-1)!;
        clock += 1000;
        await sender.messaging.edit(conv, m.id, 'hello');
        clock += 1000;
        await sender.messaging.edit(conv, m.id, 'hello there');
        const items = backend.inboxes.get('owner')!.splice(0);
        expect(items).toHaveLength(3);
        backend.inboxes.get('owner')!.push(...order.map((i) => items[i]!));
        await owner.messaging.sync();
        // Dated in whole seconds.
        expect(await getMessage(owner.db, mine, m.id)).toMatchObject({ text: 'hello there', edited: Math.floor(clock / 1000) * 1000 });
        expect(await getPendingEdits(owner.db, mine)).toEqual([]);
      }
    });
  });

  describe('two copies of the app', () => {
    it('a delete one took in, read again by the other from a stale inbox, wipes nothing newer', async () => {
      const { backend, owner, sender, conv, again, texts, last } = await chat();
      const tab = copyOf(backend, owner);
      await sender.messaging.remove(conv, true);
      const wipe = last();
      await owner.messaging.sync();
      await sender.messaging.send(conv, 'new start');
      const fresh = last();
      await owner.messaging.sync();
      // The other copy reads a page from before both were confirmed.
      await again('owner', wipe);
      await again('owner', fresh);
      expect(await tab.sync()).toBe(0);
      expect(await texts('owner')).toEqual(['new start']);
    });

    it('both taking in the same envelopes end where one would', async () => {
      let clock = Date.now();
      const now = () => clock;
      const { backend, owner, sender, conv, mine } = await chat({ owner: now, sender: now });
      const tab = copyOf(backend, owner, { now });
      const step = () => (clock += 1000);
      step();
      await sender.messaging.send(conv, 'a');
      step();
      await sender.messaging.send(conv, 'b');
      const [a, b] = (await listMessages(sender.db, conv)).slice(-2);
      step();
      await sender.messaging.react(conv, a!.id, '👍');
      step();
      await sender.messaging.edit(conv, a!.id, 'a!');
      step();
      await sender.messaging.deleteForEveryone(conv, b!.id);
      step();
      await owner.messaging.markSeen(mine);
      await sender.messaging.sync();
      step();
      await sender.messaging.send(conv, 'c');
      const items = [...backend.inboxes.get('owner')!];
      await owner.messaging.sync();
      const once = await state(owner.db);
      // The other copy gets the same items again, in another order.
      backend.inboxes.get('owner')!.push(...items.reverse().map((i) => ({ ...i, id: rand() })));
      expect(await tab.sync()).toBe(0);
      expect(await state(owner.db)).toEqual(once);
    });
  });

  describe('repeats as a matter of course', () => {
    /** What the device keeps, without the record of envelopes taken in. */
    async function apartFromApplied(db: Database) {
      const s = await state(db);
      return { ...s, chats: s.chats.map((c) => ({ ...c, ids: { ...c.ids, applied: undefined } })) };
    }
    /** Forgets which envelopes were taken in, as when the record let them go (it's capped) or another copy took them. */
    async function forgetApplied(db: Database, conv: string) {
      await forgetIds(db, conv, 'applied');
    }

    it('every kind taken in again changes nothing, whatever the order, even with no record of having taken it in', async () => {
      let clock = Date.now();
      const now = () => clock;
      const step = () => (clock += 1000);
      const { backend, owner, sender, conv, mine } = await chat({ owner: now, sender: now });
      step();
      await sender.messaging.send(conv, 'a');
      step();
      await sender.messaging.send(conv, 'b');
      const [a, b] = (await listMessages(sender.db, conv)).slice(-2);
      step();
      await sender.messaging.react(conv, a!.id, '👍');
      step();
      await sender.messaging.edit(conv, a!.id, 'a!');
      step();
      await sender.messaging.react(conv, a!.id, '😮');
      step();
      await sender.messaging.deleteForEveryone(conv, b!.id);
      step();
      await owner.messaging.send(mine, 'to you');
      await sender.messaging.sync();
      step();
      await sender.messaging.markSeen(conv);
      step();
      await sender.messaging.react(conv, (await listMessages(sender.db, conv)).at(-1)!.id, '❤️');
      const first = backend.inboxes.get('owner')!.splice(0);
      backend.inboxes.get('owner')!.push(...first);
      await owner.messaging.sync();
      const once = await apartFromApplied(owner.db);
      expect(once.chats[0]!.messages.slice(-2).map((m) => [m.text, m.reactions?.theirs?.e])).toEqual([
        ['a!', '😮'],
        ['to you', '❤️'],
      ]);
      expect(once.chats[0]!.messages.find((m) => m.text === 'to you')!.status).toBe('seen');

      await forgetApplied(owner.db, mine);
      backend.inboxes.get('owner')!.push(...[...first].reverse().map((i) => ({ ...i, id: rand() })));
      expect(await owner.messaging.sync()).toBe(0);
      expect(await apartFromApplied(owner.db)).toEqual(once);

      // Then the whole chat goes for both sides, and they start again.
      step();
      await sender.messaging.remove(conv, true);
      step();
      await sender.messaging.send(conv, 'c');
      const second = backend.inboxes.get('owner')!.splice(0);
      backend.inboxes.get('owner')!.push(...second);
      await owner.messaging.sync();
      const cleared = await apartFromApplied(owner.db);
      expect(cleared.chats[0]!.messages.map((m) => m.text)).toEqual(['c']);
      await forgetApplied(owner.db, mine);
      backend.inboxes.get('owner')!.push(...[...first, ...second].reverse().map((i) => ({ ...i, id: rand() })));
      expect(await owner.messaging.sync()).toBe(0);
      expect(await apartFromApplied(owner.db)).toEqual(cleared);
    });

    it('a reaction that comes before its message is shown once the message comes', async () => {
      const { backend, owner, sender, conv, mine, again, last } = await chat();
      await sender.messaging.send(conv, 'look');
      const look = (await listMessages(sender.db, conv)).at(-1)!;
      await sender.messaging.react(conv, look.id, '🔥');
      const reaction = last();
      backend.inboxes.get('owner')!.reverse();
      await owner.messaging.sync();
      expect((await getMessage(owner.db, mine, look.id))!.reactions?.theirs?.e).toBe('🔥');
      expect((await getConversation(owner.db, mine))!.reactions ?? []).toEqual([]);
      // Taken back, then the first one again: it stays taken back.
      await sender.messaging.react(conv, look.id, '');
      await owner.messaging.sync();
      await again('owner', reaction);
      expect(await owner.messaging.sync()).toBe(0);
      expect((await getMessage(owner.db, mine, look.id))!.reactions?.theirs?.e).toBe('');
    });

    it('a conversation from before the newest was kept starts from the last message it took in', async () => {
      let clock = Date.now();
      const now = () => clock;
      const { owner, sender, conv, mine, again, last } = await chat({ owner: now, sender: now });
      clock += 1000;
      await owner.messaging.react(mine, (await listMessages(owner.db, mine))[0]!.id, '👍');
      const old = last();
      clock += 10 * DAY;
      await owner.messaging.send(mine, 'with a new key');
      // The last envelope taken in is a reaction: older versions named that as lastReceived.
      clock += 1000;
      await owner.messaging.react(mine, (await listMessages(owner.db, mine))[0]!.id, '🎉');
      await sender.messaging.sync();
      const current = (await getConversation(owner.db, mine))!.myKey;
      const lastIn = (await getConversation(sender.db, conv))!.lastReceived;
      expect((await listMessages(sender.db, conv)).some((m) => m.id === lastIn)).toBe(false);
      expect((await getConversation(sender.db, conv))!.peerKey).toBe(current);
      // As an older version kept it: nothing about the newest, nothing about what was taken in.
      const { newest: _, ...before } = (await getConversation(sender.db, conv))!;
      await putConversation(sender.db, before);
      await forgetIds(sender.db, conv, 'applied');
      await again('sender', old);
      await sender.messaging.sync();
      expect((await getConversation(sender.db, conv))!.peerKey).toBe(current);
    });
  });

  describe('what is kept to tell', () => {
    it('is keyed hashes and days, never IDs or exact times, and goes once nothing it covers can still arrive', async () => {
      // On the hour, so everything below falls on one day, and after the
      // link's key starts: chat() makes it 3 to 14 hours before now, so
      // midday (as this used) came before it after 15:00 UTC, at random.
      let clock = Math.floor(Date.now() / HOUR) * HOUR;
      const now = () => clock;
      const { backend, owner, sender, conv, mine } = await chat({ owner: now, sender: now });
      clock += 1000;
      await sender.messaging.send(conv, 'one');
      clock += 1000;
      await sender.messaging.send(conv, 'two');
      clock += 1000;
      await sender.messaging.send(conv, 'three');
      await owner.messaging.sync();
      const ids = (await listMessages(sender.db, conv)).map((m) => m.id);
      const [one, two] = ids.slice(-3);
      clock += 1000;
      await sender.messaging.deleteForEveryone(conv, one!);
      await owner.messaging.sync();
      await owner.messaging.deleteHere(mine, two!);
      // A delete for one that hasn't come yet is kept the same way.
      clock += 1000;
      await sender.messaging.send(conv, 'four');
      const four = (await listMessages(sender.db, conv)).at(-1)!.id;
      await sender.messaging.deleteForEveryone(conv, four);
      backend.inboxes.get('owner')!.reverse();
      await owner.messaging.sync();
      await owner.messaging.remove(mine);
      // Then they delete the whole conversation for both sides too.
      clock += 1000;
      await sender.messaging.remove(conv, true);
      await owner.messaging.sync();

      const c = (await getConversation(owner.db, mine))!;
      const kept = await getIds(owner.db, mine);
      // Not on the conversation record, which the chat list reads every time.
      expect(Object.keys(c).filter((k) => ['applied', 'gone', 'dropped'].includes(k))).toEqual([]);
      const text = JSON.stringify({ kept, newest: c.newest });
      for (const id of [...ids, four]) expect(text).not.toContain(id);
      expect(c.deleted).toBeUndefined();
      for (const day of [...kept.applied!, ...kept.gone!, ...kept.dropped!]) {
        expect(Object.keys(day).sort()).toEqual(['day', 'tags']);
        expect(day.day).toBe(Math.floor(clock / DAY));
        for (const tag of day.tags) expect(tag).toMatch(/^[A-Za-z0-9_-]{12}$/);
      }
      // Theirs they deleted: 'one', and 'four' before it came. Deleted here: 'two', then 'hello' and 'three' with the chat; and ours, 'hi'.
      expect(kept.gone!.flatMap((d) => d.tags)).toHaveLength(2);
      expect(kept.dropped!.flatMap((d) => d.tags)).toHaveLength(3);
      expect(kept.mine!.flatMap((d) => d.tags)).toHaveLength(1);
      expect(c.theirClear).toEqual({ upTo: c.clearedBefore, here: clock });

      // Upkeep with nothing run out leaves the chat alone: it doesn't even take its lock.
      const locks = vi.spyOn(navigator.locks, 'request');
      await owner.messaging.maintain().catch(() => {});
      expect(locks.mock.calls.filter(([name]) => String(name).includes(':send:'))).toEqual([]);
      locks.mockRestore();

      // Once nothing they cover could still arrive, upkeep lets them go.
      clock += 31 * DAY;
      await owner.messaging.maintain().catch(() => {});
      expect(Object.keys(await getIds(owner.db, mine)).sort()).toEqual(['applied', 'dropped', 'gone', 'mine']);
      clock += 2 * DAY;
      await owner.messaging.maintain().catch(() => {});
      const after = (await getConversation(owner.db, mine))!;
      expect(await getIds(owner.db, mine)).toEqual({});
      expect([after.clearedBefore, after.theirClear, after.droppedBefore]).toEqual([undefined, undefined, undefined]);
    });
  });
});

describe('message times', () => {
  // Every envelope carries `at`. Dated by the device's own clock, to the
  // millisecond, it told recipients how far that clock is off, which lasts
  // for days and is the same in all of a person's conversations: recipients
  // comparing could link an anonymous sender to a known one. So it's the
  // server's clock as the device knows it, in whole seconds, and what comes
  // from the same second goes in the order it came.
  const S = Math.floor(Date.now() / 1000) * 1000;

  /**
   * A chat between an owner and a sender, with each one's clocks: the one
   * messages are dated by, and the device's own (the same if not given).
   * 'hello' from the sender is taken in.
   */
  async function chat(clocks: { owner: () => number; sender: () => number; ownerDevice?: () => number; senderDevice?: () => number }) {
    const backend = await fakeBackend();
    const o = await person(backend, 'owner', clocks.ownerDevice ?? clocks.owner);
    const s = await person(backend, 'sender', clocks.senderDevice ?? clocks.sender);
    const owner: Person = { ...o, messaging: o.open({ messageNow: clocks.owner }) };
    const sender: Person = { ...s, messaging: s.open({ messageNow: clocks.sender }) };
    // Made at S too: by the real clock, its key could start in an hour that
    // began after S (since this file loaded), and not be valid yet at S.
    const { ref, bundle } = await linkOf(backend, o, () => S / 1000);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    const texts = async (who: 'owner' | 'sender') =>
      (await listMessages(who === 'owner' ? owner.db : sender.db, who === 'owner' ? mine : conv)).map((m) => m.text);
    /**
     * Someone's app as one that doesn't date what it sends in a conversation
     * apart (a version before this one, or another app): the next thing it
     * sends there, with its clocks at `at`, carries the second it's in.
     */
    const unspaced = async (who: Person, conversation: string, at: number) => {
      // Forgets when it last sent something there (store.ts, takeSentAt).
      await deleteMeta(who.db, `sent-at:${conversation}`);
      return copyOf(backend, who, { now: () => at, messageNow: () => at });
    };
    return { backend, owner, sender, conv, mine, texts, unspaced };
  }

  it("dates everything it sends by the server's clock, in whole seconds, not by the device's", async () => {
    // The sender's device runs 23.4 seconds fast; it knows the server's
    // clock (from its session token) as 0.789 s into a second, and the
    // owner's as 0.3 s later.
    let server = S + 789;
    const { owner, sender, conv, mine, texts } = await chat({
      owner: () => server + 300,
      sender: () => server,
      senderDevice: () => server + 23_400,
    });
    const [hello] = await listMessages(owner.db, mine);
    expect([hello!.at, hello!.sent]).toEqual([S, undefined]);
    expect((await listMessages(sender.db, conv))[0]!.at).toBe(S);

    server += 2000;
    await owner.messaging.send(mine, 'hi');
    await sender.messaging.sync();
    const hi = (await listMessages(sender.db, conv)).find((m) => !m.out)!;
    await sender.messaging.markSeen(conv);
    server += 2000;
    await sender.messaging.react(conv, hi.id, '👍');
    server += 2000;
    await sender.messaging.edit(conv, hello!.id, 'hello!');
    await owner.messaging.sync();
    expect(await texts('owner')).toEqual(['hello!', 'hi']);
    const [edited, answered] = await listMessages(owner.db, mine);
    // The receipt, the reaction and the edit: each the server's whole second.
    expect(answered!.had).toBe(S + 2000);
    expect(answered!.reactions?.theirs).toEqual({ e: '👍', at: S + 4000 });
    expect(edited!.edited).toBe(S + 6000);
  });

  it('never dates two envelopes of its own in a conversation alike, so they keep their order', async () => {
    // The sender does everything in one second; the owner reads it later.
    const { backend, owner, sender, conv, texts } = await chat({ owner: () => S + 60_000, sender: () => S + 100 });
    // Each new message has an ID that sorts before the last.
    const ids = Array.from({ length: 3 }, rand).sort().reverse();
    for (const [i, text] of ['one', 'two', 'three'].entries()) {
      nextIds(ids[i]!);
      await sender.messaging.send(conv, text);
    }
    expect(await texts('sender')).toEqual(['hello', 'one', 'two', 'three']);
    // In one page, in any order.
    backend.inboxes.get('owner')!.reverse();
    await owner.messaging.sync();
    expect(await texts('owner')).toEqual(['hello', 'one', 'two', 'three']);
    // A second apart: run on from the second it's in, when need be.
    expect((await listMessages(sender.db, conv)).map((m) => m.at)).toEqual([S, S + 1000, S + 2000, S + 3000]);

    // A delete of the whole conversation, then a fresh start in the same second: that one stays.
    await sender.messaging.remove(conv, true);
    await sender.messaging.send(conv, 'fresh start');
    await owner.messaging.sync();
    expect(await texts('owner')).toEqual(['fresh start']);
    expect(await texts('sender')).toEqual(['fresh start']);
  });

  it('shows messages from the same second in the order they came or were written, and a reply after what it answers', async () => {
    // Both sides, all in one second, the devices' clocks too, to the
    // millisecond; the sender's app doesn't date its messages apart.
    const { owner, sender, conv, mine, texts, unspaced } = await chat({ owner: () => S + 500, sender: () => S + 100 });
    const [low, mid, high] = [rand(), rand(), rand()].sort();
    nextIds(high!);
    await (await unspaced(sender, conv, S + 100)).send(conv, 'first');
    await owner.messaging.sync();
    nextIds(mid!);
    await (await unspaced(sender, conv, S + 100)).send(conv, 'second');
    await owner.messaging.sync();
    expect(await texts('owner')).toEqual(['hello', 'first', 'second']);
    // The owner answers in that second too.
    nextIds(low!);
    await (await unspaced(owner, mine, S + 500)).send(mine, 'answer');
    expect(await texts('owner')).toEqual(['hello', 'first', 'second', 'answer']);
    await sender.messaging.sync();
    expect(await texts('sender')).toEqual(['hello', 'first', 'second', 'answer']);
    expect((await listMessages(owner.db, mine)).map((m) => m.at)).toEqual([S, S, S, S]);
    expect((await listMessages(sender.db, conv)).map((m) => m.at)).toEqual([S, S, S, S]);
  });

  it('shows a reply after what it answers, though the clock it was dated by is a little behind', async () => {
    // The owner knows the server's clock as four tenths of a second behind
    // the sender, across a second: 'hello' comes dated a second after the
    // owner's reply.
    const { owner, sender, conv, mine, texts } = await chat({ owner: () => S - 300, sender: () => S + 100 });
    await owner.messaging.send(mine, 'hi');
    await sender.messaging.sync();
    expect(await texts('sender')).toEqual(['hello', 'hi']);
    // At the time of what it answers, and taken in after it; sent by their clock.
    expect((await listMessages(sender.db, conv)).map((m) => [m.at, m.sent])).toEqual([
      [S, undefined],
      [S, S - 1000],
    ]);
  });

  it('shows what comes after a quick run of ours after it, though ours are dated ahead', async () => {
    // All in one second: the owner writes two (the second dated a second
    // ahead), and then the sender writes, dated a second after 'hello'.
    const { owner, sender, conv, mine, texts } = await chat({ owner: () => S + 100, sender: () => S + 100 });
    await owner.messaging.send(mine, 'one');
    await owner.messaging.send(mine, 'two');
    await sender.messaging.send(conv, 'three');
    await owner.messaging.sync();
    expect(await texts('owner')).toEqual(['hello', 'one', 'two', 'three']);
  });

  describe('a quick run more than a minute ahead', () => {
    // Seventy sends in a second are dated up to seventy seconds ahead of the
    // clock: past the minute after which the app used to take its clock to
    // have gone back, and dated what it sent next by the clock again, so it
    // showed among the run, on both sides.
    const run = async (who: Person, conversation: string, name: string, count = 70) => {
      const texts: string[] = [];
      for (let i = 0; i < count; i++) {
        texts.push(`${name} ${i}`);
        await who.messaging.send(conversation, `${name} ${i}`);
      }
      return texts;
    };

    it('dates what follows it after it, and both sides show that last', async () => {
      let clock = S + 100;
      const { owner, sender, conv, texts } = await chat({ owner: () => clock, sender: () => clock });
      const sent = ['hello', ...(await run(sender, conv, 'run')), 'one more'];
      await sender.messaging.send(conv, 'one more');
      // A second apart from 'hello' on, never back.
      expect((await listMessages(sender.db, conv)).map((m) => m.at)).toEqual(sent.map((_, i) => S + i * 1000));
      expect(await texts('sender')).toEqual(sent);
      // The owner takes them in five seconds later: those dated after that
      // second show in it, in the order they came.
      clock = S + 5100;
      await owner.messaging.sync();
      expect(await texts('owner')).toEqual(sent);
    }, 30_000);

    it('shows it in order to a receiver taking it in a second after each part was sent, and what follows last', async () => {
      let clock = S + 100;
      const { owner, sender, conv, texts } = await chat({ owner: () => clock, sender: () => clock });
      const sent = ['hello'];
      // Ten a second for eight seconds; the owner takes each second's in during the next.
      for (let second = 0; second < 8; second++) {
        sent.push(...(await run(sender, conv, `run ${second}`, 10)));
        clock += 1000;
        await owner.messaging.sync();
      }
      sent.push('one more');
      await sender.messaging.send(conv, 'one more');
      clock += 1000;
      await owner.messaging.sync();
      expect(await texts('owner')).toEqual(sent);
      expect(await texts('sender')).toEqual(sent);
    }, 30_000);

    it('keeps both sides in order when both write quick runs, and shows what each writes after them last', async () => {
      const { owner, sender, conv, mine, texts } = await chat({ owner: () => S + 100, sender: () => S + 100 });
      // In turns of ten, each side taking the other's in first: the same order on both sides.
      const sent = ['hello'];
      for (let turn = 0; turn < 7; turn++) {
        sent.push(...(await run(sender, conv, `sender ${turn}`, 10)));
        await owner.messaging.sync();
        sent.push(...(await run(owner, mine, `owner ${turn}`, 10)));
        await sender.messaging.sync();
      }
      expect(await texts('owner')).toEqual(sent);
      expect(await texts('sender')).toEqual(sent);
      // Then both at once, neither taking the other's in meanwhile: each
      // side's in the order written, on both sides.
      const theirs = await run(sender, conv, 'sender at once', 20);
      const ours = await run(owner, mine, 'owner at once', 20);
      await owner.messaging.sync();
      await sender.messaging.sync();
      for (const who of ['owner', 'sender'] as const) {
        const shown = (await texts(who)).slice(sent.length);
        expect(shown.filter((t) => t.startsWith('sender'))).toEqual(theirs);
        expect(shown.filter((t) => t.startsWith('owner'))).toEqual(ours);
      }
      // What each writes after taking the other's in shows last.
      await sender.messaging.send(conv, 'sender last');
      await owner.messaging.sync();
      await owner.messaging.send(mine, 'owner last');
      await sender.messaging.sync();
      expect((await texts('owner')).slice(-2)).toEqual(['sender last', 'owner last']);
      expect((await texts('sender')).slice(-2)).toEqual(['sender last', 'owner last']);
    }, 30_000);

    it('shows it in order to a receiver that takes it in later, in whatever order the inbox gives it', async () => {
      let clock = S + 100;
      const { backend, owner, sender, conv, texts } = await chat({ owner: () => clock, sender: () => clock });
      const sent = ['hello', ...(await run(sender, conv, 'run')), 'one more'];
      await sender.messaging.send(conv, 'one more');
      // The owner's app opens ten minutes later.
      clock = S + 600_100;
      backend.inboxes.get('owner')!.reverse();
      await owner.messaging.sync();
      expect(await texts('owner')).toEqual(sent);
    }, 30_000);

    it('deletes it for both sides, and dates what it writes next after the delete, so both sides keep that', async () => {
      const { owner, sender, conv, texts } = await chat({ owner: () => S + 100, sender: () => S + 100 });
      await run(sender, conv, 'run');
      await owner.messaging.sync();
      // Dated after the whole run (S + 71 s), it takes all of it, on both sides.
      await sender.messaging.remove(conv, true);
      // In the same second: a second after the delete, though that's more than a minute ahead.
      await sender.messaging.send(conv, 'fresh start');
      await owner.messaging.sync();
      expect(await texts('owner')).toEqual(['fresh start']);
      expect(await texts('sender')).toEqual(['fresh start']);
      expect((await listMessages(sender.db, conv))[0]!.at).toBe(S + 72_000);
    }, 30_000);

    it.each(['after a reload', 'from another copy of the app, open all along'] as const)(
      'dates what it writes after deleting the chat for both sides after it, after the delete, %s',
      async (how) => {
        let clock = S + 100;
        const { backend, owner, sender, conv, texts } = await chat({ owner: () => clock, sender: () => clock });
        const copy = copyOf(backend, sender, { now: () => clock, messageNow: () => clock });
        await run(sender, conv, 'run');
        await owner.messaging.sync();
        await sender.messaging.remove(conv, true);
        await owner.messaging.sync();
        // Five seconds on: the delete (S + 71 s) is still more than a minute ahead.
        clock = S + 5100;
        const app = how === 'after a reload' ? sender.open({ messageNow: () => clock }) : copy;
        await app.send(conv, 'fresh start');
        await owner.messaging.sync();
        expect(await texts('owner')).toEqual(['fresh start']);
        expect(await texts('sender')).toEqual(['fresh start']);
      },
      30_000,
    );

    it("is taken whole by the other side's delete for both sides, and what it writes next stays on both sides, after a reload too", async () => {
      let clock = S + 100;
      const { owner, sender, conv, mine, texts } = await chat({ owner: () => clock, sender: () => clock });
      await run(sender, conv, 'run');
      await owner.messaging.sync();
      await owner.messaging.remove(mine, true);
      await sender.messaging.sync();
      expect(await texts('owner')).toEqual([]);
      expect(await texts('sender')).toEqual([]);
      clock = S + 5100;
      await sender.messaging.send(conv, 'still there?');
      await sender.open({ messageNow: () => clock }).send(conv, 'after a reload');
      await owner.messaging.sync();
      expect(await texts('owner')).toEqual(['still there?', 'after a reload']);
      expect(await texts('sender')).toEqual(['still there?', 'after a reload']);
    }, 30_000);

    it('keeps the later of two edits sent after it', async () => {
      const { owner, sender, conv, mine } = await chat({ owner: () => S + 100, sender: () => S + 100 });
      await run(sender, conv, 'run', 59);
      const hello = (await listMessages(sender.db, conv)).find((m) => m.text === 'hello')!;
      await sender.messaging.edit(conv, hello.id, 'v1');
      await sender.messaging.edit(conv, hello.id, 'v2');
      await owner.messaging.sync();
      expect((await getMessage(owner.db, mine, hello.id))!.text).toBe('v2');
      expect((await getMessage(sender.db, conv, hello.id))!.text).toBe('v2');
    }, 30_000);

    it('still dates by the clock again once it went back a minute or more, or the run is ten minutes ahead', async () => {
      let clock = S + 100;
      const { owner, sender, conv, mine } = await chat({ owner: () => clock, sender: () => clock });
      const find = async (text: string) => (await listMessages(sender.db, conv)).find((m) => m.text === text)!;
      const at = async (text: string) => (await find(text)).at;
      await run(sender, conv, 'run');
      expect(await at('run 69')).toBe(S + 70_000);
      // The clock goes back 59 seconds: the run carries on.
      clock = S - 59_000 + 100;
      await sender.messaging.send(conv, 'a little back');
      expect(await at('a little back')).toBe(S + 71_000);
      // A minute back from the furthest it got (S): from the clock again.
      clock = S - 60_000 + 100;
      await sender.messaging.send(conv, 'a minute back');
      expect(await at('a minute back')).toBe(S - 60_000);

      // A run almost ten minutes ahead (599 more sends than seconds) carries
      // on once more, then the clock again.
      const T = S - 60_000;
      await putMeta(sender.db, `sent-at:${conv}`, T + 599_000);
      await putMeta(sender.db, `sent-clock:${conv}`, { at: T + 599_000, clock: T });
      await sender.messaging.send(conv, 'ten minutes ahead');
      await sender.messaging.send(conv, 'past it');
      expect([await at('ten minutes ahead'), await at('past it')]).toEqual([T + 600_000, T]);

      // A time kept by a version before this one, in another copy of the
      // app: it keeps no clock with it, and one kept with another time
      // doesn't count. As that version took it, the clock went back if it's
      // a minute ahead or more.
      for (const [ahead, dated] of [
        [59_000, T + 60_000],
        [60_000, T],
      ]) {
        await putMeta(sender.db, `sent-at:${conv}`, T + ahead!);
        await putMeta(sender.db, `sent-clock:${conv}`, { at: T + 1000, clock: T });
        await sender.messaging.send(conv, `${ahead} ahead`);
        expect(await at(`${ahead} ahead`)).toBe(dated);
      }
      await deleteMeta(sender.db, `sent-clock:${conv}`);
      await putMeta(sender.db, `sent-at:${conv}`, T + 60_000);
      await sender.messaging.send(conv, 'no clock');
      expect(await at('no clock')).toBe(T);

      // An edit the menu offers at the end of the window, from a run almost
      // ten minutes ahead: well within the hour's grace their app gives it.
      const hello = await find('hello');
      clock = S + DAY - 500;
      await putMeta(sender.db, `sent-at:${conv}`, S + DAY - 1000 + 599_000);
      await putMeta(sender.db, `sent-clock:${conv}`, { at: S + DAY - 1000 + 599_000, clock: S + DAY - 1000 });
      expect(editable(hello.at, clock)).toBe(true);
      await sender.messaging.edit(conv, hello.id, 'hello!');
      await owner.messaging.sync();
      expect(await getMessage(owner.db, mine, hello.id)).toMatchObject({ text: 'hello!', edited: S + DAY - 1000 + 600_000 });
    }, 30_000);
  });

  it.each(['reaction', 'edit', 'seen receipt'] as const)('shows a reply after ours though the newest of ours it names is our %s, not a message', async (kind) => {
    // Clocks alike, all in one second. The owner writes; the sender writes
    // two more, then sends the other envelope: dated a second apart, so
    // ahead. The owner's reply names that one as the newest of the sender's
    // it had (`last`).
    const { owner, sender, conv, mine, texts } = await chat({ owner: () => S + 100, sender: () => S + 100 });
    await owner.messaging.send(mine, 'hi');
    await sender.messaging.sync();
    await sender.messaging.send(conv, 'one');
    await sender.messaging.send(conv, 'two');
    const [hello] = await listMessages(sender.db, conv);
    if (kind === 'reaction') await sender.messaging.react(conv, hello!.id, '👍');
    if (kind === 'edit') await sender.messaging.edit(conv, hello!.id, 'hello!');
    if (kind === 'seen receipt') await sender.messaging.markSeen(conv);
    await owner.messaging.sync();
    await owner.messaging.send(mine, 'reply');
    await sender.messaging.sync();
    expect((await texts('sender')).slice(-3)).toEqual(['one', 'two', 'reply']);
    // At that one's time, though dated earlier by their clock.
    expect((await listMessages(sender.db, conv)).at(-1)).toMatchObject({ at: S + 3000, sent: S + 1000 });
  });

  it("shows a reply no later than it arrived, though it names one of ours dated further ahead", async () => {
    // The sender's clock was ten minutes fast when it wrote 'hello', and
    // then set right (more than a minute back: it dates from there again).
    let clock = S + 600_000 + 100;
    const { owner, sender, conv, mine, texts } = await chat({ owner: () => S + 100, sender: () => clock, senderDevice: () => S + 100 });
    clock = S + 100;
    // The reply names 'hello' (`last`); a modified app could name it in all it sends.
    await owner.messaging.send(mine, 'hi');
    await sender.messaging.sync();
    await sender.messaging.send(conv, 'after');
    const at = async (text: string) => (await listMessages(sender.db, conv)).find((m) => m.text === text)!.at;
    expect([await at('hello'), await at('hi'), await at('after')]).toEqual([S + 600_000, S, S]);
    // What the sender writes after it shows after it.
    expect(await texts('sender')).toEqual(['hi', 'after', 'hello']);
  });

  it('takes the later of two edits from the same second, here or not yet, and the same one again changes nothing', async () => {
    const { backend, owner, sender, conv, mine, unspaced } = await chat({ owner: () => S + 500, sender: () => S + 100 });
    const [hello] = await listMessages(sender.db, conv);
    // The owner's inbox as it is now (confirming replaces it).
    const inbox = () => backend.inboxes.get('owner')!;

    // The sender's app edits 'hello' twice in the same second.
    await (await unspaced(sender, conv, S + 100)).edit(conv, hello!.id, 'hello.');
    await owner.messaging.sync();
    await (await unspaced(sender, conv, S + 100)).edit(conv, hello!.id, 'hello!');
    const lastEdit = inbox()[0]!;
    await owner.messaging.sync();
    expect(await getMessage(owner.db, mine, hello!.id)).toMatchObject({ text: 'hello!', edited: S });

    // A message edited twice in its second, both edits arriving before it.
    await (await unspaced(sender, conv, S + 100)).send(conv, 'later');
    const later = (await listMessages(sender.db, conv)).at(-1)!;
    const message = inbox().splice(0);
    await (await unspaced(sender, conv, S + 100)).edit(conv, later.id, 'later.');
    await owner.messaging.sync();
    await (await unspaced(sender, conv, S + 100)).edit(conv, later.id, 'later!');
    await owner.messaging.sync();
    inbox().push(...message);
    await owner.messaging.sync();
    expect(await getMessage(owner.db, mine, later.id)).toMatchObject({ text: 'later!', edited: S });
    expect(await getPendingEdits(owner.db, mine)).toEqual([]);

    // The later edit of 'hello' again, with no record of having taken it in.
    await forgetIds(owner.db, mine, 'applied');
    const before = await listMessages(owner.db, mine);
    inbox().push({ ...lastEdit, id: rand() });
    expect(await owner.messaging.sync()).toBe(0);
    expect(await listMessages(owner.db, mine)).toEqual(before);
  });

  it('takes the later of two reactions from the same second, here or not yet', async () => {
    const { backend, owner, sender, conv, mine, unspaced } = await chat({ owner: () => S + 500, sender: () => S + 100 });
    const [hello] = await listMessages(sender.db, conv);

    // The owner's app reacts to 'hello' twice in the same second.
    await (await unspaced(owner, mine, S + 500)).react(mine, hello!.id, '👍');
    await sender.messaging.sync();
    await (await unspaced(owner, mine, S + 500)).react(mine, hello!.id, '❤️');
    await sender.messaging.sync();
    expect((await getMessage(sender.db, conv, hello!.id))!.reactions?.theirs).toEqual({ e: '❤️', at: S });

    // The sender reacts twice in a second to a message of its own that the
    // owner hasn't got yet.
    // The owner's inbox as it is now (confirming replaces it).
    const inbox = () => backend.inboxes.get('owner')!;
    await (await unspaced(sender, conv, S + 100)).send(conv, 'later');
    const later = (await listMessages(sender.db, conv)).at(-1)!;
    const message = inbox().splice(0);
    await (await unspaced(sender, conv, S + 100)).react(conv, later.id, '👍');
    await owner.messaging.sync();
    await (await unspaced(sender, conv, S + 100)).react(conv, later.id, '😮');
    await owner.messaging.sync();
    inbox().push(...message);
    await owner.messaging.sync();
    expect((await getMessage(owner.db, mine, later.id))!.reactions?.theirs).toEqual({ e: '😮', at: S });
    expect((await getConversation(owner.db, mine))!.reactions ?? []).toEqual([]);
  });

  it('dates what it sends in a conversation apart across reloads and copies of the app, unless its clock went back more than a minute', async () => {
    let clock = S + 100;
    const { backend, sender, conv } = await chat({ owner: () => S + 60_000, sender: () => clock });
    // The app opened again, and another copy of it, in the same second.
    await sender.open({ messageNow: () => clock }).send(conv, 'reopened');
    await copyOf(backend, sender, { now: () => clock, messageNow: () => clock }).send(conv, 'another copy');
    // A new session token puts the clock a second and a half back.
    clock = S - 1400;
    await sender.messaging.send(conv, 'a little back');
    // The device's clock set back by hours, beyond what a token could do: so are these.
    clock = S - 3 * 3600_000 + 100;
    await sender.messaging.send(conv, 'hours back');
    const at = async (text: string) => (await listMessages(sender.db, conv)).find((m) => m.text === text)!.at;
    expect(await Promise.all(['hello', 'reopened', 'another copy', 'a little back', 'hours back'].map(at))).toEqual([
      S,
      S + 1000,
      S + 2000,
      S + 3000,
      S - 3 * 3600_000,
    ]);
  });

  describe('and where the user first wrote', () => {
    const photo = () => {
      const file = crypto.getRandomValues(new Uint8Array(300));
      return { file, media: { t: 'photo', s: file.length, w: 3, h: 3, m: 'image/jpeg' } };
    };
    /** The owner's records of their photos, oldest first. */
    const photos = async (owner: Person, mine: string) => (await listRecords(owner.db, mine)).filter((m) => !m.out && m.file !== undefined);

    it('sent again, counts from where it was sent again: what came while it showed as not sent still waits', async () => {
      // Their clock a little ahead: their photo shows in the second the owner's reply was first written.
      const { backend, owner, sender, conv, mine } = await chat({ owner: () => S + 100, sender: () => S + 2100 });
      const request = backend.api.request;
      backend.api.request = async (method, path, init, check) => {
        if (method === 'POST' && path === '/send') {
          backend.api.request = request;
          throw new NetworkError('down');
        }
        return request(method, path, init, check);
      };
      await expect(owner.messaging.send(mine, 'stop')).rejects.toThrow(NetworkError);
      const failed = (await listRecords(owner.db, mine)).find((m) => m.out)!;
      expect(failed).toMatchObject({ status: 'failed', at: S });
      await sender.messaging.sendMedia(conv, photo());
      await owner.messaging.sync();

      await owner.messaging.resend(mine, failed.id);
      const sent = (await listRecords(owner.db, mine)).find((m) => m.out)!;
      expect(sent.status).toBe('sent');
      expect(sent.at).toBeGreaterThan(failed.at);
      expect(await answeredAt(owner.db, mine)).toEqual({ at: sent.at, order: sent.order ?? 0 });
      // The photo that came while it was "Not sent" waits; one after it doesn't.
      await sender.messaging.sendMedia(conv, photo());
      await owner.messaging.sync();
      const [during, after] = await photos(owner, mine);
      expect(during!.at).toBe(failed.at);
      const place = (await answeredAt(owner.db, mine))!;
      expect([comesAfter(during!, place), comesAfter(after!, place)]).toEqual([false, true]);
    });

    it('goes by where the chat shows what came after the reply: dated earlier, it waits unless it names the reply; sent earlier but dated ahead, it counts as after', async () => {
      let theirs = S + 100;
      const { backend, owner, sender, conv, mine } = await chat({ owner: () => S + 100, sender: () => theirs });
      // Sent before the owner's reply, dated ten minutes ahead (a fast clock), still in the owner's inbox.
      theirs = S + 10 * 60_000;
      await sender.messaging.sendMedia(conv, photo());
      // Sent before it too, dated three seconds back, by an app that doesn't date what it sends apart.
      const older = copyOf(backend, sender, { now: () => S - 3000, messageNow: () => S - 3000 });
      await deleteMeta(sender.db, `sent-at:${conv}`);
      await older.sendMedia(conv, photo());
      // The owner replies, then takes both in.
      await owner.messaging.send(mine, 'stop');
      const stop = (await listRecords(owner.db, mine)).find((m) => m.out)!;
      await owner.messaging.sync();
      // After the reply reached them, dated half a minute back by their clock, naming it as the newest of the owner's they had.
      await sender.messaging.sync();
      theirs = S - 30_000;
      await sender.messaging.sendMedia(conv, photo());
      await owner.messaging.sync();

      const place = (await answeredAt(owner.db, mine))!;
      expect(place).toEqual({ at: stop.at, order: stop.order ?? 0 });
      const [backdated, ahead, reply] = await photos(owner, mine);
      expect([backdated!.at, ahead!.at, reply!.at]).toEqual([S - 3000, stop.at, stop.at]);
      expect([backdated, ahead, reply].map((m) => comesAfter(m!, place))).toEqual([false, true, true]);
    });
  });

  it('forgets when it last sent something in a chat deleted here, and keeps only that time through a delete for both sides', async () => {
    const { owner, sender, conv, mine, texts } = await chat({ owner: () => S + 500, sender: () => S + 100 });
    const sentAt = (who: Person, c: string) => getMeta<number>(who.db, `sent-at:${c}`);
    await owner.messaging.send(mine, 'hi');
    expect([await sentAt(sender, conv), await sentAt(owner, mine)]).toEqual([S, S]);
    await owner.messaging.remove(mine);
    // Deleted here: none of it is kept (the time, how far the clock had got, the IDs and times of the last few things sent).
    for (const key of [`sent-at:${mine}`, `sent-ids:${mine}`, `sent-clock:${mine}`]) expect(await getMeta(owner.db, key)).toBeUndefined();

    await sender.messaging.send(conv, 'still there?');
    expect(await sentAt(sender, conv)).toBe(S + 1000);
    await sender.messaging.remove(conv, true);
    // Deleted for both sides: the delete's time stays (S + 2000), with the
    // clock, so what's sent there next is dated after it; the IDs don't.
    expect(await sentAt(sender, conv)).toBe(S + 2000);
    expect(await getMeta(sender.db, `sent-clock:${conv}`)).toEqual({ at: S + 2000, clock: S });
    expect(await getMeta(sender.db, `sent-ids:${conv}`)).toBeUndefined();
    // What it sends there next, in the same second, after a reload, is still dated after the delete, and stays.
    await sender.open({ messageNow: () => S + 100 }).send(conv, 'fresh start');
    expect((await listMessages(sender.db, conv)).map((m) => m.at)).toEqual([S + 3000]);
    await owner.messaging.sync();
    expect(await texts('owner')).toEqual(['fresh start']);
  });

  it('deletes a clock kept with a time last sent once an older version deleted that time', async () => {
    const { owner, sender, conv, mine } = await chat({ owner: () => S + 500, sender: () => S + 100 });
    await owner.messaging.send(mine, 'hi');
    // An older copy of the app forgets when the sender last sent there (its
    // chat deleted) without knowing of the clock; the owner's stays whole.
    await deleteMeta(sender.db, `sent-at:${conv}`);
    await deleteMeta(sender.db, `sent-ids:${conv}`);
    await sender.messaging.maintain();
    await owner.messaging.maintain();
    expect(await getMeta(sender.db, `sent-clock:${conv}`)).toBeUndefined();
    expect(await getMeta(owner.db, `sent-clock:${mine}`)).toEqual({ at: S, clock: S });
  });

  it('a delete of the whole chat for both sides takes all of ours they had, also ones dated a few seconds ahead', async () => {
    // The owner writes three in one second: dated a second apart, so ahead.
    const { owner, sender, conv, mine, texts } = await chat({ owner: () => S + 100, sender: () => S + 30_000 });
    for (const text of ['a', 'b', 'c']) await owner.messaging.send(mine, text);
    expect((await listMessages(owner.db, mine)).filter((m) => m.out).map((m) => m.at)).toEqual([S, S + 1000, S + 2000]);
    await sender.messaging.sync();
    await sender.messaging.markSeen(conv);
    await sender.messaging.remove(conv, true);
    // The owner takes it in still in that first second.
    await owner.messaging.sync();
    expect(await texts('owner')).toEqual([]);
    expect(await texts('sender')).toEqual([]);
  });

  it("offers an edit in the menu exactly while the engine takes it, a quick run of sends or not", async () => {
    let clock = S + 100;
    const { sender, conv } = await chat({ owner: () => S + 60_000, sender: () => clock });
    const [hello] = await listMessages(sender.db, conv);
    // Nearly a day on, two quick sends date what follows a second ahead.
    clock = S + DAY - 500;
    await sender.messaging.send(conv, 'one');
    await sender.messaging.send(conv, 'two');
    expect(editable(hello!.at, clock)).toBe(true);
    await sender.messaging.edit(conv, hello!.id, 'hello!');
    clock = S + DAY + 1000;
    expect(editable(hello!.at, clock)).toBe(false);
    await expect(sender.messaging.edit(conv, hello!.id, 'hello!!')).rejects.toThrow('too late to edit');
    expect((await getMessage(sender.db, conv, hello!.id))!.text).toBe('hello!');
  });

  it('keeps messages dated to the millisecond by older versions, and goes on from them', async () => {
    // Each step ten seconds on; the owner's clock two seconds ahead.
    let t = S + 123;
    const step = () => (t += 10_000);
    older.ms = true;
    const { owner, sender, conv, mine, texts } = await chat({ owner: () => t + 2000, sender: () => t });
    const [hello] = await listMessages(sender.db, conv);
    expect(hello!.at).toBe(S + 123);
    step();
    await sender.messaging.react(conv, hello!.id, '👍');
    await owner.messaging.sync();
    expect((await getMessage(owner.db, mine, hello!.id))!.reactions?.theirs).toEqual({ e: '👍', at: S + 10_123 });
    // As the older version stored them: with no order among those from the same time.
    for (const db of [owner.db, sender.db]) {
      for (const { order: _, ...m } of await db.getAll('messages')) await db.put('messages', m);
    }

    // Updated: whole seconds from here on.
    older.ms = false;
    step();
    await owner.messaging.send(mine, 'hi');
    step();
    await sender.messaging.sync();
    await sender.messaging.edit(conv, hello!.id, 'hello!');
    await sender.messaging.react(conv, hello!.id, '❤️');
    await sender.messaging.send(conv, 'and you?');
    step();
    await owner.messaging.sync();
    expect(await texts('owner')).toEqual(['hello!', 'hi', 'and you?']);
    expect(await texts('sender')).toEqual(['hello!', 'hi', 'and you?']);
    const there = (await getMessage(owner.db, mine, hello!.id))!;
    expect([there.at, there.edited, there.reactions?.theirs]).toEqual([S + 123, S + 30_000, { e: '❤️', at: S + 31_000 }]);
    expect((await listMessages(owner.db, mine)).map((m) => m.at)).toEqual([S + 123, S + 22_000, S + 32_000]);
  });
});

describe('someone with the link flooding the owner', () => {
  it('an edit, reaction or delete before any message starts no conversation: it waits aside for the message', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'helo');
    const [hello] = await listMessages(sender.db, conv);
    await sender.messaging.edit(conv, hello!.id, 'hello');
    await sender.messaging.react(conv, hello!.id, '🔥');
    // Their message is still on its way: only what came after it is here.
    const first = backend.inboxes.get('owner')!.shift()!;
    expect(await owner.messaging.sync()).toBe(0);
    expect(await listConversations(owner.db)).toEqual([]);
    const { wire, myKey } = (await getConversation(sender.db, conv))!;
    expect(await earlyFor(owner.db, ref.id, wire, myKey!, 0)).toHaveLength(2);
    // It comes: the conversation starts, edited and reacted to, and nothing is kept aside any more.
    backend.inboxes.get('owner')!.push(first);
    expect(await owner.messaging.sync()).toBe(1);
    const mine = await across(sender.db, conv, owner.db);
    expect(await listMessages(owner.db, mine)).toMatchObject([{ text: 'hello', edited: expect.any(Number), reactions: { theirs: { e: '🔥' } } }]);
    expect(await getConversation(owner.db, mine)).toMatchObject({ hidden: false, unread: 1 });
    expect(await lastShown(owner.db, (await getConversation(owner.db, mine))!)).toEqual({ out: false, text: 'hello' });
    expect(await earlyFor(owner.db, ref.id, wire, myKey!, 0)).toEqual([]);

    // A delete that came alone first: the message is dropped when it comes, and shows nowhere.
    const oops = await sender.messaging.startConversation(ref, bundle, 'oops');
    await sender.messaging.deleteForEveryone(oops, (await listMessages(sender.db, oops))[0]!.id);
    const message = backend.inboxes.get('owner')!.shift()!;
    expect(await owner.messaging.sync()).toBe(0);
    expect(await listConversations(owner.db)).toHaveLength(1);
    backend.inboxes.get('owner')!.push(message);
    expect(await owner.messaging.sync()).toBe(0);
    const dropped = await across(sender.db, oops, owner.db);
    expect(await getConversation(owner.db, dropped)).toMatchObject({ hidden: true, lastAt: 0, unread: 0 });
    expect(await listMessages(owner.db, dropped)).toEqual([]);
  });

  it('keeps few envelopes aside, small, and not for long, however many come', async () => {
    let clock = Date.now();
    const now = () => clock;
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner', now);
    const sender = await person(backend, 'sender', now);
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'x');
    const [m] = await listMessages(sender.db, conv);
    // The message never comes; edits of it do, many and long.
    backend.inboxes.get('owner')!.length = 0;
    for (let i = 0; i < MAX_EARLY + 10; i++) {
      clock += 1;
      await sender.messaging.edit(conv, m!.id, `edit ${i}`);
    }
    expect(await owner.messaging.sync()).toBe(0);
    const { wire, myKey } = (await getConversation(sender.db, conv))!;
    const kept = await earlyFor(owner.db, ref.id, wire, myKey!, 0);
    expect(kept.map((e) => e.edit!.text)).toEqual(Array.from({ length: MAX_EARLY }, (_, i) => `edit ${i + 10}`));
    for (let i = 0; i < 10; i++) {
      clock += 1;
      await sender.messaging.edit(conv, m!.id, 'y'.repeat(MAX_TEXT_BYTES - i));
    }
    await owner.messaging.sync();
    const big = await earlyFor(owner.db, ref.id, wire, myKey!, 0);
    expect(new TextEncoder().encode(JSON.stringify(big)).length).toBeLessThanOrEqual(MAX_EARLY_BYTES);
    expect(big.at(-1)!.edit!.text).toBe('y'.repeat(MAX_TEXT_BYTES - 9));
    // No conversation, hidden or not.
    expect(await listConversations(owner.db)).toEqual([]);
    // Forgotten once the message they wait for can no longer come.
    clock += 32 * DAY;
    await owner.messaging.maintain().catch(() => {});
    expect(await earlyFor(owner.db, ref.id, wire, myKey!, 0)).toEqual([]);
    expect(await owner.db.get('meta', 'early-envelopes')).toBeUndefined();
  });

  it("keeps a conversation's edits for messages still on their way apart from it: the newest 20, and 64 KB", async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    const count = MAX_PENDING_EDITS + 5;
    for (let i = 0; i < count; i++) await sender.messaging.send(conv, `m${i}`);
    const sent = (await listMessages(sender.db, conv)).slice(1);
    for (const [i, m] of sent.entries()) await sender.messaging.edit(conv, m.id, `edited ${i}`);
    // The messages are still on their way; their edits are here.
    const messages = backend.inboxes.get('owner')!.splice(0, count);
    await owner.messaging.sync();
    expect(await getPendingEdits(owner.db, mine)).toHaveLength(MAX_PENDING_EDITS);
    expect(await getConversation(owner.db, mine)).not.toHaveProperty('edits');
    // They come: the newest 20 show edited.
    backend.inboxes.get('owner')!.push(...messages);
    await owner.messaging.sync();
    expect((await listMessages(owner.db, mine)).map((m) => m.text)).toEqual([
      'hello',
      ...Array.from({ length: 5 }, (_, i) => `m${i}`),
      ...Array.from({ length: MAX_PENDING_EDITS }, (_, i) => `edited ${i + 5}`),
    ]);
    expect(await getPendingEdits(owner.db, mine)).toEqual([]);

    // Long ones: as many as fit.
    for (let i = 0; i < 8; i++) await sender.messaging.send(conv, `long ${i}`);
    const longs = (await listMessages(sender.db, conv)).slice(-8);
    for (const m of longs) await sender.messaging.edit(conv, m.id, 'z'.repeat(MAX_TEXT_BYTES));
    backend.inboxes.get('owner')!.splice(0, 8);
    await owner.messaging.sync();
    const pending = await getPendingEdits(owner.db, mine);
    expect(pending.map((e) => e.id)).toEqual(longs.slice(-5).map((m) => m.id));
    expect(pending.reduce((n, e) => n + e.sealed.length, 0)).toBeLessThanOrEqual(MAX_PENDING_EDIT_BYTES);
  });

  it('a hidden chat never opened goes after 31 days; one opened and deleted here stays', async () => {
    let clock = Date.now();
    const now = () => clock;
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner', now);
    const sender = await person(backend, 'sender', now);
    const other = await person(backend, 'other', now);
    const { ref, bundle } = await linkOf(backend, owner);
    // Started by a message they deleted before it came.
    const oops = await sender.messaging.startConversation(ref, bundle, 'oops');
    await sender.messaging.deleteForEveryone(oops, (await listMessages(sender.db, oops))[0]!.id);
    backend.inboxes.get('owner')!.reverse();
    await owner.messaging.sync();
    const empty = await across(sender.db, oops, owner.db);
    // One the owner opened and deleted here: kept, keys and mailbox, so it
    // can come back. Opened is all it takes (no "seen" went out: the app was
    // in the background, say).
    const chat = await other.messaging.startConversation(ref, bundle, 'hi');
    await owner.messaging.sync();
    const deleted = await across(other.db, chat, owner.db);
    await owner.messaging.markRead(deleted);
    expect(await getConversation(owner.db, deleted)).toMatchObject({ opened: true, myKey: null });
    await owner.messaging.remove(deleted);
    // One an older version started with an edit, without the time of what came.
    const { newest: _, ...older } = (await getConversation(owner.db, empty))!;
    await putConversation(owner.db, { ...older, id: 'from-before', wire: 'from-before' });
    expect((await listConversations(owner.db)).filter((c) => c.hidden).length).toBe(3);
    // A time for those that a clock running ahead set: from now instead.
    await putMeta(owner.db, 'empty-chats-since', clock + 300 * DAY);

    clock += 30 * DAY;
    await owner.messaging.maintain().catch(() => {});
    expect((await listConversations(owner.db)).map((c) => c.id).sort()).toEqual([deleted, empty, 'from-before'].sort());
    clock += 2 * DAY;
    await owner.messaging.maintain().catch(() => {});
    expect((await listConversations(owner.db)).map((c) => c.id).sort()).toEqual([deleted, 'from-before'].sort());
    // Nothing kept for it is left.
    expect(await getIds(owner.db, empty)).toEqual({});
    expect((await owner.db.getAllKeys('meta')).filter((k) => String(k).includes(empty))).toEqual([]);
    // The older one: 31 days and a day from when upkeep first found it.
    clock += 29 * DAY;
    await owner.messaging.maintain().catch(() => {});
    expect((await listConversations(owner.db)).map((c) => c.id).sort()).toEqual([deleted, 'from-before'].sort());
    clock += 2 * DAY;
    await owner.messaging.maintain().catch(() => {});
    expect((await listConversations(owner.db)).map((c) => c.id)).toEqual([deleted]);
    // The deleted chat still comes back when they write.
    await other.messaging.send(chat, 'still there?');
    expect(await owner.messaging.sync()).toBe(1);
    expect(await getConversation(owner.db, deleted)).toMatchObject({ hidden: false });
  });

  it('a chat a sender wrote in and then cleared for both sides, never opened, goes too', async () => {
    let clock = Date.now();
    const now = () => clock;
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner', now);
    const sender = await person(backend, 'sender', now);
    const { ref, bundle } = await linkOf(backend, owner);
    const chats: string[] = [];
    for (let i = 0; i < 3; i++) {
      clock += 1000;
      const conv = await sender.messaging.startConversation(ref, bundle, `hello ${i}`);
      clock += 1000;
      await sender.messaging.remove(conv, true);
      await owner.messaging.sync();
      chats.push(await across(sender.db, conv, owner.db));
    }
    for (const id of chats) {
      expect(await getConversation(owner.db, id)).toMatchObject({ hidden: true, myKey: null, myMailbox: null });
      expect((await getConversation(owner.db, id))!.lastAt).toBeGreaterThan(0);
    }
    // One the owner blocked stays (its sender tag is what blocks the person).
    await owner.messaging.block(chats[2]!);
    clock += 30 * DAY;
    await owner.messaging.maintain().catch(() => {});
    expect((await listConversations(owner.db)).map((c) => c.id).sort()).toEqual([...chats].sort());
    clock += 2 * DAY;
    await owner.messaging.maintain().catch(() => {});
    expect((await listConversations(owner.db)).map((c) => c.id)).toEqual([chats[2]]);
    clock += 400 * DAY;
    await owner.messaging.maintain().catch(() => {});
    expect((await listConversations(owner.db)).map((c) => c.id)).toEqual([chats[2]]);
  });

  it("drops the edits waiting in a chat we never answered when it's deleted or blocked", async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const waiting = async () => {
      const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
      await owner.messaging.sync();
      await sender.messaging.send(conv, 'helo');
      await sender.messaging.edit(conv, (await listMessages(sender.db, conv)).at(-1)!.id, 'hello again');
      // The message is still on its way; its edit is here.
      backend.inboxes.get('owner')!.shift();
      await owner.messaging.sync();
      const mine = await across(sender.db, conv, owner.db);
      expect(await getPendingEdits(owner.db, mine)).toHaveLength(1);
      expect(await owner.db.get('meta', 'edits-unanswered')).toMatchObject([{ conv: mine }]);
      return mine;
    };
    const deleted = await waiting();
    await owner.messaging.remove(deleted);
    expect(await getPendingEdits(owner.db, deleted)).toEqual([]);
    expect(await owner.db.get('meta', 'edits-unanswered')).toBeUndefined();
    const blocked = await waiting();
    await owner.messaging.block(blocked);
    expect(await getPendingEdits(owner.db, blocked)).toEqual([]);
    expect(await owner.db.get('meta', 'edits-unanswered')).toBeUndefined();
  });

  it("a chat's edits for messages on their way stay once we answer it, whatever other chats' come", async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const { ref, bundle } = await linkOf(backend, owner);
    /** Someone writes through the link; then an edit of a message still on its way. */
    const waiting = async (name: string, edits: number, text: (i: number) => string) => {
      const who = await person(backend, name);
      const conv = await who.messaging.startConversation(ref, bundle, 'hello');
      await owner.messaging.sync();
      const held = [];
      for (let i = 0; i < edits; i++) {
        await who.messaging.send(conv, `message ${i}`);
        held.push(backend.inboxes.get('owner')!.pop()!);
        await who.messaging.edit(conv, (await listMessages(who.db, conv)).at(-1)!.id, text(i));
      }
      await owner.messaging.sync();
      return { mine: await across(who.db, conv, owner.db), held };
    };
    const a = await waiting('a', 1, () => 'edited');
    expect(await getPendingEdits(owner.db, a.mine)).toHaveLength(1);
    // The owner answers: from now on 'a' doesn't share the budget.
    await owner.messaging.send(a.mine, 'hi');
    // Others' fill it, past it: theirs go, the oldest first; never the answered one's.
    const b = await waiting('b', 6, () => 'b'.repeat(MAX_TEXT_BYTES));
    const c = await waiting('c', 1, () => 'c'.repeat(MAX_TEXT_BYTES));
    expect(await getPendingEdits(owner.db, a.mine)).toHaveLength(1);
    expect(await getPendingEdits(owner.db, b.mine)).toEqual([]);
    expect(await getPendingEdits(owner.db, c.mine)).toHaveLength(1);
    // And it applies when its message comes.
    backend.inboxes.get('owner')!.push(...a.held);
    await owner.messaging.sync();
    expect((await listMessages(owner.db, a.mine)).map((m) => m.text)).toContain('edited');
  });

  it('takes in what was kept aside on the next sync if taking it in failed halfway', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'helo');
    await sender.messaging.edit(conv, (await listMessages(sender.db, conv))[0]!.id, 'hello');
    const first = backend.inboxes.get('owner')!.shift()!;
    // Someone else's is kept aside too, for a message that never comes.
    const other = await person(backend, 'other');
    const theirs = await other.messaging.startConversation(ref, bundle, 'x');
    await other.messaging.edit(theirs, (await listMessages(other.db, theirs))[0]!.id, 'y');
    backend.inboxes.get('owner')!.splice(-2, 1);
    await owner.messaging.sync();
    // The message comes; the app closes after its conversation started, before it's taken in.
    backend.inboxes.get('owner')!.push(first);
    storage.closeAt = 'early-envelopes';
    await expect(owner.messaging.sync()).rejects.toThrow();
    const mine = await across(sender.db, conv, owner.db);
    expect(await listMessages(owner.db, mine)).toEqual([]);
    // Next time, through the conversation found: the edit first, then the message.
    expect(await owner.messaging.sync()).toBe(1);
    expect(await listMessages(owner.db, mine)).toMatchObject([{ text: 'hello', edited: expect.any(Number) }]);
    const { wire, myKey } = (await getConversation(sender.db, conv))!;
    expect(await earlyFor(owner.db, ref.id, wire, myKey!, 0)).toEqual([]);
  });

  it('keeps the preview of each chat in step: sent, received, edited, deleted', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const sender = await person(backend, 'sender');
    const { ref, bundle } = await linkOf(backend, owner);
    const conv = await sender.messaging.startConversation(ref, bundle, 'hello');
    await owner.messaging.sync();
    const mine = await across(sender.db, conv, owner.db);
    const shown = async () => {
      const c = (await getConversation(owner.db, mine))!;
      // Kept on the record, so the list needn't make it.
      expect(c.preview).toBeTruthy();
      return lastShown(owner.db, c);
    };
    expect(await shown()).toEqual({ out: false, text: 'hello' });
    await owner.messaging.send(mine, 'hi bak');
    expect(await shown()).toEqual({ out: true, text: 'hi bak', status: 'sent' });
    const reply = (await listMessages(owner.db, mine)).at(-1)!;
    await owner.messaging.edit(mine, reply.id, 'hi back');
    expect(await shown()).toEqual({ out: true, text: 'hi back', status: 'sent' });
    await sender.messaging.sync();
    await sender.messaging.markSeen(conv);
    await owner.messaging.sync();
    expect(await shown()).toEqual({ out: true, text: 'hi back', status: 'seen' });
    // Theirs, edited and deleted.
    await sender.messaging.send(conv, 'one mor');
    await owner.messaging.sync();
    const one = (await listMessages(sender.db, conv)).at(-1)!;
    await sender.messaging.edit(conv, one.id, 'one more');
    await owner.messaging.sync();
    expect(await shown()).toEqual({ out: false, text: 'one more' });
    await sender.messaging.deleteForEveryone(conv, one.id);
    await owner.messaging.sync();
    expect(await shown()).toEqual({ out: true, text: 'hi back', status: 'seen' });
    await owner.messaging.deleteHere(mine, reply.id);
    expect(await shown()).toEqual({ out: false, text: 'hello' });
    await owner.messaging.remove(mine);
    expect((await getConversation(owner.db, mine))!.preview).toBeNull();
  });
});

describe("a chat's own name in upkeep", () => {
  it('goes from a chat in neither list (a delete that stopped when the app closed); stays on one in a list or in Blocked', async () => {
    const backend = await fakeBackend();
    const owner = await person(backend, 'owner');
    const { ref, bundle } = await linkOf(backend, owner);
    const ids: string[] = [];
    for (const who of ['a', 'b', 'c']) {
      const sender = await person(backend, who);
      await sender.messaging.startConversation(ref, bundle, `hello from ${who}`);
    }
    await owner.messaging.sync();
    for (const c of await listConversations(owner.db)) ids.push(c.id);
    expect(ids).toHaveLength(3);
    const [deleted, listed, blocked] = ids as [string, string, string];
    const name = async (id: string) => sealChatName(owner.db, id, { name: 'Alex' });
    // Opened (so upkeep keeps the record), named; one deleted and not blocked, one in the list, one blocked and deleted.
    await putConversation(owner.db, { ...(await getConversation(owner.db, deleted))!, opened: true, hidden: true, custom: await name(deleted) });
    await putConversation(owner.db, { ...(await getConversation(owner.db, listed))!, opened: true, custom: await name(listed) });
    await putConversation(owner.db, { ...(await getConversation(owner.db, blocked))!, opened: true, hidden: true, status: 'blocked', custom: await name(blocked) });

    await owner.messaging.maintain();
    expect((await getConversation(owner.db, deleted))!.custom).toBeUndefined();
    expect((await getConversation(owner.db, listed))!.custom).toBeInstanceOf(Uint8Array);
    expect((await getConversation(owner.db, blocked))!.custom).toBeInstanceOf(Uint8Array);
  });
});
