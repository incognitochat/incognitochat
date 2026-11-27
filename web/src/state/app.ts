// What the app shows, and the actions that move between screens. The UI only
// reads `screen` and calls actions; it never touches storage, crypto or the
// network itself.

import { effect, signal } from '@preact/signals';
import {
  isRegistrationLaunch,
  isSetUp,
  logIn,
  AccountChanged,
  markDeletingElsewhere,
  prepareSetup,
  readAccount,
  register,
  registrationPath,
  rememberLink,
  META_START_OVER,
  REGISTRATION_PREFIX,
  SetupMismatch,
  takePendingLink,
} from '../account/account';
import {
  checkCreated,
  checkInvitations,
  checkLevels,
  checkRedeemed,
  invitationUrl,
  normalizeCode,
  parseInvitationPayload,
  type InvitationCode,
  type InvitationsInfo,
  type LevelAllowance,
} from '../account/invitations';
import { checkSwitches, type Switch, type Switches } from '../account/switches';
import { checkAccountInfo, createLink, listLinks, newKeyToTell, replaceLink, revokeLink, toldNewKey, type AccountInfo, type LinkRecord } from '../account/links';
import type { Config } from '../config';
import { budgetLeft, countTokens, lowerLeft, type TokenIssuer, type TokenKind } from '../account/wallet';
import { checkUsage, usageView, type UsageView } from '../account/usage';
import { poolSize } from '../messaging/pool';
import { importIssuerKey } from '../crypto/blindrsa';
import { toBase64Url } from '../crypto/encoding';
import { createMessaging, isPaused, MailboxLimit, NoMailboxes, NoTokens, resendUploads, SyncFailed, TurnedAway, type Messaging, type Outgoing } from '../messaging/engine';
import {
  answeredAt,
  attachmentsOf,
  clearMedia,
  comesAfter,
  failStuck,
  getConversation,
  openChatName,
  getMedia,
  getMessage,
  lastShown,
  listConversations,
  listRecords,
  mediaUsage,
  PAGE,
  pageMessages,
  pendingUploadDeletes,
  STUCK_MS,
  unsentBefore,
  type MessageView,
} from '../messaging/store';
import { DEFAULT_MEDIA_SETTINGS, fetchesByItself, getMediaSettings, keepCutoff, putMediaSettings, type KeepMedia, type MediaSettings } from '../messaging/settings';
import { prepareAudio, prepareFile, prepareGif, preparePhoto, prepareVideo, TooBig } from '../media/prepare';
import type { Recording, RoundRecording } from '../media/record';
import { saveUrl } from '../media/save';
import { fileName, passiveType, type Media, type Sticker } from '../protocol/message';
import { ApiError, checkObject, NetworkError, type Api } from '../net/api';
import { createBackoff } from '../net/backoff';
import { createClock } from '../net/clock';
import { createSession, type AppSession, type Session } from '../net/session';
import { createPushSocket } from '../net/socket';
import { BundleMismatch, checkBundle, linkUrl, parsePayload, verifyBundle, type Bundle, type LinkRef } from '../protocol/link';
import { pickLanguage } from '../i18n';
import type { Launch } from '../platform/launch';
import { openPopup, type Bridge, type PopupButton } from '../platform/telegram';
import { findSourceUrl } from '../platform/source';
import { deleteMeta, getMeta, putMeta, wipe, type ConversationRecord, type Database } from '../storage/db';
import { withLock, type SyncEvent } from '../sync/locks';
import { createPace } from '../sync/pace';
import { cleanName, isEmoji, shownLabel, type ChatCustom } from './label';

/** Whether the device says it's offline (its saying online proves nothing). */
const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * Between the steps of deleting an account (DELETE /account answers
 * in_progress until done), or what is left of one it replaced (POST
 * /account/cleanup, the same).
 */
const DELETE_STEP_PAUSE_MS = 1000;
/**
 * Set once the user typed the confirmation to delete the account, until
 * it's done: { accountId } of the account it's for. Every launch carries on
 * with it, since the server deletes in steps and the app may close before
 * the last; only for that account (deletionConfirmed), so a record left by
 * another copy of the app, after a new setup, deletes nothing. Only the
 * typed confirmation writes it: the server's word alone never deletes
 * anything on the device.
 */
const META_DELETING = 'deleting';
/**
 * The most steps one run of a deletion, or of a cleanup, asks for (an
 * account with 4,000 mailboxes takes about 160), and the longest it goes
 * on: past either, a deletion shows its error screen (Try again, the chats,
 * or deleting from this device only), and a cleanup stops, until a new run
 * (the next time the home screen finds something left). A server that keeps
 * answering "more" can't keep the user waiting.
 */
const STEPS_PER_RUN = 400;
const RUN_FOR_MS = 10 * 60_000;
/**
 * Before a deletion's first step, for how long the app fetches what still
 * waits for the device (a deletion just confirmed) and tries again the
 * uploads the server couldn't delete: it starts nothing more of either
 * after that (a request under way then can take up to its 15-second
 * timeout), and goes on with the deletion.
 */
const PREPARE_MS = 10_000;
/**
 * How many times the uploads still to delete that the server couldn't take
 * (out of reach, or failing) are tried again before a deletion's step,
 * after waiting so many step pauses (DELETE_STEP_PAUSE_MS) each: about 7
 * seconds in all between tries, within PREPARE_MS.
 */
const UPLOAD_DELETE_RETRIES = [1, 2, 4];
/** The longest wait a step's Retry-After (503 unavailable, 429) is honoured for. */
const STEP_WAIT_MAX_MS = 30_000;
/**
 * The pause between the deletes for both sides that go before deleting the
 * account, when the user asks for them (deleteChatsForBoth). The firewall
 * turns an address away for a few minutes past 500 requests in 5 minutes
 * to the routes that need no login (infra/edge.tf, anonymous-per-ip):
 * sends, logins and the uploads' deletes, which the deletion then needs
 * (one batch every 2 seconds, about 130 in 5 minutes). One send a second
 * at most, 300 in 5 minutes, leaves room for them.
 */
const CHAT_DELETE_GAP_MS = 1000;
/**
 * And at most so many of them in so long (CHAT_DELETE_WINDOW_MS), a
 * sliding window, also across Try again: a chat the user started that
 * wasn't answered also fetches its link's key first (GET /links/{id}, a
 * route without login too). With those and the uploads' deletes, at most
 * 450 in any 5 minutes, under the firewall's default of 500 (an operator
 * who sets it lower may see a run turned away, and Try again later).
 */
const CHAT_DELETES_PER_WINDOW = 150;
const CHAT_DELETE_WINDOW_MS = 5 * 60_000;

/**
 * Ends a deletion that took STEPS_PER_RUN steps, or RUN_FOR_MS, without
 * finishing. last: why its last step had to wait, if it did.
 */
class DeletionStalled extends Error {
  constructor(readonly last: unknown) {
    super('the deletion stalled');
    this.name = 'DeletionStalled';
  }
}

/**
 * How long to wait before the next step after err, or null if err ends the
 * run: in_progress the usual pause, and a server that is busy (503
 * unavailable) or turning requests away (429) at least that, or as long as
 * it asked (Retry-After), up to STEP_WAIT_MAX_MS.
 */
function stepWait(err: unknown, pause: number): number | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === 'in_progress') return pause;
  if (err.status === 503 || err.status === 429) return Math.max(pause, Math.min((err.retryAfter ?? 0) * 1000, STEP_WAIT_MAX_MS));
  return null;
}

/**
 * The server refused this device's login, signed request or other
 * logged-in request for now (deviceLimit): until the minute ends (device-limit, "Try again in a
 * minute"), or for longer, its quarter of an hour or its day being used up
 * (device-limit-later, "Try again later").
 */
export type DeviceLimit = 'device-limit' | 'device-limit-later';

/**
 * clock: the device's clock is too far off (more than two days) for the
 * server's to be believed.
 */
export type ErrorKind = 'network' | 'expired' | 'rate-limited' | DeviceLimit | 'clock' | 'generic';

/**
 * Why deleting the user's chats for both sides, before the account,
 * stopped (deleteChatsForBoth): the day's messages are used up
 * (no-tokens); the server couldn't be reached; it turned the sends away
 * for now (the firewall, or a mailbox's cap: 429 rate_limited), or the
 * device's requests (device_limit); a link a chat goes through takes no
 * more first messages this hour (link-busy: the other chats went on); this
 * build's token key was replaced or won't load (outdated: the app must be
 * opened again); or anything else.
 */
export type ChatsStop = 'no-tokens' | 'network' | 'turned-away' | DeviceLimit | 'link-busy' | 'outdated' | 'generic';

/**
 * Whether Try again may help with what stopped the deletes for both sides:
 * not until the messages reset, or a busy link's hour is over (each try
 * spends its tokens), or the app is opened again.
 */
export function canRetryChats(reason: ChatsStop): boolean {
  return reason !== 'no-tokens' && reason !== 'link-busy' && reason !== 'outdated';
}

/**
 * Why the server no longer takes this device: it refused the login (the
 * device or its account is gone), or says the account was replaced, or is
 * being deleted when this app didn't start that here; or expired: its
 * expiry is deleting the account, or did (nobody used it for 12 months).
 * Never checked, so asked again at every launch; nothing is deleted for it
 * (a deletion is finished, or a new setup made, only after the typed
 * confirmation).
 */
type SignedOutReason = 'refused' | 'replaced' | 'deleting' | 'expired';

/** A short message on the home screen after an action. */
export type HomeNotice =
  | 'blocked'
  | 'unblocked'
  | 'deleted'
  /** Several chats selected in the list: deleted here; deleted on both sides. */
  | 'deleted-many'
  | 'deleted-many-both'
  | 'replaced'
  | 'created'
  | 'revoked'
  | 'limit'
  | 'invitation'
  | 'joined'
  | 'invalid-invitation'
  | 'already-member'
  | 'own-invitation'
  | 'rate-limited'
  | DeviceLimit
  | 'new-signing-key'
  | 'network'
  | 'generic';

/** Notices that say an action went as asked, which telling of a new link signing key takes the place of. */
const ROUTINE_NOTICES: ReadonlySet<HomeNotice> = new Set<HomeNotice>(['blocked', 'unblocked', 'deleted', 'replaced', 'created', 'revoked', 'joined']);

/** The home notice to show when the user is still to be told their link has a new signing key: that, unless an error is to be shown. */
function withNewKey(notice: HomeNotice | null, newKey: boolean): HomeNotice | null {
  return newKey && (notice === null || ROUTINE_NOTICES.has(notice)) ? 'new-signing-key' : notice;
}

export type InvitationsNotice = 'created' | 'none-left' | DeviceLimit | 'network' | 'generic';

/** What the Data and storage screen shows: attachments on this device, in bytes. */
interface StorageUsage {
  media: number;
  /** Conversations holding attachments, largest first. */
  chats: { id: string; label: string; bytes: number }[];
  /** All the app's storage on this device (keys and history too), where the browser tells. */
  app: { usage: number; quota: number } | null;
}

export type AdminNotice = 'saved' | 'granted' | 'switched' | 'not-member' | 'not-found' | 'bad-link' | DeviceLimit | 'network' | 'generic';

/**
 * Why a message couldn't be sent. mailbox-limit: the account has as many
 * chats as it may (4,000), so no new one can be started or answered.
 * rate-limited: too many messages to this mailbox this minute.
 * device-limit, device-limit-later: the server refused this device's login
 * for now (deviceLimit), which a send that needed one (to fetch tokens or a
 * mailbox) passes on. turned-away: the firewall turned an upload away, too
 * many requests from this address for now (minutes; "Try again later").
 * media-paused: the operator has paused attachments for now (also said
 * when a tapped download is refused for it). outdated: the server no longer
 * holds the issuer key this build names (it was replaced), so the app must
 * be opened again. A LimitError says until when.
 */
export type SendError =
  | 'no-tokens'
  | 'no-mailboxes'
  | 'mailbox-limit'
  | 'rate-limited'
  | DeviceLimit
  | 'turned-away'
  | 'media-paused'
  | 'outdated'
  | 'network'
  | 'too-big'
  | 'unreadable'
  | 'generic'
  | LimitError;

/**
 * Refused by a limit that starts over at a set time: link-busy, the link's
 * first messages for this hour, which everyone writing to it shares (a
 * send); download-limit, a file's downloads for today (a tapped download).
 * until: when it starts over (Unix ms), as the server said (Retry-After),
 * or null if it didn't.
 */
export interface LimitError {
  kind: 'link-busy' | 'download-limit';
  until: number | null;
}

/** The LimitError of a refusal, until when the server said. */
function limitError(kind: LimitError['kind'], err: ApiError): LimitError {
  return { kind, until: err.retryAfter === undefined ? null : Date.now() + err.retryAfter * 1000 };
}

/**
 * Whether the server refused this device's login, signed request or any
 * logged-in request for now (429 device_limit): too many from this device
 * in a minute, a quarter of an hour or the day, whatever the request was.
 * A request that had to log in first passes the login's refusal on as its
 * own, so this is never the route's own limit (a day's tokens or
 * mailboxes, say). Which DeviceLimit goes by how long the server asked to
 * wait (Retry-After): a minute or less, or longer (or unsaid). Background
 * requests (the inbox) wait it out as any 429 (net/backoff), as long as
 * Retry-After says, up to their longest wait.
 */
function deviceLimit(err: unknown): DeviceLimit | null {
  if (!(err instanceof ApiError && err.code === 'device_limit')) return null;
  return err.retryAfter !== undefined && err.retryAfter <= 60 ? 'device-limit' : 'device-limit-later';
}

/** Whether an error is one a tapped download shows, which the next tap's outcome replaces. */
function downloadError(error: SendError | null): boolean {
  return error === 'media-paused' || (typeof error === 'object' && error?.kind === 'download-limit');
}

/** A conversation in the list. */
interface ConversationView {
  id: string;
  /** What it's shown as (shownLabel): the user's own name and picture where they gave one. */
  label: string;
  /** The label it came with, and the user's own name and picture for it (Rename, from the list's selection). */
  original: string;
  custom: ChatCustom | null;
  role: 'owner' | 'sender';
  unread: number;
  lastAt: number;
  status: 'active' | 'ended' | 'blocked';
  /** The latest message, if any (status: of one of ours, for its ticks). */
  last: { text: string; out: boolean; status?: MessageView['status']; media?: { t: string; n?: string; m?: string }; sticker?: Sticker } | null;
}

/** A message: its conversation (on this device) and its ID, which is unique only within that conversation. */
type MessageRef = Pick<MessageView, 'conv' | 'id'>;

/** A key for one message on this device, e.g. for its transfer's progress. */
export function messageKey(m: MessageRef): string {
  return `${m.conv}/${m.id}`;
}

/** What a picked file is sent as (music is "audio"). */
export type SendAs = 'photo' | 'video' | 'gif' | 'audio' | 'file';

/** An attachment being prepared to send, shown before its message is stored. */
interface Preparing {
  key: string;
  conv: string;
  as: SendAs | 'voice' | 'round';
  /** The picked photo, video or GIF (or the recorded video message), for showing it meanwhile. */
  url: string | null;
  /** A video message's last frame (a data URL), shown until its recording is finished off. */
  still?: string | null;
  name: string;
  size: number;
  caption: string;
}

/** An invitation code with its shareable URL. */
interface InvitationView extends InvitationCode {
  url: string;
}

/** What opening someone's link found ('existing': a conversation through it already, opened only on a tap). */
export type LinkStatus = 'checking' | 'verified' | 'own' | 'existing' | 'not-found' | 'mismatch' | 'network';

