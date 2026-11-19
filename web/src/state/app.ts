// What the app shows, and the actions that move between screens. The UI only
// reads `screen` and calls actions; it never touches storage, crypto or the
// network itself.

import { signal } from '@preact/signals';
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
import { budgetLeft, countTokens, rememberLeft, type TokenIssuer, type TokenKind } from '../account/wallet';
import { checkUsage, usageView, type UsageView } from '../account/usage';
import { poolSize } from '../messaging/pool';
import { importIssuerKey } from '../crypto/blindrsa';
import { toBase64Url } from '../crypto/encoding';
import { createMessaging, isPaused, MailboxLimit, NoMailboxes, NoTokens, SyncFailed, type Messaging, type Outgoing } from '../messaging/engine';
import {
  attachmentsOf,
  clearMedia,
  getConversation,
  getMedia,
  getMessage,
  lastShown,
  listConversations,
  listRecords,
  mediaUsage,
  PAGE,
  pageMessages,
  pendingUploadDeletes,
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
import type { Launch } from '../platform/launch';
import { openPopup, type Bridge, type PopupButton } from '../platform/telegram';
import { deleteMeta, getMeta, putMeta, wipe, type Database } from '../storage/db';
import type { SyncEvent } from '../sync/locks';

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

/** Ends a deletion that took STEPS_PER_RUN steps, or RUN_FOR_MS, without finishing. */
class DeletionStalled extends Error {}

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

/** clock: the device's clock is too far off (more than two days) for the server's to be believed. */
export type ErrorKind = 'network' | 'expired' | 'rate-limited' | 'clock' | 'generic';

/**
 * Why the server no longer takes this device: it refused the login (the
 * device or its account is gone), or says the account was replaced, or is
 * being deleted when this app didn't start that here. Never checked, so
 * asked again at every launch; nothing is deleted for it (a deletion is
 * finished only after the typed confirmation).
 */
export type SignedOutReason = 'refused' | 'replaced' | 'deleting';

/** A short message on the home screen after an action. */
export type HomeNotice =
  | 'blocked'
  | 'unblocked'
  | 'deleted'
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
  | 'new-signing-key'
  | 'network'
  | 'generic';

/** Notices that say an action went as asked, which telling of a new link signing key takes the place of. */
const ROUTINE_NOTICES: ReadonlySet<HomeNotice> = new Set<HomeNotice>(['blocked', 'unblocked', 'deleted', 'replaced', 'created', 'revoked', 'joined']);

/** The home notice to show when the user is still to be told their link has a new signing key: that, unless an error is to be shown. */
function withNewKey(notice: HomeNotice | null, newKey: boolean): HomeNotice | null {
  return newKey && (notice === null || ROUTINE_NOTICES.has(notice)) ? 'new-signing-key' : notice;
}

export type InvitationsNotice = 'created' | 'none-left' | 'network' | 'generic';

/** What the Data and storage screen shows: attachments on this device, in bytes. */
export interface StorageUsage {
  media: number;
  /** Conversations holding attachments, largest first. */
  chats: { id: string; label: string; bytes: number }[];
  /** All the app's storage on this device (keys and history too), where the browser tells. */
  app: { usage: number; quota: number } | null;
}

export type AdminNotice = 'saved' | 'granted' | 'switched' | 'not-member' | 'not-found' | 'bad-link' | 'network' | 'generic';

/**
 * Why a message couldn't be sent. mailbox-limit: the account has as many
 * chats as it may (4,000), so no new one can be started or answered.
 * media-paused: the operator has paused attachments for now (also said
 * when a tapped download is refused for it). outdated: the server no longer
 * holds the issuer key this build names (it was replaced), so the app must
 * be opened again.
 */
export type SendError =
  | 'no-tokens'
  | 'no-mailboxes'
  | 'mailbox-limit'
  | 'rate-limited'
  | 'media-paused'
  | 'outdated'
  | 'network'
  | 'too-big'
  | 'unreadable'
  | 'generic';

/** A conversation in the list. */
export interface ConversationView {
  id: string;
  label: string;
  role: 'owner' | 'sender';
  unread: number;
  lastAt: number;
  status: 'active' | 'ended' | 'blocked';
  /** The latest message, if any (status: of one of ours, for its ticks). */
  last: { text: string; out: boolean; status?: MessageView['status']; media?: { t: string; n?: string; m?: string }; sticker?: Sticker } | null;
}

/** A message: its conversation (on this device) and its ID, which is unique only within that conversation. */
export type MessageRef = Pick<MessageView, 'conv' | 'id'>;

/** A key for one message on this device, e.g. for its transfer's progress. */
export function messageKey(m: MessageRef): string {
  return `${m.conv}/${m.id}`;
}

/** What a picked file is sent as (music is "audio"). */
export type SendAs = 'photo' | 'video' | 'gif' | 'audio' | 'file';

/** An attachment being prepared to send, shown before its message is stored. */
export interface Preparing {
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
export interface InvitationView extends InvitationCode {
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
  /** Deleting the account, after a typed confirmation. */
  | { kind: 'confirm-delete'; busy: boolean; error: ErrorKind | null }
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
      tab: 'chats' | 'links';
      conversations: ConversationView[];
      offline: boolean;
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
    }
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
  | { kind: 'invitation'; code: string; busy: boolean; error: 'network' | 'generic' | null }
  | {
      kind: 'conversation';
      id: string;
      label: string;
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
  | { kind: 'signed-out'; reason: SignedOutReason; busy: boolean; offline: boolean }
  /** Setting up again from there, which deletes everything on this device: a typed confirmation first. */
  | { kind: 'confirm-reset'; reason: SignedOutReason }
  | { kind: 'error'; error: ErrorKind };

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
}

/** How often an open app checks its inbox while it has no push socket. */
const POLL_MS = 20_000;
/** While a push socket is open, poll only every this many POLL_MS. */
const SOCKET_POLL_EVERY = 6;
/**
 * The longest the app's background syncs wait while the server is in
 * trouble (net/backoff): the first wait is up to POLL_MS, and each failure
 * in a row doubles it, up to this.
 */
const SYNC_BACKOFF_MAX_MS = 5 * 60_000;

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
    else void showHome();
  });
  let messaging: Messaging | null = null;
  let mediaSettings: MediaSettings = DEFAULT_MEDIA_SETTINGS;
  let tab: 'chats' | 'links' = 'chats';
  let backgroundStarted = false;
  // Stops the inbox poll and the push socket (the account was deleted).
  let stopBackground = (): void => {};
  /** Holds back the syncs the app asks for by itself (backgroundSync) while the server is in trouble. */
  const syncBackoff = createBackoff({ baseMs: POLL_MS, maxMs: SYNC_BACKOFF_MAX_MS });
  /** The one sync waiting for the backoff to end, for all asked for meanwhile. */
  let backoffTimer: ReturnType<typeof setTimeout> | undefined;
  /** Stops messaging and everything started for it: the poll, the socket, a sync waiting out a server's pause. */
  function stopMessaging(): void {
    stopBackground();
    clearTimeout(backoffTimer);
    backoffTimer = undefined;
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
  // is.
  const signedStart = new URLSearchParams(deps.launch.initData).get('start_param') ?? '';
  const noticeLaunch = deps.launch.initData !== '' && (signedStart === '' || isRegistrationLaunch(signedStart));
  let writeAllowed = deps.launch.allowsWriteToPm;
  let noticesTried = false;
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
      if (handleGone(err)) return;
      // Couldn't ask, with a deletion the user confirmed here: its own
      // screen (Try again, the chats, deleting here only), whatever the
      // server said before.
      if (deleting) return showDeletionError(err instanceof NetworkError ? 'network' : 'generic');
      // Couldn't ask: as the server last said, until it can be asked again.
      const last =
        signedOut ??
        (recorded?.state === 'replaced' ? 'replaced' : recorded?.state === 'refused' ? (recorded.deleting ? 'deleting' : 'refused') : null);
      if (last) return showSignedOut(last, true);
      // Offline or the server is down: the device still works on what it has.
      offline = true;
    }
    // Carried on before anything else is asked: the server takes no other
    // request from an account being deleted.
    if (deleting) return runDeletion();
    await startMessaging(!offline);
    // The first sync found the server no longer takes this device (its
    // account being deleted, say): that screen stays.
    if (signedOut) return;
    return continueLaunch(offline);
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

  /** The server no longer takes this device: say so, and keep its chats readable. */
  function showSignedOut(reason: SignedOutReason, offline = false): void {
    signedOut = reason;
    readOnly.value = true;
    stopMessaging();
    backButton(false);
    screen.value = { kind: 'signed-out', reason, busy: false, offline };
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
    // Without a usable issuer key the app still works, but can't send.
    if (!(await createEngine())) return;
    if (online) {
      await sync();
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
              void sync();
            },
          })
        : null;
    // Being shown is the user's doing: it syncs, backoff or not.
    const visibility = () => {
      socket?.setVisible(shown());
      if (shown()) void sync();
    };
    socket?.setVisible(shown());
    socket?.start();
    // With a socket open, polling is only a safety net.
    let ticks = 0;
    const poll = setInterval(() => {
      ticks++;
      if (shown() && (!socket?.connected || ticks % SOCKET_POLL_EVERY === 0)) backgroundSync();
    }, POLL_MS);
    document.addEventListener('visibilitychange', visibility);
    // Back online: whatever the backoff, sync now.
    const backOnline = () => {
      endWait();
      if (shown()) void sync();
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

  /** The sync under way, and whether another was asked for meanwhile: pushes, polls and showing the app ask often, so one runs and one waits, no more. */
  let syncing: Promise<void> | null = null;
  let syncAgain = false;

  /** Fetches new messages; refreshes the screen if any arrived. */
  function sync(): Promise<void> {
    if (syncing) {
      syncAgain = true;
      return syncing;
    }
    syncing = (async () => {
      try {
        do {
          syncAgain = false;
          await syncOnce();
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
   * A sync the app asks for by itself (the poll, a push, the end of a
   * pause): while the server is in trouble (syncBackoff), it waits, and all
   * asked for meanwhile become one when the wait ends.
   */
  function backgroundSync(): void {
    const wait = syncBackoff.remaining();
    if (wait === 0) {
      void sync();
      return;
    }
    // For when the wait ends now, which may be sooner than before (it
    // started over).
    clearTimeout(backoffTimer);
    backoffTimer = setTimeout(() => {
      backoffTimer = undefined;
      backgroundSync();
    }, wait);
  }

  /** Ends the wait. Returns whether a sync was waiting for it, which is then up to the caller. */
  function endWait(): boolean {
    syncBackoff.succeeded();
    if (backoffTimer === undefined) return false;
    clearTimeout(backoffTimer);
    backoffTimer = undefined;
    return true;
  }

  async function syncOnce(): Promise<void> {
    if (!messaging) return;
    let received = 0;
    try {
      received = await messaging.sync();
      // Through: what was waiting runs now.
      if (endWait()) syncAgain = true;
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

  /**
   * Redraws the current screen from storage (after new messages, or another
   * copy's change), as it is once read: a notice shown meanwhile stays.
   */
  async function refresh(): Promise<void> {
    const current = screen.value;
    if (current.kind === 'home' && !current.busy) {
      const [list, links, newKey] = [await conversations(), await linkViews(), await newKeyToTell(deps.db)];
      const latest = screen.value;
      if (latest.kind !== 'home' || latest.busy) return;
      const notice = withNewKey(latest.notice, newKey);
      screen.value = { ...latest, conversations: list, links, notice };
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
        label: c.label,
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
  ): Promise<{ messages: MessageView[]; more: boolean; quoted: MessageView[] }> {
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
    const here = new Set(page.messages.map((m) => m.id));
    const quoted: MessageView[] = [];
    for (const id of new Set(page.messages.flatMap((m) => (m.replyTo && !here.has(m.replyTo) ? [m.replyTo] : [])))) {
      const m = await getMessage(deps.db, conv, id);
      if (m) quoted.push(m);
    }
    return { ...page, quoted };
  }

  /**
   * Redraws the open chat from storage, if it's still `conv`, with these
   * changes: on the screen as it is once its messages are read, and with
   * the messages it shows then (older ones loaded meanwhile stay).
   */
  async function showChat(conv: string, changes: { error?: SendError | null } = {}): Promise<void> {
    for (let tries = 0; ; tries++) {
      const before = currentScreen();
      if (before.kind !== 'conversation' || before.id !== conv) return;
      const page = await chatPage(conv, before);
      const now = currentScreen();
      if (now.kind !== 'conversation' || now.id !== conv) return;
      // Shown otherwise meanwhile (older ones loaded, say): read again for that.
      if (now.messages !== before.messages && tries < 2) continue;
      screen.value = { ...now, ...changes, ...page };
      return;
    }
  }

  let loadingOlder = false;
  /**
   * Shows older messages in the open chat: PAGE more, or all from the one
   * with this ID on (a quote's, to jump to it). Returns whether any came.
   */
  async function loadOlder(until?: string): Promise<boolean> {
    const current = screen.value;
    if (current.kind !== 'conversation' || !current.more || loadingOlder) return false;
    loadingOlder = true;
    try {
      const page = await chatPage(current.id, current, until ?? true);
      const now = currentScreen();
      if (now.kind !== 'conversation' || now.id !== current.id) return false;
      screen.value = { ...now, ...page };
      // Their attachments shown now download as they would have when the chat opened.
      autoFetch(current.id);
      return page.messages[0]?.id !== now.messages[0]?.id;
    } finally {
      loadingOlder = false;
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
    if (current.kind !== 'conversation' || !messaging) return;
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
   * Deletes a conversation from this device (and first blocks it, if asked),
   * then shows the list.
   */
  /** Deletes a conversation from this device, and on theirs too if forBoth; then blocks them if asked. */
  async function deleteConversation(id: string, alsoBlock: boolean, forBoth = false): Promise<void> {
    if (!messaging) return;
    const current = screen.value;
    if ((current.kind === 'home' || current.kind === 'conversation') && current.busy) return;
    if (current.kind === 'home' || current.kind === 'conversation') screen.value = { ...current, busy: true };
    try {
      // Told before blocking, which ends our way of writing to them.
      if (forBoth) await messaging.remove(id, true);
      if (alsoBlock) await messaging.block(id);
      if (!forBoth) await messaging.remove(id);
    } catch (err) {
      if (handleGone(err)) return;
      return showHome({ tab: 'chats', notice: err instanceof NetworkError ? 'network' : 'generic' });
    }
    deps.broadcast({ type: 'data-changed' });
    return showHome({ tab: 'chats', notice: alsoBlock ? 'blocked' : 'deleted' });
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
    screen.value = {
      kind: 'conversation',
      id,
      label: c.label,
      role: c.role,
      ended: c.status === 'ended',
      blocked: c.status === 'blocked',
      readOnly: signedOut !== null || deletionPaused,
      ...(await chatPage(id, null)),
      busy: false,
      error: null,
    };
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
   * Sends again one of our attachments in the open conversation that
   * failed before it was uploaded (Try again in its menu): attachments were
   * paused, say. It goes to the end of the conversation, as a new one would.
   */
  async function resendMedia(id: string): Promise<void> {
    const current = screen.value;
    if (current.kind !== 'conversation' || current.busy || !messaging) return;
    const conv = current.id;
    const key = messageKey({ conv, id });
    if (transfers.value[key] !== undefined) return;
    screen.value = { ...current, error: null };
    let error: SendError | null = null;
    const show = () => showChat(conv, { error });
    setProgress(key, 0);
    try {
      await messaging.resendMedia(conv, id, show, (f) => setProgress(key, f));
    } catch (err) {
      if (handleGone(err)) return;
      error = sendError(err);
    } finally {
      setProgress(key, null);
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
   * One that's gone or broken is marked so (messaging.fetchMedia), and isn't
   * fetched by itself again.
   */
  async function fetchMedia(m: MessageRef, auto = false): Promise<void> {
    const key = messageKey(m);
    if (!messaging || transfers.value[key] !== undefined) return;
    setProgress(key, 0);
    let paused = false;
    try {
      await messaging.fetchMedia(m.conv, m.id, (f) => setProgress(key, f), auto);
      // Answered: downloads aren't paused (any more).
      downloadsPausedUntil = 0;
    } catch (err) {
      // Otherwise tried again on the next tap or opening.
      if (isPaused(err)) {
        paused = true;
        downloadsPausedUntil = Date.now() + PAUSED_WAIT_MS;
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
      // A tap says it's paused, or that it no longer is.
      let error = now.error;
      if (!auto && now.id === m.conv) error = paused ? 'media-paused' : error === 'media-paused' ? null : error;
      await showChat(now.id, { error });
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
   * files and anything larger wait for a tap. Attachments cleared from this
   * device, gone or broken also wait for a tap.
   */
  function autoFetch(conv: string): void {
    const now = currentScreen();
    if (now.kind !== 'conversation' || now.id !== conv) return;
    const { auto } = mediaSettings;
    void (async () => {
      for (const m of now.messages) {
        // Paused: one refusal, not one per attachment.
        if (Date.now() < downloadsPausedUntil) return;
        if (m.file !== 'remote' || m.out || !m.media || !fetchesByItself(m.media, auto)) continue;
        if ((autoFailures.get(messageKey(m)) ?? 0) >= AUTO_TRIES) continue;
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
      if (currentScreen().kind === 'usage') screen.value = { kind: 'usage', usage: null, error: err instanceof NetworkError ? 'network' : 'generic' };
      return;
    }
    // What the server will still sign today, for the low-balance notice too.
    await rememberLeft(deps.db, 'send', info.send.limit - info.send.used);
    await rememberLeft(deps.db, 'media', info.media.limit - info.media.used);
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
    const { total, byConversation } = await mediaUsage(deps.db);
    const labels = new Map((await listConversations(deps.db)).map((c) => [c.id, c.label]));
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
      if (currentScreen().kind === 'blocked') return showBlocked(err instanceof NetworkError ? 'network' : 'generic');
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
    if (err instanceof ApiError && err.code === 'rate_limited') return 'rate-limited';
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
  async function continueLaunch(offline: boolean): Promise<void> {
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
    return showHome({ offline });
  }

  /**
   * Deletes the account, once the user typed the confirmation: from then on
   * the deletion goes ahead, and a launch carries on with it if the app
   * closes first (META_DELETING), so the account is never left half
   * deleted. See runDeletion. This is also how a deletion the server says is
   * under way, with no record of it here, is finished (Finish deleting).
   */
  async function deleteAccount(): Promise<void> {
    const current = screen.value;
    if (current.kind !== 'confirm-delete' || current.busy || !session) return;
    const account = await readAccount(deps.db);
    if (!isSetUp(account)) return;
    // Not one already under way (confirmed here before, or the server says
    // so): the server may take nothing else for it now.
    const first = signedOut !== 'deleting' && !(await deletionConfirmed());
    await putMeta(deps.db, META_DELETING, { accountId: account.accountId });
    signedOut = null;
    readOnly.value = false;
    return runDeletion(first);
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
        if (steps++ >= STEPS_PER_RUN || Date.now() > until) throw new DeletionStalled();
        // Shown again each step: nothing else is, until it's done.
        screen.value = { kind: 'deleting', error: null };
        try {
          await session.call('DELETE', '/account', undefined, checkObject, { sign: true, account: target });
          finished = true;
          break;
        } catch (err) {
          const wait = stepWait(err, pause);
          if (wait === null) throw err;
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
        showDeletionError(err instanceof NetworkError ? 'network' : 'generic');
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
   */
  function deletingOnServer(): void {
    if (deletionRunning) return;
    showSignedOut('deleting');
    void (async () => {
      if (await deletionConfirmed()) {
        signedOut = null;
        readOnly.value = false;
        return runDeletion();
      }
      const account = await readAccount(deps.db);
      if (isSetUp(account)) await markDeletingElsewhere(deps.db, account.accountId);
    })();
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
    else if (err.code === 'login_refused') showSignedOut(signedOut === 'replaced' ? 'replaced' : 'refused');
    // Not taken on trust: the chats stay, and the user may finish it.
    else if (err.code === 'account_deleting') deletingOnServer();
    else if (clock.tooFar(err)) showClockOff(() => start());
    else return false;
    return true;
  }

  /** The account's links, as the home screen shows them. */
  async function linkViews(): Promise<LinkView[]> {
    return (await listLinks(deps.db)).map((l) => ({ ...l, url: linkUrl(deps.config!.botUsername, deps.config!.appName, l) }));
  }

  async function showHome(options: { offline?: boolean; notice?: HomeNotice | null; tab?: 'chats' | 'links' } = {}): Promise<void> {
    if (options.tab) tab = options.tab;
    const { config, db } = deps;
    // Signed out, the chats are only read: the server isn't asked.
    let offline = (options.offline ?? false) || signedOut !== null || deletionPaused;
    let account: AccountInfo | null = null;
    let invitations: InvitationsInfo | null = null;
    if (!offline) {
      try {
        [account, invitations] = await Promise.all([
          session!.call('GET', '/account', undefined, checkAccountInfo),
          session!.call('GET', '/invitations', undefined, checkInvitations),
        ]);
      } catch (err) {
        if (handleGone(err)) return;
        offline = true;
      }
    }
    if (account?.deleting) return deletingOnServer();
    if (account?.cleanup) void cleanUpReplaced();
    const links = await linkViews();
    backButton(false);
    screen.value = {
      kind: 'home',
      tab,
      conversations: await conversations(),
      offline,
      account,
      invitations,
      links,
      busy: false,
      notice: withNewKey(options.notice ?? null, await newKeyToTell(db)),
      askNotices: noticeLaunch && !!account && !account.notices && !writeAllowed,
      blockedCount: (await listConversations(db)).filter((c) => c.status === 'blocked').length,
      signedOut,
      deletionPaused,
    };
    if (screen.value.kind === 'home' && screen.value.notice === 'new-signing-key') await toldNewKey(db);
    if (account && !account.notices && writeAllowed && !noticesTried) void setUpNotices();
  }

  /**
   * Turns on Telegram notices for this account. Failures are left alone:
   * a later launch tries again while the account says they're off.
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
      screen.value = { ...current, account: { ...current.account, notices: true }, askNotices: false };
    }
  }

  /** Joins with an invitation code (typed, pasted, or from an invitation link). */
  async function redeem(input: string): Promise<void> {
    const code = normalizeCode(input);
    if (!code) return showHome({ notice: 'invalid-invitation' });
    const current = screen.value;
    if (current.kind === 'invitation' && current.busy) return;
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
      else if (err instanceof NetworkError) notice = 'network';
      else notice = 'generic';
    }
    // From an invitation link, what can be tried again keeps its Join button.
    if (current.kind === 'invitation' && (notice === 'network' || notice === 'generic')) {
      screen.value = { ...current, busy: false, error: notice };
      return;
    }
    return showHome({ notice });
  }

  async function openInvitations(notice: InvitationsNotice | null = null, created: string | null = null): Promise<void> {
    const { config } = deps;
    let info: InvitationsInfo;
    try {
      info = await session!.call('GET', '/invitations', undefined, checkInvitations);
    } catch (err) {
      if (handleGone(err)) return;
      return showHome({ notice: err instanceof NetworkError ? 'network' : 'generic' });
    }
    const codes = info.codes.map((c) => ({ ...c, url: invitationUrl(config!.botUsername, config!.appName, c.code) }));
    backButton(true);
    screen.value = { kind: 'invitations', info: { ...info, codes }, busy: false, notice, created };
  }

  async function createInvitation(uses: number): Promise<void> {
    const current = screen.value;
    if (current.kind !== 'invitations' || current.busy) return;
    screen.value = { ...current, busy: true, notice: null };
    try {
      const code = await session!.call('POST', '/invitations', { uses }, checkCreated, { sign: true });
      return openInvitations('created', code);
    } catch (err) {
      if (handleGone(err)) return;
      const notice: InvitationsNotice =
        err instanceof ApiError && err.code === 'no_invitations_left' ? 'none-left' : err instanceof NetworkError ? 'network' : 'generic';
      return openInvitations(notice);
    }
  }

  async function openAdmin(notice: AdminNotice | null = null): Promise<void> {
    let levels: LevelAllowance[];
    try {
      levels = await session!.call('GET', '/admin/levels', undefined, checkLevels);
    } catch (err) {
      if (handleGone(err)) return;
      return showHome({ notice: err instanceof NetworkError ? 'network' : 'generic' });
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
    return adminAction(() => session!.call('PUT', '/admin/switches', { switch: which, paused }, checkSwitches, { sign: true }), 'switched');
  }

  /** Runs an admin change, then shows the admin screen again with its outcome. */
  async function adminAction(action: () => Promise<unknown>, done: AdminNotice): Promise<void> {
    const current = screen.value;
    if (current.kind !== 'admin' || current.busy) return;
    screen.value = { ...current, busy: true, notice: null };
    let notice: AdminNotice = done;
    try {
      await action();
    } catch (err) {
      if (handleGone(err)) return;
      if (err instanceof ApiError && err.code === 'not_member') notice = 'not-member';
      else if (err instanceof ApiError && err.code === 'not_found') notice = 'not-found';
      else if (err instanceof NetworkError) notice = 'network';
      else notice = 'generic';
    }
    return openAdmin(notice);
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
    screen.value = { ...current, busy: true, notice: null };
    let notice: HomeNotice = done;
    try {
      await action();
    } catch (err) {
      if (handleGone(err)) return;
      if (err instanceof ApiError && err.code === 'invitation_required') notice = 'invitation';
      else if (err instanceof ApiError && err.code === 'link_limit') notice = 'limit';
      else if (err instanceof ApiError && err.code === 'rate_limited') notice = 'rate-limited';
      else if (err instanceof NetworkError) notice = 'network';
      else notice = 'generic';
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
    bridge.post('web_app_open_tg_link', { path_full: registrationPath(config.botUsername, config.appName, code) });
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
      screen.value = { kind: 'confirm-delete', busy: false, error: null };
    },
    deleteAccount,
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
      else return showHome({ tab: 'links' });
    },
    close: () => deps.bridge?.post('web_app_close'),
    retry: () => retry(),
    /** The time messages are dated by now (Unix ms): what a message's age, for editing, is counted from. */
    messageNow: () => clock.messageNow(),
    home: () => showHome(),
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
    /** Whether this build can send and receive attachments. */
    media: !!deps.config?.media,
    sendMedia,
    resendMedia,
    sendVoice,
    sendRound,
    /** Fetches an attachment on a tap. */
    fetchMedia: (m: MessageRef) => fetchMedia(m),
    saveMedia,
    mediaUrl,
    transfers,
    preparing,
    /** The Telegram app's platform, e.g. "ios", "android", "tdesktop". */
    platform: deps.launch.platform,
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
    showTab: (t: 'chats' | 'links') => showHome({ tab: t }),
    sync,
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
    setLevel: (level: number, invitations: number) =>
      adminAction(() => session!.call('PUT', '/admin/levels', { level, invitations }, checkObject, { sign: true }), 'saved'),
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
  const norm = (s: string) =>
    s
      .normalize('NFC')
      .replace(/[\s‌-‏⁦-⁩]+/g, '')
      .replace(/ك/g, 'ک')
      .replace(/[يى]/g, 'ی')
      .toLocaleLowerCase();
  return norm(typed) !== '' && norm(typed) === norm(phrase);
}
