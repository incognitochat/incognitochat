// On-device storage (IndexedDB). Never localStorage: it can't hold CryptoKeys
// and some webviews clear it on their own.
//
// CryptoKeys live in their own store under explicit string keys, with no
// indexes: a WebKit bug breaks index queries on records that contain a
// CryptoKey. Each schema change is a new version with its own upgrade step.

import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb';

export const DB_NAME = 'incognitochat';
export const DB_VERSION = 5;

export interface StoredKeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

interface Schema extends DBSchema {
  /** CryptoKeys and key pairs: device keys, the vault key, working copies. */
  keys: { key: string; value: CryptoKey | StoredKeyPair };
  /** Sealed copyable keys (see crypto/vault.ts). */
  vault: { key: string; value: Uint8Array<ArrayBuffer> };
  /** Small app state: account and device IDs, settings. */
  meta: { key: string; value: unknown };
  /** Conversations (messaging/store.ts), by their ID on this device; byWire finds one started through our link. */
  conversations: { key: string; value: ConversationRecord; indexes: { byWire: [string, string] } };
  /**
   * Message history, by conversation and message ID, text encrypted under
   * the device's storage key (messaging/store.ts).
   */
  messages: { key: [string, string]; value: MessageRecord; indexes: { byConversation: [string, number]; byStatus: [string, string, number] } };
  /**
   * Attachments on this device, by conversation and message ID, encrypted
   * under the storage key (messaging/store.ts). Files from before version 4
   * stay under their message ID alone (see MessageRecord.legacyFile).
   */
  media: { key: [string, string] | string; value: Uint8Array<ArrayBuffer> };
}

/**
 * A conversation, as kept on the device.
 *
 * Its ID here is its own, never sent: the ID in messages (wire) is chosen by
 * whoever started it, so two conversations may share one. Messages are kept
 * by conversation, too: an ID one conversation shares with another changes
 * nothing in either.
 */
