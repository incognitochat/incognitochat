import 'fake-indexeddb/auto';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { readAccount } from '../account/account';
import type { TokenIssuer } from '../account/wallet';
import { i2osp, modPow, os2ip, type IssuerKey } from '../crypto/blindrsa';
import { fromBase64Url, toBase64Url } from '../crypto/encoding';
import { ApiError, NetworkError, type Api } from '../net/api';
import { parseLaunch, type Launch } from '../platform/launch';
import type { Bridge } from '../platform/telegram';
import { canResend } from '../messaging/engine';
import { addMessage, getConversation, listConversations, listMessages, listRecords, PAGE, putConversation } from '../messaging/store';
import { countTokens, takeTokens } from '../account/wallet';
import { parsePayload } from '../protocol/link';
import { getMeta, openDatabase, putMeta } from '../storage/db';
import { pickLanguage } from '../i18n';
import type { SyncEvent } from '../sync/locks';
import { canRetryChats, createApp, MAX_SHOWN, type LimitError, type Screen } from './app';

// A read of an open chat's page held up once it's done, until the test lets
// it go (holdPage): as a slow IndexedDB would, with its draw still under way.
const pages = vi.hoisted(() => ({ hold: null as (() => Promise<void>) | null }));
vi.mock('../messaging/store', async (importOriginal) => {
  const original = await importOriginal<typeof import('../messaging/store')>();
  return {
    ...original,
    pageMessages: async (...args: Parameters<typeof original.pageMessages>) => {
      const page = await original.pageMessages(...args);
      const hold = pages.hold;
      pages.hold = null;
      await hold?.();
      return page;
    },
  };
});

/** Holds the next read of an open chat's page, once it's done, until released. */
function holdPage() {
  let reached!: () => void;
  const atRead = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  pages.hold = () => {
    reached();
    return released;
  };
  return { atRead, release };
}

let n = 0;
const rand = () => toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
const config = {
  apiUrl: 'https://api.example',
  botUsername: 'test_bot',
  issuer: { name: 'test', spki: new Uint8Array(0), keyId: new Uint8Array(32) },
};

/** A backend with several accounts, the delivery rules, and a real token issuer. */
async function backend() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-384' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const big = (s: string) => os2ip(fromBase64Url(s));
  const key: IssuerKey = { key: pair.publicKey, n: big(jwk.n!), e: big(jwk.e!), k: 256 };
  const issuer: TokenIssuer = { key, keyId: new Uint8Array(32) };
  const d = big(jwk.d!);

  const owners = new Map<string, string>(); // mailbox -> account
  const inboxes = new Map<string, { id: string; mailbox: string; envelope: string }[]>();
  const bundles = new Map<string, Record<string, unknown>>();
  // uploadsPaused: the operator has paused uploads; mediaSigned: media
  // tokens signed; keyRetired: the issuer keys the apps' build names are
  // replaced, and no longer held; mailboxesFull: accounts hold all the
  // mailboxes they may (4,000); sendRefused: how every send is refused, if set.
  // tokensRefused: how every token request is refused, if set.
  // uploadsTurnedAway: the firewall turns uploads away (too many requests
  // from this address).
  const state = {
    tokensLeft: Infinity,
    uploadsPaused: false,
    uploadsTurnedAway: false,
    mediaSigned: 0,
    keyRetired: false,
    mailboxesFull: false,
    sendRefused: null as ApiError | null,
    tokensRefused: null as ApiError | null,
    // The accounts deleted (DELETE /account), and the uploads deleted (POST /media/delete), by ID.
    deletedAccounts: [] as string[],
    deletedUploads: [] as string[],
  };
  // An older server says no notice language; languageRefused: how a change of it is refused, if set.
  const noticeState = { languageSaid: true, languageRefused: null as Error | null };
  /** Requests to the media routes. */
  const mediaCalls: string[] = [];
  // What the app sent to /notices and /send, to check what it tells the server.
  const noticeSetups: string[] = [];
  const sends: Record<string, unknown>[] = [];
  // Every request, as "METHOD /path", in order.
  const calls: string[] = [];
  const noticesOn = new Set<string>();
  // The language notices are sent in, as the server picks it from the launch data; and what the app sent to change it.
  const noticeLanguages = new Map<string, string>();
  const languageChanges: string[] = [];
  const telegramLanguage = (initData: string) => {
    const user = JSON.parse(new URLSearchParams(initData).get('user') ?? '{}') as { language_code?: string };
    return pickLanguage(user.language_code ?? '');
  };
  // Accounts whose notices Telegram refused (the user blocked the bot), not set up since.
  const noticesRefused = new Set<string>();

  const api: Api = {
    post: (path, body, check) => api.request('POST', path, { body: JSON.stringify(body) }, check),
    async request(method, path, init, check) {
      calls.push(`${method} ${path}`);
      const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      const auth = init.headers?.['X-Session'];
      const account = auth ? auth.split('.')[1]! : '';
      const token = (a: string) => ({ account: a, token: `v1.${a}.m`, expires: Math.floor(Date.now() / 1000) + 900 });
      if (path === '/register') {
        const a = rand();
        inboxes.set(a, []);
        return check(token(a));
      }
      if (path === '/session') return check(token(body.account as string));
      if (method === 'DELETE' && path === '/account') {
        // All in one step: its link and mailboxes go, so sends to them are dropped.
        state.deletedAccounts.push(account);
        for (const [id, b] of bundles) if (owners.get(b.mailbox as string) === account) bundles.delete(id);
        for (const [mailbox, a] of owners) if (a === account) owners.delete(mailbox);
        inboxes.set(account, []);
        return check({});
      }
      if (path === '/account') {
        const noticeLanguage = noticeState.languageSaid && noticesOn.has(account) ? { noticeLanguage: noticeLanguages.get(account) } : {};
        return check({ canCreateLinks: true, admin: false, links: 0, maxLinks: 5, notices: noticesOn.has(account), noticesRefused: noticesRefused.has(account), ...noticeLanguage });
      }
      if (path === '/notices') {
        noticeSetups.push(body.initData as string);
        noticesOn.add(account);
        noticesRefused.delete(account);
        noticeLanguages.set(account, telegramLanguage(body.initData as string));
        return check({});
      }
      if (path === '/notices/language') {
        // The launch data alone: never the language chosen in the app.
        if (Object.keys(body).join() !== 'initData') throw new Error(`sent ${Object.keys(body).join()}`);
        languageChanges.push(body.initData as string);
        if (noticeState.languageRefused) throw noticeState.languageRefused;
        if (!noticesOn.has(account)) throw new ApiError(409, 'notices_off');
        noticeLanguages.set(account, telegramLanguage(body.initData as string));
        return check({});
      }
      if (path === '/invitations') {
        return check({ inviteOnly: false, member: false, admin: false, level: 0, unlimited: false, remaining: 0, maxUses: 0, codes: [] });
      }
      if (method === 'POST' && path === '/links') {
        if (body.replaces) {
          const old = bundles.get(body.replaces as string);
          if (!old) throw new ApiError(404, 'not_found');
          bundles.delete(body.replaces as string);
          owners.delete(old.mailbox as string);
        }
        const intro = rand();
        owners.set(intro, account);
        bundles.set(body.id as string, { signingKey: body.signingKey, keys: body.keys, mailbox: intro });
        return check({ id: body.id, mailbox: intro });
      }
      if (method === 'GET' && path.startsWith('/links/')) {
        const b = bundles.get(path.split('/')[2]!);
        if (!b) throw new ApiError(404, 'not_found');
        return check(b);
      }
      if (path === '/mailboxes') {
        if (state.mailboxesFull) throw new ApiError(409, 'mailbox_limit');
        const ids = Array.from({ length: body.count as number }, rand);
        ids.forEach((id) => owners.set(id, account));
        return check({ mailboxes: ids });
      }
      if (path === '/tokens' || path === '/tokens/media') {
        // Signed with the key the request names, the only one held here
        // until it is retired.
        if (state.keyRetired || body.keyId !== toBase64Url(issuer.keyId)) throw new ApiError(409, 'unknown_issuer_key');
        if (state.tokensRefused) throw state.tokensRefused;
        const blinded = body.blinded as string[];
        if (blinded.length > state.tokensLeft) throw new ApiError(429, 'rate_limited');
        state.tokensLeft -= blinded.length;
        if (path === '/tokens/media') state.mediaSigned += blinded.length;
        return check({ signatures: blinded.map((b) => toBase64Url(i2osp(modPow(os2ip(fromBase64Url(b)), d, key.n), 256))) });
      }
      if (path === '/send') {
        if (auth) throw new Error('sends must not carry a login');
        // The tokens of a retired key, told apart from bad ones.
        if (state.keyRetired) throw new ApiError(401, 'unknown_issuer_key');
        if (state.sendRefused) throw state.sendRefused;
        sends.push(body);
        const owner = owners.get(body.mailbox as string);
        if (owner) inboxes.get(owner)!.push({ id: rand(), mailbox: body.mailbox as string, envelope: body.envelope as string });
        return check({});
      }
      if (path.startsWith('/media')) {
        mediaCalls.push(`${method} ${path}`);
        // By the uploads' own secrets, without logging in.
        if (method === 'POST' && path === '/media/delete') {
          const items = body.items as { id: string }[];
          state.deletedUploads.push(...items.map((i) => i.id));
          return check({ results: items.map(() => 'deleted') });
        }
        if (state.uploadsPaused && method === 'POST' && path === '/media') throw new ApiError(503, 'uploads_paused');
        // The firewall's answer, before the server sees anything.
        if (state.uploadsTurnedAway && method === 'POST' && path === '/media') throw new ApiError(429, 'rate_limited');
        throw new ApiError(404, 'not_found');
      }
      if (path === '/inbox') return check({ items: [...inboxes.get(account)!], more: false });
      if (path === '/ack') {
        const done = new Set(body.ids as string[]);
        inboxes.set(account, inboxes.get(account)!.filter((i) => !done.has(i.id)));
        return check({});
      }
      throw new ApiError(404, 'not_found');
    },
  };
  /** Telegram refuses a notice to an account (its user blocked the bot): notify turns them off, as refused. */
  const refuseNotices = (account: string) => {
    noticesOn.delete(account);
    noticesRefused.add(account);
  };
  return { api, issuer, state, noticeSetups, sends, calls, mediaCalls, refuseNotices, noticeState, noticeLanguages, languageChanges };
}

const bridge = (): Bridge => ({ transport: 'webview-proxy', post: () => {}, on: () => () => {} });

/** A Telegram bridge whose events a test plays with fire(). */
function telegram() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const tg = {
    transport: 'webview-proxy',
    post: () => {},
    on: (type: string, handler: (data: unknown) => void) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
      return () => handlers.get(type)!.delete(handler);
    },
  } as unknown as Bridge;
  return { bridge: tg, fire: (type: string, data: unknown) => handlers.get(type)?.forEach((h) => h(data)) };
}

function launchWith(startParam: string, allowsWrite = true, language?: string): Launch {
  const code = language === undefined ? '' : `,"language_code":"${language}"`;
  const initData = `auth_date=1&start_param=${startParam}&user=${encodeURIComponent(`{"id":1,"allows_write_to_pm":${allowsWrite}${code}}`)}`;
  return parseLaunch('tgWebAppData=' + encodeURIComponent(initData));
}

