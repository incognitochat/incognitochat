import 'fake-indexeddb/auto';
import { openDB, type IDBPDatabase } from 'idb';
import { describe, expect, it } from 'vitest';
import { concat, utf8 } from '../crypto/encoding';
import { generateCopyableSigningKey, generateSigningKey } from '../crypto/keys';
import { LABEL_SESSION, sign, verify } from '../crypto/signing';
import { generateVaultKey, seal, unseal } from '../crypto/vault';
import {
  addMessage,
  deleteMessage,
  findLinkConversation,
  getMedia,
  getMessage,
  listConversations,
  listMessages,
  openPendingEdit,
  pendingUploadDeletes,
} from '../messaging/store';
import { DB_VERSION, getKey, getKeyPair, getMeta, getSealed, openDatabase, putKey, putMeta, putSealed } from './db';

let n = 0;
const fresh = () => openDatabase(`test-${n++}`);

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

  it('upgrades a version 3 database: conversations get their own IDs, messages and attachments are kept by conversation', async () => {
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
    expect(await getMedia(db, 'written', 'm3')).toEqual(photo);
    expect(await db.getAllKeys('media')).toEqual([['written', 'm3']]);
    const pending = byId.get('unanswered')!;
    expect(await openPendingEdit(db, 'early', pending.edits![0]!.sealed)).toBe('fixed');
    expect(pending.deleted).toEqual([{ id: 'gone', at: 6 }]);
    expect(await pendingUploadDeletes(db)).toEqual([{ id: 'u1', d: 's1' }]);

    // First messages through the link find their conversation: by the first
    // key where it's known, and as before where it isn't.
    expect((await findLinkConversation(db, link.id, 'unanswered', 'their-first-key'))?.id).toBe('unanswered');
    expect(await findLinkConversation(db, link.id, 'unanswered', 'someone-else')).toBeUndefined();
    expect((await findLinkConversation(db, link.id, 'answered', 'any-key'))?.id).toBe('answered');
    expect(await findLinkConversation(db, 'O'.repeat(11), 'unanswered', 'their-first-key')).toBeUndefined();
    expect(await findLinkConversation(db, 'K'.repeat(11), 'written', 'link-key')).toBeUndefined();

    // And it works on: the same message ID in another conversation is another message.
    await addMessage(db, { id: 'm3', conv: 'answered', at: 40, out: false, status: 'received' }, { text: 'same ID, other chat' });
    expect((await listMessages(db, 'answered')).map((m) => m.text)).toEqual(['hi', 'same ID, other chat']);
    await deleteMessage(db, 'answered', 'm3');
    expect(await getMedia(db, 'written', 'm3')).toEqual(photo);
    expect(await getMessage(db, 'written', 'm3')).toMatchObject({ file: 'local', out: true });
  });

  it("leaves a database it can't upgrade as it was", async () => {
    const name = `upgrade-test-${n++}`;
    await version3(name, async (db) => {
      await db.put('conversations', { id: 'c', role: 'sender' });
      // Not a message this app would have stored: it has no conversation.
      await db.put('messages', { id: 'm', at: 1, out: false, status: 'received', sealed: new Uint8Array(1) });
    });
    await expect(openDatabase(name)).rejects.toThrow();
    const still = await openDB(name);
    expect(still.version).toBe(3);
    expect(await still.getAll('messages')).toMatchObject([{ id: 'm' }]);
    expect(await still.getAll('conversations')).toEqual([{ id: 'c', role: 'sender' }]);
    still.close();
  });
});
