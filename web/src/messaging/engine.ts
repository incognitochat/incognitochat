// Messaging (design §9, §10, §12): starting conversations through links,
// writing, and receiving.
//
// Who writes with which key (docs/protocol.md): a first message comes from a
// fresh conversation key of the sender and is written for the link's current
// encryption key; it carries the sender's reply mailbox and sender tag. The
// owner's first reply comes from a fresh conversation key of the owner and
// carries the owner's mailbox. From then on each side writes for the other's
// latest key, to the other's mailbox.
//
// An envelope counts only through the mailbox it belongs to (receive): one
// written for a link's key, through that link's intro mailbox; one written
// for a conversation's key, through our mailbox for that conversation.
//
// Sends carry no login: they go to POST /send with anonymous tokens, as many
// as the envelope costs (one for anything but a long text).

import { fromBase64Url, toBase64Url, utf8 } from '../crypto/encoding';
import { introMailbox, keyName, listLinks, rotateLinkKey, setLinkMailbox, type LinkRecord } from '../account/links';
import {
  countTokens,
  LOW_WATER,
  MAX_BATCH,
  MEDIA_BATCH,
  MEDIA_LOW_WATER,
  refillTokens,
  returnToken,
  returnTokens,
  takeToken,
  takeTokens,
  TOKEN_BATCH,
  type StoredToken,
  type TokenIssuer,
} from '../account/wallet';
import { ApiError, checkObject, NetworkError, type Api } from '../net/api';
import type { Session } from '../net/session';
import { MAX_ENVELOPE, sendTokensFor } from '../protocol/envelope';
import { BundleMismatch, checkBundle, verifyBundle, type Bundle, type LinkRef } from '../protocol/link';
import { EDIT_GRACE_MS, EDIT_WINDOW_MS, isReactionEmoji, MAX_TEXT_BYTES, newId, openMessage, sealMessage, type Draft, type Media, type Message, type Sticker } from '../protocol/message';
import { getMeta, getSealed, putMeta, type ConversationRecord, type Database } from '../storage/db';
import { withLock, withLockIfFree } from '../sync/locks';
import {
  conversationKey,
  createConversationKey,
  deleteExpiredKeys,
  hasKey,
  hasLinkKey,
  indexKey,
  KEY_RETENTION_MS,
  keyFinder,
  lookupKey,
  scheduleKeyDeletion,
  type KeyEntry,
} from './keys';
import { dropFromPool, pooled, POOL_LOW, poolSize, refillPool, takeMailbox } from './pool';
import { couldCome, DAY, dayOf, endOf, forgetOld, isNewer, MAX_AGE, MAX_APPLIED, MAX_DROPPED, MAX_GONE, MAX_MINE, remember, remembers, tidy } from './replay';
import { accountSecret, idTag, label, senderTag } from './secret';
import {
  addMessage,
  clearMessages,
  deleteMessage,
  findLinkConversation,
  forgetUploadDeletes,
  getConversation,
  getMedia,
  getMessage,
  hasMessage,
  listConversations,
  getIds,
  ID_KINDS,
  listMessages,
  mediaLock,
  newestTheirs,
  newLocalId,
  noteHad,
  openPendingEdit,
  openPendingReaction,
  pendingUploadDeletes,
  putConversation,
  putMedia,
  queueUploadDeletes,
  saveConversation,
  sealPendingEdit,
  sealPendingReaction,
  sentAt,
  setFile,
  setMessageStatus,
  setReaction,
  setText,
  type ConversationIds,
  type LocalMedia,
  type MessageBody,
  type MessageView,
} from './store';
import { decryptFile, encryptFile, newFileKey, uploadSize } from '../crypto/media';
import { httpTransfer, TransferError, type Transfer } from '../net/transfer';

/** The most edits for messages not here yet that a conversation keeps. */
const MAX_PENDING_EDITS = 500;
/** The most reactions to messages not here yet that a conversation keeps. */
const MAX_PENDING_REACTIONS = 100;
/** How many uploads are deleted from the server at once. */
const UPLOAD_DELETE_PARALLEL = 6;
const MAX_INBOX_PAGES = 10;
/** After the server limits this device's inbox fetches, they pause this long, plus up to as much again (its limits are per minute). */
const SYNC_PAUSE_MS = 30_000;
/**
 * How long a confirmed item's ID is remembered, so a fetch that lists it
 * again (the server's reads lag a little) neither opens nor confirms it
 * twice. The server gives an item the same ID within the hour it's listed in.
 */
const CONFIRMED_FOR_MS = 2 * 3600 * 1000;
const MAX_CONFIRMED = 1000;
/** How long IDs that couldn't be confirmed yet are kept to confirm later: the server takes an ID for an hour or two after it listed it. */
const UNCONFIRMED_FOR_MS = 3600 * 1000;
/** How many IDs may wait to be confirmed before a sync stops reading more (three pages): else what can't be confirmed yet is read again and again. */
const MAX_PENDING = 150;
/**
 * The most messages one receipt names: the protocol takes 100, but 50 keep
 * a receipt in the smaller envelopes, at one send token (68 would fit).
 */
const MAX_SEEN = 50;
/** The most send tokens one envelope can cost: what the largest there can be costs. */
const MAX_SEND_TOKENS = sendTokensFor(MAX_ENVELOPE);
const META_BLOCKED = 'blocked-tags';
/** When the mailboxes were last checked (healMailboxes), Unix ms. */
const META_MAILBOXES_CHECKED = 'mailboxes-checked';
/** The most mailbox IDs one check sends: well within a request's size limit. */
const CHECK_CHUNK = 1000;
/** Our conversation keys are replaced every 6 to 9 days (design D11), each conversation on its own schedule. */
const ROTATE_MIN = 6 * DAY;
const ROTATE_SPREAD = 3 * DAY;
/** How long a sender not answered yet trusts the link key it has before fetching the current one. */
const LINK_KEY_RECHECK = 3600 * 1000;
/**
 * How long a conversation's former mailbox still counts once something came
 * through the current one: the other side wrote to the old one until our
 * message told them, and that may wait in the inbox for 30 days.
 */
const MAILBOX_GRACE = MAX_AGE;
/** The most former mailboxes a conversation keeps (it rarely has more than one). */
const MAX_FORMER_MAILBOXES = 8;

export class NoTokens extends Error {
  constructor() {
    super('no send tokens');
    this.name = 'NoTokens';
  }
}

/**
 * An envelope that can't be judged yet: it was written for an older link
 * whose intro mailbox isn't known here, and the link's bundle can't be
 * fetched now. It stays in the inbox, unconfirmed, for the next sync.
 */
class NotYet extends Error {
  constructor() {
    super('not yet');
    this.name = 'NotYet';
  }
}

/** A sync failed partway, after it had stored changes: received is how many (as sync() counts them), error what stopped it. */
export class SyncFailed extends Error {
  constructor(
    readonly received: number,
    readonly error: unknown,
  ) {
    super('sync failed');
    this.name = 'SyncFailed';
  }
}

/** The day's new mailboxes are used up: no new chat can be started or answered until tomorrow. */
export class NoMailboxes extends Error {
  constructor() {
    super('no mailboxes');
    this.name = 'NoMailboxes';
  }
}

export interface MessagingDeps {
  db: Database;
  /** For calls without login: sending, reading link bundles. */
  api: Api;
  /** For logged-in calls: inbox, mailboxes, tokens. */
  session: Session;
  issuer: TokenIssuer;
  /** The media-token issuer, which pays for uploads; without it attachments can't be sent. */
  mediaIssuer?: TokenIssuer;
  /** Unix milliseconds. */
  now?: () => number;
  /** Uploads and downloads attachments (tests use a fake). */
  transfer?: Transfer;
  /** Waits ms before an upload is tried again (tests don't wait). */
  wait?: (ms: number) => Promise<void>;
  /** Called after send tokens were spent or fetched, so the app can say when they run low. */
  onTokens?: () => void;
  /**
   * Called when a sync left something unconfirmed because a send of ours was
   * going out in its chat, once that send is done: syncing again then takes
   * it in.
   */
  onWaiting?: () => void;
  /** Called when a pause the server asked for ends (rate_limited), so the app syncs then: pushes that came meanwhile weren't acted on. */
  onResume?: () => void;
}

/** An attachment to send: the file, and what it is. */
export interface Outgoing {
  file: Uint8Array<ArrayBuffer>;
  media: Omit<Media, 'id' | 'k' | 'd'>;
}

/** One media token pays for this much of an upload (as the server counts). */
const TOKEN_BYTES = 1024 * 1024;
/**
 * How many times an upload is tried in all. Tries after the first cost no
 * tokens: the server gives an upload three fresh URLs for them, in the first
 * hours after paying. (An upload URL only starts a PUT within a minute.)
 */
const PUT_TRIES = 4;
/**
 * How long to wait before each try after the first: long enough for a poor
 * connection to come back, well within the server's 3 hours.
 */
const PUT_RETRY_MS = [2_000, 10_000, 30_000];
/**
 * How many uploads run at once. Browsers open about 6 connections to one
 * host, and an upload URL only starts a PUT within a minute, so the rest
 * wait here and ask for their URL once it's their turn.
 */
const UPLOADS_AT_ONCE = 2;

function checkUpload(value: unknown): { id: string; url: string } {
  const { id, url } = checkObject(value);
  if (typeof id !== 'string' || typeof url !== 'string' || !url.startsWith('https://')) throw new Error('bad upload');
  return { id, url };
}

/** A fresh upload URL, or word that the upload is stored already. */
function checkRenewal(value: unknown): string | 'uploaded' {
  const { url, uploaded } = checkObject(value);
  if (uploaded === true) return 'uploaded';
  if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error('bad upload');
  return url;
}

/** The operator has paused uploads or downloads of attachments for now: try again later, not at once. */
export function isPaused(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'uploads_paused' || err.code === 'downloads_paused');
}

