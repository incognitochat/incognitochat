// Conversations and history on this device (design D6: history lives on the
// device only). Message text is encrypted under the device's storage key, a
// non-extractable AES-GCM key, and bound to the message ID. The key is kept
// in the same database, so a copy of the app's storage opens the history
// too (crypto/vault.ts).
//
// Message and conversation IDs are chosen by the other side, so they count
// only within their conversation: messages and attachments are kept by
// (conversation, message ID), and each conversation by an ID of this
// device's own. An ID that is in use elsewhere on the device then changes
// nothing the other side could notice.

import { concat, randomBytes, toBase64Url, utf8 } from '../crypto/encoding';
import type { Media, Sticker } from '../protocol/message';
import { deleteMeta, getKey, getMeta, putKey, putMeta, type ConversationRecord, type Database, type IdDays, type MessageRecord } from '../storage/db';
import { withLock } from '../sync/locks';

const STORAGE_KEY = 'storage-key';
const IV = 12;

/** An attachment as kept with its message: no upload fields until it's uploaded (ours) or always (theirs). */
export type LocalMedia = Omit<Media, 'id' | 'k' | 'd'> & Partial<Pick<Media, 'id' | 'k' | 'd'>>;

/** One side's reaction to a message, and when it was set; an empty emoji is one taken back. */
export interface ReactionMark {
  e: string;
  at: number;
}

export interface MessageBody {
  text: string;
  replyTo?: string;
  /** An attachment: what it is and how to fetch it (the file itself is in the media store). */
  media?: LocalMedia;
  /** A sticker (then the text is empty). */
  sticker?: Sticker;
  /** Reactions, one per side: ours and theirs. */
  reactions?: { mine?: ReactionMark; theirs?: ReactionMark };
  /** When the text was last edited (the sender's clock), if it was. */
  edited?: number;
}

/** A message with its text, for showing. */
export interface MessageView extends Omit<MessageRecord, 'sealed'>, MessageBody {}

async function storageKey(db: Database): Promise<CryptoKey> {
  return withLock(STORAGE_KEY, async () => {
    const existing = await getKey(db, STORAGE_KEY);
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await putKey(db, STORAGE_KEY, key);
    return key;
  });
}

async function sealBody(db: Database, id: string, body: MessageBody): Promise<Uint8Array<ArrayBuffer>> {
  const iv = randomBytes(IV);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(id) }, await storageKey(db), utf8(JSON.stringify(body)));
  return concat(iv, new Uint8Array(ct));
}

async function openBody(db: Database, id: string, sealed: Uint8Array<ArrayBuffer>): Promise<MessageBody> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: sealed.slice(0, IV), additionalData: utf8(id) },
    await storageKey(db),
    sealed.slice(IV),
  );
  return JSON.parse(new TextDecoder().decode(pt)) as MessageBody;
}

/** A new ID for a conversation on this device: random, and never sent. */
export function newLocalId(): string {
  return toBase64Url(randomBytes(16));
}

/** A conversation, by its ID on this device. */
export function getConversation(db: Database, id: string): Promise<ConversationRecord | undefined> {
  return db.get('conversations', id);
}

/**
 * The conversation a message written for one of our links' keys belongs to:
 * the one someone started through that link with this wire ID, from this key
 * (their first). Conversations through other links, our own ones, and anyone
 * else's with the same wire ID don't count. One from before version 4 that
 * we had answered doesn't know their first key: as before, it's the only one
 * with its wire ID on its link.
 */
export async function findLinkConversation(db: Database, link: string, wire: string, from: string): Promise<ConversationRecord | undefined> {
  const started = (await db.getAllFromIndex('conversations', 'byWire', [link, wire])).filter((c) => c.role === 'owner');
  return started.find((c) => c.firstKey === from) ?? started.find((c) => c.firstKey === undefined);
}

export async function putConversation(db: Database, conversation: ConversationRecord): Promise<void> {
  await db.put('conversations', conversation);
}

/**
 * What a conversation remembers by keyed hashes (messaging/replay.ts):
 * applied, envelopes of theirs taken in; gone, their messages they deleted;
 * dropped, their messages the user deleted here; mine, the user's own
 * messages deleted here. Kept in `meta`, one item per
 * conversation and kind, apart from the conversation record: that is read
 * whenever the chat list is shown, and only the kind that changed is
 * written.
 */