/** Sets up an account (two launches) and returns the app of the registration launch. */
async function person(
  b: Awaited<ReturnType<typeof backend>>,
  startParam = '',
  tg: Bridge = bridge(),
  chatDelete: { chatDeleteGapMs?: number; chatDeleteWindow?: { count: number; ms: number } } = {},
): Promise<ReturnType<typeof createApp> & { db: Awaited<ReturnType<typeof openDatabase>>; reopen: (startParam: string) => Promise<ReturnType<typeof createApp>>; broadcasts: SyncEvent[] }> {
  const db = await openDatabase(`conv-test-${n++}`);
  // What the apps on this device told the others.
  const broadcasts: SyncEvent[] = [];
  const deps = { config, api: b.api, db, bridge: tg, broadcast: (e: SyncEvent) => void broadcasts.push(e), closeDelayMs: 0, background: false, issuer: b.issuer, mediaIssuer: b.issuer, chatDeleteGapMs: 0, ...chatDelete };
  const first = createApp({ ...deps, launch: launchWith(startParam) });
  await first.start();
  await first.setUp();
  const code = 'reg' + (await readAccount(db))!.fingerprint;
  const app = createApp({ ...deps, launch: launchWith(code) });
  await app.start();
  const reopen = async (param: string) => {
    const next = createApp({ ...deps, launch: launchWith(param) });
    await next.start();
    return next;
  };
  return Object.assign(app, { db, reopen, broadcasts });
}

function screenOf<K extends Screen['kind']>(screen: Screen, kind: K): Extract<Screen, { kind: K }> {
  if (screen.kind !== kind) throw new Error(`expected ${kind}, got ${screen.kind}`);
  return screen as Extract<Screen, { kind: K }>;
}

/** Holds the next request to a path that matches, until the test fails it. */
function holdAndFail(b: Awaited<ReturnType<typeof backend>>, match: RegExp) {
  const request = b.api.request.bind(b.api);
  let reached: () => void = () => {};
  const atServer = new Promise<void>((r) => (reached = r));
  let fail: (err: Error) => void = () => {};
  b.api.request = (async (method, path, init, check) => {
    if (!match.test(path)) return request(method, path, init, check);
    b.api.request = request;
    reached();
    return new Promise<never>((_, reject) => (fail = reject));
  }) as Api['request'];
  return { atServer, fail: (err: Error) => fail(err) };
}

/** The chat a link screen offers to open (a link of someone we already write to). */
function existingChat(screen: Screen): string {
  const link = screenOf(screen, 'link');
  if (link.status !== 'existing') throw new Error(`expected existing, got ${link.status}`);
  return link.chat;
}

