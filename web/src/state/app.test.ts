import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logIn, prepareSetup, readAccount } from '../account/account';
import { ApiError, NetworkError, type Api } from '../net/api';
import { parseLaunch, type Launch } from '../platform/launch';
import type { Bridge, OutgoingEvents } from '../platform/telegram';
import { deleteMeta, getMeta, openDatabase, putMeta, wipe } from '../storage/db';
import { addMessage, deleteMessage, getConversation, getMedia, listMessages, PAGE, putConversation, putMedia, sendingLock, STUCK_MS } from '../messaging/store';
import { DEFAULT_MEDIA_SETTINGS, getMediaSettings } from '../messaging/settings';
import { withLock, type SyncEvent } from '../sync/locks';
import { SYNC_GAP_MS } from '../sync/pace';
import { rememberLeft, type TokenIssuer } from '../account/wallet';
import type { IssuerKey } from '../crypto/blindrsa';
import { en } from '../i18n/en';
import { fa } from '../i18n/fa';
import type { Messaging, MessagingDeps } from '../messaging/engine';
import { confirmationMatches, createApp, offersSettings, type Deps, type Screen } from './app';
import { encryptFile, newFileKey } from '../crypto/media';
import { toBase64Url } from '../crypto/encoding';

// The engine as it is, but what the app gives it is kept, so tests can call
// its callbacks (onWaiting, onResume) as the engine would; and so is what
// it makes, so they can watch the app call it.
const engines = vi.hoisted(() => ({ deps: [] as MessagingDeps[], made: [] as Messaging[] }));
vi.mock('../messaging/engine', async (importOriginal) => {
  const original = await importOriginal<typeof import('../messaging/engine')>();
  return {
    ...original,
    createMessaging: (deps: MessagingDeps) => {
      engines.deps.push(deps);
      const made = original.createMessaging(deps);
      engines.made.push(made);
      return made;
    },
  };
});

// Storing an attachment can fail as it would on a full device (storeFaults.putMedia).
const storeFaults = vi.hoisted(() => ({ putMedia: null as Error | null }));
// How many times where the user first wrote in a chat was looked up (and the lookup over).
const lookups = vi.hoisted(() => ({ answered: 0 }));
// How many times an open chat's page was read, and what happens on the
// screen while one is (pageReads.during): as when another draw or a tap
// lands while IndexedDB is slow.
const pageReads = vi.hoisted(() => ({ count: 0, during: null as (() => void) | null }));
// Reads a test holds up once they're done, until it lets them go (holdRead):
// as a slow IndexedDB would, with what read them still under way.
const heldReads = vi.hoisted(() => {
  const next = new Map<string, { when: (args: unknown[]) => boolean; hold: () => Promise<void> }>();
  return {
    next,
    async pass(name: string, args: unknown[]): Promise<void> {
      const held = next.get(name);
      if (!held?.when(args)) return;
      next.delete(name);
      await held.hold();
    },
  };
});
vi.mock('../messaging/store', async (importOriginal) => {
  const original = await importOriginal<typeof import('../messaging/store')>();
  return {
    ...original,
    putMedia: async (...args: Parameters<typeof original.putMedia>) => {
      if (storeFaults.putMedia) throw storeFaults.putMedia;
      return original.putMedia(...args);
    },
    pageMessages: async (...args: Parameters<typeof original.pageMessages>) => {
      pageReads.count++;
      const page = await original.pageMessages(...args);
      pageReads.during?.();
      await heldReads.pass('pageMessages', args);
      return page;
    },
    listConversations: async (...args: Parameters<typeof original.listConversations>) => {
      const list = await original.listConversations(...args);
      await heldReads.pass('listConversations', args);
      return list;
    },
    mediaUsage: async (...args: Parameters<typeof original.mediaUsage>) => {
      const usage = await original.mediaUsage(...args);
      await heldReads.pass('mediaUsage', args);
      return usage;
    },
    answeredAt: async (...args: Parameters<typeof original.answeredAt>) => {
      try {
        return await original.answeredAt(...args);
      } finally {
        lookups.answered++;
      }
    },
  };
});

// A read held for a test that never reached it mustn't hold up the next test.
afterEach(() => heldReads.next.clear());

let n = 0;
const config = {
  apiUrl: 'https://api.example',
  botUsername: 'test_bot',
  issuer: { name: 'test', spki: new Uint8Array(0), keyId: new Uint8Array(32) },
};
const tick = () => new Promise((r) => setTimeout(r, 5));

type Outcome = 'ok' | ApiError | NetworkError;

/** The server's clock, whatever the device's says (tests move Date.now). */
const realNow = Date.now;
const serverSeconds = () => Math.floor(realNow() / 1000);
/** Like the backend: a login or signed request more than 60 seconds off. */
const clockSkew = (timestamp: unknown) =>
  Math.abs(Number(timestamp) - serverSeconds()) > 60 ? new ApiError(401, 'clock_skew', serverSeconds()) : null;

/** Runs with this device's clock off by ms; the server's stays right. */
async function withDeviceClockOff<T>(ms: number, run: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + ms);
  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
}

/**
 * A fake server: accepts registrations and logins (or fails them as told),
 * stores link bundles exactly as clients send them, like the real one, and
 * keeps invitations for its one account.
 */
function fakeServer(
  outcomes: {
    register?: Outcome[];
    session?: Outcome[];
    account?: Outcome[];
    createLink?: Outcome[];
    deleteAccount?: Outcome[];
    mediaDelete?: Outcome[];
    inbox?: Outcome[];
    cleanup?: Outcome[];
    invitations?: Outcome[];
    admin?: Outcome[];
    usage?: Outcome[];
    /** For GET /invitations and GET /admin/levels. */
    reads?: Outcome[];
    elsewhere?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const bundles = new Map<string, { signingKey: string; keys: unknown[]; mailbox: string }>();
  const unsigned: string[] = [];
  // The timestamps logins were signed with.
  const loginTimes: number[] = [];
  const state = {
    inviteOnly: false,
    member: false,
    admin: false,
    codes: new Map<string, { uses: number; left: number }>(),
    levels: new Map<number, number>(),
    granted: [] as { link: string; invitations: number }[],
    deleted: false,
    // What GET /account says: being deleted (expired: by the server's expiry); something of a replaced account left to clean up.
    deleting: false,
    expired: false,
    cleanup: false,
    // The account registrations and logins answer with.
    accountId: 'BBBBBBBBBBBBBBBBBBBBBB',
    // DELETE /account waits for this, if set.
    deleteGate: null as Promise<void> | null,
    // The operator's emergency switches; switchesDown: they can't be read.
    switches: { uploadsPaused: false, downloadsPaused: false },
    switchesDown: false,
    // Fetches of the (empty) inbox wait for this, if set.
    inboxGate: null as Promise<void> | null,
    // Run when the inbox is fetched: what arrives with it.
    onInbox: null as (() => Promise<void>) | null,
    // Run when uploads are deleted, before it answers; the IDs deleted.
    onMediaDelete: null as (() => Promise<void>) | null,
    deletedUploads: [] as string[],
    // How GET /media/{id} answers: with this download URL, or failing so, or
    // (neither set) not_found, no such upload.
    mediaUrl: null as string | null,
    media: null as ApiError | NetworkError | null,
    // GET /media/{id} of these uploads fails so, whatever the above say.
    mediaRefused: new Map<string, ApiError>(),
    // When GET /usage says the day ends (Unix seconds).
    resetsAt: 1_800_028_800,
  };
  let nextCode = 0;
  const take = (queue: Outcome[] | undefined) => {
    const outcome = queue?.shift() ?? 'ok';
    if (outcome !== 'ok') throw outcome;
  };
  const api: Api = {
    post: (path, body, check) => api.request('POST', path, { body: JSON.stringify(body) }, check),
    async request(method, path, init, check) {
      const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      calls.push(`${method} ${path}${body.replace ? '?replace' : ''}`);
      const signature = init.headers?.['X-Device-Signature'];
      const signed = !!signature && !!init.headers?.['X-Session'];
      const needsSignature = () => {
        if (!signed) unsigned.push(`${method} ${path}`);
      };
      // Checked first, as the backend does.
      const skew = signature ? clockSkew(signature.split('.')[0]) : null;
      if (skew) throw skew;
      // Like the backend: an account being deleted isn't one in use.
      if (path === '/accounts/lookup') return check({ exists: outcomes.elsewhere === true && !state.deleting });
      if (method === 'GET' && path.startsWith('/inbox')) {
        await state.inboxGate;
        take(outcomes.inbox);
        if (state.deleting && !state.deleted) throw new ApiError(409, 'account_deleting');
        await state.onInbox?.();
        return check({ items: [], more: false });
      }
      if (path === '/register') {
        take(outcomes.register);
        // A new account (replacing one being deleted, too).
        state.deleting = false;
        return check({ account: state.accountId, token: 'v1.p.m', expires: serverSeconds() + 900 });
      }
      if (path === '/session') {
        loginTimes.push(Number(body.timestamp));
        const skew = clockSkew(body.timestamp);
        if (skew) throw skew;
        take(outcomes.session);
        return check({ account: state.accountId, token: 'v1.p.m', expires: serverSeconds() + 900 });
      }
      if (method === 'DELETE' && path === '/account') {
        // A request that stalls on its way, until the test lets it through.
        await state.deleteGate;
        needsSignature();
        // Marked by a step that went through (done, or more to do).
        const outcome = outcomes.deleteAccount?.shift() ?? 'ok';
        if (outcome === 'ok' || (outcome instanceof ApiError && outcome.code === 'in_progress')) state.deleting = true;
        if (outcome !== 'ok') throw outcome;
        state.deleted = true;
        bundles.clear();
        return check({});
      }
      // By the uploads' own secrets, without logging in: each outcome is
      // one request's.
      if (method === 'POST' && path === '/media/delete') {
        await state.onMediaDelete?.();
        take(outcomes.mediaDelete);
        const items = body.items as { id: string }[];
        state.deletedUploads.push(...items.map((i) => i.id));
        return check({ results: items.map(() => 'deleted') });
      }
      // Like the backend: an account being deleted takes no other request.
      if (state.deleting && !state.deleted && path !== '/account') throw new ApiError(409, 'account_deleting');
      if (method === 'POST' && path === '/account/cleanup') {
        needsSignature();
        take(outcomes.cleanup);
        state.cleanup = false;
        return check({});
      }
      const canCreateLinks = !state.inviteOnly || state.member || state.admin;
      if (path === '/account') {
        take(outcomes.account);
        return check({
          canCreateLinks,
          admin: state.admin,
          links: bundles.size,
          maxLinks: 5,
          deleting: state.deleting,
          expired: state.deleting && state.expired,
          cleanup: state.cleanup,
        });
      }
      if (method === 'GET' && path === '/usage') {
        take(outcomes.usage);
        const item = (used: number, limit: number) => ({ used, limit });
        return check({ resetsAt: state.resetsAt, send: item(980, 1000), media: item(24, 1024), mailboxes: item(10, 100), linkChanges: item(1, 5), owned: item(10, 2000) });
      }
      if (method === 'GET' && path === '/invitations') {
        take(outcomes.reads);
        const maxUses = state.admin ? 1000 : state.member ? 2 : 0;
        return check({
          inviteOnly: state.inviteOnly,
          member: state.member,
          admin: state.admin,
          level: state.member ? 1 : 0,
          unlimited: state.admin,
          remaining: state.admin ? 0 : maxUses,
          maxUses,
          codes: [...state.codes].map(([code, c]) => ({ code, ...c })),
        });
      }
      if (method === 'POST' && path === '/invitations') {
        needsSignature();
        take(outcomes.invitations);
        const code = `aaaa-aaa${'abcdefghjk'[nextCode++]}`;
        state.codes.set(code, { uses: body.uses as number, left: body.uses as number });
        return check({ code });
      }
      if (path === '/invitations/redeem') {
        if (body.code === 'mmmm-nnnn') throw new ApiError(409, 'own_invitation');
        const c = state.codes.get(body.code as string);
        if (!c || c.left === 0) throw new ApiError(404, 'invalid_invitation');
        if (state.member) throw new ApiError(409, 'already_member');
        c.left--;
        state.member = true;
        return check({ level: 1 });
      }
      if (path === '/admin/levels' && method === 'GET') {
        take(outcomes.reads);
        return check({ levels: [...state.levels].map(([level, invitations]) => ({ level, invitations })) });
      }
      if (path === '/admin/levels' && method === 'PUT') {
        needsSignature();
        take(outcomes.admin);
        state.levels.set(body.level as number, body.invitations as number);
        return check({});
      }
      if (path === '/admin/switches') {
        if (!state.admin) throw new ApiError(403, 'admin_only');
        if (state.switchesDown) throw new ApiError(500, 'internal');
        if (method === 'PUT') {
          needsSignature();
          state.switches[body.switch === 'uploads' ? 'uploadsPaused' : 'downloadsPaused'] = body.paused as boolean;
        }
        return check({ ...state.switches });
      }
      if (method === 'GET' && path.startsWith('/media/')) {
        if (state.switches.downloadsPaused) throw new ApiError(503, 'downloads_paused');
        const refused = state.mediaRefused.get(path.slice('/media/'.length));
        if (refused) throw refused;
        if (state.mediaUrl) return check({ url: state.mediaUrl });
        throw state.media ?? new ApiError(404, 'not_found');
      }
      if (path === '/admin/grant') {
        needsSignature();
        if (!bundles.has(body.link as string)) throw new ApiError(404, 'not_found');
        state.granted.push({ link: body.link as string, invitations: body.invitations as number });
        return check({});
      }
      if (method === 'POST' && path === '/links') {
        needsSignature();
        take(outcomes.createLink);
        bundles.set(body.id as string, { signingKey: body.signingKey as string, keys: body.keys as unknown[], mailbox: 'MMMMMMMMMMMMMMMMMMMMMA' });
        return check({ id: body.id, mailbox: 'MMMMMMMMMMMMMMMMMMMMMA' });
      }
      const id = path.split('/')[2]!;
      if (method === 'GET' && bundles.has(id)) return check(bundles.get(id));
      if (method === 'DELETE' && bundles.has(id)) {
        needsSignature();
        bundles.delete(id);
        return check({});
      }
      throw new ApiError(404, 'not_found');
    },
  };
  return { api, calls, bundles, unsigned, state, loginTimes, outcomes };
}

function fakeBridge() {
  const posted: { type: keyof OutgoingEvents; data: unknown }[] = [];
  const bridge: Bridge = {
    transport: 'webview-proxy',
    post: (type, ...data) => void posted.push({ type, data: data[0] }),
    on: () => () => {},
  };
  return { bridge, posted };
}

function launchWith(startParam: string, extra = ''): Launch {
  const initData = `auth_date=1&start_param=${startParam}&user=${encodeURIComponent(`{"id":1${extra}}`)}`;
  return parseLaunch('tgWebAppData=' + encodeURIComponent(initData));
}

async function setup(partial: Partial<Deps> & { api?: Api | null }) {
  const db = partial.db ?? (await openDatabase(`app-test-${n++}`));
  const broadcasts: SyncEvent[] = [];
  const app = createApp({
    config,
    api: null,
    launch: parseLaunch(''),
    bridge: null,
    broadcast: (e) => broadcasts.push(e),
    closeDelayMs: 0,
    background: false,
    ...partial,
    db,
  });
  return { app, db, broadcasts };
}

/** Sets up a registered device on a fresh database. */
async function registered(api: Api, extra: Partial<Deps> = {}) {
  const db = await openDatabase(`app-test-${n++}`);
  await (await setup({ api, bridge: fakeBridge().bridge, launch: launchWith(''), db })).app.setUp();
  const code = 'reg' + (await readAccount(db))!.fingerprint;
  const reg = await setup({ api, bridge: fakeBridge().bridge, launch: launchWith(code), db });
  await reg.app.start();
  // Then a normal launch (or one opened from a link).
  const { app, broadcasts } = await setup({ api, bridge: fakeBridge().bridge, launch: launchWith(''), db, ...extra });
  await app.start();
  return { app, db, code, broadcasts };
}

function home(screen: Screen) {
  if (screen.kind !== 'home') throw new Error(`expected home, got ${screen.kind}`);
  return screen;
}

function payloadOf(url: string): string {
  return new URL(url).searchParams.get('startapp')!;
}

/**
 * Holds the next read of `name` (that `when` picks) once it's done, until
 * released: as a slow IndexedDB would, with what read it still under way.
 */
function holdRead(name: 'pageMessages' | 'listConversations' | 'mediaUsage', when: (args: unknown[]) => boolean = () => true) {
  let reached!: () => void;
  const atRead = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  heldReads.next.set(name, {
    when,
    hold: () => {
      reached();
      return released;
    },
  });
  return { atRead, release };
}

describe('setup', () => {
  it('says so when the build has no server', async () => {
    const { app } = await setup({ config: null });
    await app.start();
    expect(app.screen.value.kind).toBe('unconfigured');
  });

  it('asks to open Telegram when set up outside it', async () => {
    const { app } = await setup({ api: fakeServer().api });
    await app.start();
    expect(app.screen.value.kind).toBe('outside-telegram');
  });

  it('sets up across two launches: reopen with the code, then register', async () => {
    const { api, calls } = fakeServer();
    const first = fakeBridge();
    const { app, db } = await setup({ api, bridge: first.bridge, launch: launchWith('') });
    await app.start();
    expect(app.screen.value).toEqual({ kind: 'welcome', mismatch: false });

    await app.setUp();
    await tick();
    expect(app.screen.value.kind).toBe('reopening');
    const open = first.posted.find((p) => p.type === 'web_app_open_tg_link');
    const code = (await readAccount(db))!.fingerprint;
    expect(open?.data).toEqual({ path_full: `/test_bot?startapp=reg${code}` });
    expect(first.posted.at(-1)?.type).toBe('web_app_close');

    // The registration launch, a second copy sharing the same storage.
    const second = fakeBridge();
    const { app: reopened, broadcasts } = await setup({ api, bridge: second.bridge, launch: launchWith('reg' + code), db });
    await reopened.start();
    expect(home(reopened.screen.value)).toMatchObject({ offline: false, links: [], account: { canCreateLinks: true } });
    // The first, plain launch asked whether the account lives elsewhere.
    expect(calls).toEqual(['POST /accounts/lookup', 'POST /register', 'GET /account', 'GET /invitations']);
    expect(broadcasts).toContainEqual({ type: 'account-changed' });
    expect(second.posted.map((p) => p.type)).toContain('web_app_request_write_access');
    expect(await readAccount(db)).toMatchObject({ state: 'registered' });
  });

  it("doesn't ask for write access the user already gave", async () => {
    const { api } = fakeServer();
    const db = await openDatabase(`app-test-${n++}`);
    const { app } = await setup({ api, bridge: fakeBridge().bridge, launch: launchWith(''), db });
    await app.setUp();
    const code = 'reg' + (await readAccount(db))!.fingerprint;
    const second = fakeBridge();
    const { app: reopened } = await setup({ api, bridge: second.bridge, launch: launchWith(code, ',"allows_write_to_pm":true'), db });
    await reopened.start();
    expect(second.posted.map((p) => p.type)).not.toContain('web_app_request_write_access');
  });

  it('refuses a registration launch for another setup', async () => {
    const { api, calls } = fakeServer();
    const { app } = await setup({ api, bridge: fakeBridge().bridge, launch: launchWith('reg' + 'x'.repeat(43)) });
    await app.start();
    expect(app.screen.value).toEqual({ kind: 'welcome', mismatch: true });
    expect(calls).toEqual([]);
  });

  it('needs the typed confirmation to replace an existing account', async () => {
    const { api, calls } = fakeServer({ register: [new ApiError(409, 'account_exists')] });
    const db = await openDatabase(`app-test-${n++}`);
    await (await setup({ api, bridge: fakeBridge().bridge, launch: launchWith(''), db })).app.setUp();
    const code = 'reg' + (await readAccount(db))!.fingerprint;

    const { app } = await setup({ api, bridge: fakeBridge().bridge, launch: launchWith(code), db });
    await app.start();
    // First: the account is on another device. Starting over here is a choice, then typed.
    expect(app.screen.value).toEqual({ kind: 'elsewhere' });
    await app.startOver();
    expect(app.screen.value).toEqual({ kind: 'confirm-replace', busy: false });
    app.cancelReplace();
    expect(app.screen.value).toEqual({ kind: 'elsewhere' });
    await app.startOver();
    await app.confirmReplace();
    expect(app.screen.value.kind).toBe('home');
    expect(calls.filter((c) => c.includes('register'))).toEqual(['POST /register', 'POST /register?replace']);
  });

  it('says on a plain launch that the account is on another device, and can start over from there', async () => {
    const { api, calls } = fakeServer({ elsewhere: true, register: [new ApiError(409, 'account_exists')] });
    const db = await openDatabase(`app-test-${n++}`);
    const first = fakeBridge();
    const { app } = await setup({ api, bridge: first.bridge, launch: launchWith(''), db });
    await app.start();
    expect(app.screen.value).toEqual({ kind: 'elsewhere' });
    app.close();
    expect(first.posted.at(-1)?.type).toBe('web_app_close');

    // Starting over: setup reopens the app, and the existing account goes straight to the typed confirmation.
    await app.startOver();
    await tick();
    expect(app.screen.value.kind).toBe('reopening');
    const code = 'reg' + (await readAccount(db))!.fingerprint;
    const { app: reopened } = await setup({ api, bridge: fakeBridge().bridge, launch: launchWith(code), db });
    await reopened.start();
    expect(reopened.screen.value).toEqual({ kind: 'confirm-replace', busy: false });
    await reopened.confirmReplace();
    expect(reopened.screen.value.kind).toBe('home');
    expect(calls.filter((c) => c.includes('register'))).toEqual(['POST /register', 'POST /register?replace']);
  });

  it("doesn't ask the server about launches that name a link", async () => {
    const { api, calls } = fakeServer({ elsewhere: true });
    const { app } = await setup({ api, bridge: fakeBridge().bridge, launch: launchWith('1' + 'A'.repeat(54)) });
    await app.start();
    expect(app.screen.value).toEqual({ kind: 'welcome', mismatch: false });
    expect(calls).toEqual([]);
  });

  it('reopens for fresh launch data when the old one expired', async () => {
    const { api } = fakeServer({ register: [new ApiError(401, 'init_data_rejected')] });
    const db = await openDatabase(`app-test-${n++}`);
    await (await setup({ api, bridge: fakeBridge().bridge, launch: launchWith(''), db })).app.setUp();
    const code = 'reg' + (await readAccount(db))!.fingerprint;

    const bridge = fakeBridge();
    const { app } = await setup({ api, bridge: bridge.bridge, launch: launchWith(code), db });
    await app.start();
    expect(app.screen.value).toEqual({ kind: 'error', error: 'expired' });
    await app.retry();
    expect(app.screen.value.kind).toBe('reopening');
    // Same keys, same code.
    expect(bridge.posted.find((p) => p.type === 'web_app_open_tg_link')?.data).toEqual({ path_full: `/test_bot?startapp=${code}` });
  });

  it('logs in when registered, and shows a replaced account loudly, asking again at each launch', async () => {
    // The first login is the one registered() makes.
    const down = new NetworkError('down');
    const { api, calls } = fakeServer({ session: ['ok', 'ok', down, new ApiError(410, 'account_replaced'), down, 'ok'] });
    const { db } = await registered(api);

    const { app } = await setup({ api, bridge: fakeBridge().bridge, launch: launchWith(''), db });
    await app.start();
    expect(home(app.screen.value).offline).toBe(false);
    await app.start();
    expect(home(app.screen.value).offline).toBe(true);
    await app.start();
    expect(app.screen.value).toEqual({ kind: 'signed-out', reason: 'replaced', busy: false, offline: false });
    expect(await readAccount(db)).toMatchObject({ state: 'replaced' });
    // Unverified: asked again at the next launch. Offline, it still says what the server last said.
    await app.start();
    expect(app.screen.value).toEqual({ kind: 'signed-out', reason: 'replaced', busy: false, offline: true });
    // A server that lets the device in again is believed: nothing was lost.
    await app.start();
    expect(home(app.screen.value).offline).toBe(false);
    expect(await readAccount(db)).toMatchObject({ state: 'registered' });
    expect(calls.filter((c) => c === 'POST /session')).toHaveLength(6);
  });
});

/** A conversation with one message on the device. */
async function chatOnDevice(db: Awaited<ReturnType<typeof openDatabase>>) {
  await putConversation(db, {
    id: 'c1',
    wire: 'W'.repeat(22),
    role: 'sender',
    link: { id: 'E'.repeat(11), fingerprint: 'F'.repeat(43) },
    label: 'x',
    peerKey: 'k',
    myKey: null,
    sendTo: 'H'.repeat(22),
    myMailbox: 'D'.repeat(22),
    lastAt: 1,
    unread: 0,
    status: 'active',
    lastReceived: null,
  });
  await addMessage(db, { id: 'm1', conv: 'c1', at: 1, out: false, status: 'read' }, { text: 'kept' });
}

/**
 * Chat c1 as the user started it: their first message, sent (and seen),
 * before the other side's. Attachments that come after it download by
 * themselves (store.ts, answeredAt).
 */
async function startedOnDevice(db: Awaited<ReturnType<typeof openDatabase>>) {
  await chatOnDevice(db);
  await addMessage(db, { id: 'hi', conv: 'c1', at: 0, out: true, status: 'seen' }, { text: 'hi' });
}

describe('a device clock that is off', () => {
  it('logs in after one automatic retry when 5 minutes fast, and the user sees no error', async () => {
    const server = fakeServer();
    await withDeviceClockOff(5 * 60_000, async () => {
      const owner = await registered(server.api);
      expect(home(owner.app.screen.value)).toMatchObject({ offline: false, signedOut: null });
      // One refused login, then one with the server's time.
      expect(server.calls.filter((c) => c === 'POST /session')).toHaveLength(2);
      // Signed requests use the server's time from then on.
      await owner.app.createLink();
      expect(home(owner.app.screen.value).notice).toBe('created');
      expect(server.calls.filter((c) => c === 'POST /links')).toHaveLength(1);
    });
  });

  it("dates messages by the server's clock as the login's token tells it, within a minute of the device's", async () => {
    const server = fakeServer();
    for (const [off, dated] of [
      [20_000, 0],
      [-45_000, 0],
      // Further off: the device's own, as before.
      [90_000, 90_000],
    ] as const) {
      await withDeviceClockOff(off, async () => {
        const { app } = await registered(server.api);
        // Something that logs in.
        await app.createLink();
        expect(Math.abs(app.messageNow() - (realNow() + dated))).toBeLessThan(1500);
      });
    }
  });

  it('logs in when hours behind, too', async () => {
    const server = fakeServer();
    await withDeviceClockOff(-3.5 * 3600_000, async () => {
      const owner = await registered(server.api);
      expect(home(owner.app.screen.value)).toMatchObject({ offline: false });
    });
  });

  it('asks to set the clock when the device is days off, signing nothing by the server clock', async () => {
    const server = fakeServer();
    const owner = await withDeviceClockOff(3 * 86_400_000, () => registered(server.api));
    expect(owner.app.screen.value).toEqual({ kind: 'error', error: 'clock' });
    // Every login was signed by the device's own clock and refused: the
    // server's, two days and more away, was never taken.
    expect(server.loginTimes.length).toBeGreaterThan(0);
    for (const at of server.loginTimes) expect(Math.abs(at - (serverSeconds() + 3 * 86_400))).toBeLessThan(60);
    // Once the clock is set, Try again goes through.
    await owner.app.retry();
    expect(home(owner.app.screen.value)).toMatchObject({ offline: false });
  });

  it("doesn't believe a server that says it's ten years later", async () => {
    // A hostile server collecting logins dated ahead, to replay them on the honest one later.
    const later = () => new ApiError(401, 'clock_skew', serverSeconds() + 10 * 365 * 86_400);
    const server = fakeServer({ session: ['ok', later()] });
    const { db } = await registered(server.api);
    const { app } = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db });
    const logins = () => server.calls.filter((c) => c === 'POST /session').length;
    const before = logins();
    await app.start();
    expect(app.screen.value).toEqual({ kind: 'error', error: 'clock' });
    expect(logins() - before).toBe(1);
    // No login was ever signed with a time ahead of the real one.
    for (const at of server.loginTimes) expect(Math.abs(at - serverSeconds())).toBeLessThan(60);
    // Nothing deleted, and the device is still set up.
    expect(await readAccount(db)).toMatchObject({ state: 'registered' });
  });
});

