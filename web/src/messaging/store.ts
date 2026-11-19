// Conversations and history on this device (history lives on the device only).
// Message text is encrypted under the device's storage key, a non-extractable
// AES-GCM key, and bound to the message ID. The key is kept in the same
// database, so a copy of the app's storage opens the history too
// (crypto/vault.ts).
//
// Message and conversation IDs are chosen by the other side, so they count
// only within their conversation: messages and attachments are kept by
// (conversation, message ID), and each conversation by an ID of this
// device's own. An ID that is in use elsewhere on the device then changes
// nothing the other side could notice.

import { concat, randomBytes, toBase64Url, utf8 } from '../crypto/encoding';
import type { Media, Message, Sticker } from '../protocol/message';
import {
  capEdits,
  deleteMeta,
  EDITS_LEDGER,
  editBytes,
  editsKey,
  getKey,
  getMeta,
  LEDGER_ENTRY_COST,
  MAX_UNANSWERED_EDIT_BYTES,
  putKey,
  putMeta,
  type ConversationRecord,
  type Database,
  type IdDays,
  type LedgerEntry,
  type MessageRecord,
  type PendingEdit,
  unanswered,
} from '../storage/db';
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

/** Seals a value, as JSON, under the storage key, bound to a name (a message's ID, say). */
async function seal(db: Database, name: string, value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const iv = randomBytes(IV);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(name) }, await storageKey(db), utf8(JSON.stringify(value)));
  return concat(iv, new Uint8Array(ct));
}

async function unseal<T>(db: Database, name: string, sealed: Uint8Array<ArrayBuffer>): Promise<T> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: sealed.slice(0, IV), additionalData: utf8(name) },
    await storageKey(db),
    sealed.slice(IV),
  );
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

function sealBody(db: Database, id: string, body: MessageBody): Promise<Uint8Array<ArrayBuffer>> {
  return seal(db, id, body);
}

