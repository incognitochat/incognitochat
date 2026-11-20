import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { readAccount } from '../account/account';
import type { TokenIssuer } from '../account/wallet';
import { i2osp, modPow, os2ip, type IssuerKey } from '../crypto/blindrsa';
import { fromBase64Url, toBase64Url } from '../crypto/encoding';
import { ApiError, NetworkError, type Api } from '../net/api';
import { parseLaunch, type Launch } from '../platform/launch';
import type { Bridge } from '../platform/telegram';
import { canResend } from '../messaging/engine';
import { listConversations, listMessages, PAGE } from '../messaging/store';
import { countTokens } from '../account/wallet';
import { parsePayload } from '../protocol/link';
import { openDatabase } from '../storage/db';
import { createApp, MAX_SHOWN, type LimitError, type Screen } from './app';

let n = 0;
const rand = () => toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
const config = {
  apiUrl: 'https://api.example',
  botUsername: 'test_bot',
  appName: 'dev',
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
  const state = { tokensLeft: Infinity, uploadsPaused: false, mediaSigned: 0, keyRetired: false, mailboxesFull: false, sendRefused: null as ApiError | null };
  /** Requests to the media routes. */
  const mediaCalls: string[] = [];
  // What the app sent to /notices and /send, to check what it tells the server.
  const noticeSetups: string[] = [];
  const sends: Record<string, unknown>[] = [];
  const noticesOn = new Set<string>();

  const api: Api = {
    post: (path, body, check) => api.request('POST', path, { body: JSON.stringify(body) }, check),
    async request(method, path, init, check) {
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
      if (path === '/account') return check({ canCreateLinks: true, admin: false, links: 0, maxLinks: 5, notices: noticesOn.has(account) });
      if (path === '/notices') {
        noticeSetups.push(body.initData as string);
        noticesOn.add(account);
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
        if (state.uploadsPaused && method === 'POST' && path === '/media') throw new ApiError(503, 'uploads_paused');
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
  return { api, issuer, state, noticeSetups, sends, mediaCalls };
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

function launchWith(startParam: string, allowsWrite = true): Launch {
  const initData = `auth_date=1&start_param=${startParam}&user=${encodeURIComponent(`{"id":1,"allows_write_to_pm":${allowsWrite}}`)}`;
  return parseLaunch('tgWebAppData=' + encodeURIComponent(initData));
}

/** Sets up an account (two launches) and returns the app of the registration launch. */
async function person(b: Awaited<ReturnType<typeof backend>>, startParam = '', tg: Bridge = bridge()): Promise<ReturnType<typeof createApp> & { db: Awaited<ReturnType<typeof openDatabase>>; reopen: (startParam: string) => Promise<ReturnType<typeof createApp>> }> {
  const db = await openDatabase(`conv-test-${n++}`);
  const deps = { config, api: b.api, db, bridge: tg, broadcast: () => {}, closeDelayMs: 0, background: false, issuer: b.issuer, mediaIssuer: b.issuer };
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
  return Object.assign(app, { db, reopen });
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
    for (let i = 0; i < 100 && b.sends.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
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
    // A flood comes in while it's open.
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
      // The newest 200, and ours failed first, however old: no more each time.
      expect(chat.messages).toHaveLength(MAX_SHOWN + 1);
      expect([chat.messages[0]!.text, chat.messages[0]!.status, chat.messages.at(-1)!.text, chat.more]).toEqual(['mine', 'failed', `one more ${round}`, true]);
      // What it shows, and the new one as it's taken in: not the flood behind them.
      expect(opened()).toBeLessThanOrEqual(MAX_SHOWN + 1 + 5);
    }
    decrypt.mockRestore();
  }, 60_000);

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
    expect(canResend(failed)).toBe(true);
    expect(sender.preparing.value).toEqual([]);
    // Asked once, and every media token fetched is still in the wallet.
    expect(b.mediaCalls).toEqual(['POST /media']);
    expect(await countTokens(sender.db, b.issuer.keyId, undefined, 'media')).toBe(b.state.mediaSigned);

    // Try again while still paused: the same notice, one more request, nothing lost.
    await sender.resendMedia(failed.id);
    expect(screenOf(sender.screen.value, 'conversation')).toMatchObject({ error: 'media-paused' });
    expect((await listMessages(sender.db, conv.id)).at(-1)).toMatchObject({ id: failed.id, status: 'failed' });
    expect(b.mediaCalls).toEqual(['POST /media', 'POST /media']);
    expect(await countTokens(sender.db, b.issuer.keyId, undefined, 'media')).toBe(b.state.mediaSigned);
    // Text messages go on.
    await sender.sendMessage('still here');
    expect(screenOf(sender.screen.value, 'conversation')).toMatchObject({ error: null });
    expect(screenOf(sender.screen.value, 'conversation').messages.at(-1)).toMatchObject({ text: 'still here', status: 'sent' });
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