describe('when the server stops taking this device', () => {
  const refused = () => new ApiError(401, 'login_refused');

  it('keeps the chats, read-only, and nothing short of the typed confirmation deletes them', async () => {
    // The first login is the one registered() makes.
    const server = fakeServer({ session: ['ok', refused(), refused(), refused(), refused()] });
    const { db } = await registered(server.api);
    await chatOnDevice(db);

    const { app } = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db });
    await app.start();
    expect(app.screen.value).toEqual({ kind: 'signed-out', reason: 'refused', busy: false, offline: false });

    // What used to be the only button (Continue, which wiped the device) now asks again.
    await app.retry();
    expect(app.screen.value).toMatchObject({ kind: 'signed-out', reason: 'refused' });
    await app.recheck();
    expect(app.screen.value).toMatchObject({ kind: 'signed-out', reason: 'refused', busy: false });
    expect(server.calls.filter((c) => c === 'POST /session')).toHaveLength(4);

    // The chats can be read, not written.
    await app.readChats();
    expect(home(app.screen.value)).toMatchObject({ signedOut: 'refused', offline: true, conversations: [{ id: 'c1' }] });
    await app.openConversation('c1');
    expect(app.screen.value).toMatchObject({ kind: 'conversation', readOnly: true, messages: [{ id: 'm1', text: 'kept' }] });
    await app.home();
    expect(home(app.screen.value).signedOut).toBe('refused');

    // Setting up again asks for the typed confirmation; cancelling keeps everything.
    await app.recheck();
    app.askReset();
    expect(app.screen.value).toEqual({ kind: 'confirm-reset', reason: 'refused' });
    app.cancelReset();
    expect(app.screen.value).toMatchObject({ kind: 'signed-out', reason: 'refused' });
    // Recorded as refused (asked again at the next launch); nothing deleted.
    expect(await readAccount(db)).toMatchObject({ state: 'refused' });
    expect(await listMessages(db, 'c1')).toHaveLength(1);

    // Only confirming deletes, and sets up anew.
    app.askReset();
    await app.confirmReset();
    await tick();
    expect(app.screen.value.kind).toBe('reopening');
    expect(await readAccount(db)).toMatchObject({ state: 'pending' });
    expect(await listMessages(db, 'c1')).toHaveLength(0);
  });

  it('says so when the server refuses the device while the app is open, deleting nothing', async () => {
    // registered() reads the account twice (the registration launch, then a plain one).
    const server = fakeServer({ account: ['ok', 'ok', refused()] });
    const owner = await registered(server.api);
    await chatOnDevice(owner.db);
    await owner.app.home();
    expect(owner.app.screen.value).toMatchObject({ kind: 'signed-out', reason: 'refused' });
    expect(await readAccount(owner.db)).toMatchObject({ state: 'refused' });
    expect(await listMessages(owner.db, 'c1')).toHaveLength(1);
  });

  it('keeps the replaced warning when the server later only refuses the device', async () => {
    // Once the server's marker of the replacement expires, it answers login_refused.
    const server = fakeServer({ session: ['ok', new ApiError(410, 'account_replaced'), refused(), refused()] });
    const { db } = await registered(server.api);
    const { app } = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db });
    await app.start();
    expect(app.screen.value).toMatchObject({ kind: 'signed-out', reason: 'replaced' });
    await app.recheck();
    expect(app.screen.value).toMatchObject({ kind: 'signed-out', reason: 'replaced' });
    // And at a later launch.
    const later = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db });
    await later.app.start();
    expect(later.app.screen.value).toMatchObject({ kind: 'signed-out', reason: 'replaced' });
    expect(await readAccount(db)).toMatchObject({ state: 'replaced' });
  });

  it('opens read-only after a refusal even offline, until the server lets the device in', async () => {
    const server = fakeServer({ session: ['ok', refused(), new NetworkError('down'), 'ok'] });
    const { db } = await registered(server.api);
    await chatOnDevice(db);
    const launch = async () => {
      const { app } = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db });
      await app.start();
      return app;
    };
    expect((await launch()).screen.value).toMatchObject({ kind: 'signed-out', reason: 'refused' });
    const offline = await launch();
    expect(offline.screen.value).toEqual({ kind: 'signed-out', reason: 'refused', busy: false, offline: true });
    await offline.readChats();
    expect(home(offline.screen.value)).toMatchObject({ signedOut: 'refused', conversations: [{ id: 'c1' }] });
    // Accepted again: writable, and no longer recorded as refused.
    const back = await launch();
    expect(home(back.screen.value)).toMatchObject({ signedOut: null, offline: false });
    expect(await readAccount(db)).toMatchObject({ state: 'registered' });
  });

  it('makes no server calls while read-only: reading chats, opening one, seen receipts, downloads', async () => {
    const server = fakeServer({ session: ['ok', refused()] });
    const { db } = await registered(server.api);
    await startedOnDevice(db);
    // A photo not on the device yet, which would download as the chat opens.
    await addMessage(
      db,
      { id: 'p1', conv: 'c1', at: 2, out: false, status: 'received', file: 'remote' },
      { text: '', media: { t: 'photo', s: 1000, m: 'image/jpeg', w: 10, h: 10, id: 'upload-p1', k: 'a2V5', d: 'c2VjcmV0' } },
    );
    const { app } = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db });
    await app.start();
    expect(app.screen.value).toMatchObject({ kind: 'signed-out' });
    expect(app.readOnly.value).toBe(true);
    const before = server.calls.length;

    await app.readChats();
    await app.openConversation('c1');
    expect(app.screen.value).toMatchObject({ kind: 'conversation', readOnly: true, messages: [{ id: 'hi' }, { id: 'm1' }, { id: 'p1', file: 'remote' }] });
    app.markSeen();
    await app.fetchMedia({ conv: 'c1', id: 'p1' });
    await app.home();
    await tick();
    expect(server.calls.slice(before)).toEqual([]);
    expect(await getMedia(db, 'c1', 'p1')).toBeUndefined();
  });

  it('starts messaging again when Try again works, with one of each background listener', async () => {
    // registered() reads the account twice; then refused while open, accepted after Try again, refused again.
    const server = fakeServer({ account: ['ok', 'ok', refused(), 'ok', refused()] });
    const listeners = new Map<string, number>();
    const bridge: Bridge = {
      transport: 'webview-proxy',
      post: () => {},
      on: (type) => {
        listeners.set(type, (listeners.get(type) ?? 0) + 1);
        return () => void listeners.set(type, listeners.get(type)! - 1);
      },
    };
    const issuer: TokenIssuer = { key: {} as IssuerKey, keyId: new Uint8Array(32) };
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} });
    try {
      const owner = await registered(server.api, { bridge, issuer, background: true });
      const inbox = () => server.calls.filter((c) => c === 'GET /inbox').length;
      const visible = () => listeners.get('visibility_changed') ?? 0;
      // With the background running (other parts of the app may listen for good).
      const running = visible();
      expect(running).toBeGreaterThan(0);
      expect(inbox()).toBe(1);

      await owner.app.home();
      expect(owner.app.screen.value).toMatchObject({ kind: 'signed-out', reason: 'refused' });
      // The background's own listener is gone with it.
      expect(visible()).toBe(running - 1);

      await owner.app.recheck();
      expect(home(owner.app.screen.value)).toMatchObject({ signedOut: null, offline: false });
      expect(owner.app.readOnly.value).toBe(false);
      // Messaging runs again (it fetched the inbox), its background started once.
      expect(inbox()).toBe(2);
      expect(visible()).toBe(running);

      // Stops it again (and so ends this test's timers).
      await owner.app.home();
      expect(visible()).toBe(running - 1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps a replaced account readable too, and its chats on the device', async () => {
    const server = fakeServer({ session: ['ok', new ApiError(410, 'account_replaced'), new ApiError(410, 'account_replaced')] });
    const { db } = await registered(server.api);
    await chatOnDevice(db);
    const { app } = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db });
    await app.start();
    expect(app.screen.value).toMatchObject({ kind: 'signed-out', reason: 'replaced' });
    await app.retry();
    await app.readChats();
    expect(home(app.screen.value)).toMatchObject({ signedOut: 'replaced', conversations: [{ id: 'c1' }] });
    expect(await listMessages(db, 'c1')).toHaveLength(1);
  });
});

describe('the chat list', () => {
  it('draws the newest it read: a refresh that read the list before another never draws over it', async () => {
    const { app, db } = await registered(fakeServer().api);
    await chatOnDevice(db);
    // Another chat, newer than those before it.
    const chat = async (id: string, lastAt: number) => putConversation(db, { ...(await getConversation(db, 'c1'))!, id, lastAt, preview: null });
    const shown = () => home(app.screen.value).conversations.map((c) => c.id);
    await app.home();
    expect(shown()).toEqual(['c1']);

    // A refresh slow to read the list. Meanwhile a chat comes in, and another
    // refresh draws it: the first, once read, draws nothing.
    const slow = holdRead('listConversations');
    const first = app.refresh();
    await slow.atRead;
    await chat('c2', 2);
    await app.refresh();
    expect(shown()).toEqual(['c2', 'c1']);
    slow.release();
    await first;
    expect(shown()).toEqual(['c2', 'c1']);

    // The same when the list is shown afresh (a tab tapped) meanwhile.
    const slower = holdRead('listConversations');
    const again = app.refresh();
    await slower.atRead;
    await chat('c3', 3);
    await app.showTab('chats');
    expect(shown()).toEqual(['c3', 'c2', 'c1']);
    slower.release();
    await again;
    expect(shown()).toEqual(['c3', 'c2', 'c1']);
  });
});

describe('syncing', () => {
  it('runs one sync at a time, and one more for all asked for meanwhile', async () => {
    const server = fakeServer();
    const issuer: TokenIssuer = { key: {} as IssuerKey, keyId: new Uint8Array(32) };
    const { app } = await registered(server.api, { issuer });
    const inbox = () => server.calls.filter((c) => c === 'GET /inbox').length;
    const before = inbox();
    let open!: () => void;
    server.state.inboxGate = new Promise((resolve) => (open = resolve));
    // Pushes arriving while a sync runs.
    const syncs = [app.sync(), app.sync(), app.sync(), app.sync(), app.sync()];
    await vi.waitFor(() => expect(inbox()).toBe(before + 1));
    open();
    await Promise.all(syncs);
    expect(inbox()).toBe(before + 2);
  });

  it('tells other copies when upkeep deleted keys, and forgets its own when another copy did', async () => {
    const server = fakeServer();
    const issuer: TokenIssuer = { key: {} as IssuerKey, keyId: new Uint8Array(32) };
    engines.deps.length = 0;
    engines.made.length = 0;
    const { app, broadcasts } = await registered(server.api, { issuer });
    broadcasts.length = 0;
    engines.deps.at(-1)!.onKeysDeleted!();
    expect(broadcasts).toEqual([{ type: 'keys-changed' }]);
    const forget = vi.spyOn(engines.made.at(-1)!, 'forgetKeys');
    app.keysChanged();
    expect(forget).toHaveBeenCalledOnce();
  });

  it('backs its poll off while the server is in trouble, but syncs when shown', async () => {
    const trouble: Outcome[] = [];
    const server = fakeServer({ inbox: trouble });
    const issuer: TokenIssuer = { key: {} as IssuerKey, keyId: new Uint8Array(32) };
    const { db } = await registered(server.api, { issuer });
    let show!: (data: { is_visible: boolean }) => void;
    const bridge: Bridge = {
      transport: 'webview-proxy',
      post: () => {},
      on: (type, handler) => {
        if (type === 'visibility_changed') show = handler as typeof show;
        return () => {};
      },
    };
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      // Overloaded from the start: 503 unavailable, Retry-After 2.
      for (let i = 0; i < 50; i++) trouble.push(new ApiError(503, 'unavailable', undefined, undefined, 2));
      const { app } = await setup({ api: server.api, bridge, launch: launchWith(''), db, issuer, background: true });
      await app.start();
      const inbox = () => server.calls.filter((c) => c === 'GET /inbox').length;
      const first = inbox();
      expect(first).toBeGreaterThan(0);

      // Polling every 20 seconds would fetch 15 times in 5 minutes; backing
      // off (20 s, then 40, 80, 160, each half to all of it), at most 5.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const backedOff = inbox() - first;
      expect(backedOff).toBeGreaterThanOrEqual(2);
      expect(backedOff).toBeLessThanOrEqual(5);

      // Shown by the user: it syncs at once, backoff or not.
      const before = inbox();
      show({ is_visible: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(inbox()).toBe(before + 1);

      // The server is fine again: once a sync gets through, the poll is
      // back to every 20 seconds (a poll within 10 seconds of a sync is
      // answered by it).
      trouble.length = 0;
      show({ is_visible: true });
      await vi.advanceTimersByTimeAsync(0);
      const fine = inbox();
      await vi.advanceTimersByTimeAsync(80_000);
      expect(inbox() - fine).toBeGreaterThanOrEqual(3);
      await app.home();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("holds back the engine's and the socket's syncs, until the socket opens or the device is back online", async () => {
    const trouble: Outcome[] = [];
    const server = fakeServer({ inbox: trouble });
    const issuer: TokenIssuer = { key: {} as IssuerKey, keyId: new Uint8Array(32) };
    const { db } = await registered(server.api, { issuer });
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      static OPEN = 1;
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        sockets.push(this);
      }
      send() {}
      close() {
        this.readyState = 3;
      }
      open() {
        this.readyState = 1;
        this.onopen?.();
      }
      hint() {
        this.onmessage?.({ data: '{"t":"sync"}' });
      }
    }
    const listeners = new Map<string, () => void>();
    let online = true;
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal('window', { addEventListener: (type: string, fn: () => void) => listeners.set(type, fn), removeEventListener: (type: string) => listeners.delete(type) });
    vi.stubGlobal('WebSocket', FakeSocket);
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const unavailable = () => new ApiError(503, 'unavailable', undefined, undefined, 2);
    try {
      for (let i = 0; i < 50; i++) trouble.push(unavailable());
      engines.deps.length = 0;
      const { app } = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db, issuer, background: true, config: { ...config, wsUrl: 'wss://ws.example/live' } });
      await app.start();
      await vi.advanceTimersByTimeAsync(0);
      const inbox = () => server.calls.filter((c) => c === 'GET /inbox').length;
      const engine = engines.deps.at(-1)!;
      expect(sockets).toHaveLength(1);
      const socket = sockets[0]!;

      // The first sync failed: what the engine (a chat no longer busy, a
      // pause over) and the socket ask for waits, and comes as one sync.
      let before = inbox();
      engine.onWaiting?.();
      engine.onResume?.();
      socket.hint();
      await vi.advanceTimersByTimeAsync(0);
      expect(inbox()).toBe(before);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(inbox()).toBe(before + 1);

      // The socket opening ends the wait, and syncs at once.
      before = inbox();
      socket.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(inbox()).toBe(before + 1);
      // So does the device coming back online.
      before = inbox();
      listeners.get('online')!();
      await vi.advanceTimersByTimeAsync(0);
      expect(inbox()).toBe(before + 1);

      // No answer while the device says it's offline doesn't count: the
      // next push syncs as soon as the device's pace allows.
      trouble.length = 0;
      listeners.get('online')!();
      await vi.advanceTimersByTimeAsync(0);
      online = false;
      trouble.push(new NetworkError('request failed'), new NetworkError('request failed'));
      before = inbox();
      socket.hint();
      await vi.advanceTimersByTimeAsync(SYNC_GAP_MS);
      expect(inbox()).toBe(before + 1);
      socket.hint();
      await vi.advanceTimersByTimeAsync(2 * SYNC_GAP_MS);
      expect(inbox()).toBe(before + 2);
      online = true;

      // A sync asked for while one is failing doesn't run right after it,
      // but when the wait is over.
      await vi.advanceTimersByTimeAsync(2 * SYNC_GAP_MS);
      trouble.push(unavailable(), unavailable());
      let release!: () => void;
      server.state.inboxGate = new Promise((resolve) => (release = resolve));
      before = inbox();
      socket.hint();
      await vi.advanceTimersByTimeAsync(0);
      socket.hint();
      server.state.inboxGate = null;
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(inbox()).toBe(before + 1);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(inbox()).toBe(before + 2);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      Reflect.deleteProperty(navigator, 'onLine');
    }
  });
});