export type IdKind = 'applied' | 'gone' | 'dropped' | 'mine';
export const ID_KINDS: readonly IdKind[] = ['applied', 'gone', 'dropped', 'mine'];
export type ConversationIds = Partial<Record<IdKind, IdDays>>;

function idsKey(conv: string, kind: IdKind): string {
  return `ids:${kind}:${conv}`;
}

/** What a conversation remembers by keyed hashes, of every kind. */
export async function getIds(db: Database, conv: string): Promise<ConversationIds> {
  const out: ConversationIds = {};
  for (const kind of ID_KINDS) {
    const days = (await db.get('meta', idsKey(conv, kind))) as IdDays | undefined;
    if (days) out[kind] = days;
  }
  return out;
}

/**
 * Writes a conversation and, in the same transaction, the kinds of what it
 * remembers by keyed hashes that changed from `before` (by identity): all
 * of it happens, or none.
 */
export async function saveConversation(db: Database, conversation: ConversationRecord, ids: ConversationIds = {}, before: ConversationIds = ids): Promise<void> {
  const tx = db.transaction(['conversations', 'meta'], 'readwrite');
  await tx.objectStore('conversations').put(conversation);
  for (const kind of ID_KINDS) {
    if (ids[kind] === before[kind]) continue;
    const days = ids[kind];
    if (days && days.length > 0) await tx.objectStore('meta').put(days, idsKey(conversation.id, kind));
    else await tx.objectStore('meta').delete(idsKey(conversation.id, kind));
  }
  await tx.done;
}

/** Their newest message here, by when they sent it (sentAt): for a conversation from before lastMessage was kept. */
export async function newestTheirs(db: Database, conv: string): Promise<{ at: number; id: string } | undefined> {
  const range = IDBKeyRange.bound([conv, 0], [conv, Number.MAX_SAFE_INTEGER]);
  let newest: { at: number; id: string } | undefined;
  for (const m of await db.getAllFromIndex('messages', 'byConversation', range)) {
    if (m.out) continue;
    const at = sentAt(m);
    if (!newest || at > newest.at || (at === newest.at && m.id > newest.id)) newest = { at, id: m.id };
  }
  return newest;
}

/** Conversations, newest activity first. */
export async function listConversations(db: Database): Promise<ConversationRecord[]> {
  return (await db.getAll('conversations')).sort((a, b) => b.lastAt - a.lastAt);
}

/** Whether a conversation has a message with this ID (another conversation's doesn't count). */
export async function hasMessage(db: Database, conv: string, id: string): Promise<boolean> {
  return (await db.getKey('messages', [conv, id])) !== undefined;
}

export async function addMessage(db: Database, record: Omit<MessageRecord, 'sealed'>, body: MessageBody): Promise<void> {
  await db.put('messages', { ...record, sealed: await sealBody(db, record.id, body) });
}

/** Sets a message's status; with from, only if it has that status now. */
export async function setMessageStatus(db: Database, conv: string, id: string, status: MessageRecord['status'], from?: MessageRecord['status']): Promise<void> {
  await updateMessage(db, conv, id, (record) => (from === undefined || record.status === from ? { ...record, status } : null));
}

/**
 * Changes a stored message, read and written in one transaction, so it
 * can't write back a stale copy over another change (such as its file
 * moving from where version 3 kept it). change returns null to leave it.
 */
async function updateMessage(db: Database, conv: string, id: string, change: (record: MessageRecord) => MessageRecord | null): Promise<boolean> {
  const tx = db.transaction('messages', 'readwrite');
  const record = await tx.store.get([conv, id]);
  const next = record && change(record);
  if (next) await tx.store.put(next);
  await tx.done;
  return !!next;
}

/**
 * Where a message's file may be in the media store: under (conversation,
 * message ID), and for one kept since before version 4 under the message ID
 * alone too (MessageRecord.legacyFile; IDs were unique on the device then).
 * Never under the message ID for any other message: an ID from another
 * conversation must not reach that one's file.
 */
function fileKeys(conv: string, id: string, record: MessageRecord | undefined): ([string, string] | string)[] {
  return record?.legacyFile ? [id, [conv, id]] : [[conv, id]];
}

