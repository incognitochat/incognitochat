import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLink, listLinks, replaceLink } from '../account/links';
import type { TokenIssuer } from '../account/wallet';
import { i2osp, modPow, os2ip, type IssuerKey } from '../crypto/blindrsa';
import { fromBase64Url, toBase64Url, toHex } from '../crypto/encoding';
import { generateVaultKey } from '../crypto/vault';
import { ApiError, NetworkError, type Api } from '../net/api';
import type { Session } from '../net/session';
import { checkBundle, type LinkRef } from '../protocol/link';
import { challenge, epochOf, LABEL_MEDIA_TOKEN } from '../protocol/token';
import { countTokens, LOW_WATER } from '../account/wallet';
import { newId } from '../protocol/message';
import { getMeta, getSealed, openDatabase, putKey, putMeta, type Database } from '../storage/db';
import { POOL_LOW, poolSize } from './pool';
import { createMessaging } from './engine';
import { clearMedia, getConversation, getMedia, getMessage, listConversations, listMessages, mediaUsage, pendingUploadDeletes } from './store';
import { TransferError, WrongSize, type Transfer } from '../net/transfer';
import { KEY_RETENTION_MS, scheduleKeyDeletion, type KeyEntry } from './keys';

// A modified app chooses its IDs: tests make it reuse some (nextIds).
vi.mock('../protocol/message', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../protocol/message')>();
  return { ...actual, newId: vi.fn(actual.newId) };
});

/** The next IDs the app makes for the wire (conversation, then message, in the order it makes them) are these. */
function nextIds(...ids: string[]): void {
  for (const id of ids) vi.mocked(newId).mockReturnValueOnce(id);
}