function openBody(db: Database, id: string, sealed: Uint8Array<ArrayBuffer>): Promise<MessageBody> {
  return unseal<MessageBody>(db, id, sealed);
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
 * A conversation's edits of their messages that came before the messages
 * (oldest first): in `meta`, apart from the conversation record, which is
 * read whenever the chat list is shown and written with everything that
 * comes. At most MAX_PENDING_EDITS, MAX_PENDING_EDIT_BYTES in all.
 */
export async function getPendingEdits(db: Database, conv: string): Promise<PendingEdit[]> {
  return ((await db.get('meta', editsKey(conv))) as PendingEdit[] | undefined) ?? [];
}

/**
 * Pending edits as they are now, and as they were read: written only if
 * they changed (by identity). at: when (our clock) one of them came, if one
 * just did.
 */
export interface EditsChange {
  now: PendingEdit[];
  before: PendingEdit[];
  at?: number;
}

/** The `meta` and `conversations` stores, as a transaction gives them. */
interface MetaStore {
  get(key: string): Promise<unknown>;
  put(value: unknown, key: string): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}
interface ConversationStore {
  get(key: string): Promise<ConversationRecord | undefined>;
}

/**
 * Keeps the budget conversations we haven't answered share for their
 * pending edits (MAX_UNANSWERED_EDIT_BYTES, in EDITS_LEDGER), with `conv`'s
 * as now (shares: how much it has, and when one came if one just did; null
 * if it has none, or no longer shares it). Past it, the edits of those one
 * came to longest ago go, never `conv`'s own. Each is read first: one we
 * have answered since (our first reply takes a mailbox, and isn't written
 * here) or that's gone no longer counts, and keeps its edits. In the
 * caller's transaction.
 */
async function keepBudget(conversations: ConversationStore, meta: MetaStore, conv: string, shares: { bytes: number; at?: number } | null): Promise<void> {
  const ledger = ((await meta.get(EDITS_LEDGER)) as LedgerEntry[] | undefined) ?? [];
  const was = ledger.find((e) => e.conv === conv);
  if (!shares && !was) return;
  let next = ledger.filter((e) => e !== was);
  if (shares) next.push({ conv, bytes: shares.bytes + LEDGER_ENTRY_COST, at: shares.at ?? was?.at ?? Date.now() });
  const total = () => next.reduce((n, e) => n + e.bytes, 0);
  if (total() > MAX_UNANSWERED_EDIT_BYTES) {
    const still = await Promise.all(next.map(async (e) => e.conv === conv || unansweredHere(await conversations.get(e.conv))));
    next = next.filter((_, i) => still[i]);
    for (const e of next.filter((x) => x.conv !== conv).sort((a, b) => a.at - b.at)) {
      if (total() <= MAX_UNANSWERED_EDIT_BYTES) break;
      await meta.delete(editsKey(e.conv));
      next = next.filter((x) => x !== e);
    }
  }
  if (next.length > 0) await meta.put(next, EDITS_LEDGER);
  else await meta.delete(EDITS_LEDGER);
}

function unansweredHere(c: ConversationRecord | undefined): boolean {
  return !!c && unanswered(c);
}

/**
 * Writes a conversation and, in the same transaction, the kinds of what it
 * remembers by keyed hashes that changed from `before` (by identity), and
 * its pending edits if they changed (the newest that fit: capEdits, and in
 * one we haven't answered, within the budget those share): all of it
 * happens, or none.
 */
export async function saveConversation(
  db: Database,
  conversation: ConversationRecord,
  ids: ConversationIds = {},
  before: ConversationIds = ids,
  edits?: EditsChange,
): Promise<void> {
  const tx = db.transaction(['conversations', 'meta'], 'readwrite');
  await tx.objectStore('conversations').put(conversation);
  for (const kind of ID_KINDS) {
    if (ids[kind] === before[kind]) continue;
    const days = ids[kind];
    if (days && days.length > 0) await tx.objectStore('meta').put(days, idsKey(conversation.id, kind));
    else await tx.objectStore('meta').delete(idsKey(conversation.id, kind));
  }
  if (edits && edits.now !== edits.before) {
    const meta = tx.objectStore('meta');
    const kept = capEdits(edits.now);
    if (kept.length > 0) await meta.put(kept, editsKey(conversation.id));
    else await meta.delete(editsKey(conversation.id));
    const shares = unanswered(conversation) && kept.length > 0;
    await keepBudget(tx.objectStore('conversations'), meta, conversation.id, shares ? { bytes: editBytes(kept), ...(edits.at !== undefined ? { at: edits.at } : {}) } : null);
  }
  await tx.done;
}

/** Forgets a conversation's pending edits (it was blocked, say). */
export async function dropPendingEdits(db: Database, conv: string): Promise<void> {
  const tx = db.transaction(['conversations', 'meta'], 'readwrite');
  await tx.objectStore('meta').delete(editsKey(conv));
  await keepBudget(tx.objectStore('conversations'), tx.objectStore('meta'), conv, null);
  await tx.done;
}

/**
 * Deletes a conversation with no messages, and everything kept for it apart
 * from its record (what it remembers by keyed hashes, its pending edits), in
 * one transaction; not if a message came meanwhile. Returns whether it did.
 */
export async function dropEmptyConversation(db: Database, conv: string): Promise<boolean> {
  const tx = db.transaction(['conversations', 'meta', 'messages'], 'readwrite');
  if ((await tx.objectStore('messages').index('byConversation').openKeyCursor(allOf(conv))) !== null) {
    await tx.done;
    return false;
  }
  await tx.objectStore('conversations').delete(conv);
  for (const kind of ID_KINDS) await tx.objectStore('meta').delete(idsKey(conv, kind));
  await tx.objectStore('meta').delete(editsKey(conv));
  await deleteSentAt(tx.objectStore('meta'), conv);
  await keepBudget(tx.objectStore('conversations'), tx.objectStore('meta'), conv, null);
  await tx.done;
  return true;
}

/**
 * Their newest message here, by when they sent it (sentAt), and of those
 * sent in the same second the last taken in: for a conversation from before
 * lastMessage was kept.
 */
export async function newestTheirs(db: Database, conv: string): Promise<{ at: number; id: string } | undefined> {
  const range = IDBKeyRange.bound([conv, 0], [conv, Number.MAX_SAFE_INTEGER]);
  // Sent later; or shown later (`at`, never after it arrived); or, shown at
  // the same time, taken in later (from before that was kept: the larger ID).
  const after = (a: MessageRecord, b: MessageRecord) =>
    (sentAt(a) - sentAt(b) || a.at - b.at || (a.order ?? 0) - (b.order ?? 0) || (a.id > b.id ? 1 : -1)) > 0;
  let newest: MessageRecord | undefined;
  for (const m of await db.getAllFromIndex('messages', 'byConversation', range)) {
    if (!m.out && (!newest || after(m, newest))) newest = m;
  }
  return newest && { at: sentAt(newest), id: newest.id };
}

function sentKey(conv: string): string {
  return `sent-at:${conv}`;
}

function sentIdsKey(conv: string): string {
  return `sent-ids:${conv}`;
}

/**
 * Of how many of the last things this device sent in a conversation (of
 * any kind) it keeps the envelope's ID and time (takeSentAt): enough for a
 * run of messages, receipts, reactions and edits sent while the other side
 * writes. What they write names the newest of ours they had (`last`), and
 * shows after it (engine.ts, shownAt).
 */
export const SENT_KEPT = 10;

/** One of the last things this device sent in a conversation (takeSentAt): its envelope's ID and time. */
interface SentEnvelope {
  id: string;
  at: number;
}

/**
 * Takes the time for something this device sends in a conversation (`at`):
 * choose gets the time of the last one sent there, from this device (also
 * before a reload, and from any copy of the app), and returns the next.
 * Kept apart from the conversation, under a lock of its own: two sends at
 * once never get the same time, and a send going out (which holds the
 * conversation's lock) doesn't hold up the next one being shown. With the
 * envelope's ID, that and its time are kept too, for the last SENT_KEPT.
 */
export function takeSentAt(db: Database, conv: string, choose: (last: number | undefined) => number, id?: string): Promise<number> {
  return withLock(sentKey(conv), async () => {
    const next = choose(await getMeta<number>(db, sentKey(conv)));
    const tx = db.transaction('meta', 'readwrite');
    await tx.store.put(next, sentKey(conv));
    if (id !== undefined) {
      const kept = ((await tx.store.get(sentIdsKey(conv))) as SentEnvelope[] | undefined) ?? [];
      await tx.store.put([...kept.filter((e) => e.id !== id), { id, at: next }].slice(-SENT_KEPT), sentIdsKey(conv));
    }
    await tx.done;
    return next;
  });
}

/** The time of the last thing this device sent in a conversation (takeSentAt), if any. */
export function lastSentAt(db: Database, conv: string): Promise<number | undefined> {
  return getMeta<number>(db, sentKey(conv));
}

/** The time of something this device sent in a conversation, by its envelope's ID, if it's one of the last SENT_KEPT there (takeSentAt). */
export async function sentEnvelopeAt(db: Database, conv: string, id: string): Promise<number | undefined> {
  return ((await getMeta<SentEnvelope[]>(db, sentIdsKey(conv))) ?? []).find((e) => e.id === id)?.at;
}

/**
 * Deletes when this device last sent something in a conversation, and the
 * IDs and times of the last few things (takeSentAt), within a transaction
 * that writes `meta`: with its chat, or with its record. Whatever deletes a
 * conversation's record deletes these in the same transaction, with what it
 * remembers by keyed hashes.
 */
export function deleteSentAt(meta: { delete(key: string): Promise<unknown> }, conv: string): Promise<unknown> {
  return Promise.all([meta.delete(sentKey(conv)), meta.delete(sentIdsKey(conv))]);
}

/** Forgets when this device last sent something in a conversation, and what (deleteSentAt): its chat was deleted. */
export function forgetSentAt(db: Database, conv: string): Promise<void> {
  return withLock(sentKey(conv), async () => {
    const tx = db.transaction('meta', 'readwrite');
    await deleteSentAt(tx.store, conv);
    await tx.done;
  });
}

/** Conversations, newest activity first. */
export async function listConversations(db: Database): Promise<ConversationRecord[]> {
  return (await db.getAll('conversations')).sort((a, b) => b.lastAt - a.lastAt);
}

/** Whether a conversation has a message with this ID (another conversation's doesn't count). */
export async function hasMessage(db: Database, conv: string, id: string): Promise<boolean> {
  return (await db.getKey('messages', [conv, id])) !== undefined;
}

/**
 * The place (MessageRecord.order) of a message stored now among those of
 * its conversation with the same `at` (whole seconds, as senders date
 * them): after all of them.
 */
function placeAfter(same: MessageRecord[]): number {
  return same.reduce((last, m) => Math.max(last, m.order ?? 0), -1) + 1;
}

/**
 * Stores a message, after any of its conversation with the same `at`; with
 * `file`, its attachment too (one of ours going out), in the same
 * transaction: neither is kept without the other.
 */
export async function addMessage(db: Database, record: Omit<MessageRecord, 'sealed' | 'order'>, body: MessageBody, file?: Uint8Array<ArrayBuffer>): Promise<void> {
  const sealed = await sealBody(db, record.id, body);
  const sealedFile = file && (await sealFile(db, record.id, file));
  // Read and written in one transaction, so two stored at once don't take
  // the same place. The media store only with a file: else reads of files
  // (a chat's pictures) needn't wait for messages being stored.
  const tx = db.transaction(sealedFile ? ['messages', 'media'] : ['messages'], 'readwrite');
  const messages = tx.objectStore('messages');
  const order = placeAfter(await messages.index('byConversation').getAll([record.conv, record.at]));
  await messages.put({ ...record, order, sealed });
  if (sealedFile) await tx.objectStore('media').put(sealedFile, [record.conv, record.id]);
  await tx.done;
}

/** Whether one of our messages is still here and going out (status sending): not deleted meanwhile. */
export async function stillSending(db: Database, conv: string, id: string): Promise<boolean> {
  return (await db.get('messages', [conv, id]))?.status === 'sending';
}

/**
 * Changes one of our messages that's going out, only if it's still here
 * with status `from`: its status, its time (then it goes after any with the
 * same time), or its attachment (with the upload's fields, once uploaded).
 * Returns whether it did. A message deleted meanwhile isn't brought back,
 * and one another copy of the app sent or marked meanwhile is left as it is.
 */
export async function patchMessage(
  db: Database,
  conv: string,
  id: string,
  from: MessageRecord['status'],
  patch: { status?: MessageRecord['status']; at?: number; media?: LocalMedia },
): Promise<boolean> {
  // The lock reactions and edits take, so the body isn't written back stale.
  return withLock(`message:${conv}:${id}`, async () => {
    let sealed: Uint8Array<ArrayBuffer> | undefined;
    if (patch.media) {
      const message = await getMessage(db, conv, id);
      if (!message || message.status !== from) return false;
      const body: MessageBody = {
        text: message.text,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        media: patch.media,
        ...(message.sticker ? { sticker: message.sticker } : {}),
        ...(message.reactions ? { reactions: message.reactions } : {}),
        ...(message.edited ? { edited: message.edited } : {}),
      };
      sealed = await sealBody(db, id, body);
    }
    return updateMessage(db, conv, id, (record) =>
      record.status === from
        ? {
            ...record,
            ...(patch.status ? { status: patch.status } : {}),
            ...(patch.at !== undefined ? { at: patch.at } : {}),
            ...(sealed ? { sealed } : {}),
          }
        : null,
    );
  });
}

/** Sets a message's status; with from, only if it has that status now. */
export async function setMessageStatus(db: Database, conv: string, id: string, status: MessageRecord['status'], from?: MessageRecord['status']): Promise<void> {
  await updateMessage(db, conv, id, (record) => (from === undefined || record.status === from ? { ...record, status } : null));
}

/**
 * Changes a stored message, read and written in one transaction, so it
 * can't write back a stale copy over another change (such as its file
 * moving from where version 3 kept it). change returns null to leave it.
 * A new time puts it after the others of its conversation with that time.
 */
async function updateMessage(db: Database, conv: string, id: string, change: (record: MessageRecord) => MessageRecord | null): Promise<boolean> {
  const tx = db.transaction('messages', 'readwrite');
  const record = await tx.store.get([conv, id]);
  let next = record && change(record);
  if (next && next.at !== record!.at) next = { ...next, order: placeAfter(await tx.store.index('byConversation').getAll([conv, next.at])) };
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

/** An attachment's file sealed under the storage key, bound to its message's ID. */
async function sealFile(db: Database, id: string, file: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const iv = randomBytes(IV);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(`media:${id}`) }, await storageKey(db), file);
  return concat(iv, new Uint8Array(ct));
}