describe('the syncs the app asks for by itself', () => {
  // The server's limits on a device's requests with a session
  // (backend/internal/api/devices.go): 180 a minute, 1,200 a quarter of an
  // hour. Pushes, however many, and however many copies are open, must
  // stay well under half of each, so nobody writing to someone can use
  // them up.
  const PER_MINUTE = 180;
  const PER_QUARTER = 1200;
  // What storage does between fake ticks (it runs on real ones: Node's
  // setImmediate, which fake timers leave alone).
  const { setImmediate: immediate } = globalThis as unknown as { setImmediate: (fn: () => void) => void };
  // WebCrypto (signing a login) runs on Node's own threads, in real time:
  // however long a machine as busy as CI's takes. The fake clock waits for it
  // (watchCrypto), as if it took no time, as next to these seconds it nearly
  // does. Otherwise the login a sync waits for, once a quarter of an hour,
  // took as many fake seconds as the machine was slow, and the messages that
  // sync took in waited as much longer (34 seconds, once, in CI).
  const crypting = new Set<Promise<unknown>>();
  /** WebCrypto, watched so that settle waits for it; undone by done. */
  const watched: { mockRestore(): void }[] = [];
  function watchCrypto(): void {
    const subtle = crypto.subtle as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const name of ['encrypt', 'decrypt', 'sign', 'verify', 'digest', 'generateKey', 'deriveKey', 'deriveBits', 'importKey', 'exportKey', 'wrapKey', 'unwrapKey']) {
      const original = subtle[name]!.bind(crypto.subtle);
      const spy = vi.spyOn(subtle, name).mockImplementation((...args: unknown[]) => {
        const work: Promise<unknown> = original(...args).finally(() => crypting.delete(work));
        crypting.add(work);
        return work;
      });
      watched.push(spy);
    }
  }
  const settle = async () => {
    for (let i = 0; i < 30; i++) {
      await new Promise<void>((resolve) => immediate(resolve));
      while (crypting.size > 0) {
        await Promise.allSettled(crypting);
        await new Promise<void>((resolve) => immediate(resolve));
      }
    }
  };
  /**
   * Moves the fake clock on by ms, a timer at a time, letting storage and
   * WebCrypto work after each: no timer fires while WebCrypto is at work.
   */
  const pass = async (ms: number) => {
    const end = Date.now() + ms;
    // The last timer on the way, so that it stops at end.
    const stop = setTimeout(() => {}, ms);
    while (Date.now() < end) {
      await vi.advanceTimersToNextTimerAsync();
      await settle();
    }
    clearTimeout(stop);
  };

  /**
   * A device with `count` copies of the app open, each with its push
   * socket, on fake timers from the start of a quarter of an hour, and its
   * inbox as the server keeps it until confirmed, with its limit on
   * fetches that read something (30 a minute, InboxUnitsPerMinute).
   * fetchMs: how long each fetch takes; tellMs: how late the copies hear
   * of each other (the broadcast channel); refuse: an answer instead for
   * the nth fetch that would read something (1 is the first). The caller
   * undoes the fake timers and the stubs (done).
   */
  async function device(count: number, options: { fetchMs?: number; tellMs?: number; refuse?: (n: number) => ApiError | null } = {}) {
    const base = fakeServer();
    const issuer: TokenIssuer = { key: {} as IssuerKey, keyId: new Uint8Array(32) };
    const { db } = await registered(base.api, { issuer });
    const waiting = new Map<string, number>(); // item ID -> when delivered
    const waited: number[] = []; // how long each confirmed item waited
    const reads = new Map<number, number>();
    const requests: number[] = []; // when each request with a session went
    const fetches: number[] = []; // when each fetch of the inbox started
    const events: SyncEvent[] = [];
    let read = 0;
    const api: Api = {
      post: (path, body, check) => api.request('POST', path, { body: JSON.stringify(body) }, check),
      async request(method, path, init, check) {
        if (init.headers?.['X-Session']) requests.push(Date.now());
        if (method === 'GET' && path.startsWith('/inbox')) {
          fetches.push(Date.now());
          if (options.fetchMs) await new Promise((resolve) => setTimeout(resolve, options.fetchMs));
          if (waiting.size === 0) return check({ items: [], more: false });
          const refused = options.refuse?.(++read);
          if (refused) throw refused;
          const minute = Math.floor(Date.now() / 60_000);
          if ((reads.get(minute) ?? 0) >= 30) throw new ApiError(429, 'rate_limited');
          reads.set(minute, (reads.get(minute) ?? 0) + 1);
          const ids = [...waiting.keys()].slice(0, 50);
          const more = waiting.size > ids.length;
          return check({ items: ids.map((id) => ({ id, mailbox: 'MMMMMMMMMMMMMMMMMMMMMM', envelope: 'AAAA' })), more, ...(more ? { next: 'NNNNNNNNNNNNNNNNNNNNNN' } : {}) });
        }
        if (method === 'POST' && path === '/ack') {
          for (const id of (JSON.parse(init.body!) as { ids: string[] }).ids) {
            const at = waiting.get(id);
            if (at !== undefined) waited.push(Date.now() - at);
            waiting.delete(id);
          }
          return check({});
        }
        // Logins, by the device's clock: the server's agrees with it. (The
        // fake server goes by the real clock, which this fake one, set to
        // the next quarter of an hour and run on 15 minutes in a moment,
        // leaves behind: whether a login is answered clock_skew first would
        // depend on the time of day.)
        if (path === '/session') return check({ account: base.state.accountId, token: 'v1.p.m', expires: Math.floor(Date.now() / 1000) + 900 });
        return base.api.request(method, path, init, check);
      },
    };
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      static OPEN = 1;
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        sockets.push(this);
        void Promise.resolve().then(() => {
          this.readyState = 1;
          this.onopen?.();
        });
      }
      send() {}
      close() {
        this.readyState = 3;
      }
    }
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(Math.ceil(Date.now() / (15 * 60_000)) * 15 * 60_000);
    watchCrypto();
    // The copies tell each other what they do, as the broadcast channel
    // does, tellMs late.
    const copies: ReturnType<typeof createApp>[] = [];
    const tell = (from: number) => (e: SyncEvent) => {
      events.push(e);
      const deliver = () =>
        copies.forEach((c, i) => {
          if (i === from) return;
          if (e.type === 'sync-started') c.syncStarted(e.at, e.paced);
          if (e.type === 'data-changed') void c.refresh();
        });
      if (options.tellMs) setTimeout(deliver, options.tellMs);
      else deliver();
    };
    for (let i = 0; i < count; i++) {
      const { app } = await setup({ api, bridge: fakeBridge().bridge, launch: launchWith(''), db, issuer, background: true, config: { ...config, wsUrl: 'wss://ws.example/live' }, broadcast: tell(i) });
      copies.push(app);
    }
    // Starting syncs, which may wait for the fake clock (fetchMs).
    let started = false;
    const starting = Promise.all(copies.map((c) => c.start())).then(() => (started = true));
    while (!started) await pass(100);
    await starting;
    let n = 0;
    return {
      copies,
      sockets,
      waiting,
      waited,
      requests,
      fetches,
      events,
      /** Delivers `messages` messages, each pushing a hint to every open copy. */
      push(messages = 1) {
        for (let i = 0; i < messages; i++) {
          waiting.set(`m${n++}`, Date.now());
          for (const ws of sockets) if (ws.readyState === 1) ws.onmessage?.({ data: '{"t":"sync"}' });
        }
      },
    };
  }

  const done = () => {
    for (const spy of watched.splice(0)) spy.mockRestore();
    crypting.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  };

  it('costs the device under half of its request limits, with two copies open, for a whole quarter of an hour', async () => {
    try {
      const d = await device(2);
      expect(d.sockets.length).toBeGreaterThanOrEqual(2);
      const start = Date.now();
      d.requests.length = 0;
      // Four senders, each at the cap of one mailbox (a message every 2
      // seconds), for 15 minutes: 1,800 messages, 3,600 pushes.
      for (let second = 0; second < 15 * 60; second++) {
        if (second % 2 === 0) d.push(4);
        await pass(1000);
      }
      const minutes = new Map<number, number>();
      for (const at of d.requests) {
        const minute = Math.floor((at - start) / 60_000);
        minutes.set(minute, (minutes.get(minute) ?? 0) + 1);
      }
      const busiest = Math.max(...minutes.values());
      const slowest = Math.max(...d.waited);
      // Every message was taken in, a few seconds after it came.
      expect(d.waited).toHaveLength(1800 - d.waiting.size);
      expect(d.waiting.size).toBeLessThanOrEqual(8 * 4);
      expect(slowest).toBeLessThanOrEqual(3 * SYNC_GAP_MS);
      // A sync every 5 seconds, a fetch and a confirmation each: 24 a
      // minute, well under half of the quarter and of any minute.
      expect(d.requests.length).toBeLessThan(PER_QUARTER / 2);
      expect(busiest).toBeLessThanOrEqual(26);
      expect(busiest).toBeLessThan(PER_MINUTE / 2);
      for (const c of d.copies) await c.home();
    } finally {
      done();
    }
  }, 300_000);

  it('takes turns across copies that hear of each other late, and a push that comes while another copy waits is answered by its sync', async () => {
    try {
      const d = await device(2, { fetchMs: 200, tellMs: 50 });
      await pass(2 * SYNC_GAP_MS);
      d.fetches.length = 0;
      const t = Date.now();
      // Both copies hear each push at once.
      d.push();
      await pass(1000);
      d.push();
      await pass(11_000);
      // One copy synced at once; the other waited the gap, then synced; the
      // second push came while they waited, and made no fetch of its own.
      expect(d.fetches.map((f) => f - t)).toEqual([0, SYNC_GAP_MS]);
      for (const c of d.copies) await c.home();
    } finally {
      done();
    }
  }, 60_000);

  it('still syncs on pushes after the clock was set back, or another copy said it synced later than now', async () => {
    try {
      const d = await device(1);
      await pass(2 * SYNC_GAP_MS);
      d.push();
      await pass(SYNC_GAP_MS);
      // The clock set back ten minutes: pushes are still fetched for.
      vi.setSystemTime(Date.now() - 10 * 60_000);
      let before = d.fetches.length;
      for (let i = 0; i < 3; i++) {
        d.push();
        await pass(2 * SYNC_GAP_MS);
      }
      expect(d.fetches.length - before).toBe(3);
      // A start said to be ten minutes from now (sent before the clock was
      // set back) is ignored.
      d.copies[0]!.syncStarted(Date.now() + 10 * 60_000, true);
      before = d.fetches.length;
      d.push();
      await pass(2 * SYNC_GAP_MS);
      expect(d.fetches.length - before).toBe(1);
      await d.copies[0]!.home();
    } finally {
      done();
    }
  }, 60_000);

  it("doesn't start syncs that can't fetch while the inbox is paused", async () => {
    try {
      // The second page is refused: fetching pauses, 30 to 60 seconds.
      const d = await device(1, { refuse: (n) => (n === 2 ? new ApiError(429, 'rate_limited') : null) });
      await pass(2 * SYNC_GAP_MS);
      d.events.length = 0;
      d.push(80);
      await pass(25_000);
      // The first page, then the refused one: no more while paused.
      const paced = d.events.filter((e) => e.type === 'sync-started' && e.paced);
      expect(paced.length).toBeLessThanOrEqual(3);
      await d.copies[0]!.home();
    } finally {
      done();
    }
  }, 60_000);
});

describe('an open chat', () => {
  it('shows a message that comes dated before all it shows, as the inbox gives them in no set order', async () => {
    const { app, db } = await registered(fakeServer().api);
    await chatOnDevice(db);
    await deleteMessage(db, 'c1', 'm1');
    const S = 1_800_000_000_000;
    await addMessage(db, { id: 'second', conv: 'c1', at: S + 1000, out: false, status: 'read' }, { text: 'second' });
    await app.openConversation('c1');
    expect(app.screen.value).toMatchObject({ kind: 'conversation', messages: [{ id: 'second' }], more: false });

    // The one written before it comes in a later sync.
    await addMessage(db, { id: 'first', conv: 'c1', at: S, out: false, status: 'received' }, { text: 'first' });
    await app.refresh();
    expect(app.screen.value).toMatchObject({ kind: 'conversation', messages: [{ id: 'first' }, { id: 'second' }], more: false });
  });

  // These apps have no messaging engine (the build's issuer key here isn't
  // a real one): nothing in an open chat is drawn by itself (no "seen", no
  // downloads), so the draws below are the tests' own.

  /** Chat c1 with `count` messages after its first (m1): n0, n1… a second apart. Returns their IDs, m1 first. */
  async function longChat(db: Awaited<ReturnType<typeof openDatabase>>, count: number): Promise<string[]> {
    await chatOnDevice(db);
    const ids = ['m1', ...Array.from({ length: count }, (_, i) => `n${i}`)];
    for (const [i, id] of ids.slice(1).entries()) await addMessage(db, { id, conv: 'c1', at: 1_800_000_000_000 + i * 1000, out: false, status: 'read' }, { text: id });
    return ids;
  }
  type Chat = Extract<Screen, { kind: 'conversation' }>;
  function chatOf(screen: Screen): Chat {
    if (screen.kind !== 'conversation') throw new Error(`expected conversation, got ${screen.kind}`);
    return screen;
  }

  it('keeps older messages loaded on purpose, however often the chat changes while it is drawn again', async () => {
    const { app, db } = await registered(fakeServer().api);
    const ids = await longChat(db, PAGE + 5);
    const chat = () => chatOf(app.screen.value);
    const shown = () => [chat().messages.map((m) => m.id), chat().more];
    await app.openConversation('c1');
    expect(shown()).toEqual([ids.slice(-PAGE), true]);
    // Scrolled up: the rest. What that draws stands in below for older ones
    // that load while the chat is being drawn again.
    expect(await app.loadOlder()).toBe(true);
    const loaded = chat();
    expect(shown()).toEqual([ids, false]);

    // Opened again, at its newest. While a redraw reads its page (slowly, as
    // when a write holds IndexedDB up), the chat is drawn again, twice, then
    // the older ones load: each time it has read, the screen has changed.
    // (Set here by the test: in the app, only a reaction shown at once
    // changes the screen while a draw is under way; what this pins is that
    // a draw builds its page again then, however often.)
    await app.openConversation('c1');
    const meanwhile: ((s: Chat) => Chat)[] = [
      (s) => ({ ...s, messages: [...s.messages] }),
      (s) => ({ ...s, messages: [...s.messages] }),
      (s) => ({ ...s, messages: loaded.messages, more: loaded.more, quoted: loaded.quoted }),
    ];
    pageReads.during = () => {
      const change = meanwhile.shift();
      if (change) app.screen.value = change(chat());
    };
    try {
      await app.refresh();
    } finally {
      pageReads.during = null;
    }
    expect(meanwhile).toHaveLength(0);
    expect(shown()).toEqual([ids, false]);

    // The app's own draws, asked for all at once (a refresh, slow to read,
    // a scroll up, two more refreshes): drawn one at a time, each from the
    // screen the one before left, so the older ones stay and a new one
    // shows. The page would be right side by side too (a draw builds again
    // on a changed screen): what shows they wait their turn is that none
    // reads while the first is under way, and the two refreshes asked for
    // while another waits join it (one read for both).
    await app.openConversation('c1');
    await addMessage(db, { id: 'new', conv: 'c1', at: 1_800_000_000_000 + ids.length * 1000, out: false, status: 'read' }, { text: 'new' });
    const first = holdRead('pageMessages');
    pageReads.count = 0;
    const draws = [app.refresh(), app.loadOlder(), app.refresh(), app.refresh()];
    await first.atRead;
    await tick();
    expect(pageReads.count).toBe(1);
    first.release();
    expect(await Promise.all(draws)).toEqual([undefined, true, undefined, undefined]);
    expect(shown()).toEqual([[...ids, 'new'], false]);
    expect(pageReads.count).toBe(3);
  });

  it('opens a chat again in its turn: a page read before a redraw is never drawn over it', async () => {
    const { app, db } = await registered(fakeServer().api);
    await chatOnDevice(db);
    await app.openConversation('c1');
    // Opened again while it's shown (as Unblock does), and the page that
    // reads (the newest PAGE of a chat shown afresh) is slow to come back.
    const opening = holdRead('pageMessages', ([, , options]) => (options as { count?: number; since?: number }).count === PAGE);
    const reopened = app.openConversation('c1');
    await opening.atRead;
    // Meanwhile a message comes in, and the chat is to be drawn again for
    // it: after the opening's page, not before (that page, read before the
    // message came, would then be drawn over it). It reads nothing until then.
    await addMessage(db, { id: 'm2', conv: 'c1', at: 2, out: false, status: 'read' }, { text: 'new' });
    const reads = pageReads.count;
    const redrawn = app.refresh();
    await tick();
    expect(pageReads.count).toBe(reads);
    opening.release();
    await Promise.all([reopened, redrawn]);
    expect(chatOf(app.screen.value).messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('jumps to a quote tapped while older messages are loading, once they have', async () => {
    const { app, db } = await registered(fakeServer().api);
    // More than two pages after the first message, which is quoted.
    const ids = await longChat(db, 2 * PAGE + 5);
    await app.openConversation('c1');
    // Scrolled up: PAGE more, slow to come. The quote tapped meanwhile: all
    // from its message on, after those.
    const scrolling = holdRead('pageMessages');
    const scrolled = app.loadOlder();
    await scrolling.atRead;
    const jumped = app.loadOlder('m1');
    // Another scroll up meanwhile asks for nothing: those loading are what it would.
    expect(await app.loadOlder()).toBe(false);
    scrolling.release();
    expect(await Promise.all([scrolled, jumped])).toEqual([true, true]);
    expect([chatOf(app.screen.value).messages.map((m) => m.id), chatOf(app.screen.value).more]).toEqual([ids, false]);
  });

  it('shows ours left sending as not sent: at start, and in the open chat after a while, but not while a copy sends them', async () => {
    const server = fakeServer();
    const { db } = await registered(server.api);
    await chatOnDevice(db);
    const now = Date.now();
    // The app closed while sending one; another copy of the app is sending the other.
    await addMessage(db, { id: 'closed', conv: 'c1', at: now - 1000, out: true, status: 'sending' }, { text: 'closed' });
    await addMessage(db, { id: 'live', conv: 'c1', at: now - STUCK_MS + 2000, out: true, status: 'sending' }, { text: 'live' });
    let taken!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => (taken = resolve));
    const sending = withLock(sendingLock('c1', 'live'), async () => {
      taken();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await holding;
    const statuses = async () => (await listMessages(db, 'c1')).filter((m) => m.out).map((m) => `${m.id} ${m.status}`);

    const { app, broadcasts } = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db });
    await app.start();
    expect(await statuses()).toEqual(['live sending', 'closed failed']);
    expect(broadcasts).toContainEqual({ type: 'data-changed' });

    // That copy closes too. In the open chat, it shows as sending until it's
    // been so for a minute, then as not sent, with nothing else redrawing it.
    release();
    await sending;
    await app.openConversation('c1');
    expect(await statuses()).toEqual(['live sending', 'closed failed']);
    await vi.waitFor(
      () => expect(app.screen.value).toMatchObject({ kind: 'conversation', messages: [{ id: 'm1' }, { id: 'live', status: 'failed' }, { id: 'closed', status: 'failed' }] }),
      { timeout: 8_000, interval: 100 },
    );
    expect(await statuses()).toEqual(['live failed', 'closed failed']);

    // Once the chat is left, it isn't looked at again: only when it opens.
    await addMessage(db, { id: 'left', conv: 'c1', at: Date.now() - STUCK_MS + 1000, out: true, status: 'sending' }, { text: 'left' });
    await app.refresh();
    const shown = app.screen.value;
    expect(shown.kind === 'conversation' && shown.messages.find((m) => m.id === 'left')).toMatchObject({ status: 'sending' });
    await app.home();
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(await statuses()).toEqual(['live failed', 'left sending', 'closed failed']);
    await app.openConversation('c1');
    expect(await statuses()).toEqual(['live failed', 'left failed', 'closed failed']);
  }, 20_000);
});

describe('links', () => {
  it('creates a link with signed requests, and others can verify it', async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    await owner.app.createLink();
    const screen = home(owner.app.screen.value);
    expect(screen.notice).toBe('created');
    expect(screen.links).toHaveLength(1);
    const url = screen.links[0]!.url;
    expect(url).toMatch(/^https:\/\/t\.me\/test_bot\?startapp=1[A-Za-z0-9_-]{54}$/);
    expect(server.unsigned).toEqual([]);

    // Someone else opens it: the bundle must match the fingerprint in the link.
    const sender = await registered(server.api, { launch: launchWith(payloadOf(url)) });
    expect(sender.app.screen.value).toMatchObject({ kind: 'link', status: 'verified' });

    // The owner opening their own link is told so.
    const { app: ownerAgain } = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(payloadOf(url)), db: owner.db });
    await ownerAgain.start();
    expect(ownerAgain.screen.value).toMatchObject({ kind: 'link', status: 'own' });
  });

  it("leaves someone's link for the Chats tab", async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    await owner.app.createLink();
    const url = home(owner.app.screen.value).links[0]!.url;
    const sender = await registered(server.api, { launch: launchWith(payloadOf(url)) });
    expect(sender.app.screen.value).toMatchObject({ kind: 'link', status: 'verified' });
    // Home, as the link screen's button did before it asked for Chats itself (app.chats, below).
    await sender.app.home();
    expect(sender.app.screen.value).toMatchObject({ kind: 'home', tab: 'chats' });
  });

  it('goes to the Chats tab from anywhere, whatever tab was open last', async () => {
    const server = fakeServer();
    const { app } = await registered(server.api);
    await app.showTab('settings');
    expect(app.screen.value).toMatchObject({ kind: 'home', tab: 'settings' });
    await app.chats();
    expect(app.screen.value).toMatchObject({ kind: 'home', tab: 'chats' });
    // Remembered from here on: home again stays on Chats.
    await app.home();
    expect(app.screen.value).toMatchObject({ kind: 'home', tab: 'chats' });
  });

  it('catches a server that swaps the keys', async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    await owner.app.createLink();
    const payload = payloadOf(home(owner.app.screen.value).links[0]!.url);

    // The server serves another link's bundle under this link's ID.
    const other = await registered(server.api);
    await other.app.createLink();
    const id = payload.slice(1, 12);
    const otherId = [...server.bundles.keys()].find((k) => k !== id)!;
    server.bundles.set(id, server.bundles.get(otherId)!);

    const sender = await registered(server.api, { launch: launchWith(payload) });
    expect(sender.app.screen.value).toMatchObject({ kind: 'link', status: 'mismatch' });
  });

  it('revokes a link, after which it is not found', async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    await owner.app.createLink();
    const link = home(owner.app.screen.value).links[0]!;
    await owner.app.revokeLink(link.id);
    expect(home(owner.app.screen.value)).toMatchObject({ notice: 'revoked', links: [] });
    expect(server.bundles.size).toBe(0);
    expect(server.unsigned).toEqual([]);

    const sender = await registered(server.api, { launch: launchWith(payloadOf(link.url)) });
    expect(sender.app.screen.value).toMatchObject({ kind: 'link', status: 'not-found' });
  });

  it('makes the link with a new signing key when another account has the old one, and says so once', async () => {
    const server = fakeServer({ createLink: [new ApiError(409, 'signing_key_taken')] });
    const owner = await registered(server.api);
    await owner.app.createLink();
    const screen = home(owner.app.screen.value);
    expect(screen).toMatchObject({ notice: 'new-signing-key' });
    expect(screen.links).toHaveLength(1);
    expect(server.bundles.size).toBe(1);
    await owner.app.home();
    expect(home(owner.app.screen.value).notice).toBeNull();
  });

  it("says the link has a new key though the new link's answer was lost, at the next home screen", async () => {
    const server = fakeServer({ createLink: [new ApiError(409, 'signing_key_taken')] });
    const owner = await registered(server.api);
    // Refused once (the key is taken), then made with a new key, but the answer is lost.
    const request = server.api.request;
    let posts = 0;
    server.api.request = async function (method, path, init, check) {
      if (method !== 'POST' || path !== '/links' || ++posts < 2) return request(method, path, init, check);
      server.api.request = request;
      await request(method, path, init, check);
      throw new NetworkError('answer lost');
    } as Api['request'];
    await owner.app.createLink();
    // The error is said first; the new key waits, kept on the device.
    expect(home(owner.app.screen.value)).toMatchObject({ notice: 'network' });
    await owner.app.refresh();
    expect(home(owner.app.screen.value)).toMatchObject({ notice: 'network' });
    await owner.app.home();
    expect(home(owner.app.screen.value)).toMatchObject({ notice: 'new-signing-key' });
    // A redraw keeps it; the next home screen doesn't say it again.
    await owner.app.refresh();
    expect(home(owner.app.screen.value)).toMatchObject({ notice: 'new-signing-key' });
    await owner.app.home();
    expect(home(owner.app.screen.value).notice).toBeNull();
  });

  it('says when an invitation is needed', async () => {
    const server = fakeServer({ createLink: [new ApiError(403, 'invitation_required')] });
    const owner = await registered(server.api);
    await owner.app.createLink();
    expect(home(owner.app.screen.value)).toMatchObject({ notice: 'invitation', links: [] });
    server.state.inviteOnly = true;
    await owner.app.home();
    expect(home(owner.app.screen.value).account?.canCreateLinks).toBe(false);
  });

  it('shows a link the server made though the answer was lost, once upkeep finds it, here and in other copies', async () => {
    const account: Outcome[] = [];
    const server = fakeServer({ account });
    const owner = await registered(server.api);
    // Made on the server, but the answer is lost.
    const request = server.api.request;
    server.api.request = async function (method, path, init, check) {
      if (method !== 'POST' || path !== '/links') return request(method, path, init, check);
      server.api.request = request;
      await request(method, path, init, check);
      throw new NetworkError('answer lost');
    } as Api['request'];
    await owner.app.createLink();
    expect(home(owner.app.screen.value)).toMatchObject({ notice: 'network', links: [] });
    const [made] = [...server.bundles.keys()];

    // The next launch: upkeep runs in the background soon after it opens.
    const issuer: TokenIssuer = { key: {} as IssuerKey, keyId: new Uint8Array(32) };
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} });
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const { app, broadcasts } = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db: owner.db, issuer, background: true });
      await app.start();
      random.mockRestore();
      expect(home(app.screen.value).links).toEqual([]);
      const before = broadcasts.length;
      await vi.waitFor(() => expect(home(app.screen.value).links.map((l) => l.id)).toEqual([made]), { timeout: 4_000, interval: 50 });
      expect(broadcasts.slice(before)).toContainEqual({ type: 'data-changed' });
      // Stops the background (and so this test's timers).
      account.push(new ApiError(401, 'login_refused'));
      await app.home();
      expect(app.screen.value.kind).toBe('signed-out');
    } finally {
      random.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('continues to a link opened before setup', async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    await owner.app.createLink();
    const payload = payloadOf(home(owner.app.screen.value).links[0]!.url);

    // A new user opens the link, then sets up through the registration launch.
    const db = await openDatabase(`app-test-${n++}`);
    const first = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(payload), db });
    await first.app.start();
    expect(first.app.screen.value.kind).toBe('welcome');
    expect(await getMeta(db, 'pending-link')).toBe(payload);
    await first.app.setUp();
    const code = 'reg' + (await readAccount(db))!.fingerprint;
    const second = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(code), db });
    await second.app.start();
    expect(second.app.screen.value).toMatchObject({ kind: 'link', status: 'verified' });
    expect(await getMeta(db, 'pending-link')).toBeUndefined();
  });
});