export interface ConversationRecord {
  /** This device's ID for it. Conversations from before version 4 keep their wire ID here. */
  id: string;
  /** Its ID in messages (`conv`), chosen by whoever started it. */
  wire: string;
  /** owner: someone wrote to our link; sender: we wrote to someone's link. */
  role: 'owner' | 'sender';
  /** The link the conversation came through. */
  link: { id: string; fingerprint: string };
  label: string;
  /** The other side's current public key (65 bytes, base64url): for a sender before any reply, the link's key. */
  peerKey: string;
  /** Our current conversation public key; null for an owner who hasn't replied yet. */
  myKey: string | null;
  /** The mailbox we write to. */
  sendTo: string;
  /**
   * The mailbox they write to us at; null for an owner who hasn't replied yet
   * (they write to the link's intro mailbox). Envelopes written for our keys
   * here count only through it, through the link's intro mailbox until
   * introUntil (an owner's), or through one of formerMailboxes.
   */
  myMailbox: string | null;
  /**
   * For an owner: the intro mailbox of the link it came through, where their
   * first message arrived. Kept here so it counts without asking the link,
   * which may be revoked or replaced since. Missing in conversations from
   * before it was kept, until upkeep copies it from the link.
   */
  intro?: string;
  /**
   * For an owner: until when (Unix ms) the intro mailbox of the link it came
   * through counts for it. They write there until they hear of our mailbox,
   * and that may wait in the inbox: set to 31 days after something first came
   * through myMailbox. Missing (as in conversations from before it was kept):
   * it counts.
   */
  introUntil?: number;
  /**
   * Mailboxes of ours this conversation moved on from (an unblock, or one the
   * server lost): they wrote there until our next message told them. Each
   * counts until `until` (Unix ms), set like introUntil; missing until then.
   */
  formerMailboxes?: { id: string; until?: number }[];
  /** Unix ms of the latest message, for ordering. */
  lastAt: number;
  unread: number;
  /** blocked: our mailbox is discarded and anything more from them is dropped. */
  status: 'active' | 'ended' | 'blocked';
  /**
   * Being unblocked: we've moved off the discarded mailbox, but the quiet key
   * update telling them our new one hasn't gone out yet. It stays blocked
   * until it has; unblocking again sends it.
   */
  unblocking?: true;
  /** For an owner: the sender's tag (base64url), to block the person and not just this conversation. */
  tag?: string;
  /**
   * For an owner: the key their first message came from. With the link and
   * the wire ID, it tells this conversation apart from any other someone
   * starts through our link with the same ID. Missing for one from before
   * version 4 that we had answered (their key may have changed since): that
   * one is the only one with its wire ID on its link.
   */
  firstKey?: string;
  /**
   * The ID of the newest envelope of theirs taken in (newest by its `at`,
   * as `newest` orders them), named as `last` in what we send.
   */
  lastReceived: string | null;
  /**
   * The newest envelope of theirs taken in: its `at` (their clock) and its
   * keyed hash (idTag). Only an envelope newer than this changes peerKey,
   * sendTo and lastReceived, so one that comes late or again can't move us
   * back to an older key or mailbox. Of envelopes from the same second
   * (times are whole seconds), the one taken in last counts as newer.
   * Missing in conversations from before it was kept, until something
   * comes.
   */
  newest?: { at: number; tag: string };
  /**
   * The newest of their messages taken in (shown), by its `at` (their
   * clock), with its ID: deleting the conversation for both sides names it
   * as `last`, so their app deletes exactly the messages of its own we had,
   * and clears this side up to its time. Kept even once deleted here.
   * Missing in conversations from before it was kept; their newest message
   * here stands in.
   */
  lastMessage?: { at: number; id: string };
  /**
   * Out of the list, with no messages, until a message comes or goes:
   * deleted on this device, cleared by their delete of the whole
   * conversation, or started by a message that was dropped (deleted or
   * cleared before it came). One someone started through our link that we
   * never opened or answered goes once nothing more can come for it
   * (upkeep); one we opened stays, so it comes back if either side writes
   * again.
   */
  hidden?: boolean;
  /**
   * The user opened it here. Missing in conversations from before it was
   * kept: of those, one opened shows it by our key, which its "seen" made.
   */
  opened?: true;
  /**
   * What the chat list shows of the newest message: its ID, and its start
   * (who wrote it, the text, what attachment or sticker), sealed under the
   * storage key like message text (messaging/store.ts), so the list opens
   * one small item per chat. null: no messages. Missing in conversations
   * from before it was kept, until the list fills it in.
   */
  preview?: { id: string; sealed: Uint8Array<ArrayBuffer> } | null;
  /** Unix ms when our conversation key is next replaced (weekly, jittered per conversation). */
  rotateAt?: number;
  /** For a sender not answered yet: Unix ms when the link's current key was last fetched. */
  linkCheckedAt?: number;
  /**
   * Kept by versions before IDs were remembered as keyed hashes: their
   * messages they deleted for both sides before those arrived, by ID, with
   * when. Still read, and moved into their deletes (messaging/store.ts,
   * `gone`) when something comes, when the conversation is deleted, or at
   * upkeep.
   */
  deleted?: { id: string; at: number }[];
  /**
   * The conversation was cleared for both sides up to this time (their
   * clock): by their delete of the whole conversation, or by ours (then the
   * time of their newest message we had, lastMessage). Anything of theirs
   * sent by then that arrives later is dropped, and so is a whole-
   * conversation delete of theirs from no later. Forgotten once nothing
   * that old can still arrive (31 days).
   */
  clearedBefore?: number;
  /**
   * Their latest delete of the whole conversation: its `at` (their clock),
   * when we took it in (our clock, or the time of the last thing we sent
   * there, if later), and, if its `last` named one of our messages, that
   * message's time (our clock). Something of theirs from by then that shows
   * they had more of ours takes those too, but never one we wrote after
   * taking the delete in, nor one newer than the message `last` named:
   * their app names the newest of ours it had. Forgotten with it.
   */
  theirClear?: { upTo: number; here: number; ours?: number };
  /**
   * Their messages sent up to this time (their clock) are dropped: set only
   * if the user deleted more of them here than are remembered one by one
   * (replay.ts, MAX_DROPPED), to the end of the day the oldest went from.
   * Forgotten after 31 days.
   */
  droppedBefore?: number;
  /**
   * Their reactions to messages that weren't here yet (one of theirs still
   * on its way), sealed under the storage key, by the message's keyed hash
   * (idTag): applied when it comes. The newest per message.
   */
  reactions?: { tag: string; at: number; sealed: Uint8Array<ArrayBuffer> }[];
}