/**
 * Keeps a message's attachment on this device, sealed under the storage
 * key. With ifMessage (a file just fetched), only if the message is still
 * here, checked in the same transaction, which then also marks its file as
 * here (`local`): one deleted while its file downloaded leaves no file
 * behind. Returns whether the file was kept.
 */
export async function putMedia(db: Database, conv: string, id: string, file: Uint8Array<ArrayBuffer>, options: { ifMessage?: boolean } = {}): Promise<boolean> {
  const sealed = await sealFile(db, id, file);
  const tx = db.transaction(['messages', 'media'], 'readwrite');
  const messages = tx.objectStore('messages');
  const media = tx.objectStore('media');
  const record = await messages.get([conv, id]);
  if (options.ifMessage && !record) {
    await tx.done;
    return false;
  }
  // A file kept from before version 4 (cleared and fetched again, say) moves to the current key.
  for (const key of fileKeys(conv, id, record)) await media.delete(key);
  if (record && (record.legacyFile || options.ifMessage)) {
    const { legacyFile: _, ...rest } = record;
    await messages.put(options.ifMessage ? { ...rest, file: 'local' } : rest);
  }
  await media.put(sealed, [conv, id]);
  await tx.done;
  return true;
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
 * arriving late) changes nothing; another one from the same second (times
 * are whole seconds) replaces it, as it came later. Returns whether what's
 * shown changed.
 */