describe('deleting the account', () => {
  it('deletes it on the server with a signed request, then everything on the device', async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    await owner.app.createLink();
    owner.app.askDeleteAccount();
    expect(owner.app.screen.value).toEqual({ kind: 'confirm-delete', busy: false, error: null });
    await owner.app.deleteAccount();
    expect(server.state.deleted).toBe(true);
    expect(server.unsigned).toEqual([]);
    expect(owner.app.screen.value).toEqual({ kind: 'welcome', mismatch: false, deleted: true });
    expect(await readAccount(owner.db)).toBeUndefined();
    expect(await getMeta(owner.db, 'links')).toBeUndefined();
  });

  it('keeps everything, and says so, when the server can\'t be reached', async () => {
    const server = fakeServer({ deleteAccount: [new NetworkError('offline')] });
    const owner = await registered(server.api);
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    expect(owner.app.screen.value).toEqual({ kind: 'deleting', error: 'network' });
    expect(await readAccount(owner.db)).toMatchObject({ state: 'registered' });
    // Confirmed: it goes ahead, now or at the next launch.
    expect(await getMeta(owner.db, 'deleting')).toEqual({ accountId: 'BBBBBBBBBBBBBBBBBBBBBB' });
    // Trying again works.
    await owner.app.continueDeletion();
    expect(owner.app.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
    expect(await getMeta(owner.db, 'deleting')).toBeUndefined();
  });

  it('carries on at the next launch when the app closed halfway', async () => {
    const step = new ApiError(409, 'in_progress');
    const server = fakeServer({ deleteAccount: [step, new NetworkError('closed')] });
    const owner = await registered(server.api);
    await chatOnDevice(owner.db);
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    expect(owner.app.screen.value).toEqual({ kind: 'deleting', error: 'network' });
    expect(await listMessages(owner.db, 'c1')).toHaveLength(1);

    // The app restarts: the deletion carries on, before anything else is asked.
    server.calls.length = 0;
    const again = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db: owner.db });
    await again.app.start();
    expect(again.app.screen.value).toEqual({ kind: 'welcome', mismatch: false, deleted: true });
    expect(server.calls).toEqual(['POST /session', 'DELETE /account']);
    expect(server.unsigned).toEqual([]);
    expect(await readAccount(owner.db)).toBeUndefined();
    expect(await listMessages(owner.db, 'c1')).toHaveLength(0);
  });

  it('finishes at the next launch when the deletion was done but its answer lost', async () => {
    const server = fakeServer({ deleteAccount: [new NetworkError('lost')] });
    const owner = await registered(server.api);
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    // The server finished it: the device no longer logs in.
    server.outcomes.session = [new ApiError(401, 'login_refused')];
    const again = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db: owner.db });
    await again.app.start();
    expect(again.app.screen.value).toEqual({ kind: 'welcome', mismatch: false, deleted: true });
    expect(await readAccount(owner.db)).toBeUndefined();
  });

  it('says so offline at the next launch, and carries on when asked', async () => {
    const server = fakeServer({ deleteAccount: [new NetworkError('lost')] });
    const owner = await registered(server.api);
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    server.outcomes.session = [new NetworkError('offline')];
    const again = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db: owner.db });
    await again.app.start();
    expect(again.app.screen.value).toEqual({ kind: 'deleting', error: 'network' });
    await again.app.continueDeletion();
    expect(again.app.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
  });

  it("doesn't take the server's word that the account is being deleted: the chats stay until the user confirms", async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    await chatOnDevice(owner.db);
    // Started by another copy of the app, or said by a server that lies.
    server.state.deleting = true;
    await owner.app.home();
    expect(owner.app.screen.value).toEqual({ kind: 'signed-out', reason: 'deleting', busy: false, offline: false });
    expect(server.calls).not.toContain('DELETE /account');
    expect(await getMeta(owner.db, 'deleting')).toBeUndefined();
    expect(await readAccount(owner.db)).toMatchObject({ state: 'registered' });
    // The chats stay readable.
    await owner.app.readChats();
    expect(home(owner.app.screen.value)).toMatchObject({ signedOut: 'deleting' });
    expect(await listMessages(owner.db, 'c1')).toHaveLength(1);
    // Finishing it takes the same typed confirmation; cancelling goes back.
    owner.app.askDeleteAccount();
    await owner.app.cancelDeleteAccount();
    expect(owner.app.screen.value).toMatchObject({ kind: 'signed-out', reason: 'deleting' });
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    expect(owner.app.screen.value).toEqual({ kind: 'welcome', mismatch: false, deleted: true });
    expect(server.state.deleted).toBe(true);
    expect(await readAccount(owner.db)).toBeUndefined();
  });

  it('never wipes the device when the server says it is deleting the account, then refuses the login', async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    await chatOnDevice(owner.db);
    server.state.deleting = true;
    await owner.app.home();
    expect(owner.app.screen.value).toMatchObject({ kind: 'signed-out', reason: 'deleting' });
    // At the next launch the server refuses the device.
    server.outcomes.session = [new ApiError(401, 'login_refused')];
    const again = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db: owner.db });
    await again.app.start();
    expect(again.app.screen.value).toMatchObject({ kind: 'signed-out', reason: 'refused' });
    expect(server.calls).not.toContain('DELETE /account');
    expect(await readAccount(owner.db)).toMatchObject({ state: 'refused' });
    expect(await listMessages(owner.db, 'c1')).toHaveLength(1);
  });

  it("says the account was deleted, not that something may be wrong, when the server's expiry deletes it", async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    await chatOnDevice(owner.db);
    // Nobody used it for 12 months: the server's expiry is deleting it.
    server.state.deleting = true;
    server.state.expired = true;
    await owner.app.home();
    await vi.waitFor(() => expect(owner.app.screen.value).toEqual({ kind: 'signed-out', reason: 'expired', busy: false, offline: false }));
    await vi.waitFor(async () => expect(await readAccount(owner.db)).toMatchObject({ state: 'refused', deleting: true, expired: true }));
    expect(server.calls).not.toContain('DELETE /account');
    expect(await listMessages(owner.db, 'c1')).toHaveLength(1);
    // Once it's gone, the next launch still says it was deleted.
    server.outcomes.session = [new ApiError(401, 'login_refused')];
    const again = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db: owner.db });
    await again.app.start();
    expect(again.app.screen.value).toMatchObject({ kind: 'signed-out', reason: 'expired' });
    expect(await readAccount(owner.db)).toMatchObject({ state: 'refused', expired: true });
    expect(await listMessages(owner.db, 'c1')).toHaveLength(1);
    // Setting up again (a typed confirmation) is what it offers.
    again.app.askReset();
    expect(again.app.screen.value).toEqual({ kind: 'confirm-reset', reason: 'expired' });
    // Let back in (set up again elsewhere, say): that's forgotten.
    server.outcomes.session = [];
    server.state.deleting = false;
    const back = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db: owner.db });
    await back.app.start();
    expect(back.app.screen.value.kind).not.toBe('signed-out');
    expect(await readAccount(owner.db)).toEqual(expect.not.objectContaining({ expired: true }));
  });

  it("learns that the server's expiry deletes the account when another request finds it being deleted first", async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    await chatOnDevice(owner.db);
    server.state.deleting = true;
    server.state.expired = true;
    // The launch's first sync gets account_deleting, which says no more.
    const again = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db: owner.db });
    await again.app.start();
    await vi.waitFor(() => expect(again.app.screen.value).toMatchObject({ kind: 'signed-out', reason: 'expired' }));
    await vi.waitFor(async () => expect(await readAccount(owner.db)).toMatchObject({ state: 'refused', deleting: true, expired: true }));
    expect(server.calls).not.toContain('DELETE /account');
    // The user's own deletion elsewhere is still said as before.
    const other = fakeServer();
    const user = await registered(other.api);
    other.state.deleting = true;
    const launch = await setup({ api: other.api, bridge: fakeBridge().bridge, launch: launchWith(''), db: user.db });
    await launch.app.start();
    await vi.waitFor(async () => expect(await readAccount(user.db)).toMatchObject({ state: 'refused', deleting: true }));
    expect(launch.app.screen.value).toMatchObject({ kind: 'signed-out', reason: 'deleting' });
    expect(await readAccount(user.db)).toEqual(expect.not.objectContaining({ expired: true }));
  });

  it("ignores a deletion record that isn't this account's (left by another copy of the app before a new setup)", async () => {
    for (const record of [{ accountId: 'C'.repeat(22) }, true]) {
      const server = fakeServer();
      const owner = await registered(server.api);
      await chatOnDevice(owner.db);
      await putMeta(owner.db, 'deleting', record);
      // Even with the login refused, nothing is deleted for it.
      server.outcomes.session = [new ApiError(401, 'login_refused')];
      const again = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db: owner.db });
      await again.app.start();
      expect(again.app.screen.value).toMatchObject({ kind: 'signed-out', reason: 'refused' });
      expect(server.calls).not.toContain('DELETE /account');
      expect(await getMeta(owner.db, 'deleting')).toBeUndefined();
      expect(await listMessages(owner.db, 'c1')).toHaveLength(1);
    }
  });

  // Uploads are deleted by the messaging engine, which needs a token issuer.
  const issuer: TokenIssuer = { key: {} as IssuerKey, keyId: new Uint8Array(32) };

  /** A received photo in the chat on the device (chatOnDevice), whose upload the deletion deletes. */
  const photo = (db: Awaited<ReturnType<typeof openDatabase>>) =>
    addMessage(
      db,
      { id: 'p1', conv: 'c1', at: 2, out: false, status: 'received', file: 'remote' },
      { text: '', media: { t: 'photo', s: 10, w: 1, h: 1, m: 'image/jpeg', id: 'upload-p1', k: 'K'.repeat(43), d: 'c2VjcmV0' } },
    );

  it('first fetches the messages still waiting, so their uploads are deleted too, then deletes the account', async () => {
    const server = fakeServer();
    const owner = await registered(server.api, { issuer });
    await chatOnDevice(owner.db);
    // A photo still waiting for the device, which the deletion's fetch brings.
    server.state.onInbox = async () => {
      server.state.onInbox = null;
      await photo(owner.db);
    };
    server.calls.length = 0;
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    expect(owner.app.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
    const at = (call: string) => server.calls.indexOf(call);
    expect(at('GET /inbox')).toBeGreaterThanOrEqual(0);
    expect(at('POST /media/delete')).toBeGreaterThan(at('GET /inbox'));
    expect(at('DELETE /account')).toBeGreaterThan(at('POST /media/delete'));
    expect(server.state.deletedUploads).toEqual(['upload-p1']);
  });

  it('fetches nothing more once the deletion has started: carrying on, or confirming it again, asks only for the deletion', async () => {
    const server = fakeServer({ deleteAccount: [new ApiError(409, 'in_progress'), new NetworkError('offline'), new NetworkError('offline')] });
    const owner = await registered(server.api, { issuer, stepPauseMs: 0 });
    server.calls.length = 0;
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    expect(owner.app.screen.value).toEqual({ kind: 'deleting', error: 'network' });
    const fetches = () => server.calls.filter((c) => c.startsWith('GET /inbox'));
    expect(fetches()).toHaveLength(1);
    // Try again.
    await owner.app.continueDeletion();
    expect(owner.app.screen.value).toEqual({ kind: 'deleting', error: 'network' });
    // The chats meanwhile, then Delete account again.
    await owner.app.readDuringDeletion();
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    expect(owner.app.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
    expect(fetches()).toHaveLength(1);
  });

  it('fetches nothing when finishing a deletion the server says is under way', async () => {
    const server = fakeServer();
    const owner = await registered(server.api, { issuer });
    // Started by another copy of the app, or said by a server that lies.
    server.state.deleting = true;
    await owner.app.home();
    expect(owner.app.screen.value).toMatchObject({ kind: 'signed-out', reason: 'deleting' });
    server.calls.length = 0;
    // Finish deleting.
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    expect(owner.app.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
    expect(server.calls.filter((c) => c.startsWith('GET /inbox'))).toEqual([]);
  });

  it('offers no deleting for both sides when finishing a deletion the server says is under way, and sends nothing if asked', async () => {
    const server = fakeServer();
    const owner = await registered(server.api, { issuer });
    await chatOnDevice(owner.db);
    server.state.deleting = true;
    await owner.app.home();
    expect(owner.app.screen.value).toMatchObject({ kind: 'signed-out', reason: 'deleting' });
    server.calls.length = 0;
    owner.app.askDeleteAccount();
    expect(owner.app.screen.value).toEqual({ kind: 'confirm-delete', busy: false, error: null, finishing: true });
    await owner.app.deleteAccount(true);
    expect(owner.app.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
    expect(server.calls.filter((c) => c.startsWith('POST /send') || c.startsWith('POST /tokens'))).toEqual([]);
  });

  it('offers no deleting for both sides once a deletion has started, and sends nothing if asked', async () => {
    const server = fakeServer({ deleteAccount: [new NetworkError('offline')] });
    const owner = await registered(server.api, { issuer });
    await chatOnDevice(owner.db);
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    expect(owner.app.screen.value).toEqual({ kind: 'deleting', error: 'network' });
    // The chats meanwhile, then Delete account again, ticked.
    await owner.app.readDuringDeletion();
    server.calls.length = 0;
    owner.app.askDeleteAccount();
    expect(owner.app.screen.value).toEqual({ kind: 'confirm-delete', busy: false, error: null, finishing: true });
    await owner.app.deleteAccount(true);
    expect(owner.app.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
    expect(server.calls.filter((c) => c.startsWith('POST /send') || c.startsWith('POST /tokens'))).toEqual([]);
  });

  it("asks, never deleting the account, when ticked but the app can't send (no messaging)", async () => {
    const server = fakeServer();
    // No token issuer: messaging can't start.
    const owner = await registered(server.api);
    await chatOnDevice(owner.db);
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount(true);
    expect(owner.app.screen.value).toEqual({ kind: 'deleting-chats', done: 0, total: 1, stopped: { reason: 'outdated', left: 1 } });
    expect(server.calls).not.toContain('DELETE /account');
    expect(await getMeta(owner.db, 'deleting')).toBeUndefined();
  });

  it('tries the uploads the server could not delete again, waiting longer each time, before deleting the account', async () => {
    const failing = new ApiError(500, 'internal');
    const server = fakeServer({ mediaDelete: [failing, new NetworkError('offline')] });
    const owner = await registered(server.api, { issuer, stepPauseMs: 7 });
    await chatOnDevice(owner.db);
    await photo(owner.db);
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    try {
      owner.app.askDeleteAccount();
      await owner.app.deleteAccount();
      // One step pause, then two.
      expect(timeouts.mock.calls.map((c) => c[1]).filter((ms) => ms === 7 || ms === 14 || ms === 28)).toEqual([7, 14]);
    } finally {
      timeouts.mockRestore();
    }
    const deletes = server.calls.filter((c) => c === 'POST /media/delete');
    expect(deletes).toHaveLength(3);
    expect(server.calls.indexOf('DELETE /account')).toBeGreaterThan(server.calls.lastIndexOf('POST /media/delete'));
    expect(owner.app.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
  });

  it('stops trying them again when another copy changes the account', async () => {
    const failing = new ApiError(500, 'internal');
    const server = fakeServer({ mediaDelete: Array.from({ length: 10 }, () => failing) });
    const owner = await registered(server.api, { issuer, stepPauseMs: 1 });
    await chatOnDevice(owner.db);
    await photo(owner.db);
    // Another copy drops the record meanwhile (it finished, say).
    server.state.onMediaDelete = () => deleteMeta(owner.db, 'deleting');
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    expect(server.calls).not.toContain('DELETE /account');
    // Not tried again: it stopped, and looked again from the start (whose
    // login and usual flush come after).
    const first = server.calls.indexOf('POST /media/delete');
    const login = server.calls.indexOf('POST /session', first);
    expect(login).toBeGreaterThan(first);
    expect(server.calls.slice(first + 1, login)).not.toContain('POST /media/delete');
  });

  it('stops trying them again once its time is up, and goes on with the deletion', async () => {
    const failing = new ApiError(500, 'internal');
    const server = fakeServer({ mediaDelete: Array.from({ length: 10 }, () => failing) });
    const owner = await registered(server.api, { issuer, stepPauseMs: 1 });
    await chatOnDevice(owner.db);
    await photo(owner.db);
    // The first try takes 11 seconds.
    let ahead = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + ahead);
    server.state.onMediaDelete = async () => void (ahead = 11_000);
    try {
      owner.app.askDeleteAccount();
      await owner.app.deleteAccount();
    } finally {
      clock.mockRestore();
    }
    expect(server.calls.filter((c) => c === 'POST /media/delete')).toHaveLength(1);
    expect(server.state.deleted).toBe(true);
    expect(owner.app.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
  });

  it('gives up on them after a few tries, within seconds, and deletes the account anyway: they expire on their own', async () => {
    const failing = new ApiError(500, 'internal');
    const server = fakeServer({ mediaDelete: Array.from({ length: 10 }, () => failing) });
    const owner = await registered(server.api, { issuer, stepPauseMs: 1 });
    await chatOnDevice(owner.db);
    await photo(owner.db);
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    expect(server.calls.filter((c) => c === 'POST /media/delete')).toHaveLength(4);
    expect(server.state.deleted).toBe(true);
    expect(owner.app.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
  });

  it('repeats the request while the server deletes in steps', async () => {
    const step = new ApiError(409, 'in_progress');
    const server = fakeServer({ deleteAccount: [step, step] });
    const owner = await registered(server.api);
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    expect(server.calls.filter((c) => c === 'DELETE /account')).toHaveLength(3);
    expect(server.unsigned).toEqual([]);
    expect(owner.app.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
    expect(await readAccount(owner.db)).toBeUndefined();
  });

  it('finishes when a repeat is refused as a device that no longer exists (an earlier answer was lost)', async () => {
    const server = fakeServer({ deleteAccount: [new NetworkError('lost'), new ApiError(401, 'login_refused')] });
    const owner = await registered(server.api);
    await chatOnDevice(owner.db);
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    expect(owner.app.screen.value).toEqual({ kind: 'deleting', error: 'network' });
    await owner.app.continueDeletion();
    expect(owner.app.screen.value).toEqual({ kind: 'welcome', mismatch: false, deleted: true });
    expect(await readAccount(owner.db)).toBeUndefined();
    expect(await listMessages(owner.db, 'c1')).toHaveLength(0);
  });

  it("doesn't take a not_found for done, and keeps everything", async () => {
    // Older servers answered a conflict in the last step with 404 while the account stayed.
    const server = fakeServer({ deleteAccount: [new ApiError(404, 'not_found')] });
    const owner = await registered(server.api);
    await chatOnDevice(owner.db);
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    expect(owner.app.screen.value).toEqual({ kind: 'deleting', error: 'generic' });
    expect(await readAccount(owner.db)).toMatchObject({ state: 'registered' });
    expect(await listMessages(owner.db, 'c1')).toHaveLength(1);
    // Trying again finishes it.
    await owner.app.continueDeletion();
    expect(owner.app.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
  });

  it('cancels back to the Settings tab, where Delete account is', async () => {
    const owner = await registered(fakeServer().api);
    owner.app.askDeleteAccount();
    await owner.app.cancelDeleteAccount();
    expect(home(owner.app.screen.value).tab).toBe('settings');
  });

  it("never touches the account set up after it: one copy finishes, a new account is set up, the other copy stops", async () => {
    // Copy B deletes account X in steps; between two of them, copy A
    // finishes the deletion and the user sets up Y on the same device.
    const step = new ApiError(409, 'in_progress');
    const server = fakeServer({ deleteAccount: [step, new ApiError(401, 'login_refused')] });
    const b = await registered(server.api);
    await chatOnDevice(b.db);
    b.app.askDeleteAccount();
    const deleting = b.app.deleteAccount();
    await vi.waitFor(() => expect(server.calls.filter((c) => c === 'DELETE /account')).toHaveLength(1));

    // Copy A, meanwhile: X is gone (A wiped the device), and Y is set up,
    // another account.
    await wipe(b.db);
    server.state.deleting = false;
    server.state.accountId = 'CCCCCCCCCCCCCCCCCCCCCC';
    await (await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db: b.db })).app.setUp();
    const code = 'reg' + (await readAccount(b.db))!.fingerprint;
    await (await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(code), db: b.db })).app.start();
    expect(await readAccount(b.db)).toMatchObject({ state: 'registered', accountId: 'CCCCCCCCCCCCCCCCCCCCCC' });

    // B wakes: it neither deletes Y on the server nor wipes this device.
    await deleting;
    expect(server.calls.filter((c) => c === 'DELETE /account')).toHaveLength(1);
    expect(await readAccount(b.db)).toMatchObject({ accountId: 'CCCCCCCCCCCCCCCCCCCCCC' });
    expect(b.app.screen.value.kind).not.toBe('deleting');
    expect(b.app.screen.value).not.toMatchObject({ kind: 'welcome', deleted: true });
  });

  it('stops when another copy changes the account', async () => {
    const step = new ApiError(409, 'in_progress');
    const server = fakeServer({ deleteAccount: [step, step, step] });
    const owner = await registered(server.api);
    owner.app.askDeleteAccount();
    const deleting = owner.app.deleteAccount();
    await vi.waitFor(() => expect(server.calls.filter((c) => c === 'DELETE /account')).toHaveLength(1));
    // Another copy changed things (here: dropped the record): this one
    // stops at once and looks again, without another request.
    await deleteMeta(owner.db, 'deleting');
    server.state.deleting = false;
    await owner.app.accountChanged();
    await deleting;
    expect(server.calls.filter((c) => c === 'DELETE /account')).toHaveLength(1);
    expect(home(owner.app.screen.value)).toBeTruthy();
  });

  it('lets the user read the chats, or delete only from this device, when the server keeps failing', async () => {
    const server = fakeServer({ deleteAccount: [new ApiError(500, 'internal'), new ApiError(500, 'internal')] });
    const owner = await registered(server.api);
    await chatOnDevice(owner.db);
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    expect(owner.app.screen.value).toEqual({ kind: 'deleting', error: 'generic' });

    // Read the chats, read-only (not "signed out": the server refused
    // nothing); Try again there carries on with the deletion.
    await owner.app.readDuringDeletion();
    expect(home(owner.app.screen.value)).toMatchObject({ signedOut: null, deletionPaused: true });
    expect(owner.app.readOnly.value).toBe(true);
    expect(await listMessages(owner.db, 'c1')).toHaveLength(1);
    await owner.app.continueDeletion();
    expect(owner.app.screen.value).toEqual({ kind: 'deleting', error: 'generic' });

    // Or delete everything here, as confirmed: nothing more is asked of the server.
    const asked = server.calls.length;
    await owner.app.deleteHereOnly();
    expect(owner.app.screen.value).toEqual({ kind: 'welcome', mismatch: false, deletedHere: true });
    expect(server.calls.slice(asked)).toEqual([]);
    expect(await readAccount(owner.db)).toBeUndefined();
    expect(await listMessages(owner.db, 'c1')).toHaveLength(0);
  });

  it('carries on a deletion confirmed here (in another copy) when the server says it is under way', async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    // Another copy of the app on this device confirmed it and started.
    await putMeta(owner.db, 'deleting', { accountId: 'BBBBBBBBBBBBBBBBBBBBBB' });
    server.state.deleting = true;
    await owner.app.home();
    await vi.waitFor(() => expect(owner.app.screen.value).toEqual({ kind: 'welcome', mismatch: false, deleted: true }));
    expect(server.state.deleted).toBe(true);
  });

  it('remembers that the server said the account is being deleted, for a launch that can\'t reach it', async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    await chatOnDevice(owner.db);
    server.state.deleting = true;
    await owner.app.home();
    // Stored as refused, with a flag: an older build of the app reads a
    // refused account, never "no account" (whose setup asks for nothing).
    await vi.waitFor(async () => expect(await readAccount(owner.db)).toMatchObject({ state: 'refused', deleting: true }));
    expect(await getMeta(owner.db, 'account')).toMatchObject({ state: 'refused', deleting: true });
    server.outcomes.session = [new NetworkError('offline')];
    const again = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db: owner.db });
    await again.app.start();
    expect(again.app.screen.value).toEqual({ kind: 'signed-out', reason: 'deleting', busy: false, offline: true });
    expect(again.app.readOnly.value).toBe(true);
    expect(await listMessages(owner.db, 'c1')).toHaveLength(1);
  });

  it('never deletes the account set up meanwhile, even from the retry of a request that stalled', async () => {
    // Copy A's DELETE for X stalls; meanwhile X is gone and Y is set up on
    // this device. The stalled request then comes back session_expired:
    // its retry would log in, and sign, as whatever the device holds.
    const server = fakeServer({ deleteAccount: [new ApiError(401, 'session_expired')] });
    const owner = await registered(server.api);
    let release!: () => void;
    server.state.deleteGate = new Promise<void>((resolve) => (release = resolve));
    owner.app.askDeleteAccount();
    const deleting = owner.app.deleteAccount();
    await vi.waitFor(() => expect(server.calls.filter((c) => c === 'DELETE /account')).toHaveLength(1));

    await wipe(owner.db);
    server.state.accountId = 'CCCCCCCCCCCCCCCCCCCCCC';
    await (await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db: owner.db })).app.setUp();
    const code = 'reg' + (await readAccount(owner.db))!.fingerprint;
    await (await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(code), db: owner.db })).app.start();

    server.state.deleteGate = null;
    release();
    await deleting;
    expect(server.calls.filter((c) => c === 'DELETE /account')).toHaveLength(1);
    expect(await readAccount(owner.db)).toMatchObject({ state: 'registered', accountId: 'CCCCCCCCCCCCCCCCCCCCCC' });
    expect(owner.app.screen.value.kind).not.toBe('deleting');
  });

  it('stops after a run of steps that never finishes, and offers the way out', async () => {
    const step = new ApiError(409, 'in_progress');
    const server = fakeServer({ deleteAccount: Array.from({ length: 401 }, () => step) });
    const owner = await registered(server.api, { stepPauseMs: 0 });
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    expect(owner.app.screen.value).toEqual({ kind: 'deleting', error: 'generic' });
    expect(server.calls.filter((c) => c === 'DELETE /account')).toHaveLength(400);
  }, 60_000);

  it('waits out a busy server (503, 429) as long as it asks, then carries on', async () => {
    const server = fakeServer({
      deleteAccount: [new ApiError(503, 'unavailable', undefined, undefined, 1), new ApiError(429, 'rate_limited', undefined, undefined, 1)],
      cleanup: [new ApiError(503, 'unavailable', undefined, undefined, 1)],
    });
    const owner = await registered(server.api, { stepPauseMs: 0 });

    // The cleanup after a replacement too.
    server.state.cleanup = true;
    await owner.app.home();
    await vi.waitFor(() => expect(server.state.cleanup).toBe(false), { timeout: 5_000 });
    expect(server.calls.filter((c) => c === 'POST /account/cleanup')).toHaveLength(2);

    owner.app.askDeleteAccount();
    const started = Date.now();
    await owner.app.deleteAccount();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    expect(owner.app.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
  }, 20_000);

  it("shows the deletion's own screen, never the server's refusal, when the user started it here", async () => {
    // (a) The chats read while the deletion couldn't finish, then Try
    // again, offline; and a launch offline.
    const server = fakeServer({ deleteAccount: [new ApiError(500, 'internal'), new NetworkError('offline')] });
    const owner = await registered(server.api);
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    await owner.app.readDuringDeletion();
    await owner.app.continueDeletion();
    expect(owner.app.screen.value).toEqual({ kind: 'deleting', error: 'network' });
    server.outcomes.session = [new NetworkError('offline')];
    const offline = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db: owner.db });
    await offline.app.start();
    expect(offline.app.screen.value).toEqual({ kind: 'deleting', error: 'network' });

    // (c) The chats read, then Delete account, then Cancel: back to the deletion.
    await offline.app.readDuringDeletion();
    offline.app.askDeleteAccount();
    await offline.app.cancelDeleteAccount();
    expect(offline.app.screen.value).toEqual({ kind: 'deleting', error: 'network' });
  });

  it('shows the deletion the user confirmed, not "started elsewhere", on an offline launch (b)', async () => {
    const server = fakeServer({ deleteAccount: [new NetworkError('offline')] });
    const owner = await registered(server.api);
    // The server said it is being deleted; the user then finished it here.
    server.state.deleting = true;
    await owner.app.home();
    await vi.waitFor(async () => expect(await readAccount(owner.db)).toMatchObject({ state: 'refused', deleting: true }));
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    expect(owner.app.screen.value).toEqual({ kind: 'deleting', error: 'network' });
    server.outcomes.session = [new NetworkError('offline')];
    const again = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db: owner.db });
    await again.app.start();
    expect(again.app.screen.value).toEqual({ kind: 'deleting', error: 'network' });
  });

  it('sets up again as new after deleting from this device only: no other-device screen, no takeover warning', async () => {
    // The first step marked it; the next failed, and kept failing.
    const server = fakeServer({ deleteAccount: [new ApiError(409, 'in_progress'), new ApiError(500, 'internal')], elsewhere: true });
    const owner = await registered(server.api, { stepPauseMs: 0 });
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    await owner.app.deleteHereOnly();
    expect(owner.app.screen.value).toMatchObject({ kind: 'welcome', deletedHere: true });
    // The server still holds the account, being deleted: it isn't counted.
    const plain = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db: owner.db });
    await plain.app.start();
    expect(plain.app.screen.value).toEqual({ kind: 'welcome', mismatch: false });
    await plain.app.setUp();
    const code = 'reg' + (await readAccount(owner.db))!.fingerprint;
    const reg = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(code), db: owner.db });
    await reg.app.start();
    expect(reg.app.screen.value.kind).not.toBe('confirm-replace');
    expect(server.calls.filter((c) => c.startsWith('POST /register')).at(-1)).toBe('POST /register');
    expect(await readAccount(owner.db)).toMatchObject({ state: 'registered' });
  });

  /** Another copy of the app wipes the device and sets up a new account, Y, on db. */
  async function setUpAnother(api: Api, server: ReturnType<typeof fakeServer>, db: Awaited<ReturnType<typeof openDatabase>>) {
    await wipe(db);
    server.state.deleting = false;
    server.state.accountId = 'CCCCCCCCCCCCCCCCCCCCCC';
    await (await setup({ api, bridge: fakeBridge().bridge, launch: launchWith(''), db })).app.setUp();
    const code = 'reg' + (await readAccount(db))!.fingerprint;
    await (await setup({ api, bridge: fakeBridge().bridge, launch: launchWith(code), db })).app.start();
  }

  it("records a stalled request's refusal against the account it was sent as, and shows none of it over the new one", async () => {
    // Copy 1's DELETE for X stalls; copy 2 deletes from this device only
    // and sets up Y, which replaces X. The stalled request then comes back
    // replaced: that's X's, not Y's.
    const server = fakeServer({ deleteAccount: [new ApiError(410, 'account_replaced')] });
    const owner = await registered(server.api);
    let release!: () => void;
    server.state.deleteGate = new Promise<void>((resolve) => (release = resolve));
    owner.app.askDeleteAccount();
    const deleting = owner.app.deleteAccount();
    await vi.waitFor(() => expect(server.calls.filter((c) => c === 'DELETE /account')).toHaveLength(1));
    await setUpAnother(server.api, server, owner.db);
    server.state.deleteGate = null;
    release();
    await deleting;
    expect(await readAccount(owner.db)).toMatchObject({ state: 'registered', accountId: 'CCCCCCCCCCCCCCCCCCCCCC' });
    expect(owner.app.screen.value).not.toMatchObject({ kind: 'signed-out' });
    expect(owner.app.screen.value.kind).not.toBe('deleting');
    expect(owner.app.screen.value).not.toMatchObject({ kind: 'welcome', deleted: true });
  });

  it('reads the new account normally after another copy sets one up while this one read the chats of a deletion', async () => {
    const server = fakeServer({ deleteAccount: [new ApiError(500, 'internal')] });
    const owner = await registered(server.api);
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    await owner.app.readDuringDeletion();
    expect(owner.app.readOnly.value).toBe(true);
    await setUpAnother(server.api, server, owner.db);
    await owner.app.accountChanged();
    expect(home(owner.app.screen.value)).toMatchObject({ deletionPaused: false, signedOut: null });
    expect(owner.app.readOnly.value).toBe(false);
  });

  it('takes "replaced" as done for a deletion confirmed here (set up again elsewhere), during it and at a launch', async () => {
    const replaced = new ApiError(410, 'account_replaced');
    const server = fakeServer({ deleteAccount: [replaced] });
    const owner = await registered(server.api);
    await chatOnDevice(owner.db);
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    expect(owner.app.screen.value).toEqual({ kind: 'welcome', mismatch: false, deleted: true });
    expect(await listMessages(owner.db, 'c1')).toHaveLength(0);

    const later = fakeServer({ deleteAccount: [new NetworkError('offline')] });
    const second = await registered(later.api);
    second.app.askDeleteAccount();
    await second.app.deleteAccount();
    later.outcomes.session = [replaced];
    const again = await setup({ api: later.api, bridge: fakeBridge().bridge, launch: launchWith(''), db: second.db });
    await again.app.start();
    expect(again.app.screen.value).toEqual({ kind: 'welcome', mismatch: false, deleted: true });
    expect(await readAccount(second.db)).toBeUndefined();
  });

  it('takes a login answered for another account as no answer, waited out, never as that account', async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    server.state.accountId = 'CCCCCCCCCCCCCCCCCCCCCC';
    await expect(logIn(owner.db, server.api)).rejects.toBeInstanceOf(NetworkError);
    expect(await readAccount(owner.db)).toMatchObject({ state: 'registered', accountId: 'BBBBBBBBBBBBBBBBBBBBBB' });
  });

  it('reads a "deleting" state stored by builds before refused + deleting as refused, so setup asks first', async () => {
    const owner = await registered(fakeServer().api);
    const record = await getMeta<Record<string, unknown>>(owner.db, 'account');
    await putMeta(owner.db, 'account', { ...record, state: 'deleting' });
    expect(await readAccount(owner.db)).toMatchObject({ state: 'refused', deleting: true, accountId: 'BBBBBBBBBBBBBBBBBBBBBB' });
    await expect(prepareSetup(owner.db)).rejects.toThrow('already set up');
  });

  it('starts nothing in the background when the first sync finds the account being deleted', async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    server.state.deleting = true;
    let visible = 0;
    const bridge: Bridge = {
      transport: 'webview-proxy',
      post: () => {},
      on: (type) => {
        if (type === 'visibility_changed') visible++;
        return () => void (type === 'visibility_changed' && visible--);
      },
    };
    const issuer: TokenIssuer = { key: {} as IssuerKey, keyId: new Uint8Array(32) };
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} });
    try {
      const again = await setup({ api: server.api, bridge, launch: launchWith(''), db: owner.db, issuer, background: true });
      const created = visible; // the app's own listener
      const fetched = server.calls.filter((c) => c === 'GET /inbox').length;
      await again.app.start();
      expect(again.app.screen.value).toMatchObject({ kind: 'signed-out', reason: 'deleting' });
      // No background listener, poll or socket started; one fetch only.
      expect(visible).toBe(created);
      expect(server.calls.filter((c) => c === 'GET /inbox')).toHaveLength(fetched + 1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the server's limit on this device's logins and signed requests", () => {
  // 429 device_limit, for a minute, as the server says (Retry-After).
  const deviceLimit = (seconds = 42) => new ApiError(429, 'device_limit', undefined, undefined, seconds);

  it('says to try again in a minute, never "tomorrow", when a link action is refused', async () => {
    const server = fakeServer({ createLink: [deviceLimit()] });
    const owner = await registered(server.api);
    await owner.app.createLink();
    expect(home(owner.app.screen.value)).toMatchObject({ notice: 'device-limit', links: [] });
    // The link changes' own daily limit still says so.
    server.outcomes.createLink = [new ApiError(429, 'rate_limited')];
    await owner.app.createLink();
    expect(home(owner.app.screen.value)).toMatchObject({ notice: 'rate-limited', links: [] });
  });

  it('says so for a login refused at launch, and for a request whose login is refused', async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    server.outcomes.session = [deviceLimit(), deviceLimit()];
    const logins = () => server.calls.filter((c) => c === 'POST /session').length;
    const before = logins();
    const again = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db: owner.db });
    await again.app.start();
    expect(home(again.app.screen.value)).toMatchObject({ offline: true, notice: 'device-limit' });
    // Joining needs a login, refused too: the device's limit, not the
    // route's own ("Too many tries. Try again tomorrow.").
    await again.app.redeem('abcd-efgh');
    expect(home(again.app.screen.value)).toMatchObject({ notice: 'device-limit' });
    // The launch's login, then the one joining needed; and none while the
    // session waits after that one (home's requests too).
    expect(logins() - before).toBe(2);
    expect(server.calls).not.toContain('POST /invitations/redeem');
  });

  it('keeps Join on an invitation refused for now', async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    server.outcomes.session = [deviceLimit(), deviceLimit()];
    const again = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith('invabcdefgh'), db: owner.db });
    await again.app.start();
    expect(again.app.screen.value).toMatchObject({ kind: 'invitation' });
    await again.app.redeem('abcd-efgh');
    expect(again.app.screen.value).toMatchObject({ kind: 'invitation', busy: false, error: 'device-limit' });
  });

  it('says so when an invitation is refused', async () => {
    const server = fakeServer({ invitations: [deviceLimit()] });
    server.state.admin = true;
    const admin = await registered(server.api);
    await admin.app.invitations();
    await admin.app.createInvitation(3);
    expect(admin.app.screen.value).toMatchObject({ kind: 'invitations', notice: 'device-limit' });
  });

  it('says "later" when the wait is longer than a minute, or unsaid', async () => {
    const server = fakeServer({ createLink: [deviceLimit(600), new ApiError(429, 'device_limit'), deviceLimit(60)] });
    const owner = await registered(server.api);
    await owner.app.createLink();
    expect(home(owner.app.screen.value)).toMatchObject({ notice: 'device-limit-later', links: [] });
    await owner.app.createLink();
    expect(home(owner.app.screen.value)).toMatchObject({ notice: 'device-limit-later', links: [] });
    // A minute, exactly, is still "in a minute".
    await owner.app.createLink();
    expect(home(owner.app.screen.value)).toMatchObject({ notice: 'device-limit', links: [] });
  });

  it('says so for an invitation whose login is refused, and the screen that would show it', async () => {
    // The session lapsed: logging in again is refused for now, so is
    // reading the invitations again after.
    const server = fakeServer({ invitations: [new ApiError(401, 'session_expired')] });
    server.state.admin = true;
    const admin = await registered(server.api);
    await admin.app.invitations();
    server.outcomes.session = [deviceLimit()];
    await admin.app.createInvitation(3);
    expect(home(admin.app.screen.value)).toMatchObject({ notice: 'device-limit' });
  });

  it("says so for an admin's change refused, and for one whose login is refused", async () => {
    const server = fakeServer({ admin: [deviceLimit(), new ApiError(401, 'session_expired')] });
    server.state.admin = true;
    const admin = await registered(server.api);
    await admin.app.admin();
    await admin.app.setLevel(1, 5);
    expect(admin.app.screen.value).toMatchObject({ kind: 'admin', notice: 'device-limit' });
    server.outcomes.session = [deviceLimit(600)];
    await admin.app.setLevel(1, 5);
    expect(home(admin.app.screen.value)).toMatchObject({ notice: 'device-limit-later' });
  });

  it('says so on Usage', async () => {
    const server = fakeServer({ usage: [deviceLimit(600)] });
    const owner = await registered(server.api);
    await owner.app.usage();
    expect(owner.app.screen.value).toEqual({ kind: 'usage', usage: null, error: 'device-limit-later' });
  });

  it('says so on the signed-out screen when asking again is refused for now', async () => {
    // The first login is the one registered() makes.
    const server = fakeServer({ session: ['ok', new ApiError(401, 'login_refused')] });
    const { db } = await registered(server.api);
    const { app } = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db });
    await app.start();
    expect(app.screen.value).toEqual({ kind: 'signed-out', reason: 'refused', busy: false, offline: false });
    server.outcomes.session = [deviceLimit()];
    await app.recheck();
    expect(app.screen.value).toEqual({ kind: 'signed-out', reason: 'refused', busy: false, offline: true, limited: 'device-limit' });
  });

  it("says so when a deletion stalls on the device's limit", async () => {
    const server = fakeServer({ deleteAccount: Array.from({ length: 401 }, () => deviceLimit(0)) });
    const owner = await registered(server.api, { stepPauseMs: 0 });
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    expect(owner.app.screen.value).toEqual({ kind: 'deleting', error: 'device-limit' });
    expect(server.calls.filter((c) => c === 'DELETE /account')).toHaveLength(400);
  }, 60_000);

  it("says so on the deletion's screen for a login refused at launch, and carries on when asked", async () => {
    const server = fakeServer({ deleteAccount: [new NetworkError('lost')] });
    const owner = await registered(server.api);
    owner.app.askDeleteAccount();
    await owner.app.deleteAccount();
    server.outcomes.session = [deviceLimit()];
    const again = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db: owner.db });
    await again.app.start();
    expect(again.app.screen.value).toEqual({ kind: 'deleting', error: 'device-limit' });
    await again.app.continueDeletion();
    expect(again.app.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
  });

  it("waits a deletion's step out as long as the server asks, then carries on", async () => {
    const server = fakeServer({ deleteAccount: [deviceLimit(1)] });
    const owner = await registered(server.api, { stepPauseMs: 0 });
    owner.app.askDeleteAccount();
    const started = Date.now();
    await owner.app.deleteAccount();
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(owner.app.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
  }, 10_000);

  it("says so on home when the device's requests are refused, for as long as the server says", async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    // Home reads the account: refused, so shown as it was, with the notice.
    server.outcomes.account = [deviceLimit()];
    await owner.app.home();
    expect(home(owner.app.screen.value)).toMatchObject({ offline: true, notice: 'device-limit' });
    server.outcomes.account = [deviceLimit(600)];
    await owner.app.home();
    expect(home(owner.app.screen.value)).toMatchObject({ offline: true, notice: 'device-limit-later' });
    // The invitations refused alone: the account is shown, home online.
    server.outcomes.reads = [deviceLimit()];
    await owner.app.home();
    expect(home(owner.app.screen.value)).toMatchObject({ offline: false, invitations: null, notice: 'device-limit' });
    expect(home(owner.app.screen.value).account).not.toBeNull();
    // What brought the user home says it first, and the refusal shows in
    // place of "offline" (the server was reached).
    await owner.app.home();
    server.outcomes.account = [deviceLimit()];
    await owner.app.createLink();
    expect(home(owner.app.screen.value)).toMatchObject({ notice: 'created', offline: true, limited: 'device-limit' });
  });

  it('keeps a new invitation code on screen when reading the list again is refused', async () => {
    const server = fakeServer();
    server.state.admin = true;
    const admin = await registered(server.api);
    await admin.app.invitations();
    server.outcomes.reads = [deviceLimit()];
    await admin.app.createInvitation(3);
    const screen = admin.app.screen.value;
    expect(screen).toMatchObject({ kind: 'invitations', notice: 'created', created: 'aaaa-aaaa', busy: false });
    if (screen.kind !== 'invitations') return;
    expect(screen.info.codes).toMatchObject([{ code: 'aaaa-aaaa', uses: 3, left: 3 }]);
    // An admin's allowance doesn't run down.
    expect(screen.info).toMatchObject({ maxUses: 1000, remaining: 0, unlimited: true });

    // A member's does, by the code's uses.
    const other = fakeServer();
    other.state.member = true;
    const member = await registered(other.api);
    await member.app.invitations();
    other.outcomes.reads = [deviceLimit()];
    await member.app.createInvitation(1);
    expect(member.app.screen.value).toMatchObject({ kind: 'invitations', notice: 'created', info: { maxUses: 1, remaining: 1 } });
  });

  it('says an admin change was done, with it shown, when reading the screen again is refused, so it is not done twice', async () => {
    const server = fakeServer();
    server.state.admin = true;
    const admin = await registered(server.api);
    await admin.app.admin();
    server.outcomes.reads = [deviceLimit()];
    await admin.app.setLevel(1, 5);
    expect(admin.app.screen.value).toMatchObject({ kind: 'admin', notice: 'saved', busy: false, levels: [{ level: 1, invitations: 5 }] });
    server.outcomes.reads = [deviceLimit()];
    await admin.app.setSwitch('uploads', true);
    expect(admin.app.screen.value).toMatchObject({ kind: 'admin', notice: 'switched', switches: { uploadsPaused: true, downloadsPaused: false } });
  });

  it('holds its inbox fetches back as long as the server says', async () => {
    const refused: Outcome[] = [];
    const server = fakeServer({ inbox: refused });
    const issuer: TokenIssuer = { key: {} as IssuerKey, keyId: new Uint8Array(32) };
    const { db } = await registered(server.api, { issuer });
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      // Refused for the next two minutes: polling every 20 seconds would
      // fetch 6 times; it waits them out, then fetches.
      for (let i = 0; i < 50; i++) refused.push(deviceLimit(120));
      const { app } = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db, issuer, background: true });
      await app.start();
      const inbox = () => server.calls.filter((c) => c === 'GET /inbox').length;
      const first = inbox();
      expect(first).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(110_000);
      expect(inbox()).toBe(first);
      refused.length = 0;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(inbox()).toBeGreaterThan(first);
      await app.home();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe('after setting up over an account elsewhere', () => {
  it('asks the server, in the background, to delete what the old account left, until nothing is', async () => {
    const step = new ApiError(409, 'in_progress');
    const server = fakeServer({ cleanup: [step, step] });
    const owner = await registered(server.api);
    expect(server.calls).not.toContain('POST /account/cleanup');
    // The server says something is left (it does after a replacement, at every launch until done).
    server.state.cleanup = true;
    await owner.app.home();
    expect(home(owner.app.screen.value).account?.cleanup).toBe(true);
    await vi.waitFor(() => expect(server.state.cleanup).toBe(false), { timeout: 5000 });
    expect(server.calls.filter((c) => c === 'POST /account/cleanup')).toHaveLength(3);
    expect(server.unsigned).toEqual([]);
    // Nothing left: not asked again.
    await owner.app.home();
    expect(server.calls.filter((c) => c === 'POST /account/cleanup')).toHaveLength(3);
  });

  it('stops on an error, and the next launch carries on', async () => {
    const server = fakeServer({ cleanup: [new NetworkError('offline')] });
    const owner = await registered(server.api);
    server.state.cleanup = true;
    await owner.app.home();
    await vi.waitFor(() => expect(server.calls.filter((c) => c === 'POST /account/cleanup')).toHaveLength(1));
    expect(server.state.cleanup).toBe(true);
    const again = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db: owner.db });
    await again.app.start();
    await vi.waitFor(() => expect(server.state.cleanup).toBe(false));
  });
});