/** Deletes one message from this device, and its attachment. */
export async function deleteMessage(db: Database, conv: string, id: string): Promise<void> {
  const tx = db.transaction(['messages', 'media'], 'readwrite');
  const record = await tx.objectStore('messages').get([conv, id]);
  await tx.objectStore('messages').delete([conv, id]);
  for (const key of fileKeys(conv, id, record)) await tx.objectStore('media').delete(key);
  await tx.done;
}

/** Keeps a message's attachment on this device, sealed under the storage key. */
export async function putMedia(db: Database, conv: string, id: string, file: Uint8Array<ArrayBuffer>): Promise<void> {
  const iv = randomBytes(IV);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(`media:${id}`) }, await storageKey(db), file);
  const tx = db.transaction(['messages', 'media'], 'readwrite');
  const messages = tx.objectStore('messages');
  const media = tx.objectStore('media');
  // A file kept from before version 4 (cleared and fetched again, say) moves to the current key.
  const record = await messages.get([conv, id]);
  for (const key of fileKeys(conv, id, record)) await media.delete(key);
  if (record?.legacyFile) {
    const { legacyFile: _, ...rest } = record;
    await messages.put(rest);
  }
  await media.put(concat(iv, new Uint8Array(ct)), [conv, id]);
  await tx.done;
}

/** A message's attachment, if it's on this device. */
export async function getMedia(db: Database, conv: string, id: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  let sealed: Uint8Array<ArrayBuffer> | undefined;
  for (const key of fileKeys(conv, id, await db.get('messages', [conv, id]))) sealed ??= await db.get('media', key);
  if (!sealed) return undefined;
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(0, IV), additionalData: utf8(`media:${id}`) }, await storageKey(db), sealed.slice(IV));
  return new Uint8Array(pt);
}

/** Sets where a message's attachment is. */
export async function setFile(db: Database, conv: string, id: string, file: NonNullable<MessageRecord['file']>): Promise<void> {
  await updateMessage(db, conv, id, (record) => ({ ...record, file }));
}

/** The lock that keeps fetching and clearing one message's attachment apart. */
export function mediaLock(conv: string, id: string): string {
  return `media:${conv}:${id}`;
}

/** The size of the attachments on this device, in bytes: in all, and by conversation. */
export async function mediaUsage(db: Database): Promise<{ total: number; byConversation: Record<string, number> }> {
  const byConversation: Record<string, number> = {};
  let total = 0;
  for (const record of await db.getAll('messages')) {
    if (record.file !== 'local') continue;
    const size = (await openBody(db, record.id, record.sealed)).media?.s ?? 0;
    byConversation[record.conv] = (byConversation[record.conv] ?? 0) + size;
    total += size;
  }
  return { total, byConversation };
}

/**
 * Removes attachments from this device and keeps their messages: those of
 * one conversation, or those older than a time, or all. Only uploaded ones
 * go, since they can be fetched again while the server keeps them; one of
 * ours still sending, or failed, stays. Returns the bytes freed.
 */
export async function clearMedia(db: Database, which: { conv?: string; before?: number } = {}): Promise<number> {
  let freed = 0;
  for (const record of await db.getAll('messages')) {
    if (record.file !== 'local') continue;
    if (which.conv !== undefined && record.conv !== which.conv) continue;
    if (which.before !== undefined && record.at >= which.before) continue;
    if (record.out && (record.status === 'sending' || record.status === 'failed')) continue;
    const { media } = await openBody(db, record.id, record.sealed);
    if (!media?.id || !media.k) continue;
    // The same lock as fetching, so a fetch can't put the file back halfway.
    freed += await withLock(mediaLock(record.conv, record.id), async () => {
      const tx = db.transaction(['messages', 'media'], 'readwrite');
      const now = await tx.objectStore('messages').get([record.conv, record.id]);
      if (now?.file !== 'local') {
        await tx.done;
        return 0;
      }
      for (const key of fileKeys(now.conv, now.id, now)) await tx.objectStore('media').delete(key);
      const { legacyFile: _, ...rest } = now;
      await tx.objectStore('messages').put({ ...rest, file: 'cleared' });
      await tx.done;
      return media.s;
    });
  }
  return freed;
}

/**
 * Sets one side's reaction to a message (an empty emoji takes it back). One
 * set at an earlier time than the one there (a replay, or an old one
 * arriving late) changes nothing. Returns whether what's shown changed.
 */