export async function setReaction(db: Database, conv: string, id: string, side: 'mine' | 'theirs', e: string, at: number): Promise<boolean> {
  return withLock(`message:${conv}:${id}`, async () => {
    const message = await getMessage(db, conv, id);
    if (!message) return false;
    const current = message.reactions?.[side];
    if (current && (current.at > at || (current.at === at && current.e === e))) return false;
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
 * late); another one from the same second (times are whole seconds)
 * replaces it, as it came later. Returns whether it changed.
 */
export async function setText(db: Database, conv: string, id: string, text: string, at: number): Promise<boolean> {
  return withLock(`message:${conv}:${id}`, async () => {
    const message = await getMessage(db, conv, id);
    if (!message || (message.edited ?? 0) > at || (message.edited === at && message.text === text)) return false;
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

function opened(db: Database, { sealed, ...rest }: MessageRecord): Promise<MessageView> {
  return openBody(db, rest.id, sealed).then((body) => ({ ...rest, ...body }));
}

/** All of a conversation's messages, in the byConversation index. */
function allOf(conv: string): IDBKeyRange {
  return IDBKeyRange.bound([conv, 0], [conv, Number.MAX_SAFE_INTEGER]);
}

/**
 * The order messages show in: by `at`, and those with the same `at` (whole
 * seconds) in the order they were written or taken in here (`order`). The
 * byConversation index gives them by `at` already, and stable sorts keep
 * that; `order` isn't in its key, so records from before it was kept stay
 * in the index.
 */
function byTime(a: Pick<MessageRecord, 'at' | 'order'>, b: Pick<MessageRecord, 'at' | 'order'>): number {
  return a.at - b.at || (a.order ?? 0) - (b.order ?? 0);
}

/** A conversation's messages, oldest first (byTime), with their text: all of them (a chat on screen shows a page: pageMessages). */
export async function listMessages(db: Database, conv: string): Promise<MessageView[]> {
  const records = (await db.getAllFromIndex('messages', 'byConversation', allOf(conv))).sort(byTime);
  return Promise.all(records.map((r) => opened(db, r)));
}

/** A conversation's messages without their text (none is opened), oldest first (byTime). */
export async function listRecords(db: Database, conv: string): Promise<MessageRecord[]> {
  return (await db.getAllFromIndex('messages', 'byConversation', allOf(conv))).sort(byTime);
}

/** The attachments of these messages: only those with a file are opened. */
export function attachmentsOf(db: Database, records: MessageRecord[]): Promise<{ out: boolean; media?: LocalMedia }[]> {
  return Promise.all(
    records
      .filter((r) => r.file !== undefined)
      .map(async (r) => {
        const { media } = await openBody(db, r.id, r.sealed);
        return { out: r.out, ...(media ? { media } : {}) };
      }),
  );
}

/** How many messages a chat shows when it opens, and how many more each time it's scrolled to the top. */
export const PAGE = 50;

/**
 * A page of a conversation's messages, oldest first (byTime), with their
 * text: its newest `count`; or, with `since`, all from then on (by `at`),
 * but no more than `most` (the newest). And whether it has older ones.
 * Which are newest within a second goes by `order`, which the index doesn't
 * know, so the whole second at the cut-off is read to choose. Only those
 * shown are opened, so a chat flooded with thousands opens as fast as one
 * with a few.
 */
export async function pageMessages(
  db: Database,
  conv: string,
  { count = PAGE, since, most = Infinity }: { count?: number; since?: number; most?: number } = {},
): Promise<{ messages: MessageView[]; more: boolean }> {
  const tx = db.transaction('messages');
  const index = tx.store.index('byConversation');
  let records: MessageRecord[] = [];
  let more: boolean;
  if (since !== undefined) {
    records = (await index.getAll(IDBKeyRange.bound([conv, since], [conv, Number.MAX_SAFE_INTEGER]))).sort(byTime);
    more = (await index.openKeyCursor(IDBKeyRange.bound([conv, 0], [conv, since], false, true), 'prev')) !== null;
    if (records.length > most) {
      records = records.slice(-most);
      more = true;
    }
  } else {
    let cursor = await index.openCursor(allOf(conv), 'prev');
    for (; cursor && records.length < count; cursor = await cursor.continue()) records.push(cursor.value);
    // And the rest of the oldest second read: the newest of it are chosen below.
    const edge = records.at(-1)?.at;
    for (; cursor && cursor.value.at === edge; cursor = await cursor.continue()) records.push(cursor.value);
    records.sort(byTime);
    more = cursor !== null || records.length > count;
    records = records.slice(-count);
  }
  await tx.done;
  return { messages: await Promise.all(records.map((r) => opened(db, r))), more };
}

/** A conversation's messages with one status, up to a time (`at`), in the byStatus index. */
function withStatus(conv: string, status: MessageRecord['status'], upTo = Infinity): IDBKeyRange {
  return IDBKeyRange.bound([conv, status, -Infinity], [conv, status, upTo]);
}

/**
 * Our messages in a conversation still going out, or failed (to send
 * again), written up to a time (that second included), oldest first
 * (byTime), with their text, but those in `shown`: found by the index, so
 * only they are opened.
 */
export async function unsentBefore(db: Database, conv: string, upTo: number, shown: ReadonlySet<string> = new Set()): Promise<MessageView[]> {
  const keys = [
    ...(await db.getAllKeysFromIndex('messages', 'byStatus', withStatus(conv, 'sending', upTo))),
    ...(await db.getAllKeysFromIndex('messages', 'byStatus', withStatus(conv, 'failed', upTo))),
  ].filter((key) => !shown.has(key[1]));
  const records = (await Promise.all(keys.map((key) => db.get('messages', key)))).filter((m): m is MessageRecord => !!m?.out);
  return Promise.all(records.sort(byTime).map((r) => opened(db, r)));
}

/** The IDs of their messages in a conversation not marked read yet. Only the index is read. */
export async function unreadIds(db: Database, conv: string): Promise<string[]> {
  return (await db.getAllKeysFromIndex('messages', 'byStatus', withStatus(conv, 'received'))).map((key) => key[1]);
}

/**
 * Their messages in a conversation not marked read yet: all their IDs, and
 * the newest `count` (byTime, oldest first), for a receipt to name. Only the
 * index is read, but for the newest and the rest of the oldest second of
 * them (`order` decides within a second).
 */
export async function unread(db: Database, conv: string, count: number): Promise<{ ids: string[]; newest: string[] }> {
  const ids = await unreadIds(db, conv);
  if (ids.length <= count) {
    if (ids.length <= 1) return { ids, newest: ids };
    const records = (await Promise.all(ids.map((id) => db.get('messages', [conv, id])))).filter((m): m is MessageRecord => !!m);
    return { ids, newest: records.sort(byTime).map((m) => m.id) };
  }
  const tx = db.transaction('messages');
  const records: MessageRecord[] = [];
  let cursor = await tx.store.index('byStatus').openCursor(withStatus(conv, 'received'), 'prev');
  for (; cursor && records.length < count; cursor = await cursor.continue()) records.push(cursor.value);
  const edge = records.at(-1)?.at;
  for (; cursor && cursor.value.at === edge; cursor = await cursor.continue()) records.push(cursor.value);
  await tx.done;
  return { ids, newest: records.sort(byTime).slice(-count).map((m) => m.id) };
}

/** Sets these messages' status, in one transaction; with from, only of those that have that status now. */
export async function setStatuses(db: Database, conv: string, ids: string[], status: MessageRecord['status'], from?: MessageRecord['status']): Promise<void> {
  const tx = db.transaction('messages', 'readwrite');
  // Asked for all at once: one by one, a chat flooded with thousands takes long.
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      const record = await tx.store.get([conv, id]);
      if (record && record.status !== status && (from === undefined || record.status === from)) await tx.store.put({ ...record, status });
    }),
  );
  await tx.done;
}

/**
 * A receipt saying they read the earlier messages too (`earlier`): ours
 * written up to `upTo` (our clock; that second too, since times are whole
 * seconds) that show as sent now show as seen. Returns how many.
 */
export async function noteSeenBefore(db: Database, conv: string, upTo: number): Promise<number> {
  let seen = 0;
  const tx = db.transaction('messages', 'readwrite');
  // Found by the index: only those it marks are read.
  const keys = await tx.store.index('byStatus').getAllKeys(withStatus(conv, 'sent', upTo));
  await Promise.all(
    keys.map(async (key) => {
      const m = await tx.store.get(key);
      if (!m?.out || m.status !== 'sent') return;
      await tx.store.put({ ...m, status: 'seen' });
      seen++;
    }),
  );
  await tx.done;
  return seen;
}

/** What the chat list shows of a conversation's newest message: who wrote it, and the start of it. */
export interface PreviewView {
  out: boolean;
  text: string;
  media?: { t: string; n?: string; m?: string };
  sticker?: Sticker;
}

/** How much of a text a preview keeps, in characters: the list shows a line. */
const PREVIEW_CHARS = 200;

function previewName(conv: string, id: string): string {
  return `preview:${conv}:${id}`;
}

/** The ID of a conversation's newest message, if it has any: only the index is read (and the records of its second, if it shares that). */
async function newestId(db: Database, conv: string): Promise<string | undefined> {
  const index = db.transaction('messages').store.index('byConversation');
  const cursor = await index.openKeyCursor(allOf(conv), 'prev');
  if (!cursor) return undefined;
  // More than one in its second: `order` decides, which only the records hold.
  const second = IDBKeyRange.only(cursor.key);
  if ((await index.count(second)) === 1) return (cursor.primaryKey as [string, string])[1];
  return (await index.getAll(second)).sort(byTime).at(-1)!.id;
}

/**
 * A conversation with its preview (ConversationRecord.preview) of its newest
 * message as stored now. The same object if it has that one's already,
 * unless that's `touched` (its text changed): then it's sealed again.
 */
export async function withPreview(db: Database, c: ConversationRecord, touched?: string): Promise<ConversationRecord> {
  const newest = await newestId(db, c.id);
  if (newest === undefined) return c.preview === null ? c : { ...c, preview: null };
  if (c.preview?.id === newest && touched !== newest) return c;
  const record = await db.get('messages', [c.id, newest]);
  if (!record) return c;
  const body = await openBody(db, newest, record.sealed);
  const shown: PreviewView = {
    out: record.out,
    text: Array.from(body.text).slice(0, PREVIEW_CHARS).join(''),
    ...(body.media ? { media: { t: body.media.t, ...(body.media.n ? { n: body.media.n } : {}), ...(body.media.m ? { m: body.media.m } : {}) } } : {}),
    ...(body.sticker ? { sticker: body.sticker } : {}),
  };
  return { ...c, preview: { id: newest, sealed: await seal(db, previewName(c.id, newest), shown) } };
}

/**
 * What the chat list shows of a conversation's newest message, null if it
 * has none: its preview, and for one of ours its status (the ticks). A
 * conversation from before previews were kept gets one, kept from then on;
 * so does one whose preview names a message that's gone (a change that
 * didn't reach the preview).
 */
export async function lastShown(db: Database, c: ConversationRecord): Promise<(PreviewView & { status?: MessageRecord['status'] }) | null> {
  let preview = c.preview === undefined ? await fillPreview(db, c) : c.preview;
  for (let tries = 0; preview; tries++) {
    const shown = await unseal<PreviewView>(db, previewName(c.id, preview.id), preview.sealed);
    // Its message still here: ours read for its status, theirs only by its key.
    const status = shown.out ? (await db.get('messages', [c.id, preview.id]))?.status : undefined;
    const here = shown.out ? status !== undefined : (await db.getKey('messages', [c.id, preview.id])) !== undefined;
    if (here || tries > 0) return { ...shown, ...(status ? { status } : {}) };
    preview = await fillPreview(db, c);
  }
  return null;
}

/** Makes a conversation's preview afresh and keeps it, unless the record's changed meanwhile (it then has its own). */
async function fillPreview(db: Database, c: ConversationRecord): Promise<NonNullable<ConversationRecord['preview']> | null> {
  const { preview: _, ...unknown } = c;
  const preview = (await withPreview(db, unknown)).preview ?? null;
  const tx = db.transaction('conversations', 'readwrite');
  const now = await tx.store.get(c.id);
  if (now && samePreview(now.preview, c.preview)) await tx.store.put({ ...now, preview });
  await tx.done;
  return preview;
}

function samePreview(a: ConversationRecord['preview'], b: ConversationRecord['preview']): boolean {
  if (!a || !b) return a === b;
  return a.id === b.id && a.sealed.length === b.sealed.length && a.sealed.every((x, i) => x === b.sealed[i]);
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

// Upkeep's sweep for what a change that stopped halfway (the app closed, or
// storage refused a write), in this version or an older one, can leave with
// nothing to show it and nothing else to delete it: messages whose
// conversation isn't here, and files whose message isn't. Only on this
// device: an upload such a message names stays on the server, since its
// envelope, taken in again, may have brought the same message into a
// conversation that is here. Files kept under the message ID alone, from
// before version 4, are left: nothing stores files so any more.
//
// In two passes: what one upkeep finds is noted (SweepState), and deleted
// only if a later upkeep, at least SWEEP_GRACE_MS after, finds it still
// stray. So nothing a write under way leaves for a moment is deleted, from
// this version or from an older copy of the app open at the same time
// (same database version): this one writes a file with its message, and a
// conversation before its messages (addMessage, putMedia ifMessage,
// receive), but version 2.4.0 writes a file it sends before its message,
// and a first message before its conversation, in separate transactions.
// On top of that, a conversation's messages go only under its lock, which
// taking messages in holds (where the engine has Web Locks, across copies),
// and each is looked at again in the transaction that deletes it.

/** How long something stays stray before the sweep deletes it. */
export const SWEEP_GRACE_MS = 60 * 60_000;
/**
 * How many files one sweep looks at: those after where the last stopped,
 * going round to the start, so a big media store is looked at a part at a
 * time, in a short transaction.
 */
export const SWEEP_SCAN = 1000;
/** The most strays of each kind the sweep keeps track of; any more are found again later. */
export const SWEEP_KEPT = 1000;

const SWEEP = 'sweep';

/**
 * What the sweep found stray, with when (our clock) it first did, and where
 * its look through the files goes on (the last key it looked at; none: the
 * start). Keys only, nothing of what they hold, in `meta`.
 */
export interface SweepState {
  convs: { id: string; seen: number }[];
  files: { key: [string, string]; seen: number }[];
  after?: [string, string];
}

function isFileKey(value: unknown): value is [string, string] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string';
}

/** The sweep's notes (none if there are none, or they can't be read). */
export async function getSweep(db: Database): Promise<SweepState> {
  const kept = await getMeta<Partial<SweepState>>(db, SWEEP);
  const seen = (x: { seen?: unknown }) => typeof x.seen === 'number' && Number.isFinite(x.seen);
  const convs = Array.isArray(kept?.convs) ? kept.convs.filter((c) => !!c && typeof c.id === 'string' && seen(c)) : [];
  const files = Array.isArray(kept?.files) ? kept.files.filter((f) => !!f && isFileKey(f.key) && seen(f)) : [];
  return { convs, files, ...(isFileKey(kept?.after) ? { after: kept.after } : {}) };
}

export async function putSweep(db: Database, state: SweepState): Promise<void> {
  if (state.convs.length === 0 && state.files.length === 0 && !state.after) await deleteMeta(db, SWEEP);
  else await putMeta(db, SWEEP, state);
}

/**
 * The conversations that messages are kept under but that aren't here. Only
 * keys are read, and one step per conversation: the index is skipped past
 * all of one's messages at once.
 */
export async function strayConversations(db: Database): Promise<string[]> {
  const tx = db.transaction(['conversations', 'messages']);
  const here = new Set(await tx.objectStore('conversations').getAllKeys());
  const strays: string[] = [];
  let cursor = await tx.objectStore('messages').index('byConversation').openKeyCursor();
  while (cursor) {
    const conv = cursor.key[0];
    if (!here.has(conv)) strays.push(conv);
    // Past every time of this conversation's: arrays sort after numbers.
    cursor = await cursor.continue([conv, []] as unknown as [string, number]);
  }
  await tx.done;
  return strays;
}

/**
 * Deletes up to `most` messages of a conversation that isn't here, with
 * their files, in one transaction; none if the conversation is here (by
 * now). Returns how many went.
 */
export async function dropStrayMessages(db: Database, conv: string, most: number): Promise<number> {
  const tx = db.transaction(['conversations', 'messages', 'media'], 'readwrite');
  let removed = 0;
  if ((await tx.objectStore('conversations').getKey(conv)) === undefined) {
    let cursor = await tx.objectStore('messages').index('byConversation').openCursor(allOf(conv));
    for (; cursor && removed < most; cursor = await cursor.continue()) {
      for (const key of fileKeys(conv, cursor.value.id, cursor.value)) await tx.objectStore('media').delete(key);
      await cursor.delete();
      removed++;
    }
  }
  await tx.done;
  return removed;
}

/**
 * The files whose message isn't here, of up to `count` after `after` (from
 * the start without it), and the last key looked at, if there may be more
 * after it (none: it reached the end). Only keys are read, all looked up at
 * once, in one short transaction.
 */
export async function strayFiles(
  db: Database,
  after: [string, string] | undefined,
  count: number,
): Promise<{ strays: [string, string][]; last?: [string, string] }> {
  const tx = db.transaction(['media', 'messages']);
  // Array keys only: those from before version 4 are strings, which sort first.
  const range = after ? IDBKeyRange.lowerBound(after, true) : IDBKeyRange.lowerBound([]);
  const keys = (await tx.objectStore('media').getAllKeys(range, count)) as [string, string][];
  const found = await Promise.all(keys.map((key) => tx.objectStore('messages').getKey(key)));
  await tx.done;
  const strays = keys.filter((_, i) => found[i] === undefined);
  return keys.length === count && count > 0 ? { strays, last: keys.at(-1)! } : { strays };
}

/**
 * Deletes these files, each only if its message still isn't here (checked
 * in the same transaction). Returns how many went.
 */
export async function dropStrayFiles(db: Database, keys: [string, string][]): Promise<number> {
  if (keys.length === 0) return 0;
  const tx = db.transaction(['media', 'messages'], 'readwrite');
  const gone = await Promise.all(
    keys.map(async (key) => {
      if ((await tx.objectStore('messages').getKey(key)) !== undefined) return false;
      if ((await tx.objectStore('media').getKey(key)) === undefined) return false;
      await tx.objectStore('media').delete(key);
      return true;
    }),
  );
  await tx.done;
  return gone.filter(Boolean).length;
}

// Uploads to delete from the server, kept until done, so deleting survives
// the app closing halfway. Their delete secrets are sealed under the storage
// key, like the messages they came from.
const UPLOAD_DELETES = 'upload-deletes';

/** An upload to delete, with its delete secret. */
export interface UploadDelete {
  id: string;
  d: string;
  /**
   * One of ours, deleted just after it was made (its message was deleted
   * while it went out): the server looks uploads up from a copy that can lag
   * a moment behind, so the first not_found is asked again later.
   */
  recent?: true;
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

/** Marks uploads asked for once (no longer `recent`): a not_found for them now means gone. */
export function triedUploadDeletes(db: Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return Promise.resolve();
  return withLock(UPLOAD_DELETES, async () => {
    const tried = new Set(ids);
    const list = (await readUploadDeletes(db)).map((u) => {
      if (!tried.has(u.id)) return u;
      const { recent: _, ...rest } = u;
      return rest;
    });
    await writeUploadDeletes(db, list);
  });
}

/** Takes uploads off the list once they're deleted (or already gone). */
export function forgetUploadDeletes(db: Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return Promise.resolve();
  return withLock(UPLOAD_DELETES, async () => {
    const done = new Set(ids);
    await writeUploadDeletes(db, (await readUploadDeletes(db)).filter((u) => !done.has(u.id)));
  });
}

// Envelopes through a link that came before the message starting their
// conversation: an edit, reaction or delete of the sender's that overtook it
// (the inbox gives envelopes in no set order). They start no conversation,
// so someone with the link can't fill the device with hidden ones; a few are
// kept here instead, sealed under the storage key, and taken in when that
// message starts the conversation (or forgotten once it can no longer come).
const EARLY = 'early-envelopes';
/**
 * The most edits and reactions kept so, in number and in bytes (as JSON):
 * past either, the oldest go. Deletes have a budget of their own, so a
 * flood of big edits (from anyone with the link) can't push out a delete,
 * which would let the deleted message show; one names at most 100 IDs,
 * about 2.5 KB.
 */
export const MAX_EARLY = 50;
export const MAX_EARLY_BYTES = 64 * 1024;
export const MAX_EARLY_DELETES = 50;
export const MAX_EARLY_DELETE_BYTES = 32 * 1024;

/** An envelope kept for a conversation not started yet: the link it came through, and what it said (its `conv` and `from` say which conversation). */
interface Early {
  link: string;
  message: Message;
}

async function readEarly(db: Database): Promise<Early[]> {
  const sealed = await getMeta<Uint8Array<ArrayBuffer>>(db, EARLY);
  if (!sealed) return [];
  try {
    return await unseal<Early[]>(db, EARLY, sealed);
  } catch {
    return [];
  }
}

async function writeEarly(db: Database, list: Early[]): Promise<void> {
  if (list.length === 0) await deleteMeta(db, EARLY);
  else await putMeta(db, EARLY, await seal(db, EARLY, list));
}

/** Whether a kept envelope is for the conversation through `link` with this wire ID, started from this key. */
function earlyMatch(e: Early, link: string, wire: string, from: string): boolean {
  return e.link === link && e.message.conv === wire && e.message.from === from;
}

/**
 * Keeps an envelope for a conversation through a link that hasn't started
 * yet. Those sent before `since` go (their message can no longer come), and
 * past their kind's budget (MAX_EARLY and MAX_EARLY_BYTES, or for deletes
 * MAX_EARLY_DELETES and MAX_EARLY_DELETE_BYTES) the oldest of that kind go.
 */
export function keepEarly(db: Database, link: string, message: Message, since: number): Promise<void> {
  return withLock(EARLY, async () => {
    const list = (await readEarly(db)).filter((e) => e.message.at >= since && !(earlyMatch(e, link, message.conv, message.from) && e.message.id === message.id));
    list.push({ link, message });
    const size = (e: Early) => utf8(JSON.stringify(e)).length + 1;
    const deletes = message.kind === 'delete';
    const [count, most] = deletes ? [MAX_EARLY_DELETES, MAX_EARLY_DELETE_BYTES] : [MAX_EARLY, MAX_EARLY_BYTES];
    const same = list.filter((e) => (e.message.kind === 'delete') === deletes);
    let bytes = same.reduce((n, e) => n + size(e), 0);
    const gone = new Set<Early>();
    while (same.length - gone.size > count || bytes > most) {
      const oldest = same[gone.size]!;
      gone.add(oldest);
      bytes -= size(oldest);
    }
    await writeEarly(db, gone.size > 0 ? list.filter((e) => !gone.has(e)) : list);
  });
}

/** The envelopes kept for the conversation through `link` with this wire ID, started from this key, sent from `since` on: oldest first. */
export async function earlyFor(db: Database, link: string, wire: string, from: string, since: number): Promise<Message[]> {
  return (await readEarly(db))
    .filter((e) => earlyMatch(e, link, wire, from) && e.message.at >= since)
    .map((e) => e.message)
    .sort((a, b) => a.at - b.at);
}

/** Forgets the envelopes kept that were sent before `since`, and those for one conversation (taken in now). */
export function forgetEarly(db: Database, since: number, taken?: { link: string; wire: string; from: string }): Promise<void> {
  return withLock(EARLY, async () => {
    const list = await readEarly(db);
    const kept = list.filter((e) => e.message.at >= since && !(taken && earlyMatch(e, taken.link, taken.wire, taken.from)));
    if (kept.length !== list.length) await writeEarly(db, kept);
  });
}