describe('usage', () => {
  it("shows what's left today, and remembers it for the low-balance notice", async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    expect(owner.app.messagesLeft.value).toBeNull();
    await owner.app.usage();
    const screen = owner.app.screen.value;
    expect(screen.kind).toBe('usage');
    if (screen.kind !== 'usage') return;
    expect(screen.error).toBeNull();
    expect(screen.usage).toMatchObject({
      resetsAt: 1_800_028_800_000,
      messages: { left: 20, limit: 1000 },
      newChats: { left: 90, limit: 100 },
      linkChanges: { left: 4, limit: 5 },
      chats: { used: 10, limit: 2000 },
    });
    await vi.waitFor(() => expect(owner.app.messagesLeft.value).toBe(20));
  });

  it('never shows or remembers more left than the server said before today', async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    server.state.resetsAt = (Math.floor(Date.now() / 86_400_000) + 1) * 86_400;
    // A token batch's answer said 10 left; Usage, maybe older, says 20.
    await rememberLeft(owner.db, 'send', 10);
    await owner.app.usage();
    expect(owner.app.screen.value).toMatchObject({ kind: 'usage', usage: { messages: { left: 10, limit: 1000 } } });
    await vi.waitFor(() => expect(owner.app.messagesLeft.value).toBe(10));
  });
});