export type Screen =
  | { kind: 'loading' }
  | { kind: 'unconfigured' }
  | { kind: 'outside-telegram' }
  /** deleted: the account was deleted; deletedHere: only from this device (the server couldn't be reached). */
  | { kind: 'welcome'; mismatch: boolean; deleted?: boolean; deletedHere?: boolean }
  | { kind: 'reopening' }
  | { kind: 'registering' }
  | { kind: 'confirm-replace'; busy: boolean }
  /**
   * Deleting the account, after a typed confirmation. finishing: a deletion
   * the server says is under way (Finish deleting, while signed out): the
   * account takes no other request, so no send tokens can be fetched, and
   * its chats can't be deleted for both sides.
   */
  | { kind: 'confirm-delete'; busy: boolean; error: ErrorKind | null; finishing?: true }
  /**
   * Deleting the user's chats for both sides before the account, as they
   * asked on confirm-delete: done of total, or why it stopped (stopped) and
   * how many of them it didn't delete (left). Nothing of it is saved, so
   * leaving this screen, or closing the app, keeps the account; those
   * deleted for both sides stay deleted.
   */
  | { kind: 'deleting-chats'; done: number; total: number; stopped: { reason: ChatsStop; left: number; until?: number | null } | null }
  /**
   * Deleting chats the user selected in the list for both sides (and
   * blocking them, if asked), one at a time and paced as before deleting
   * the account: done of total, or why it stopped and how many are left
   * (Try again, or Stop: they stay with the other side). Nothing of it is
   * saved: leaving the screen, or closing the app, stops it.
   */
  | { kind: 'deleting-selected'; done: number; total: number; stopped: { reason: ChatsStop; left: number; until?: number | null } | null }
  /**
   * The account is being deleted, as the user confirmed: in steps, carried
   * on at every launch until done. error: the last try failed; Try again
   * carries on.
   */
  | { kind: 'deleting'; error: ErrorKind | null }
  /** This Telegram account is set up on another device (one device per account). */
  | { kind: 'elsewhere' }
  | {
      kind: 'home';
      tab: HomeTab;
      conversations: ConversationView[];
      offline: boolean;
      /** Offline because the server refused home's own requests for now (deviceLimit): said in place of "offline". */
      limited: DeviceLimit | null;
      account: AccountInfo | null;
      invitations: InvitationsInfo | null;
      links: LinkView[];
      busy: boolean;
      notice: HomeNotice | null;
      /** Offer to turn on Telegram notices (the bot may not write yet). */
      askNotices: boolean;
      /** How many conversations are blocked (the Blocked list). */
      blockedCount: number;
      /** The server no longer takes this device: chats are read-only. */
      signedOut: SignedOutReason | null;
      /** The user's deletion couldn't finish, and they read their chats meanwhile: read-only; Try again carries on with it. */
      deletionPaused: boolean;
      /** Bytes of attachments stored on this device, for the Settings tab (null on the other tabs). */
      media: number | null;
    }
  /** Choosing the app's language (the choice itself lives in state/language.ts). */
  | { kind: 'language' }
  | { kind: 'blocked'; conversations: ConversationView[]; busy: boolean; notice: HomeNotice | null }
  /** Data and storage: what stays on this device and what's fetched by itself. */
  | { kind: 'storage'; settings: MediaSettings; usage: StorageUsage | null; busy: boolean; cleared: number | null }
  /** Today's usage of the limits a person can run into; null while loading. */
  | { kind: 'usage'; usage: UsageView | null; error: ErrorKind | null }
  | {
      kind: 'invitations';
      info: Omit<InvitationsInfo, 'codes'> & { codes: InvitationView[] };
      busy: boolean;
      notice: InvitationsNotice | null;
      /** The code just created, to highlight. */
      created: string | null;
    }
  /** switches: the emergency switches for attachments; null if they couldn't be read. */
  | { kind: 'admin'; levels: LevelAllowance[]; switches: Switches | null; busy: boolean; notice: AdminNotice | null }
  | { kind: 'link'; status: Exclude<LinkStatus, 'existing'>; canWrite: boolean; busy: boolean; error: SendError | null }
  /** chat: the conversation already written through this link. */
  | { kind: 'link'; status: 'existing'; canWrite: false; busy: boolean; error: null; chat: string }
  /** An invitation link: joins only on a tap. error: Join failed, and can be tried again. */
  | { kind: 'invitation'; code: string; busy: boolean; error: 'network' | DeviceLimit | 'generic' | null }
  | {
      kind: 'conversation';
      id: string;
      /** What it's shown as: the user's own name and picture where they gave one (shownLabel). */
      label: string;
      /** The label it came with ("🦊 K3F9"), under any name the user gave it. */
      original: string;
      /** The user's own name and picture for it, if any: on this device only. */
      custom: ChatCustom | null;
      /** Deleted here, out of the list until either side writes (opened again from their link): no Rename then. */
      hidden: boolean;
      role: 'owner' | 'sender';
      ended: boolean;
      /** Blocked: shown read-only, with Unblock. */
      blocked: boolean;
      /** The server no longer takes this device: shown read-only. */
      readOnly: boolean;
      /**
       * The messages shown: the newest PAGE when it opens, and from the
       * oldest shown on as more come; older ones load on scrolling up
       * (loadOlder), so a flooded chat opens as fast as any.
       */
      messages: MessageView[];
      /** There are older messages than those shown. */
      more: boolean;
      /** Messages those shown answer that aren't among them (older), for their quotes. */
      quoted: MessageView[];
      busy: boolean;
      error: SendError | null;
    }
  /**
   * The server no longer takes this device. Its chats stay, readable; the
   * app asks again (Try again, and at every launch). offline: it couldn't
   * be asked just now.
   */
  /** offline: the server couldn't be asked; limited, if set: it was, and refused this device's login for now. */
  | { kind: 'signed-out'; reason: SignedOutReason; busy: boolean; offline: boolean; limited?: DeviceLimit }
  /** Setting up again from there, which deletes everything on this device: a typed confirmation first. */
  | { kind: 'confirm-reset'; reason: SignedOutReason }
  | { kind: 'error'; error: ErrorKind };

type AdminScreen = Extract<Screen, { kind: 'admin' }>;

/** The home screen's tabs, switched by the bar at its bottom. */
export type HomeTab = 'chats' | 'links' | 'settings';

/**
 * Where Telegram's own Settings item (in its menu) is offered: the screens of
 * a set-up app, not setup, sign-out, deletion or errors; nor while one is
 * busy (an action under way, a link being written to, an invitation being
 * redeemed) or a link is being checked, any of which would draw over
 * Settings once done. It opens the Settings tab.
 */
export function offersSettings(s: Screen): boolean {
  // Busy, a screen draws itself (or home's tab) again once done, over
  // Settings; except Data and storage's first reading, which looks first.
  if ('busy' in s && s.busy && !(s.kind === 'storage' && s.usage === null)) return false;
  if (s.kind === 'link') return s.status !== 'checking';
  if (s.kind === 'invitation') return !s.busy;
  return SETTINGS_BUTTON_SCREENS.has(s.kind);
}

/** The other screens it's offered on (links and invitations: offersSettings). */
const SETTINGS_BUTTON_SCREENS: ReadonlySet<Screen['kind']> = new Set([
  'home',
  'conversation',
  'blocked',
  'storage',
  'usage',
  'invitations',
  'admin',
  'language',
]);

export interface Deps {
  config: Config | null;
  api: Api | null;
  db: Database;
  launch: Launch;
  bridge: Bridge | null;
  /** Tells the other copies of the app on this device. */
  broadcast(event: SyncEvent): void;
  /** Waits before closing the old copy after asking Telegram to reopen. */
  closeDelayMs?: number;
  /** The token issuers to use instead of the build's (tests). */
  issuer?: TokenIssuer;
  mediaIssuer?: TokenIssuer;
  /** Run the inbox poll and upkeep in the background (off in tests). */
  background?: boolean;
  /** The pause between steps of a deletion or cleanup, instead of a second (tests). */
  stepPauseMs?: number;
  /** The pause between the deletes for both sides before deleting the account, instead of CHAT_DELETE_GAP_MS (tests). */
  chatDeleteGapMs?: number;
  /** How many of those in how long (ms), instead of CHAT_DELETES_PER_WINDOW in CHAT_DELETE_WINDOW_MS (tests). */
  chatDeleteWindow?: { count: number; ms: number };
}

/** How often an open app checks its inbox while it has no push socket. */
const POLL_MS = 20_000;
/** While a push socket is open, poll only every this many POLL_MS. */
const SOCKET_POLL_EVERY = 6;
/** How long after one of ours would be stuck (STUCK_MS) an open chat looks again (watchStuck): times are reckoned in whole seconds. */
const STUCK_SLACK_MS = 1_000;
/**
 * The longest the app's background syncs wait while the server is in
 * trouble (net/backoff): the first wait is up to POLL_MS, and each failure
 * in a row doubles it, up to this.
 */
const SYNC_BACKOFF_MAX_MS = 5 * 60_000;
/**
 * How many pages of the inbox a sync the app asks for by itself reads (a
 * push, the poll): one, of up to 50 messages, and its confirmation, so a
 * flood of messages costs the device at most 2 requests a sync
 * (sync/pace.ts). One that stops with more waiting asks for another, at the
 * device's pace; what the user does reads as many as a sync does.
 */
const BACKGROUND_PAGES = 1;

/** A link of this account, with its shareable URL. */
export interface LinkView extends LinkRecord {
  url: string;
}

/** How long the old copy waits before closing, so Telegram handles the link first (found by testing). */
const CLOSE_DELAY_MS = 400;
/**
 * After the server says downloads are paused, attachments aren't fetched by
 * themselves for this long; then on the next opening or new message. A tap
 * still asks. After an automatic fetch that failed any other way (out of
 * reach, turned away, failing, or the file couldn't be stored), half of
 * this to all of it.
 */
const PAUSED_WAIT_MS = 2 * 60_000;
/**
 * How many times one attachment is fetched by itself, in a run of the app,
 * when that keeps failing (a poor connection, say, or a full device); then
 * it waits for a tap. Paused downloads don't count.
 */
const AUTO_TRIES = 3;
/** The most messages an open chat keeps shown as more come in, unless more were loaded (chatPage). */
export const MAX_SHOWN = 4 * PAGE;