export async function setReaction(db: Database, conv: string, id: string, side: 'mine' | 'theirs', e: string, at: number): Promise<boolean> {
  return withLock(`message:${conv}:${id}`, async () => {
    const message = await getMessage(db, conv, id);
    if (!message) return false;
    const current = message.reactions?.[side];
    if (current && current.at >= at) return false;
    const body: MessageBody = {
      text: message.text,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      ...(message.media ? { media: message.media } : {}),
      ...(message.sticker ? { sticker: message.sticker } : {}),
      ...(message.edited ? { edited: message.edited } : {}),
      reactions: { ...message.reactions, [side]: { e, at } },
    };
    const sealed = await sealBody(db, id, body);
    const tx = db.transaction('messages', 'readwrite');
    const record = await tx.store.get([conv, id]);
    if (record) await tx.store.put({ ...record, sealed });
    await tx.done;
    return !!record && (current?.e ?? '') !== e;
  });
}

/**
 * Gives a message a new text, as edited at a time (the editor's clock). An
 * edit older than the last one changes nothing (a replay, or one arriving
 * late). Returns whether it changed.
 */
export async function setText(db: Database, conv: string, id: string, text: string, at: number): Promise<boolean> {
  return withLock(`message:${conv}:${id}`, async () => {
    const message = await getMessage(db, conv, id);
    if (!message || (message.edited ?? 0) >= at) return false;
    const body: MessageBody = {
      text,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      ...(message.media ? { media: message.media } : {}),
      ...(message.sticker ? { sticker: message.sticker } : {}),
      ...(message.reactions ? { reactions: message.reactions } : {}),
      edited: at,
    };
    const sealed = await sealBody(db, id, body);
    const tx = db.transaction('messages', 'readwrite');
    const record = await tx.store.get([conv, id]);
    if (record) await tx.store.put({ ...record, sealed });
    await tx.done;
    return !!record;
  });
}

/** An edit that came before its message, sealed under the storage key like any text, until the message comes. */
export async function sealPendingEdit(db: Database, id: string, text: string): Promise<Uint8Array<ArrayBuffer>> {
  return sealBody(db, `edit:${id}`, { text });
}

export async function openPendingEdit(db: Database, id: string, sealed: Uint8Array<ArrayBuffer>): Promise<string> {
  return (await openBody(db, `edit:${id}`, sealed)).text;
}

/** A reaction that came before its message (by the message's ID tag), sealed under the storage key, until the message comes. */
export async function sealPendingReaction(db: Database, tag: string, e: string): Promise<Uint8Array<ArrayBuffer>> {
  return sealBody(db, `reaction:${tag}`, { text: e });
}

export async function openPendingReaction(db: Database, tag: string, sealed: Uint8Array<ArrayBuffer>): Promise<string> {
  return (await openBody(db, `reaction:${tag}`, sealed)).text;
}

/**
 * Notes that the other side had these messages of ours by `at` (their
 * clock): a receipt, a reaction or a reply named them, or `last` did. Those
 * in `read` they have read, so a sent one shows as seen (and stays so: a
 * receipt only ever marks). Their messages, and IDs not here, change
 * nothing. Returns how many now show as seen, and whether any named is one
 * of ours that's here.
 */
export async function noteHad(db: Database, conv: string, ids: string[], at: number, read: ReadonlySet<string>): Promise<{ seen: number; here: boolean }> {
  if (ids.length === 0) return { seen: 0, here: false };
  const tx = db.transaction('messages', 'readwrite');
  let seen = 0;
  let here = false;
  for (const id of new Set(ids)) {
    const record = await tx.store.get([conv, id]);
    if (!record?.out) continue;
    here = true;
    let next = record;
    if (record.had === undefined || at < record.had) next = { ...next, had: at };
    if (read.has(id) && (record.status === 'sent' || record.status === 'sending')) {
      next = { ...next, status: 'seen' };
      seen++;
    }
    if (next !== record) await tx.store.put(next);
  }
  await tx.done;
  return { seen, here };
}

/** One message of a conversation with its text, if it's on this device. */
export async function getMessage(db: Database, conv: string, id: string): Promise<MessageView | undefined> {
  const record = await db.get('messages', [conv, id]);
  if (!record) return undefined;
  const { sealed, ...rest } = record;
  return { ...rest, ...(await openBody(db, id, sealed)) };
}