/** Whether one of our attachments can be sent again: it failed before it was uploaded, and its file is here. */
export function canResend(m: Pick<MessageView, 'out' | 'status' | 'file' | 'media' | 'legacyFile'>): boolean {
  return m.out && m.status === 'failed' && m.file === 'local' && !!m.media && !m.media.id && !m.legacyFile;
}

function mediaBody(text: string, replyTo: string | undefined, media: LocalMedia): MessageBody {
  return { text, ...(replyTo ? { replyTo } : {}), media };
}

function checkUrl(value: unknown): string {
  const { url } = checkObject(value);
  if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error('bad download');
  return url;
}

interface InboxItem {
  id: string;
  mailbox: string;
  envelope: string;
}

/** POST /ack's answer: the IDs whose delete failed, to send again. */
function checkAck(value: unknown): { retry: string[] } {
  const { retry } = checkObject(value);
  if (retry === undefined) return { retry: [] };
  if (!Array.isArray(retry) || retry.some((id) => typeof id !== 'string')) throw new Error('bad ack');
  return { retry: retry as string[] };
}

function checkInbox(value: unknown): { items: InboxItem[]; more: boolean; next: string | null } {
  const { items, more, next } = checkObject(value);
  if (!Array.isArray(items) || typeof more !== 'boolean') throw new Error('bad inbox');
  // Where the next page starts: an item's key, which goes back in the URL.
  if (next !== undefined && (typeof next !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(next))) throw new Error('bad inbox');
  return {
    more,
    next: typeof next === 'string' ? next : null,
    items: items.map((i: unknown) => {
      const { id, mailbox, envelope } = checkObject(i);
      if (typeof id !== 'string' || typeof mailbox !== 'string' || typeof envelope !== 'string') throw new Error('bad item');
      return { id, mailbox, envelope };
    }),
  };
}