describe('data and storage', () => {
  const DAY = 24 * 60 * 60 * 1000;
  /** A received photo already on the device, as if fetched days ago. */
  async function photoOnDevice(db: Awaited<ReturnType<typeof openDatabase>>, id: string, daysAgo: number) {
    await addMessage(
      db,
      { id, conv: 'c1', at: Date.now() - daysAgo * DAY, out: false, status: 'read', file: 'local' },
      { text: '', media: { t: 'photo', s: 1000, m: 'image/jpeg', w: 10, h: 10, id: `upload-${id}`, k: 'a2V5', d: 'c2VjcmV0' } },
    );
    await putMedia(db, 'c1', id, new Uint8Array(1000));
  }

  it('shows what is on the device, and saves the settings', async () => {
    const owner = await registered(fakeServer().api);
    await owner.app.storage();
    expect(owner.app.screen.value).toMatchObject({ kind: 'storage', settings: DEFAULT_MEDIA_SETTINGS, usage: { media: 0, chats: [] }, busy: false, cleared: null });
    await owner.app.setAutoDownload('gifs', false);
    expect(owner.app.screen.value).toMatchObject({ kind: 'storage', settings: { keep: 'forever', auto: { photos: true, voice: true, gifs: false } } });
    expect(await getMediaSettings(owner.db)).toEqual({ keep: 'forever', auto: { photos: true, voice: true, gifs: false } });
  });

  it('clears media older than "keep media" when it changes, and at every start', async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    await photoOnDevice(owner.db, 'old', 10);
    await photoOnDevice(owner.db, 'new', 1);
    await owner.app.storage();
    expect(owner.app.screen.value).toMatchObject({ usage: { media: 2000, chats: [{ id: 'c1', bytes: 2000 }] } });
    await owner.app.setKeepMedia('week');
    expect(owner.app.screen.value).toMatchObject({ kind: 'storage', settings: { keep: 'week' }, usage: { media: 1000 }, cleared: 1000 });
    expect((await listMessages(owner.db, 'c1')).map((m) => [m.id, m.file])).toEqual([['old', 'cleared'], ['new', 'local']]);
    expect(await getMedia(owner.db, 'c1', 'old')).toBeUndefined();

    // Later, at the next start, the one that has grown old goes too.
    await photoOnDevice(owner.db, 'older', 8);
    const again = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db: owner.db });
    await again.app.start();
    expect(await getMedia(owner.db, 'c1', 'older')).toBeUndefined();
    expect(await getMedia(owner.db, 'c1', 'new')).toBeDefined();
  });

  it('clears all media on request, and goes back to the Settings tab', async () => {
    const owner = await registered(fakeServer().api);
    await putMeta(owner.db, 'media-settings', { keep: 'forever' });
    await photoOnDevice(owner.db, 'a', 40);
    await photoOnDevice(owner.db, 'b', 0);
    await owner.app.showTab('settings');
    await owner.app.storage();
    await owner.app.clearMedia();
    expect(owner.app.screen.value).toMatchObject({ kind: 'storage', usage: { media: 0, chats: [] }, cleared: 2000 });
    expect(owner.broadcasts).toContainEqual({ type: 'data-changed' });
    await owner.app.home();
    expect(home(owner.app.screen.value).tab).toBe('settings');
  });
});

describe('the back button', () => {
  it('closes what is open on top first, then goes back home', async () => {
    const handlers = new Map<string, (data: unknown) => void>();
    const posted: { type: string; data: unknown }[] = [];
    const bridge: Bridge = {
      transport: 'webview-proxy',
      post: (type, ...data) => void posted.push({ type, data: data[0] }),
      on: (type, handler) => {
        handlers.set(type, handler as (data: unknown) => void);
        return () => {};
      },
    };
    const shown = () => posted.filter((p) => p.type === 'web_app_setup_back_button').at(-1)?.data;
    const back = () => handlers.get('back_button_pressed')!({});
    const owner = await registered(fakeServer().api, { bridge });
    await owner.app.showTab('settings');
    expect(shown()).toEqual({ is_visible: false });

    // A dialog on the home screen shows the button, and back closes it, not the app.
    let closed = 0;
    const done = owner.app.onBack(() => {
      closed++;
      done();
    });
    expect(shown()).toEqual({ is_visible: true });
    back();
    expect(closed).toBe(1);
    expect(shown()).toEqual({ is_visible: false });

    // On a screen of its own: the viewer on top goes first, then the screen.
    await owner.app.storage();
    const viewer = owner.app.onBack(() => viewer());
    back();
    expect(owner.app.screen.value.kind).toBe('storage');
    expect(shown()).toEqual({ is_visible: true });
    back();
    await vi.waitFor(() => expect(home(owner.app.screen.value).tab).toBe('settings'));
    expect(shown()).toEqual({ is_visible: false });
  });

  it('goes back to the tab each screen was opened from', async () => {
    const handlers = new Map<string, (data: unknown) => void>();
    const bridge: Bridge = {
      transport: 'webview-proxy',
      post: () => {},
      on: (type, handler) => {
        handlers.set(type, handler as (data: unknown) => void);
        return () => {};
      },
    };
    const back = () => handlers.get('back_button_pressed')!({});
    const server = fakeServer();
    server.state.inviteOnly = true;
    server.state.admin = true;
    const owner = await registered(server.api, { bridge });
    const screens: [Screen['kind'], () => Promise<void>][] = [
      ['blocked', owner.app.blocked],
      ['storage', owner.app.storage],
      ['usage', owner.app.usage],
      ['invitations', owner.app.invitations],
      ['admin', owner.app.admin],
    ];
    for (const tab of ['chats', 'links'] as const) {
      for (const [kind, open] of screens) {
        await owner.app.showTab(tab);
        await open();
        expect(owner.app.screen.value.kind).toBe(kind);
        back();
        await vi.waitFor(() => expect(home(owner.app.screen.value).tab).toBe(tab));
      }
    }
    // Invitations and Admin have a Back button of their own, which does the same.
    for (const open of [owner.app.invitations, owner.app.admin]) {
      await owner.app.showTab('links');
      await open();
      await owner.app.home();
      expect(home(owner.app.screen.value).tab).toBe('links');
    }
  });
});

/** A Telegram bridge that keeps what the app posts, and plays events to every handler. */
function recordingBridge() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const posted: { type: string; data: unknown }[] = [];
  const bridge: Bridge = {
    transport: 'webview-proxy',
    post: (type, ...data) => void posted.push({ type, data: data[0] }),
    on: (type, handler) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler as (data: unknown) => void);
      return () => void handlers.get(type)!.delete(handler as (data: unknown) => void);
    },
  };
  return {
    bridge,
    posted,
    fire: (type: string) => handlers.get(type)?.forEach((h) => h({})),
    last: (type: string) => posted.filter((p) => p.type === type).at(-1)?.data,
    count: (type: string) => posted.filter((p) => p.type === type).length,
  };
}

describe('the Settings tab', () => {
  it('shows what its rows need: the media on this device, blocked chats, the account and invitations', async () => {
    const server = fakeServer();
    server.state.inviteOnly = true;
    server.state.member = true;
    const owner = await registered(server.api);
    await addMessage(
      owner.db,
      { id: 'p', conv: 'c1', at: Date.now(), out: false, status: 'read', file: 'local' },
      { text: '', media: { t: 'photo', s: 1500, m: 'image/jpeg', w: 10, h: 10, id: 'upload-p', k: 'a2V5', d: 'c2VjcmV0' } },
    );
    await putMedia(owner.db, 'c1', 'p', new Uint8Array(1500));
    await owner.app.showTab('settings');
    // Measured after the tab draws, without holding it up.
    await vi.waitFor(() => expect(home(owner.app.screen.value).media).toBe(1500));
    expect(home(owner.app.screen.value)).toMatchObject({
      tab: 'settings',
      blockedCount: 0,
      account: { canCreateLinks: true },
      invitations: { inviteOnly: true, member: true },
    });
    // The other tabs don't read it.
    await owner.app.showTab('chats');
    expect(home(owner.app.screen.value).media).toBeNull();
    // A redraw (new messages, another copy's change) keeps it up to date on Settings only.
    await owner.app.showTab('settings');
    await addMessage(
      owner.db,
      { id: 'q', conv: 'c1', at: Date.now(), out: false, status: 'read', file: 'local' },
      { text: '', media: { t: 'photo', s: 1000, m: 'image/jpeg', w: 10, h: 10, id: 'upload-q', k: 'a2V5', d: 'c2VjcmV0' } },
    );
    await owner.app.refresh();
    await vi.waitFor(() => expect(home(owner.app.screen.value).media).toBe(2500));
    // Drawn again, it shows the last measurement at once.
    await owner.app.showTab('chats');
    const drawn = owner.app.showTab('settings');
    await vi.waitFor(() => expect(home(owner.app.screen.value).tab).toBe('settings'));
    expect(home(owner.app.screen.value).media).toBe(2500);
    await drawn;
  });

  it("Delete account's way out from Settings goes back there: Back, and Cancel", async () => {
    const tg = recordingBridge();
    const owner = await registered(fakeServer().api, { bridge: tg.bridge });
    await owner.app.showTab('settings');
    owner.app.askDeleteAccount();
    expect(owner.app.screen.value.kind).toBe('confirm-delete');
    tg.fire('back_button_pressed');
    await vi.waitFor(() => expect(home(owner.app.screen.value).tab).toBe('settings'));
    owner.app.askDeleteAccount();
    await owner.app.cancelDeleteAccount();
    expect(home(owner.app.screen.value).tab).toBe('settings');
  });

  it('goes back to Settings from every page it opens', async () => {
    const tg = recordingBridge();
    const server = fakeServer();
    server.state.inviteOnly = true;
    server.state.admin = true;
    const owner = await registered(server.api, { bridge: tg.bridge });
    const pages: [Screen['kind'], () => unknown][] = [
      ['language', owner.app.language],
      ['blocked', owner.app.blocked],
      ['storage', owner.app.storage],
      ['usage', owner.app.usage],
      ['invitations', owner.app.invitations],
      ['admin', owner.app.admin],
    ];
    for (const [kind, open] of pages) {
      await owner.app.showTab('settings');
      expect(tg.last('web_app_setup_back_button')).toEqual({ is_visible: false });
      await open();
      expect(owner.app.screen.value.kind).toBe(kind);
      expect(tg.last('web_app_setup_back_button')).toEqual({ is_visible: true });
      tg.fire('back_button_pressed');
      await vi.waitFor(() => expect(home(owner.app.screen.value).tab).toBe('settings'));
      expect(tg.last('web_app_setup_back_button')).toEqual({ is_visible: false });
    }
  });

  it("offers Telegram's Settings item on the app's own screens, and a press there opens the Settings tab", async () => {
    const server = fakeServer();
    // Before setting up: not offered.
    const before = recordingBridge();
    const fresh = await setup({ api: server.api, bridge: before.bridge, launch: launchWith('') });
    await fresh.app.start();
    expect(fresh.app.screen.value.kind).toBe('welcome');
    expect(before.last('web_app_setup_settings_button')).toEqual({ is_visible: false });
    before.fire('settings_button_pressed');
    await tick();
    expect(fresh.app.screen.value.kind).toBe('welcome');

    const tg = recordingBridge();
    const owner = await registered(server.api, { bridge: tg.bridge });
    expect(tg.last('web_app_setup_settings_button')).toEqual({ is_visible: true });
    // Told only when it changes.
    const told = tg.count('web_app_setup_settings_button');
    await owner.app.showTab('settings');
    await owner.app.storage();
    expect(tg.count('web_app_setup_settings_button')).toBe(told);

    // From a page with two things open on top (a dialog over a menu, say): both close, and Settings opens.
    const closed: string[] = [];
    const menu = owner.app.onBack(() => {
      closed.push('menu');
      menu();
    });
    const dialog = owner.app.onBack(() => {
      closed.push('dialog');
      dialog();
    });
    tg.fire('settings_button_pressed');
    await vi.waitFor(() => expect(home(owner.app.screen.value).tab).toBe('settings'));
    expect(closed).toEqual(['dialog', 'menu']);
    expect(tg.last('web_app_setup_back_button')).toEqual({ is_visible: false });

    // Offered in a chat and on the Language page; not while deleting the account is being confirmed.
    await chatOnDevice(owner.db);
    await owner.app.openConversation('c1');
    expect(owner.app.screen.value.kind).toBe('conversation');
    expect(tg.last('web_app_setup_settings_button')).toEqual({ is_visible: true });
    owner.app.language();
    expect(tg.last('web_app_setup_settings_button')).toEqual({ is_visible: true });
    owner.app.askDeleteAccount();
    expect(tg.last('web_app_setup_settings_button')).toEqual({ is_visible: false });
    tg.fire('settings_button_pressed');
    await tick();
    expect(owner.app.screen.value.kind).toBe('confirm-delete');
  });

  it('draws Settings at once with the last size measured, measures after, the latest measurement winning', async () => {
    const owner = await registered(fakeServer().api);
    const photo = (id: string, s: number) =>
      addMessage(
        owner.db,
        { id, conv: 'c1', at: Date.now(), out: false, status: 'read', file: 'local' },
        { text: '', media: { t: 'photo', s, m: 'image/jpeg', w: 10, h: 10, id: `upload-${id}`, k: 'a2V5', d: 'c2VjcmV0' } },
      );
    await photo('p', 1500);
    await owner.app.showTab('settings');
    await vi.waitFor(() => expect(home(owner.app.screen.value).media).toBe(1500));
    await owner.app.showTab('chats');
    await photo('q', 1000);

    // A slow measurement (A): the tab is drawn meanwhile, with the last size.
    const a = holdRead('mediaUsage');
    await owner.app.showTab('settings');
    await a.atRead;
    expect(home(owner.app.screen.value)).toMatchObject({ tab: 'settings', media: 1500 });
    // A new attachment, then a redraw meanwhile: it keeps the size, and measures again (B).
    await photo('r', 500);
    const b = holdRead('mediaUsage');
    await owner.app.refresh();
    await b.atRead;
    expect(home(owner.app.screen.value).media).toBe(1500);
    b.release();
    await vi.waitFor(() => expect(home(owner.app.screen.value).media).toBe(3000));
    // A, older (2500, from before the new one), finishes last: dropped.
    a.release();
    await tick();
    expect(home(owner.app.screen.value).media).toBe(3000);

    // Left for Chats while measuring: Chats gets no size.
    const c = holdRead('mediaUsage');
    await owner.app.showTab('settings');
    await c.atRead;
    await owner.app.showTab('chats');
    c.release();
    await tick();
    expect(home(owner.app.screen.value)).toMatchObject({ tab: 'chats', media: null });
  });

  it('is not offered on a link being checked or written to, or an invitation being joined', () => {
    expect(offersSettings({ kind: 'link', status: 'checking', canWrite: false, busy: false, error: null })).toBe(false);
    expect(offersSettings({ kind: 'link', status: 'verified', canWrite: true, busy: true, error: null })).toBe(false);
    expect(offersSettings({ kind: 'link', status: 'verified', canWrite: true, busy: false, error: null })).toBe(true);
    expect(offersSettings({ kind: 'invitation', code: 'abcd-efgh', busy: true, error: null })).toBe(false);
    expect(offersSettings({ kind: 'invitation', code: 'abcd-efgh', busy: false, error: null })).toBe(true);
  });

  it('hides the Settings item while a link is checked, and offers it again once it is', async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    await owner.app.createLink();
    const url = home(owner.app.screen.value).links[0]!.url;
    const sender = await registered(server.api);
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    const request = server.api.request.bind(server.api);
    server.api.request = (async (method, path, init, check) => {
      if (method === 'GET' && path.startsWith('/links/')) await held;
      return request(method, path, init, check);
    }) as Api['request'];
    const tg = recordingBridge();
    const { app } = await setup({ api: server.api, bridge: tg.bridge, launch: launchWith(payloadOf(url)), db: sender.db });
    const starting = app.start();
    await vi.waitFor(() => expect(app.screen.value).toMatchObject({ kind: 'link', status: 'checking' }));
    expect(tg.last('web_app_setup_settings_button')).toEqual({ is_visible: false });
    tg.fire('settings_button_pressed');
    release();
    await starting;
    expect(app.screen.value).toMatchObject({ kind: 'link', status: 'verified' });
    expect(tg.last('web_app_setup_settings_button')).toEqual({ is_visible: true });
    // The press did nothing: home is still on the tab it was (Chats), not Settings.
    await app.home();
    expect(home(app.screen.value).tab).toBe('chats');
  });

  it("isn't offered while a screen is busy, which would draw over Settings once done", () => {
    expect(offersSettings({ kind: 'storage', settings: DEFAULT_MEDIA_SETTINGS, usage: { media: 0, chats: [], app: null }, busy: true, cleared: null })).toBe(false);
    // Data and storage's first reading is the exception: it looks before drawing.
    expect(offersSettings({ kind: 'storage', settings: DEFAULT_MEDIA_SETTINGS, usage: null, busy: true, cleared: null })).toBe(true);
    expect(offersSettings({ kind: 'blocked', conversations: [], busy: true, notice: null })).toBe(false);
    expect(offersSettings({ kind: 'blocked', conversations: [], busy: false, notice: null })).toBe(true);
  });

  it("Data and storage's measurement never wins over one Settings started later", async () => {
    const owner = await registered(fakeServer().api);
    const photo = (id: string, s: number) =>
      addMessage(
        owner.db,
        { id, conv: 'c1', at: Date.now(), out: false, status: 'read', file: 'local' },
        { text: '', media: { t: 'photo', s, m: 'image/jpeg', w: 10, h: 10, id: `upload-${id}`, k: 'a2V5', d: 'c2VjcmV0' } },
      );
    await photo('p', 1500);
    await owner.app.showTab('settings');
    await vi.waitFor(() => expect(home(owner.app.screen.value).media).toBe(1500));
    await photo('q', 1000);
    // Data and storage measures (2500), slowly; meanwhile the user goes back.
    const storage = holdRead('mediaUsage');
    const opening = owner.app.storage();
    await storage.atRead;
    await photo('r', 500);
    const settings = holdRead('mediaUsage');
    await owner.app.home();
    await settings.atRead;
    // The older one ends first, then the newer (3000): the newer shows.
    storage.release();
    await opening;
    settings.release();
    await vi.waitFor(() => expect(home(owner.app.screen.value).media).toBe(3000));
    // And what Data and storage measures (3500) shows on Settings at once, while Settings measures again.
    await photo('s', 500);
    await owner.app.storage();
    const again = holdRead('mediaUsage');
    await owner.app.home();
    await again.atRead;
    expect(home(owner.app.screen.value)).toMatchObject({ tab: 'settings', media: 3500 });
    again.release();
  });

  it("never records the old account's size from Data and storage still measuring when the account changes", async () => {
    const owner = await registered(fakeServer().api);
    await addMessage(
      owner.db,
      { id: 'p', conv: 'c1', at: Date.now(), out: false, status: 'read', file: 'local' },
      { text: '', media: { t: 'photo', s: 1500, m: 'image/jpeg', w: 10, h: 10, id: 'upload-p', k: 'a2V5', d: 'c2VjcmV0' } },
    );
    await owner.app.showTab('settings');
    await vi.waitFor(() => expect(home(owner.app.screen.value).media).toBe(1500));
    await owner.app.showTab('chats');
    // Data and storage measures, slowly; meanwhile another copy changes the account (home comes back on Chats, which measures nothing).
    const storage = holdRead('mediaUsage');
    const opening = owner.app.storage();
    await storage.atRead;
    await owner.app.accountChanged();
    storage.release();
    await opening;
    // Settings, while measuring anew, has no size to show: not the old account's.
    const settings = holdRead('mediaUsage');
    await owner.app.showTab('settings');
    await settings.atRead;
    expect(home(owner.app.screen.value)).toMatchObject({ tab: 'settings', media: null });
    settings.release();
  });

  it("keeps Data and storage's newer size when Settings' older measurement ends after it", async () => {
    const owner = await registered(fakeServer().api);
    const photo = (id: string, s: number) =>
      addMessage(
        owner.db,
        { id, conv: 'c1', at: Date.now(), out: false, status: 'read', file: 'local' },
        { text: '', media: { t: 'photo', s, m: 'image/jpeg', w: 10, h: 10, id: `upload-${id}`, k: 'a2V5', d: 'c2VjcmV0' } },
      );
    await photo('p', 1500);
    // Settings measures (1500), held; Data and storage then measures more (2500), held too.
    const settings = holdRead('mediaUsage');
    await owner.app.showTab('settings');
    await settings.atRead;
    await photo('q', 1000);
    const storage = holdRead('mediaUsage');
    const opening = owner.app.storage();
    await storage.atRead;
    // Data and storage's (newer) ends first, then Settings' (older): the newer stays.
    storage.release();
    await opening;
    settings.release();
    await tick();
    const back = holdRead('mediaUsage');
    await owner.app.home();
    await back.atRead;
    expect(home(owner.app.screen.value)).toMatchObject({ tab: 'settings', media: 2500 });
    back.release();
  });

  it('ignores a tab switch while home is busy, so an action under way is asked once and lands where it began', async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    await owner.app.showTab('links');
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    const request = server.api.request.bind(server.api);
    server.api.request = (async (method, path, init, check) => {
      if (method === 'POST' && path === '/links') await held;
      return request(method, path, init, check);
    }) as Api['request'];
    try {
      const creating = owner.app.createLink();
      await vi.waitFor(() => expect(home(owner.app.screen.value).busy).toBe(true));
      await owner.app.showTab('chats');
      expect(home(owner.app.screen.value)).toMatchObject({ tab: 'links', busy: true });
      // Creating again meanwhile asks nothing more.
      await owner.app.createLink();
      release();
      await creating;
      expect(home(owner.app.screen.value)).toMatchObject({ tab: 'links', notice: 'created' });
      expect(server.calls.filter((c) => c === 'POST /links')).toHaveLength(1);
    } finally {
      release();
    }
  });

  it("doesn't let a tab switch still loading draw over an action started meanwhile", async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    await owner.app.showTab('links');
    let releaseAccount = () => {};
    const accountHeld = new Promise<void>((r) => (releaseAccount = r));
    let releaseLink = () => {};
    const linkHeld = new Promise<void>((r) => (releaseLink = r));
    let holdAccount = true;
    const request = server.api.request.bind(server.api);
    server.api.request = (async (method, path, init, check) => {
      if (holdAccount && method === 'GET' && path === '/account') {
        holdAccount = false;
        await accountHeld;
      }
      if (method === 'POST' && path === '/links') await linkHeld;
      return request(method, path, init, check);
    }) as Api['request'];
    try {
      // A tap on Settings on a slow network: nothing changes yet, so the user taps Create my link.
      const switching = owner.app.showTab('settings');
      await tick();
      const creating = owner.app.createLink();
      await vi.waitFor(() => expect(home(owner.app.screen.value)).toMatchObject({ tab: 'links', busy: true }));
      releaseAccount();
      await switching;
      // Settings didn't draw over the action: still busy on My link, so nothing can be asked twice.
      expect(home(owner.app.screen.value)).toMatchObject({ tab: 'links', busy: true });
      await owner.app.createLink();
      releaseLink();
      await creating;
      expect(home(owner.app.screen.value)).toMatchObject({ tab: 'links', notice: 'created' });
      expect(server.calls.filter((c) => c === 'POST /links')).toHaveLength(1);
    } finally {
      releaseAccount();
      releaseLink();
    }
  });

  it("forgets the size when another copy changes the account, so the old account's never shows", async () => {
    const owner = await registered(fakeServer().api);
    await addMessage(
      owner.db,
      { id: 'p', conv: 'c1', at: Date.now(), out: false, status: 'read', file: 'local' },
      { text: '', media: { t: 'photo', s: 1500, m: 'image/jpeg', w: 10, h: 10, id: 'upload-p', k: 'a2V5', d: 'c2VjcmV0' } },
    );
    await owner.app.showTab('settings');
    await vi.waitFor(() => expect(home(owner.app.screen.value).media).toBe(1500));
    const measuring = holdRead('mediaUsage');
    await owner.app.accountChanged();
    await measuring.atRead;
    expect(home(owner.app.screen.value)).toMatchObject({ tab: 'settings', media: null });
    measuring.release();
  });

  it('is not offered while a link is checked or an invitation joined, which would draw over Settings once done', async () => {
    const server = fakeServer();
    server.state.inviteOnly = true;
    server.state.codes.set('abcd-efgh', { uses: 1, left: 1 });
    const tg = recordingBridge();
    const user = await registered(server.api, { bridge: tg.bridge, launch: launchWith('invabcdefgh') });
    expect(user.app.screen.value).toMatchObject({ kind: 'invitation', busy: false });
    expect(tg.last('web_app_setup_settings_button')).toEqual({ is_visible: true });
    // Joining: held at the server until we've looked.
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    const request = server.api.request.bind(server.api);
    server.api.request = (async (method, path, init, check) => {
      if (path === '/invitations/redeem') await held;
      return request(method, path, init, check);
    }) as Api['request'];
    const joining = user.app.redeem('abcd-efgh');
    await vi.waitFor(() => expect(user.app.screen.value).toMatchObject({ kind: 'invitation', busy: true }));
    expect(tg.last('web_app_setup_settings_button')).toEqual({ is_visible: false });
    tg.fire('settings_button_pressed');
    release();
    await joining;
    // Where joining always lands; the press didn't take it to Settings.
    expect(home(user.app.screen.value)).toMatchObject({ tab: 'chats', notice: 'joined' });
  });

  it('is not offered while the server refuses this device, and a press then does nothing', async () => {
    const refused = () => new ApiError(401, 'login_refused');
    // The first login is the one registered() makes.
    const server = fakeServer({ session: ['ok', refused(), refused()] });
    const { db } = await registered(server.api);
    const tg = recordingBridge();
    const { app } = await setup({ api: server.api, bridge: tg.bridge, launch: launchWith(''), db });
    await app.start();
    expect(app.screen.value.kind).toBe('signed-out');
    expect(tg.last('web_app_setup_settings_button')).toEqual({ is_visible: false });
    tg.fire('settings_button_pressed');
    await tick();
    expect(app.screen.value.kind).toBe('signed-out');
  });
});

