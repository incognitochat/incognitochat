// On-device storage (IndexedDB). Never localStorage: it can't hold CryptoKeys
// and some webviews clear it on their own.
//
// CryptoKeys live in their own store under explicit string keys, with no
// indexes: a WebKit bug breaks index queries on records that contain a
// CryptoKey. Each schema change is a new version with its own upgrade step.

import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb';

export const DB_NAME = 'incognitochat';
export const DB_VERSION = 4;

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
  messages: { key: [string, string]; value: MessageRecord; indexes: { byConversation: [string, number] } };
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
   * keyed hash (idTag), which breaks ties. Only an envelope newer than this
   * changes peerKey, sendTo and lastReceived, so one that comes late or
   * again can't move us back to an older key or mailbox. Missing in
   * conversations from before it was kept, until something comes.
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
  /** Deleted on this device: out of the list, with no messages, until a new one comes or goes. */
  hidden?: boolean;
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
   * and when we took it in (our clock). Something of theirs from by then
   * that comes later and shows they had more of ours takes those too, but
   * never one we wrote after taking the delete in. Forgotten with it.
   */
  theirClear?: { upTo: number; here: number };
  /**
   * Their messages sent up to this time (their clock) are dropped: set only
   * if the user deleted more of them here than are remembered one by one
   * (replay.ts, MAX_DROPPED), to the end of the day the oldest went from.
   * Forgotten after 31 days.
   */
  droppedBefore?: number;
  /** Edits of their messages that came before the messages did, sealed under the storage key (messaging/store.ts). */
  edits?: { id: string; at: number; sealed: Uint8Array<ArrayBuffer> }[];
  /**
   * Their reactions to messages that weren't here yet (one of theirs still
   * on its way), sealed under the storage key, by the message's keyed hash
   * (idTag): applied when it comes. The newest per message.
   */
  reactions?: { tag: string; at: number; sealed: Uint8Array<ArrayBuffer> }[];
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
  /** Unix ms shown: the sender's time, but never later than when it arrived. */
  at: number;
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
   * device (fetched again only on a tap, while the server keeps it), or gone
   * (expired).
   */
  file?: 'local' | 'remote' | 'cleared' | 'gone';
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
  const all = (await conversations.getAll()) as Omit<ConversationRecord, 'wire'>[];
  await Promise.all(
    all.map((c) => {
      // Someone we never answered can't have changed keys: theirs is still
      // their first. Once answered, it may have changed (firstKey stays unknown).
      const firstKey = c.role === 'owner' && c.myKey === null ? { firstKey: c.peerKey } : {};
      return conversations.put({ ...c, wire: c.id, ...firstKey });
    }),
  );
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