export function createApp(deps: Deps) {
  const screen = signal<Screen>({ kind: 'loading' });
  /** Messages that can still be sent today (send tokens), or null while unknown: for the low-balance notice. */
  const messagesLeft = signal<number | null>(null);
  // The screen now, read fresh (TypeScript would otherwise keep a type
  // narrowed by an earlier assignment, across awaits).
  const currentScreen = (): Screen => screen.value;
  // The server's clock, learnt when it says this device's is off: logins,
  // signed requests and registration are timed by it. Messages are dated by
  // it as each login's token tells it (messageNow).
  const clock = createClock();
  const session: AppSession | null = deps.api ? createSession(deps.db, deps.api, clock) : null;
  // Set while the server doesn't take this device (unverified, asked again).
  let signedOut: SignedOutReason | null = null;
  /** While signed out: the chats are only read (no downloads either). */
  const readOnly = signal(false);
  // What this launch was opened with (a link or an invitation) is handled
  // once, not on every restart.
  let launchParam: string | null = isRegistrationLaunch(deps.launch.startParam) ? null : deps.launch.startParam || null;
  // The back button (Telegram's, or the phone's): closes what's open on top
  // first, a viewer, menu, dialog or panel, as in Telegram; then goes home.
  let screenBack = false;
  const onTop: (() => void)[] = [];
  const showBack = () => deps.bridge?.post('web_app_setup_back_button', { is_visible: screenBack || onTop.length > 0 });
  deps.bridge?.on('back_button_pressed', () => {
    const close = onTop.at(-1);
    if (close) close();
    // Leaves deleting the chats for both sides at once: the account is kept.
    else if (currentScreen().kind === 'deleting-chats') void keepAccount();
    // At once, not once home has loaded (that waits for the server): no more deletes go out after Back.
    else if (currentScreen().kind === 'deleting-selected') void stopDeletingSelected();
    else void showHome();
  });
  // Telegram's Settings item: shown on the screens that have somewhere to
  // take it (told only when that changes); a press closes whatever is open on
  // top, then opens the Settings tab.
  let settingsButton: boolean | null = null;
  effect(() => {
    const visible = offersSettings(screen.value);
    if (visible === settingsButton) return;
    settingsButton = visible;
    deps.bridge?.post('web_app_setup_settings_button', { is_visible: visible });
  });
  deps.bridge?.on('settings_button_pressed', () => {
    const pressedOn = currentScreen();
    if (!offersSettings(pressedOn)) return;
    // Closing takes each one off as it redraws, later: all of them, as they are now.
    for (const close of [...onTop].reverse()) close();
    // Drawn only while the screen it was pressed on is still there: not over a chat opened meanwhile, say.
    void showHome({ tab: 'settings', over: placeOf(pressedOn) });
  });
  let messaging: Messaging | null = null;
  let mediaSettings: MediaSettings = DEFAULT_MEDIA_SETTINGS;
  let tab: HomeTab = 'chats';
  let backgroundStarted = false;
  // Stops the inbox poll and the push socket (the account was deleted).
  let stopBackground = (): void => {};
  /** Holds back the syncs the app asks for by itself (backgroundSync) while the server is in trouble. */
  const syncBackoff = createBackoff({ baseMs: POLL_MS, maxMs: SYNC_BACKOFF_MAX_MS });
  /** The one sync waiting for the backoff or the device's pace to allow it, for all asked for meanwhile. */
  let backoffTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * What the syncs the app asks for by itself, not run yet, are for: what
   * came after this (Unix ms, the latest asked); null if none waits.
   */
  let wantedSince: number | null = null;
  /** The device's syncs as this copy knows them (sync/pace.ts), and whether this copy is running its paced one. */
  const syncPace = createPace();
  let pacing = false;
  /** Stops messaging and everything started for it: the poll, the socket, a sync waiting out a server's pause. */
  function stopMessaging(): void {
    stopWatchingStuck();
    stopBackground();
    clearTimeout(backoffTimer);
    backoffTimer = undefined;
    wantedSince = null;
    messaging?.stop();
    messaging = null;
  }
  // The link last checked and found genuine, to write to.
  let openedLink: { ref: LinkRef; bundle: Bundle } | null = null;
  // "Seen" goes out only while the user is using the app: from a tap that
  // opens a chat until the app is hidden or minimised, then again once they
  // touch it. Opening a link, or bringing the app back, can be someone
  // else's doing, and must not tell them who has which chat open.
  let attending = false;
  // How many times the app was hidden, so a tap that first waits (on the
  // network, or storage) can tell whether it still counts.
  let hides = 0;
  // Where the running build's source code is (openSource): looked up once
  // the home screen shows, so a tap can open it at once, while the touch
  // still lets the page open a link. Looked up again after a failure.
  let sourceLookup: Promise<string | null> | null = null;
  let sourceOpening = false;
  const lookUpSource = (): Promise<string | null> =>
    (sourceLookup ??= findSourceUrl(location.origin + location.pathname).then((url) => {
      if (!url) sourceLookup = null;
      return url;
    }));
  const hidden = () => {
    attending = false;
    hides++;
  };
  deps.bridge?.on('visibility_changed', ({ is_visible }) => {
    if (!is_visible) hidden();
  });
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') hidden();
    });
  }

  // Telegram notices (docs/protocol.md, Notices) are set up with this launch's
  // signed data, and only from a plain or registration launch: never one that
  // names a link or an invitation, which would tell the server whose link this
  // is. By themselves only while Telegram never refused one: once it did (the
  // user blocked the bot, say), the launch data may still say the bot may
  // write, so the app only offers to (askNotices), and sets them up on a tap.
  const signedStart = new URLSearchParams(deps.launch.initData).get('start_param') ?? '';
  const noticeLaunch = deps.launch.initData !== '' && (signedStart === '' || isRegistrationLaunch(signedStart));
  let writeAllowed = deps.launch.allowsWriteToPm;
  let noticesTried = false;
  let noticeLanguageTried = false;
  deps.bridge?.on('write_access_requested', ({ status }) => {
    if (status !== 'allowed') return;
    writeAllowed = true;
    void setUpNotices();
  });

  /** Whether the screen itself has somewhere to go back to (anything open on top shows the button too). */
  const backButton = (visible: boolean) => {
    screenBack = visible;
    showBack();
  };
  // What "try again" does from the error screen.
  let retry: () => Promise<void> = () => start();

  const fail = (error: ErrorKind, again: () => Promise<void>) => {
    retry = again;
    screen.value = { kind: 'error', error };
  };

  async function start(): Promise<void> {
    const { config, api, db, launch, bridge } = deps;
    if (!config || !api) {
      screen.value = { kind: 'unconfigured' };
      return;
    }
    const account = await readAccount(db);
    // A replaced or refused one too: the server is asked again each time.
    if (isSetUp(account)) return enter();
    if (!bridge) {
      screen.value = { kind: 'outside-telegram' };
      return;
    }
    if (isRegistrationLaunch(launch.startParam)) {
      if (account?.state === 'pending' && launch.startParam === REGISTRATION_PREFIX + account.fingerprint) {
        return runRegister(false);
      }
      screen.value = { kind: 'welcome', mismatch: true };
      return;
    }
    if (launch.startParam) {
      await rememberLink(db, launch.startParam);
    } else if (!account && (await accountElsewhere())) {
      // Say so rather than offer setup, which would replace that account.
      screen.value = { kind: 'elsewhere' };
      return;
    }
    screen.value = { kind: 'welcome', mismatch: false };
  }

  /**
   * Whether this Telegram account is set up on another device. Asked only on
   * a plain launch: launch data that names a link would tell the server whose
   * link this is. If the answer can't be had, setup shows as usual.
   */
  async function accountElsewhere(): Promise<boolean> {
    if (!noticeLaunch || deps.launch.startParam !== '') return false;
    try {
      const out = await deps.api!.post('/accounts/lookup', { initData: deps.launch.initData }, checkObject);
      return out.exists === true;
    } catch {
      return false;
    }
  }

  /**
   * "Start over on this device", from the other-device screen: on a
   * registration launch, straight to the typed confirmation; otherwise set up
   * first, and the confirmation comes when the server says the account exists.
   */
  async function startOver(): Promise<void> {
    const account = await readAccount(deps.db);
    if (account?.state === 'pending' && deps.launch.startParam === REGISTRATION_PREFIX + account.fingerprint) {
      screen.value = { kind: 'confirm-replace', busy: false };
      return;
    }
    await putMeta(deps.db, META_START_OVER, true);
    return setUp();
  }

  /**
   * A registered device: log in, then show the link it was opened with, or
   * home. If the server no longer takes the device, its chats stay, readable,
   * and nothing is deleted: the server's word alone is never enough for that.
   */
  async function enter(): Promise<void> {
    const recorded = await readAccount(deps.db);
    // A deletion the user confirmed here, for this account, not finished
    // when the app closed.
    const deleting = await deletionConfirmed();
    let offline = false;
    // The login was refused for now: said on home, as well as offline.
    let notice: HomeNotice | null = null;
    try {
      session!.use(await logIn(deps.db, deps.api!, clock));
      signedOut = null;
      // Reading the chats while a deletion couldn't finish ends here too:
      // the deletion, if still confirmed, carries on below.
      deletionPaused = false;
      readOnly.value = false;
    } catch (err) {
      // It finished, and its answer was lost: the device no longer exists.
      // Only for a deletion the user confirmed: a refusal alone deletes
      // nothing.
      // Replaced, likewise: set up again elsewhere, which replaces an
      // account being deleted without asking.
      if (deleting && isSetUp(recorded) && err instanceof ApiError && (err.code === 'login_refused' || err.code === 'account_replaced')) {
        return finishDeletion(recorded.accountId);
      }
      // Replaced once, still replaced: the server forgets a replacement
      // (its marker expires) and then only refuses the device, but the
      // warning stays.
      if (recorded?.state === 'replaced' && err instanceof ApiError && err.code === 'login_refused') return showSignedOut('replaced');
      // Being deleted for going unused, then gone: deleted, as the server
      // said, not "something may be wrong".
      if (recorded?.state === 'refused' && recorded.expired && err instanceof ApiError && err.code === 'login_refused') {
        return showSignedOut('expired');
      }
      if (handleGone(err)) return;
      // Couldn't ask, with a deletion the user confirmed here: its own
      // screen (Try again, the chats, deleting here only), whatever the
      // server said before.
      if (deleting) return showDeletionError(err instanceof NetworkError ? 'network' : (deviceLimit(err) ?? 'generic'));
      // Couldn't ask: as the server last said, until it can be asked again.
      const last =
        signedOut ??
        (recorded?.state === 'replaced'
          ? 'replaced'
          : recorded?.state === 'refused'
            ? recorded.expired
              ? 'expired'
              : recorded.deleting
                ? 'deleting'
                : 'refused'
            : null);
      if (last) return showSignedOut(last, true, deviceLimit(err));
      // Offline or the server is down: the device still works on what it has.
      offline = true;
      notice = deviceLimit(err);
    }
    // Carried on before anything else is asked: the server takes no other
    // request from an account being deleted.
    if (deleting) return runDeletion();
    await startMessaging(!offline);
    // The first sync found the server no longer takes this device (its
    // account being deleted, say): that screen stays.
    if (signedOut) return;
    return continueLaunch(offline, notice);
  }

  /**
   * Whether the user confirmed deleting this device's account (the typed
   * confirmation), and it isn't done yet. A record for another account (left
   * by another copy of the app, say, before a new setup here) is dropped.
   */
  async function deletionConfirmed(): Promise<boolean> {
    const record = await getMeta<unknown>(deps.db, META_DELETING);
    if (record === undefined) return false;
    const account = await readAccount(deps.db);
    const id = record && typeof record === 'object' ? (record as { accountId?: unknown }).accountId : undefined;
    if (isSetUp(account) && id === account.accountId) return true;
    await deleteMeta(deps.db, META_DELETING);
    return false;
  }

  /**
   * The server no longer takes this device: say so, and keep its chats
   * readable. offline: it couldn't be asked now; limited: it refused the
   * login for now.
   */
  function showSignedOut(reason: SignedOutReason, offline = false, limited: DeviceLimit | null = null): void {
    signedOut = reason;
    readOnly.value = true;
    stopMessaging();
    backButton(false);
    screen.value = { kind: 'signed-out', reason, busy: false, offline, ...(limited ? { limited } : {}) };
  }

  /**
   * The device's clock is more than two days off: the server's isn't
   * believed that far (a hostile one could collect requests dated ahead), so
   * nothing is signed until the user sets the clock.
   */
  function showClockOff(again: () => Promise<void>): void {
    stopMessaging();
    backButton(false);
    fail('clock', again);
  }

  /** Asks the server again whether it takes this device (Try again). */
  async function recheck(): Promise<void> {
    const current = screen.value;
    if (!signedOut || (current.kind === 'signed-out' && current.busy)) return;
    screen.value = { kind: 'signed-out', reason: signedOut, busy: true, offline: false };
    return enter();
  }

  /**
   * Creates the messaging engine, if there isn't one, without starting
   * anything: no sync, no poll. Reports false if it couldn't (no usable
   * issuer key).
   */
  async function createEngine(): Promise<boolean> {
    if (messaging || !deps.config || !deps.api) return true;
    try {
      const issuer = deps.issuer ?? { key: await importIssuerKey(deps.config.issuer.spki), keyId: deps.config.issuer.keyId };
      const media = deps.config.issuer.media;
      const mediaIssuer = deps.mediaIssuer ?? (media ? { key: await importIssuerKey(media.spki), keyId: media.keyId } : undefined);
      messaging = createMessaging({
        db: deps.db,
        api: deps.api,
        session: session!,
        issuer,
        ...(mediaIssuer ? { mediaIssuer } : {}),
        messageNow: () => clock.messageNow(),
        onTokens: () => void refreshBudget(),
        onWaiting: () => backgroundSync(),
        // Only while the app syncs in the background (not signed out).
        onResume: () => {
          if (backgroundStarted) backgroundSync();
        },
        // Other copies drop their unsealed copies of the deleted keys too (keysChanged).
        onKeysDeleted: () => deps.broadcast({ type: 'keys-changed' }),
        // A link the server made though its answer was lost: shown here and in other copies.
        onLinks: () => {
          deps.broadcast({ type: 'data-changed' });
          void refresh();
        },
        // A link with a new signing key: the user is told on the home
        // screen, here or in another copy, now or the next time it shows
        // (refresh and showHome read the note).
        onNewLink: () => {
          deps.broadcast({ type: 'data-changed' });
          void refresh();
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Creates the messaging engine and, outside tests, the inbox poll and upkeep. */
  async function startMessaging(online: boolean): Promise<void> {
    // "Keep media" applies at every start, whether or not this build can send.
    mediaSettings = await getMediaSettings(deps.db);
    await tidyMedia();
    // Ours left sending by a copy that closed mid-send show as not sent, to
    // send again; one another copy is sending stays as it is.
    if ((await failStuck(deps.db)).length > 0) deps.broadcast({ type: 'data-changed' });
    // Without a usable issuer key the app still works, but can't send.
    if (!(await createEngine())) return;
    if (online) {
      await syncNow();
      // The server no longer takes this device (its account being deleted,
      // say): nothing more starts, no poll, socket or logins.
      if (signedOut) return;
      // Uploads left to delete from before (the app closed halfway).
      void messaging?.flushUploadDeletes();
    }
    if (deps.background === false || backgroundStarted || typeof document === 'undefined') return;
    backgroundStarted = true;
    // Shown: the page is visible and Telegram hasn't minimised the app.
    let telegramVisible = true;
    const shown = () => document.visibilityState === 'visible' && telegramVisible;
    // Pushes, while shown (hidden, the server sends a Telegram notice instead).
    const socket =
      deps.config?.wsUrl && session
        ? createPushSocket({
            url: deps.config.wsUrl,
            token: () => session.token(),
            onHint: () => backgroundSync(),
            // The server is reachable again: no more waiting.
            onOpen: () => {
              endWait();
              void syncNow();
            },
          })
        : null;
    // Being shown is the user's doing: it syncs, backoff or not.
    const visibility = () => {
      socket?.setVisible(shown());
      if (shown()) void syncNow();
    };
    socket?.setVisible(shown());
    socket?.start();
    // With a socket open, polling is only a safety net. A poll is answered
    // by a sync in the last half of its interval, in any copy.
    let ticks = 0;
    const poll = setInterval(() => {
      ticks++;
      if (shown() && (!socket?.connected || ticks % SOCKET_POLL_EVERY === 0)) backgroundSync(Date.now() - POLL_MS / 2);
    }, POLL_MS);
    document.addEventListener('visibilitychange', visibility);
    // Back online: whatever the backoff, sync now.
    const backOnline = () => {
      endWait();
      if (shown()) void syncNow();
    };
    const win = typeof window === 'undefined' ? null : window;
    win?.addEventListener('online', backOnline);
    const offVisible = deps.bridge?.on('visibility_changed', ({ is_visible }) => {
      telegramVisible = is_visible;
      visibility();
    });
    // Upkeep at a random moment soon after opening, unrelated to anything
    // the user does, so the first send rarely has to fetch tokens itself.
    const upkeep = setTimeout(() => void messaging?.maintain().catch(() => {}), 2_000 + Math.random() * 8_000);
    // Everything started here stops here, so starting again (after a
    // sign-out that Try again undid) runs one of each, not two.
    stopBackground = () => {
      clearInterval(poll);
      clearTimeout(upkeep);
      socket?.stop();
      document.removeEventListener('visibilitychange', visibility);
      win?.removeEventListener('online', backOnline);
      offVisible?.();
      backgroundStarted = false;
      stopBackground = () => {};
    };
  }

  /**
   * The sync under way, and whether another was asked for meanwhile (and
   * how many pages it may read): one runs and one waits, no more.
   */
  let syncing: Promise<void> | null = null;
  let syncAgain = false;
  let againPages = 0;

  /**
   * A sync the user's doing asks for (opening the app, showing it, coming
   * back online, the push socket opening): at once, whatever the device's
   * pace, and it answers the syncs asked for before it, in every copy
   * (sync/pace.ts).
   */
  function syncNow(): Promise<void> {
    const at = Date.now();
    syncPace.started(at, false);
    deps.broadcast({ type: 'sync-started', at, paced: false });
    return sync(Infinity);
  }

  /** Fetches new messages, up to `pages` pages (Infinity: as many as a sync reads); refreshes the screen if any arrived. */
  function sync(pages: number): Promise<void> {
    if (syncing) {
      syncAgain = true;
      againPages = Math.max(againPages, pages);
      return syncing;
    }
    syncing = (async () => {
      try {
        let next = pages;
        do {
          syncAgain = false;
          againPages = 0;
          await syncOnce(next);
          next = againPages;
          // Not again at once after a failure: when the wait is over.
        } while (syncAgain && syncBackoff.remaining() === 0);
        if (syncAgain) {
          syncAgain = false;
          backgroundSync();
        }
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  }

  /**
   * A sync the app asks for by itself (a push, the poll, a chat free again,
   * the end of a pause), for what came after `since`: paced on the whole
   * device (sync/pace.ts), so that pushes, however many messages come and
   * however many copies are open, make at most one every SYNC_GAP_MS (a
   * flood, one every SYNC_REFILL_MS once it has lasted), and one another
   * copy ran since answers it; and while the server is in trouble
   * (syncBackoff), it waits. All asked for meanwhile become one.
   */
  function backgroundSync(since = Date.now()): void {
    wantedSince = Math.max(wantedSince ?? since, since);
    armPace(syncBackoff.remaining());
  }

  function armPace(wait: number): void {
    clearTimeout(backoffTimer);
    backoffTimer = setTimeout(() => {
      backoffTimer = undefined;
      void runPaced();
    }, wait);
  }

  /**
   * Runs the sync asked for by itself once the device's pace allows it, or
   * drops it if a sync started since (in any copy). It decides and syncs
   * holding a lock across copies, and tells the other copies when its sync
   * started; so a copy that decides next knows of it, and waits out the
   * rest of the gap (without the lock).
   */
  async function runPaced(): Promise<void> {
    if (pacing || wantedSince === null) return;
    pacing = true;
    let after: { wait: number } | { partway: boolean } = { wait: -1 };
    try {
      after = await withLock('sync-pace', async () => {
        for (;;) {
          const since = wantedSince;
          if (since === null) return { wait: -1 };
          // A sync started after it was asked for, here or in another
          // copy: it took in what was asked for then (and the other copy
          // tells this one of it).
          if (syncPace.last(Date.now()) > since) {
            if (wantedSince === since) wantedSince = null;
            continue;
          }
          // The server in trouble, or the device's pace: waited out
          // without the lock.
          const wait = Math.max(syncBackoff.remaining(), syncPace.wait(Date.now()));
          if (wait > 0) return { wait };
          break;
        }
        const at = Date.now();
        syncPace.started(at, true);
        deps.broadcast({ type: 'sync-started', at, paced: true });
        // Starting now: it answers everything asked so far.
        wantedSince = null;
        await sync(BACKGROUND_PAGES);
        return { partway: messaging?.partway() ?? false };
      });
    } finally {
      pacing = false;
    }
    // More waits than it read: another, at the pace. Or asked meanwhile.
    if ('partway' in after && after.partway) backgroundSync();
    else if (wantedSince !== null) armPace('wait' in after && after.wait > 0 ? after.wait : 0);
  }

  /** Ends the wait for a server in trouble: a sync asked for meanwhile goes at the device's pace. */
  function endWait(): void {
    syncBackoff.succeeded();
    if (wantedSince !== null) armPace(0);
  }

  async function syncOnce(pages: number): Promise<void> {
    if (!messaging) return;
    let received = 0;
    try {
      received = await messaging.sync({ pages });
      // Through: what was waiting goes now (at the device's pace).
      endWait();
    } catch (err) {
      // What it stored before failing is still shown.
      if (err instanceof SyncFailed) received = err.received;
      const cause = err instanceof SyncFailed ? err.error : err;
      if (handleGone(cause)) return;
      // The server in trouble: background syncs wait, longer each time. Not
      // while the device says it's offline: that costs the server nothing,
      // and coming online syncs at once.
      if (!(cause instanceof NetworkError && offline())) syncBackoff.failed(cause);
    }
    if (received > 0) {
      deps.broadcast({ type: 'data-changed' });
      await refresh();
    }
  }

  // Draws of the home screen's lists from storage (refresh, showHome),
  // counted: a refresh draws only if no newer one started since, so one
  // that read storage before another can't draw over it (an older list,
  // previews or unread counts, until something drew it again).
  let homeDraws = 0;
  // Actions started on home (busy), each drawing home itself once done; and
  // the draws of home (showHome). A home draw is dropped once a newer one of
  // either began: the newer one shows.
  let homeActions = 0;
  let homeAsks = 0;

  /**
   * Redraws the current screen from storage (after new messages, or another
   * copy's change), as it is once read: a notice shown meanwhile stays.
   */
  async function refresh(): Promise<void> {
    const current = screen.value;
    if (current.kind === 'home' && !current.busy) {
      const draw = ++homeDraws;
      const [list, links, newKey] = [await conversations(), await linkViews(), await newKeyToTell(deps.db)];
      const blockedCount = (await listConversations(deps.db)).filter((c) => c.status === 'blocked').length;
      const latest = screen.value;
      // A newer one draws (or drew) what's newer.
      if (draw !== homeDraws || latest.kind !== 'home' || latest.busy) return;
      const notice = withNewKey(latest.notice, newKey);
      screen.value = { ...latest, conversations: list, links, notice, blockedCount };
      if (latest.tab === 'settings') void measureMedia();
      if (newKey && notice === 'new-signing-key') await toldNewKey(deps.db);
    } else if (current.kind === 'conversation' && !current.busy) {
      // Not marked seen here: only once they're in view (markSeen, from the screen).
      await showChat(current.id);
      autoFetch(current.id);
    }
  }

  /**
   * The chat list: blocked and deleted conversations are gone from it. With
   * blocked, the Blocked list. Each chat's newest message comes from its
   * preview (one small item), not from its messages.
   */
  async function conversations(blocked = false): Promise<ConversationView[]> {
    const list = (await listConversations(deps.db)).filter((c) => (blocked ? c.status === 'blocked' : c.status !== 'blocked' && !c.hidden));
    return Promise.all(
      list.map(async (c) => ({
        id: c.id,
        ...(await chatName(c)),
        original: c.label,
        role: c.role,
        unread: c.unread,
        lastAt: c.lastAt,
        status: c.status,
        last: await lastShown(deps.db, c),
      })),
    );
  }

  /**
   * The messages an open chat shows (Screen, conversation): when it opens
   * (shown null), the newest PAGE; as it's redrawn, all from the oldest
   * shown on, or from the first if all were shown (so one that comes dated
   * before those, out of order from the inbox, say, shows too), but no more
   * than MAX_SHOWN or as many as were shown (a flood coming in while it's
   * open pushes the oldest out); with older, PAGE more than shown, or, given a
   * message's ID, all from that one on. Ours still going out, or failed (to
   * send again), from before those, show first however old: the rest is
   * reckoned without them. With the older messages those answer, for their
   * quotes.
   */
  async function chatPage(
    conv: string,
    shown: { messages: MessageView[]; more: boolean } | null,
    older?: true | string,
  ): Promise<{ messages: MessageView[]; more: boolean; quoted: MessageView[] } & Partial<{ label: string; original: string; custom: ChatCustom | null; hidden: boolean; blocked: boolean }>> {
    const base = shown?.messages.filter((m) => !(m.out && (m.status === 'sending' || m.status === 'failed'))) ?? null;
    let since = base?.[0]?.at;
    if (typeof older === 'string') {
      const target = await deps.db.get('messages', [conv, older]);
      if (target) since = Math.min(target.at, since ?? Infinity);
    }
    let page: { messages: MessageView[]; more: boolean };
    if (since === undefined || older === true) {
      page = await pageMessages(deps.db, conv, { count: (base?.length ?? 0) + PAGE });
    } else if (older === undefined && shown?.more === false) {
      // All of it shown: the newest of all of it, not only from the oldest shown on.
      page = await pageMessages(deps.db, conv, { count: Math.max(base!.length, MAX_SHOWN) });
    } else {
      // A flood coming in while it's open: only the newest are read.
      page = await pageMessages(deps.db, conv, { since, ...(older === undefined ? { most: Math.max(base!.length, MAX_SHOWN) } : {}) });
    }
    const first = page.messages[0];
    if (first) page = { ...page, messages: [...(await unsentBefore(deps.db, conv, first.at, new Set(page.messages.map((m) => m.id)))), ...page.messages] };
    // Ours still sending after STUCK_MS that no copy of the app is sending
    // (one that sent them closed halfway) show as not sent, to send again.
    const stuckBefore = clock.messageNow() - STUCK_MS;
    if (page.messages.some((m) => m.out && m.status === 'sending' && m.at < stuckBefore) && (await failStuck(deps.db, { conv, before: stuckBefore })).length > 0) {
      deps.broadcast({ type: 'data-changed' });
      return chatPage(conv, shown, older);
    }
    watchStuck(conv, page.messages);
    const here = new Set(page.messages.map((m) => m.id));
    const quoted: MessageView[] = [];
    for (const id of new Set(page.messages.flatMap((m) => (m.replyTo && !here.has(m.replyTo) ? [m.replyTo] : [])))) {
      const m = await getMessage(deps.db, conv, id);
      if (m) quoted.push(m);
    }
    // Its name, and whether it's out of the list or blocked, read again with
    // it: changed meanwhile (here or in another copy of the app), it shows.
    const c = await getConversation(deps.db, conv);
    return { ...page, quoted, ...(c ? { ...(await chatName(c)), original: c.label, hidden: !!c.hidden, blocked: c.status === 'blocked' } : {}) };
  }

  /** What a chat is shown as, and the user's own name and picture for it (sealed: opened here). */
  async function chatName(c: ConversationRecord): Promise<{ label: string; custom: ChatCustom | null }> {
    const custom = c.custom ? await openChatName(deps.db, c.id, c.custom) : null;
    return { label: shownLabel(c.label, custom ?? undefined), custom };
  }

  type ChatScreen = Extract<Screen, { kind: 'conversation' }>;
  type ChatPage = Awaited<ReturnType<typeof chatPage>>;
  /**
   * What a redraw does to the error the chat shows, decided by the error
   * shown when it draws (in its turn), not when it was asked for: shows this
   * one (error), takes away a notice about downloads (clearDownloadError: a
   * tap that fetched), or leaves it.
   */
  type ChatChanges = { error?: SendError | null; clearDownloadError?: true };
  type ErrorChange = (shown: SendError | null) => SendError | null;
  const errorChange = (changes: ChatChanges): ErrorChange => (shown) => (changes.error !== undefined ? changes.error : changes.clearDownloadError && downloadError(shown) ? null : shown);
  const keepError: ErrorChange = (shown) => shown;

  // The open chat's messages are drawn one draw at a time, in the order
  // asked for (inTurn): opening it, redrawing it (showChat) and loading
  // older ones (loadOlder). Each builds its page from the screen as the
  // draw before left it, and from storage read after that one drew. Side by
  // side, one could draw a page built from a screen another had since
  // replaced, and older messages loaded on purpose would go.
  // A draw waits for storage only: nothing it waits for may wait for a draw.
  // So chatPage, and anything else a draw waits for, must never wait for a
  // lock (send:…, sending:…, seen:…): a send redraws its chat (onStored)
  // while it holds its sendingLock (engine.ts), so a draw waiting for that
  // lock would wait for itself, and the send and every draw after it would
  // hang. failStuck takes a sendingLock only if it's free (withLockIfFree).
  let chatDraws: Promise<unknown> = Promise.resolve();
  // A redraw waiting its turn, last in line: redraws of its chat asked for
  // meanwhile join it, their changes after its own.
  let waitingRedraw: { conv: string; error: ErrorChange; done: Promise<void> } | null = null;
  function inTurn<T>(draw: () => Promise<T>): Promise<T> {
    waitingRedraw = null;
    const run = chatDraws.then(draw);
    chatDraws = run.catch(() => {});
    return run;
  }

  /**
   * Draws the page build makes from the open chat as it's shown, with the
   * error it shows changed so, if it's still `conv`. If its messages are
   * shown otherwise once the page is built (a reaction shown at once: the
   * one change that doesn't wait its turn), it's built again from that: a
   * page is only ever drawn on the screen it was built from. Returns that
   * screen and the page; null if `conv` is no longer open.
   */
  async function drawChat(conv: string, build: (shown: ChatScreen) => Promise<ChatPage>, error: ErrorChange = keepError): Promise<{ shown: ChatScreen; page: ChatPage } | null> {
    for (;;) {
      const before = currentScreen();
      if (before.kind !== 'conversation' || before.id !== conv) return null;
      const page = await build(before);
      const now = currentScreen();
      if (now.kind !== 'conversation' || now.id !== conv) return null;
      if (now.messages !== before.messages) continue;
      screen.value = { ...now, error: error(now.error), ...page };
      return { shown: now, page };
    }
  }

  /**
   * Redraws the open chat from storage, if it's still `conv`, with these
   * changes: in its turn (inTurn), from the messages it shows then (older
   * ones loaded before stay). Asked for while a redraw of it waits its turn:
   * that one, with these changes too, after its own.
   */
  function showChat(conv: string, changes: ChatChanges = {}): Promise<void> {
    const current = currentScreen();
    if (current.kind !== 'conversation' || current.id !== conv) return Promise.resolve();
    const waiting = waitingRedraw;
    if (waiting?.conv === conv) {
      const [first, then] = [waiting.error, errorChange(changes)];
      waiting.error = (shown) => then(first(shown));
      return waiting.done;
    }
    const redraw = { conv, error: errorChange(changes), done: Promise.resolve() };
    redraw.done = inTurn(async () => {
      if (waitingRedraw === redraw) waitingRedraw = null;
      await drawChat(conv, (shown) => chatPage(conv, shown), redraw.error);
    });
    waitingRedraw = redraw;
    return redraw.done;
  }

  /**
   * While the open chat shows one of ours as sending: the chat is drawn
   * again once that's been so for STUCK_MS (and a moment), so it shows as
   * not sent then (chatPage) if no copy of the app is sending it, without
   * waiting for something else to redraw it. One still sending after that
   * is being sent by a copy of the app: looked at again STUCK_MS later, in
   * case that copy closes. Stops when the chat is left, or messaging stops.
   */
  let stuckTimer: ReturnType<typeof setTimeout> | undefined;
  let stuckConv: string | null = null;
  function watchStuck(conv: string, messages: MessageView[]): void {
    stopWatchingStuck();
    const now = clock.messageNow();
    const waits = messages.filter((m) => m.out && m.status === 'sending').map((m) => m.at + STUCK_MS - now);
    if (waits.length === 0) return;
    stuckConv = conv;
    stuckTimer = setTimeout(
      () => {
        stuckTimer = undefined;
        void showChat(conv);
      },
      Math.min(...waits.map((wait) => (wait > 0 ? wait : STUCK_MS))) + STUCK_SLACK_MS,
    );
  }
  function stopWatchingStuck(): void {
    clearTimeout(stuckTimer);
    stuckTimer = undefined;
    stuckConv = null;
  }
  // Left for another screen, or another chat.
  screen.subscribe((s) => {
    if (stuckConv !== null && (s.kind !== 'conversation' || s.id !== stuckConv)) stopWatchingStuck();
  });

  // Older messages being loaded (loadOlder), waiting their turn or drawing.
  let loadingOlder = 0;
  /**
   * Shows older messages in the open chat: PAGE more, or all from the one
   * with this ID on (a quote's, to jump to it), in its turn (inTurn), more
   * than it shows then. Returns whether any came. A scroll up while some
   * are loading does nothing (those are what it asks for); a jump to a
   * quote waits its turn after them.
   */
  async function loadOlder(until?: string): Promise<boolean> {
    const current = screen.value;
    if (current.kind !== 'conversation' || !current.more || (loadingOlder > 0 && until === undefined)) return false;
    const conv = current.id;
    loadingOlder++;
    try {
      const drawn = await inTurn(() => drawChat(conv, (shown) => chatPage(conv, shown, until ?? true)));
      if (!drawn) return false;
      // Their attachments shown now download as they would have when the chat opened.
      autoFetch(conv);
      return drawn.page.messages[0]?.id !== drawn.shown.messages[0]?.id;
    } finally {
      loadingOlder--;
    }
  }

  /**
   * Tells the other side, at once, what we've just read. In the background:
   * the screen doesn't wait, and a failure is retried next time.
   */
  function seen(id: string): void {
    // Redrawn whether or not it all went: a call that joined one under way
    // fails if the run after it does, though its own messages were marked.
    void messaging
      ?.markSeen(id)
      .catch(() => {})
      .then(() => showChat(id))
      .catch(() => {});
  }

  /** Blocks the open conversation, silently, then goes back to the list. */
  async function block(): Promise<void> {
    const current = screen.value;
    // Once: not again while it's under way, nor a chat blocked already (or only read).
    if (current.kind !== 'conversation' || !messaging || current.busy || current.blocked || current.readOnly) return;
    screen.value = { ...current, busy: true };
    try {
      await messaging.block(current.id);
    } catch (err) {
      if (handleGone(err)) return;
      showErrorIn(current.id, sendError(err));
      return;
    }
    deps.broadcast({ type: 'data-changed' });
    return showHome({ tab: 'chats', notice: 'blocked' });
  }

  /**
   * Deletes a conversation from this device, and on theirs too if forBoth;
   * blocks them too if asked; then shows the list.
   */
  async function deleteConversation(id: string, alsoBlock: boolean, forBoth = false): Promise<void> {
    if (!messaging) return;
    const current = screen.value;
    if ((current.kind === 'home' || current.kind === 'conversation') && current.busy) return;
    if (current.kind === 'home') homeActions++;
    if (current.kind === 'home' || current.kind === 'conversation') screen.value = { ...current, busy: true };
    try {
      // Told before blocking, which ends our way of writing to them. The
      // name the user gave it goes with it (messaging), unless it stays in
      // Blocked: kept through the delete for both that comes first.
      if (forBoth) await messaging.remove(id, true, alsoBlock);
      if (alsoBlock) await messaging.block(id);
      if (!forBoth) await messaging.remove(id);
    } catch (err) {
      // Stopped partway (deleted, not blocked): the name goes all the same.
      await messaging.tidyName(id).catch(() => {});
      if (handleGone(err)) return;
      return showHome({ tab: 'chats', notice: deviceLimit(err) ?? (err instanceof NetworkError ? 'network' : 'generic') });
    }
    deps.broadcast({ type: 'data-changed' });
    return showHome({ tab: 'chats', notice: alsoBlock ? 'blocked' : 'deleted' });
  }

  /**
   * Gives the open chat (if it's still `id`) the user's own name and
   * picture (null, or nothing left once cleaned: back to its label). On
   * this device only: nothing is sent. Not while it's busy, blocked or
   * read-only (the ⋯ menu isn't offered then), nor while it's out of the
   * list (Rename isn't offered then: a name lasts only while it's in a list).
   */
  async function rename(id: string, custom: ChatCustom | null): Promise<void> {
    const current = screen.value;
    const fromChat = current.kind === 'conversation' && current.id === id && !current.busy && !current.blocked && !current.readOnly && !current.hidden;
    // From the list's selection: a chat in the list (the engine leaves one deleted or blocked meanwhile as it is).
    const fromList = current.kind === 'home' && !current.busy && current.signedOut === null && !current.deletionPaused && current.conversations.some((c) => c.id === id);
    if (!messaging || !(fromChat || fromList)) return;
    const name = custom?.name ? cleanName(custom.name) : '';
    const emoji = custom?.emoji && isEmoji(custom.emoji) ? custom.emoji : '';
    await messaging.rename(id, name || emoji ? { ...(name ? { name } : {}), ...(emoji ? { emoji } : {}) } : null);
    deps.broadcast({ type: 'data-changed' });
    if (fromChat) await showChat(id);
    else await refresh();
  }

  /**
   * Opens a conversation: only ever on a tap in the app, so it's read now,
   * and "seen" goes out. tapped is the hide count when the tap came: if the
   * app was hidden since (even while this runs), "seen" waits for a touch.
   */
  async function openConversation(id: string, tapped = hides): Promise<void> {
    if (tapped === hides) attending = true;
    void refreshBudget();
    const c = await getConversation(deps.db, id);
    if (!c) return showHome();
    // In the background: it waits for a send of ours still going out in this chat.
    void messaging?.markRead(id).catch(() => {});
    backButton(true);
    // In its turn (inTurn): a draw under way, of this chat as it was shown before, finishes first.
    await inTurn(async () => {
      screen.value = {
        kind: 'conversation',
        id,
        ...(await chatName(c)),
        original: c.label,
        hidden: !!c.hidden,
        role: c.role,
        ended: c.status === 'ended',
        blocked: c.status === 'blocked',
        readOnly: signedOut !== null || deletionPaused,
        ...(await chatPage(id, null)),
        busy: false,
        error: null,
      };
    });
    if (attending) seen(id);
    autoFetch(id);
  }

  // Upload and download progress of attachments, by messageKey (0 to 1).
  const transfers = signal<Record<string, number>>({});
  const setProgress = (key: string, fraction: number | null) => {
    const next = { ...transfers.value };
    if (fraction === null) delete next[key];
    else next[key] = fraction;
    transfers.value = next;
  };

  // Attachments being prepared (a photo being shrunk), shown at once with
  // the picked file until their message is stored.
  const preparing = signal<Preparing[]>([]);
  const unprepare = (key: string) => {
    const item = preparing.value.find((p) => p.key === key);
    if (item?.url) URL.revokeObjectURL(item.url);
    preparing.value = preparing.value.filter((p) => p.key !== key);
  };

  /**
   * Sends a picked file in the open conversation: as a photo (redrawn,
   * smaller), a video, GIF or music (as it is, shown inline), or a file
   * (untouched).
   */
  async function sendMedia(file: File, as: SendAs, caption: string, replyTo?: string): Promise<void> {
    const current = screen.value;
    if (current.kind !== 'conversation' || current.busy || !messaging) return;
    const key = crypto.randomUUID();
    const shown = as === 'photo' || as === 'video' || as === 'gif';
    preparing.value = [
      ...preparing.value,
      { key, conv: current.id, as, url: shown ? URL.createObjectURL(file) : null, name: file.name, size: file.size, caption: caption.trim() },
    ];
    let out: Outgoing;
    try {
      out = await { photo: preparePhoto, video: prepareVideo, gif: prepareGif, audio: prepareAudio, file: prepareFile }[as](file);
    } catch (err) {
      unprepare(key);
      const now = currentScreen();
      if (now.kind === 'conversation' && now.id === current.id) screen.value = { ...now, error: err instanceof TooBig ? 'too-big' : 'unreadable' };
      return;
    }
    await sendPrepared(current.id, key, out, caption.trim(), replyTo);
  }

  /** Sends a recorded voice message in the open conversation. */
  async function sendVoice(recording: Recording, replyTo?: string): Promise<void> {
    const current = screen.value;
    if (current.kind !== 'conversation' || current.busy || !messaging) return;
    const key = crypto.randomUUID();
    const media = { t: 'voice', s: recording.file.length, m: recording.type, l: recording.length, v: toBase64Url(recording.waveform) };
    preparing.value = [...preparing.value, { key, conv: current.id, as: 'voice', url: null, name: fileName(media), size: media.s, caption: '' }];
    await sendPrepared(current.id, key, { file: recording.file, media }, '', replyTo);
  }

  /**
   * Sends a video message in the open conversation. It shows at once, with
   * its last frame, while the recording is finished off (seconds, on some
   * phones); null from the recording means it was too short.
   */
  async function sendRound(pending: Promise<RoundRecording | null>, still: string | null, replyTo?: string): Promise<void> {
    const current = screen.value;
    if (current.kind !== 'conversation' || current.busy || !messaging) return void pending.catch(() => {});
    const key = crypto.randomUUID();
    preparing.value = [...preparing.value, { key, conv: current.id, as: 'round', url: null, still, name: '', size: 0, caption: '' }];
    let recording: RoundRecording | null;
    try {
      recording = await pending;
    } catch (err) {
      unprepare(key);
      throw err;
    }
    if (!recording) return unprepare(key);
    const { file, type, length, side } = recording;
    const media = { t: 'round', s: file.length, m: type, l: length, w: side, h: side, ...(recording.preview ? { p: recording.preview } : {}) };
    const url = URL.createObjectURL(new Blob([file], { type }));
    preparing.value = preparing.value.map((p) => (p.key === key ? { ...p, url, name: fileName(media), size: media.s } : p));
    await sendPrepared(current.id, key, { file, media }, '', replyTo);
  }

  /** Stores, uploads and sends a prepared attachment; its "preparing" stand-in goes once it's stored. */
  async function sendPrepared(conv: string, key: string, out: Outgoing, caption: string, replyTo?: string): Promise<void> {
    if (!messaging) return unprepare(key);
    const before = currentScreen();
    if (before.kind === 'conversation' && before.id === conv) screen.value = { ...before, error: null };
    let error: SendError | null = null;
    let sent: string | null = null;
    const show = () => showChat(conv, { error });
    try {
      await messaging.sendMedia(
        conv,
        out,
        caption,
        replyTo,
        async (id) => {
          sent = messageKey({ conv, id });
          setProgress(sent, 0);
          await show();
          unprepare(key);
        },
        (f) => sent && setProgress(sent, f),
      );
    } catch (err) {
      unprepare(key);
      if (handleGone(err)) return;
      error = sendError(err);
    }
    if (sent) setProgress(sent, null);
    deps.broadcast({ type: 'data-changed' });
    await show();
  }

  /**
   * Sends again one of ours in the open conversation that wasn't sent
   * (Send again in its menu): the same message, at the end of the
   * conversation, as a new one would go. An attachment uploaded then
   * (resendUploads) shows its upload's progress.
   */
  async function resend(id: string): Promise<void> {
    const current = screen.value;
    if (current.kind !== 'conversation' || current.busy || !messaging) return;
    const conv = current.id;
    const key = messageKey({ conv, id });
    if (transfers.value[key] !== undefined) return;
    const message = current.messages.find((m) => m.id === id);
    const uploads = !!message && resendUploads(message, clock.messageNow());
    screen.value = { ...current, error: null };
    let error: SendError | null = null;
    const show = () => showChat(conv, { error });
    if (uploads) setProgress(key, 0);
    try {
      await messaging.resend(conv, id, show, (f) => setProgress(key, f));
    } catch (err) {
      if (handleGone(err)) return;
      error = sendError(err);
    } finally {
      if (uploads) setProgress(key, null);
    }
    deps.broadcast({ type: 'data-changed' });
    await show();
  }

  // Until when attachments aren't fetched by themselves: the server said
  // downloads are paused, or an automatic fetch failed (out of reach, turned
  // away, failing, or the file couldn't be stored), so the rest aren't asked
  // for one by one meanwhile.
  let downloadsPausedUntil = 0;
  /** Attachments whose fetching by itself failed in this run, and how often (AUTO_TRIES). */
  const autoFailures = new Map<string, number>();

  /**
   * Fetches a received attachment: on a tap, or by itself (auto) for
   * photos, GIFs, voice and video messages. If downloads are paused, a tap
   * says so; fetching by itself stops quietly for a while (PAUSED_WAIT_MS).
   * If this file was downloaded as often as a day allows, a tap says until
   * when, and it isn't fetched by itself again in this run.
   * One that's gone or broken is marked so (messaging.fetchMedia), and isn't
   * fetched by itself again.
   */
  async function fetchMedia(m: MessageRef, auto = false): Promise<void> {
    const key = messageKey(m);
    if (!messaging || transfers.value[key] !== undefined) return;
    setProgress(key, 0);
    let paused = false;
    let limited: LimitError | null = null;
    try {
      await messaging.fetchMedia(m.conv, m.id, (f) => setProgress(key, f), auto);
      // Answered: downloads aren't paused (any more).
      downloadsPausedUntil = 0;
    } catch (err) {
      // Otherwise tried again on the next tap or opening.
      if (isPaused(err)) {
        paused = true;
        downloadsPausedUntil = Date.now() + PAUSED_WAIT_MS;
      } else if (err instanceof ApiError && err.code === 'download_limit') {
        // This file's limit, until the day ends: the others aren't held up.
        limited = limitError('download-limit', err);
        autoFailures.set(key, AUTO_TRIES);
      } else if (auto) {
        // However it failed: not again at once, for this one or the rest;
        // and this one only a few times in all.
        downloadsPausedUntil = Date.now() + PAUSED_WAIT_MS * (0.5 + Math.random() / 2);
        autoFailures.set(key, (autoFailures.get(key) ?? 0) + 1);
      }
    } finally {
      setProgress(key, null);
    }
    const now = currentScreen();
    if (now.kind === 'conversation') {
      // A tap says it's paused or past the day's downloads, or that it no
      // longer is: by the notice shown when the chat is drawn (in its turn,
      // perhaps after a tap's still waiting), not the one shown now. Any
      // other error is left as it is then.
      const onTap = !auto && now.id === m.conv;
      const changes: ChatChanges = !onTap ? {} : paused ? { error: 'media-paused' } : limited ? { error: limited } : { clearDownloadError: true };
      await showChat(now.id, changes);
    }
  }

  /**
   * Saves an attachment to the device. Where the Mini App has a share sheet
   * (some phones), through that. Otherwise, a received one opens the save
   * page in the device's own browser (media/save.ts). Must run straight from
   * a tap: Telegram only opens links then.
   */
  async function saveMedia(m: MessageView): Promise<'shared' | 'opened' | 'unavailable'> {
    const media = m.media;
    if (!media) return 'unavailable';
    if (typeof navigator.canShare === 'function') {
      const file = await getMedia(deps.db, m.conv, m.id);
      // Only a passive type, as for showing it.
      const type = passiveType(media.m);
      const shareable = file && new File([file], fileName(media), type ? { type } : {});
      if (shareable && navigator.canShare({ files: [shareable] })) {
        try {
          await navigator.share({ files: [shareable] });
          return 'shared';
        } catch {
          // Cancelled: nothing more to do.
          return 'shared';
        }
      }
    }
    if (!m.out && media.id && media.k && media.d && deps.bridge) {
      const base = location.origin + location.pathname;
      deps.bridge.post('web_app_open_link', { url: saveUrl(base, media as Media) });
      return 'opened';
    }
    return 'unavailable';
  }

  /**
   * Photos, voice and video messages and GIFs are fetched as soon as their
   * conversation is open, as in Telegram, up to a size for each kind
   * (fetchesByItself), unless turned off in Data and storage; videos, music,
   * files and anything larger wait for a tap. Only those that came after
   * the user first wrote in the chat, though (store.ts, answeredAt and
   * comesAfter): in a chat they haven't written in, everything waits for a
   * tap, and so does what came before their first message, each on its own
   * (a tap fetches that one only). Attachments cleared from this device,
   * gone or broken also wait for a tap.
   */
  function autoFetch(conv: string): void {
    const now = currentScreen();
    if (now.kind !== 'conversation' || now.id !== conv) return;
    const { auto } = mediaSettings;
    const candidates = now.messages.filter((m) => m.file === 'remote' && !m.out && m.media && fetchesByItself(m.media, auto));
    // Nothing to fetch: not even where the user first wrote is looked up.
    if (candidates.length === 0) return;
    void (async () => {
      const answered = await answeredAt(deps.db, conv).catch(() => undefined);
      if (!answered) return;
      for (const m of candidates) {
        // Paused: one refusal, not one per attachment.
        if (Date.now() < downloadsPausedUntil) return;
        if (!comesAfter(m, answered) || (autoFailures.get(messageKey(m)) ?? 0) >= AUTO_TRIES) continue;
        await fetchMedia(m, true);
      }
    })();
  }

  // Object URLs of attachments on this device, for showing them; dropped when another conversation opens.
  let urls = new Map<string, string>();
  let urlsFor: string | null = null;
  /** A URL for a message's attachment, if it's on this device. */
  async function mediaUrl(m: MessageRef, type?: string): Promise<string | null> {
    const now = currentScreen();
    const conv = now.kind === 'conversation' ? now.id : null;
    if (conv !== urlsFor) {
      for (const u of urls.values()) URL.revokeObjectURL(u);
      urls = new Map();
      urlsFor = conv;
    }
    const key = messageKey(m);
    const cached = urls.get(key);
    if (cached) return cached;
    const file = await getMedia(deps.db, m.conv, m.id);
    if (!file) return null;
    // QuickTime videos and .m4a songs play as MP4 (the same container) where
    // a browser doesn't know their type. Only a passive type is used: an SVG
    // or HTML file is never handed over as one.
    const shown = passiveType(type === 'video/quicktime' ? 'video/mp4' : type === 'audio/x-m4a' ? 'audio/mp4' : type);
    const url = URL.createObjectURL(new Blob([file], shown ? { type: shown } : {}));
    urls.set(key, url);
    return url;
  }

  /** Clears attachments older than the "keep media" setting from this device. */
  async function tidyMedia(): Promise<number> {
    const before = keepCutoff(mediaSettings.keep, Date.now());
    if (before === null) return 0;
    const freed = await clearMedia(deps.db, { before });
    if (freed > 0) deps.broadcast({ type: 'data-changed' });
    return freed;
  }

  /** The ID of the issuer key of a kind this build names (the tests' own, if given): only its tokens count. */
  function buildKeyId(kind: TokenKind): Uint8Array | undefined {
    return kind === 'send' ? (deps.issuer ?? deps.config?.issuer)?.keyId : (deps.mediaIssuer ?? deps.config?.issuer.media)?.keyId;
  }

  /** How many tokens of a kind this device holds unused. */
  async function tokensHeld(kind: TokenKind): Promise<number> {
    const keyId = buildKeyId(kind);
    return keyId ? countTokens(deps.db, keyId, undefined, kind) : 0;
  }

  /** Updates how many messages can still be sent today. */
  async function refreshBudget(): Promise<void> {
    const keyId = buildKeyId('send');
    messagesLeft.value = keyId ? await budgetLeft(deps.db, keyId) : null;
  }

  /** Usage: today's limits, from the server's counts and what this device holds unused. */
  async function showUsage(): Promise<void> {
    backButton(true);
    screen.value = { kind: 'usage', usage: null, error: null };
    let info;
    try {
      info = await session!.call('GET', '/usage', undefined, checkUsage);
    } catch (err) {
      if (handleGone(err)) return;
      if (currentScreen().kind === 'usage') {
        screen.value = { kind: 'usage', usage: null, error: deviceLimit(err) ?? (err instanceof NetworkError ? 'network' : 'generic') };
      }
      return;
    }
    // What the server will still sign today, for the low-balance notice
    // too: never more than it said before today (a batch's exact answer),
    // since this one may miss what was counted in the last half a minute.
    const serverDay = Math.floor(info.resetsAt / 86_400) - 1;
    const sendLeft = await lowerLeft(deps.db, 'send', info.send.limit - info.send.used, serverDay);
    const mediaLeft = await lowerLeft(deps.db, 'media', info.media.limit - info.media.used, serverDay);
    info = { ...info, send: { ...info.send, used: info.send.limit - sendLeft }, media: { ...info.media, used: info.media.limit - mediaLeft } };
    void refreshBudget();
    const held = {
      sendTokens: await tokensHeld('send'),
      mediaTokens: await tokensHeld('media'),
      spareMailboxes: await poolSize(deps.db),
    };
    if (currentScreen().kind !== 'usage') return;
    screen.value = { kind: 'usage', usage: usageView(info, held), error: null };
  }

  /** Data and storage, with what was just cleared (bytes), if anything. */
  async function showStorage(cleared: number | null = null): Promise<void> {
    backButton(true);
    mediaSettings = await getMediaSettings(deps.db);
    const current = screen.value;
    if (current.kind !== 'storage') screen.value = { kind: 'storage', settings: mediaSettings, usage: null, busy: true, cleared };
    // Also the size Settings shows: a measurement like Settings' own, the latest started winning.
    const run = ++mediaRuns;
    const { total, byConversation } = await mediaUsage(deps.db);
    if (run === mediaRuns) mediaBytes = total;
    const labels = new Map(await Promise.all((await listConversations(deps.db)).map(async (c) => [c.id, (await chatName(c)).label] as const)));
    const chats = Object.entries(byConversation)
      .filter(([, bytes]) => bytes > 0)
      .map(([id, bytes]) => ({ id, label: labels.get(id) ?? '', bytes }))
      .sort((a, b) => b.bytes - a.bytes);
    let app: StorageUsage['app'] = null;
    try {
      const estimate = await navigator.storage?.estimate?.();
      if (estimate?.usage !== undefined && estimate.quota) app = { usage: estimate.usage, quota: estimate.quota };
    } catch {
      // Not every webview tells (Telegram Desktop on Linux has no navigator.storage).
    }
    if (currentScreen().kind !== 'storage') return;
    screen.value = { kind: 'storage', settings: mediaSettings, usage: { media: total, chats, app }, busy: false, cleared };
  }

  async function changeMediaSettings(change: (s: MediaSettings) => MediaSettings): Promise<void> {
    const current = screen.value;
    if (current.kind !== 'storage' || current.busy) return;
    mediaSettings = change(await getMediaSettings(deps.db));
    await putMediaSettings(deps.db, mediaSettings);
    screen.value = { ...current, settings: mediaSettings, busy: true, cleared: null };
    const freed = await tidyMedia();
    return showStorage(freed > 0 ? freed : null);
  }

  /** Clears attachments from this device: one conversation's, or all. */
  async function clearStoredMedia(conv?: string): Promise<void> {
    const current = screen.value;
    if (current.kind !== 'storage' || current.busy) return;
    screen.value = { ...current, busy: true, cleared: null };
    const freed = await clearMedia(deps.db, conv === undefined ? {} : { conv });
    if (freed > 0) deps.broadcast({ type: 'data-changed' });
    return showStorage(freed);
  }

  /** The Blocked list. */
  async function showBlocked(notice: HomeNotice | null = null): Promise<void> {
    backButton(true);
    screen.value = { kind: 'blocked', conversations: await conversations(true), busy: false, notice };
  }

  /** Unblocks a conversation, from the Blocked list or from the conversation itself. */
  async function unblock(id: string): Promise<void> {
    const current = screen.value;
    if (!messaging || ((current.kind === 'blocked' || current.kind === 'conversation') && current.busy)) return;
    if (current.kind === 'blocked' || current.kind === 'conversation') screen.value = { ...current, busy: true };
    const tapped = hides;
    try {
      await messaging.unblock(id);
    } catch (err) {
      if (handleGone(err)) return;
      if (current.kind === 'conversation') return showErrorIn(current.id, sendError(err));
      // Only if the user is still on the Blocked list.
      if (currentScreen().kind === 'blocked') return showBlocked(deviceLimit(err) ?? (err instanceof NetworkError ? 'network' : 'generic'));
      return;
    }
    deps.broadcast({ type: 'data-changed' });
    if (current.kind === 'conversation') return openConversation(id, tapped);
    return showBlocked('unblocked');
  }

  /**
   * Shows why an action in a conversation failed, once it has: only if that
   * conversation is still open (an error that comes late mustn't take the
   * user back from where they've gone since), and as it is now (refreshed
   * meanwhile, say), no longer busy.
   */
  function showErrorIn(id: string, error: SendError): void {
    const now = currentScreen();
    if (now.kind === 'conversation' && now.id === id) screen.value = { ...now, busy: false, error };
  }

  function sendError(err: unknown): SendError {
    if (err instanceof NoTokens) return 'no-tokens';
    if (err instanceof NoMailboxes) return 'no-mailboxes';
    if (err instanceof MailboxLimit) return 'mailbox-limit';
    if (err instanceof TurnedAway) return 'turned-away';
    if (err instanceof ApiError && err.code === 'link_busy') return limitError('link-busy', err);
    if (err instanceof ApiError && err.code === 'rate_limited') return 'rate-limited';
    const limited = deviceLimit(err);
    if (limited) return limited;
    if (isPaused(err)) return 'media-paused';
    // The server no longer holds the issuer key this build names (it was
    // replaced): a fresh copy of the app names the new one.
    if (err instanceof ApiError && err.code === 'unknown_issuer_key') return 'outdated';
    if (err instanceof NetworkError) return 'network';
    return 'generic';
  }

  /** Sends a message, or a sticker, in the open conversation. */
  async function sendMessage(content: string | { sticker: Sticker }, replyTo?: string): Promise<void> {
    const current = screen.value;
    if (current.kind !== 'conversation' || current.busy || !messaging) return;
    if (typeof content === 'string' && content.trim() === '') return;
    screen.value = { ...current, error: null };
    let error: SendError | null = null;
    // Shown at once as "sending", updated when delivered.
    const show = () => showChat(current.id, { error });
    try {
      await messaging.send(current.id, typeof content === 'string' ? content.trim() : content, replyTo, show);
    } catch (err) {
      if (handleGone(err)) return;
      error = sendError(err);
    }
    deps.broadcast({ type: 'data-changed' });
    await show();
  }

  /**
   * Reacts to a message in the open conversation with one emoji; the same
   * emoji again takes the reaction back. Shown at once; if it can't be sent,
   * it goes back and the conversation says why.
   */
  async function react(id: string, emoji: string): Promise<void> {
    const current = screen.value;
    if (current.kind !== 'conversation' || current.busy || !messaging) return;
    const message = current.messages.find((m) => m.id === id);
    if (!message) return;
    const next = (message.reactions?.mine?.e ?? '') === emoji ? '' : emoji;
    const shown = (m: MessageView): MessageView => (m.id === id ? { ...m, reactions: { ...m.reactions, mine: { e: next, at: Date.now() } } } : m);
    screen.value = { ...current, error: null, messages: current.messages.map(shown) };
    let error: SendError | null = null;
    try {
      await messaging.react(current.id, id, next);
    } catch (err) {
      if (handleGone(err)) return;
      error = sendError(err);
    }
    deps.broadcast({ type: 'data-changed' });
    await showChat(current.id, { error });
  }

  /** Writes the first message to the link just checked, starting a conversation. */
  async function writeToLink(text: string): Promise<void> {
    const current = screen.value;
    const link = openedLink;
    if (current.kind !== 'link' || current.status !== 'verified' || current.busy || !messaging || !link || text.trim() === '') return;
    screen.value = { ...current, busy: true, error: null };
    let opened: string | null = null;
    const tapped = hides;
    try {
      // The conversation opens as soon as the message is stored, shown as sending.
      await messaging.startConversation(link.ref, link.bundle, text.trim(), async (id) => {
        opened = id;
        await openConversation(id, tapped);
      });
      deps.broadcast({ type: 'data-changed' });
      await refresh();
    } catch (err) {
      if (handleGone(err)) return;
      const error = sendError(err);
      const now = currentScreen();
      // Shown where the user is still: in the conversation it opened, or on
      // this link's screen. Nowhere if they've gone elsewhere since.
      if (opened && now.kind === 'conversation' && now.id === opened) {
        await showChat(opened, { error });
      } else if (now.kind === 'link' && now.status === 'verified' && openedLink === link) {
        screen.value = { ...now, busy: false, error };
      }
    }
  }

  /**
   * After logging in or registering: go where the launch (or a launch before
   * setup) pointed. Only to a screen: a launch can come from anyone's link,
   * so nothing is opened, sent or redeemed until the user taps.
   */
  async function continueLaunch(offline: boolean, notice: HomeNotice | null = null): Promise<void> {
    const param = launchParam ?? (await takePendingLink(deps.db)) ?? '';
    launchParam = null;
    const ref = parsePayload(param);
    if (ref) return openLink(ref);
    const code = parseInvitationPayload(param);
    if (code) {
      // Joining tells whoever made the invitation that it was used, and when.
      // Offline too: Join then says it couldn't reach the server.
      screen.value = { kind: 'invitation', code, busy: false, error: null };
      return;
    }
    return showHome({ offline, notice });
  }

  /**
   * Deletes the account, once the user typed the confirmation: from then on
   * the deletion goes ahead, and a launch carries on with it if the app
   * closes first (META_DELETING), so the account is never left half
   * deleted. See runDeletion. This is also how a deletion the server says is
   * under way, with no record of it here, is finished (Finish deleting).
   */
  async function deleteAccount(forBoth = false): Promise<void> {
    const current = screen.value;
    if (current.kind !== 'confirm-delete' || current.busy || !session) return;
    const account = await readAccount(deps.db);
    if (!isSetUp(account)) return;
    // Its chats for both sides first, if the user ticked that: only before
    // a deletion starts (once it has, the account takes no other request,
    // so no send tokens can be fetched), and only once (a second tap finds
    // this screen gone).
    if (forBoth && !current.finishing && signedOut === null && !deletionPaused && !(await deletionConfirmed())) {
      if (screen.value !== current) return;
      return deleteChatsForBoth(account.accountId);
    }
    return confirmDeletion(account.accountId);
  }

  /**
   * Records the deletion the user confirmed, for the account they confirmed
   * it for, and starts it (runDeletion). Nothing if the device holds another
   * account by now (another copy deleted it, and set up again).
   */
  async function confirmDeletion(accountId: string): Promise<void> {
    const account = await readAccount(deps.db);
    if (!isSetUp(account) || account.accountId !== accountId) return start();
    // Not one already under way (confirmed here before, or the server says
    // so): the server may take nothing else for it now.
    const first = signedOut !== 'deleting' && signedOut !== 'expired' && !(await deletionConfirmed());
    await putMeta(deps.db, META_DELETING, { accountId: account.accountId });
    signedOut = null;
    readOnly.value = false;
    return runDeletion(first);
  }

  /**
   * Counts runs of deleteChatsForBoth: a new run, leaving its screen
   * (keepAccount), or going on to the deletion ends the one under way.
   */
  let chatsRun = 0;
  /**
   * The run whose stop the screen shows, and the account it's for: Try
   * again and Delete anyway act on it alone, and only while it's the latest
   * (not once Keep was tapped, while home loads).
   */
  let chatsStopped: { run: number; accountId: string } | null = null;
  /**
   * When each delete for both sides before a deletion went out, or failed
   * (Unix ms), within the last window: the pace holds across runs (Try
   * again).
   */
  const chatSends: number[] = [];

  /**
   * Before deleting the account, as the user asked: deletes each chat in
   * the list for both sides, one at a time, as the chat's own Delete does
   * (messaging.remove: their app is told, and the uploads of the user's
   * attachments there are queued for deletion, with the deletion's own; one
   * of the day's messages each). Only open ones that a delete for both can
   * reach: not blocked, not ended, not out of the list (deleted here only).
   * Paced (CHAT_DELETE_GAP_MS, CHAT_DELETES_PER_WINDOW), so the firewall
   * doesn't turn the device away, which would hold up the deletion's
   * uploads too. A chat whose link takes no more first messages this hour
   * (link_busy) is left for later, and the others go on. Then the deletion
   * itself (confirmDeletion).
   *
   * One that can't be sent stops it, and the user chooses (deleting-chats'
   * stopped): Try again (the chats still in the list), deleting the account
   * anyway (the rest stay with the other side), or keeping it. Nothing of
   * this is saved: leaving the screen (Cancel, back), or closing the app,
   * ends it with the account kept, so it never deletes the account with
   * chats left that the user didn't agree to.
   */
  async function deleteChatsForBoth(accountId: string): Promise<void> {
    const run = ++chatsRun;
    chatsStopped = null;
    let done = 0;
    let total = 0;
    /** Chats left for later: their link takes no more first messages this hour (link_busy); and until when (Unix ms, the latest the server said; null if it didn't). */
    let busy = 0;
    let busyUntil: number | null = null;
    screen.value = { kind: 'deleting-chats', done, total, stopped: null };
    const ours = () => run === chatsRun && currentScreen().kind === 'deleting-chats';
    const show = () => {
      if (ours()) screen.value = { kind: 'deleting-chats', done, total, stopped: null };
    };
    const stop = (reason: ChatsStop) => {
      if (!ours()) return;
      chatsStopped = { run, accountId };
      const until = reason === 'link-busy' ? { until: busyUntil } : {};
      screen.value = { kind: 'deleting-chats', done, total, stopped: { reason, left: total - done + busy, ...until } };
    };
    const open = (c: ConversationRecord | undefined): c is ConversationRecord => !!c && c.status === 'active' && !c.hidden;
    const ids = (await listConversations(deps.db)).filter(open).map((c) => c.id);
    total = ids.length;
    show();
    // Messaging, if it couldn't start before: the box is never ignored.
    if (total > 0) await createEngine();
    for (const id of ids) {
      if (!ours()) return;
      // Blocked, deleted, or deleted for both sides meanwhile (another copy):
      // nothing left to do. Looked at again after the wait, which can be long.
      if (open(await getConversation(deps.db, id))) {
        await chatDeleteTurn();
        const account = await readAccount(deps.db);
        const still = open(await getConversation(deps.db, id));
        if (!ours()) return;
        // Another copy deleted the account, and set up a new one: start again.
        if (!isSetUp(account) || account.accountId !== accountId) {
          chatsRun++;
          return start();
        }
        // This build can't send (its token key won't load): a fresh copy of the app can.
        if (still && !messaging) return stop('outdated');
        if (still && messaging) {
          try {
            await messaging.remove(id, true);
            deps.broadcast({ type: 'data-changed' });
            // The list, if it shows by now (Cancel while this was sent).
            void refresh();
          } catch (err) {
            if (!ours()) return;
            if (handleGone(err)) return;
            // Not for both sides any more (blocked meanwhile, say): nothing to do.
            if (open(await getConversation(deps.db, id))) {
              // Its link is full for this hour: the others go on, and it's left for later.
              if (err instanceof ApiError && err.code === 'link_busy') {
                busy++;
                const until = limitError('link-busy', err).until;
                if (until !== null) busyUntil = Math.max(busyUntil ?? 0, until);
              } else return stop(chatsStop(err));
            }
          } finally {
            chatSends.push(Date.now());
          }
        }
      }
      done++;
      show();
    }
    if (!ours()) return;
    if (busy > 0) return stop('link-busy');
    // On to the deletion in the same turn as the last look: a Cancel or back
    // from now on finds its screen gone.
    chatsRun++;
    backButton(false);
    screen.value = { kind: 'deleting', error: null };
    return confirmDeletion(accountId);
  }

  /**
   * Waits for the next delete for both sides' turn (CHAT_DELETE_GAP_MS
   * apart, at most CHAT_DELETES_PER_WINDOW in a window), across runs: before
   * deleting the account, and of chats selected in the list, alike.
   */
  async function chatDeleteTurn(): Promise<void> {
    const gap = deps.chatDeleteGapMs ?? CHAT_DELETE_GAP_MS;
    const window = deps.chatDeleteWindow ?? { count: CHAT_DELETES_PER_WINDOW, ms: CHAT_DELETE_WINDOW_MS };
    while (chatSends.length > 0 && chatSends[0]! <= Date.now() - window.ms) chatSends.shift();
    let wait = chatSends.length > 0 ? chatSends.at(-1)! + gap - Date.now() : 0;
    if (chatSends.length >= window.count) wait = Math.max(wait, chatSends[chatSends.length - window.count]! + window.ms - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  /** Counts runs of deleteSelectedForBoth: a new run, or leaving its screen, ends the one under way. */
  let selectedRun = 0;
  /** The latest run's chats it didn't delete, if it stopped: Try again carries on with them, as asked (alsoBlock). */
  let selectedLeft: { run: number; ids: string[]; alsoBlock: boolean } | null = null;

  /**
   * Deletes chats selected in the list (the list's own order): one alone as
   * its own Delete does (deleteConversation); several here, or for both
   * sides (deleteSelectedForBoth), blocking them too if asked.
   */
  async function deleteChats(ids: string[], alsoBlock: boolean, forBoth: boolean): Promise<void> {
    if (ids.length === 1) return deleteConversation(ids[0]!, alsoBlock, forBoth);
    const current = screen.value;
    if (ids.length === 0 || current.kind !== 'home' || current.busy || !messaging) return;
    if (forBoth) {
      homeActions++;
      return deleteSelectedForBoth(ids, alsoBlock);
    }
    homeActions++;
    screen.value = { ...current, busy: true, notice: null };
    try {
      for (const id of ids) {
        // Blocked, deleted, or gone meanwhile (another copy): nothing left to do.
        const c = await getConversation(deps.db, id);
        if (!c || c.hidden || c.status === 'blocked') continue;
        // Blocked first: the name it was given then stays, for Blocked.
        if (alsoBlock) await messaging.block(id);
        await messaging.remove(id);
      }
    } catch (err) {
      if (handleGone(err)) return;
      deps.broadcast({ type: 'data-changed' });
      return showHome({ tab: 'chats', notice: deviceLimit(err) ?? (err instanceof NetworkError ? 'network' : 'generic') });
    }
    deps.broadcast({ type: 'data-changed' });
    return showHome({ tab: 'chats', notice: alsoBlock ? 'blocked' : 'deleted-many' });
  }

  /**
   * Deletes chats selected in the list for both sides, as their own Delete
   * does (messaging.remove: their app is told; one of the day's messages
   * each), blocking each too if asked; one at a time, paced as before
   * deleting the account (chatDeleteTurn). One that can't be deleted for
   * both sides any more (ended, or deleted here meanwhile) is deleted here,
   * as asked. A chat whose link takes no more first messages this hour
   * (link_busy) is left for later, and the others go on. One that can't be
   * sent stops it (deleting-selected's stopped): Try again (the ones left),
   * or Stop (they stay with the other side). Nothing of this is saved:
   * leaving the screen (Cancel, back), or closing the app, stops it.
   */
  async function deleteSelectedForBoth(ids: string[], alsoBlock: boolean): Promise<void> {
    const run = ++selectedRun;
    selectedLeft = null;
    let done = 0;
    const total = ids.length;
    /** Left for later: their link takes no more first messages this hour; and until when (Unix ms, the latest the server said). */
    const busy: string[] = [];
    let busyUntil: number | null = null;
    const ours = () => run === selectedRun && currentScreen().kind === 'deleting-selected';
    const show = () => {
      if (ours()) screen.value = { kind: 'deleting-selected', done, total, stopped: null };
    };
    const stop = (reason: ChatsStop, left: string[]) => {
      if (!ours()) return;
      selectedLeft = { run, ids: left, alsoBlock };
      const until = reason === 'link-busy' ? { until: busyUntil } : {};
      screen.value = { kind: 'deleting-selected', done, total, stopped: { reason, left: left.length, ...until } };
    };
    const forBoth = (c: ConversationRecord | undefined): c is ConversationRecord => !!c && c.status === 'active' && !c.hidden;
    backButton(true);
    screen.value = { kind: 'deleting-selected', done, total, stopped: null };
    // Messaging, if it couldn't start before.
    await createEngine();
    for (const [i, id] of ids.entries()) {
      if (!ours()) return;
      const left = () => [...busy, ...ids.slice(i)];
      if (forBoth(await getConversation(deps.db, id))) {
        await chatDeleteTurn();
        if (!ours()) return;
        // This build can't send (its token key won't load): a fresh copy of the app can.
        // Held here: signed out meanwhile, the app's own messaging goes, not this one.
        const m = messaging;
        if (!m) return stop('outdated', left());
        // Looked at again after the wait, which can be long; and left (Back) meanwhile: nothing goes out.
        if (forBoth(await getConversation(deps.db, id)) && ours()) {
          try {
            // The name it was given is kept through it if it's to be blocked (for Blocked).
            await m.remove(id, true, alsoBlock);
            if (alsoBlock) await m.block(id);
            deps.broadcast({ type: 'data-changed' });
          } catch (err) {
            // Deleted for both, not blocked (the block failed): the name goes, left or not; Try again blocks it.
            await m.tidyName(id).catch(() => {});
            if (!ours()) return;
            if (handleGone(err)) return;
            const now = await getConversation(deps.db, id);
            const stillOpen = !!now && now.status === 'active' && !now.hidden;
            if (stillOpen && err instanceof ApiError && err.code === 'link_busy') {
              // Its link is full for this hour: the others go on, and it's left for later.
              busy.push(id);
              const until = limitError('link-busy', err).until;
              if (until !== null) busyUntil = Math.max(busyUntil ?? 0, until);
            } else if (stillOpen || (alsoBlock && !!now && now.status !== 'blocked')) return stop(chatsStop(err), left());
          } finally {
            chatSends.push(Date.now());
          }
        }
      } else {
        // Not for both sides (ended, or deleted here meanwhile): here, as asked.
        const c = await getConversation(deps.db, id);
        const m = messaging;
        if (!ours()) return;
        if (c && c.status !== 'blocked' && !m) return stop('outdated', left());
        if (c && c.status !== 'blocked' && m) {
          try {
            if (alsoBlock) await m.block(id);
            if (!c.hidden) await m.remove(id);
            deps.broadcast({ type: 'data-changed' });
          } catch (err) {
            if (!ours()) return;
            if (handleGone(err)) return;
            return stop(chatsStop(err), left());
          }
        }
      }
      done++;
      show();
    }
    if (!ours()) return;
    if (busy.length > 0) return stop('link-busy', busy);
    selectedRun++;
    return showHome({ tab: 'chats', notice: alsoBlock ? 'blocked' : 'deleted-many-both' });
  }

  /** Leaves deleting selected chats for both sides (Cancel, Stop, or back): at once, the rest kept. */
  function stopDeletingSelected(): Promise<void> | undefined {
    if (currentScreen().kind !== 'deleting-selected') return;
    selectedRun++;
    backButton(false);
    return showHome({ tab: 'chats' });
  }

  /** What stopped the deletes for both sides before the account, for the user. */
  function chatsStop(err: unknown): ChatsStop {
    if (err instanceof NoTokens) return 'no-tokens';
    // The firewall, or a mailbox's cap: later.
    if (err instanceof ApiError && err.code === 'rate_limited') return 'turned-away';
    const limited = deviceLimit(err);
    if (limited) return limited;
    if (err instanceof ApiError && err.code === 'unknown_issuer_key') return 'outdated';
    if (err instanceof NetworkError) return 'network';
    return 'generic';
  }

  /** The stop the screen shows, if it's the latest run's, with the account it's for. */
  function stoppedChats(): { reason: ChatsStop; accountId: string } | null {
    const current = currentScreen();
    if (current.kind !== 'deleting-chats' || !current.stopped || chatsStopped?.run !== chatsRun) return null;
    return { reason: current.stopped.reason, accountId: chatsStopped.accountId };
  }

  /**
   * Leaves deleting the chats for both sides (Cancel, Keep, or back),
   * keeping the account: at once, so nothing of the run acts after it, nor
   * a tap on its screen while home loads.
   */
  function keepAccount(): Promise<void> | undefined {
    if (currentScreen().kind !== 'deleting-chats') return;
    chatsRun++;
    backButton(false);
    // Back where Delete account is.
    return showHome({ tab: 'settings' });
  }

  /** Whether runDeletion is under way. */
  let deletionRunning = false;
  /** Counts runs of runDeletion; another copy changing the account ends the one under way. */
  let deletionRun = 0;

  /**
   * Whether this device still holds accountId, and the user's confirmed
   * record of deleting it. Another copy of the app may have finished the
   * deletion and set up a new account meanwhile: nothing of that one is
   * deleted, here or on the server.
   */
  async function stillDeleting(accountId: string): Promise<boolean> {
    const account = await readAccount(deps.db);
    return isSetUp(account) && account.accountId === accountId && (await deletionConfirmed());
  }

  /**
   * Deletes the account, or carries on deleting it, as the user confirmed
   * (deleteAccount, or a launch with the record of it): first the uploads of
   * the attachments this device received (best effort; any it can't delete,
   * or never sees, expire within 30 days), then everything the server holds
   * for the account (DELETE /account, signed), then everything on this
   * device. A deletion just confirmed (first) fetches the messages still
   * waiting for this device before that, so their uploads go too. Nothing
   * more of this starts after PREPARE_MS. The other side of each
   * conversation isn't told: their messages go nowhere, like to any unknown
   * mailbox. Nothing else is asked of the server once the deletion has
   * started: it takes no other request from an account being deleted
   * (uploads are deleted by their own secrets, without logging in).
   *
   * Only for the account it started with: before each request and before
   * wiping anything, it checks that this device still holds that account
   * and the record of deleting it (stillDeleting), and each request, its
   * retries included, is bound to it (session.call's account): if not
   * (another copy finished and set up again), it stops and looks again
   * (start).
   *
   * At most STEPS_PER_RUN steps, or RUN_FOR_MS: past that it shows its
   * error screen (Try again, the chats, or deleting here only), so a server
   * that keeps answering "more" can't keep the user waiting. A busy server
   * (503, 429) is waited out within that.
   */
  async function runDeletion(first = false): Promise<void> {
    screen.value = { kind: 'deleting', error: null };
    backButton(false);
    if (deletionRunning || !session) return;
    const account = await readAccount(deps.db);
    if (!isSetUp(account) || !(await deletionConfirmed())) return start();
    const target = account.accountId;
    const run = ++deletionRun;
    deletionRunning = true;
    deletionPaused = false;
    readOnly.value = false;
    const still = async () => run === deletionRun && (await stillDeleting(target));
    const pause = deps.stepPauseMs ?? DELETE_STEP_PAUSE_MS;
    const until = Date.now() + RUN_FOR_MS;
    const prepareUntil = Date.now() + PREPARE_MS;
    let steps = 0;
    let finished = false;
    // Why the last step had to wait, if it did: said if the run stalls.
    let waited: unknown = null;
    try {
      // Also when carrying on at a launch, which starts no messaging.
      await createEngine();
      if (messaging) {
        // The messages still waiting for this device, so their attachments'
        // uploads are deleted below too: only before the first DELETE
        // /account, which the server takes no other request after, and only
        // for the account this deletes (another copy may have finished and
        // set up another meanwhile).
        if (first && (await still())) {
          try {
            await messaging.sync({ until: prepareUntil });
          } catch {
            // Best effort: theirs expire on their own within 30 days.
          }
        }
        for (const c of await listConversations(deps.db)) {
          try {
            await messaging.discardUploads(await attachmentsOf(deps.db, await listRecords(deps.db, c.id)));
          } catch {
            // They expire on their own within 30 days.
          }
        }
        // Done before the device is wiped, which takes the list with it.
        // Those the server couldn't take then are tried again a few times,
        // waiting longer each time, while there's time (PREPARE_MS) and the
        // device isn't offline; any left expire within 30 days.
        await messaging.flushUploadDeletes();
        for (const times of UPLOAD_DELETE_RETRIES) {
          if ((await pendingUploadDeletes(deps.db)).length === 0 || !(await still())) break;
          const wait = times * pause;
          if (Date.now() + wait >= prepareUntil || offline()) break;
          await new Promise((resolve) => setTimeout(resolve, wait));
          await messaging.flushUploadDeletes();
        }
      }
      stopMessaging();
      // In steps: the server answers in_progress until everything is gone
      // (the biggest accounts take a few minutes), and also when another
      // change interrupted the last step, or another step was running. A
      // pause between steps leaves the database's capacity to everyone else.
      while (await still()) {
        if (steps++ >= STEPS_PER_RUN || Date.now() > until) throw new DeletionStalled(waited);
        // Shown again each step: nothing else is, until it's done.
        screen.value = { kind: 'deleting', error: null };
        try {
          await session.call('DELETE', '/account', undefined, checkObject, { sign: true, account: target });
          finished = true;
          break;
        } catch (err) {
          const wait = stepWait(err, pause);
          if (wait === null) throw err;
          waited = err;
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
    } catch (err) {
      // A run another copy's change ended, or one whose account this device
      // no longer holds: its error isn't for whatever is here now.
      if (run !== deletionRun) return;
      const ours = !(err instanceof AccountChanged) && (await stillDeleting(target));
      // Refused as a device that no longer exists: an earlier step finished
      // it, and its answer was lost. Or replaced: set up again elsewhere,
      // which replaced it without asking, since it was being deleted. Done
      // either way; the user asked for the rest, for this account.
      if (ours && err instanceof ApiError && (err.code === 'login_refused' || err.code === 'account_replaced')) finished = true;
      // Otherwise the error screen, unless the device holds another account
      // now (start() below looks again).
      else if (ours) {
        deletionRunning = false;
        if (handleGone(err)) return;
        // Stalled while the server refused this device's steps for now: that.
        const limited = deviceLimit(err instanceof DeletionStalled ? err.last : err);
        showDeletionError(err instanceof NetworkError ? 'network' : (limited ?? 'generic'));
        return;
      }
    }
    if (run !== deletionRun) return; // Ended by another copy's change, which looks again itself.
    deletionRunning = false;
    if (finished) return finishDeletion(target);
    return start();
  }

  /**
   * The account the user confirmed deleting is gone from the server (or,
   * here only, the user chose to delete it from this device only):
   * everything on this device goes too. Only after the typed confirmation
   * (deleteAccount), never on the server's word alone, and only while this
   * device still holds that account and the record of it (stillDeleting).
   */
  async function finishDeletion(accountId: string, hereOnly = false): Promise<void> {
    if (!(await stillDeleting(accountId))) return start();
    stopMessaging();
    await wipe(deps.db);
    signedOut = null;
    deletionPaused = false;
    readOnly.value = false;
    deps.broadcast({ type: 'account-changed' });
    backButton(false);
    screen.value = hereOnly ? { kind: 'welcome', mismatch: false, deletedHere: true } : { kind: 'welcome', mismatch: false, deleted: true };
  }

  /**
   * On the deleting screen, when the server keeps failing: everything on
   * this device goes now, as the user confirmed. What the server holds stays,
   * marked and unused, until the user sets up again (which ends it).
   */
  async function deleteHereOnly(): Promise<void> {
    const account = await readAccount(deps.db);
    if (deletionRunning || !isSetUp(account) || currentScreen().kind !== 'deleting') return;
    return finishDeletion(account.accountId, true);
  }

  /** The deleting screen's error (it kept failing), shown again by Cancel from the confirmation. */
  let deletionError: ErrorKind = 'generic';
  function showDeletionError(error: ErrorKind): void {
    deletionError = error;
    screen.value = { kind: 'deleting', error };
  }

  /**
   * The user's deletion couldn't finish, and they chose to read their chats
   * meanwhile (readDuringDeletion): read-only, like signed out, but no
   * refusal of the server's, so not signedOut (whose screens say the
   * deletion wasn't started here). Try again there, or the next launch,
   * carries on with the deletion.
   */
  let deletionPaused = false;

  /** On the deleting screen, when the server keeps failing: the chats, read only. */
  function readDuringDeletion(): Promise<void> {
    deletionPaused = true;
    readOnly.value = true;
    return showHome({ tab: 'chats' });
  }

  /**
   * The server says the account is being deleted. If the user confirmed that
   * here (on this device, maybe in another copy of the app), it carries on.
   * Otherwise it isn't taken on trust (a server could say so to anyone): the
   * chats stay, readable, as when signed out (remembered, so a launch that
   * can't reach the server shows the same), and the user can finish the
   * deletion, after the same typed confirmation, or ask again. Nothing on
   * the device is deleted for it. Signed out at once, so nothing else starts
   * meanwhile.
   *
   * expired: the server says its expiry is deleting it (nobody used it for
   * 12 months), and the app says that. Undefined when the server didn't say
   * why (another request's account_deleting): GET /account, which an
   * account being deleted is still answered on, says; failing that, what it
   * said before stays.
   */
  function deletingOnServer(expired?: boolean): void {
    if (deletionRunning) return;
    showSignedOut((expired ?? signedOut === 'expired') ? 'expired' : 'deleting');
    void (async () => {
      if (await deletionConfirmed()) {
        signedOut = null;
        readOnly.value = false;
        return runDeletion();
      }
      const account = await readAccount(deps.db);
      if (!isSetUp(account)) return;
      const why = expired ?? (await whyDeleting());
      await markDeletingElsewhere(deps.db, account.accountId, why);
      if (why ?? account.expired) becomeExpired();
    })();
  }

  /** Whether the server's expiry is what deletes the account (GET /account); undefined if it can't be asked. */
  async function whyDeleting(): Promise<boolean | undefined> {
    try {
      const info = await session!.call('GET', '/account', undefined, checkAccountInfo);
      return info.deleting ? info.expired : undefined;
    } catch {
      return undefined;
    }
  }

  /** Signed out as being deleted, learnt to be the expiry's: says so, on the screen that shows it. */
  function becomeExpired(): void {
    if (signedOut !== 'deleting') return;
    const current = currentScreen();
    if (current.kind === 'signed-out') showSignedOut('expired', current.offline);
    else signedOut = 'expired';
  }

  /** The cleanup under way (cleanUpReplaced). */
  let cleaning: Promise<void> | null = null;

  /**
   * Asks the server, in the background, to delete what is left of the
   * account this one replaced (setting up here ended one elsewhere), in
   * steps, until it says nothing is (POST /account/cleanup answers
   * in_progress until then). The old account ended at once; this only frees
   * what it held. GET /account says whether anything is left, so the next
   * launch carries on if this one stops (closed, offline).
   */
  function cleanUpReplaced(): Promise<void> {
    cleaning ??= (async () => {
      try {
        const account = await readAccount(deps.db);
        if (!isSetUp(account)) return;
        const pause = deps.stepPauseMs ?? DELETE_STEP_PAUSE_MS;
        const until = Date.now() + RUN_FOR_MS;
        for (let step = 0; step < STEPS_PER_RUN && Date.now() <= until; step++) {
          try {
            await session!.call('POST', '/account/cleanup', undefined, checkObject, { sign: true, account: account.accountId });
            return;
          } catch (err) {
            // A busy server is waited out too; anything else (offline, another
            // account set up meanwhile) stops it until the next launch.
            const wait = stepWait(err, pause);
            if (wait === null) return;
            await new Promise((resolve) => setTimeout(resolve, wait));
          }
        }
      } finally {
        cleaning = null;
      }
    })();
    return cleaning;
  }

  /**
   * Shows that the server no longer takes this device (a replaced account
   * loudly), keeping its chats. Returns whether err said so.
   */
  function handleGone(err: unknown): boolean {
    if (!(err instanceof ApiError)) return false;
    if (err.code === 'account_replaced') showSignedOut('replaced');
    // An account the expiry was deleting, now gone, was deleted.
    else if (err.code === 'login_refused') showSignedOut(signedOut === 'replaced' || signedOut === 'expired' ? signedOut : 'refused');
    // Not taken on trust: the chats stay, and the user may finish it.
    else if (err.code === 'account_deleting') deletingOnServer();
    else if (clock.tooFar(err)) showClockOff(() => start());
    else return false;
    return true;
  }

  /** The account's links, as the home screen shows them. */
  async function linkViews(): Promise<LinkView[]> {
    return (await listLinks(deps.db)).map((l) => ({ ...l, url: linkUrl(deps.config!.botUsername, l) }));
  }

  // The attachments on this device (bytes), for the Settings tab: measured
  // when it shows and redraws (it reads every message), the latest
  // measurement winning.
  let mediaBytes: number | null = null;
  let mediaRuns = 0;
  async function measureMedia(): Promise<void> {
    const run = ++mediaRuns;
    const total = (await mediaUsage(deps.db)).total;
    if (run !== mediaRuns) return;
    mediaBytes = total;
    const current = screen.value;
    if (current.kind === 'home' && current.tab === 'settings') screen.value = { ...current, media: total };
  }

  /** Where a screen is, to tell whether it's still there: its kind, and for a chat, which one (drawn again, it's the same place). */
  function placeOf(s: Screen): string {
    return s.kind === 'conversation' ? `conversation:${s.id}` : s.kind;
  }

  /**
   * Draws home. overHome: a tab switch, drawn only if home is still on screen
   * (not over a chat opened meanwhile). over: Telegram's Settings item, drawn
   * only if the screen it was pressed on (placeOf) still is.
   */
  async function showHome(options: { offline?: boolean; notice?: HomeNotice | null; tab?: HomeTab; overHome?: boolean; over?: string } = {}): Promise<void> {
    const actions = homeActions;
    const ask = ++homeAsks;
    const shownTab = options.tab ?? tab;
    const { config, db } = deps;
    // Signed out, the chats are only read: the server isn't asked.
    let offline = (options.offline ?? false) || signedOut !== null || deletionPaused;
    let notice = options.notice ?? null;
    let limited: DeviceLimit | null = null;
    let account: AccountInfo | null = null;
    let invitations: InvitationsInfo | null = null;
    if (!offline) {
      // Apart: the invitations failing alone leaves the account shown, and
      // home online, without its invitations section.
      const [a, i] = await Promise.allSettled([
        session!.call('GET', '/account', undefined, checkAccountInfo),
        session!.call('GET', '/invitations', undefined, checkInvitations),
      ]);
      for (const r of [a, i]) if (r.status === 'rejected' && handleGone(r.reason)) return;
      if (a.status === 'fulfilled') account = a.value;
      else {
        offline = true;
        // Refused for now (any of the device's requests are, past its
        // limit): said as the notice, unless what brought the user here
        // says something, and then in place of "offline".
        limited = deviceLimit(a.reason);
        notice ??= limited;
      }
      if (i.status === 'fulfilled') invitations = i.value;
      else notice ??= deviceLimit(i.reason);
    }
    if (account?.deleting) return deletingOnServer(account.expired);
    if (account?.cleanup) void cleanUpReplaced();
    // Read from here on: a refresh that read before draws nothing over it.
    homeDraws++;
    const links = await linkViews();
    const drawn = {
      kind: 'home' as const,
      tab: shownTab,
      conversations: await conversations(),
      offline,
      limited,
      account,
      invitations,
      links,
      busy: false,
      notice: withNewKey(notice, await newKeyToTell(db)),
      // Offered while the bot may not write yet, and after Telegram refused
      // a notice: then only the user's tap sets them up again.
      askNotices: noticeLaunch && !!account && !account.notices && (!writeAllowed || account.noticesRefused),
      blockedCount: (await listConversations(db)).filter((c) => c.status === 'blocked').length,
      signedOut,
      deletionPaused,
      // Last measured (null the first time): measured again below, without holding the tab up.
      media: shownTab === 'settings' ? mediaBytes : null,
    };
    // Dropped if a newer showHome began meanwhile, or an action on home (it
    // draws home itself once done, or the screen its end calls for); or, a
    // tab switch, if home has left the screen (a chat opened, say); or,
    // Telegram's Settings item, if the screen it was pressed on has.
    const moved = (options.overHome && screen.value.kind !== 'home') || (options.over !== undefined && placeOf(screen.value) !== options.over);
    if (ask !== homeAsks || actions !== homeActions || moved) {
      // Its homeDraws++ may have dropped a refresh's draw: read again.
      void refresh();
      return;
    }
    tab = drawn.tab;
    backButton(false);
    screen.value = drawn;
    if (tab === 'settings') void measureMedia();
    if (screen.value.kind === 'home' && screen.value.notice === 'new-signing-key') await toldNewKey(db);
    // By itself only if Telegram never refused one (never set up, or a new
    // chat key): a block holds until the user taps Turn on notices.
    if (account && !account.notices && !account.noticesRefused && writeAllowed && !noticesTried) void setUpNotices();
    // While they're on, notices follow Telegram's language: the server picks
    // it from the launch data the same way the app does (shared vectors),
    // and keeps it only once set up, so a language the app gained since, or
    // a change in Telegram, needs telling. Never the language chosen in the
    // app, nor the browser's, which stay on this device.
    const telegramLanguage = deps.launch.userLanguage;
    if (account?.notices && account.noticeLanguage !== undefined && telegramLanguage !== '' && pickLanguage(telegramLanguage) !== account.noticeLanguage && !noticeLanguageTried) {
      void changeNoticeLanguage();
    }
  }

  /**
   * Asks the server to send notices in Telegram's language, from this
   * launch's data: a plain launch only, as for setting them up. Failures
   * are left alone: the next launch tries again.
   */
  async function changeNoticeLanguage(): Promise<void> {
    if (!noticeLaunch || !session) return;
    noticeLanguageTried = true;
    try {
      await session.call('POST', '/notices/language', { initData: deps.launch.initData }, checkObject);
    } catch {
      return;
    }
  }

  /**
   * Turns on Telegram notices for this account. Failures are left alone:
   * while the account says they're off, a later launch tries again, or,
   * after a refusal, offers to again.
   */
  async function setUpNotices(): Promise<void> {
    if (!noticeLaunch || !session) return;
    noticesTried = true;
    try {
      await session.call('POST', '/notices', { initData: deps.launch.initData }, checkObject);
    } catch {
      return;
    }
    const current = screen.value;
    if (current.kind === 'home' && current.account) {
      screen.value = { ...current, account: { ...current.account, notices: true, noticesRefused: false }, askNotices: false };
    }
  }

  /** Joins with an invitation code (typed, pasted, or from an invitation link). */
  async function redeem(input: string): Promise<void> {
    const current = screen.value;
    if ((current.kind === 'invitation' || current.kind === 'home') && current.busy) return;
    const code = normalizeCode(input);
    if (!code) return showHome({ notice: 'invalid-invitation' });
    if (current.kind === 'home') homeActions++;
    if (current.kind === 'home') screen.value = { ...current, busy: true, notice: null };
    if (current.kind === 'invitation') screen.value = { ...current, busy: true, error: null };
    let notice: HomeNotice = 'joined';
    try {
      await session!.call('POST', '/invitations/redeem', { code }, checkRedeemed);
    } catch (err) {
      if (handleGone(err)) return;
      if (err instanceof ApiError && err.code === 'invalid_invitation') notice = 'invalid-invitation';
      else if (err instanceof ApiError && err.code === 'already_member') notice = 'already-member';
      else if (err instanceof ApiError && err.code === 'own_invitation') notice = 'own-invitation';
      else if (err instanceof ApiError && err.code === 'rate_limited') notice = 'rate-limited';
      else notice = deviceLimit(err) ?? (err instanceof NetworkError ? 'network' : 'generic');
    }
    // From an invitation link, what can be tried again keeps its Join button.
    if (current.kind === 'invitation' && (notice === 'network' || notice === 'device-limit' || notice === 'device-limit-later' || notice === 'generic')) {
      screen.value = { ...current, busy: false, error: notice };
      return;
    }
    return showHome({ notice });
  }

  /**
   * The Invitations screen, read afresh. made: the code just made (and its
   * uses), shown even if the list can't be read again now, so it isn't
   * made twice.
   */
  async function openInvitations(notice: InvitationsNotice | null = null, made: { code: string; uses: number } | null = null): Promise<void> {
    const { config } = deps;
    const url = (code: string) => invitationUrl(config!.botUsername, code);
    const created = made?.code ?? null;
    let info: InvitationsInfo;
    try {
      info = await session!.call('GET', '/invitations', undefined, checkInvitations);
    } catch (err) {
      if (handleGone(err)) return;
      const current = screen.value;
      if (made && current.kind === 'invitations') {
        const left = current.info.unlimited ? current.info.maxUses : Math.max(0, current.info.maxUses - made.uses);
        const codes = [...current.info.codes, { code: made.code, uses: made.uses, left: made.uses, url: url(made.code) }].sort((a, b) => a.code.localeCompare(b.code));
        screen.value = { ...current, info: { ...current.info, codes, maxUses: left, remaining: current.info.unlimited ? current.info.remaining : left }, busy: false, notice, created };
        return;
      }
      // A login refused for now refuses this reload too (the session waits).
      return showHome({ notice: deviceLimit(err) ?? (err instanceof NetworkError ? 'network' : 'generic') });
    }
    const codes = info.codes.map((c) => ({ ...c, url: url(c.code) }));
    backButton(true);
    screen.value = { kind: 'invitations', info: { ...info, codes }, busy: false, notice, created };
  }

  async function createInvitation(uses: number): Promise<void> {
    const current = screen.value;
    if (current.kind !== 'invitations' || current.busy) return;
    screen.value = { ...current, busy: true, notice: null };
    try {
      const code = await session!.call('POST', '/invitations', { uses }, checkCreated, { sign: true });
      return openInvitations('created', { code, uses });
    } catch (err) {
      if (handleGone(err)) return;
      const notice: InvitationsNotice =
        err instanceof ApiError && err.code === 'no_invitations_left'
          ? 'none-left'
          : (deviceLimit(err) ?? (err instanceof NetworkError ? 'network' : 'generic'));
      return openInvitations(notice);
    }
  }

  /**
   * The admin screen, read afresh. done: what a change just done makes of
   * the screen as it was, for when it can't be read again now.
   */
  async function openAdmin(notice: AdminNotice | null = null, done: (s: AdminScreen) => AdminScreen = (s) => s): Promise<void> {
    let levels: LevelAllowance[];
    try {
      levels = await session!.call('GET', '/admin/levels', undefined, checkLevels);
    } catch (err) {
      if (handleGone(err)) return;
      // Done, but the screen can't be read again now: it stays, with the
      // change in it, saying it was done, so it isn't done twice (a grant
      // would be).
      const current = screen.value;
      if ((notice === 'saved' || notice === 'granted' || notice === 'switched') && current.kind === 'admin') {
        screen.value = done({ ...current, busy: false, notice });
        return;
      }
      // A login refused for now refuses this reload too (the session waits).
      return showHome({ notice: deviceLimit(err) ?? (err instanceof NetworkError ? 'network' : 'generic') });
    }
    // The rest of the screen still works if these can't be read.
    let switches: Switches | null = null;
    try {
      switches = await session!.call('GET', '/admin/switches', undefined, checkSwitches);
    } catch (err) {
      if (handleGone(err)) return;
    }
    backButton(true);
    screen.value = { kind: 'admin', levels, switches, busy: false, notice };
  }

  /**
   * Pauses or resumes uploads or downloads of attachments for everyone (the
   * emergency switches), after a confirmation in the UI. Every server
   * follows within about half a minute.
   */
  function setSwitch(which: Switch, paused: boolean): Promise<void> {
    return adminAction(
      () => session!.call('PUT', '/admin/switches', { switch: which, paused }, checkSwitches, { sign: true }),
      'switched',
      (s, switches) => ({ ...s, switches }),
    );
  }

  /** Sets a level's invitation allowance. */
  function setLevel(level: number, invitations: number): Promise<void> {
    return adminAction(
      () => session!.call('PUT', '/admin/levels', { level, invitations }, checkObject, { sign: true }),
      'saved',
      (s) => ({ ...s, levels: [...s.levels.filter((l) => l.level !== level), { level, invitations }].sort((a, b) => a.level - b.level) }),
    );
  }

  /**
   * Runs an admin change, then shows the admin screen again with its
   * outcome. apply: what the change makes of the screen, if it can't be
   * read again now.
   */
  async function adminAction<T>(action: () => Promise<T>, done: AdminNotice, apply: (s: AdminScreen, result: T) => AdminScreen = (s) => s): Promise<void> {
    const current = screen.value;
    if (current.kind !== 'admin' || current.busy) return;
    screen.value = { ...current, busy: true, notice: null };
    let notice: AdminNotice = done;
    let changed: (s: AdminScreen) => AdminScreen = (s) => s;
    try {
      const result = await action();
      changed = (s) => apply(s, result);
    } catch (err) {
      if (handleGone(err)) return;
      if (err instanceof ApiError && err.code === 'not_member') notice = 'not-member';
      else if (err instanceof ApiError && err.code === 'not_found') notice = 'not-found';
      else notice = deviceLimit(err) ?? (err instanceof NetworkError ? 'network' : 'generic');
    }
    return openAdmin(notice, changed);
  }

  /** Grants a member extra invitations, naming them by one of their links. */
  function grant(linkText: string, invitations: number): Promise<void> {
    const ref = parsePayload(startParamOf(linkText));
    if (!ref) {
      const current = screen.value;
      if (current.kind === 'admin') screen.value = { ...current, notice: 'bad-link' };
      return Promise.resolve();
    }
    return adminAction(() => session!.call('POST', '/admin/grant', { link: ref.id, invitations }, checkObject, { sign: true }), 'granted');
  }

  /**
   * Runs a link action from the home screen, then shows home again with its
   * outcome (a new signing key the link got wins over a routine one:
   * showHome).
   */
  async function linkAction(action: () => Promise<unknown>, done: HomeNotice): Promise<void> {
    const current = screen.value;
    if (current.kind !== 'home' || current.busy) return;
    homeActions++;
    screen.value = { ...current, busy: true, notice: null };
    let notice: HomeNotice = done;
    try {
      await action();
    } catch (err) {
      if (handleGone(err)) return;
      if (err instanceof ApiError && err.code === 'invitation_required') notice = 'invitation';
      else if (err instanceof ApiError && err.code === 'link_limit') notice = 'limit';
      else if (err instanceof ApiError && err.code === 'rate_limited') notice = 'rate-limited';
      else notice = deviceLimit(err) ?? (err instanceof NetworkError ? 'network' : 'generic');
    }
    deps.broadcast({ type: 'data-changed' });
    return showHome({ notice, tab: 'links' });
  }

  /** Checks someone's link: its bundle must match the fingerprint in the link. */
  async function openLink(ref: LinkRef): Promise<void> {
    const linkScreen = (status: Exclude<LinkStatus, 'existing'>) => ({ kind: 'link' as const, status, canWrite: false, busy: false, error: null });
    screen.value = linkScreen('checking');
    openedLink = null;
    // Our link, or one it replaced (the same fingerprint).
    const own = (await listLinks(deps.db)).some((l) => l.id === ref.id || l.fingerprint === ref.fingerprint);
    // Already writing to this person: offer that conversation. A new one
    // would gain nothing, since the owner sees the same sender tag and label.
    // Through a replaced link, only once they've answered: before that, it
    // still writes to the old link's mailbox, which is gone.
    // Not opened by itself: opening sends "seen", so the link's owner could
    // send someone their link and watch whether their messages turn seen.
    const existing = (await listConversations(deps.db)).find(
      (c) =>
        c.role === 'sender' &&
        c.status !== 'blocked' &&
        c.link.fingerprint === ref.fingerprint &&
        (c.link.id === ref.id || c.lastReceived !== null),
    );
    // Checked the same way whatever the link turns out to be, so the server
    // can't tell our own link, or one we already write to, from a new one.
    let status: Exclude<LinkStatus, 'existing'> = 'verified';
    let bundle: Bundle | null = null;
    try {
      bundle = await deps.api!.request('GET', `/links/${ref.id}`, {}, checkBundle);
      await verifyBundle(ref, bundle, Math.floor(Date.now() / 1000));
    } catch (err) {
      status = 'network';
      if (err instanceof ApiError && err.code === 'not_found') status = 'not-found';
      else if (err instanceof BundleMismatch) status = 'mismatch';
    }
    if (own) {
      screen.value = linkScreen('own');
      return;
    }
    // The chat goes on without the link (replaced, or out of reach just
    // now), but keys that don't match it are worth a warning.
    if (existing && status !== 'mismatch') {
      screen.value = { kind: 'link', status: 'existing', canWrite: false, busy: false, error: null, chat: existing.id };
      return;
    }
    if (status === 'verified' && bundle) {
      openedLink = { ref, bundle };
      screen.value = { ...linkScreen('verified'), canWrite: messaging !== null };
      return;
    }
    screen.value = linkScreen(status);
    if (status === 'network') retry = () => openLink(ref);
  }

  /** Creates the keys (or reuses a pending setup) and asks Telegram to reopen as the registration launch. */
  async function setUp(options: { restart?: boolean } = {}): Promise<void> {
    const { config, bridge, db } = deps;
    if (!config || !bridge) return;
    const code = await prepareSetup(db, options);
    screen.value = { kind: 'reopening' };
    bridge.post('web_app_open_tg_link', { path_full: registrationPath(config.botUsername, code) });
    // The new launch is a second copy of the app; this one steps aside.
    setTimeout(() => bridge.post('web_app_close'), deps.closeDelayMs ?? CLOSE_DELAY_MS);
  }

  async function runRegister(replace: boolean): Promise<void> {
    screen.value = replace ? { kind: 'confirm-replace', busy: true } : { kind: 'registering' };
    try {
      session!.use(await register(deps.db, deps.api!, deps.launch, { replace, clock }));
    } catch (err) {
      if (err instanceof SetupMismatch) screen.value = { kind: 'welcome', mismatch: true };
      else if (err instanceof ApiError && err.code === 'account_exists') {
        // Set up on another device: say so, unless starting over was chosen already.
        const chosen = (await getMeta<unknown>(deps.db, META_START_OVER)) === true;
        await deleteMeta(deps.db, META_START_OVER);
        screen.value = chosen ? { kind: 'confirm-replace', busy: false } : { kind: 'elsewhere' };
      }
      // The launch data is only accepted for 10 minutes: reopen for a fresh one.
      else if (err instanceof ApiError && err.code === 'init_data_rejected') fail('expired', () => setUp());
      else if (err instanceof ApiError && err.code === 'rate_limited') fail('rate-limited', () => runRegister(replace));
      else if (clock.tooFar(err)) showClockOff(() => runRegister(replace));
      else if (err instanceof NetworkError) fail('network', () => runRegister(replace));
      else fail('generic', () => runRegister(replace));
      return;
    }
    deps.broadcast({ type: 'account-changed' });
    if (!deps.launch.allowsWriteToPm) deps.bridge?.post('web_app_request_write_access');
    await startMessaging(true);
    // The first sync found the server no longer takes this device: that
    // screen stays.
    if (signedOut) return;
    // A link or invitation opened before setup: continue there.
    launchParam = null;
    return continueLaunch(false);
  }

  return {
    screen,
    start,
    /** Another copy changed the account (finished setting up, say): catch up. A login refused in the next few seconds is tried once more. */
    accountChanged(): Promise<void> {
      // A deletion under way here stops: the account it was for may be gone
      // (another copy finished it) or another set up. start() looks again.
      deletionRun++;
      deletionRunning = false;
      deletionPaused = false;
      // Measured again for the account there is now.
      mediaBytes = null;
      mediaRuns++;
      session?.setUp();
      return start();
    },
    /** Another copy deleted keys whose time had come: the unsealed copies kept here go too. */
    keysChanged: () => messaging?.forgetKeys(),
    setUp: () => setUp(),
    /** Asks the server again whether it takes this device. */
    recheck,
    /** Whether the chats are read-only (signed out): nothing is sent or downloaded. */
    readOnly,
    /** While signed out: the chats, read-only. */
    readChats: () => showHome({ tab: 'chats' }),
    /** Asks to set up again while signed out (a typed confirmation follows: it deletes everything here). */
    askReset: () => {
      if (signedOut) screen.value = { kind: 'confirm-reset', reason: signedOut };
    },
    /** Sets up again, deleting everything on this device: from the typed confirmation only. */
    confirmReset: async () => {
      if (currentScreen().kind === 'confirm-reset') return setUp({ restart: true });
    },
    cancelReset: () => {
      if (signedOut) screen.value = { kind: 'signed-out', reason: signedOut, busy: false, offline: false };
    },
    confirmReplace: () => runRegister(true),
    cancelReplace: () => {
      screen.value = { kind: 'elsewhere' };
    },
    startOver,
    /** Asks to delete the account (a typed confirmation follows). */
    askDeleteAccount: () => {
      backButton(true);
      // Finishing one the server says is under way: no sends (deleteAccount).
      screen.value = { kind: 'confirm-delete', busy: false, error: null, ...(signedOut !== null || deletionPaused ? { finishing: true as const } : {}) };
    },
    /** Deletes the account, as typed; forBoth: its chats for both sides first, as ticked. */
    deleteAccount,
    /** Stopped deleting the chats for both sides: Try again, with those still in the list. */
    retryDeletingChats: async () => {
      const stopped = stoppedChats();
      if (stopped && canRetryChats(stopped.reason)) return deleteChatsForBoth(stopped.accountId);
    },
    /** Stopped deleting the chats for both sides: deletes the account anyway; the rest stay with the other side. */
    deleteAccountAnyway: async () => {
      const stopped = stoppedChats();
      if (!stopped) return;
      // Once: a second tap finds the deletion's screen.
      chatsRun++;
      backButton(false);
      screen.value = { kind: 'deleting', error: null };
      return confirmDeletion(stopped.accountId);
    },
    /** While deleting the chats for both sides (Cancel), or once it stopped: ends it and keeps the account. */
    keepAccount,
    /** Try again, on the deleting screen: carries on with the deletion. */
    continueDeletion: () => runDeletion(),
    /** On the deleting screen, when the server keeps failing: the chats, read only. */
    readDuringDeletion,
    /** On the deleting screen, when the server keeps failing: everything on this device goes, as confirmed. */
    deleteHereOnly,
    cancelDeleteAccount: async () => {
      backButton(false);
      // Back to the deletion the user confirmed, if one couldn't finish; or
      // to where Finish deleting was asked, while signed out.
      if (await deletionConfirmed()) screen.value = { kind: 'deleting', error: deletionError };
      else if (signedOut) screen.value = { kind: 'signed-out', reason: signedOut, busy: false, offline: false };
      // Back where Delete account is.
      else return showHome({ tab: 'settings' });
    },
    close: () => deps.bridge?.post('web_app_close'),
    retry: () => retry(),
    /** The time messages are dated by now (Unix ms): what a message's age, for editing, is counted from. */
    messageNow: () => clock.messageNow(),
    home: () => showHome(),
    /** The home screen on its Chats tab, whatever tab was open last: the way out of someone's link screen. */
    chats: () => showHome({ tab: 'chats' }),
    /** Scrolled to the top of the open chat: older messages (or all from the one with this ID, to jump to its quote). */
    loadOlder,
    /** The open conversation's newest messages are in view: tell the other side, while the user is using the app. */
    markSeen: () => {
      const current = currentScreen();
      if (current.kind === 'conversation' && attending) seen(current.id);
    },
    /**
     * The user touched the app. Returns whether it's the first touch since
     * the app was hidden or minimised (the screen then marks what's in view).
     */
    attend: () => {
      const first = !attending;
      attending = true;
      return first;
    },
    /** Asks Telegram to let the bot write; notices are set up once it may. */
    allowNotices: () => deps.bridge?.post('web_app_request_write_access'),
    deleteConversation,
    /** Deletes chats selected in the list: here, or for both sides (paced, deleting-selected), blocking them too if asked. */
    deleteChats,
    /** Stopped deleting selected chats for both sides: Try again, with the ones left. */
    retryDeletingSelected: async () => {
      const current = currentScreen();
      const left = selectedLeft;
      if (current.kind !== 'deleting-selected' || !current.stopped || left?.run !== selectedRun || !canRetryChats(current.stopped.reason)) return;
      return deleteSelectedForBoth(left.ids, left.alsoBlock);
    },
    /** While deleting selected chats for both sides (Cancel), or once it stopped (Stop): the rest stay with the other side. */
    stopDeletingSelected,
    rename,
    /** Whether this build can send and receive attachments. */
    media: !!deps.config?.media,
    sendMedia,
    resend,
    sendVoice,
    sendRound,
    /** Fetches an attachment on a tap. */
    fetchMedia: (m: MessageRef) => fetchMedia(m),
    saveMedia,
    mediaUrl,
    transfers,
    preparing,
    /**
     * Deletes one message from this device (the other side keeps theirs).
     * One of theirs stays deleted if it's delivered again.
     */
    deleteMessage: async (id: string) => {
      const current = screen.value;
      if (current.kind !== 'conversation' || !messaging) return;
      await messaging.deleteHere(current.id, id);
      deps.broadcast({ type: 'data-changed' });
      await showChat(current.id);
    },
    /**
     * Deletes one of our messages on both sides (their app deletes it too,
     * and its upload goes from the server). If it can't be sent, nothing is
     * deleted and the conversation says why.
     */
    deleteForEveryone: async (id: string) => {
      const current = screen.value;
      if (current.kind !== 'conversation' || !messaging) return;
      let error: SendError | null = null;
      try {
        await messaging.deleteForEveryone(current.id, id);
      } catch (err) {
        if (handleGone(err)) return;
        error = sendError(err);
      }
      deps.broadcast({ type: 'data-changed' });
      await showChat(current.id, { error });
    },
    /** Edits one of our messages (its text, or a caption); if it can't be sent, it stays as it was and the conversation says why. */
    editMessage: async (id: string, text: string) => {
      const current = screen.value;
      if (current.kind !== 'conversation' || !messaging) return;
      let error: SendError | null = null;
      try {
        await messaging.edit(current.id, id, text);
      } catch (err) {
        if (handleGone(err)) return;
        error = sendError(err);
      }
      deps.broadcast({ type: 'data-changed' });
      await showChat(current.id, { error });
    },
    blocked: () => showBlocked(),
    unblock,
    /**
     * While something is open on top of the screen (a viewer, menu, dialog or
     * panel), the back button closes it. Returns what to call once it's closed.
     */
    onBack: (close: () => void) => {
      onTop.push(close);
      showBack();
      return () => {
        const i = onTop.lastIndexOf(close);
        if (i >= 0) onTop.splice(i, 1);
        showBack();
      };
    },
    /** Starts looking up the source link, for when it's tapped (the home screen). */
    prepareSource: (): void => {
      if (deps.bridge) void lookUpSource();
    },
    /**
     * The running build's source code (AGPL-3.0, section 13), in the
     * device's browser: the repository and commit its signed manifest names
     * (platform/source). 'unknown' when the build has none to name, or it
     * couldn't be read; 'waiting' for a tap while another one still waits,
     * or one that waited while the app was hidden (it opens nothing).
     */
    openSource: async (): Promise<'opened' | 'unknown' | 'waiting'> => {
      if (!deps.bridge) return 'unknown';
      if (sourceOpening) return 'waiting';
      sourceOpening = true;
      const tapped = hides;
      let url: string | null;
      try {
        url = await lookUpSource();
      } finally {
        sourceOpening = false;
      }
      // Hidden while it waited: the tap no longer counts.
      if (tapped !== hides) return 'waiting';
      if (!url) return 'unknown';
      deps.bridge.post('web_app_open_link', { url });
      return 'opened';
    },
    /** Data and storage. */
    storage: () => showStorage(),
    /** Usage: today's limits. */
    usage: () => showUsage(),
    messagesLeft,
    setKeepMedia: (keep: KeepMedia) => changeMediaSettings((s) => ({ ...s, keep })),
    setAutoDownload: (kind: keyof MediaSettings['auto'], on: boolean) =>
      changeMediaSettings((s) => ({ ...s, auto: { ...s.auto, [kind]: on } })),
    clearMedia: (conv?: string) => clearStoredMedia(conv),
    /** Shows a native popup; resolves with the button pressed, or null. */
    popup: (params: { title?: string; message: string; buttons: PopupButton[] }) =>
      deps.bridge ? openPopup(deps.bridge, params) : Promise.resolve(null),
    haptic: () => deps.bridge?.post('web_app_trigger_haptic_feedback', { type: 'impact', impact_style: 'medium' }),
    /** Switches home's tab; not while home is busy (an action under way would draw over it, and a redraw would let it be asked twice). */
    showTab: (t: HomeTab): Promise<void> => {
      const current = screen.value;
      if (current.kind === 'home' && current.busy) return Promise.resolve();
      return showHome({ tab: t, overHome: true });
    },
    /** Choosing the app's language (from Settings). */
    language: (): void => {
      backButton(true);
      screen.value = { kind: 'language' };
    },
    sync: syncNow,
    /**
     * Another copy started a sync at `at` (paced: one the app asked for by
     * itself). One said to start later than a second from now (sent before
     * the clock was set back) is ignored: it would take every sync asked
     * for until then as answered.
     */
    syncStarted: (at: number, paced: boolean) => {
      if (at <= Date.now() + 1_000) syncPace.started(at, paced);
    },
    refresh,
    /** A tap on a chat. */
    openConversation: (id: string) => openConversation(id),
    sendMessage,
    react,
    block,
    writeToLink,
    createLink: () => linkAction(() => createLink(deps.db, session!, deps.api!), 'created'),
    /** Gives the account a new link in place of its current one. */
    replaceLink: () => linkAction(() => replaceLink(deps.db, session!, deps.api!), 'replaced'),
    revokeLink: (id: string) => linkAction(() => revokeLink(deps.db, session!, id), 'revoked'),
    /** Opens Telegram's share sheet for a link. */
    share: (url: string) => deps.bridge?.post('web_app_open_tg_link', { path_full: `/share/url?url=${encodeURIComponent(url)}` }),
    redeem,
    invitations: () => openInvitations(),
    createInvitation,
    admin: () => openAdmin(),
    setLevel,
    grant,
    setSwitch,
  };
}

export type App = ReturnType<typeof createApp>;

/** The start parameter in a pasted t.me link, or the text itself. */
function startParamOf(text: string): string {
  const trimmed = text.trim();
  try {
    return new URL(trimmed).searchParams.get('startapp') ?? '';
  } catch {
    return trimmed;
  }
}

/** Whether the typed confirmation matches the phrase, ignoring case and spacing. */
export function confirmationMatches(typed: string, phrase: string): boolean {
  // Forgiving of how a keyboard types it: spaces anywhere or none, a
  // zero-width non-joiner or a space or nothing between word parts, and the
  // Arabic kaf and yeh (ك ي ى) that Arabic layouts type for the Persian ک ی.
  // Direction marks (as around the phrase shown, if copied) don't count either.
  // The dotted and dotless i (İ I ı i) are one letter, and lowercasing
  // ignores the device's language (Turkish turns I into ı, Lithuanian Í
  // into i, a dot and an accent).
  const norm = (s: string) =>
    s
      .normalize('NFC')
      .replace(/[\s‌-‏⁦-⁩]+/g, '')
      .replace(/ك/g, 'ک')
      .replace(/[يى]/g, 'ی')
      .replace(/[İIı]/g, 'i')
      .toLowerCase();
  return norm(typed) !== '' && norm(typed) === norm(phrase);
}
