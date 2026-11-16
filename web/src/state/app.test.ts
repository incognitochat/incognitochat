import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { readAccount } from '../account/account';
import { ApiError, NetworkError, type Api } from '../net/api';
import { parseLaunch, type Launch } from '../platform/launch';
import type { Bridge, OutgoingEvents } from '../platform/telegram';
import { getMeta, openDatabase, putMeta } from '../storage/db';
import { addMessage, getMedia, listMessages, putConversation, putMedia } from '../messaging/store';
import { DEFAULT_MEDIA_SETTINGS, getMediaSettings } from '../messaging/settings';
import type { SyncEvent } from '../sync/locks';
import type { TokenIssuer } from '../account/wallet';
import type { IssuerKey } from '../crypto/blindrsa';
import { en } from '../i18n/en';
import { fa } from '../i18n/fa';
import { confirmationMatches, createApp, type Deps, type Screen } from './app';

let n = 0;
const config = {
  apiUrl: 'https://api.example',
  botUsername: 'test_bot',
  appName: 'dev',
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
    // The operator's emergency switches; switchesDown: they can't be read.
    switches: { uploadsPaused: false, downloadsPaused: false },
    switchesDown: false,
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
      if (path === '/accounts/lookup') return check({ exists: outcomes.elsewhere === true });
      if (path === '/register') {
        take(outcomes.register);
        return check({ account: 'BBBBBBBBBBBBBBBBBBBBBB', token: 'v1.p.m', expires: serverSeconds() + 900 });
      }
      if (path === '/session') {
        loginTimes.push(Number(body.timestamp));
        const skew = clockSkew(body.timestamp);
        if (skew) throw skew;
        take(outcomes.session);
        return check({ account: 'BBBBBBBBBBBBBBBBBBBBBB', token: 'v1.p.m', expires: serverSeconds() + 900 });
      }
      if (method === 'DELETE' && path === '/account') {
        needsSignature();
        take(outcomes.deleteAccount);
        state.deleted = true;
        bundles.clear();
        return check({});
      }
      const canCreateLinks = !state.inviteOnly || state.member || state.admin;
      if (path === '/account') {
        take(outcomes.account);
        return check({ canCreateLinks, admin: state.admin, links: bundles.size, maxLinks: 5 });
      }
      if (method === 'GET' && path === '/usage') {
        const item = (used: number, limit: number) => ({ used, limit });
        return check({ resetsAt: 1_800_028_800, send: item(980, 1000), media: item(24, 1024), mailboxes: item(10, 100), linkChanges: item(1, 5), owned: item(10, 2000) });
      }
      if (method === 'GET' && path === '/invitations') {
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
      if (path === '/admin/levels' && method === 'GET') return check({ levels: [...state.levels].map(([level, invitations]) => ({ level, invitations })) });
      if (path === '/admin/levels' && method === 'PUT') {
        needsSignature();
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
        throw new ApiError(404, 'not_found');
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
  return { api, calls, bundles, unsigned, state, loginTimes };
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
    expect(open?.data).toEqual({ path_full: `/test_bot/dev?startapp=reg${code}` });
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
    expect(bridge.posted.find((p) => p.type === 'web_app_open_tg_link')?.data).toEqual({ path_full: `/test_bot/dev?startapp=${code}` });
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
    await chatOnDevice(db);
    // A photo not on the device yet, which would download as the chat opens.
    await addMessage(
      db,
      { id: 'p1', conv: 'c1', at: 2, out: false, status: 'received', file: 'remote' },
      { text: '', media: { t: 'photo', s: 1000, w: 10, h: 10, id: 'upload-p1', k: 'a2V5', d: 'c2VjcmV0' } },
    );
    const { app } = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(''), db });
    await app.start();
    expect(app.screen.value).toMatchObject({ kind: 'signed-out' });
    expect(app.readOnly.value).toBe(true);
    const before = server.calls.length;

    await app.readChats();
    await app.openConversation('c1');
    expect(app.screen.value).toMatchObject({ kind: 'conversation', readOnly: true, messages: [{ id: 'm1' }, { id: 'p1', file: 'remote' }] });
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

describe('links', () => {
  it('creates a link with signed requests, and others can verify it', async () => {
    const server = fakeServer();
    const owner = await registered(server.api);
    await owner.app.createLink();
    const screen = home(owner.app.screen.value);
    expect(screen.notice).toBe('created');
    expect(screen.links).toHaveLength(1);
    const url = screen.links[0]!.url;
    expect(url).toMatch(/^https:\/\/t\.me\/test_bot\/dev\?startapp=1[A-Za-z0-9_-]{54}$/);
    expect(server.unsigned).toEqual([]);

    // Someone else opens it: the bundle must match the fingerprint in the link.
    const sender = await registered(server.api, { launch: launchWith(payloadOf(url)) });
    expect(sender.app.screen.value).toMatchObject({ kind: 'link', status: 'verified' });

    // The owner opening their own link is told so.
    const { app: ownerAgain } = await setup({ api: server.api, bridge: fakeBridge().bridge, launch: launchWith(payloadOf(url)), db: owner.db });
    await ownerAgain.start();
    expect(ownerAgain.screen.value).toMatchObject({ kind: 'link', status: 'own' });
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

  it('says when an invitation is needed', async () => {
    const server = fakeServer({ createLink: [new ApiError(403, 'invitation_required')] });
    const owner = await registered(server.api);
    await owner.app.createLink();
    expect(home(owner.app.screen.value)).toMatchObject({ notice: 'invitation', links: [] });
    server.state.inviteOnly = true;
    await owner.app.home();
    expect(home(owner.app.screen.value).account?.canCreateLinks).toBe(false);
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
    expect(owner.app.screen.value).toEqual({ kind: 'confirm-delete', busy: false, error: 'network' });
    expect(await readAccount(owner.db)).toMatchObject({ state: 'registered' });
    // Trying again works.
    await owner.app.deleteAccount();
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
    expect(owner.app.screen.value).toMatchObject({ kind: 'confirm-delete', error: 'network' });
    await owner.app.deleteAccount();
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
    expect(owner.app.screen.value).toEqual({ kind: 'confirm-delete', busy: false, error: 'generic' });
    expect(await readAccount(owner.db)).toMatchObject({ state: 'registered' });
    expect(await listMessages(owner.db, 'c1')).toHaveLength(1);
    // Trying again finishes it.
    await owner.app.deleteAccount();
    expect(owner.app.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
  });

  it('cancels back to the link tab', async () => {
    const owner = await registered(fakeServer().api);
    owner.app.askDeleteAccount();
    await owner.app.cancelDeleteAccount();
    expect(home(owner.app.screen.value).tab).toBe('links');
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
});

describe('data and storage', () => {
  const DAY = 24 * 60 * 60 * 1000;
  /** A received photo already on the device, as if fetched days ago. */
  async function photoOnDevice(db: Awaited<ReturnType<typeof openDatabase>>, id: string, daysAgo: number) {
    await addMessage(
      db,
      { id, conv: 'c1', at: Date.now() - daysAgo * DAY, out: false, status: 'read', file: 'local' },
      { text: '', media: { t: 'photo', s: 1000, w: 10, h: 10, id: `upload-${id}`, k: 'a2V5', d: 'c2VjcmV0' } },
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

  it('clears all media on request, and goes back to the link tab', async () => {
    const owner = await registered(fakeServer().api);
    await putMeta(owner.db, 'media-settings', { keep: 'forever' });
    await photoOnDevice(owner.db, 'a', 40);
    await photoOnDevice(owner.db, 'b', 0);
    await owner.app.showTab('links');
    await owner.app.storage();
    await owner.app.clearMedia();
    expect(owner.app.screen.value).toMatchObject({ kind: 'storage', usage: { media: 0, chats: [] }, cleared: 2000 });
    expect(owner.broadcasts).toContainEqual({ type: 'data-changed' });
    await owner.app.home();
    expect(home(owner.app.screen.value).tab).toBe('links');
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
    await owner.app.showTab('links');
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
    await vi.waitFor(() => expect(home(owner.app.screen.value).tab).toBe('links'));
    expect(shown()).toEqual({ is_visible: false });
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
    expect(screen.info.codes[0]).toMatchObject({ code: 'aaaa-aaaa', uses: 3, left: 3, url: 'https://t.me/test_bot/dev?startapp=invaaaaaaaa' });
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
    expect(server.unsigned).toEqual([]);

    await admin.app.home();
    expect(bridge.posted.at(-1)).toEqual({ type: 'web_app_setup_back_button', data: { is_visible: false } });
  });
});

describe('attachments paused by the operator', () => {
  const issuer: TokenIssuer = { key: {} as IssuerKey, keyId: new Uint8Array(32) };

  it('fetches nothing more by itself while downloads are paused, says so on a tap, and tries again later', async () => {
    const server = fakeServer();
    server.state.switches.downloadsPaused = true;
    const { app, db } = await registered(server.api, { issuer });
    await chatOnDevice(db);
    // Two photos, which would download as the chat opens.
    for (const [id, at] of [['p1', 2], ['p2', 3]] as const) {
      await addMessage(
        db,
        { id, conv: 'c1', at, out: false, status: 'received', file: 'remote' },
        { text: '', media: { t: 'photo', s: 1000, w: 10, h: 10, id: `upload-${id}`, k: 'a2V5', d: 'c2VjcmV0' } },
      );
    }
    const downloads = () => server.calls.filter((c) => c.startsWith('GET /media/'));

    await app.openConversation('c1');
    await vi.waitFor(() => expect(downloads()).toHaveLength(1));
    await tick();
    // One refusal, not one per photo, and quietly: no notice.
    expect(downloads()).toEqual(['GET /media/upload-p1']);
    expect(app.screen.value).toMatchObject({ kind: 'conversation', error: null, messages: [{ id: 'm1' }, { id: 'p1', file: 'remote' }, { id: 'p2', file: 'remote' }] });
    // Opening it again soon after asks nothing.
    await app.home();
    await app.openConversation('c1');
    await tick();
    expect(downloads()).toHaveLength(1);

    // A tap asks, and says why it didn't work.
    await app.fetchMedia({ conv: 'c1', id: 'p2' });
    expect(downloads()).toEqual(['GET /media/upload-p1', 'GET /media/upload-p2']);
    expect(app.screen.value).toMatchObject({ kind: 'conversation', error: 'media-paused' });

    // Resumed: a tap asks at once, and the notice goes (here the upload has expired).
    server.state.switches.downloadsPaused = false;
    await app.fetchMedia({ conv: 'c1', id: 'p2' });
    expect(downloads()).toHaveLength(3);
    expect(app.screen.value).toMatchObject({ kind: 'conversation', error: null, messages: [{ id: 'm1' }, { id: 'p1', file: 'remote' }, { id: 'p2', file: 'gone' }] });
    // Some minutes later, by itself again.
    await withDeviceClockOff(3 * 60_000, async () => {
      await app.home();
      await app.openConversation('c1');
      await vi.waitFor(() => expect(downloads()).toHaveLength(4));
    });
    expect(downloads().at(-1)).toBe('GET /media/upload-p1');
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