afterEach(() => {
  vi.mocked(newId).mockReset();
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

  const mailboxes = new Map<string, string>(); // mailbox -> owner account
  const inboxes = new Map<string, { id: string; mailbox: string; envelope: string }[]>();
  const bundles = new Map<string, Record<string, unknown>>();
  const spent = new Set<string>();
  const seenEnvelopes: string[] = [];
  const sendHeaders: (Record<string, string> | undefined)[] = [];
  /**
   * Parts of the server that can't be reached. puts: how the next PUTs go
   * wrong: the bucket can't be reached; the upload is written but the answer
   * is lost; the URL can no longer start one; a delete races the write (409);
   * or the upload is there already (412). renewals: whether the next fresh
   * URLs asked for are refused.
   */
  const down = {
    deletes: false,
    puts: [] as ('unreachable' | 'lost' | 'expired' | 'conflict' | 'there')[],
    renewals: [] as ('ok' | 'refused')[],
  };
  const quietSends: boolean[] = [];
  const uploads = new Map<string, { size: number; deleteHash: string; body: Uint8Array<ArrayBuffer> | null; renewals: number }>();
  /** Every upload URL handed out, and every PUT tried. */
  const uploadUrls: string[] = [];
  const puts: string[] = [];
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
      if (!up?.body) throw new Error('not in the bucket');
      if (up.body.length !== size) throw new WrongSize();
      return up.body;
    },
  };

  const api: Api = {
    post: (path, body, check) => api.request('POST', path, { body: JSON.stringify(body) }, check),
    async request(method, path, init, check) {
      if (method === 'POST' && path === '/send') {
        sendHeaders.push(init.headers);
        const { mailbox, envelope, token, quiet } = JSON.parse(init.body!) as Record<string, string>;
        quietSends.push(quiet === (true as unknown as string));
        if (!token || spent.has(token)) throw new ApiError(401, 'invalid_token');
        spent.add(token);
        seenEnvelopes.push(envelope!);
        const owner = mailboxes.get(mailbox!);
        if (owner) inboxes.get(owner)!.push({ id: rand(), mailbox: mailbox!, envelope: envelope! });
        return check({});
      }
      if (method === 'POST' && path === '/media') {
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
        if (!up || up.deleteHash !== hash || up.renewals >= 3 || down.renewals.shift() === 'refused') throw new ApiError(404, 'not_found');
        up.renewals++;
        if (up.body) return check({ uploaded: true });
        uploadUrls.push(`https://bucket.example/m/${id}?n=${up.renewals}`);
        return check({ url: uploadUrls.at(-1) });
      }
      if (method === 'GET' && path.startsWith('/media/')) {
        const up = uploads.get(path.split('/')[2]!);
        if (!up?.body) throw new ApiError(404, 'not_found');
        return check({ url: `https://bucket.example/m/${path.split('/')[2]!}` });
      }
      if (method === 'POST' && path.startsWith('/media/') && path.endsWith('/delete')) {
        if (down.deletes) throw new NetworkError('down');
        const id = path.split('/')[2]!;
        const { secret } = JSON.parse(init.body!) as { secret: string };
        const hash = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', fromBase64Url(secret))));
        if (uploads.get(id)?.deleteHash !== hash) throw new ApiError(404, 'not_found');
        uploads.delete(id);
        return check({});
      }
      if (method === 'GET' && path.startsWith('/links/')) {
        const b = bundles.get(path.split('/')[2]!);
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
          if (path === '/tokens/media') mediaSigned += (b.blinded as string[]).length;
          return check({
            signatures: (b.blinded as string[]).map((x) => toBase64Url(i2osp(modPow(os2ip(fromBase64Url(x)), d, key.n), 256))),
          });
        }
        if (path === '/links') {
          if (b.replaces) {
            // The old link and its intro mailbox go.
            const old = bundles.get(b.replaces as string);
            if (!old) throw new ApiError(404, 'not_found');
            bundles.delete(b.replaces as string);
            mailboxes.delete(old.mailbox as string);
          }
          const intro = rand();
          mailboxes.set(intro, account);
          bundles.set(b.id as string, { signingKey: b.signingKey, keys: b.keys, mailbox: intro });
          return check({ id: b.id, mailbox: intro });
        }
        if (method === 'PUT' && path.startsWith('/links/') && path.endsWith('/keys')) {
          const bundle = bundles.get(path.split('/')[2]!);
          if (!bundle) throw new ApiError(404, 'not_found');
          bundle.keys = b.keys;
          return check({});
        }
        if (method === 'POST' && path.startsWith('/mailboxes/') && path.endsWith('/discard')) {
          const id = path.split('/')[2]!;
          if (mailboxes.get(id) !== account) throw new ApiError(404, 'not_found');
          mailboxes.delete(id);
          return check({});
        }
        if (method === 'GET' && path === '/inbox') return check({ items: [...inboxes.get(account)!], more: false });
        if (path === '/mailboxes/check') return check({ missing: (b.ids as string[]).filter((id) => mailboxes.get(id) !== account) });
        if (path === '/ack') {
          const done = new Set(b.ids as string[]);
          inboxes.set(account, inboxes.get(account)!.filter((i) => !done.has(i.id)));
          return check({});
        }
        throw new ApiError(404, 'not_found');
      },
    };
  }

  return { api, session, issuer, seenEnvelopes, sendHeaders, inboxes, quietSends, mailboxes, uploads, uploadUrls, puts, transfer, down, mediaSigned: () => mediaSigned };
}

async function person(backend: Awaited<ReturnType<typeof fakeBackend>>, account: string, now?: () => number) {
  const db: Database = await openDatabase(`engine-test-${n++}`);
  await putKey(db, 'vault-key', await generateVaultKey());
  const session = backend.session(account);
  return {
    db,
    session,
    messaging: createMessaging({ db, api: backend.api, session, issuer: backend.issuer, mediaIssuer: backend.issuer, transfer: backend.transfer, wait: async () => {}, ...(now ? { now } : {}) }),
  };
}

async function linkOf(backend: Awaited<ReturnType<typeof fakeBackend>>, owner: Awaited<ReturnType<typeof person>>) {
  const record = await createLink(owner.db, owner.session);
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

describe('messaging between two people', () => {
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
    expect(await countTokens(owner.db)).toBeGreaterThanOrEqual(LOW_WATER);

    await sender.messaging.startConversation(ref, bundle, 'still reaches you');
    expect(await owner.messaging.sync()).toBe(1);
  });
});