describe('conversations in the app', () => {
  it('shows a message as sending before it is delivered', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    // Hold the send until we've looked at the screen.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const post = b.api.post.bind(b.api);
    b.api.post = async (path, body, check) => {
      if (path === '/send') await held;
      return post(path, body, check);
    };
    const writing = sender.writeToLink('right away');
    await new Promise((r) => setTimeout(r, 300));
    expect(screenOf(sender.screen.value, 'conversation').messages.map((m) => [m.text, m.status])).toEqual([['right away', 'sending']]);
    release();
    await writing;
    expect(screenOf(sender.screen.value, 'conversation').messages.map((m) => m.status)).toEqual(['sent']);
  });

  it('lets someone write to a link, and the owner read and reply', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const url = screenOf(owner.screen.value, 'home').links[0]!.url;
    const payload = new URL(url).searchParams.get('startapp')!;

    // A new user opens the link, sets up, and lands on it, ready to write.
    const sender = await person(b, payload);
    expect(screenOf(sender.screen.value, 'link')).toMatchObject({ status: 'verified', canWrite: true });
    await sender.writeToLink('hello there');
    const conv = screenOf(sender.screen.value, 'conversation');
    expect(conv.messages.map((m) => [m.out, m.text, m.status])).toEqual([[true, 'hello there', 'sent']]);
    expect(conv.role).toBe('sender');

    // The owner's inbox fills the chat list.
    await owner.showTab('chats');
    await owner.sync();
    const home = screenOf(owner.screen.value, 'home');
    expect(home.conversations).toHaveLength(1);
    expect(home.conversations[0]).toMatchObject({ unread: 1, role: 'owner', last: { text: 'hello there', out: false } });

    await owner.openConversation(home.conversations[0]!.id);
    await owner.sendMessage('hi! who is this?');
    expect(screenOf(owner.screen.value, 'conversation').messages.map((m) => m.text)).toEqual(['hello there', 'hi! who is this?']);
    await owner.home();
    expect(screenOf(owner.screen.value, 'home').conversations[0]!.unread).toBe(0);

    // The sender's open conversation picks up the reply.
    await sender.sync();
    expect(screenOf(sender.screen.value, 'conversation').messages.map((m) => [m.out, m.text])).toEqual([
      [true, 'hello there'],
      [false, 'hi! who is this?'],
    ]);

    // Opening the link again offers that conversation instead of starting another.
    const reopened = await sender.reopen(payload);
    expect(screenOf(reopened.screen.value, 'link')).toMatchObject({ status: 'existing', chat: conv.id });
    expect(await listConversations(sender.db)).toHaveLength(1);
  });

  it('sets up notices from plain launches only, and keeps seen receipts quiet', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    // The owner's registration launch set up notices, once.
    expect(b.noticeSetups).toHaveLength(1);
    expect(new URLSearchParams(b.noticeSetups[0]).get('start_param')).toMatch(/^reg/);
    await owner.home();
    expect(b.noticeSetups).toHaveLength(1);

    // Someone who arrives through a link never sends that launch's data.
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    const before = b.noticeSetups.length;
    await sender.reopen(payload);
    for (const initData of b.noticeSetups) expect(new URLSearchParams(initData).get('start_param') ?? '').not.toContain(payload);
    expect(b.noticeSetups.length).toBe(before);

    // Messages notify; seen receipts don't.
    await sender.writeToLink('hello');
    await owner.showTab('chats');
    await owner.sync();
    await owner.openConversation(screenOf(owner.screen.value, 'home').conversations[0]!.id);
    // The receipt goes in the background.
    for (let i = 0; i < 100 && b.sends.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    expect(b.sends.map((s) => s.quiet === true)).toEqual([false, true]);
  });

  it("keeps notices in Telegram's language, from plain launches only, never the app's", async () => {
    const b = await backend();
    const db = await openDatabase(`conv-test-${n++}`);
    const deps = { config, api: b.api, db, bridge: bridge(), broadcast: () => {}, closeDelayMs: 0, background: false, issuer: b.issuer, mediaIssuer: b.issuer };
    await createApp({ ...deps, launch: launchWith('', true, 'en') }).setUp();
    const code = 'reg' + (await readAccount(db))!.fingerprint;
    await createApp({ ...deps, launch: launchWith(code, true, 'en') }).start();
    const record = await readAccount(db);
    if (!record || !('accountId' in record)) throw new Error('not set up');
    const id = record.accountId;
    expect(b.noticeSetups).toHaveLength(1);
    expect(b.noticeLanguages.get(id)).toBe('en');
    // Opens the app, and waits for what it sends in the background.
    const open = async (startParam: string, language?: string) => {
      const app = createApp({ ...deps, launch: launchWith(startParam, true, language) });
      await app.start();
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 10));
      return app;
    };

    // The same language, or none in the launch data (never read as English): nothing to tell.
    await open('', 'en-GB');
    await open('');
    expect(b.languageChanges).toHaveLength(0);
    // The language chosen in the app stays on this device.
    await putMeta(db, 'language', 'fa');
    await open('', 'en');
    expect(b.languageChanges).toHaveLength(0);

    // Telegram now in Persian: told once, with this launch's data.
    await open('', 'fa');
    expect(b.languageChanges).toHaveLength(1);
    expect(JSON.parse(new URLSearchParams(b.languageChanges[0]).get('user')!)).toMatchObject({ language_code: 'fa' });
    expect(b.noticeLanguages.get(id)).toBe('fa');
    await open('', 'fa-IR');
    // No language in the launch data is never read as English.
    await open('');
    expect(b.languageChanges).toHaveLength(1);
    expect(b.noticeLanguages.get(id)).toBe('fa');

    // Through an invitation or someone's link, the launch data would say whose: never sent.
    await open('invABCDEFGH', 'en');
    expect(b.languageChanges).toHaveLength(1);

    // A failure is left alone, and not tried again until the next launch.
    b.noticeState.languageRefused = new NetworkError('unreachable');
    const app = await open('', 'en');
    expect(b.languageChanges).toHaveLength(2);
    await app.home();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 10));
    expect(b.languageChanges).toHaveLength(2);
    expect(app.screen.value.kind).toBe('home');
    b.noticeState.languageRefused = null;
    await open('', 'en');
    expect(b.languageChanges).toHaveLength(3);
    expect(b.noticeLanguages.get(id)).toBe('en');

    // A server that doesn't say the language: nothing sent.
    b.noticeState.languageSaid = false;
    await open('', 'fa');
    expect(b.languageChanges).toHaveLength(3);
    b.noticeState.languageSaid = true;

    // Refused by Telegram (the bot blocked): off, so nothing to change, and no setup either.
    b.refuseNotices(id);
    await open('', 'fa');
    expect(b.languageChanges).toHaveLength(3);
    expect(b.noticeSetups).toHaveLength(1);
  });

  it('asks before setting up notices when the bot may not write yet', async () => {
    const b = await backend();
    const db = await openDatabase(`conv-test-${n++}`);
    const handlers: Record<string, (data: unknown) => void> = {};
    const posted: string[] = [];
    const tg: Bridge = {
      transport: 'webview-proxy',
      post: (type: string) => void posted.push(type),
      on: (type: string, handler: (data: never) => void) => {
        handlers[type] = handler as (data: unknown) => void;
        return () => {};
      },
    } as Bridge;
    const deps = { config, api: b.api, db, bridge: tg, broadcast: () => {}, closeDelayMs: 0, background: false, issuer: b.issuer, mediaIssuer: b.issuer };
    await createApp({ ...deps, launch: launchWith('', false) }).setUp();
    const code = 'reg' + (await readAccount(db))!.fingerprint;
    const app = createApp({ ...deps, launch: launchWith(code, false) });
    await app.start();
    // Registering asks Telegram; until it's allowed, nothing is sent and home offers it.
    expect(posted).toContain('web_app_request_write_access');
    expect(b.noticeSetups).toHaveLength(0);
    expect(screenOf(app.screen.value, 'home').askNotices).toBe(true);
    handlers.write_access_requested!({ status: 'allowed' });
    for (let i = 0; i < 20 && b.noticeSetups.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(b.noticeSetups).toHaveLength(1);
    expect(screenOf(app.screen.value, 'home').askNotices).toBe(false);
  });

  it("doesn't set notices up again by itself once Telegram refused one, only on the user's tap", async () => {
    const b = await backend();
    const db = await openDatabase(`conv-test-${n++}`);
    const handlers: Record<string, (data: unknown) => void> = {};
    const posted: string[] = [];
    const tg: Bridge = {
      transport: 'webview-proxy',
      post: (type: string) => void posted.push(type),
      on: (type: string, handler: (data: never) => void) => {
        handlers[type] = handler as (data: unknown) => void;
        return () => {};
      },
    } as Bridge;
    const deps = { config, api: b.api, db, bridge: tg, broadcast: () => {}, closeDelayMs: 0, background: false, issuer: b.issuer, mediaIssuer: b.issuer };
    // Set up, with the bot allowed to write: notices are set up by themselves, as at first.
    await createApp({ ...deps, launch: launchWith('') }).setUp();
    const code = 'reg' + (await readAccount(db))!.fingerprint;
    await createApp({ ...deps, launch: launchWith(code) }).start();
    expect(b.noticeSetups).toHaveLength(1);

    // The user blocks the bot, and the next notice is refused. Telegram's
    // launch data may still say the bot may write: a plain launch only offers.
    const record = await readAccount(db);
    if (!record || !('accountId' in record)) throw new Error('not set up');
    b.refuseNotices(record.accountId);
    const app = createApp({ ...deps, launch: launchWith('') });
    await app.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(b.noticeSetups).toHaveLength(1);
    expect(screenOf(app.screen.value, 'home')).toMatchObject({ askNotices: true, account: { notices: false, noticesRefused: true } });
    await app.home();
    await new Promise((r) => setTimeout(r, 30));
    expect(b.noticeSetups).toHaveLength(1);

    // The user taps Turn on notices: Telegram is asked, and once it allows, they're set up.
    const asked = posted.length;
    app.allowNotices();
    expect(posted.slice(asked)).toEqual(['web_app_request_write_access']);
    handlers.write_access_requested!({ status: 'allowed' });
    for (let i = 0; i < 20 && b.noticeSetups.length === 1; i++) await new Promise((r) => setTimeout(r, 10));
    expect(b.noticeSetups).toHaveLength(2);
    expect(screenOf(app.screen.value, 'home')).toMatchObject({ askNotices: false, account: { notices: true, noticesRefused: false } });
  });

  it('deletes a conversation from the list, and brings it back when they write again', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    await sender.writeToLink('hello');
    await owner.showTab('chats');
    await owner.sync();
    const id = screenOf(owner.screen.value, 'home').conversations[0]!.id;

    await owner.deleteConversation(id, false);
    const home = screenOf(owner.screen.value, 'home');
    expect(home.notice).toBe('deleted');
    expect(home.conversations).toEqual([]);

    // The sender still has theirs, and writing again brings it back with only the new message.
    await sender.sendMessage('anyone?');
    await owner.sync();
    const back = screenOf(owner.screen.value, 'home').conversations;
    expect(back.map((c) => [c.id, c.last?.text, c.unread])).toEqual([[id, 'anyone?', 1]]);
  });

  it('keeps a chat\'s label through a delete and their return, and in Blocked after a delete that also blocks', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    await sender.writeToLink('hello');
    await owner.showTab('chats');
    await owner.sync();
    const first = screenOf(owner.screen.value, 'home').conversations[0]!;
    expect(first.label).toMatch(/^\S+ [0-9A-Z]{4}$/u);

    // Deleted, then they write again: the same label.
    await owner.deleteConversation(first.id, false);
    await sender.sendMessage('anyone?');
    await owner.sync();
    expect(screenOf(owner.screen.value, 'home').conversations.map((c) => [c.id, c.label])).toEqual([[first.id, first.label]]);

    // Deleted and blocked: Blocked shows it by the same label.
    await owner.deleteConversation(first.id, true);
    await owner.blocked();
    expect(screenOf(owner.screen.value, 'blocked').conversations.map((c) => [c.id, c.label])).toEqual([[first.id, first.label]]);

    // Unblocked (it was deleted: in neither list), then they write again: the same label.
    await owner.unblock(first.id);
    await sender.sync();
    await sender.sendMessage('still there?');
    await owner.sync();
    await owner.home();
    expect(screenOf(owner.screen.value, 'home').conversations.map((c) => [c.id, c.label])).toEqual([[first.id, first.label]]);
  });

  it("renames a chat on this device only: shown in the list, the chat and Blocked; gone with a delete, kept by a delete that also blocks", async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    await sender.writeToLink('hello');
    await owner.showTab('chats');
    await owner.sync();
    const { id, label } = screenOf(owner.screen.value, 'home').conversations[0]!;
    await owner.openConversation(id);

    // Named: nothing goes to the server, and it's stored sealed, as message previews are.
    const before = b.calls.length;
    await owner.rename(id, { name: '  Alex\u202e  ', emoji: '🇨🇦' });
    expect(b.calls.length).toBe(before);
    const stored = await owner.db.get('conversations', id);
    expect(stored!.custom).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(stored!.custom)).not.toContain('Alex');
    expect(JSON.stringify(stored)).not.toContain('Alex');
    expect(screenOf(owner.screen.value, 'conversation')).toMatchObject({ label: '🇨🇦 Alex', original: label, custom: { name: 'Alex', emoji: '🇨🇦' } });
    await owner.home();
    expect(screenOf(owner.screen.value, 'home').conversations.map((c) => c.label)).toEqual(['🇨🇦 Alex']);

    // Only a picture; then back to the label.
    await owner.openConversation(id);
    await owner.rename(id, { emoji: '🌻' });
    expect(screenOf(owner.screen.value, 'conversation').label).toBe(`🌻 ${label.split(' ')[1]}`);
    await owner.rename(id, null);
    expect(screenOf(owner.screen.value, 'conversation')).toMatchObject({ label, custom: null });
    // A name that cleans to nothing, and a picture that isn't one emoji: the label.
    await owner.rename(id, { name: ' \n\u2066 ', emoji: 'xy' });
    expect(screenOf(owner.screen.value, 'conversation')).toMatchObject({ label, custom: null });

    // Deleted: the name goes with it; when they write again, the label.
    await owner.rename(id, { name: 'Alex' });
    await owner.deleteConversation(id, false);
    await sender.sendMessage('anyone?');
    await owner.sync();
    expect(screenOf(owner.screen.value, 'home').conversations.map((c) => c.label)).toEqual([label]);

    // Deleted and blocked: Blocked shows the name.
    await owner.openConversation(id);
    await owner.rename(id, { name: 'Alex' });
    await owner.deleteConversation(id, true);
    await owner.blocked();
    expect(screenOf(owner.screen.value, 'blocked').conversations.map((c) => c.label)).toEqual([`${label.split(' ')[0]} Alex`]);
    // Not renamed while blocked (no ⋯ menu then).
    await owner.openConversation(id);
    await owner.rename(id, { name: 'Other' });
    expect(screenOf(owner.screen.value, 'conversation').label).toBe(`${label.split(' ')[0]} Alex`);

    // Unblocked: it was deleted, so in neither list now; the name goes. They write again: the label.
    await owner.unblock(id);
    await sender.sync();
    await sender.sendMessage('still there?');
    await owner.sync();
    await owner.home();
    expect(screenOf(owner.screen.value, 'home').conversations.map((c) => c.label)).toEqual([label]);
  });

  describe("a chat's own name goes once the chat is in neither list, on every path", () => {
    const payloadOf = (p: Awaited<ReturnType<typeof person>>) => new URL(screenOf(p.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    async function pair() {
      const b = await backend();
      const owner = await person(b);
      await owner.createLink();
      const sender = await person(b, payloadOf(owner));
      await sender.writeToLink('hello');
      await owner.showTab('chats');
      await owner.sync();
      const { id, label } = screenOf(owner.screen.value, 'home').conversations[0]!;
      await owner.openConversation(id);
      return { b, owner, sender, id, label };
    }
    const named = async (app: Awaited<ReturnType<typeof person>>, id: string) => !!(await app.db.get('conversations', id))?.custom;

    it('when they delete it for both sides, and they write again: the label', async () => {
      const { owner, sender, id, label } = await pair();
      await owner.sendMessage('hi');
      await sender.sync();
      await owner.rename(id, { name: 'Alex' });
      await sender.home();
      const sid = screenOf(sender.screen.value, 'home').conversations[0]!.id;
      await sender.deleteConversation(sid, false, true);
      await owner.home();
      await owner.sync();
      expect(screenOf(owner.screen.value, 'home').conversations).toEqual([]);
      expect(await named(owner, id)).toBe(false);
      const again = await sender.reopen(payloadOf(owner));
      await again.openConversation(existingChat(again.screen.value));
      await again.sendMessage('again');
      await owner.sync();
      await owner.home();
      expect(screenOf(owner.screen.value, 'home').conversations.map((c) => c.label)).toEqual([label]);
    });

    it('offers no Rename on a chat out of the list (opened again from their link) until someone writes in it', async () => {
      const { owner, sender } = await pair();
      await owner.sendMessage('hi');
      await sender.sync();
      // The sender is in the chat they started.
      const sid = screenOf(sender.screen.value, 'conversation').id;
      await sender.deleteConversation(sid, false);
      await owner.home();
      const again = await sender.reopen(payloadOf(owner));
      await again.openConversation(existingChat(again.screen.value));
      expect(screenOf(again.screen.value, 'conversation')).toMatchObject({ id: sid, hidden: true });
      await again.rename(sid, { name: 'Bob' });
      expect(await named(sender, sid)).toBe(false);
      // Written in: back in the list, and named as asked.
      await again.sendMessage('again');
      expect(screenOf(again.screen.value, 'conversation').hidden).toBe(false);
      await again.rename(sid, { name: 'Bob' });
      expect(screenOf(again.screen.value, 'conversation').label).toMatch(/ Bob$/u);
    });

    it('shows a chat another copy blocked as blocked (no ⋯ menu, no Rename) once it is drawn again', async () => {
      const { owner, id } = await pair();
      const other = await owner.reopen('');
      await other.openConversation(id);
      await other.block();
      await owner.refresh();
      expect(screenOf(owner.screen.value, 'conversation')).toMatchObject({ id, blocked: true });
    });

    it('keeps the name when a delete fails before anything changed (still in the list)', async () => {
      const { b, owner, id } = await pair();
      await owner.sendMessage('hi');
      await owner.rename(id, { name: 'Alex' });
      const held = holdAndFail(b, /send/);
      const run = owner.deleteConversation(id, false, true);
      await held.atServer;
      held.fail(new NetworkError('offline'));
      await run;
      const stored = await owner.db.get('conversations', id);
      expect(stored!.hidden).toBeFalsy();
      expect(stored!.custom).toBeInstanceOf(Uint8Array);
    });

    it('when another copy deleted it, a rename from a copy still showing it stores nothing', async () => {
      const { owner, id } = await pair();
      const other = await owner.reopen('');
      await other.deleteConversation(id, false);
      await owner.sync();
      await owner.rename(id, { name: 'Alex' });
      expect(await named(owner, id)).toBe(false);
    });

    it('when a delete for both that also blocks stops after the delete went out: the name goes', async () => {
      const { b, owner, id } = await pair();
      await owner.sendMessage('hi');
      await owner.rename(id, { name: 'Alex' });
      const held = holdAndFail(b, /discard/);
      const run = owner.deleteConversation(id, true, true);
      await held.atServer;
      held.fail(new NetworkError('offline'));
      await run;
      const stored = await owner.db.get('conversations', id);
      expect(stored).toMatchObject({ hidden: true, status: 'active' });
      expect(stored!.custom).toBeUndefined();
    });

    it('and a delete for both that also blocks keeps it, for Blocked', async () => {
      const { owner, id, label } = await pair();
      await owner.sendMessage('hi');
      await owner.rename(id, { name: 'Alex' });
      await owner.deleteConversation(id, true, true);
      await owner.blocked();
      expect(screenOf(owner.screen.value, 'blocked').conversations.map((c) => c.label)).toEqual([`${label.split(' ')[0]} Alex`]);
    });

    it("when deleting the account deletes chats for both sides, stops, and the account is kept: the names go", async () => {
      const b = await backend();
      const a = await person(b);
      await a.createLink();
      const others: Awaited<ReturnType<typeof person>>[] = [];
      for (let i = 0; i < 2; i++) {
        const o = await person(b, payloadOf(a));
        await o.writeToLink(`hello ${i}`);
        others.push(o);
      }
      await a.showTab('chats');
      await a.sync();
      const list = screenOf(a.screen.value, 'home').conversations;
      const chats = others.map((_, i) => list.find((c) => c.last?.text === `hello ${i}`)!.id);
      for (const [i, chat] of chats.entries()) {
        await a.openConversation(chat);
        await a.sendMessage(`hi ${i}`);
        await a.rename(chat, { name: `Name${i}` });
        await others[i]!.sync();
      }
      await a.home();
      // Tokens for one chat's delete only: it stops after the first.
      const held = await countTokens(a.db, b.issuer.keyId);
      if (held > 1) await takeTokens(a.db, b.issuer.keyId, held - 1);
      b.state.tokensLeft = 0;
      a.askDeleteAccount();
      await a.deleteAccount(true);
      await a.keepAccount();
      const stored = await Promise.all(chats.map((id) => a.db.get('conversations', id)));
      // The chat deleted for both sides is in neither list: its name went. The other is as it was.
      const gone = stored.filter((c) => c!.hidden);
      const left = stored.filter((c) => !c!.hidden);
      expect(gone).toHaveLength(1);
      expect(gone[0]!.custom).toBeUndefined();
      expect(left).toHaveLength(1);
      expect(left[0]!.custom).toBeInstanceOf(Uint8Array);
    });
  });

  it('keeps the name of a chat blocked without a delete when it is unblocked', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    await sender.writeToLink('hello');
    await owner.showTab('chats');
    await owner.sync();
    const { id, label } = screenOf(owner.screen.value, 'home').conversations[0]!;
    await owner.openConversation(id);
    await owner.rename(id, { name: 'Alex' });
    await owner.block();
    await owner.blocked();
    expect(screenOf(owner.screen.value, 'blocked').conversations.map((c) => c.label)).toEqual([`${label.split(' ')[0]} Alex`]);
    await owner.unblock(id);
    await owner.home();
    expect(screenOf(owner.screen.value, 'home').conversations.map((c) => c.label)).toEqual([`${label.split(' ')[0]} Alex`]);
  });

  it('shows the delivery state of the last message in the list', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    await sender.writeToLink('hello');
    await sender.home();
    await sender.showTab('chats');
    expect(screenOf(sender.screen.value, 'home').conversations[0]!.last).toMatchObject({ out: true, status: 'sent' });
  });

  it('swaps the link for a new one; people who were answered carry on through it', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const oldUrl = screenOf(owner.screen.value, 'home').links[0]!.url;
    const oldPayload = new URL(oldUrl).searchParams.get('startapp')!;
    const sender = await person(b, oldPayload);
    await sender.writeToLink('hello');
    await owner.showTab('chats');
    await owner.sync();
    await owner.openConversation(screenOf(owner.screen.value, 'home').conversations[0]!.id);
    await owner.sendMessage('hi back');
    await sender.sync();

    await owner.home();
    await owner.showTab('links');
    await owner.replaceLink();
    const home = screenOf(owner.screen.value, 'home');
    expect(home.notice).toBe('replaced');
    expect(home.links).toHaveLength(1);
    const newPayload = new URL(home.links[0]!.url).searchParams.get('startapp')!;
    expect(newPayload).not.toBe(oldPayload);

    // The owner opening their old link sees it's theirs.
    expect(screenOf((await owner.reopen(oldPayload)).screen.value, 'link').status).toBe('own');
    // Someone opening the old link: gone.
    const stranger = await person(b, oldPayload);
    expect(screenOf(stranger.screen.value, 'link').status).toBe('not-found');
    // The sender, already answered, opens the new link: the same conversation.
    const conv = (await listConversations(sender.db))[0]!.id;
    expect(screenOf((await sender.reopen(newPayload)).screen.value, 'link')).toMatchObject({ status: 'existing', chat: conv });
  });

  it("updates the writer's open chat when the other side reads it", async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    await sender.writeToLink('hello');
    expect(screenOf(sender.screen.value, 'conversation').messages.map((m) => m.status)).toEqual(['sent']);
    await owner.showTab('chats');
    await owner.sync();
    await owner.openConversation(screenOf(owner.screen.value, 'home').conversations[0]!.id);
    // The receipt goes in the background; nothing else arrives with it.
    for (let i = 0; i < 100 && b.sends.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    await sender.sync();
    expect(screenOf(sender.screen.value, 'conversation').messages.map((m) => m.status)).toEqual(['seen']);
  });

  it('never opens a chat or sends "seen" because a link was opened, only on a tap', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    await sender.writeToLink('hello');
    const conv = screenOf(sender.screen.value, 'conversation').id;
    await sender.home();
    const quiet = () => b.sends.filter((s) => s.quiet === true).length;
    const settle = async (count: number) => {
      for (let i = 0; i < 100 && quiet() < count; i++) await new Promise((r) => setTimeout(r, 50));
    };
    // The owner answers while the sender is away (their "seen" for hello goes first)...
    await owner.showTab('chats');
    await owner.sync();
    await owner.openConversation(screenOf(owner.screen.value, 'home').conversations[0]!.id);
    await settle(1);
    await owner.sendMessage('is it you?');
    const before = quiet();
    const replies = async () => {
      await owner.sync();
      return screenOf(owner.screen.value, 'conversation').messages.filter((m) => m.out).map((m) => m.status);
    };

    // ...then sends a suspect their link. Opening it only says there's a chat already.
    const launched = await sender.reopen(payload);
    expect(screenOf(launched.screen.value, 'link')).toMatchObject({ status: 'existing', chat: conv });
    await new Promise((r) => setTimeout(r, 300));
    expect(quiet()).toBe(before);
    expect(await replies()).toEqual(['sent']);

    // A tap on Open opens it, and "seen" goes out as for any chat opened in the app.
    await launched.openConversation(existingChat(launched.screen.value));
    expect(screenOf(launched.screen.value, 'conversation').id).toBe(conv);
    await settle(before + 1);
    expect(await replies()).toEqual(['seen']);
  });

  it('after the app was minimised, sends "seen" only once it is touched again', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const tg = telegram();
    const sender = await person(b, payload, tg.bridge);
    await sender.writeToLink('hello');
    const quiet = () => b.sends.filter((s) => s.quiet === true).length;
    const settle = async (count: number) => {
      for (let i = 0; i < 100 && quiet() < count; i++) await new Promise((r) => setTimeout(r, 50));
    };
    await owner.showTab('chats');
    await owner.sync();
    await owner.openConversation(screenOf(owner.screen.value, 'home').conversations[0]!.id);
    await settle(1);

    // The sender's chat is open in a minimised app; the reply shows once it's back.
    tg.fire('visibility_changed', { is_visible: false });
    await owner.sendMessage('still there?');
    tg.fire('visibility_changed', { is_visible: true });
    await sender.sync();
    expect(screenOf(sender.screen.value, 'conversation').messages.map((m) => m.text)).toEqual(['hello', 'still there?']);
    // In view, but coming back may not have been their doing: nothing yet.
    sender.markSeen();
    await new Promise((r) => setTimeout(r, 300));
    expect(quiet()).toBe(1);

    // Their first touch marks it seen.
    expect(sender.attend()).toBe(true);
    expect(sender.attend()).toBe(false);
    sender.markSeen();
    await settle(2);
    await owner.sync();
    expect(screenOf(owner.screen.value, 'conversation').messages.filter((m) => m.out).map((m) => m.status)).toEqual(['seen']);
  });

  it("doesn't count a tap when the app was hidden before the chat finished opening", async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const tg = telegram();
    const sender = await person(b, payload, tg.bridge);
    await sender.writeToLink('hello');
    const conv = screenOf(sender.screen.value, 'conversation').id;
    await sender.home();
    const quiet = () => b.sends.filter((s) => s.quiet === true).length;
    const settle = async (count: number) => {
      for (let i = 0; i < 100 && quiet() < count; i++) await new Promise((r) => setTimeout(r, 50));
    };
    await owner.showTab('chats');
    await owner.sync();
    await owner.openConversation(screenOf(owner.screen.value, 'home').conversations[0]!.id);
    await settle(1);
    await owner.sendMessage('one');
    await sender.sync();

    // A tap opens the chat, and the app is hidden while it opens.
    const opening = sender.openConversation(conv);
    tg.fire('visibility_changed', { is_visible: false });
    await opening;
    tg.fire('visibility_changed', { is_visible: true });
    await owner.sendMessage('two');
    await sender.sync();
    expect(screenOf(sender.screen.value, 'conversation').messages.map((m) => m.text)).toEqual(['hello', 'one', 'two']);
    sender.markSeen();
    await new Promise((r) => setTimeout(r, 300));
    expect(quiet()).toBe(1);

    // Only a touch after it marks both seen.
    expect(sender.attend()).toBe(true);
    sender.markSeen();
    await settle(2);
    await owner.sync();
    expect(screenOf(owner.screen.value, 'conversation').messages.filter((m) => m.out).map((m) => m.status)).toEqual(['seen', 'seen']);
  });

  it("doesn't count an Unblock tap when the app was hidden while it was sent", async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const tg = telegram();
    const sender = await person(b, payload, tg.bridge);
    await sender.writeToLink('hello');
    const conv = screenOf(sender.screen.value, 'conversation').id;
    await sender.block();
    await sender.openConversation(conv);
    expect(screenOf(sender.screen.value, 'conversation').blocked).toBe(true);

    const unblocking = sender.unblock(conv);
    tg.fire('visibility_changed', { is_visible: false });
    await unblocking;
    tg.fire('visibility_changed', { is_visible: true });
    expect(screenOf(sender.screen.value, 'conversation')).toMatchObject({ id: conv, blocked: false });
    // Not in use until touched: "seen" waits.
    expect(sender.attend()).toBe(true);
  });

  it('checks the link on every launch, also of a chat that exists already', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const other = await person(b);
    await other.createLink();
    const otherPayload = new URL(screenOf(other.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    await sender.writeToLink('hello');
    const conv = screenOf(sender.screen.value, 'conversation').id;
    const fetched: string[] = [];
    let swap = false;
    const request = b.api.request.bind(b.api);
    b.api.request = ((method, path, init, check) => {
      if (method === 'GET' && path.startsWith('/links/')) {
        fetched.push(path);
        if (swap) path = `/links/${parsePayload(otherPayload)!.id}`;
      }
      return request(method, path, init, check);
    }) as Api['request'];
    const linkPath = `/links/${parsePayload(payload)!.id}`;

    // The server sees the same request as for a new link: from the writer...
    expect(existingChat((await sender.reopen(payload)).screen.value)).toBe(conv);
    expect(fetched).toEqual([linkPath]);
    // ...and from the link's owner.
    expect(screenOf((await owner.reopen(payload)).screen.value, 'link').status).toBe('own');
    expect(fetched).toEqual([linkPath, linkPath]);
    // Keys swapped by the server are caught here too.
    swap = true;
    expect(screenOf((await sender.reopen(payload)).screen.value, 'link').status).toBe('mismatch');
  });

  it('lists blocked conversations, opens them read-only, and unblocks from either place', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    await sender.writeToLink('hello');
    await owner.showTab('chats');
    await owner.sync();
    const id = screenOf(owner.screen.value, 'home').conversations[0]!.id;
    await owner.openConversation(id);
    await owner.sendMessage('hi');

    // Delete, ticking "also block": gone from the chats, counted under Blocked.
    await owner.deleteConversation(id, true);
    let home = screenOf(owner.screen.value, 'home');
    expect(home.conversations).toEqual([]);
    expect(home.blockedCount).toBe(1);
    await owner.blocked();
    const list = screenOf(owner.screen.value, 'blocked');
    expect(list.conversations.map((c) => [c.id, c.status])).toEqual([[id, 'blocked']]);

    // Opened from the list: read-only.
    await owner.openConversation(id);
    expect(screenOf(owner.screen.value, 'conversation')).toMatchObject({ id, blocked: true });
    // Unblocked from the conversation: it's an ordinary conversation again.
    await owner.unblock(id);
    expect(screenOf(owner.screen.value, 'conversation')).toMatchObject({ id, blocked: false });
    await sender.sync();
    await sender.sendMessage('back again');
    await owner.sync();
    expect(screenOf(owner.screen.value, 'conversation').messages.map((m) => m.text)).toEqual(['back again']);

    // Blocked again, then unblocked from the list.
    await owner.home();
    await owner.deleteConversation(id, true);
    await owner.blocked();
    await owner.unblock(id);
    const after = screenOf(owner.screen.value, 'blocked');
    expect(after.notice).toBe('unblocked');
    expect(after.conversations).toEqual([]);
    await owner.home();
    expect(screenOf(owner.screen.value, 'home').blockedCount).toBe(0);
  });

  it('opens a long chat at its newest messages, loads older ones on the way up, quotes ones not shown, and reads it all in one receipt', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    // Each in a millisecond of its own, so their order is theirs.
    const tick = () => new Promise((r) => setTimeout(r, 2));
    await sender.writeToLink('first question');
    for (let i = 0; i < 60; i++) {
      await tick();
      await sender.sendMessage(`m${i}`);
    }
    await owner.showTab('chats');
    await owner.sync();
    const home = screenOf(owner.screen.value, 'home');
    expect(home.conversations[0]).toMatchObject({ unread: 61, last: { text: 'm59', out: false } });
    const sends = b.sends.length;
    await owner.openConversation(home.conversations[0]!.id);
    let chat = screenOf(owner.screen.value, 'conversation');
    expect(chat.messages.map((m) => m.text)).toEqual(Array.from({ length: PAGE }, (_, i) => `m${i + 10}`));
    expect(chat.more).toBe(true);
    // All 61 read, in one receipt, in the background.
    for (let i = 0; i < 100 && b.sends.length < sends + 1; i++) await new Promise((r) => setTimeout(r, 50));
    expect(b.sends.slice(sends).map((s) => s.quiet)).toEqual([true]);
    await sender.sync();
    expect(screenOf(sender.screen.value, 'conversation').messages.filter((m) => m.status !== 'seen')).toEqual([]);

    // Answering the first question, which isn't shown: its quote is.
    const question = (await listMessages(owner.db, chat.id))[0]!;
    await tick();
    await owner.sendMessage('the answer', question.id);
    chat = screenOf(owner.screen.value, 'conversation');
    expect(chat.messages.at(-1)).toMatchObject({ text: 'the answer', replyTo: question.id });
    expect(chat.quoted.map((m) => m.text)).toEqual(['first question']);
    // The list shows it last, from its preview.
    await owner.home();
    expect(screenOf(owner.screen.value, 'home').conversations[0]!.last).toMatchObject({ text: 'the answer', out: true });

    // Scrolling up: PAGE more (here, the rest).
    await owner.openConversation(chat.id);
    expect(await owner.loadOlder()).toBe(true);
    chat = screenOf(owner.screen.value, 'conversation');
    expect([chat.messages[0]!.text, chat.messages.length, chat.more, chat.quoted]).toEqual(['first question', 62, false, []]);
    expect(await owner.loadOlder()).toBe(false);
    // Jumping to a quote not shown: all from it on.
    await owner.openConversation(chat.id);
    expect(screenOf(owner.screen.value, 'conversation').messages).toHaveLength(PAGE);
    expect(await owner.loadOlder(question.id)).toBe(true);
    expect(screenOf(owner.screen.value, 'conversation').messages[0]!.id).toBe(question.id);
    // New ones as they come are added, and what's shown stays.
    await tick();
    await sender.sendMessage('one more');
    await owner.sync();
    chat = screenOf(owner.screen.value, 'conversation');
    expect([chat.messages[0]!.id, chat.messages.at(-1)!.text]).toEqual([question.id, 'one more']);
  });

  it('keeps a failed message of ours shown through a flood, reading only what it shows', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    await sender.writeToLink('hello');
    await owner.showTab('chats');
    await owner.sync();
    await owner.openConversation(screenOf(owner.screen.value, 'home').conversations[0]!.id);
    // The receipt goes in the background: waited for, however slow.
    await vi.waitFor(() => expect(b.sends).toHaveLength(2), { timeout: 30_000, interval: 50 });
    // Ours fails: the server can't be reached.
    const post = b.api.post;
    b.api.post = async (path, body, check) => {
      if (path === '/send') throw new NetworkError('unreachable');
      return post(path, body, check);
    };
    await owner.sendMessage('mine');
    b.api.post = post;
    expect(screenOf(owner.screen.value, 'conversation').messages.map((m) => [m.text, m.status])).toEqual([
      ['hello', 'read'],
      ['mine', 'failed'],
    ]);
    // A flood comes in while it's open. The clock stands still from here, so
    // nothing depends on how fast it comes: the flood is dated ahead of the
    // clock, a second apart, and what follows it after it (engine.ts,
    // stampIn); the owner shows what's dated after the second it's taken in
    // in that second, in the order taken in (shownAt).
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    onTestFinished(() => clock.mockRestore());
    for (let i = 0; i < MAX_SHOWN + 10; i++) await sender.sendMessage(`flood ${i}`);
    await owner.sync();
    // Message texts opened while it's drawn again for one more (message IDs are what they're bound to).
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    const opened = () =>
      decrypt.mock.calls.filter(([algorithm]) => {
        const aad = (algorithm as AesGcmParams).additionalData;
        return aad !== undefined && /^[A-Za-z0-9_-]{22}$/.test(new TextDecoder().decode(aad as Uint8Array));
      }).length;
    for (let round = 0; round < 3; round++) {
      await sender.sendMessage(`one more ${round}`);
      // Only the owner's app counts (the sender's redraws its own chat).
      decrypt.mockClear();
      await owner.sync();
      const chat = screenOf(owner.screen.value, 'conversation');
      // The newest 200 as stored (records: nothing opened), and ours failed
      // first, however old: no more each time.
      const stored = (await listRecords(owner.db, chat.id)).filter((m) => !(m.out && m.status === 'failed'));
      expect(chat.messages.slice(1).map((m) => m.id)).toEqual(stored.slice(-MAX_SHOWN).map((m) => m.id));
      expect([chat.messages[0]!.text, chat.messages[0]!.status, chat.messages.at(-1)!.text, chat.more]).toEqual(['mine', 'failed', `one more ${round}`, true]);
      // What it shows, and the new one as it's taken in: not the flood behind them.
      expect(opened()).toBeLessThanOrEqual(MAX_SHOWN + 1 + 5);
    }
    decrypt.mockRestore();
  }, 60_000);

  it("shows why a send failed, though a redraw of the chat was waiting its turn when it did", async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    await sender.writeToLink('hello');
    // The next send is held at the server, then fails.
    const send = holdAndFail(b, /^\/send$/);
    const sending = sender.sendMessage('mine');
    await send.atServer;
    // A draw of the chat under way, slow to read, and a sync's redraw
    // waiting its turn after it.
    const drawing = holdPage();
    const synced = sender.refresh();
    await drawing.atRead;
    const waiting = sender.refresh();
    // The send fails meanwhile: what it shows joins the redraw waiting (it
    // tells the other copies, then redraws, at once).
    const told = sender.broadcasts.length;
    send.fail(new NetworkError('unreachable'));
    await vi.waitFor(() => expect(sender.broadcasts.length).toBeGreaterThan(told));
    drawing.release();
    await Promise.all([sending, synced, waiting]);
    const chat = screenOf(sender.screen.value, 'conversation');
    expect([chat.error, chat.messages.map((m) => [m.text, m.status])]).toEqual([
      'network',
      [
        ['hello', 'sent'],
        ['mine', 'failed'],
      ],
    ]);
  });

  it('sends replies that quote a message, and deletes one message on this device', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    await sender.writeToLink('first question');
    await owner.showTab('chats');
    await owner.sync();
    await owner.openConversation(screenOf(owner.screen.value, 'home').conversations[0]!.id);
    const question = screenOf(owner.screen.value, 'conversation').messages[0]!;

    await owner.sendMessage('the answer', question.id);
    await sender.sync();
    const theirs = screenOf(sender.screen.value, 'conversation').messages;
    expect(theirs.map((m) => [m.text, m.replyTo ?? null])).toEqual([
      ['first question', null],
      ['the answer', theirs[0]!.id],
    ]);
    // Same message ID on both sides, so the quote finds it.
    expect(theirs[0]!.id).toBe(question.id);

    await owner.deleteMessage(question.id);
    expect(screenOf(owner.screen.value, 'conversation').messages.map((m) => m.text)).toEqual(['the answer']);
    // The other side still has it.
    await sender.sync();
    expect(screenOf(sender.screen.value, 'conversation').messages).toHaveLength(2);
    // Delivered again (a server that kept it), it stays deleted here.
    await b.api.post('/send', b.sends[0]!, (v) => v);
    await owner.sync();
    expect(screenOf(owner.screen.value, 'conversation').messages.map((m) => m.text)).toEqual(['the answer']);
  });

  it('says when attachments are paused, keeps the message and its tokens, and offers to send it again', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    await sender.writeToLink('hello');
    b.state.uploadsPaused = true;
    const voice = { file: crypto.getRandomValues(new Uint8Array(3000)), type: 'audio/mp4', length: 2, waveform: new Uint8Array([1, 2, 3]) };
    await sender.sendVoice(voice);

    const conv = screenOf(sender.screen.value, 'conversation');
    expect(conv.error).toBe('media-paused');
    const failed = conv.messages.at(-1)!;
    expect(failed).toMatchObject({ status: 'failed', file: 'local', media: { t: 'voice' } });
    expect(canResend(failed, Date.now())).toBe(true);
    expect(sender.preparing.value).toEqual([]);
    // Asked once, and every media token fetched is still in the wallet.
    expect(b.mediaCalls).toEqual(['POST /media']);
    expect(await countTokens(sender.db, b.issuer.keyId, undefined, 'media')).toBe(b.state.mediaSigned);

    // Try again while still paused: the same notice, one more request, nothing lost.
    await sender.resend(failed.id);
    expect(screenOf(sender.screen.value, 'conversation')).toMatchObject({ error: 'media-paused' });
    expect((await listMessages(sender.db, conv.id)).at(-1)).toMatchObject({ id: failed.id, status: 'failed' });
    expect(b.mediaCalls).toEqual(['POST /media', 'POST /media']);
    expect(await countTokens(sender.db, b.issuer.keyId, undefined, 'media')).toBe(b.state.mediaSigned);
    // Text messages go on.
    await sender.sendMessage('still here');
    expect(screenOf(sender.screen.value, 'conversation')).toMatchObject({ error: null });
    expect(screenOf(sender.screen.value, 'conversation').messages.at(-1)).toMatchObject({ text: 'still here', status: 'sent' });
  });

  it('says when the firewall turns an upload away, keeps the message and its tokens, and offers to send it again', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    await sender.writeToLink('hello');
    b.state.uploadsTurnedAway = true;
    const voice = { file: crypto.getRandomValues(new Uint8Array(3000)), type: 'audio/mp4', length: 2, waveform: new Uint8Array([1, 2, 3]) };
    await sender.sendVoice(voice);

    // "Try again later": the block lasts minutes, not a minute.
    const conv = screenOf(sender.screen.value, 'conversation');
    expect(conv.error).toBe('turned-away');
    const failed = conv.messages.at(-1)!;
    expect(failed).toMatchObject({ status: 'failed', file: 'local', media: { t: 'voice' } });
    expect(canResend(failed, Date.now())).toBe(true);
    // Asked once, and the server never saw its tokens: all still in the wallet.
    expect(b.mediaCalls).toEqual(['POST /media']);
    expect(await countTokens(sender.db, b.issuer.keyId, undefined, 'media')).toBe(b.state.mediaSigned);

    // Again while still turned away: the same notice, nothing lost.
    await sender.resend(failed.id);
    expect(screenOf(sender.screen.value, 'conversation')).toMatchObject({ error: 'turned-away' });
    expect(b.mediaCalls).toEqual(['POST /media', 'POST /media']);
    expect(await countTokens(sender.db, b.issuer.keyId, undefined, 'media')).toBe(b.state.mediaSigned);

    // Refused by the server itself, which saw them: they're dropped.
    b.state.uploadsTurnedAway = false;
    const before = await countTokens(sender.db, b.issuer.keyId, undefined, 'media');
    await sender.resend(failed.id);
    expect(screenOf(sender.screen.value, 'conversation').error).not.toBe('turned-away');
    expect(await countTokens(sender.db, b.issuer.keyId, undefined, 'media')).toBeLessThan(before);
  });

  it("says when the day's tokens are used up", async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    b.state.tokensLeft = 0;
    await sender.writeToLink('hello');
    // The conversation opens at once; the message shows as not sent, and why.
    const conv = screenOf(sender.screen.value, 'conversation');
    expect(conv.error).toBe('no-tokens');
    expect(conv.messages.map((m) => [m.text, m.status])).toEqual([['hello', 'failed']]);
    const failed = conv.messages[0]!;
    expect(canResend(failed, Date.now())).toBe(true);

    // The next day: Send again sends it, with its ID, once.
    b.state.tokensLeft = Infinity;
    await sender.resend(failed.id);
    expect(screenOf(sender.screen.value, 'conversation')).toMatchObject({ error: null, messages: [{ id: failed.id, text: 'hello', status: 'sent' }] });
    await sender.resend(failed.id);
    await owner.showTab('chats');
    await owner.sync();
    await owner.openConversation(screenOf(owner.screen.value, 'home').conversations[0]!.id);
    expect(screenOf(owner.screen.value, 'conversation').messages.map((m) => [m.id, m.text])).toEqual([[failed.id, 'hello']]);
  });

  // A send that has to fetch tokens first, while the server refuses this
  // device's logins for a minute: as that request's own refusal, never as
  // the day's tokens used up.
  it('says to try again in a minute when the device is refused for now, not that the day is used up', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    b.state.tokensLeft = 0;
    b.state.tokensRefused = new ApiError(429, 'device_limit', undefined, undefined, 30);
    await sender.writeToLink('hello');
    const conv = screenOf(sender.screen.value, 'conversation');
    expect(conv.error).toBe('device-limit');
    expect(conv.messages.map((m) => [m.text, m.status])).toEqual([['hello', 'failed']]);
    expect(canResend(conv.messages[0]!, Date.now())).toBe(true);
  });

  it('says when a link takes no more first messages for now, and from when it does, apart from a busy mailbox', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    // The link's hourly cap, 29 minutes before the hour ends.
    b.state.sendRefused = new ApiError(429, 'link_busy', undefined, undefined, 29 * 60);
    const before = Date.now();
    await sender.writeToLink('hello');
    let conv = screenOf(sender.screen.value, 'conversation');
    expect(conv.messages.map((m) => [m.text, m.status])).toEqual([['hello', 'failed']]);
    expect(conv.error).toMatchObject({ kind: 'link-busy' });
    const { until } = conv.error as LimitError;
    expect(until).toBeGreaterThanOrEqual(before + 29 * 60_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 29 * 60_000);

    // The mailbox's own cap is still "too fast": a minute.
    b.state.sendRefused = new ApiError(429, 'rate_limited');
    await sender.sendMessage('again');
    conv = screenOf(sender.screen.value, 'conversation');
    expect(conv.error).toBe('rate-limited');
    // Without a Retry-After, until when isn't known (the message then says
    // when the hour ends).
    b.state.sendRefused = new ApiError(429, 'link_busy');
    await sender.sendMessage('and again');
    expect(screenOf(sender.screen.value, 'conversation').error).toEqual({ kind: 'link-busy', until: null });
  });

  it("doesn't take the user back to where an action failed once they've gone elsewhere", async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);

    // The first message: its chat opens, the user goes home, then it fails.
    // They stay home, not taken back to the link.
    const sending = holdAndFail(b, /^\/send$/);
    const writing = sender.writeToLink('hello');
    await sending.atServer;
    const conv = screenOf(sender.screen.value, 'conversation').id;
    await sender.home();
    sending.fail(new NetworkError('no answer'));
    await writing;
    expect(sender.screen.value.kind).toBe('home');

    // Blocking, the same: the user went home meanwhile.
    await sender.openConversation(conv);
    let discard = holdAndFail(b, /\/discard$/);
    const blocking = sender.block();
    await discard.atServer;
    await sender.home();
    discard.fail(new NetworkError('no answer'));
    await blocking;
    expect(sender.screen.value.kind).toBe('home');
    // Still in the chat when it fails: it says why there, no longer busy.
    await sender.openConversation(conv);
    discard = holdAndFail(b, /\/discard$/);
    const again = sender.block();
    await discard.atServer;
    discard.fail(new NetworkError('no answer'));
    await again;
    expect(screenOf(sender.screen.value, 'conversation')).toMatchObject({ id: conv, busy: false, error: 'network', blocked: false });

    // Unblocking from the Blocked list, the same.
    await sender.block();
    await sender.blocked();
    const telling = holdAndFail(b, /^\/send$/);
    const unblocking = sender.unblock(conv);
    await telling.atServer;
    await sender.home();
    telling.fail(new ApiError(400, 'bad_request'));
    await unblocking;
    expect(sender.screen.value.kind).toBe('home');
  });

  it('says when a reply would start more chats than an account may have', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    await sender.writeToLink('hello');
    await owner.showTab('chats');
    await owner.sync();
    await owner.openConversation(screenOf(owner.screen.value, 'home').conversations[0]!.id);
    b.state.mailboxesFull = true;
    await owner.sendMessage('hi');
    const conv = screenOf(owner.screen.value, 'conversation');
    expect(conv.error).toBe('mailbox-limit');
    expect(conv.messages.map((m) => [m.text, m.status])).toEqual([
      ['hello', 'read'],
      ['hi', 'failed'],
    ]);
  });

  it("says to reopen the app once the server no longer holds its build's issuer key", async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    b.state.keyRetired = true;
    await sender.writeToLink('hello');
    const conv = screenOf(sender.screen.value, 'conversation');
    expect(conv.error).toBe('outdated');
    expect(conv.messages.map((m) => [m.text, m.status])).toEqual([['hello', 'failed']]);
  });

  it('says so too when the tokens it holds are of the retired key, at once', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    await sender.writeToLink('hello');
    expect(screenOf(sender.screen.value, 'conversation').messages.at(-1)).toMatchObject({ text: 'hello', status: 'sent' });
    // Retired while the app is open: the server refuses its tokens as
    // those of a key it no longer holds, and nothing else is tried.
    b.state.keyRetired = true;
    let tries = 0;
    const post = b.api.post;
    b.api.post = async (path, body, check) => {
      if (path === '/send') tries++;
      return post(path, body, check);
    };
    await sender.sendMessage('again');
    const conv = screenOf(sender.screen.value, 'conversation');
    expect(conv.error).toBe('outdated');
    expect(conv.messages.at(-1)).toMatchObject({ text: 'again', status: 'failed' });
    expect(tries).toBe(1);
  });
});