describe('switching tabs while home loads (a slow network)', () => {
  /** Holds the first request that matches, until released; reached: once it's held. */
  function holdFirst(server: ReturnType<typeof fakeServer>, match: (method: string, path: string) => boolean) {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    let atHold = () => {};
    const reached = new Promise<void>((r) => (atHold = r));
    let holding = true;
    const request = server.api.request.bind(server.api);
    server.api.request = (async (method, path, init, check) => {
      if (holding && match(method, path)) {
        holding = false;
        atHold();
        await held;
      }
      return request(method, path, init, check);
    }) as Api['request'];
    return Object.assign(() => release(), { reached });
  }
  const account = (m: string, p: string) => m === 'GET' && p === '/account';

  it('ends on the tab tapped last, whichever loads last', async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    const release = holdFirst(server, account);
    try {
      const first = owner.app.showTab('settings');
      await release.reached;
      await owner.app.showTab('links');
      expect(home(owner.app.screen.value).tab).toBe('links');
      release();
      await first;
      expect(home(owner.app.screen.value).tab).toBe('links');
    } finally {
      release();
    }
  });

  it("doesn't draw over what an action ended with, when the action ends first", async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    await owner.app.showTab('links');
    const release = holdFirst(server, account);
    try {
      const switching = owner.app.showTab('settings');
      await release.reached;
      await owner.app.createLink();
      expect(home(owner.app.screen.value)).toMatchObject({ tab: 'links', notice: 'created', busy: false });
      release();
      await switching;
      expect(home(owner.app.screen.value)).toMatchObject({ tab: 'links', notice: 'created' });
    } finally {
      release();
    }
  });

  it("doesn't draw over the screen an action ended on (the account replaced elsewhere)", async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    await owner.app.showTab('links');
    const release = holdFirst(server, account);
    const request = server.api.request.bind(server.api);
    server.api.request = (async (method, path, init, check) => {
      if (method === 'POST' && path === '/links') throw new ApiError(410, 'account_replaced');
      return request(method, path, init, check);
    }) as Api['request'];
    try {
      const switching = owner.app.showTab('settings');
      await release.reached;
      await owner.app.createLink();
      const ended = owner.app.screen.value.kind;
      expect(ended).not.toBe('home');
      release();
      await switching;
      expect(owner.app.screen.value.kind).toBe(ended);
    } finally {
      release();
    }
  });

  it("doesn't draw over a chat opened meanwhile", async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    await chatOnDevice(owner.db);
    await owner.app.showTab('chats');
    const release = holdFirst(server, account);
    try {
      const switching = owner.app.showTab('settings');
      await release.reached;
      await owner.app.openConversation('c1');
      release();
      await switching;
      expect(owner.app.screen.value.kind).toBe('conversation');
    } finally {
      release();
    }
  });

  it('deletes a chat from home once, while a tab switch loads', async () => {
    const server = fakeServer();
    const issuer: TokenIssuer = { key: {} as IssuerKey, keyId: new Uint8Array(32) };
    engines.made.length = 0;
    const owner = await registered(server.api, { issuer });
    await chatOnDevice(owner.db);
    await owner.app.showTab('chats');
    const engine = engines.made.at(-1)!;
    let releaseRemove = () => {};
    const removeHeld = new Promise<void>((r) => (releaseRemove = r));
    let removes = 0;
    vi.spyOn(engine, 'remove').mockImplementation(async () => {
      removes++;
      await removeHeld;
    });
    const release = holdFirst(server, account);
    try {
      const switching = owner.app.showTab('settings');
      await release.reached;
      const deleting = owner.app.deleteConversation('c1', false);
      await vi.waitFor(() => expect(home(owner.app.screen.value)).toMatchObject({ tab: 'chats', busy: true }));
      release();
      await switching;
      expect(home(owner.app.screen.value)).toMatchObject({ tab: 'chats', busy: true });
      await owner.app.deleteConversation('c1', false);
      releaseRemove();
      await deleting;
      expect(home(owner.app.screen.value)).toMatchObject({ tab: 'chats', busy: false, notice: 'deleted' });
      expect(removes).toBe(1);
    } finally {
      release();
      releaseRemove();
    }
  });

  it('joins from home once, while a tab switch loads, and lands where it began', async () => {
    const server = fakeServer();
    server.state.inviteOnly = true;
    server.state.codes.set('abcd-efgh', { uses: 1, left: 1 });
    const owner = await registered(server.api);
    await owner.app.showTab('links');
    let releaseRedeem = () => {};
    const redeemHeld = new Promise<void>((r) => (releaseRedeem = r));
    const release = holdFirst(server, account);
    const request = server.api.request.bind(server.api);
    server.api.request = (async (method, path, init, check) => {
      if (path === '/invitations/redeem') await redeemHeld;
      return request(method, path, init, check);
    }) as Api['request'];
    try {
      const switching = owner.app.showTab('settings');
      await release.reached;
      const joining = owner.app.redeem('abcd-efgh');
      await vi.waitFor(() => expect(home(owner.app.screen.value)).toMatchObject({ tab: 'links', busy: true }));
      release();
      await switching;
      expect(home(owner.app.screen.value)).toMatchObject({ tab: 'links', busy: true });
      await owner.app.redeem('abcd-efgh');
      releaseRedeem();
      await joining;
      expect(home(owner.app.screen.value)).toMatchObject({ tab: 'links', notice: 'joined', busy: false });
      expect(server.calls.filter((c) => c === 'POST /invitations/redeem')).toHaveLength(1);
    } finally {
      release();
      releaseRedeem();
    }
  });

  it('drops a stale draw without leaving the chat list behind: a refresh under way is read again', async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    await chatOnDevice(owner.db);
    await owner.app.showTab('chats');
    const release = holdFirst(server, account);
    try {
      const older = owner.app.showTab('settings');
      await release.reached;
      await owner.app.showTab('links');
      expect(home(owner.app.screen.value).conversations[0]!.unread).toBe(0);
      // A message arrives (unread 1), and a refresh reads it, slowly.
      await putConversation(owner.db, { ...(await getConversation(owner.db, 'c1'))!, unread: 1 });
      const read = holdRead('listConversations');
      const refreshing = owner.app.refresh();
      await read.atRead;
      release();
      await older;
      read.release();
      await refreshing;
      expect(home(owner.app.screen.value).tab).toBe('links');
      await vi.waitFor(() => expect(home(owner.app.screen.value).conversations[0]!.unread).toBe(1));
    } finally {
      release();
    }
  });

  it('keeps the notice of a join that ended before an older home draw loads', async () => {
    const server = fakeServer();
    server.state.inviteOnly = true;
    server.state.codes.set('abcd-efgh', { uses: 1, left: 1 });
    const tg = recordingBridge();
    // Opened from an invitation link: joining there isn't an action on home, so only the draws' order decides.
    const user = await registered(server.api, { bridge: tg.bridge, launch: launchWith('invabcdefgh') });
    expect(user.app.screen.value).toMatchObject({ kind: 'invitation', busy: false });
    const release = holdFirst(server, account);
    try {
      tg.fire('settings_button_pressed');
      await release.reached;
      await user.app.redeem('abcd-efgh');
      expect(home(user.app.screen.value)).toMatchObject({ notice: 'joined', busy: false });
      // The older draw reads the chats twice, the second just before it decides: hold that one, then let it decide.
      const first = holdRead('listConversations');
      release();
      await first.atRead;
      const last = holdRead('listConversations');
      first.release();
      await last.atRead;
      last.release();
      await tick();
      expect(home(user.app.screen.value)).toMatchObject({ tab: 'chats', notice: 'joined' });
    } finally {
      release();
    }
  });

  it('ignores Join with a mistyped code while home is busy, drawing nothing over the action', async () => {
    const server = fakeServer();
    server.state.inviteOnly = true;
    const owner = await registered(server.api);
    await owner.app.showTab('links');
    server.state.admin = true;
    const release = holdFirst(server, (m, p) => m === 'POST' && p === '/links');
    try {
      const creating = owner.app.createLink();
      await release.reached;
      expect(home(owner.app.screen.value).busy).toBe(true);
      await owner.app.redeem('not a code');
      expect(home(owner.app.screen.value)).toMatchObject({ busy: true, notice: null });
      release();
      await creating;
      expect(home(owner.app.screen.value)).toMatchObject({ busy: false, notice: 'created' });
    } finally {
      release();
    }
  });

  it("doesn't let Telegram's Settings item, still loading, draw over the screen an action ended on", async () => {
    const server = fakeServer();
    const tg = recordingBridge();
    const owner = await registered(server.api, { bridge: tg.bridge });
    await owner.app.showTab('links');
    const release = holdFirst(server, account);
    const request = server.api.request.bind(server.api);
    server.api.request = (async (method, path, init, check) => {
      if (method === 'POST' && path === '/links') throw new ApiError(410, 'account_replaced');
      return request(method, path, init, check);
    }) as Api['request'];
    try {
      tg.fire('settings_button_pressed');
      await release.reached;
      await owner.app.createLink();
      const ended = owner.app.screen.value.kind;
      expect(ended).not.toBe('home');
      // The older draw reads the chats twice, the second just before it decides: hold that one, then let it decide.
      const first = holdRead('listConversations');
      release();
      await first.atRead;
      const last = holdRead('listConversations');
      first.release();
      await last.atRead;
      last.release();
      await tick();
      expect(owner.app.screen.value.kind).toBe(ended);
    } finally {
      release();
    }
  });

  it("opens Settings from a chat that refreshes while Settings loads (a new message, say)", async () => {
    const server = fakeServer();
    const tg = recordingBridge();
    const owner = await registered(server.api, { bridge: tg.bridge });
    await chatOnDevice(owner.db);
    await owner.app.openConversation('c1');
    const release = holdFirst(server, account);
    try {
      tg.fire('settings_button_pressed');
      await release.reached;
      // The same chat, drawn again.
      await owner.app.refresh();
      expect(owner.app.screen.value).toMatchObject({ kind: 'conversation', id: 'c1' });
      release();
      await vi.waitFor(() => expect(home(owner.app.screen.value).tab).toBe('settings'));
    } finally {
      release();
    }
  });

  it("doesn't let Telegram's Settings item, still loading, draw over a chat opened meanwhile", async () => {
    const server = fakeServer();
    const tg = recordingBridge();
    const owner = await registered(server.api, { bridge: tg.bridge });
    await chatOnDevice(owner.db);
    await owner.app.showTab('chats');
    const release = holdFirst(server, account);
    try {
      tg.fire('settings_button_pressed');
      await release.reached;
      await owner.app.openConversation('c1');
      expect(owner.app.screen.value).toMatchObject({ kind: 'conversation', id: 'c1' });
      // The older draw reads the chats twice, the second just before it decides: hold that one, then let it decide.
      const first = holdRead('listConversations');
      release();
      await first.atRead;
      const last = holdRead('listConversations');
      first.release();
      await last.atRead;
      last.release();
      await tick();
      expect(owner.app.screen.value).toMatchObject({ kind: 'conversation', id: 'c1' });
    } finally {
      release();
    }
  });

  it('a tab tapped, a chat opened, then Back: home stays on the tab Back went to', async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    await chatOnDevice(owner.db);
    await owner.app.showTab('chats');
    const release = holdFirst(server, account);
    try {
      const switching = owner.app.showTab('settings');
      await release.reached;
      await owner.app.openConversation('c1');
      await owner.app.home();
      expect(home(owner.app.screen.value).tab).toBe('chats');
      release();
      await switching;
      expect(home(owner.app.screen.value).tab).toBe('chats');
    } finally {
      release();
    }
  });
});

describe('invitations', () => {
  it('lets an admin invite someone, who then joins through the link', async () => {
    const server = fakeServer();
    server.state.inviteOnly = true;
    server.state.admin = true;
    const admin = await registered(server.api);
    expect(home(admin.app.screen.value).invitations).toMatchObject({ admin: true, unlimited: true });

    await admin.app.invitations();
    expect(admin.app.screen.value.kind).toBe('invitations');
    await admin.app.createInvitation(3);
    const screen = admin.app.screen.value;
    if (screen.kind !== 'invitations') throw new Error(screen.kind);
    expect(screen.notice).toBe('created');
    expect(screen.created).toBe('aaaa-aaaa');
    expect(screen.info.codes[0]).toMatchObject({ code: 'aaaa-aaaa', uses: 3, left: 3, url: 'https://t.me/test_bot?startapp=invaaaaaaaa' });
    expect(server.unsigned).toEqual([]);

    // Someone opens the invitation link (the fake has one account, so stop being admin).
    server.state.admin = false;
    const invitee = await registered(server.api, { launch: launchWith('invaaaaaaaa') });
    // It only asks: joining tells the inviter, so it waits for a tap on Join.
    expect(invitee.app.screen.value).toEqual({ kind: 'invitation', code: 'aaaa-aaaa', busy: false, error: null });
    expect(server.calls).not.toContain('POST /invitations/redeem');
    expect(server.state.codes.get('aaaa-aaaa')!.left).toBe(3);
    await invitee.app.redeem('aaaa-aaaa');
    expect(home(invitee.app.screen.value)).toMatchObject({ notice: 'joined', account: { canCreateLinks: true } });
    expect(server.state.codes.get('aaaa-aaaa')!.left).toBe(2);
  });

  it('goes home without joining on "not now"', async () => {
    const server = fakeServer();
    server.state.inviteOnly = true;
    server.state.codes.set('abcd-efgh', { uses: 1, left: 1 });
    const user = await registered(server.api, { launch: launchWith('invabcdefgh') });
    expect(user.app.screen.value).toMatchObject({ kind: 'invitation', code: 'abcd-efgh' });
    await user.app.home();
    expect(home(user.app.screen.value).notice).toBeNull();
    expect(server.calls).not.toContain('POST /invitations/redeem');
    expect(server.state.codes.get('abcd-efgh')!.left).toBe(1);
  });

  it('says from an invitation link when the code is unknown, or not needed', async () => {
    const server = fakeServer();
    server.state.inviteOnly = true;
    server.state.codes.set('abcd-efgh', { uses: 1, left: 1 });
    const unknown = await registered(server.api, { launch: launchWith('invzzzzzzzz') });
    await unknown.app.redeem('zzzz-zzzz');
    expect(home(unknown.app.screen.value).notice).toBe('invalid-invitation');

    server.state.member = true;
    const member = await registered(server.api, { launch: launchWith('invabcdefgh') });
    await member.app.redeem('abcd-efgh');
    expect(home(member.app.screen.value).notice).toBe('already-member');
    expect(server.state.codes.get('abcd-efgh')!.left).toBe(1);
  });

  it('keeps Join after a network error, also when the app opened offline', async () => {
    // The login registered() makes fails: the app opens offline.
    const server = fakeServer({ session: [new NetworkError('offline')] });
    server.state.inviteOnly = true;
    server.state.codes.set('abcd-efgh', { uses: 1, left: 1 });
    const request = server.api.request.bind(server.api);
    let down = true;
    server.api.request = ((method, path, init, check) => {
      if (down && path === '/invitations/redeem') return Promise.reject(new NetworkError('offline'));
      return request(method, path, init, check);
    }) as Api['request'];
    const user = await registered(server.api, { launch: launchWith('invabcdefgh') });
    // Opened offline (the login failed): the invitation still shows.
    expect(user.app.screen.value).toEqual({ kind: 'invitation', code: 'abcd-efgh', busy: false, error: null });

    await user.app.redeem('abcd-efgh');
    expect(user.app.screen.value).toEqual({ kind: 'invitation', code: 'abcd-efgh', busy: false, error: 'network' });
    down = false;
    await user.app.redeem('abcd-efgh');
    expect(home(user.app.screen.value).notice).toBe('joined');
    expect(server.state.codes.get('abcd-efgh')!.left).toBe(0);
  });

  it('joins once when Join is tapped twice', async () => {
    const server = fakeServer();
    server.state.inviteOnly = true;
    server.state.codes.set('abcd-efgh', { uses: 2, left: 2 });
    const user = await registered(server.api, { launch: launchWith('invabcdefgh') });
    const first = user.app.redeem('abcd-efgh');
    expect(user.app.screen.value).toMatchObject({ kind: 'invitation', busy: true });
    const second = user.app.redeem('abcd-efgh');
    await Promise.all([first, second]);
    expect(server.calls.filter((c) => c === 'POST /invitations/redeem')).toHaveLength(1);
    expect(home(user.app.screen.value).notice).toBe('joined');
  });

  it('joins with a typed code, and explains a bad one', async () => {
    const server = fakeServer();
    server.state.inviteOnly = true;
    server.state.codes.set('abcd-efgh', { uses: 1, left: 1 });
    const user = await registered(server.api);
    expect(home(user.app.screen.value).invitations).toMatchObject({ member: false, inviteOnly: true });

    await user.app.redeem('nope');
    expect(home(user.app.screen.value).notice).toBe('invalid-invitation');
    await user.app.redeem(' ABCD EFGH ');
    expect(home(user.app.screen.value).notice).toBe('joined');
    await user.app.redeem('abcd-efgh');
    expect(home(user.app.screen.value).notice).toBe('invalid-invitation'); // used up
  });

  it("says when it's your own invitation code", async () => {
    const server = fakeServer();
    server.state.inviteOnly = true;
    const user = await registered(server.api);
    await user.app.redeem('mmmm-nnnn');
    expect(home(user.app.screen.value).notice).toBe('own-invitation');
  });

  it('remembers an invitation opened before setup', async () => {
    const server = fakeServer();
    server.state.inviteOnly = true;
    server.state.codes.set('abcd-efgh', { uses: 1, left: 1 });
    const db = await openDatabase(`app-test-${n++}`);
    const first = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith('invabcdefgh'), db });
    await first.app.start();
    await first.app.setUp();
    const code = 'reg' + (await readAccount(db))!.fingerprint;
    const second = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(code), db });
    await second.app.start();
    expect(second.app.screen.value).toEqual({ kind: 'invitation', code: 'abcd-efgh', busy: false, error: null });
    expect(server.calls).not.toContain('POST /invitations/redeem');
    await second.app.redeem('abcd-efgh');
    expect(home(second.app.screen.value).notice).toBe('joined');
  });

  it('lets admins set allowances and grant extra invitations by link', async () => {
    const server = fakeServer();
    server.state.inviteOnly = true;
    server.state.admin = true;
    const bridge = fakeBridge();
    const admin = await registered(server.api, { bridge: bridge.bridge });
    await admin.app.createLink();
    const memberLink = home(admin.app.screen.value).links[0]!;

    await admin.app.admin();
    expect(admin.app.screen.value.kind).toBe('admin');
    expect(bridge.posted.at(-1)).toEqual({ type: 'web_app_setup_back_button', data: { is_visible: true } });
    await admin.app.setLevel(1, 5);
    expect(admin.app.screen.value).toMatchObject({ kind: 'admin', notice: 'saved', levels: [{ level: 1, invitations: 5 }] });

    await admin.app.grant('not a link', 2);
    expect(admin.app.screen.value).toMatchObject({ notice: 'bad-link' });
    await admin.app.grant(memberLink.url, 2);
    expect(admin.app.screen.value).toMatchObject({ notice: 'granted' });
    expect(server.state.granted).toEqual([{ link: memberLink.id, invitations: 2 }]);
    // Pasted links work in either form: through a named Mini App or the
    // bot's main one. Only the start parameter counts.
    const payload = new URL(memberLink.url).searchParams.get('startapp')!;
    await admin.app.grant(`https://t.me/test_bot/dev?startapp=${payload}`, 1);
    await admin.app.grant(`https://t.me/test_bot?startapp=${payload}`, 3);
    expect(server.state.granted).toEqual([
      { link: memberLink.id, invitations: 2 },
      { link: memberLink.id, invitations: 1 },
      { link: memberLink.id, invitations: 3 },
    ]);
    expect(server.unsigned).toEqual([]);

    await admin.app.home();
    expect(bridge.posted.at(-1)).toEqual({ type: 'web_app_setup_back_button', data: { is_visible: false } });
  });
});