describe('seen receipts', () => {
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

    const record = await replaceLink(owner.db, owner.session);
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
    expect(c?.deleted?.map((d) => d.id)).toEqual([hello!.id]);
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

describe('deleting uploads in the background', () => {
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
    expect((await getConversation(owner.db, local))!.edits).toEqual([]);
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
    const sendTokens = await countTokens(sender.db);
    const file = crypto.getRandomValues(new Uint8Array(65536));
    const big = new Uint8Array(6 * 1024 * 1024);
    big.set(file);
    const progress: number[] = [];
    await sender.messaging.sendMedia(conv, { file: big, media: { t: 'file', s: big.length, n: 'notes.pdf', m: 'application/pdf' } }, 'see this', undefined, undefined, (f) => progress.push(f));
    expect(progress).toEqual([1]);
    const [upload] = [...backend.uploads.values()];
    expect(upload!.body!.length).toBe(7 * 1024 * 1024);
    expect(backend.mediaSigned()).toBeGreaterThanOrEqual(7);
    expect(await countTokens(sender.db)).toBe(sendTokens - 1);
    // What the batch brought beyond the upload's cost stays in the media wallet.
    expect(await countTokens(sender.db, undefined, 'media')).toBe(backend.mediaSigned() - 7);
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

/**
 * A copy of a device's database as version 3 of the app kept it: each
 * conversation under its wire ID, messages and attachments by message ID.
 */
async function asVersion3(db: Database, name: string): Promise<void> {
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
  for (const k of await db.getAllKeys('meta')) {
    let value = await db.get('meta', k);
    if (k === 'recipient-keys') {
      const index = value as Record<string, KeyEntry>;
      value = Object.fromEntries(Object.entries(index).map(([id, e]) => [id, e.conv ? { ...e, conv: wire.get(e.conv)! } : e]));
    }
    await v3.put('meta', value, k);
  }
  for (const { wire: id, firstKey: _, ...c } of conversations) await v3.put('conversations', { ...c, id });
  for (const { legacyFile: _, ...m } of await db.getAll('messages')) await v3.put('messages', { ...m, conv: wire.get(m.conv)! });
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
    await sender.messaging.deleteForEveryone(conv, (await listMessages(sender.db, conv)).at(-1)!.id);
    // And one not answered yet.
    const unanswered = await other.messaging.startConversation(ref, bundle, 'hey');
    expect(await owner.messaging.sync()).toBe(2);
    const pic = (await listMessages(owner.db, await across(sender.db, conv, owner.db))).at(-1)!;
    expect(await owner.messaging.fetchMedia(pic.conv, pic.id)).toBe('local');

    // The same device as version 3 kept it, opened by this version.
    const name = `engine-v3-${n++}`;
    await asVersion3(owner.db, name);
    const db = await openDatabase(name);
    const after = createMessaging({ db, api: backend.api, session: owner.session, issuer: backend.issuer, mediaIssuer: backend.issuer, transfer: backend.transfer });
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
    const paidOnce = async () => (await countTokens(sender.db, undefined, 'media')) === backend.mediaSigned() - 1;
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
    expect(await paidOnce()).toBe(true);
    expect(await mine()).toMatchObject({ status: 'failed' });
  });

  it('downloads only the padded size the message says', async () => {
    const { backend, owner, send, received } = await photoChat();
    await send();
    const { local, theirs } = await received();
    // Not the upload the message names: refused, and still to fetch.
    const up = [...backend.uploads.values()][0]!;
    up.body = new Uint8Array(up.size * 2);
    await expect(owner.messaging.fetchMedia(local, theirs.id)).rejects.toBeInstanceOf(WrongSize);
    expect((await listMessages(owner.db, local)).at(-1)!.file).toBe('remote');
  });
});