/**
 * An edit of one of their messages that came before the message did, sealed
 * under the storage key (messaging/store.ts). Kept in `meta`, apart from the
 * conversation record (editsKey), since version 5.
 */
export interface PendingEdit {
  id: string;
  /** The edit's `at` (their clock). */
  at: number;
  sealed: Uint8Array<ArrayBuffer>;
}

/** The most edits waiting for their messages that a conversation keeps: in number, and in bytes sealed. */
export const MAX_PENDING_EDITS = 20;
export const MAX_PENDING_EDIT_BYTES = 64 * 1024;

/** Where a conversation's edits waiting for their messages are kept in `meta`. */
export function editsKey(conv: string): string {
  return `edits:${conv}`;
}

/** The newest edits (the last ones) that fit in MAX_PENDING_EDITS and MAX_PENDING_EDIT_BYTES, oldest first. */
export function capEdits(edits: PendingEdit[]): PendingEdit[] {
  let bytes = 0;
  let from = edits.length;
  while (from > 0 && edits.length - from < MAX_PENDING_EDITS) {
    const next = bytes + edits[from - 1]!.sealed.length;
    if (next > MAX_PENDING_EDIT_BYTES) break;
    bytes = next;
    from--;
  }
  return from === 0 ? edits : edits.slice(from);
}

/** How much a conversation's pending edits take, sealed. */
export function editBytes(edits: PendingEdit[]): number {
  return edits.reduce((n, e) => n + e.sealed.length, 0);
}

/**
 * Conversations someone started through our link that we haven't answered
 * share one budget for their pending edits, MAX_UNANSWERED_EDIT_BYTES in
 * all, so starting many can't fill the device. EDITS_LEDGER, in `meta`,
 * lists those that have some: how many bytes (with LEDGER_ENTRY_COST for
 * the entry itself, so the list is bounded too), and when (our clock) one
 * last came, which decides whose go first (messaging/store.ts).
 */
export const MAX_UNANSWERED_EDIT_BYTES = 64 * 1024;
export const LEDGER_ENTRY_COST = 256;
export const EDITS_LEDGER = 'edits-unanswered';
export interface LedgerEntry {
  conv: string;
  bytes: number;
  /** Unix ms, our clock. */
  at: number;
}

/**
 * Whether a conversation's pending edits share that budget: someone wrote to
 * our link, and we never took a mailbox for it (none now, none it moved on
 * from, and not being unblocked). Our first reply takes one.
 */
export function unanswered(c: Pick<ConversationRecord, 'role' | 'myMailbox' | 'formerMailboxes' | 'unblocking'>): boolean {
  return c.role === 'owner' && c.myMailbox === null && !c.unblocking && !c.formerMailboxes?.length;
}

/**
 * IDs remembered without keeping them: keyed hashes (messaging/secret.ts,
 * idTag), by the UTC day (Unix ms / 86,400,000, rounded down) that decides
 * when they can be forgotten. Oldest day first.
 */
export type IdDays = { day: number; tags: string[] }[];