export function createMessaging(deps: MessagingDeps) {
  const { db, api, session, issuer, mediaIssuer } = deps;
  const now = deps.now ?? Date.now;
  const findKey = keyFinder(db);
  const transfer = deps.transfer ?? httpTransfer;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nextRotation = () => now() + ROTATE_MIN + Math.floor(Math.random() * ROTATE_SPREAD);

  /**
   * Writes the first message to someone's link, starting a conversation.
   * onStored runs as soon as the conversation and message are stored, before
   * the (slower) delivery. Returns the conversation's ID (on this device)
   * once delivered.
   */
  async function startConversation(
    ref: LinkRef,
    bundle: Bundle,
    text: string,
    onStored?: (conv: string) => void | Promise<void>,
  ): Promise<string> {
    const { raw: linkKey } = await verifyBundle(ref, bundle, Math.floor(now() / 1000));
    const id = newLocalId();
    const myKey = await createConversationKey(db, id);
    const secret = await accountSecret(db);
    const conversation: ConversationRecord = {
      id,
      wire: newId(),
      role: 'sender',
      link: { id: ref.id, fingerprint: ref.fingerprint },
      label: await label(secret, 'link', utf8(ref.fingerprint)),
      peerKey: toBase64Url(linkKey),
      myKey: toBase64Url(myKey.publicKey),
      sendTo: bundle.mailbox,
      // Taken from the pool once the message shows.
      myMailbox: null,
      lastAt: now(),
      unread: 0,
      status: 'active',
      lastReceived: null,
      rotateAt: nextRotation(),
      linkCheckedAt: now(),
    };
    await putConversation(db, conversation);
    await write(conversation, { text }, undefined, () => onStored?.(id));
    return id;
  }

  /**
   * Writes a message (or sends a sticker) in a conversation. onStored runs as
   * soon as the message is stored (shown as sending), before delivery.
   */
  async function send(conv: string, content: string | { sticker: Sticker }, replyTo?: string, onStored?: () => void | Promise<void>): Promise<void> {
    const conversation = await getConversation(db, conv);
    if (!conversation) throw new Error('unknown conversation');
    await write(conversation, typeof content === 'string' ? { text: content } : content, replyTo, onStored);
  }

  async function write(
    conversation: ConversationRecord,
    content: { text: string } | { sticker: Sticker },
    replyTo?: string,
    onStored?: () => void | Promise<void>,
  ): Promise<void> {
    // Stored and shown first; everything slow happens after.
    const id = newId();
    const at = now();
    const answer = replyTo ? { replyTo } : {};
    await addMessage(db, { id, conv: conversation.id, at, out: true, status: 'sending' }, { text: '', ...content, ...answer });
    // Shown now; its chat's place in the list may wait for a send of ours
    // still going out there.
    await onStored?.();
    await update(conversation.id, (c) => ({ ...c, lastAt: at, hidden: false }));
    try {
      await transmit(conversation.id, { kind: 'message', id, at, ...content, ...answer });
      // Unless their receipt came in first.
      await setMessageStatus(db, conversation.id, id, 'sent', 'sending');
    } catch (err) {
      await setMessageStatus(db, conversation.id, id, 'failed');
      throw err;
    }
  }

  /**
   * Sends an attachment, with an optional caption. Like a message, it's
   * stored and shown first (as sending); then the file is encrypted and
   * uploaded, paid with media tokens, and the message carries its key.
   */
  async function sendMedia(
    conv: string,
    out: Outgoing,
    caption = '',
    replyTo?: string,
    onStored?: (id: string) => void | Promise<void>,
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    const conversation = await getConversation(db, conv);
    if (!conversation) throw new Error('unknown conversation');
    const id = newId();
    const at = now();
    await putMedia(db, conv, id, out.file);
    await addMessage(db, { id, conv, at, out: true, status: 'sending', file: 'local' }, mediaBody(caption, replyTo, out.media));
    await onStored?.(id);
    await update(conv, (c) => ({ ...c, lastAt: at, hidden: false }));
    await deliverMedia(conv, id, at, out, caption, replyTo, onProgress);
  }

  /**
   * Sends one of our attachments again that failed before it was uploaded
   * (attachments were paused, say, or the server couldn't be reached): its
   * file is still on this device, and none of it reached the other side, so
   * it goes like a new one, now, at the end of the conversation. One that
   * was uploaded is left alone: its message may have arrived. Under the
   * message's lock, so two copies of the app don't both send (and pay for)
   * it; one that another copy sent meanwhile (or deleted) is quietly left
   * as it is.
   */
  function resendMedia(
    conv: string,
    id: string,
    onStored?: () => void | Promise<void>,
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    return withLock(mediaLock(conv, id), async () => {
      const message = await getMessage(db, conv, id);
      if (!message || !canResend(message) || !(await getConversation(db, conv))) return;
      const file = await getMedia(db, conv, id);
      if (!file) throw new Error('attachment missing');
      const at = now();
      const { text, replyTo, media } = message;
      await addMessage(db, { id, conv, at, out: true, status: 'sending', file: 'local' }, mediaBody(text, replyTo, media!));
      await onStored?.();
      // Only these two change, on the chat as it is then (under the send
      // lock), so a message that arrived meanwhile isn't undone.
      await update(conv, (c) => ({ ...c, lastAt: at, hidden: false }));
      await deliverMedia(conv, id, at, { file, media: media! }, text, replyTo, onProgress);
    });
  }

  /** Uploads a stored attachment and sends its message; marks it failed if either fails. */
  async function deliverMedia(
    conv: string,
    id: string,
    at: number,
    out: Outgoing,
    caption: string,
    replyTo: string | undefined,
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    try {
      const media = await upload(out, onProgress);
      await addMessage(db, { id, conv, at, out: true, status: 'sending', file: 'local' }, mediaBody(caption, replyTo, media));
      await transmit(conv, { kind: 'message', id, at, ...(caption ? { text: caption } : {}), ...(replyTo ? { replyTo } : {}), media });
      await setMessageStatus(db, conv, id, 'sent', 'sending');
    } catch (err) {
      await setMessageStatus(db, conv, id, 'failed');
      throw err;
    }
  }

  let uploading = 0;
  const waitingToUpload: (() => void)[] = [];
  /** Runs an upload once fewer than UPLOADS_AT_ONCE are running. */
  async function uploadSlot<T>(run: () => Promise<T>): Promise<T> {
    while (uploading >= UPLOADS_AT_ONCE) await new Promise<void>((resolve) => waitingToUpload.push(resolve));
    uploading++;
    try {
      return await run();
    } finally {
      uploading--;
      waitingToUpload.shift()?.();
    }
  }

  /** Encrypts and uploads a file; returns the attachment with its upload ID, key and delete secret. */
  function upload(out: Outgoing, onProgress?: (fraction: number) => void): Promise<Media> {
    // Its URL is asked for only when it can be used at once: it only starts
    // a PUT within a minute.
    return uploadSlot(async () => {
      const key = newFileKey();
      const secret = crypto.getRandomValues(new Uint8Array(16));
      // Encrypted before asking where to put it, for the same reason.
      const body = await encryptFile(out.file, key);
      const tokens = await takeMediaTokens(Math.ceil(body.length / TOKEN_BYTES));
      const deleteHash = new Uint8Array(await crypto.subtle.digest('SHA-256', secret));
      let created: { id: string; url: string };
      try {
        created = await api.post('/media', { size: body.length, deleteHash: toBase64Url(deleteHash), tokens: tokens.map((t) => t.token) }, checkUpload);
      } catch (err) {
        // Unspent if it never arrived, or if uploads are paused (the server
        // answers that before looking at them); otherwise the server refuses
        // them later and they're dropped.
        if (err instanceof NetworkError || isPaused(err)) for (const t of tokens) await returnToken(db, t.token, t.epoch, 'media');
        throw err;
      }
      await put(created.id, created.url, body, secret, onProgress);
      return { ...out.media, id: created.id, k: toBase64Url(key), d: toBase64Url(secret) };
    });
  }

  /**
   * PUTs a paid upload, trying again a few times if that fails. Tries again
   * cost no tokens: each asks the server, with the upload's delete secret,
   * for a fresh URL, or learns that the upload is stored already (an earlier
   * try wrote it and only its answer was lost). A URL writes only once, so a
   * 412 means the same.
   */
  async function put(id: string, first: string, body: Uint8Array<ArrayBuffer>, secret: Uint8Array, onProgress?: (fraction: number) => void): Promise<void> {
    let url: string | null = first;
    for (let tries = 1; ; tries++) {
      try {
        if (url === null) {
          // The server knows whether a try that seemed to fail wrote it
          // after all; if not, it gives a fresh URL.
          const next = await api.post(`/media/${id}/upload`, { secret: toBase64Url(secret) }, checkRenewal);
          if (next === 'uploaded') return;
          url = next;
        }
        await transfer.put(url, body, onProgress);
        return;
      } catch (err) {
        // It's there already: an earlier try wrote it.
        if (err instanceof TransferError && err.status === 412) return;
        // The bucket or the server out of reach (a TransferError is a
        // NetworkError too), or the server failing, uses up a try; a
        // refusal (no fresh URL) ends it, and so do paused uploads: the
        // operator doesn't resume them within these seconds.
        const again = err instanceof NetworkError || (err instanceof ApiError && err.status >= 500 && !isPaused(err));
        if (!again || tries >= PUT_TRIES) throw err;
      }
      url = null;
      await wait(PUT_RETRY_MS[tries - 1] ?? 0);
    }
  }

  /**
   * Fetches an attachment: downloads, decrypts and keeps it on this device.
   * A received one, or one of either side's that was cleared from this
   * device. The upload stays, saved or not, until the recipient deletes the
   * message or the conversation, or it expires.
   * Returns where the file is now.
   */
  function fetchMedia(conv: string, id: string, onProgress?: (fraction: number) => void): Promise<'local' | 'gone'> {
    return withLock(mediaLock(conv, id), async () => {
      const message = await getMessage(db, conv, id);
      if (!message?.media || (message.file !== 'remote' && message.file !== 'cleared')) return message?.file === 'local' ? 'local' : 'gone';
      const m = message.media as Media;
      let url: string;
      try {
        url = await api.request('GET', `/media/${m.id}`, {}, checkUrl);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'not_found') {
          await setFile(db, conv, id, 'gone');
          return 'gone';
        }
        throw err;
      }
      const file = await decryptFile(await transfer.get(url, uploadSize(m.s), onProgress), fromBase64Url(m.k), m.s);
      await putMedia(db, conv, id, file);
      await setFile(db, conv, id, 'local');
      return 'local';
    });
  }

  /**
   * Deletes attachments' uploads from the server, in the background: they go
   * on a list first, so a chat with many attachments disappears at once and
   * the rest is finished on the next start if the app closes halfway.
   */
  async function deleteUploadsLater(media: (LocalMedia | undefined)[]): Promise<void> {
    const items = media.flatMap((m) => (m?.id && m.d ? [{ id: m.id, d: m.d }] : []));
    if (items.length === 0) return;
    await queueUploadDeletes(db, items);
    void flushUploadDeletes();
  }

  let flushing: Promise<void> | null = null;
  /**
   * Works through the uploads waiting to be deleted, several at a time. One
   * already gone counts as done; with the server unreachable or busy, the
   * rest wait for the next try (each start, and upkeep).
   */
  function flushUploadDeletes(): Promise<void> {
    flushing ??= withLock('upload-deletes-flush', async () => {
      for (;;) {
        const items = await pendingUploadDeletes(db);
        if (items.length === 0) return;
        const done: string[] = [];
        let stop = false;
        let next = 0;
        const worker = async () => {
          while (!stop && next < items.length) {
            const item = items[next++]!;
            try {
              await api.post(`/media/${item.id}/delete`, { secret: item.d }, checkObject);
              done.push(item.id);
            } catch (err) {
              if (err instanceof ApiError && err.code === 'not_found') done.push(item.id);
              else stop = true;
            }
          }
        };
        await Promise.all(Array.from({ length: UPLOAD_DELETE_PARALLEL }, worker));
        await forgetUploadDeletes(db, done);
        if (stop) return;
      }
    }).finally(() => (flushing = null));
    return flushing;
  }

  /**
   * Deletes the uploads of received attachments: their messages are being
   * deleted here. Ours stay, for the other side to fetch: deleting our own
   * message only for us leaves theirs as it is.
   */
  async function discardUploads(messages: { out: boolean; media?: LocalMedia }[]): Promise<void> {
    await deleteUploadsLater(messages.filter((m) => !m.out).map((m) => m.media));
  }

  /**
   * Edits one of our messages: a text message's text, or an attachment's
   * caption (which may become empty). Sent quietly, like a receipt, and kept
   * here once sent; their app shows the new text, marked edited. Only for a
   * day after sending (EDIT_WINDOW_MS); their app drops later edits too. Like
   * deleting for both sides, it relies on their app.
   */
  async function edit(conv: string, id: string, text: string): Promise<void> {
    const c = await getConversation(db, conv);
    const m = await getMessage(db, conv, id);
    if (!c || c.status !== 'active' || !m || !m.out || (m.status !== 'sent' && m.status !== 'seen') || m.sticker) {
      throw new Error('nothing to edit');
    }
    if ((text.trim() === '' && !m.media) || utf8(text).length > MAX_TEXT_BYTES) throw new Error('not a valid text');
    if (text === m.text) return;
    const at = now();
    if (at - m.at > EDIT_WINDOW_MS) throw new Error('too late to edit');
    await transmit(conv, { kind: 'edit', id: newId(), at, edit: { to: id, text } });
    await setText(db, conv, id, text, at);
  }

  /**
   * Deletes one of our messages on both sides, as in Telegram: their app
   * deletes it too, whether they've opened it or not, its upload goes from
   * the server, and then it goes here. Sent quietly, like a receipt. Sent
   * first: if that fails, nothing is deleted, so it can be tried again. It
   * relies on their app doing so, as blocks do.
   */
  async function deleteForEveryone(conv: string, id: string): Promise<void> {
    const c = await getConversation(db, conv);
    const m = await getMessage(db, conv, id);
    if (!c || c.status !== 'active' || !m || !m.out || (m.status !== 'sent' && m.status !== 'seen')) {
      throw new Error('nothing to delete for both sides');
    }
    await transmit(conv, { kind: 'delete', id: newId(), at: now(), delete: [id] });
    await deleteUploadsLater([m.media]);
    await forget(conv, id);
  }

  /**
   * Seals and sends something in a conversation: a message, or a seen
   * receipt. One at a time per conversation, so the owner's first reply (or
   * first receipt) creates one key, and the first reply takes one mailbox.
   * `last` names the newest envelope of theirs taken in, unless options.last
   * names another of theirs (a delete of the whole conversation names their
   * newest message here).
   */
  function transmit(conv: string, fields: Omit<Draft, 'conv' | 'reply' | 'last' | 'tag'>, options: { last?: string } = {}): Promise<void> {
    return withLock(`send:${conv}`, async () => {
      let c = await getConversation(db, conv);
      if (!c) throw new Error('unknown conversation');
      if (c.myKey === null || (c.lastReceived !== null && now() >= (c.rotateAt ?? 0))) {
        // A first key, or time for a new one (design D11). The new key goes
        // out with this message: nothing is sent just to rotate. Not before
        // they've written to us, since until then they know us by this key
        // alone. The old key stays until they've used the new one (receive).
        const key = await createConversationKey(db, c.id);
        c = { ...c, myKey: toBase64Url(key.publicKey), rotateAt: nextRotation() };
        await putConversation(db, c);
      }
      if (c.role === 'sender' && c.lastReceived === null && now() - (c.linkCheckedAt ?? 0) >= LINK_KEY_RECHECK) {
        c = await refreshLinkKey(c);
      }
      // A chat someone started through our link takes one of our mailboxes
      // only when we answer it. Receipts and deletes go without one (they
      // keep writing to the link meanwhile), so a flood of first messages we
      // only read or delete uses none of our mailboxes.
      if (c.myMailbox === null && fields.kind !== 'seen' && fields.kind !== 'delete') {
        let mailbox: string;
        try {
          mailbox = await takeMailbox(db, session);
        } catch (err) {
          if (err instanceof ApiError && err.code === 'rate_limited') throw new NoMailboxes();
          throw err;
        }
        // In a chat someone started through our link, the link's intro
        // mailbox still counts until they've used this one (introUntil).
        c = { ...c, myMailbox: mailbox };
        await putConversation(db, c);
      }
      const myKey = await conversationKey(db, c.myKey!);
      const last = options.last ?? c.lastReceived;
      const draft: Draft = {
        ...fields,
        // The conversation's ID on the wire; c.id is this device's own.
        conv: c.wire,
        ...(c.myMailbox !== null ? { reply: c.myMailbox } : {}),
        ...(last ? { last } : {}),
      };
      if (c.role === 'sender') draft.tag = toBase64Url(await senderTag(await accountSecret(db), c.link.fingerprint));
      // Only messages trigger a Telegram notice for the other side, not
      // receipts or key updates.
      await deliver(c.sendTo, await sealMessage(draft, myKey, fromBase64Url(c.peerKey)), fields.kind !== 'message');
    });
  }

  /**
   * Changes a conversation as it's stored now, under the lock its sends and
   * receives hold: a change made from an older copy would undo theirs (a
   * mailbox or key a send just took, say), and the other side's messages
   * through that mailbox would then be dropped. Not for use while holding
   * that lock (`send:<id>`).
   */
  function update(conv: string, change: (c: ConversationRecord) => ConversationRecord | null | Promise<ConversationRecord | null>): Promise<void> {
    return withLock(`send:${conv}`, async () => {
      const c = await getConversation(db, conv);
      const next = c && (await change(c));
      if (next) await putConversation(db, next);
    });
  }

  /**
   * A conversation's former mailboxes, once it moves on from one of ours (to
   * another, or to none): the one it leaves still counts, until
   * MAILBOX_GRACE after something comes through the next one (receive), and
   * those whose time is up go.
   */
  function retire(c: ConversationRecord, left: string | null | undefined): Pick<ConversationRecord, 'formerMailboxes'> {
    const t = now();
    const kept = (c.formerMailboxes ?? []).filter((f) => (f.until === undefined || t < f.until) && f.id !== left);
    if (left) kept.push({ id: left });
    return { formerMailboxes: kept.slice(-MAX_FORMER_MAILBOXES) };
  }

  /**
   * Before they've answered, we write for their link's key. Links get a new
   * key weekly and old ones are deleted later, so fetch the current one if
   * ours is more than an hour old. If that fails, the one we have still
   * works for a while.
   */
  async function refreshLinkKey(c: ConversationRecord): Promise<ConversationRecord> {
    try {
      const bundle = await api.request('GET', `/links/${c.link.id}`, {}, checkBundle);
      const { raw } = await verifyBundle({ id: c.link.id, fingerprint: c.link.fingerprint }, bundle, Math.floor(now() / 1000));
      c = { ...c, peerKey: toBase64Url(raw), linkCheckedAt: now() };
      await putConversation(db, c);
    } catch {
      // Unreachable, replaced or revoked: keep what we have.
    }
    return c;
  }

  /**
   * Reacts to a message in a conversation, theirs or ours, with one emoji; an
   * empty one takes our reaction back. Shown at once, and sent like a
   * receipt: quietly, so it triggers no notice. If sending fails, the
   * reaction goes back to what it was.
   */
  async function react(conv: string, id: string, emoji: string): Promise<void> {
    const c = await getConversation(db, conv);
    const target = await getMessage(db, conv, id);
    if (!c || c.status !== 'active' || !target) throw new Error('nothing to react to');
    if (emoji !== '' && !isReactionEmoji(emoji)) throw new Error('not an emoji');
    const before = target.reactions?.mine?.e ?? '';
    await setReaction(db, conv, id, 'mine', emoji, now());
    try {
      await transmit(conv, { kind: 'reaction', id: newId(), at: now(), reaction: { to: id, e: emoji } });
    } catch (err) {
      await setReaction(db, conv, id, 'mine', before, now());
      throw err;
    }
  }

  /**
   * Opening a conversation: tells the other side, at once, which of their
   * messages we have now read (design D12), and clears the unread count.
   */
  async function markSeen(conv: string): Promise<void> {
    const c = await getConversation(db, conv);
    if (!c) return;
    if (c.unread > 0) await update(conv, (current) => (current.unread > 0 ? { ...current, unread: 0 } : null));
    if (c.status !== 'active') return;
    const unseen = (await listMessages(db, conv)).filter((m) => !m.out && m.status === 'received').map((m) => m.id);
    for (let i = 0; i < unseen.length; i += MAX_SEEN) {
      const batch = unseen.slice(i, i + MAX_SEEN);
      // Left as received if this fails, so the next opening tries again.
      await transmit(conv, { kind: 'seen', id: newId(), at: now(), seen: batch });
      for (const id of batch) await setMessageStatus(db, conv, id, 'read');
    }
  }

  /**
   * Blocks a conversation, silently (design §11): our mailbox for it is
   * discarded, so their sends go nowhere, and for someone who wrote to our
   * link their sender tag is remembered, so new conversations they start
   * through that link are dropped too. Nobody is told. The keys stay, so it
   * can be undone (unblock).
   */
  async function block(conv: string): Promise<void> {
    const c = await getConversation(db, conv);
    if (!c) return;
    if (c.role === 'owner' && c.tag) await addBlockedTag(c.link.fingerprint, c.tag);
    // Under the chat's lock: a reply of ours going out takes its mailbox
    // first, and that's the one discarded. Again if blocking is tried again.
    await update(conv, async (current) => {
      if (current.myMailbox) {
        try {
          await session.call('POST', `/mailboxes/${current.myMailbox}/discard`, undefined, checkObject);
        } catch (err) {
          if (!(err instanceof ApiError && err.code === 'not_found')) throw err;
        }
      }
      return { ...current, status: 'blocked', unread: 0 };
    });
  }

  /**
   * Undoes a block. Their sender tag is forgotten, so they can write through
   * our link again. Their app still writes to the mailbox we discarded, so
   * if we had one, we send them a quiet key update from a new mailbox (and,
   * if our key is gone, a new key): the conversation then carries on.
   * Whatever they sent while blocked is lost.
   */
  async function unblock(conv: string): Promise<void> {
    const c = await getConversation(db, conv);
    if (!c || c.status !== 'blocked') return;
    let tell = false;
    await update(conv, async (current) => {
      if (current.status !== 'blocked') return null;
      // A try that didn't get the key update out has left the discarded mailbox already.
      tell = current.unblocking === true || current.myMailbox !== null;
      if (current.unblocking || current.myMailbox === null) return null;
      // Blocks used to delete the conversation's keys: then a new one.
      const keyKept = current.myKey !== null && (await hasKey(db, current.myKey));
      return { ...current, myMailbox: null, myKey: keyKept ? current.myKey : null, unblocking: true, ...retire(current, current.myMailbox) };
    });
    // If this fails, it stays blocked, and unblocking again sends it.
    if (tell) await transmit(c.id, { kind: 'key_update', id: newId(), at: now() });
    if (c.role === 'owner' && c.tag) await removeBlockedTag(c.link.fingerprint, c.tag);
    await update(conv, ({ unblocking: _, ...current }) => ({ ...current, status: 'active' }));
  }

  /**
   * Deletes a conversation: its messages go, and it leaves the list. Its keys
   * and mailbox stay, so if either side writes again it comes back, as in
   * Telegram; block() is for never hearing from them again. Only from this
   * device, unless forBoth: then, first, the other side's app is told to
   * delete the whole conversation too (quietly, like a receipt), and our
   * attachments' uploads go from the server. If that can't be sent, nothing
   * is deleted. Like deleting a message for both, it relies on their app.
   *
   * On this device only, each message of theirs here is remembered as
   * deleted (a keyed hash), so it doesn't come back if it's delivered again;
   * anything of theirs not taken in yet still comes, and brings the
   * conversation back. For both sides, the delete names the newest of their
   * messages ever taken in (lastMessage) as `last`, so their app deletes the
   * messages of its own we had, by its own clock; here, everything of theirs
   * sent by then is gone for good (clearedBefore), as it is there. Either
   * way, edits and reactions waiting for messages that can still come stay.
   */
  async function remove(conv: string, forBoth = false): Promise<void> {
    // On this device only: everything here now.
    let upTo = { theirs: Infinity, ours: Infinity };
    let floor: number | undefined;
    if (forBoth) {
      const c = await getConversation(db, conv);
      if (!c || c.status !== 'active') throw new Error("can't delete for both sides");
      const newest = c.lastMessage ?? (await newestTheirs(db, conv));
      const at = now();
      await transmit(conv, { kind: 'delete', id: newId(), at, all: true }, newest ? { last: newest.id } : {});
      await deleteUploadsLater((await listMessages(db, conv)).filter((m) => m.out && m.at <= at).map((m) => m.media));
      // It covers theirs up to that one, ours up to now: whatever arrives
      // meanwhile stays, as it does on their side.
      upTo = { theirs: newest?.at ?? -Infinity, ours: at };
      floor = newest?.at;
    }
    await withLock(`send:${conv}`, async () => {
      const c = await getConversation(db, conv);
      if (!c) return;
      const going = (await listMessages(db, conv)).filter((m) => (m.out ? m.at <= upTo.ours : sentAt(m) <= upTo.theirs));
      await discardUploads(going);
      const { left, unread } = await clearMessages(db, conv, upTo);
      const before = await getIds(db, conv);
      let { c: kept, ids } = await tidied(c, now(), before);
      const secret = await accountSecret(db);
      if (floor !== undefined) {
        // Never lower: their delete of the whole conversation may have cleared it further.
        const cleared = Math.max(kept.clearedBefore ?? -Infinity, floor);
        const after = (x: { at: number }) => x.at > cleared;
        const edits = kept.edits?.filter(after);
        const reactions = kept.reactions?.filter(after);
        const { edits: _e, reactions: _r, lastMessage, ...rest } = kept;
        kept = {
          ...rest,
          clearedBefore: cleared,
          ...(edits?.length ? { edits } : {}),
          ...(reactions?.length ? { reactions } : {}),
          // Sent: no need to keep its ID and time. One newer, which came meanwhile, stays.
          ...(lastMessage && lastMessage.at > cleared ? { lastMessage } : {}),
        };
      } else if (!forBoth) {
        for (const m of going) {
          if (!m.out && couldCome(dayOf(sentAt(m)), now())) kept = drop(kept, ids, await idTag(secret, c.id, m.id), sentAt(m));
        }
      }
      // Ours: so their reactions or edits naming one aren't kept for later.
      for (const m of going) if (m.out && couldCome(dayOf(m.at), now())) dropMine(ids, await idTag(secret, c.id, m.id), m.at);
      // Out of the list, unless something came meanwhile.
      await saveConversation(db, { ...kept, unread, ...(left === 0 ? { hidden: true } : {}) }, ids, before);
    });
  }

  /** Deletes one message from this device only; the other side keeps theirs. */
  async function deleteHere(conv: string, id: string): Promise<void> {
    const m = await getMessage(db, conv, id);
    if (!m) return;
    await discardUploads([m]);
    await forget(conv, id);
  }

  /**
   * Deletes one message here, and remembers it as deleted by the user (a
   * keyed hash of its ID, not the ID): one of theirs then doesn't come back
   * if it's delivered again, and an edit or reaction for either side's isn't
   * kept for later. Read again under the chat's lock, like everything that
   * changes it: a second tap, or another copy, finds it gone and does nothing.
   */
  async function forget(conv: string, id: string): Promise<void> {
    await withLock(`send:${conv}`, async () => {
      const m = await db.get('messages', [conv, id]);
      if (!m) return;
      await deleteMessage(db, conv, id);
      const c = await getConversation(db, conv);
      if (!c) return;
      const before = await getIds(db, conv);
      let { c: kept, ids } = await tidied(c, now(), before);
      const tag = await idTag(await accountSecret(db), c.id, id);
      // Theirs can come again until it's too old: by when it was sent. Ours
      // can't come again; only what names it can.
      if (m.out) dropMine(ids, tag, m.at);
      else kept = drop(kept, ids, tag, sentAt(m));
      if (!m.out && m.status === 'received' && kept.unread > 0) kept = { ...kept, unread: kept.unread - 1 };
      await saveConversation(db, kept, ids, before);
    });
  }

  /**
   * Remembers (in ids) a message of theirs the user deleted here. Past
   * MAX_DROPPED the oldest go, and then their messages up to the end of that
   * day (their clock) are dropped instead (droppedBefore).
   */
  function drop(c: ConversationRecord, ids: ConversationIds, tag: string, at: number): ConversationRecord {
    const { days, lost } = remember(ids.dropped, tag, at, MAX_DROPPED);
    ids.dropped = days;
    return lost === undefined ? c : { ...c, droppedBefore: Math.max(c.droppedBefore ?? -Infinity, endOf(lost)) };
  }

  /**
   * Remembers (in ids) one of the user's own messages deleted here, by our
   * clock's day: their reactions or edits naming it then aren't kept for
   * later. Past MAX_MINE the oldest go, and nothing is dropped by time for
   * it (our clock isn't theirs).
   */
  function dropMine(ids: ConversationIds, tag: string, at: number): void {
    ids.mine = remember(ids.mine, tag, at, MAX_MINE).days;
  }

  /**
   * A conversation and what it remembers by keyed hashes, as kept at `t`:
   * without what can no longer matter (replay.ts), and with the deletes
   * older versions kept by ID on the record moved into `gone` as keyed
   * hashes. `ids` is a copy: what changed in it is told apart from
   * `before` by identity (saveConversation).
   */
  async function tidied(c: ConversationRecord, t: number, before: ConversationIds): Promise<{ c: ConversationRecord; ids: ConversationIds }> {
    const ids: ConversationIds = { ...before };
    let next = c;
    if (c.deleted) {
      const { deleted, ...rest } = c;
      const secret = await accountSecret(db);
      for (const d of deleted) ids.gone = remember(ids.gone, await idTag(secret, c.id, d.id), d.at, MAX_GONE).days;
      next = rest;
    }
    for (const kind of ID_KINDS) {
      const kept = forgetOld(ids[kind], t);
      if (kept) ids[kind] = kept;
      else delete ids[kind];
    }
    return { c: tidy(next, t), ids };
  }

  async function blockedTags(): Promise<Set<string>> {
    const value = await getMeta<unknown>(db, META_BLOCKED);
    return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
  }

  function addBlockedTag(linkFingerprint: string, tag: string): Promise<void> {
    return withLock(META_BLOCKED, async () => {
      await putMeta(db, META_BLOCKED, [...(await blockedTags()), `${linkFingerprint}:${tag}`]);
    });
  }

  function removeBlockedTag(linkFingerprint: string, tag: string): Promise<void> {
    return withLock(META_BLOCKED, async () => {
      await putMeta(db, META_BLOCKED, [...(await blockedTags())].filter((t) => t !== `${linkFingerprint}:${tag}`));
    });
  }

  /**
   * Sends an envelope to a mailbox without logging in, paying with as many
   * send tokens as it costs (sendTokensFor).
   */
  async function deliver(mailbox: string, envelope: Uint8Array, quiet: boolean): Promise<void> {
    let needed = sendTokensFor(envelope.length);
    let dropped = 0;
    let repriced = false;
    try {
      for (;;) {
        const tokens = await nextTokens(needed);
        try {
          const body = { mailbox, envelope: toBase64Url(envelope), tokens: tokens.map((t) => t.token), ...(quiet ? { quiet: true } : {}) };
          await api.post('/send', body, checkObject);
          return;
        } catch (err) {
          // Tokens the server refuses (one spent, or too old) are dropped, all
          // that went with them; try others. More than once, but no more
          // than one send's worth: the tokens of a send whose answer was lost
          // come back to the wallet together (below), spent.
          if (err instanceof ApiError && err.code === 'invalid_token') {
            dropped += tokens.length;
            if (dropped <= MAX_SEND_TOKENS) continue;
            throw err;
          }
          // Not spent: a capped send, one that may never have arrived, or
          // one the server prices higher than this app did.
          if ((err instanceof ApiError && (err.code === 'rate_limited' || err.code === 'tokens_needed')) || err instanceof NetworkError) {
            await returnTokens(db, tokens);
          }
          // Pay what the server asks, once, if it's no more than an envelope can cost.
          if (err instanceof ApiError && err.code === 'tokens_needed' && !repriced && err.needed !== undefined && err.needed > needed && err.needed <= MAX_SEND_TOKENS) {
            repriced = true;
            needed = err.needed;
            continue;
          }
          throw err;
        }
      }
    } finally {
      deps.onTokens?.();
    }
  }

  /** Takes the media tokens an upload costs, fetching more if the wallet runs short. */
  async function takeMediaTokens(count: number): Promise<StoredToken[]> {
    if (!mediaIssuer) throw new NoTokens();
    const seconds = () => Math.floor(now() / 1000);
    const taken: StoredToken[] = [];
    try {
      let refilled = false;
      while (taken.length < count) {
        const token = await takeToken(db, seconds(), 'media');
        if (token) {
          taken.push(token);
          refilled = false;
          continue;
        }
        // A refill that brought nothing: give up rather than ask again.
        if (refilled) throw new NoTokens();
        // Out of tokens: fetching right before an upload is a timing hint,
        // but the wallet is normally refilled well ahead (maintain()).
        try {
          await refillTokens(db, session, mediaIssuer, Math.min(MAX_BATCH, Math.max(MEDIA_BATCH, count - taken.length)), seconds(), 'media');
        } catch (err) {
          // The day's media tokens are used up.
          if (err instanceof ApiError && err.code === 'rate_limited') throw new NoTokens();
          throw err;
        }
        refilled = true;
      }
    } catch (err) {
      for (const t of taken) await returnToken(db, t.token, t.epoch, 'media');
      throw err;
    }
    return taken;
  }

  /** Takes the send tokens a send costs, fetching more if the wallet has fewer. */
  async function nextTokens(count: number): Promise<StoredToken[]> {
    const seconds = () => Math.floor(now() / 1000);
    let tokens = await takeTokens(db, count, seconds());
    if (!tokens) {
      // Too few: fetching right before a send is a timing hint, but the
      // wallet is normally refilled well ahead (maintain()), with more
      // than the longest message costs.
      try {
        await refillTokens(db, session, issuer, Math.max(TOKEN_BATCH, count), seconds());
      } catch (err) {
        // The day's tokens are used up.
        if (err instanceof ApiError && err.code === 'rate_limited') throw new NoTokens();
        throw err;
      }
      tokens = await takeTokens(db, count, seconds());
    }
    if (!tokens) throw new NoTokens();
    return tokens;
  }

  /**
   * Until when (Unix ms) the inbox isn't fetched: the server said this
   * device fetched too much for now (rate_limited), or for today
   * (daily_limit). And the longest that pause can be: one longer means the
   * clock was set back since, and it's over.
   */
  let fetchPausedUntil = 0;
  let fetchPauseMax = 0;
  /** The sync for when the pause ends (onResume). */
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The walk through the inbox under way, if a sync stopped partway: where
   * it goes on (`after`), where this pass began (`origin`, null: the
   * start), and whether it has gone round past the end to the start again,
   * up to `origin` (`round`).
   */
  let walk: { after: string | null; origin: string | null; round: boolean } | null = null;
  /** Items confirmed lately: ID → when (Unix ms), oldest first. */
  const confirmed = new Map<string, number>();
  /** Pages received but not confirmed yet (the server couldn't take them then): their IDs, and when they were listed, oldest first. */
  const unconfirmed: { ids: string[]; at: number }[] = [];
  const pending = new Set<string>();

  /**
   * Fetches, opens and stores new messages and receipts, then confirms them.
   * Returns how many changed something shown: new messages, seen receipts
   * that marked ours, ends.
   *
   * A sync walks the inbox a page at a time, at most MAX_INBOX_PAGES; the
   * next one carries on where it stopped, so items behind many others (or
   * behind old ones the server skips) are reached in the end. A walk that
   * starts partway goes round to the start once, up to where it started,
   * for what arrived before. What the server can't confirm now is kept and
   * confirmed later; once MAX_PENDING wait, the walk stops, so nothing is
   * read again and again before it's confirmed. Items that can't be taken
   * in yet (NotYet) stay unconfirmed, and the walk goes past them.
   */
  function sync(): Promise<number> {
    return withLock('messaging-sync', async () => {
      let received = 0;
      unresolved = new Map();
      const busy = new Set<string>();
      try {
        await confirmLater();
        if (paused()) {
          scheduleResume();
          return received;
        }
        const w = walk ?? { after: null, origin: null, round: false };
        // Resumed partway: this pass goes round to here.
        if (!w.round) w.origin = w.after;
        walk = w;
        for (let page = 0; page < MAX_INBOX_PAGES && pending.size < MAX_PENDING; page++) {
          const path: string = w.after ? `/inbox?after=${w.after}` : '/inbox';
          let listed: ReturnType<typeof checkInbox>;
          try {
            listed = await session.call('GET', path, undefined, checkInbox);
          } catch (err) {
            if (!(err instanceof ApiError && (err.code === 'rate_limited' || err.code === 'daily_limit'))) throw err;
            // The rest waits: the next sync goes on with this page.
            pause(err.code === 'daily_limit');
            return received;
          }
          const listedAt = now();
          const { items, more, next } = listed;
          // Confirmed lately, or waiting to be: listed again, nothing to do.
          const fresh = items.filter((i) => !confirmed.has(i.id) && !pending.has(i.id));
          const held = new Set<string>();
          for (const item of fresh) {
            try {
              if (await receive(item, busy)) received++;
            } catch (err) {
              if (!(err instanceof NotYet)) throw err;
              held.add(item.id);
            }
          }
          // Confirmed whether or not they opened: what we can't open now we
          // never will. Except those that can't be judged yet: they wait,
          // unconfirmed, and the walk goes on past them (a later one takes
          // them in).
          const done = fresh.filter((i) => !held.has(i.id)).map((i) => i.id);
          if (done.length > 0) await confirm(done, listedAt);
          if (more && next) {
            // Back where this pass began, having gone round: the rest was walked already.
            if (w.round && w.origin !== null && next >= w.origin) {
              walk = null;
              break;
            }
            // A page can be empty and still have more after it (old envelopes the server skips).
            w.after = next;
          } else if (more && done.length > 0) {
            // A server that gives no `next`: from the start again, without
            // what was confirmed. Not for a page of only what waits, which
            // would come again the same.
            w.after = null;
          } else if (w.round || w.origin === null) {
            // The end.
            walk = null;
            break;
          } else {
            // Round to the start, for what arrived before where it began.
            w.round = true;
            w.after = null;
          }
        }
      } catch (err) {
        // The next sync starts from the start, not again where this failed.
        walk = null;
        // What was stored before is still news.
        throw received > 0 ? new SyncFailed(received, err) : err;
      } finally {
        // Once each chat that was busy is free, the app syncs again for what waits.
        for (const id of busy) void withLock(`send:${id}`, async () => {}).then(() => deps.onWaiting?.());
      }
      return received;
    });
  }

  /**
   * Confirms a page's IDs, listed at `at`. Those whose delete failed
   * (`retry`) are kept for the next sync. If the request fails, they're
   * kept too (a network error, or the server's: 5xx, 429), unless the
   * server refused them for good (any other 4xx: IDs it no longer takes,
   * say after its key changed): then they're dropped, and their items are
   * listed again under new IDs. Throws what went wrong, except that refusal.
   */
  async function confirm(ids: string[], at: number): Promise<void> {
    let retry: string[];
    try {
      ({ retry } = await session.call('POST', '/ack', { ids }, checkAck));
    } catch (err) {
      const forGood = err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429;
      if (!forGood) keep(ids, at);
      if (forGood && err.code === 'bad_request') return;
      throw err;
    }
    rememberConfirmed(ids.filter((id) => !retry.includes(id)));
    if (retry.length > 0) keep(retry, at);
  }

  /**
   * Confirms what earlier syncs couldn't, oldest first: only what was
   * waiting when it started, so what fails again waits for the next sync
   * rather than going straight back. IDs too old for the server go: their
   * items are listed again under new ones.
   */
  async function confirmLater(): Promise<void> {
    const batches = unconfirmed.splice(0);
    for (const batch of batches) batch.ids.forEach((id) => pending.delete(id));
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]!;
      if (batch.at < now() - UNCONFIRMED_FOR_MS) continue;
      try {
        await confirm(batch.ids, batch.at);
      } catch (err) {
        for (const rest of batches.slice(i + 1)) keep(rest.ids, rest.at);
        throw err;
      }
    }
  }

  function keep(ids: string[], at: number): void {
    unconfirmed.push({ ids, at });
    ids.forEach((id) => pending.add(id));
    // Bounded: the oldest go, and are listed and confirmed again later.
    while (pending.size > MAX_CONFIRMED && unconfirmed.length > 1) dropOldest();
  }

  /** Forgets the oldest batch waiting to be confirmed. */
  function dropOldest(): void {
    unconfirmed.shift()?.ids.forEach((id) => pending.delete(id));
  }

  /** Pauses fetching: for a minute or so, or, past the day's limit, until the next UTC day. */
  function pause(daily: boolean): void {
    if (daily) {
      fetchPausedUntil = (Math.floor(now() / DAY) + 1) * DAY + Math.random() * 60_000;
      fetchPauseMax = DAY + 60_000;
    } else {
      fetchPausedUntil = now() + SYNC_PAUSE_MS * (1 + Math.random());
      fetchPauseMax = 2 * SYNC_PAUSE_MS;
    }
    stop();
    scheduleResume();
  }

  function paused(): boolean {
    const left = fetchPausedUntil - now();
    return left > 0 && left <= fetchPauseMax;
  }

  /** Syncs when the pause ends, for what it held back: pushes that came meanwhile weren't acted on. */
  function scheduleResume(): void {
    if (!deps.onResume || resumeTimer !== undefined || !paused()) return;
    resumeTimer = setTimeout(
      () => {
        resumeTimer = undefined;
        deps.onResume?.();
      },
      fetchPausedUntil - now(),
    );
  }

  /** Stops the timer a pause set: the app no longer syncs (signed out, or the engine replaced). */
  function stop(): void {
    clearTimeout(resumeTimer);
    resumeTimer = undefined;
  }

  function rememberConfirmed(ids: string[]): void {
    const t = now();
    for (const id of ids) confirmed.set(id, t);
    for (const [id, at] of confirmed) {
      if (at >= t - CONFIRMED_FOR_MS && confirmed.size <= MAX_CONFIRMED) break;
      confirmed.delete(id);
    }
  }

  /**
   * Handles one inbox item; returns whether it changed anything shown (a new
   * message, a receipt, an end). Throws NotYet for one to leave in the inbox:
   * its chat is busy (added to busy), or its link can't be asked now.
   */
  async function receive(item: InboxItem, busy: Set<string>): Promise<boolean> {
    let message: Message;
    let keyId: Uint8Array;
    try {
      ({ message, keyId } = await openMessage(fromBase64Url(item.envelope), findKey));
    } catch {
      return false;
    }
    const entry = await lookupKey(db, keyId);
    const t = now();
    if (!entry || message.at < t - MAX_AGE || message.at > t + DAY) return false;

    // Which conversation it belongs to comes from how it reached us: the key
    // it was written for, and the mailbox it came through (the server says
    // which). Never from its IDs alone: those are the other side's choice, so
    // the same ID in any other conversation on this device must change
    // nothing. And through any mailbox but its key's own, it's dropped like
    // one we can't open: else whoever knows one of our keys could leave
    // envelopes in suspects' mailboxes and watch which one is taken in.
    let local: string;
    let fresh: ConversationRecord | undefined;
    if (entry.link) {
      // Written for our link's key: only through that link's intro mailbox.
      if (item.mailbox !== (entry.link.mailbox ?? (await introOf(entry.link.id)))) return false;
      // A new conversation, or more from a sender we haven't answered yet
      // (whose key can't change meanwhile). Only a conversation through this
      // link, with this ID, from this key, counts.
      const found = await findLinkConversation(db, entry.link.id, message.conv, message.from);
      if (found) {
        local = found.id;
      } else {
        if (!message.reply) return false;
        // A new conversation from a person we blocked through this link.
        // By the link's fingerprint, which a replaced link keeps.
        if (message.tag && (await blockedTags()).has(`${entry.link.fingerprint}:${message.tag}`)) return false;
        const secret = await accountSecret(db);
        fresh = {
          id: newLocalId(),
          wire: message.conv,
          role: 'owner',
          link: { id: entry.link.id, fingerprint: entry.link.fingerprint },
          // Where they write until they hear of a mailbox of ours.
          intro: item.mailbox,
          // Senders who don't send a tag (modified clients) are named by their key.
          label: await label(secret, 'anon', fromBase64Url(message.tag ?? message.from)),
          peerKey: message.from,
          firstKey: message.from,
          myKey: null,
          sendTo: message.reply,
          myMailbox: null,
          lastAt: 0,
          unread: 0,
          status: 'active',
          lastReceived: null,
          ...(message.tag ? { tag: message.tag } : {}),
          // Started by something other than a message (a delete or reaction
          // that overtook it): out of the list until a message comes.
          ...(message.kind !== 'message' ? { hidden: true } : {}),
        };
        local = fresh.id;
      }
    } else if (entry.conv) {
      local = entry.conv;
    } else {
      return false;
    }
    // The rest reads and writes the conversation under the lock our sends in
    // it hold: else a reply going out meanwhile (taking a mailbox and a key)
    // would be undone by this writing back what it read before. If a send
    // holds it now, this waits for the next sync rather than holding up
    // everything else coming in.
    const taken = await withLockIfFree(`send:${local}`, () => takeIn(item, message, entry, t, local, fresh));
    if (taken) return taken.value;
    busy.add(local);
    throw new NotYet();
  }

  /** Takes an envelope into its conversation (receive), under that conversation's send lock. */
  async function takeIn(item: InboxItem, message: Message, entry: KeyEntry, t: number, local: string, fresh?: ConversationRecord): Promise<boolean> {
    let conv: ConversationRecord;
    if (fresh) {
      conv = fresh;
    } else {
      const found = await getConversation(db, local);
      if (!found) return false;
      if (entry.link) {
        // More from a sender we haven't answered yet: from the same key.
        if (found.peerKey !== message.from) return false;
      } else if (found.wire !== message.conv || !(await cameThrough(found, item.mailbox))) {
        // Written for our conversation key, which only the other side knows:
        // only through that conversation's mailbox.
        return false;
      }
      conv = found;
    }
    // Nothing more from a blocked conversation.
    if (conv.status === 'blocked') return false;
    const secret = await accountSecret(db);
    const tagOf = (id: string) => idTag(secret, conv.id, id);
    const tag = await tagOf(message.id);
    const before = await getIds(db, conv.id);
    // Taken in already: delivered again (by a server that kept it, or a
    // stale inbox read), maybe to another copy of the app. Or a message this
    // conversation has (from before envelopes taken in were remembered).
    // Dropped before anything changes.
    if (remembers(before.applied, tag) || (await hasMessage(db, conv.id, message.id))) return false;
    if (entry.conv && entry.pub === conv.myKey) {
      // They have our current key, so they no longer write to older ones:
      // those go once anything written to them has expired from the inbox.
      const { id: local, myKey: current } = conv;
      await scheduleKeyDeletion(db, (e) => e.conv === local && e.pub !== current, now() + KEY_RETENTION_MS);
    }
    if (item.mailbox === conv.myMailbox) {
      // Likewise, they write to our current mailbox: the ones they wrote to
      // before (the link's, or a former one of ours) count until what they
      // wrote there can no longer be waiting.
      const until = t + MAILBOX_GRACE;
      if (conv.role === 'owner' && conv.introUntil === undefined) conv = { ...conv, introUntil: until };
      if (conv.formerMailboxes?.some((f) => f.until === undefined)) {
        conv = { ...conv, formerMailboxes: conv.formerMailboxes.map((f) => (f.until === undefined ? { ...f, until } : f)) };
      }
    }

    // Remembered as taken in until it's too old to come again (by its `at`).
    let ids: ConversationIds;
    ({ c: conv, ids } = await tidied(conv, t, before));
    ids.applied = remember(ids.applied, tag, message.at, MAX_APPLIED).days;
    if (!conv.newest) {
      // Kept from before the newest was (older versions set lastReceived
      // from any kind, in the order taken in): start from their newest
      // message here.
      const start = await newestTheirs(db, conv.id);
      if (start) conv = { ...conv, newest: { at: start.at, tag: await tagOf(start.id) } };
    }
    // Only the newest envelope of theirs says which key they write from and
    // where we write to: one that comes late or again mustn't move us back.
    if (isNewer(message.at, tag, conv.newest)) {
      conv = { ...conv, peerKey: message.from, sendTo: message.reply ?? conv.sendTo, lastReceived: message.id, newest: { at: message.at, tag } };
    }
    // Anything of ours it names, they had by its time (their clock): what a
    // delete of the whole conversation from then on takes of ours (below).
    const read = new Set(message.kind === 'seen' ? (message.seen ?? []) : []);
    const named = [...read, ...[message.last, message.replyTo, message.reaction?.to].filter((id): id is string => id !== undefined)];
    const had = await noteHad(db, conv.id, named, message.at, read);
    const cleared = conv.clearedBefore ?? -Infinity;
    // Theirs sent by then are dropped: cleared for both sides, or (only past
    // what's remembered one by one) deleted here.
    const floor = Math.max(cleared, conv.droppedBefore ?? -Infinity);
    // Deleted one by one: by them, or by the user here.
    const deleted = (t: string) => remembers(ids.gone, t) || remembers(ids.dropped, t) || remembers(ids.mine, t);
    // Shown no later than it arrived, so a fast clock can't push a message above newer ones.
    const at = Math.min(message.at, t);
    let changed = false;
    let clear = false;
    if (message.kind === 'message' && (deleted(tag) || message.at <= floor)) {
      // Deleted before it got here: by them for both sides (their delete
      // came first), here, or with the whole conversation after it was sent.
    } else if (message.kind === 'delete' && message.all) {
      // They deleted the whole conversation for both sides, at its `at`: what
      // was sent by then goes here too (below), and anything of theirs from
      // by then that comes later is dropped. One from no later than a time
      // it's already cleared to has nothing more to take.
      if (message.at > cleared) {
        conv.clearedBefore = message.at;
        // Their app names in `last` the newest of ours it had: nothing of
        // ours newer than that was theirs before the delete, whatever a
        // receipt of theirs dated before it says (their clock may have been
        // set back since).
        const named = message.last ? await db.get('messages', [conv.id, message.last]) : undefined;
        conv.theirClear = { upTo: message.at, here: t, ...(named?.out ? { ours: named.at } : {}) };
        clear = true;
      }
    } else if (message.kind === 'message' && (message.text || message.media || message.sticker)) {
      await addMessage(
        db,
        {
          id: message.id,
          conv: conv.id,
          at,
          // Their clock runs ahead: when they sent it, by their clock.
          ...(message.at !== at ? { sent: message.at } : {}),
          out: false,
          status: 'received',
          ...(message.media ? { file: 'remote' as const } : {}),
        },
        {
          text: message.text ?? '',
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          ...(message.media ? { media: message.media } : {}),
          ...(message.sticker ? { sticker: message.sticker } : {}),
        },
      );
      conv.unread += 1;
      conv.lastAt = Math.max(conv.lastAt, at);
      // The newest of theirs taken in (from before it was kept: their newest here).
      const newest = conv.lastMessage ?? (await newestTheirs(db, conv.id));
      if (!newest || message.at > newest.at || (message.at === newest.at && message.id > newest.id)) conv.lastMessage = { at: message.at, id: message.id };
      else if (!conv.lastMessage) conv.lastMessage = newest;
      // Something new brings a deleted conversation back.
      conv.hidden = false;
      changed = true;
      // An edit of it that came first.
      const early = conv.edits?.find((e) => e.id === message.id);
      if (early) {
        conv.edits = conv.edits!.filter((e) => e !== early);
        const text = await openPendingEdit(db, early.id, early.sealed);
        // Both times are from their clock: only within the edit window.
        if ((text.trim() !== '' || message.media) && early.at - message.at <= EDIT_WINDOW_MS + EDIT_GRACE_MS) await setText(db, conv.id, message.id, text, early.at);
      }
      // A reaction to it that came first.
      const reacted = conv.reactions?.find((r) => r.tag === tag);
      if (reacted) {
        conv.reactions = conv.reactions!.filter((r) => r !== reacted);
        await setReaction(db, conv.id, message.id, 'theirs', await openPendingReaction(db, reacted.tag, reacted.sealed), reacted.at);
      }
    } else if (message.kind === 'seen') {
      // They opened these: our messages in this conversation only (noted above).
      changed = had.seen > 0;
    } else if (message.kind === 'edit' && message.edit) {
      // Only their own messages in this conversation, within a day of sending
      // (with an hour of grace for clocks and late arrivals), and the latest
      // edit wins. One for a message that hasn't arrived yet is kept, sealed,
      // until it does; not for one deleted here, nor one sent before the
      // conversation was cleared (it would be dropped).
      const { to, text } = message.edit;
      const target = await getMessage(db, conv.id, to);
      if (target) {
        const inTime = message.at - sentAt(target) <= EDIT_WINDOW_MS + EDIT_GRACE_MS;
        if (!target.out && !target.sticker && inTime && (text.trim() !== '' || target.media)) {
          changed = await setText(db, conv.id, to, text, message.at);
        }
      } else if (!deleted(await tagOf(to)) && message.at > floor) {
        const since = t - MAX_AGE;
        const kept = (conv.edits ?? []).filter((e) => e.at >= since && !(e.id === to && e.at < message.at));
        if (!kept.some((e) => e.id === to)) kept.push({ id: to, at: message.at, sealed: await sealPendingEdit(db, to, text) });
        conv.edits = kept.slice(-MAX_PENDING_EDITS);
      }
    } else if (message.kind === 'delete' && message.delete) {
      // Only their own messages: a delete can't reach ours. Each is
      // remembered as gone, here or still to come, so it's dropped if it
      // comes (again), until it no longer could: it was sent before this
      // delete, by their clock.
      for (const id of message.delete) {
        const target = await db.get('messages', [conv.id, id]);
        if (target?.out) continue;
        if (target) {
          if (target.status === 'received' && conv.unread > 0) conv.unread -= 1;
          await deleteMessage(db, conv.id, id);
          changed = true;
        }
        // Gone from their side too, so a delete of ours for both sides
        // mustn't name it: it names their newest message here instead.
        if (conv.lastMessage?.id === id) delete conv.lastMessage;
        ids.gone = remember(ids.gone, await tagOf(id), message.at, MAX_GONE).days;
      }
    } else if (message.kind === 'reaction' && message.reaction) {
      // To a message of this conversation only, by their clock: the latest
      // wins. One to a message not here yet (one of theirs still on its way)
      // is kept, sealed, until it comes; not for one deleted here, nor one
      // sent before the conversation was cleared (it would be dropped).
      const { to, e } = message.reaction;
      const target = await getMessage(db, conv.id, to);
      if (target) {
        changed = await setReaction(db, conv.id, target.id, 'theirs', e, message.at);
      } else {
        const toTag = await tagOf(to);
        if (!deleted(toTag) && message.at > floor) {
          const kept = (conv.reactions ?? []).filter((r) => !(r.tag === toTag && r.at < message.at));
          if (!kept.some((r) => r.tag === toTag)) kept.push({ tag: toTag, at: message.at, sealed: await sealPendingReaction(db, toTag, e) });
          conv.reactions = kept.slice(-MAX_PENDING_REACTIONS);
        }
      }
    } else if (message.kind === 'end') {
      changed = conv.status !== 'ended';
      conv.status = 'ended';
    }
    // A delete of the whole conversation takes, by their clock, their
    // messages sent by then, and ours up to the newest they had by then
    // (named by it as `last`, or by an earlier receipt, reaction or reply).
    // Never ours by our clock against theirs, which may differ. Something of
    // theirs from before it that comes later and names more of ours (a late
    // receipt) takes those too: they had them when they deleted. But never
    // one we wrote after taking the delete in (by our clock): their clock may
    // have been set back since, and then dates what they had of it before
    // their delete. Nor, if the delete's `last` named one of ours, any of
    // ours newer than that one: their app names the newest of ours it had,
    // so a newer one (on its way when they deleted) reached them after it,
    // and they keep it. Only their delete does this, not ours.
    const theirs = conv.theirClear;
    if (theirs && (clear || (had.here && message.at <= theirs.upTo))) {
      const { upTo, here, ours } = theirs;
      const { left, unread, removed } = await clearMessages(db, conv.id, { theirs: upTo, oursHadBy: upTo, oursWrittenBy: Math.min(here, ours ?? Infinity) });
      conv.unread = unread;
      // Out of the list until either side writes again.
      if (left === 0) conv.hidden = true;
      // Edits and reactions waiting for messages it took (sent before them) go too.
      if (conv.edits) conv.edits = conv.edits.filter((e) => e.at > upTo);
      if (conv.reactions) conv.reactions = conv.reactions.filter((r) => r.at > upTo);
      if (clear || removed > 0) changed = true;
    }
    await saveConversation(db, conv, ids, before);
    return changed;
  }

  /**
   * Whether an envelope written for one of a conversation's keys came through
   * that conversation's mailbox: ours for it; or one of ours it used until
   * recently (retire); or, in a chat someone started through our link, the
   * link's intro mailbox: they write there until they hear of ours, so it
   * counts until introUntil (receive). A chat from before the intro mailbox
   * was kept on it asks the link (upkeep then keeps it on the chat).
   */
  async function cameThrough(c: ConversationRecord, mailbox: string): Promise<boolean> {
    const t = now();
    if (c.myMailbox !== null && mailbox === c.myMailbox) return true;
    if ((c.formerMailboxes ?? []).some((f) => f.id === mailbox && (f.until === undefined || t < f.until))) return true;
    if (c.role !== 'owner' || (c.introUntil !== undefined && t >= c.introUntil)) return false;
    return mailbox === (c.intro ?? (await introOf(c.link.id)));
  }

  /**
   * Links whose intro mailbox the current sync asked for and didn't get:
   * gone, or not now (out of reach, refused, or a bundle that isn't the
   * link's). Each is asked once per sync.
   */
  let unresolved = new Map<string, 'gone' | 'later'>();

  /**
   * The intro mailbox of one of our links: the current one, or one replaced
   * while its keys are kept. A link made before it was kept learns it from
   * its bundle. If that can't be fetched now, this throws NotYet: only the
   * envelopes that need it wait for the next sync, the rest go on.
   */
  async function introOf(linkId: string): Promise<string | undefined> {
    const known = await introMailbox(db, linkId);
    if (known) return known;
    const link = (await listLinks(db)).find((l) => l.id === linkId);
    const asked = unresolved.get(linkId);
    if (!link || asked === 'gone') return undefined;
    if (asked === 'later') throw new NotYet();
    let bundle: Bundle;
    try {
      bundle = await ownBundle(link);
    } catch (err) {
      // Gone (revoked or replaced elsewhere): nothing comes through it now.
      const gone = err instanceof ApiError && err.code === 'not_found';
      unresolved.set(linkId, gone ? 'gone' : 'later');
      if (gone) return undefined;
      throw new NotYet();
    }
    await setLinkMailbox(db, linkId, bundle.mailbox);
    return bundle.mailbox;
  }

  /**
   * One of our links' bundle, checked to be that link's before anything in
   * it is kept: signed by our link signing key (the link's fingerprint), and
   * listing a key we made for this link. A server mixing up bundles must not
   * leave a link taking first messages through another's mailbox.
   */
  async function ownBundle(link: LinkRecord): Promise<Bundle> {
    const bundle = await api.request('GET', `/links/${link.id}`, {}, checkBundle);
    // Checked as of its newest key's start, so a link whose keys lapsed
    // while the app was away still checks.
    await verifyBundle(link, bundle, Math.max(...bundle.keys.map((k) => k.from)));
    const ours = bundle.keys.some((k) => link.keys.some((mine) => mine.from === k.from && (mine.pub === undefined || mine.pub === toBase64Url(k.key))));
    if (!ours) throw new BundleMismatch('not a key of this link');
    return bundle;
  }

  async function markRead(conv: string): Promise<void> {
    const c = await getConversation(db, conv);
    if (c && c.unread > 0) await update(conv, (current) => (current.unread > 0 ? { ...current, unread: 0 } : null));
  }

  /**
   * What conversations remember to drop envelopes that come again (replay.ts)
   * goes once nothing it covers can still be taken in, also in conversations
   * nothing comes to any more (deleted ones, say). Needs no network.
   */
  async function forgetExpired(): Promise<void> {
    const unchanged = (c: ConversationRecord, before: ConversationIds, after: { c: ConversationRecord; ids: ConversationIds }) =>
      after.c === c && ID_KINDS.every((kind) => after.ids[kind] === before[kind]);
    for (const c of await listConversations(db)) {
      const kept = await getIds(db, c.id);
      if (unchanged(c, kept, await tidied(c, now(), kept))) continue;
      await withLock(`send:${c.id}`, async () => {
        const current = await getConversation(db, c.id);
        if (!current) return;
        const before = await getIds(db, c.id);
        const after = await tidied(current, now(), before);
        if (!unchanged(current, before, after)) await saveConversation(db, after.c, after.ids, before);
      });
    }
  }

  /**
   * Upkeep, run at a random moment after the app opens: tops up the mailbox
   * pool and the token wallet, so neither is fetched right before a send;
   * deletes old keys whose time has come; forgets what conversations
   * remember of envelopes too old to come again; fills in what older
   * versions didn't keep (links' intro mailboxes); gives the link a new key
   * when due.
   */
  async function maintain(): Promise<void> {
    const steps = [
      forgetExpired,
      flushUploadDeletes,
      healMailboxes,
      async () => {
        if ((await poolSize(db)) < POOL_LOW) await refillPool(db, session);
      },
      async () => {
        if ((await countTokens(db, Math.floor(now() / 1000))) < LOW_WATER) {
          await refillTokens(db, session, issuer, undefined, Math.floor(now() / 1000));
          deps.onTokens?.();
        }
      },
      async () => {
        if (mediaIssuer && (await countTokens(db, Math.floor(now() / 1000), 'media')) < MEDIA_LOW_WATER) {
          await refillTokens(db, session, mediaIssuer, MEDIA_BATCH, Math.floor(now() / 1000), 'media');
        }
      },
      async () => {
        if ((await deleteExpiredKeys(db, now())) > 0) findKey.clear();
      },
      backfillLinks,
      backfillIntros,
      () => rotateLinkKey(db, session, Math.floor(now() / 1000)),
    ];
    // Each on its own: one that fails (out of reach, or a daily limit
    // reached) doesn't keep the others from running. The first failure is
    // reported once all have run.
    let failure: { err: unknown } | null = null;
    for (const step of steps) {
      try {
        await step();
      } catch (err) {
        failure ??= { err };
      }
    }
    if (failure) throw failure.err;
  }

  /**
   * Mailboxes we hold that the server no longer has as ours: left from an
   * account replaced on this device (before a new setup wiped such data).
   * They leave the pool, and a conversation that gave one as our reply
   * address takes a new one with its next message or receipt, which tells
   * the other side. Blocked conversations are left alone (their mailbox was
   * discarded on purpose).
   */
  async function healMailboxes(): Promise<void> {
    // Once a day is plenty: this only finds data left from an old account.
    const checked = await getMeta<number>(db, META_MAILBOXES_CHECKED);
    if (typeof checked === 'number' && now() - checked >= 0 && now() - checked < DAY) return;
    const convs = (await listConversations(db)).filter((c) => c.status === 'active' && c.myMailbox !== null);
    const ids = [...new Set([...(await pooled(db)), ...convs.map((c) => c.myMailbox!)])];
    if (ids.length === 0) return;
    const missing = new Set<string>();
    for (let i = 0; i < ids.length; i += CHECK_CHUNK) {
      try {
        const out = await session.call('POST', '/mailboxes/check', { ids: ids.slice(i, i + CHECK_CHUNK) }, checkObject);
        if (Array.isArray(out.missing)) for (const m of out.missing) if (typeof m === 'string') missing.add(m);
      } catch {
        return;
      }
    }
    await putMeta(db, META_MAILBOXES_CHECKED, now());
    if (missing.size === 0) return;
    await dropFromPool(db, missing);
    for (const c of convs) {
      if (!missing.has(c.myMailbox!)) continue;
      await withLock(`send:${c.id}`, async () => {
        const current = await getConversation(db, c.id);
        if (current && current.myMailbox === c.myMailbox) await putConversation(db, { ...current, myMailbox: null, ...retire(current, current.myMailbox) });
      });
    }
  }

  /**
   * Links made before their intro mailbox was kept, or before keys were
   * indexed: both come from the link's bundle. Each sealed key is matched to
   * the public key there, so first messages to it can be opened.
   */
  async function backfillLinks(): Promise<void> {
    for (const link of await listLinks(db)) {
      const indexed = await hasLinkKey(db, link.id);
      if (link.mailbox && indexed) continue;
      let bundle: Bundle;
      try {
        bundle = await ownBundle(link);
      } catch {
        continue;
      }
      for (const k of indexed ? [] : bundle.keys) {
        const own = link.keys.find((mine) => mine.from === k.from);
        if (own && (await getSealed(db, keyName(link.id, k.from)))) {
          await indexKey(db, k.key, { name: keyName(link.id, k.from), link: { id: link.id, fingerprint: link.fingerprint, mailbox: bundle.mailbox } });
        }
      }
      await setLinkMailbox(db, link.id, bundle.mailbox);
    }
  }

  /**
   * Chats someone started through our link before the intro mailbox was
   * kept on each: it comes from the link (backfillLinks), and is kept on the
   * chat, which then needs neither the network nor the link, even once the
   * link is revoked or replaced.
   */
  async function backfillIntros(): Promise<void> {
    for (const c of await listConversations(db)) {
      if (c.role !== 'owner' || c.intro !== undefined) continue;
      const intro = await introMailbox(db, c.link.id);
      if (intro) await update(c.id, (current) => (current.intro === undefined ? { ...current, intro } : null));
    }
  }

  return { startConversation, send, sendMedia, resendMedia, fetchMedia, discardUploads, flushUploadDeletes, deleteForEveryone, deleteHere, edit, sync, stop, markRead, markSeen, react, block, unblock, remove, maintain };
}

export type Messaging = ReturnType<typeof createMessaging>;