describe('fetching attachments by themselves', () => {
  const issuer: TokenIssuer = { key: {} as IssuerKey, keyId: new Uint8Array(32) };
  const MiB = 1024 * 1024;
  /** A received attachment, not on this device yet. */
  const received = (db: Awaited<ReturnType<typeof openDatabase>>, id: string, at: number, media: { t: string; s: number; m?: string }, file: 'remote' | 'broken' = 'remote') =>
    addMessage(db, { id, conv: 'c1', at, out: false, status: 'received', file }, { text: '', media: { ...media, id: `upload-${id}`, k: 'a2V5', d: 'c2VjcmV0' } });

  it('fetches photos, voice and video messages and GIFs up to a size for each, and raster images only', async () => {
    const server = fakeServer();
    const { app, db } = await registered(server.api, { issuer });
    await startedOnDevice(db);
    await received(db, 'photo', 2, { t: 'photo', s: 5 * MiB, m: 'image/jpeg' });
    await received(db, 'bigPhoto', 3, { t: 'photo', s: 5 * MiB + 1, m: 'image/jpeg' });
    await received(db, 'svg', 4, { t: 'photo', s: 1000, m: 'image/svg+xml' });
    await received(db, 'voice', 5, { t: 'voice', s: 10 * MiB, m: 'audio/mp4' });
    await received(db, 'bigRound', 6, { t: 'round', s: 10 * MiB + 1, m: 'video/mp4' });
    await received(db, 'gif', 7, { t: 'gif', s: 1000, m: 'image/gif' });
    await received(db, 'bigGif', 8, { t: 'gif', s: 10 * MiB + 1, m: 'image/gif' });
    await received(db, 'video', 9, { t: 'video', s: 1000, m: 'video/mp4' });
    await received(db, 'broken', 10, { t: 'photo', s: 1000, m: 'image/jpeg' }, 'broken');
    const downloads = () => server.calls.filter((c) => c.startsWith('GET /media/'));

    await app.openConversation('c1');
    await vi.waitFor(() => expect(downloads()).toHaveLength(3));
    await tick();
    expect(downloads()).toEqual(['GET /media/upload-photo', 'GET /media/upload-voice', 'GET /media/upload-gif']);
    // The rest wait for a tap: a broken one too, which a tap tries again.
    await app.fetchMedia({ conv: 'c1', id: 'broken' });
    expect(downloads().at(-1)).toBe('GET /media/upload-broken');
  });

  it("downloads nothing by itself in a chat the user hasn't written in; a tap fetches only that one", async () => {
    const server = fakeServer();
    const { app, db } = await registered(server.api, { issuer });
    // The other side's message, then small attachments of each kind that would download by themselves.
    await chatOnDevice(db);
    await received(db, 'p1', 2, { t: 'photo', s: 1000, m: 'image/jpeg' });
    await received(db, 'p2', 3, { t: 'photo', s: 1000, m: 'image/jpeg' });
    await received(db, 'voice', 4, { t: 'voice', s: 1000, m: 'audio/mp4' });
    await received(db, 'gif', 5, { t: 'gif', s: 1000, m: 'image/gif' });
    const downloads = () => server.calls.filter((c) => c.startsWith('GET /media/'));
    /**
     * Opens c1 (again) and waits until what downloads by itself is decided:
     * where the user first wrote was looked up, and once that's over, a
     * download it starts shows at once (fetchMedia marks it under way
     * before it awaits anything).
     */
    const open = async () => {
      const before = lookups.answered;
      await app.home();
      await app.openConversation('c1');
      await vi.waitFor(() => expect(lookups.answered).toBeGreaterThan(before));
      expect(app.transfers.value).toEqual({});
    };

    await open();
    expect(downloads()).toEqual([]);
    // A tap fetches that one only: the others still wait, each on its own.
    await app.fetchMedia({ conv: 'c1', id: 'p2' });
    expect(downloads()).toEqual(['GET /media/upload-p2']);
    await open();
    expect(downloads()).toEqual(['GET /media/upload-p2']);
    // Messages of the user's the server didn't take don't count: not sent, or still sending.
    await addMessage(db, { id: 'notSent', conv: 'c1', at: 6, out: true, status: 'failed' }, { text: 'stop' });
    await addMessage(db, { id: 'sending', conv: 'c1', at: 6, out: true, status: 'sending' }, { text: 'please' });
    await received(db, 'p3', 7, { t: 'photo', s: 1000, m: 'image/jpeg' });
    await open();
    expect(downloads()).toEqual(['GET /media/upload-p2']);
    // One that was sent: what comes after it downloads by itself, and nothing from before.
    await addMessage(db, { id: 'sent', conv: 'c1', at: 8, out: true, status: 'sent' }, { text: 'ok' });
    await received(db, 'p4', 9, { t: 'photo', s: 1000, m: 'image/jpeg' });
    await app.home();
    await app.openConversation('c1');
    await vi.waitFor(() => expect(downloads()).toHaveLength(2));
    await tick();
    expect(downloads()).toEqual(['GET /media/upload-p2', 'GET /media/upload-p4']);
  });

  it('downloads by itself only what came after the first message of the user that was sent, also once that one is deleted', async () => {
    const server = fakeServer();
    const { app, db } = await registered(server.api, { issuer });
    const photo = { t: 'photo', s: 1000, m: 'image/jpeg' };
    await chatOnDevice(db);
    await received(db, 'before', 2, photo);
    // In the same second as the user's message, but here before it.
    await received(db, 'sameSecond', 3, photo);
    // The user's first message, from before this was kept: found from the messages on the device.
    await addMessage(db, { id: 'reply', conv: 'c1', at: 3, out: true, status: 'sent' }, { text: 'stop' });
    await received(db, 'after', 3, photo);
    await received(db, 'later', 4, photo);
    const downloads = () => server.calls.filter((c) => c.startsWith('GET /media/'));

    await app.openConversation('c1');
    await vi.waitFor(() => expect(downloads()).toHaveLength(2));
    await tick();
    expect(downloads()).toEqual(['GET /media/upload-after', 'GET /media/upload-later']);
    // Kept: deleting that message doesn't undo it.
    await deleteMessage(db, 'c1', 'reply');
    await received(db, 'next', 5, photo);
    await app.home();
    await app.openConversation('c1');
    await vi.waitFor(() => expect(downloads()).toHaveLength(3));
    await tick();
    expect(downloads().at(-1)).toBe('GET /media/upload-next');
    // What came before it still waits for a tap.
    expect(app.screen.value).toMatchObject({ messages: [{ id: 'm1' }, { id: 'before', file: 'remote' }, { id: 'sameSecond', file: 'remote' }, {}, {}, {}] });
  });

  /**
   * Opens chat c1, whose photo p1 fails to fetch, again and again: once at
   * once, then minutes apart. The photo is fetched by itself three times in
   * all, then left for a tap.
   */
  async function triedThreeTimes(server: ReturnType<typeof fakeServer>, app: Awaited<ReturnType<typeof registered>>['app']) {
    const downloads = () => server.calls.filter((c) => c.startsWith('GET /media/'));
    /**
     * Opens c1 (again), and waits until it has been fetched `tries` times in
     * all and the fetch is over: its failure counted, and the pause after it
     * set by the clock of that moment. A slow answer must not leave it still
     * under way at the next opening, which would then skip it.
     */
    const open = async (tries: number) => {
      await app.home();
      await app.openConversation('c1');
      await vi.waitFor(() => expect(downloads()).toHaveLength(tries));
      await tick();
      await vi.waitFor(() => expect(app.transfers.value).toEqual({}));
      // And not once more.
      expect(downloads()).toHaveLength(tries);
    };
    await open(1);
    // Not again at once.
    await open(1);
    // Then a few minutes apart, three times in all.
    for (const [minutes, tries] of [[3, 2], [6, 3], [9, 3], [12, 3]] as const) {
      await withDeviceClockOff(minutes * 60_000, () => open(tries));
    }
    expect(app.screen.value).toMatchObject({ kind: 'conversation', messages: [{ id: 'hi' }, { id: 'm1' }, { id: 'p1', file: 'remote' }] });
  }

  it.each([
    ['the server failing', new ApiError(500, 'internal')],
    ['the server out of reach', new NetworkError('down')],
    ['the server refusing it', new ApiError(400, 'bad_request')],
  ])('tries one again by itself only a few times while it keeps failing: %s', async (_, failure) => {
    const server = fakeServer();
    server.state.media = failure;
    const { app, db } = await registered(server.api, { issuer });
    await startedOnDevice(db);
    await received(db, 'p1', 2, { t: 'photo', s: 1000, m: 'image/jpeg' });
    await triedThreeTimes(server, app);
    // A tap still asks.
    await app.fetchMedia({ conv: 'c1', id: 'p1' });
    expect(server.calls.filter((c) => c.startsWith('GET /media/'))).toHaveLength(4);
  });

  it('tries one again by itself only a few times while the device is too full to keep it', async () => {
    const server = fakeServer();
    const { app, db } = await registered(server.api, { issuer });
    await startedOnDevice(db);
    // A real upload, which downloads and decrypts; only storing it fails.
    const file = crypto.getRandomValues(new Uint8Array(1000));
    const key = newFileKey();
    const upload = await encryptFile(file, key);
    await addMessage(
      db,
      { id: 'p1', conv: 'c1', at: 2, out: false, status: 'received', file: 'remote' },
      { text: '', media: { t: 'photo', s: file.length, m: 'image/jpeg', w: 10, h: 10, id: 'upload-p1', k: toBase64Url(key), d: 'c2VjcmV0' } },
    );
    server.state.mediaUrl = 'https://bucket.example/m/upload-p1';
    vi.stubGlobal('fetch', async () => new Response(upload.slice(), { headers: { 'Content-Length': String(upload.length) } }));
    storeFaults.putMedia = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    try {
      await triedThreeTimes(server, app);
      // Room again: a tap stores it.
      storeFaults.putMedia = null;
      await app.fetchMedia({ conv: 'c1', id: 'p1' });
      expect(await getMedia(db, 'c1', 'p1')).toEqual(file);
    } finally {
      storeFaults.putMedia = null;
      vi.unstubAllGlobals();
    }
  });

  it("leaves one downloaded as often as a day allows, without holding up the rest, and a tap says until when", async () => {
    const server = fakeServer();
    // Its downloads used up, for the next hour (until the UTC day ends).
    server.state.mediaRefused.set('upload-p1', new ApiError(429, 'download_limit', undefined, undefined, 3600));
    const { app, db } = await registered(server.api, { issuer });
    await startedOnDevice(db);
    await received(db, 'p1', 2, { t: 'photo', s: 1000, m: 'image/jpeg' });
    await received(db, 'p2', 3, { t: 'photo', s: 1000, m: 'image/jpeg' });
    const downloads = () => server.calls.filter((c) => c.startsWith('GET /media/'));

    await app.openConversation('c1');
    await vi.waitFor(() => expect(downloads()).toHaveLength(2));
    await tick();
    // Quietly, and the next is fetched all the same (here it has expired).
    expect(downloads()).toEqual(['GET /media/upload-p1', 'GET /media/upload-p2']);
    expect(app.screen.value).toMatchObject({ kind: 'conversation', error: null, messages: [{ id: 'hi' }, { id: 'm1' }, { id: 'p1', file: 'remote' }, { id: 'p2', file: 'gone' }] });
    // Not fetched by itself again in this run, minutes later either.
    await withDeviceClockOff(3 * 60_000, async () => {
      await app.home();
      await app.openConversation('c1');
      await tick();
    });
    expect(downloads()).toHaveLength(2);

    // A tap asks, and says from when it can be fetched again.
    const before = Date.now();
    await app.fetchMedia({ conv: 'c1', id: 'p1' });
    expect(downloads()).toHaveLength(3);
    const conv = app.screen.value;
    if (conv.kind !== 'conversation' || typeof conv.error !== 'object' || conv.error === null) throw new Error(`no limit shown: ${JSON.stringify(conv)}`);
    expect(conv.error.kind).toBe('download-limit');
    expect(conv.error.until).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(conv.error.until).toBeLessThanOrEqual(Date.now() + 3_600_000);
    // The next day a tap fetches it (here it has expired), and the notice goes.
    server.state.mediaRefused.clear();
    await app.fetchMedia({ conv: 'c1', id: 'p1' });
    expect(app.screen.value).toMatchObject({ kind: 'conversation', error: null, messages: [{ id: 'hi' }, { id: 'm1' }, { id: 'p1', file: 'gone' }, { id: 'p2', file: 'gone' }] });
  });
});

describe('attachments paused by the operator', () => {
  const issuer: TokenIssuer = { key: {} as IssuerKey, keyId: new Uint8Array(32) };

  it('fetches nothing more by itself while downloads are paused, says so on a tap, and tries again later', async () => {
    const server = fakeServer();
    server.state.switches.downloadsPaused = true;
    const { app, db } = await registered(server.api, { issuer });
    await startedOnDevice(db);
    // Two photos, which would download as the chat opens.
    for (const [id, at] of [['p1', 2], ['p2', 3]] as const) {
      await addMessage(
        db,
        { id, conv: 'c1', at, out: false, status: 'received', file: 'remote' },
        { text: '', media: { t: 'photo', s: 1000, m: 'image/jpeg', w: 10, h: 10, id: `upload-${id}`, k: 'a2V5', d: 'c2VjcmV0' } },
      );
    }
    const downloads = () => server.calls.filter((c) => c.startsWith('GET /media/'));

    await app.openConversation('c1');
    await vi.waitFor(() => expect(downloads()).toHaveLength(1));
    await tick();
    // One refusal, not one per photo, and quietly: no notice.
    expect(downloads()).toEqual(['GET /media/upload-p1']);
    expect(app.screen.value).toMatchObject({ kind: 'conversation', error: null, messages: [{ id: 'hi' }, { id: 'm1' }, { id: 'p1', file: 'remote' }, { id: 'p2', file: 'remote' }] });
    // Opening it again soon after asks nothing.
    await app.home();
    await app.openConversation('c1');
    await tick();
    expect(downloads()).toHaveLength(1);

    // A tap asks, and says why it didn't work.
    await app.fetchMedia({ conv: 'c1', id: 'p2' });
    expect(downloads()).toEqual(['GET /media/upload-p1', 'GET /media/upload-p2']);
    expect(app.screen.value).toMatchObject({ kind: 'conversation', error: 'media-paused' });

    // Resumed: a tap asks at once, the notice goes (here the upload has
    // expired), and fetching by itself starts again at once too.
    server.state.switches.downloadsPaused = false;
    await app.fetchMedia({ conv: 'c1', id: 'p2' });
    expect(downloads()).toHaveLength(3);
    expect(app.screen.value).toMatchObject({ kind: 'conversation', error: null, messages: [{ id: 'hi' }, { id: 'm1' }, { id: 'p1', file: 'remote' }, { id: 'p2', file: 'gone' }] });
    await app.home();
    await app.openConversation('c1');
    await vi.waitFor(() => expect(downloads()).toHaveLength(4));
    expect(downloads().at(-1)).toBe('GET /media/upload-p1');
  });

  it('takes the paused notice away after a tap that fetches, though the tap that brought it was still waiting to be drawn', async () => {
    const server = fakeServer();
    server.state.switches.downloadsPaused = true;
    const { app, db } = await registered(server.api, { issuer });
    await startedOnDevice(db);
    for (const [id, at] of [['p1', 2], ['p2', 3]] as const) {
      await addMessage(
        db,
        { id, conv: 'c1', at, out: false, status: 'received', file: 'remote' },
        { text: '', media: { t: 'photo', s: 1000, m: 'image/jpeg', w: 10, h: 10, id: `upload-${id}`, k: 'a2V5', d: 'c2VjcmV0' } },
      );
    }
    const downloads = () => server.calls.filter((c) => c.startsWith('GET /media/'));
    await app.openConversation('c1');
    await vi.waitFor(() => expect(downloads()).toHaveLength(1));

    // A draw of the chat under way, slow to read: what's drawn next waits its turn.
    const drawing = holdRead('pageMessages');
    const redrawn = app.refresh();
    await drawing.atRead;
    // A tap while downloads are paused: the notice is to show, once it's drawn.
    const refused = app.fetchMedia({ conv: 'c1', id: 'p2' });
    await vi.waitFor(() => expect([downloads().length, app.transfers.value]).toEqual([2, {}]));
    // Resumed: a tap fetches (here the upload has expired), so the notice goes.
    server.state.switches.downloadsPaused = false;
    const fetched = app.fetchMedia({ conv: 'c1', id: 'p1' });
    await vi.waitFor(() => expect([downloads().length, app.transfers.value]).toEqual([3, {}]));
    drawing.release();
    await Promise.all([redrawn, refused, fetched]);
    expect(app.screen.value).toMatchObject({ kind: 'conversation', error: null, messages: [{ id: 'hi' }, { id: 'm1' }, { id: 'p1', file: 'gone' }, { id: 'p2', file: 'remote' }] });
  });

  it('fetches by itself again some minutes after downloads were paused', async () => {
    const server = fakeServer();
    server.state.switches.downloadsPaused = true;
    const { app, db } = await registered(server.api, { issuer });
    await startedOnDevice(db);
    await addMessage(
      db,
      { id: 'p1', conv: 'c1', at: 2, out: false, status: 'received', file: 'remote' },
      { text: '', media: { t: 'photo', s: 1000, m: 'image/jpeg', w: 10, h: 10, id: 'upload-p1', k: 'a2V5', d: 'c2VjcmV0' } },
    );
    const downloads = () => server.calls.filter((c) => c.startsWith('GET /media/'));
    await app.openConversation('c1');
    await vi.waitFor(() => expect(downloads()).toHaveLength(1));
    server.state.switches.downloadsPaused = false;
    await app.home();
    await app.openConversation('c1');
    await tick();
    expect(downloads()).toHaveLength(1);
    await withDeviceClockOff(3 * 60_000, async () => {
      await app.home();
      await app.openConversation('c1');
      await vi.waitFor(() => expect(downloads()).toHaveLength(2));
    });
  });

  it('lets admins pause and resume uploads and downloads for everyone, with signed requests', async () => {
    const server = fakeServer();
    server.state.admin = true;
    const admin = await registered(server.api);
    await admin.app.admin();
    expect(admin.app.screen.value).toMatchObject({ kind: 'admin', switches: { uploadsPaused: false, downloadsPaused: false } });

    await admin.app.setSwitch('uploads', true);
    expect(admin.app.screen.value).toMatchObject({ kind: 'admin', notice: 'switched', switches: { uploadsPaused: true, downloadsPaused: false } });
    await admin.app.setSwitch('downloads', true);
    await admin.app.setSwitch('uploads', false);
    expect(admin.app.screen.value).toMatchObject({ notice: 'switched', switches: { uploadsPaused: false, downloadsPaused: true } });
    expect(server.state.switches).toEqual({ uploadsPaused: false, downloadsPaused: true });
    expect(server.calls.filter((c) => c === 'PUT /admin/switches')).toHaveLength(3);
    expect(server.unsigned).toEqual([]);

    // If they can't be read, the rest of the screen still works.
    server.state.switchesDown = true;
    await admin.app.home();
    await admin.app.admin();
    expect(admin.app.screen.value).toMatchObject({ kind: 'admin', switches: null, levels: [] });
    await admin.app.setSwitch('downloads', false);
    expect(admin.app.screen.value).toMatchObject({ kind: 'admin', notice: 'generic', switches: null });
  });
});

describe('typed confirmation', () => {
  it('matches ignoring case and extra spaces, in both languages', () => {
    expect(confirmationMatches('  Start   OVER ', 'start over')).toBe(true);
    expect(confirmationMatches('شروع  دوباره', 'شروع دوباره')).toBe(true);
    expect(confirmationMatches('start', 'start over')).toBe(false);
    expect(confirmationMatches('', '')).toBe(false);
  });

  it('reads the dotted and dotless i (İ I ı i) as one letter, whatever the device language', () => {
    // A Turkish keyboard types İ for a capital i; lowercased outside Turkish
    // it becomes i plus a combining dot, and I becomes ı in Turkish.
    expect(confirmationMatches('HESAP SİL', 'hesap sil')).toBe(true);
    expect(confirmationMatches('Sil', 'sil')).toBe(true);
    expect(confirmationMatches('HESABIMI SIL', 'hesabımı sil')).toBe(true);
    expect(confirmationMatches('hesabimi sil', 'hesabımı sil')).toBe(true);
    expect(confirmationMatches('hesap sal', 'hesap sil')).toBe(false);
  });

  it("doesn't depend on how the device's language lowercases", () => {
    const lower = String.prototype.toLocaleLowerCase;
    for (const language of ['tr', 'az', 'lt']) {
      const spy = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (this: string) {
        return lower.call(this, language);
      });
      try {
        expect(confirmationMatches('HESAP SIL', 'hesap sil'), language).toBe(true);
        expect(confirmationMatches('HESAP SİL', 'hesap sil'), language).toBe(true);
        expect(confirmationMatches('BORRAR DÍA', 'borrar día'), language).toBe(true);
      } finally {
        spy.mockRestore();
      }
    }
  });

  it('takes the phrase however a keyboard types it', () => {
    // A zero-width non-joiner typed as a space, or as nothing.
    const zwnj = 'گفت‌وگو';
    expect(confirmationMatches('گفت وگو', zwnj)).toBe(true);
    expect(confirmationMatches('گفتوگو', zwnj)).toBe(true);
    expect(confirmationMatches(zwnj, 'گفت وگو')).toBe(true);
    // Arabic layouts type kaf and yeh (ك ي ى) for the Persian ک and ی.
    expect(confirmationMatches('پاك كردن', 'پاک کردن')).toBe(true);
    expect(confirmationMatches('گفت‌وگوهايم', 'گفت‌وگوهایم')).toBe(true);
    expect(confirmationMatches('ى', 'ی')).toBe(true);
    // No spaces at all, or direction marks from a copied phrase.
    expect(confirmationMatches('deletemychats', 'delete my chats')).toBe(true);
    expect(confirmationMatches('⁨حذف همه⁩', 'حذف همه')).toBe(true);
    // Still the phrase, though.
    expect(confirmationMatches('حذف', 'حذف همه')).toBe(false);
    expect(confirmationMatches('‌ ⁨', '‌')).toBe(false);
  });

  it("uses phrases any keyboard can type: no zero-width non-joiner, ک or ی", () => {
    for (const key of ['replacePhrase', 'deletePhrase', 'resetPhrase'] as const) {
      for (const phrase of [en[key], fa[key]]) expect(phrase).not.toMatch(/[‌کیكي]/);
    }
  });
});

describe('the source link', () => {
  const commit = '41ee5804e4fcf04c74d650cc44541da131336d60';
  const manifest = () => new Response(JSON.stringify({ repository: 'example/app', commit }));

  // The app served from a path of its origin, with the manifest beside it,
  // and the network answering with fetcher.
  async function served(fetcher: typeof fetch, run: () => Promise<void>): Promise<void> {
    vi.stubGlobal('location', { origin: 'https://app.example', pathname: '/app/' });
    vi.stubGlobal('fetch', fetcher);
    try {
      await run();
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("opens the source tree the build's manifest names, in the device's browser", async () => {
    const asked: string[] = [];
    await served(
      async (input) => {
        asked.push(String(input));
        return manifest();
      },
      async () => {
        const { bridge, posted } = fakeBridge();
        const { app } = await setup({ api: null, bridge });
        expect(asked).toEqual([]);
        app.prepareSource();
        // Looked up when the home screen shows, before any tap, and once.
        expect(asked).toEqual(['https://app.example/app/manifest.json']);
        expect(await app.openSource()).toBe('opened');
        expect(await app.openSource()).toBe('opened');
        expect(asked).toHaveLength(1);
        expect(posted.filter((p) => p.type === 'web_app_open_link')).toEqual([
          { type: 'web_app_open_link', data: { url: `https://github.com/example/app/tree/${commit}` } },
          { type: 'web_app_open_link', data: { url: `https://github.com/example/app/tree/${commit}` } },
        ]);
      },
    );
  });

  it('opens it once for a second tap while the first still waits', async () => {
    let answer: (r: Response) => void = () => {};
    await served(
      () => new Promise<Response>((resolve) => (answer = resolve)),
      async () => {
        const { bridge, posted } = fakeBridge();
        const { app } = await setup({ api: null, bridge });
        const first = app.openSource();
        expect(await app.openSource()).toBe('waiting');
        answer(manifest());
        expect(await first).toBe('opened');
        expect(posted.filter((p) => p.type === 'web_app_open_link')).toHaveLength(1);
      },
    );
  });

  it('opens nothing for a tap that waited while the app was hidden', async () => {
    let answer: (r: Response) => void = () => {};
    await served(
      () => new Promise<Response>((resolve) => (answer = resolve)),
      async () => {
        const { bridge, posted } = fakeBridge();
        let visibility: (data: { is_visible: boolean }) => void = () => {};
        bridge.on = ((type: string, handler: typeof visibility) => {
          if (type === 'visibility_changed') visibility = handler;
          return () => {};
        }) as Bridge['on'];
        const { app } = await setup({ api: null, bridge });
        const tap = app.openSource();
        visibility({ is_visible: false });
        answer(manifest());
        expect(await tap).toBe('waiting');
        // Nor does it say "couldn't find" on return, when the lookup failed.
        const other = await setup({ api: null, bridge });
        const failed = other.app.openSource();
        visibility({ is_visible: false });
        answer(new Response('', { status: 404 }));
        expect(await failed).toBe('waiting');
        expect(posted.some((p) => p.type === 'web_app_open_link')).toBe(false);
      },
    );
  });

  it('opens nothing when the build names no source, and looks again next time', async () => {
    const answers = [
      new Response('', { status: 404 }),
      new Response(JSON.stringify({ repository: 'evil.example/x', commit })),
      manifest(),
    ];
    await served(
      async () => answers.shift()!,
      async () => {
        const { bridge, posted } = fakeBridge();
        const { app } = await setup({ api: null, bridge });
        app.prepareSource();
        expect(await app.openSource()).toBe('unknown');
        expect(await app.openSource()).toBe('unknown');
        expect(posted.some((p) => p.type === 'web_app_open_link')).toBe(false);
        expect(await app.openSource()).toBe('opened');
        expect(answers).toEqual([]);
      },
    );
  });

  it('looks nothing up outside Telegram', async () => {
    let asked = 0;
    await served(
      async () => {
        asked++;
        return manifest();
      },
      async () => {
        const { app } = await setup({ api: null });
        app.prepareSource();
        expect(await app.openSource()).toBe('unknown');
        expect(asked).toBe(0);
      },
    );
  });
});