/** A message, as kept on the device. Only its text is sealed; times and status are local metadata. */
export interface MessageRecord {
  /** Its ID in messages, chosen by whoever wrote it: unique only within its conversation. */
  id: string;
  /** The conversation's ID on this device. */
  conv: string;
  /**
   * Unix ms shown: the sender's time, but never later than when it arrived.
   * Whole seconds from versions that date messages by the server's clock
   * (net/clock.ts), milliseconds before.
   */
  at: number;
  /**
   * Its place among the conversation's messages with the same `at` (0 for
   * the first): they show in the order they were written or taken in here.
   * Missing (0) in messages stored before it was kept.
   */
  order?: number;
  /**
   * Theirs: when they sent it, by their clock (its `at` on the wire), where
   * that's later than `at` (their clock runs ahead of ours). A delete of the
   * whole conversation, also timed by their clock, is compared with this.
   */
  sent?: number;
  /**
   * Ours: the earliest time, by their clock, that something of theirs showed
   * they had it (a receipt, a reaction or a reply to it, or `last` naming
   * it). A delete of the whole conversation of theirs from then on takes it,
   * and our older messages, here too.
   */
  had?: number;
  out: boolean;
  /** Ours: sending, sent, failed, then seen once they open it. Theirs: received, then read once we told them. */
  status: 'sending' | 'sent' | 'failed' | 'seen' | 'received' | 'read';
  /**
   * An attachment's file: on this device, still to fetch, cleared from this
   * device (fetched again only on a tap, while the server keeps it), gone
   * (the server no longer has it: expired, or deleted), or broken (the
   * bucket refused it, or it wasn't what the message says: another size, or
   * it didn't decrypt; tried again only on a tap).
   */
  file?: 'local' | 'remote' | 'cleared' | 'gone' | 'broken';
  /** AES-GCM under the storage key: nonce ‖ ciphertext of {text, replyTo}. */
  sealed: Uint8Array<ArrayBuffer>;
  /**
   * Its file is in the media store under its message ID alone, as version 3
   * kept it (IDs were unique on the device then): the upgrade leaves files
   * where they are, since moving them would need as much space again, and
   * marks only messages whose file was on the device ('local'). Until the
   * file goes or moves; any file stored since is under (conversation,
   * message ID), and deleting a marked message's file deletes both.
   */
  legacyFile?: true;
}

export type Database = IDBPDatabase<Schema>;

/** Why the database couldn't be opened. */
export class StorageError extends Error {
  /**
   * failed: it couldn't be opened or upgraded (often, no space left), and is
   * as it was; newer: a newer version of the app has upgraded it already.
   */
  readonly kind: 'failed' | 'newer';
  constructor(kind: StorageError['kind'], cause: unknown) {
    super(`storage: ${kind}`, { cause });
    this.name = 'StorageError';
    this.kind = kind;
  }
}

type Upgrade = (db: IDBPDatabase<Schema>, tx: IDBPTransaction<Schema, StoreNames<Schema>[], 'versionchange'>) => void | Promise<void>;

// Each step's schema changes come before anything it awaits, and it awaits
// only the upgrade's own requests, so the upgrade stays one transaction:
// all of it happens, or none.
const upgrades: Upgrade[] = [
  // Version 1.
  (db) => {
    db.createObjectStore('keys');
    db.createObjectStore('vault');
    db.createObjectStore('meta');
  },
  // Version 2: messaging.
  (db) => {
    db.createObjectStore('conversations', { keyPath: 'id' });
    const messages = db.createObjectStore('messages', { keyPath: 'id' });
    messages.createIndex('byConversation', ['conv', 'at']);
  },
  // Version 3: attachments.
  (db) => {
    db.createObjectStore('media');
  },
  // Version 4: IDs count only within their conversation.
  (db, tx) => scopeIds(db as unknown as IDBPDatabase, tx as unknown as IDBPTransaction<unknown, string[], 'versionchange'>),
  // Version 5: edits waiting for their messages move off the conversation
  // record; messages can be found by status without reading them.
  (_db, tx) => {
    tx.objectStore('messages').createIndex('byStatus', ['conv', 'status', 'at']);
    return moveEdits(tx as unknown as IDBPTransaction<unknown, string[], 'versionchange'>);
  },
];

/**
 * Version 4. Message and conversation IDs are the other side's choice, so
 * whether one is already on this device must change nothing they could
 * notice. Messages are kept by (conversation, message ID), and a
 * conversation gets an ID of its own here, apart from the one on the wire;
 * those from before keep theirs, which was unique on the device.
 *
 * Attachments' files stay as they are: copying them would need as much
 * space again, all in this one transaction. Their messages are marked
 * (legacyFile) instead, which reads only the media store's keys.
 * Untyped: it reads the stores as version 3 left them.
 */