describe('blocking from a chat', () => {
  it('blocks once: not again while blocking, nor a chat blocked already', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    await sender.writeToLink('hi');
    const conv = screenOf(sender.screen.value, 'conversation').id;
    const discards = () => b.calls.filter((c) => c.endsWith('/discard')).length;
    // What one block asks of the server, from someone else's chat blocked alone.
    const other = await person(b, payload);
    await other.writeToLink('hello');
    const start = discards();
    await other.block();
    const once = discards() - start;
    expect(once).toBeGreaterThan(0);
    // The first block held at the server: a second one meanwhile asks nothing.
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    let reached = () => {};
    const atServer = new Promise<void>((r) => (reached = r));
    const request = b.api.request.bind(b.api);
    b.api.request = (async (method, path, init, check) => {
      if (path.endsWith('/discard')) {
        reached();
        await held;
      }
      return request(method, path, init, check);
    }) as Api['request'];
    const before = discards();
    const blocking = sender.block();
    await atServer;
    // Asked again meanwhile: it returns at once (a second block would wait on the first's lock).
    const again = sender.block().then(() => 'returned');
    expect(await Promise.race([again, new Promise((r) => setTimeout(() => r('still waiting'), 500))])).toBe('returned');
    release();
    await blocking;
    expect(discards() - before).toBe(once);
    expect(screenOf(sender.screen.value, 'home').notice).toBe('blocked');
    // Opened again, blocked: blocking again asks nothing.
    await sender.openConversation(conv);
    expect(screenOf(sender.screen.value, 'conversation').blocked).toBe(true);
    await sender.block();
    expect(discards() - before).toBe(once);
    expect(sender.screen.value.kind).toBe('conversation');
    // Each real block waits out the fake server's missing route once (2 s): more than the default 5 s in all.
  }, 15_000);
});

