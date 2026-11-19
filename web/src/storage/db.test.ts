import 'fake-indexeddb/auto';
import { forceCloseDatabase } from 'fake-indexeddb';
import { openDB, unwrap, type IDBPDatabase } from 'idb';
import { describe, expect, it, vi } from 'vitest';
import { concat, utf8 } from '../crypto/encoding';
import { generateCopyableSigningKey, generateSigningKey } from '../crypto/keys';
import { LABEL_SESSION, sign, verify } from '../crypto/signing';
import { generateVaultKey, seal, unseal } from '../crypto/vault';
import {
  addMessage,
  clearMedia,
  clearMessages,
  deleteMessage,
  findLinkConversation,
  getMedia,
  getMessage,
  listConversations,
  listMessages,
  getPendingEdits,
  openPendingEdit,
  pendingUploadDeletes,
  putMedia,
  setFile,
  unreadIds,
  type MessageBody,
} from '../messaging/store';
import {
  DB_VERSION,
  getKey,
  getKeyPair,
  getMeta,
  getSealed,
  EDITS_LEDGER,
  MAX_PENDING_EDIT_BYTES,
  MAX_PENDING_EDITS,
  MAX_UNANSWERED_EDIT_BYTES,
  openDatabase,
  putKey,
  putMeta,
  putSealed,
  RELOAD_GAP_MS,
  StorageError,
  type Database,
} from './db';

let n = 0;
const fresh = () => openDatabase(`test-${n++}`);
/** Deletes all of a conversation's messages, as deleting the whole conversation does. */
const deleteMessages = (db: Database, conv: string) => clearMessages(db, conv, { theirs: Infinity, ours: Infinity });