async function scopeIds(db: IDBPDatabase, tx: IDBPTransaction<unknown, string[], 'versionchange'>): Promise<void> {
  /** How many messages it copies at a time. */
  const MIGRATION_BATCH = 500;
  const conversations = tx.objectStore('conversations');
  conversations.createIndex('byWire', ['link.id', 'wire']);
  const before = tx.objectStore('messages');
  before.name = 'messages-v3';
  const messages = db.createObjectStore('messages', { keyPath: ['conv', 'id'] });
  messages.createIndex('byConversation', ['conv', 'at']);
  const media = tx.objectStore('media');

  // In batches, each one's writes sent together: waiting for every request in
  // turn takes seconds for a long history on some engines.
  // Conversations one at a time: a record may hold a lot (edits kept for
  // later, up to 6 MB), and all of them at once may not fit in memory.
  for (let cursor = await conversations.openCursor(); cursor; cursor = await cursor.continue()) {
    const c = cursor.value as Omit<ConversationRecord, 'wire'>;
    // Someone we never answered can't have changed keys: theirs is still
    // their first. Once answered, it may have changed (firstKey stays unknown).
    const firstKey = c.role === 'owner' && c.myKey === null ? { firstKey: c.peerKey } : {};
    await cursor.update({ ...c, wire: c.id, ...firstKey });
  }
  const files = new Set(await media.getAllKeys());
  const kept = new Set<IDBValidKey>();
  for (let after: string | undefined; ; ) {
    const batch = (await before.getAll(after === undefined ? null : IDBKeyRange.lowerBound(after, true), MIGRATION_BATCH)) as MessageRecord[];
    if (batch.length === 0) break;
    await Promise.all(
      batch.map((m) => {
        // Only a message whose file is on the device owns the file under its
        // ID; any other one there is a leftover it must not pick up.
        if (m.file !== 'local' || !files.has(m.id)) return messages.put(m);
        kept.add(m.id);
        return messages.put({ ...m, legacyFile: true });
      }),
    );
    after = batch[batch.length - 1]!.id;
  }
  // Any other file (left by a send that never finished, or one whose message
  // doesn't show it as here) was never shown: it goes. Deleting needs no
  // space. One whose message can fetch it downloads it again.
  for (const key of files) if (!kept.has(key)) await media.delete(key);
  db.deleteObjectStore('messages-v3');
}

/**
 * Version 5. Edits of their messages that came before the messages did were
 * kept on the conversation record, up to 500 of up to 12 KB each, and the
 * record is read for the chat list and written with everything that comes:
 * they move to an item of their own in `meta` (editsKey), the newest that
 * fit within MAX_PENDING_EDITS and MAX_PENDING_EDIT_BYTES; in conversations
 * we haven't answered, those whose newest edit is newest (dated no later
 * than now: their clock may run ahead), as many as fit in
 * MAX_UNANSWERED_EDIT_BYTES together (the rest go). They stay sealed as
 * they are (bound to the message's ID, not to where they're kept). One
 * record at a time: on a device someone flooded, all of them at once may
 * not fit in memory. The messages get an index by status (byStatus).
 * Opening version 5 also closes older copies of the app still running
 * (openDatabase, blocking), which would keep writing to the record.
 * Untyped: it reads the records as version 4 left them.
 */
async function moveEdits(tx: IDBPTransaction<unknown, string[], 'versionchange'>): Promise<void> {
  const meta = tx.objectStore('meta');
  const shared: LedgerEntry[] = [];
  for (let cursor = await tx.objectStore('conversations').openCursor(); cursor; cursor = await cursor.continue()) {
    const { edits, ...c } = cursor.value as ConversationRecord & { edits?: PendingEdit[] };
    if (edits === undefined) continue;
    const kept = capEdits(edits);
    await cursor.update(c);
    if (kept.length === 0) continue;
    await meta.put(kept, editsKey(c.id));
    if (unanswered(c)) shared.push({ conv: c.id, bytes: editBytes(kept) + LEDGER_ENTRY_COST, at: Math.min(Math.max(...kept.map((e) => e.at)), Date.now()) });
  }
  const ledger: LedgerEntry[] = [];
  let total = 0;
  for (const e of shared.sort((a, b) => b.at - a.at)) {
    if (total + e.bytes > MAX_UNANSWERED_EDIT_BYTES) {
      await meta.delete(editsKey(e.conv));
      continue;
    }
    total += e.bytes;
    ledger.push(e);
  }
  if (ledger.length > 0) await meta.put(ledger, EDITS_LEDGER);
}