describe('deleting the account', () => {
  /** An attachment on the device in a chat, sent or received, with its upload's ID. */
  async function attachment(db: Awaited<ReturnType<typeof openDatabase>>, conv: string, id: string, out: boolean) {
    await addMessage(
      db,
      { id, conv, at: Date.now() - 1000, out, status: out ? 'sent' : 'read', file: 'local' },
      { text: '', media: { t: 'photo', s: 1000, m: 'image/jpeg', w: 10, h: 10, id: `upload-${id}`, k: 'a2V5', d: 'c2VjcmV0' } },
    );
  }

  it('tells nobody: nothing is sent, the other side keeps the chat, and only the uploads received are deleted', async () => {
    const b = await backend();
    const owner = await person(b);
    await owner.createLink();
    const payload = new URL(screenOf(owner.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;
    const sender = await person(b, payload);
    await sender.writeToLink('hello');
    const chat = screenOf(sender.screen.value, 'conversation').id;
    await owner.showTab('chats');
    await owner.sync();
    const id = screenOf(owner.screen.value, 'home').conversations[0]!.id;
    await owner.openConversation(id);
    await owner.sendMessage('hi back');
    await sender.sync();
    await attachment(sender.db, chat, 'mine', true);
    await attachment(sender.db, chat, 'theirs', false);
    const record = await readAccount(sender.db);
    const account = record && 'accountId' in record ? record.accountId : null;

    const sent = b.sends.length;
    sender.askDeleteAccount();
    await sender.deleteAccount();
    expect(sender.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
    expect(b.state.deletedAccounts).toEqual([account]);
    // Nothing went to anyone, and the upload of what they sent was deleted,
    // not the one of what the user sent: that stays for them to fetch.
    expect(b.sends.length).toBe(sent);
    expect(b.state.deletedUploads).toEqual(['upload-theirs']);

    // The other side keeps the whole chat.
    await owner.sync();
    expect(screenOf(owner.screen.value, 'conversation').messages.map((m) => m.text)).toEqual(['hello', 'hi back']);
    await owner.home();
    expect(screenOf(owner.screen.value, 'home').conversations.map((c) => c.id)).toEqual([id]);
  });

  type Person = Awaited<ReturnType<typeof person>>;
  const payloadOf = (p: Person) => new URL(screenOf(p.screen.value, 'home').links[0]!.url).searchParams.get('startapp')!;

  /**
   * Someone (a) whose link n people wrote to, each answered: a's chat with
   * each, by what they wrote ("hello 0", ...), and theirs.
   */
  async function withChats(b: Awaited<ReturnType<typeof backend>>, n: number, chatDelete: Parameters<typeof person>[3] = {}, tg: Bridge = bridge()) {
    const a = await person(b, '', tg, chatDelete);
    await a.createLink();
    const payload = payloadOf(a);
    const others: Person[] = [];
    for (let i = 0; i < n; i++) {
      const o = await person(b, payload);
      await o.writeToLink(`hello ${i}`);
      others.push(o);
    }
    await a.showTab('chats');
    await a.sync();
    const list = screenOf(a.screen.value, 'home').conversations;
    const chats = others.map((_, i) => list.find((c) => c.last?.text === `hello ${i}`)!.id);
    for (const [i, chat] of chats.entries()) {
      await a.openConversation(chat);
      await a.sendMessage(`hi ${i}`);
      await others[i]!.sync();
    }
    await a.home();
    return { a, others, chats };
  }

  /** Whether p still has a chat in its list (one deleted for both sides leaves it). */
  async function hasChat(p: Person): Promise<boolean> {
    await p.sync();
    await p.home();
    await p.showTab('chats');
    return screenOf(p.screen.value, 'home').conversations.length > 0;
  }

  /** Leaves a's wallet one send token, and the server none to sign today. */
  async function oneTokenLeft(b: Awaited<ReturnType<typeof backend>>, a: Person) {
    const held = await countTokens(a.db, b.issuer.keyId);
    if (held > 1) await takeTokens(a.db, b.issuer.keyId, held - 1);
    expect(await countTokens(a.db, b.issuer.keyId)).toBe(1);
    b.state.tokensLeft = 0;
  }

  /** Holds the next send until released: sends the user starts meanwhile wait behind it. */
  function holdSend(b: Awaited<ReturnType<typeof backend>>) {
    const post = b.api.post.bind(b.api);
    let reached: () => void = () => {};
    const atServer = new Promise<void>((r) => (reached = r));
    let release: () => void = () => {};
    const released = new Promise<void>((r) => (release = r));
    let held: Record<string, unknown> | null = null;
    b.api.post = async (path, body, check) => {
      if (path === '/send' && !held) {
        held = body as Record<string, unknown>;
        reached();
        await released;
      }
      return post(path, body, check);
    };
    return { atServer, release, mailbox: () => held?.mailbox };
  }

  it('deletes each chat in the list for both sides first, quietly, when ticked; blocked ones and ones deleted here only stay', async () => {
    const b = await backend();
    // One chat the user started through someone's link, and three through theirs.
    const c = await person(b);
    await c.createLink();
    const a = await person(b, payloadOf(c));
    await a.writeToLink('hello c');
    await c.showTab('chats');
    await c.sync();
    await a.home();
    await a.createLink();
    const payload = payloadOf(a);
    const others: Person[] = [];
    for (const text of ['one', 'two', 'three']) {
      const o = await person(b, payload);
      await o.writeToLink(text);
      others.push(o);
    }
    const [one, two, three] = others as [Person, Person, Person];
    await a.showTab('chats');
    await a.sync();
    const chatOf = (text: string) => screenOf(a.screen.value, 'home').conversations.find((x) => x.last?.text === text)!.id;
    const [toOne, toTwo, toThree] = [chatOf('one'), chatOf('two'), chatOf('three')];
    await a.openConversation(toOne);
    await a.sendMessage('hi one');
    await attachment(a.db, toOne, 'mine', true);
    await attachment(a.db, toOne, 'theirs', false);
    await one.sync();
    // Deleted here only, and blocked (its messages kept): out of reach of a delete for both sides.
    await a.home();
    await a.deleteConversation(toTwo, false);
    const mailboxOf = async (chat: string) => (await getConversation(a.db, chat))!.sendTo;
    const threeAt = await mailboxOf(toThree);
    await a.openConversation(toThree);
    // Its "seen" first, which opening it sends in the background.
    for (let i = 0; i < 200 && !b.sends.some((x) => x.mailbox === threeAt); i++) await new Promise((r) => setTimeout(r, 10));
    await a.block();
    const toC = screenOf(a.screen.value, 'home').conversations.find((x) => x.last?.text === 'hello c')!.id;
    const reached = [await mailboxOf(toOne), await mailboxOf(toC)].sort();

    const sent = b.sends.length;
    a.askDeleteAccount();
    expect(a.screen.value).toEqual({ kind: 'confirm-delete', busy: false, error: null });
    await a.deleteAccount(true);
    expect(a.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
    // One delete each, for c's chat and one's, without a notice, all before
    // the deletion; the upload of the user's photo went too.
    const deletes = b.sends.slice(sent);
    expect(deletes.map((d) => d.mailbox).sort()).toEqual(reached);
    expect(deletes.every((d) => d.quiet === true)).toBe(true);
    expect(b.calls.lastIndexOf('POST /send')).toBeLessThan(b.calls.indexOf('DELETE /account'));
    expect(b.state.deletedUploads.sort()).toEqual(['upload-mine', 'upload-theirs']);
    expect(b.calls.lastIndexOf('POST /media/delete')).toBeLessThan(b.calls.indexOf('DELETE /account'));
    // Gone on their side; kept where it couldn't be told.
    expect(await hasChat(c)).toBe(false);
    expect(await hasChat(one)).toBe(false);
    expect(await hasChat(two)).toBe(true);
    expect(await hasChat(three)).toBe(true);
  });

  it("asks when the day's messages run out partway: keeping the account leaves it, and the chats not reached, as they were", async () => {
    const b = await backend();
    const { a, others } = await withChats(b, 2);
    await oneTokenLeft(b, a);
    const sent = b.sends.length;
    a.askDeleteAccount();
    await a.deleteAccount(true);
    expect(a.screen.value).toEqual({ kind: 'deleting-chats', done: 1, total: 2, stopped: { reason: 'no-tokens', left: 1 } });
    expect(b.sends.length - sent).toBe(1);
    // Nothing to try again until the messages reset.
    expect(canRetryChats('no-tokens')).toBe(false);
    const asked = b.calls.length;
    await a.retryDeletingChats();
    expect(b.calls.length).toBe(asked);
    expect(b.sends.length - sent).toBe(1);
    expect(a.screen.value).toMatchObject({ kind: 'deleting-chats', stopped: { reason: 'no-tokens' } });
    // Nothing of the deletion was recorded or asked for.
    expect(await getMeta(a.db, 'deleting')).toBeUndefined();
    expect(b.calls).not.toContain('DELETE /account');

    await a.keepAccount();
    expect(screenOf(a.screen.value, 'home').tab).toBe('settings');
    await a.showTab('chats');
    expect(screenOf(a.screen.value, 'home').conversations).toHaveLength(1);
    expect((await Promise.all(others.map(hasChat))).sort()).toEqual([false, true]);
  });

  it('deletes the account anyway when asked, leaving the chats it did not reach with the other side', async () => {
    const b = await backend();
    const { a, others } = await withChats(b, 2);
    await oneTokenLeft(b, a);
    a.askDeleteAccount();
    await a.deleteAccount(true);
    expect(a.screen.value).toMatchObject({ kind: 'deleting-chats', stopped: { reason: 'no-tokens', left: 1 } });
    await a.deleteAccountAnyway();
    expect(a.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
    expect(b.state.deletedAccounts).toHaveLength(1);
    expect((await Promise.all(others.map(hasChat))).sort()).toEqual([false, true]);
  });

  it("stops when the server can't be reached, and Try again carries on with the chats still in the list", async () => {
    const b = await backend();
    const { a, others } = await withChats(b, 2);
    b.state.sendRefused = new NetworkError('offline') as unknown as ApiError;
    a.askDeleteAccount();
    await a.deleteAccount(true);
    expect(a.screen.value).toEqual({ kind: 'deleting-chats', done: 0, total: 2, stopped: { reason: 'network', left: 2 } });
    expect(b.calls).not.toContain('DELETE /account');
    b.state.sendRefused = null;
    await a.retryDeletingChats();
    expect(a.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
    expect(await hasChat(others[0]!)).toBe(false);
    expect(await hasChat(others[1]!)).toBe(false);
  });

  it('stops at Cancel, after the chat being sent, keeping the account', async () => {
    const b = await backend();
    const { a, others } = await withChats(b, 2);
    const sent = b.sends.length;
    const hold = holdSend(b);
    a.askDeleteAccount();
    const deleting = a.deleteAccount(true);
    await hold.atServer;
    expect(a.screen.value).toEqual({ kind: 'deleting-chats', done: 0, total: 2, stopped: null });
    await a.keepAccount();
    hold.release();
    await deleting;
    expect(screenOf(a.screen.value, 'home').tab).toBe('settings');
    expect(b.sends.length - sent).toBe(1);
    expect(await getMeta(a.db, 'deleting')).toBeUndefined();
    expect(b.calls).not.toContain('DELETE /account');
    await a.showTab('chats');
    expect(screenOf(a.screen.value, 'home').conversations).toHaveLength(1);
    expect((await Promise.all(others.map(hasChat))).sort()).toEqual([false, true]);
  });

  it('leaves an ordinary app, account kept, when the app closes partway', async () => {
    const b = await backend();
    const { a } = await withChats(b, 2);
    holdSend(b);
    a.askDeleteAccount();
    void a.deleteAccount(true);
    await new Promise((r) => setTimeout(r, 50));
    // Opened again (the held send never ends).
    const again = await a.reopen('');
    expect(again.screen.value.kind).toBe('home');
    expect(await getMeta(a.db, 'deleting')).toBeUndefined();
    expect(b.calls).not.toContain('DELETE /account');
  });

  for (const meanwhile of ['blocked', 'deleted here only'] as const) {
    it(`skips a chat ${meanwhile} meanwhile (in another copy), and goes on`, async () => {
      const b = await backend();
      const { a, others, chats } = await withChats(b, 2);
      const sent = b.sends.length;
      const hold = holdSend(b);
      a.askDeleteAccount();
      const deleting = a.deleteAccount(true);
      await hold.atServer;
      // The one not being sent, changed in another copy of the app.
      const sending = await Promise.all(chats.map(async (chat) => (await getConversation(a.db, chat))!.sendTo === hold.mailbox()));
      const other = chats[sending.indexOf(false)]!;
      const copy = await a.reopen('');
      if (meanwhile === 'blocked') {
        await copy.openConversation(other);
        await copy.block();
      } else await copy.deleteConversation(other, false);
      hold.release();
      await deleting;
      expect(a.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
      expect(b.sends.length - sent).toBe(1);
      expect(await hasChat(others[sending.indexOf(true)]!)).toBe(false);
      expect(await hasChat(others[sending.indexOf(false)]!)).toBe(true);
    });
  }

  it('paces the deletes for both sides', async () => {
    const b = await backend();
    const { a } = await withChats(b, 3, { chatDeleteGapMs: 150 });
    const times: number[] = [];
    const post = b.api.post.bind(b.api);
    b.api.post = async (path, body, check) => {
      if (path === '/send') times.push(Date.now());
      return post(path, body, check);
    };
    a.askDeleteAccount();
    await a.deleteAccount(true);
    expect(a.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
    expect(times).toHaveLength(3);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(145);
  });

  it('stops, with no Try again, when the app is out of date', async () => {
    const b = await backend();
    const { a } = await withChats(b, 1);
    b.state.keyRetired = true;
    a.askDeleteAccount();
    await a.deleteAccount(true);
    expect(a.screen.value).toEqual({ kind: 'deleting-chats', done: 0, total: 1, stopped: { reason: 'outdated', left: 1 } });
    expect(canRetryChats('outdated')).toBe(false);
  });

  it('shows that the account was replaced, deleting nothing, when the server says so partway', async () => {
    const b = await backend();
    const { a } = await withChats(b, 1);
    const held = await countTokens(a.db, b.issuer.keyId);
    await takeTokens(a.db, b.issuer.keyId, held);
    b.state.tokensRefused = new ApiError(410, 'account_replaced');
    a.askDeleteAccount();
    await a.deleteAccount(true);
    expect(a.screen.value).toMatchObject({ kind: 'signed-out', reason: 'replaced' });
    expect(b.calls).not.toContain('DELETE /account');
    expect(await getMeta(a.db, 'deleting')).toBeUndefined();
  });

  it('keeps no more than so many deletes in a window', async () => {
    const b = await backend();
    const { a } = await withChats(b, 3, { chatDeleteWindow: { count: 2, ms: 400 } });
    const times: number[] = [];
    const post = b.api.post.bind(b.api);
    b.api.post = async (path, body, check) => {
      if (path === '/send') times.push(Date.now());
      return post(path, body, check);
    };
    a.askDeleteAccount();
    await a.deleteAccount(true);
    expect(a.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
    expect(times).toHaveLength(3);
    expect(times[2]! - times[0]!).toBeGreaterThanOrEqual(395);
  });

  it("doesn't delete the account when back is pressed during the last chat's send", async () => {
    const b = await backend();
    const tg = telegram();
    const { a } = await withChats(b, 1, {}, tg.bridge);
    const hold = holdSend(b);
    a.askDeleteAccount();
    const deleting = a.deleteAccount(true);
    await hold.atServer;
    // Home's own requests take a while to answer.
    const request = b.api.request.bind(b.api);
    b.api.request = async (method, path, init, check) => {
      if (method === 'GET' && (path === '/account' || path === '/invitations')) await new Promise((r) => setTimeout(r, 300));
      return request(method, path, init, check);
    };
    tg.fire('back_button_pressed', {});
    hold.release();
    await deleting;
    await new Promise((r) => setTimeout(r, 600));
    expect(b.state.deletedAccounts).toEqual([]);
    expect(await getMeta(a.db, 'deleting')).toBeUndefined();
    expect(screenOf(a.screen.value, 'home').tab).toBe('settings');
  });

  it('goes on to the deletion in the same turn as the last chat, so a Cancel a moment later finds nothing to cancel', async () => {
    const b = await backend();
    const { a } = await withChats(b, 1);
    let armed = true;
    // What the screen showed when the tap came.
    let shown: string | null = null;
    const push = a.broadcasts.push.bind(a.broadcasts);
    a.broadcasts.push = (...e: SyncEvent[]) => {
      if (armed && e[0]?.type === 'data-changed' && a.screen.value.kind === 'deleting-chats') {
        armed = false;
        // A moment later.
        (globalThis as unknown as { setImmediate: (fn: () => void) => void }).setImmediate(() => {
          shown = a.screen.value.kind;
          void a.keepAccount();
        });
      }
      return push(...e);
    };
    a.askDeleteAccount();
    await a.deleteAccount(true);
    await new Promise((r) => setTimeout(r, 300));
    // Not the chats' screen, whose Cancel would have kept an account then deleted.
    expect(shown).toBe('deleting');
    expect(a.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
  });

  it('ignores a tap on Delete anyway once Keep was tapped, while home loads', async () => {
    const b = await backend();
    const { a } = await withChats(b, 2);
    await oneTokenLeft(b, a);
    a.askDeleteAccount();
    await a.deleteAccount(true);
    expect(a.screen.value).toMatchObject({ kind: 'deleting-chats', stopped: { reason: 'no-tokens' } });
    const keeping = a.keepAccount();
    await a.deleteAccountAnyway();
    await keeping;
    expect(b.state.deletedAccounts).toEqual([]);
    expect(await getMeta(a.db, 'deleting')).toBeUndefined();
    expect(screenOf(a.screen.value, 'home').tab).toBe('settings');
  });

  for (const code of ['rate_limited'] as const) {
    it(`offers Try again when turned away (${code}), which carries on`, async () => {
      const b = await backend();
      const { a, others } = await withChats(b, 1);
      b.state.sendRefused = new ApiError(429, code);
      a.askDeleteAccount();
      await a.deleteAccount(true);
      expect(a.screen.value).toEqual({ kind: 'deleting-chats', done: 0, total: 1, stopped: { reason: 'turned-away', left: 1 } });
      expect(canRetryChats('turned-away')).toBe(true);
      b.state.sendRefused = null;
      await a.retryDeletingChats();
      expect(a.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
      expect(await hasChat(others[0]!)).toBe(false);
    });
  }

  it('skips an ended chat (from older versions)', async () => {
    const b = await backend();
    const { a, others, chats } = await withChats(b, 2);
    await putConversation(a.db, { ...(await getConversation(a.db, chats[0]!))!, status: 'ended' });
    const sent = b.sends.length;
    a.askDeleteAccount();
    await a.deleteAccount(true);
    expect(a.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
    expect(b.sends.length - sent).toBe(1);
    expect(await hasChat(others[0]!)).toBe(true);
    expect(await hasChat(others[1]!)).toBe(false);
  });

  it('keeps the pace across Try again', async () => {
    const b = await backend();
    const { a } = await withChats(b, 2, { chatDeleteWindow: { count: 2, ms: 600 } });
    const times: number[] = [];
    const post = b.api.post.bind(b.api);
    b.api.post = async (path, body, check) => {
      if (path !== '/send') return post(path, body, check);
      times.push(Date.now());
      // The second goes nowhere.
      if (times.length === 2) throw new NetworkError('offline');
      return post(path, body, check);
    };
    a.askDeleteAccount();
    await a.deleteAccount(true);
    expect(a.screen.value).toMatchObject({ kind: 'deleting-chats', stopped: { reason: 'network', left: 1 } });
    await a.retryDeletingChats();
    expect(a.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
    expect(times).toHaveLength(3);
    expect(times[2]! - times[0]!).toBeGreaterThanOrEqual(595);
  });

  it('looks at a chat again after waiting its turn: one deleted here meanwhile is left', async () => {
    const b = await backend();
    const { a, others, chats } = await withChats(b, 2, { chatDeleteWindow: { count: 1, ms: 500 } });
    const copy = await a.reopen('');
    const sent = b.sends.length;
    const hold = holdSend(b);
    a.askDeleteAccount();
    const deleting = a.deleteAccount(true);
    await hold.atServer;
    const sending = await Promise.all(chats.map(async (chat) => (await getConversation(a.db, chat))!.sendTo === hold.mailbox()));
    const other = chats[sending.indexOf(false)]!;
    hold.release();
    // While the second one waits its turn (half a second), another copy deletes it here.
    await new Promise((r) => setTimeout(r, 100));
    expect(a.screen.value).toMatchObject({ kind: 'deleting-chats', done: 1 });
    await copy.deleteConversation(other, false);
    await deleting;
    expect(a.screen.value).toMatchObject({ kind: 'welcome', deleted: true });
    expect(b.sends.length - sent).toBe(1);
    expect(await hasChat(others[sending.indexOf(false)]!)).toBe(true);
  });

  it('leaves a chat whose link is busy for later, goes on with the others, then asks', async () => {
    const b = await backend();
    const { a, others, chats } = await withChats(b, 2);
    const busyAt = (await getConversation(a.db, chats[0]!))!.sendTo;
    const post = b.api.post.bind(b.api);
    b.api.post = async (path, body, check) => {
      if (path === '/send' && (body as { mailbox?: string }).mailbox === busyAt) throw new ApiError(429, 'link_busy', undefined, undefined, 1200);
      return post(path, body, check);
    };
    const asked = Date.now();
    a.askDeleteAccount();
    await a.deleteAccount(true);
    const screen = screenOf(a.screen.value, 'deleting-chats');
    expect(screen).toMatchObject({ done: 2, total: 2, stopped: { reason: 'link-busy', left: 1 } });
    // Until when, as the server said (Retry-After): no Try again before, which would spend its tokens again.
    expect(screen.stopped!.until! - asked).toBeGreaterThanOrEqual(1200_000);
    expect(canRetryChats('link-busy')).toBe(false);
    expect(b.calls).not.toContain('DELETE /account');
    expect(await hasChat(others[0]!)).toBe(true);
    expect(await hasChat(others[1]!)).toBe(false);
  });

  describe('deleting chats selected in the list', () => {
    const labels = (p: Person) => screenOf(p.screen.value, 'home').conversations.map((c) => c.id);

    it('deletes several here, nothing sent; blocking them keeps them in Blocked with the names given', async () => {
      const b = await backend();
      const { a, others, chats } = await withChats(b, 3);
      const [x, y, z] = chats as [string, string, string];
      await a.rename(x, { name: 'Alex' });
      expect(screenOf(a.screen.value, 'home').conversations.find((c) => c.id === x)).toMatchObject({ label: expect.stringMatching(/ Alex$/u), custom: { name: 'Alex' } });
      const sent = b.sends.length;
      await a.deleteChats([y, z], false, false);
      expect(screenOf(a.screen.value, 'home')).toMatchObject({ tab: 'chats', notice: 'deleted-many', busy: false });
      expect(labels(a)).toEqual([x]);
      expect(b.sends.length).toBe(sent);
      expect(await hasChat(others[1]!)).toBe(true);
      // Blocked too: in Blocked, the name given kept.
      await a.home();
      await a.showTab('chats');
      await a.deleteChats([x], true, false);
      await a.blocked();
      expect(screenOf(a.screen.value, 'blocked').conversations.map((c) => [c.id, c.label.endsWith(' Alex')])).toEqual([[x, true]]);
    });

    it('deletes several for both sides, paced, then shows the list; blocking them too keeps the names', async () => {
      const b = await backend();
      const { a, others, chats } = await withChats(b, 3);
      const [x, y, z] = chats as [string, string, string];
      await a.rename(y, { name: 'Bob' });
      const sent = b.sends.length;
      await a.deleteChats([x, y], true, true);
      expect(screenOf(a.screen.value, 'home')).toMatchObject({ tab: 'chats', notice: 'blocked' });
      expect(labels(a)).toEqual([z]);
      // One delete each, quietly.
      const deletes = b.sends.slice(sent).filter((d) => d.quiet === true);
      expect(deletes).toHaveLength(2);
      expect(await hasChat(others[0]!)).toBe(false);
      expect(await hasChat(others[1]!)).toBe(false);
      expect(await hasChat(others[2]!)).toBe(true);
      await a.home();
      await a.blocked();
      expect(screenOf(a.screen.value, 'blocked').conversations.map((c) => c.id).sort()).toEqual([x, y].sort());
      expect(screenOf(a.screen.value, 'blocked').conversations.find((c) => c.id === y)!.label).toMatch(/ Bob$/u);
    });

    it("stops when the day's messages run out: Try again does nothing until they reset; Stop leaves the rest with the other side", async () => {
      const b = await backend();
      const { a, others, chats } = await withChats(b, 3);
      await oneTokenLeft(b, a);
      await a.deleteChats(chats, false, true);
      expect(a.screen.value).toEqual({ kind: 'deleting-selected', done: 1, total: 3, stopped: { reason: 'no-tokens', left: 2 } });
      const asked = b.calls.length;
      await a.retryDeletingSelected();
      expect(b.calls.length).toBe(asked);
      // Nothing of the account's deletion: its own flow is untouched.
      expect(b.calls).not.toContain('DELETE /account');
      await a.stopDeletingSelected();
      expect(screenOf(a.screen.value, 'home').tab).toBe('chats');
      expect(labels(a)).toHaveLength(2);
      expect((await Promise.all(others.map(hasChat))).filter(Boolean)).toHaveLength(2);
    });

    it('carries on with the ones left on Try again, after a network failure', async () => {
      const b = await backend();
      const { a, others, chats } = await withChats(b, 2);
      const held = holdAndFail(b, /send/);
      const run = a.deleteChats(chats, false, true);
      await held.atServer;
      held.fail(new NetworkError('offline'));
      await run;
      expect(a.screen.value).toMatchObject({ kind: 'deleting-selected', done: 0, total: 2, stopped: { reason: 'network', left: 2 } });
      await a.retryDeletingSelected();
      expect(screenOf(a.screen.value, 'home')).toMatchObject({ tab: 'chats', notice: 'deleted-many-both' });
      expect(labels(a)).toEqual([]);
      expect(await hasChat(others[0]!)).toBe(false);
      expect(await hasChat(others[1]!)).toBe(false);
    });

    it('stops at Back while it runs, the rest kept', async () => {
      const b = await backend();
      const tg = telegram();
      const { a, chats } = await withChats(b, 2, {}, tg.bridge);
      const held = holdAndFail(b, /send/);
      const run = a.deleteChats(chats, false, true);
      await held.atServer;
      tg.fire('back_button_pressed', undefined);
      await vi.waitFor(() => expect(a.screen.value.kind).toBe('home'));
      held.fail(new NetworkError('offline'));
      await run;
      expect(screenOf(a.screen.value, 'home').tab).toBe('chats');
      // The first one's delete didn't go out (it failed); nothing after it was tried.
      expect(labels(a)).toHaveLength(2);
    });

    it('stops at once at Back, not once home has loaded (which waits for the server): no delete goes out after it', async () => {
      const b = await backend();
      const tg = telegram();
      const { a, chats } = await withChats(b, 3, {}, tg.bridge);
      const sent = b.sends.length;
      // Home's own read of the account waits, as on a slow network.
      const home = holdAndFail(b, /^\/account$/);
      const run = a.deleteChats(chats, false, true);
      expect(a.screen.value.kind).toBe('deleting-selected');
      tg.fire('back_button_pressed', undefined);
      await run;
      expect(b.sends.slice(sent).filter((d) => d.quiet === true)).toHaveLength(0);
      await home.atServer;
      home.fail(new NetworkError('offline'));
      await vi.waitFor(() => expect(a.screen.value.kind).toBe('home'));
      expect(labels(a)).toHaveLength(3);
    });

    it('deletes one selected chat as its own Delete does, for both sides too', async () => {
      const b = await backend();
      const { a, others, chats } = await withChats(b, 2);
      await a.deleteChats([chats[0]!], false, true);
      expect(screenOf(a.screen.value, 'home')).toMatchObject({ notice: 'deleted' });
      expect(labels(a)).toEqual([chats[1]]);
      expect(await hasChat(others[0]!)).toBe(false);
    });
  });
});