/** A conversation's messages, oldest first, with their text. */
export async function listMessages(db: Database, conv: string): Promise<MessageView[]> {
  const records = await db.getAllFromIndex('messages', 'byConversation', IDBKeyRange.bound([conv, 0], [conv, Number.MAX_SAFE_INTEGER]));
  return Promise.all(
    records.map(async ({ sealed, ...rest }) => ({ ...rest, ...(await openBody(db, rest.id, sealed)) })),
  );
}

/** When one of their messages was sent, by their clock (MessageRecord.sent). */
export function sentAt(m: Pick<MessageRecord, 'at' | 'sent'>): number {
  return m.sent ?? m.at;
}

/**
 * Deletes part of a conversation from this device, with the files, in one
 * transaction: their messages sent up to `theirs` (their clock, sentAt), and
 * ours up to `ours` (our clock) or, if later, up to the newest of ours they
 * had by `oursHadBy` (their clock, MessageRecord.had) among those we wrote
 * by `oursWrittenBy` (our clock). Returns how many messages are left, how
 * many of theirs are unread, and how many went.
 */
export async function clearMessages(
  db: Database,
  conv: string,
  upTo: { theirs: number; ours?: number; oursHadBy?: number; oursWrittenBy?: number },
): Promise<{ left: number; unread: number; removed: number }> {
  const tx = db.transaction(['messages', 'media'], 'readwrite');
  const index = tx.objectStore('messages').index('byConversation');
  const range = IDBKeyRange.bound([conv, 0], [conv, Number.MAX_SAFE_INTEGER]);
  let ours = upTo.ours ?? -Infinity;
  if (upTo.oursHadBy !== undefined) {
    const writtenBy = upTo.oursWrittenBy ?? Infinity;
    for (let cursor = await index.openCursor(range); cursor; cursor = await cursor.continue()) {
      const m = cursor.value;
      if (m.out && m.at <= writtenBy && m.had !== undefined && m.had <= upTo.oursHadBy) ours = Math.max(ours, m.at);
    }
  }
  let left = 0;
  let unread = 0;
  let removed = 0;
  for (let cursor = await index.openCursor(range); cursor; cursor = await cursor.continue()) {
    const m = cursor.value;
    if (m.out ? m.at <= ours : sentAt(m) <= upTo.theirs) {
      for (const key of fileKeys(conv, m.id, m)) await tx.objectStore('media').delete(key);
      await cursor.delete();
      removed++;
    } else {
      left++;
      if (!m.out && m.status === 'received') unread++;
    }
  }
  await tx.done;
  return { left, unread, removed };
}

// Uploads to delete from the server, kept until done, so deleting survives
// the app closing halfway. Their delete secrets are sealed under the storage
// key, like the messages they came from.
const UPLOAD_DELETES = 'upload-deletes';

/** An upload to delete, with its delete secret. */
export interface UploadDelete {
  id: string;
  d: string;
}

async function readUploadDeletes(db: Database): Promise<UploadDelete[]> {
  const sealed = await getMeta<Uint8Array<ArrayBuffer>>(db, UPLOAD_DELETES);
  if (!sealed) return [];
  try {
    return JSON.parse((await openBody(db, UPLOAD_DELETES, sealed)).text) as UploadDelete[];
  } catch {
    return [];
  }
}

async function writeUploadDeletes(db: Database, list: UploadDelete[]): Promise<void> {
  if (list.length === 0) await deleteMeta(db, UPLOAD_DELETES);
  else await putMeta(db, UPLOAD_DELETES, await sealBody(db, UPLOAD_DELETES, { text: JSON.stringify(list) }));
}

/** Adds uploads to delete (each once). */
export function queueUploadDeletes(db: Database, items: UploadDelete[]): Promise<void> {
  return withLock(UPLOAD_DELETES, async () => {
    const list = await readUploadDeletes(db);
    const known = new Set(list.map((u) => u.id));
    for (const item of items) {
      if (known.has(item.id)) continue;
      known.add(item.id);
      list.push(item);
    }
    await writeUploadDeletes(db, list);
  });
}

/** The uploads still to delete. */
export function pendingUploadDeletes(db: Database): Promise<UploadDelete[]> {
  return readUploadDeletes(db);
}

/** Takes uploads off the list once they're deleted (or already gone). */
export function forgetUploadDeletes(db: Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return Promise.resolve();
  return withLock(UPLOAD_DELETES, async () => {
    const done = new Set(ids);
    await writeUploadDeletes(db, (await readUploadDeletes(db)).filter((u) => !done.has(u.id)));
  });
}