/**
 * Opens (and if needed creates or upgrades) the app's database. If that
 * fails, it rejects with a StorageError and the database is as it was.
 * onBlocked runs if another copy of the app, on an older version, keeps it
 * open, so the upgrade has to wait for that copy to close.
 */
export async function openDatabase(name = DB_NAME, { onBlocked }: { onBlocked?: () => void } = {}): Promise<Database> {
  let failure: unknown;
  try {
    return await openDB<Schema>(name, DB_VERSION, {
      async upgrade(db, oldVersion, _newVersion, tx) {
        // How it ends is what openDB resolves or rejects with; nothing waits on tx.done.
        tx.done.catch(() => {});
        // Aborted by the engine, not by us (a commit that failed): its reason.
        tx.addEventListener('abort', () => (failure ??= tx.error ?? undefined));
        try {
          for (let v = oldVersion; v < DB_VERSION; v++) {
            const step = upgrades[v]?.(db, tx);
            if (step) await step;
          }
        } catch (err) {
          // Nothing is kept half-done: the database stays as it was, and
          // opening it fails with this, not the abort it leads to.
          failure = err;
          try {
            tx.abort();
          } catch {
            // Already aborted by the request that failed.
          }
        }
      },
      blocked() {
        onBlocked?.();
      },
      // Another copy of the app is running a newer version: close at once, so
      // it needn't wait for the reload, which then brings that version.
      blocking(_current, _blocked, event) {
        (event.target as IDBDatabase).close();
        location.reload();
      },
    });
  } catch (err) {
    // Opened before by a newer version, which upgraded it past ours.
    if (failure === undefined && (err as { name?: unknown } | null)?.name === 'VersionError') throw new StorageError('newer', err);
    throw new StorageError('failed', failure ?? err);
  }
}

export async function getKey(db: Database, name: string): Promise<CryptoKey | undefined> {
  const value = await db.get('keys', name);
  return value instanceof CryptoKey ? value : undefined;
}

export async function getKeyPair(db: Database, name: string): Promise<StoredKeyPair | undefined> {
  const value = await db.get('keys', name);
  return value && !(value instanceof CryptoKey) ? value : undefined;
}

export async function putKey(db: Database, name: string, key: CryptoKey | StoredKeyPair): Promise<void> {
  await db.put('keys', key, name);
}

export async function getSealed(db: Database, name: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  return db.get('vault', name);
}

export async function putSealed(db: Database, name: string, sealed: Uint8Array<ArrayBuffer>): Promise<void> {
  await db.put('vault', sealed, name);
}

export async function deleteSealed(db: Database, name: string): Promise<void> {
  await db.delete('vault', name);
}

/** The names of the sealed keys whose names start with prefix. */
export async function listSealed(db: Database, prefix: string): Promise<string[]> {
  return (await db.getAllKeys('vault', IDBKeyRange.bound(prefix, `${prefix}\uffff`))).map(String);
}

export async function getMeta<T>(db: Database, name: string): Promise<T | undefined> {
  return (await db.get('meta', name)) as T | undefined;
}

export async function putMeta(db: Database, name: string, value: unknown): Promise<void> {
  await db.put('meta', value, name);
}

export async function deleteMeta(db: Database, name: string): Promise<void> {
  await db.delete('meta', name);
}

/**
 * Deletes everything stored for the previous account on this device: keys,
 * sealed keys, conversations, messages and settings, except the settings
 * named in keep. A new account must not inherit any of it: the server
 * deleted that account's mailboxes and links.
 */
export async function wipe(db: Database, keep: string[] = []): Promise<void> {
  const tx = db.transaction(['keys', 'vault', 'meta', 'conversations', 'messages', 'media'], 'readwrite');
  await Promise.all([
    tx.objectStore('keys').clear(),
    tx.objectStore('vault').clear(),
    tx.objectStore('conversations').clear(),
    tx.objectStore('messages').clear(),
    tx.objectStore('media').clear(),
  ]);
  const meta = tx.objectStore('meta');
  for (const name of await meta.getAllKeys()) {
    if (!keep.includes(String(name))) await meta.delete(name);
  }
  await tx.done;
}

/** Asks the browser not to evict our storage. Best effort: often refused. */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