describe('storage', () => {
  it('keeps a non-extractable key pair usable after reopening', async () => {
    const name = `test-${n++}`;
    const pair = await generateSigningKey();
    const db = await openDatabase(name);
    await putKey(db, 'device-signing', { privateKey: pair.privateKey, publicKey: pair.publicKey });
    db.close();

    const reopened = await openDatabase(name);
    const stored = await getKeyPair(reopened, 'device-signing');
    expect(stored).toBeDefined();
    expect(stored!.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', stored!.privateKey)).rejects.toThrow();
    const sig = await sign(stored!.privateKey, LABEL_SESSION, 'x');
    expect(await verify(pair.publicKey, sig, LABEL_SESSION, 'x')).toBe(true);
  });

  it('tells single keys and key pairs apart', async () => {
    const db = await fresh();
    await putKey(db, 'vault', await generateVaultKey());
    const pair = await generateSigningKey();
    await putKey(db, 'pair', { privateKey: pair.privateKey, publicKey: pair.publicKey });
    expect(await getKey(db, 'vault')).toBeInstanceOf(CryptoKey);
    expect(await getKeyPair(db, 'vault')).toBeUndefined();
    expect(await getKey(db, 'pair')).toBeUndefined();
    expect(await getKeyPair(db, 'pair')).toBeDefined();
    expect(await getKey(db, 'missing')).toBeUndefined();
  });

  it('stores sealed keys that unseal after reopening', async () => {
    const db = await fresh();
    const vaultKey = await generateVaultKey();
    const account = await generateCopyableSigningKey();
    await putKey(db, 'vault', vaultKey);
    await putSealed(db, 'account', await seal(vaultKey, account.privateKey, 'account'));

    const storedVault = await getKey(db, 'vault');
    const sealed = await getSealed(db, 'account');
    const working = await unseal(storedVault!, sealed!, 'account', { name: 'ECDSA', namedCurve: 'P-256' }, ['sign']);
    const sig = await sign(working, LABEL_SESSION, 'y');
    expect(await verify(account.publicKey, sig, LABEL_SESSION, 'y')).toBe(true);
  });

  it('stores small state', async () => {
    const db = await fresh();
    expect(await getMeta(db, 'account')).toBeUndefined();
    await putMeta(db, 'account', { id: 'abc', registeredAt: 1 });
    expect(await getMeta<{ id: string }>(db, 'account')).toEqual({ id: 'abc', registeredAt: 1 });
  });
});

describe('upgrades', () => {
  it('upgrades a version 1 database without losing its data', async () => {
    const name = `upgrade-test-${n++}`;
    const v1 = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore('keys');
        db.createObjectStore('vault');
        db.createObjectStore('meta');
      },
    });
    await v1.put('meta', { state: 'registered' }, 'account');
    v1.close();

    const db = await openDatabase(name);
    expect(db.version).toBe(DB_VERSION);
    expect(await getMeta(db, 'account')).toEqual({ state: 'registered' });
    expect([...db.objectStoreNames].sort()).toEqual(['conversations', 'keys', 'media', 'messages', 'meta', 'vault']);
    expect(db.transaction('messages').store.keyPath).toEqual(['conv', 'id']);
  });

  /** A database as version 3 of the app made it, filled by fill. */
  async function version3(name: string, fill: (db: IDBPDatabase) => Promise<void>): Promise<void> {
    const v3 = await openDB(name, 3, {
      upgrade(db) {
        for (const store of ['keys', 'vault', 'meta', 'media']) db.createObjectStore(store);
        db.createObjectStore('conversations', { keyPath: 'id' });
        db.createObjectStore('messages', { keyPath: 'id' }).createIndex('byConversation', ['conv', 'at']);
      },
    });
    await fill(v3);
    v3.close();
  }

  /** Sealed under the storage key as version 3 did: nonce ‖ AES-GCM, bound to a name. */
  async function sealed(key: CryptoKey, name: string, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return concat(iv, new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(name) }, key, data)));
  }

  it('upgrades a version 3 database: conversations get their own IDs, messages are kept by conversation, files stay put', async () => {
    const name = `upgrade-test-${n++}`;
    const link = { id: 'L'.repeat(11), fingerprint: 'F'.repeat(43) };
    const conversation = { link, label: 'x', sendTo: 'M'.repeat(22), lastAt: 1, unread: 0, status: 'active', lastReceived: null };
    const photo = crypto.getRandomValues(new Uint8Array(3000));
    await version3(name, async (db) => {
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await db.put('keys', key, 'storage-key');
      const message = async (id: string, conv: string, at: number, body: object, extra: object = {}) =>
        db.put('messages', { id, conv, at, out: false, status: 'received', ...extra, sealed: await sealed(key, id, utf8(JSON.stringify(body))) });
      // Someone we never answered, with an edit and a delete that came before their messages.
      await db.put('conversations', {
        ...conversation,
        id: 'unanswered',
        role: 'owner',
        peerKey: 'their-first-key',
        myKey: null,
        myMailbox: null,
        tag: 'T',
        edits: [{ id: 'early', at: 5, sealed: await sealed(key, 'edit:early', utf8(JSON.stringify({ text: 'fixed' }))) }],
        deleted: [{ id: 'gone', at: 6 }],
      });
      await message('m1', 'unanswered', 10, { text: 'hello' });
      // Someone we answered: their key may have changed since.
      await db.put('conversations', { ...conversation, id: 'answered', role: 'owner', peerKey: 'their-later-key', myKey: 'ours', myMailbox: 'B'.repeat(22) });
      await message('m2', 'answered', 20, { text: 'hi' });
      // A link we wrote to, with a photo on the device.
      await db.put('conversations', { ...conversation, id: 'written', role: 'sender', link: { id: 'K'.repeat(11), fingerprint: 'G'.repeat(43) }, peerKey: 'link-key', myKey: 'mine', myMailbox: null });
      await message('m3', 'written', 30, { text: '', media: { t: 'photo', s: photo.length, id: 'upload', k: 'a2V5', d: 'c2VjcmV0' } }, { out: true, status: 'sent', file: 'local' });
      await db.put('media', await sealed(key, 'media:m3', photo), 'm3');
      // A file whose message was never stored (a send that didn't finish).
      await db.put('media', await sealed(key, 'media:orphan', new Uint8Array(10)), 'orphan');
      // Uploads still to delete from the server.
      await db.put('meta', await sealed(key, 'upload-deletes', utf8(JSON.stringify({ text: JSON.stringify([{ id: 'u1', d: 's1' }]) }))), 'upload-deletes');
    });

    const db = await openDatabase(name);
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual(['conversations', 'keys', 'media', 'messages', 'meta', 'vault']);

    // Conversations keep their IDs, which were their wire IDs.
    const byId = new Map((await listConversations(db)).map((c) => [c.id, c]));
    expect([...byId.keys()].sort()).toEqual(['answered', 'unanswered', 'written']);
    for (const [id, c] of byId) expect(c.wire).toBe(id);
    expect(byId.get('unanswered')!.firstKey).toBe('their-first-key');
    expect(byId.get('answered')!.firstKey).toBeUndefined();
    expect(byId.get('written')!.firstKey).toBeUndefined();

    // Messages, attachments and what was pending all still open.
    expect((await listMessages(db, 'unanswered')).map((m) => [m.id, m.text])).toEqual([['m1', 'hello']]);
    expect((await listMessages(db, 'answered')).map((m) => [m.id, m.text])).toEqual([['m2', 'hi']]);
    expect(await listMessages(db, 'written')).toMatchObject([{ id: 'm3', out: true, status: 'sent', file: 'local', media: { t: 'photo', s: photo.length } }]);
    // The file wasn't moved (that would need as much space again): its message says where it is.
    expect(await db.getAllKeys('media')).toEqual(['m3']);
    expect((await db.getAll('messages')).map((m) => [m.id, m.legacyFile])).toEqual([
      ['m2', undefined],
      ['m1', undefined],
      ['m3', true],
    ]);
    expect(await getMedia(db, 'written', 'm3')).toEqual(photo);
    const pending = byId.get('unanswered')!;
    expect(await openPendingEdit(db, 'early', (await getPendingEdits(db, 'unanswered'))[0]!.sealed)).toBe('fixed');
    expect(pending).not.toHaveProperty('edits');
    expect(pending.deleted).toEqual([{ id: 'gone', at: 6 }]);
    expect(await pendingUploadDeletes(db)).toEqual([{ id: 'u1', d: 's1' }]);

    // First messages through the link find their conversation: by the first
    // key where it's known, and as before where it isn't.
    expect((await findLinkConversation(db, link.id, 'unanswered', 'their-first-key'))?.id).toBe('unanswered');
    expect(await findLinkConversation(db, link.id, 'unanswered', 'someone-else')).toBeUndefined();
    expect((await findLinkConversation(db, link.id, 'answered', 'any-key'))?.id).toBe('answered');
    expect(await findLinkConversation(db, 'O'.repeat(11), 'unanswered', 'their-first-key')).toBeUndefined();
    expect(await findLinkConversation(db, 'K'.repeat(11), 'written', 'link-key')).toBeUndefined();

    // And it works on: the same message ID in another conversation is another
    // message, which never reaches the old file under that ID.
    await addMessage(db, { id: 'm3', conv: 'answered', at: 40, out: false, status: 'received', file: 'local' }, { text: 'same ID, other chat' });
    expect((await listMessages(db, 'answered')).map((m) => m.text)).toEqual(['hi', 'same ID, other chat']);
    expect(await getMedia(db, 'answered', 'm3')).toBeUndefined();
    await deleteMessage(db, 'answered', 'm3');
    expect(await getMedia(db, 'written', 'm3')).toEqual(photo);
    expect(await getMessage(db, 'written', 'm3')).toMatchObject({ file: 'local', out: true });
  });

  it('upgrades a version 4 database: edits waiting for their messages move off the conversation record, the newest that fit', async () => {
    const name = `upgrade-test-${n++}`;
    const v4 = await openDB(name, 4, {
      upgrade(db) {
        for (const store of ['keys', 'vault', 'meta', 'media']) db.createObjectStore(store);
        db.createObjectStore('conversations', { keyPath: 'id' }).createIndex('byWire', ['link.id', 'wire']);
        db.createObjectStore('messages', { keyPath: ['conv', 'id'] }).createIndex('byConversation', ['conv', 'at']);
      },
    });
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await v4.put('keys', key, 'storage-key');
    const conversation = { wire: 'w', role: 'owner', link: { id: 'L', fingerprint: 'F' }, label: 'x', peerKey: 'k', myKey: null, sendTo: 'm', myMailbox: null, lastAt: 0, unread: 0, status: 'active', lastReceived: null };
    // A hidden one a flood of edits filled (as many as version 4 kept), one with a few, and one with none.
    const flood = await Promise.all(
      Array.from({ length: 500 }, async (_, i) => ({ id: `e${i}`, at: i, sealed: await sealed(key, `edit:e${i}`, utf8(JSON.stringify({ text: 'x'.repeat(i % 2 ? 12_000 : 10) }))) })),
    );
    await v4.put('conversations', { ...conversation, id: 'flooded', hidden: true, edits: flood });
    const few = flood.slice(0, 3).filter((e) => e.sealed.length < 100);
    await v4.put('conversations', { ...conversation, id: 'few', lastAt: 5, edits: few });
    await v4.put('conversations', { ...conversation, id: 'none', lastAt: 6 });
    await v4.put('meta', [{ day: 1, tags: ['t'] }], 'ids:applied:flooded');
    // Two more never answered, whose edits are older than those: one fits in what's left of the budget all such chats share, one doesn't.
    const old = (i: number, size: number) => ({ id: `o${i}`, at: 1, sealed: new Uint8Array(size) });
    await v4.put('conversations', { ...conversation, id: 'old-small', lastAt: 7, edits: [old(1, 100)] });
    await v4.put('conversations', { ...conversation, id: 'old-big', lastAt: 8, edits: [old(2, 12_000)] });
    // One we answered keeps its own: it doesn't share the budget.
    await v4.put('conversations', { ...conversation, id: 'answered', myMailbox: 'B', lastAt: 9, edits: [old(3, 30_000)] });
    // Messages, found by status from now on.
    await v4.put('messages', { id: 'm1', conv: 'few', at: 1, out: false, status: 'received', sealed: new Uint8Array(30) });
    await v4.put('messages', { id: 'm2', conv: 'few', at: 2, out: false, status: 'read', sealed: new Uint8Array(30) });
    v4.close();

    const db = await openDatabase(name);
    expect(db.version).toBe(DB_VERSION);
    for (const c of await listConversations(db)) expect(c).not.toHaveProperty('edits');
    // The newest, as many as fit: in number and in bytes.
    const moved = await getPendingEdits(db, 'flooded');
    expect(moved.length).toBeLessThanOrEqual(MAX_PENDING_EDITS);
    expect(moved.reduce((n, e) => n + e.sealed.length, 0)).toBeLessThanOrEqual(MAX_PENDING_EDIT_BYTES);
    expect(moved.at(-1)!.id).toBe('e499');
    expect(moved).toEqual(flood.slice(-moved.length));
    // Still sealed as they were, and open.
    expect(await openPendingEdit(db, 'e498', moved.find((e) => e.id === 'e498')!.sealed)).toBe('x'.repeat(10));
    expect(await getPendingEdits(db, 'few')).toEqual(few);
    expect(await getPendingEdits(db, 'none')).toEqual([]);
    expect(await getMeta(db, 'ids:applied:flooded')).toEqual([{ day: 1, tags: ['t'] }]);
    expect((await listConversations(db)).find((c) => c.id === 'flooded')).toMatchObject({ hidden: true, lastAt: 0 });
    // The budget never-answered chats share: newest first, as many as fit.
    const bytes = moved.reduce((n, e) => n + e.sealed.length, 0) + few.reduce((n, e) => n + e.sealed.length, 0);
    expect(bytes + 100).toBeLessThanOrEqual(MAX_UNANSWERED_EDIT_BYTES);
    expect(bytes + 100 + 12_000).toBeGreaterThan(MAX_UNANSWERED_EDIT_BYTES);
    expect(await getPendingEdits(db, 'old-small')).toHaveLength(1);
    expect(await getPendingEdits(db, 'old-big')).toEqual([]);
    expect(await getPendingEdits(db, 'answered')).toHaveLength(1);
    expect(((await getMeta(db, EDITS_LEDGER)) as { conv: string }[]).map((e) => e.conv)).toEqual(['flooded', 'few', 'old-small']);
    expect(await unreadIds(db, 'few')).toEqual(['m1']);
  });

  it('deletes and clears files kept from version 3 and files stored since, each where it is', async () => {
    const name = `upgrade-test-${n++}`;
    const file = (n: number) => new Uint8Array(n).fill(n % 251);
    const media = (n: number) => ({ text: '', media: { t: 'photo', s: n, id: `upload-${n}`, k: 'a2V5', d: 'c2VjcmV0' } });
    await version3(name, async (db) => {
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await db.put('keys', key, 'storage-key');
      const photo = async (id: string, conv: string, size: number) => {
        await db.put('messages', { id, conv, at: size, out: false, status: 'read', file: 'local', sealed: await sealed(key, id, utf8(JSON.stringify(media(size)))) });
        await db.put('media', await sealed(key, `media:${id}`, file(size)), id);
      };
      for (const id of ['a', 'b']) await db.put('conversations', { id, role: 'sender', link: { id: 'L', fingerprint: 'F' }, myKey: 'k' });
      await photo('a1', 'a', 100);
      await photo('a2', 'a', 200);
      await photo('b1', 'b', 300);
      await photo('b2', 'b', 400);
    });
    const db = await openDatabase(name);
    expect((await db.getAllKeys('media')).sort()).toEqual(['a1', 'a2', 'b1', 'b2']);
    // Files stored since go under (conversation, message ID), beside the old ones.
    const add = async (conv: string, id: string, size: number) => {
      await addMessage(db, { id, conv, at: size, out: false, status: 'read', file: 'local' }, media(size));
      await putMedia(db, conv, id, file(size));
    };
    await add('a', 'a3', 500);
    await add('b', 'b3', 600);
    for (const [conv, id, size] of [['a', 'a1', 100], ['a', 'a3', 500], ['b', 'b1', 300], ['b', 'b3', 600]] as const) {
      expect(await getMedia(db, conv, id)).toEqual(file(size));
    }

    // One message deleted: its file goes, old key or new.
    await deleteMessage(db, 'a', 'a2');
    await deleteMessage(db, 'a', 'a3');
    // An old one fetched again (after it was cleared, say) moves to the new key.
    await putMedia(db, 'b', 'b2', file(400));
    expect((await getMessage(db, 'b', 'b2'))!.legacyFile).toBeUndefined();
    expect(await getMedia(db, 'b', 'b2')).toEqual(file(400));
    expect(await db.getAllKeys('media')).toEqual(['a1', 'b1', ['b', 'b2'], ['b', 'b3']]);

    // Cleared: old and new files both go; their messages stay, marked cleared and no longer old.
    expect(await clearMedia(db, { conv: 'b' })).toBe(300 + 400 + 600);
    expect(await db.getAllKeys('media')).toEqual(['a1']);
    expect((await listMessages(db, 'b')).map((m) => [m.id, m.file, m.legacyFile])).toEqual([
      ['b1', 'cleared', undefined],
      ['b2', 'cleared', undefined],
      ['b3', 'cleared', undefined],
    ]);
    // A whole conversation deleted: its files go, old key or new.
    await add('a', 'a4', 700);
    await deleteMessages(db, 'a');
    expect(await db.getAllKeys('media')).toEqual([]);
    expect(await listMessages(db, 'a')).toEqual([]);
  });

  /** A version 3 database with one photo, 'x' in conversation 'a', on the device; and an empty conversation 'b'. Opened by this version. */
  async function oneOldPhoto(): Promise<{ db: Database; photo: Uint8Array<ArrayBuffer>; body: MessageBody }> {
    const name = `upgrade-test-${n++}`;
    const photo = crypto.getRandomValues(new Uint8Array(500));
    const body: MessageBody = { text: '', media: { t: 'photo', s: photo.length, id: 'upload', k: 'a2V5', d: 'c2VjcmV0' } };
    await version3(name, async (v3) => {
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await v3.put('keys', key, 'storage-key');
      for (const id of ['a', 'b']) await v3.put('conversations', { id, role: 'sender', link: { id: 'L', fingerprint: 'F' }, myKey: 'k' });
      await v3.put('messages', { id: 'x', conv: 'a', at: 1, out: false, status: 'read', file: 'local', sealed: await sealed(key, 'x', utf8(JSON.stringify(body))) });
      await v3.put('media', await sealed(key, 'media:x', photo), 'x');
    });
    return { db: await openDatabase(name), photo, body };
  }

  it('never lets the same ID in another conversation reach, move or delete an old file', async () => {
    const { db, photo, body } = await oneOldPhoto();
    const untouched = async () => {
      expect(await db.getKey('media', 'x')).toBe('x');
      expect((await getMessage(db, 'a', 'x'))!.legacyFile).toBe(true);
      expect(await getMedia(db, 'a', 'x')).toEqual(photo);
    };
    const theirs = crypto.getRandomValues(new Uint8Array(700));
    const arrive = (file: 'remote' | 'local') => addMessage(db, { id: 'x', conv: 'b', at: 2, out: false, status: 'received', file }, body);

    await arrive('remote');
    expect(await getMedia(db, 'b', 'x')).toBeUndefined();
    await untouched();
    await putMedia(db, 'b', 'x', theirs);
    expect(await getMedia(db, 'b', 'x')).toEqual(theirs);
    await untouched();
    await setFile(db, 'b', 'x', 'local');
    expect(await clearMedia(db, { conv: 'b' })).toBe(photo.length);
    expect(await getMedia(db, 'b', 'x')).toBeUndefined();
    await untouched();
    await putMedia(db, 'b', 'x', theirs);
    await deleteMessage(db, 'b', 'x');
    await untouched();
    await arrive('local');
    await putMedia(db, 'b', 'x', theirs);
    await deleteMessages(db, 'b');
    await untouched();
    expect(await db.getAllKeys('media')).toEqual(['x']);
  });

  it('finds and deletes a moved file even if a stale write marks it old again', async () => {
    const { db, photo } = await oneOldPhoto();
    const stale = async () => {
      // As a write from a copy read before the move would leave it.
      await putMedia(db, 'a', 'x', photo);
      const record = (await db.get('messages', ['a', 'x']))!;
      await db.put('messages', { ...record, file: 'local', legacyFile: true });
      expect(await db.getAllKeys('media')).toEqual([['a', 'x']]);
      expect(await getMedia(db, 'a', 'x')).toEqual(photo);
    };
    await stale();
    expect(await clearMedia(db, { conv: 'a' })).toBe(photo.length);
    expect(await db.getAllKeys('media')).toEqual([]);
    await stale();
    await deleteMessages(db, 'b');
    await deleteMessage(db, 'a', 'x');
    expect(await db.getAllKeys('media')).toEqual([]);
    await addMessage(db, { id: 'x', conv: 'a', at: 1, out: false, status: 'read', file: 'local' }, { text: '' });
    await stale();
    await deleteMessages(db, 'a');
    expect(await db.getAllKeys('media')).toEqual([]);
  });

  it('upgrades more messages than one batch takes, marking exactly those whose file is on the device', async () => {
    const name = `upgrade-test-${n++}`;
    const id = (i: number) => `m${String(i).padStart(4, '0')}`;
    const total = 1234;
    // Spread over all three batches of 500, at their edges too.
    const local = [0, 100, 200, 300, 400, 499, 500, 501, 600, 700, 800, 900, 999, 1000, 1100, 1200, 1233];
    await version3(name, async (v3) => {
      await v3.put('conversations', { id: 'c', role: 'sender', link: { id: 'L', fingerprint: 'F' }, myKey: 'k' });
      const tx = v3.transaction(['messages', 'media'], 'readwrite');
      for (let i = 0; i < total; i++) {
        const file = local.includes(i) ? 'local' : i === 7 ? 'remote' : i === 8 ? 'cleared' : undefined;
        void tx.objectStore('messages').put({ id: id(i), conv: 'c', at: i, out: false, status: 'read', ...(file ? { file } : {}), sealed: new Uint8Array(1) });
      }
      // Files under the IDs of messages that show them as here, and leftovers:
      // under the IDs of messages that don't (still to fetch, cleared, none at
      // all), and under no message's ID.
      for (const i of [...local, 7, 8, 9]) void tx.objectStore('media').put(new Uint8Array(4), id(i));
      void tx.objectStore('media').put(new Uint8Array(4), 'stray');
      await tx.done;
    });
    const db = await openDatabase(name);
    expect(await db.count('messages')).toBe(total);
    expect([...db.objectStoreNames]).not.toContain('messages-v3');
    const marked = (await db.getAll('messages')).filter((m) => m.legacyFile).map((m) => m.id);
    expect(marked).toEqual(local.map(id));
    expect(await db.getAllKeys('media')).toEqual(local.map(id));
    expect((await db.getAll('messages')).map((m) => m.id)).toEqual(Array.from({ length: total }, (_, i) => id(i)));
  });

  it('closes at once when a newer copy of the app needs the database, and reloads', async () => {
    const name = `upgrade-test-${n++}`;
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    try {
      await openDatabase(name);
      let blocked = false;
      const newer = await openDB(name, DB_VERSION + 1, { blocked: () => (blocked = true) });
      expect(blocked).toBe(false);
      expect(reload).toHaveBeenCalledOnce();
      newer.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reloads when the browser drops the connection, but not again within a minute', async () => {
    const reload = vi.fn();
    const kept = new Map<string, string>();
    vi.stubGlobal('location', { reload });
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const dropped = async () => {
      const db = await openDatabase(`terminated-test-${n++}`);
      forceCloseDatabase(unwrap(db) as never);
      await new Promise((r) => setTimeout(r, 0));
    };
    try {
      await dropped();
      expect(reload).toHaveBeenCalledOnce();
      // The reloaded page loses it again at once: no reload loop.
      clock.mockReturnValue(1_800_000_000_000 + RELOAD_GAP_MS - 1);
      await dropped();
      expect(reload).toHaveBeenCalledOnce();
      // Later on, it reloads again.
      clock.mockReturnValue(1_800_000_000_000 + RELOAD_GAP_MS);
      await dropped();
      expect(reload).toHaveBeenCalledTimes(2);
      // Without sessionStorage (blocked), it can't tell, and doesn't.
      clock.mockReturnValue(1_800_000_000_000 + 3 * RELOAD_GAP_MS);
      vi.stubGlobal('sessionStorage', {
        getItem: () => {
          throw new DOMException('blocked', 'SecurityError');
        },
      });
      await dropped();
      expect(reload).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("leaves a database it can't upgrade as it was, and says why", async () => {
    const name = `upgrade-test-${n++}`;
    await version3(name, async (db) => {
      await db.put('conversations', { id: 'c', role: 'sender' });
      // Not a message this app would have stored: it has no conversation.
      await db.put('messages', { id: 'm', at: 1, out: false, status: 'received', sealed: new Uint8Array(1) });
    });
    const failed = await openDatabase(name).catch((err: unknown) => err);
    expect(failed).toBeInstanceOf(StorageError);
    expect(failed).toMatchObject({ kind: 'failed', cause: { name: 'DataError' } });
    const still = await openDB(name);
    expect(still.version).toBe(3);
    expect(await still.getAll('messages')).toMatchObject([{ id: 'm' }]);
    expect(await still.getAll('conversations')).toEqual([{ id: 'c', role: 'sender' }]);
    still.close();
  });

  it('says so when a newer version of the app has upgraded the database', async () => {
    const name = `upgrade-test-${n++}`;
    (await openDB(name, DB_VERSION + 1)).close();
    const failed = await openDatabase(name).catch((err: unknown) => err);
    expect(failed).toBeInstanceOf(StorageError);
    expect(failed).toMatchObject({ kind: 'newer', cause: { name: 'VersionError' } });
  });

  it('waits for an older copy of the app to close, and says so meanwhile', async () => {
    const name = `upgrade-test-${n++}`;
    await version3(name, async () => {});
    // An older copy that keeps it open, ignoring the request to close.
    const old = await openDB(name, 3);
    let blocked = 0;
    const db = await openDatabase(name, {
      onBlocked: () => {
        blocked++;
        old.close();
      },
    });
    expect(blocked).toBe(1);
    expect(db.version).toBe(DB_VERSION);
  });
});
