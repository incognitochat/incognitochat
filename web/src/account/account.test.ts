import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { fromBase64Url, fromHex, toHex } from '../crypto/encoding';
import { importSigningPublicKey } from '../crypto/keys';
import { LABEL_REGISTER, LABEL_REQUEST, LABEL_SESSION, message, verify } from '../crypto/signing';
import { ApiError, type Api } from '../net/api';
import { createClock } from '../net/clock';
import { getKeyPair, getMeta, getSealed, openDatabase, putMeta, putSealed } from '../storage/db';
import { listConversations, putConversation } from '../messaging/store';
import {
  isRegistrationLaunch,
  markReplaced,
  META_START_OVER,
  takePendingLink,
  logIn,
  loginParts,
  prepareSetup,
  readAccount,
  register,
  registerParts,
  registrationPath,
  rememberLink,
  requestParts,
  SetupMismatch,
} from './account';

// The same vectors as backend/internal/api/vectors_test.go.
const KEY = '043e4cd596e64fe0d4dac5cce1479f58b981e24664c49c89e823be92673cd970d130b3038618a2156d3db3edccde5a6f271cb346dd868dc771d0ba2812a1197cb1';
const REGISTER =
  '0019696e636f676e69746f636861742f76322f726567697374657200000020ed6cc20d3628da6bf65e3033d5628dafcd44b7194eaac0d218b37621ab1b6c7300000041043e4cd596e64fe0d4dac5cce1479f58b981e24664c49c89e823be92673cd970d130b3038618a2156d3db3edccde5a6f271cb346dd868dc771d0ba2812a1197cb1000000164141414141414141414141414141414141414141414100000041043e4cd596e64fe0d4dac5cce1479f58b981e24664c49c89e823be92673cd970d130b3038618a2156d3db3edccde5a6f271cb346dd868dc771d0ba2812a1197cb1';
const REQUEST =
  '0018696e636f676e69746f636861742f76322f726571756573740000001642424242424242424242424242424242424242424242000000164141414141414141414141414141414141414141414100000004504f5354000000062f6c696e6b730000000a31383030303030303030000000126e6f6e63652d30313233343536373839616200000020015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862';
const LOGIN =
  '0018696e636f676e69746f636861742f76322f73657373696f6e000000164242424242424242424242424242424242424242424200000016414141414141414141414141414141414141414141410000000a31383030303030303030000000126e6f6e63652d303132333435363738396162';

let n = 0;
const fresh = () => openDatabase(`account-test-${n++}`);
const NOW = 1_800_000_000;
const ACCOUNT_ID = 'BBBBBBBBBBBBBBBBBBBBBB';
/** A device whose clock agrees with the fake server's. */
const atNow = () => createClock(() => NOW * 1000);

/** The issued time (Unix seconds) of an encoded device list. */
function listIssued(list: Uint8Array): number {
  const view = new DataView(list.buffer, list.byteOffset, list.byteLength);
  // Label, then suite (1), sequence (8) and previous hash (32), each after a 4-byte length.
  const offset = 2 + view.getUint16(0) + (4 + 1) + (4 + 8) + (4 + 32) + 4;
  return Number(view.getBigUint64(offset));
}

/** A fake server that checks requests the way the backend does, by its clock (Unix seconds). */
function fakeServer(options: { exists?: boolean; replaced?: boolean; refused?: boolean; now?: number } = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const serverNow = options.now ?? NOW;
  let deviceKey: Uint8Array<ArrayBuffer> | undefined;
  const api: Api = {
    request: (_method, path, init, check) => api.post(path, JSON.parse(init.body ?? '{}'), check),
    async post(path, body, check) {
      const b = body as Record<string, string>;
      calls.push({ path, body: b });
      if (path === '/register') {
        const issued = listIssued(fromBase64Url(b.deviceList!));
        if (issued < serverNow - 2 * 3600 || issued > serverNow + 3600) throw new ApiError(401, 'clock_skew', serverNow);
        const ak = await importSigningPublicKey(fromBase64Url(b.accountKey!));
        const dk = await importSigningPublicKey(fromBase64Url(b.deviceKey!));
        const parts = await registerParts(b.initData!, fromBase64Url(b.accountKey!), b.device!, fromBase64Url(b.deviceKey!));
        if (!(await verify(ak, fromBase64Url(b.accountSig!), LABEL_REGISTER, ...parts))) throw new ApiError(401, 'signature_rejected');
        if (!(await verify(dk, fromBase64Url(b.deviceSig!), LABEL_REGISTER, ...parts))) throw new ApiError(401, 'signature_rejected');
        const list = fromBase64Url(b.deviceList!);
        const listOk = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, ak, fromBase64Url(b.deviceListSig!), list);
        if (!listOk) throw new ApiError(400, 'invalid_device_list');
        if (options.exists && !(body as { replace?: boolean }).replace) throw new ApiError(409, 'account_exists');
        deviceKey = fromBase64Url(b.deviceKey!);
        return check({ account: ACCOUNT_ID, token: 'v1.payload.mac', expires: NOW + 900 });
      }
      if (path === '/session') {
        // Before anything about the device, as the backend does.
        if (Math.abs(Number(b.timestamp) - serverNow) > 60) throw new ApiError(401, 'clock_skew', serverNow);
        const dk = await importSigningPublicKey(deviceKey!);
        const parts = loginParts(b.account!, b.device!, Number(b.timestamp), b.nonce!);
        if (!(await verify(dk, fromBase64Url(b.signature!), LABEL_SESSION, ...parts))) throw new ApiError(401, 'login_refused');
        if (options.refused) throw new ApiError(401, 'login_refused');
        if (options.replaced) throw new ApiError(410, 'account_replaced');
        return check({ account: b.account, token: 'v1.payload.mac', expires: NOW + 900 });
      }
      throw new ApiError(404, 'not_found');
    },
  };
  return { api, calls };
}

describe('signed messages match the backend', () => {
  it('register', async () => {
    const key = fromHex(KEY);
    const parts = await registerParts('auth_date=1800000000&start_param=reg&user=%7B%7D', key, 'AAAAAAAAAAAAAAAAAAAAAA', key);
    expect(toHex(message(LABEL_REGISTER, ...parts))).toBe(REGISTER);
  });

  it('request', async () => {
    const parts = await requestParts(ACCOUNT_ID, 'AAAAAAAAAAAAAAAAAAAAAA', 'POST', '/links', NOW, 'nonce-0123456789ab', '{"a":1}');
    expect(toHex(message(LABEL_REQUEST, ...parts))).toBe(REQUEST);
  });

  it('login', () => {
    const parts = loginParts(ACCOUNT_ID, 'AAAAAAAAAAAAAAAAAAAAAA', NOW, 'nonce-0123456789ab');
    expect(toHex(message(LABEL_SESSION, ...parts))).toBe(LOGIN);
  });
});

describe('setup', () => {
  it('creates keys once and reuses a pending setup', async () => {
    const db = await fresh();
    const code = await prepareSetup(db);
    expect(isRegistrationLaunch(code)).toBe(true);
    expect(await prepareSetup(db)).toBe(code);

    const account = await getKeyPair(db, 'account-key');
    const device = await getKeyPair(db, 'device-signing-key');
    expect(account!.privateKey.extractable).toBe(false);
    expect(device!.privateKey.extractable).toBe(false);
    expect(await readAccount(db)).toMatchObject({ state: 'pending', fingerprint: code.slice(3) });
  });

  it("starts a new account with nothing of the replaced one's", async () => {
    const db = await fresh();
    await prepareSetup(db);
    // Pretend it registered and has data, then was replaced.
    await putMeta(db, 'account', { state: 'registered', deviceId: 'A'.repeat(22), fingerprint: 'B'.repeat(43), accountId: 'C'.repeat(22) });
    await putMeta(db, 'mailbox-pool', ['D'.repeat(22)]);
    await putMeta(db, 'links', [{ id: 'E'.repeat(11), fingerprint: 'F'.repeat(43), keys: [] }]);
    await putSealed(db, 'link-signing', new Uint8Array([1, 2, 3]));
    await putConversation(db, {
      id: 'G'.repeat(22),
      wire: 'I'.repeat(22),
      role: 'sender',
      link: { id: 'E'.repeat(11), fingerprint: 'F'.repeat(43) },
      label: 'x',
      peerKey: 'k',
      myKey: null,
      sendTo: 'H'.repeat(22),
      myMailbox: 'D'.repeat(22),
      lastAt: 0,
      unread: 0,
      status: 'active',
      lastReceived: null,
    });
    await markReplaced(db, 'C'.repeat(22));
    await rememberLink(db, '1' + 'E'.repeat(11) + 'F'.repeat(43));
    await putMeta(db, META_START_OVER, true);

    // Only when asked to start over (after the typed confirmation): the server saying so isn't enough.
    await expect(prepareSetup(db)).rejects.toThrow();
    expect(await listConversations(db)).toHaveLength(1);
    const code = await prepareSetup(db, { restart: true });
    expect(await readAccount(db)).toMatchObject({ state: 'pending', fingerprint: code.slice(3) });
    expect(await listConversations(db)).toEqual([]);
    expect(await getMeta(db, 'mailbox-pool')).toBeUndefined();
    expect(await getMeta(db, 'links')).toBeUndefined();
    expect(await getSealed(db, 'link-signing')).toBeUndefined();
    // Kept: the link opened just before, and the choice to start over.
    expect(await getMeta(db, META_START_OVER)).toBe(true);
    expect(await takePendingLink(db)).toBe('1' + 'E'.repeat(11) + 'F'.repeat(43));
  });

  it('builds the reopen path', () => {
    expect(registrationPath('some_bot', 'regABC')).toBe('/some_bot?startapp=regABC');
  });

  it('tells registration launches from link launches', () => {
    expect(isRegistrationLaunch('reg' + 'a'.repeat(43))).toBe(true);
    expect(isRegistrationLaunch('reg' + 'a'.repeat(42))).toBe(false);
    expect(isRegistrationLaunch('aBcDeFgHiJkLmNoPqRsTuV')).toBe(false);
    expect(isRegistrationLaunch('')).toBe(false);
  });
});

describe('register', () => {
  it('registers with signatures the server accepts, then logs in', async () => {
    const db = await fresh();
    const code = await prepareSetup(db);
    const { api, calls } = fakeServer();
    const result = await register(db, api, { initData: 'signed-launch-data', startParam: code }, { replace: false, clock: atNow() });
    expect(result.account).toBe(ACCOUNT_ID);
    expect(calls[0]!.body.initData).toBe('signed-launch-data');
    expect(calls[0]!.body.replace).toBe(false);
    expect(await readAccount(db)).toMatchObject({ state: 'registered', accountId: ACCOUNT_ID });

    await logIn(db, api, atNow());
    expect(calls[1]!.path).toBe('/session');
  });

  it('dates the device list by the server, if this device is hours off', async () => {
    const db = await fresh();
    const code = await prepareSetup(db);
    const { api, calls } = fakeServer();
    // The clock reads the right local time in the wrong time zone: 3.5 hours off.
    const clock = createClock(() => (NOW + 3.5 * 3600) * 1000);
    await register(db, api, { initData: 'd', startParam: code }, { replace: false, clock });
    expect(calls.map((c) => c.path)).toEqual(['/register', '/register']);
    expect(await readAccount(db)).toMatchObject({ state: 'registered' });
    // Learnt for what follows: the login goes through at once.
    await logIn(db, api, clock);
    expect(calls.map((c) => c.path)).toEqual(['/register', '/register', '/session']);
  });

  it("doesn't sign by a server clock that's days away, and doesn't register", async () => {
    const db = await fresh();
    const code = await prepareSetup(db);
    const { api, calls } = fakeServer();
    const clock = createClock(() => (NOW + 3 * 86_400) * 1000);
    const err = await register(db, api, { initData: 'd', startParam: code }, { replace: false, clock }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'clock_skew' });
    expect(clock.tooFar(err)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await readAccount(db)).toMatchObject({ state: 'pending' });
  });

  it("refuses a launch that isn't for this setup, without calling the server", async () => {
    const db = await fresh();
    await prepareSetup(db);
    const { api, calls } = fakeServer();
    const other = 'reg' + 'x'.repeat(43);
    await expect(register(db, api, { initData: 'd', startParam: other }, { replace: false })).rejects.toBeInstanceOf(SetupMismatch);
    await expect(register(await fresh(), api, { initData: 'd', startParam: other }, { replace: false })).rejects.toBeInstanceOf(
      SetupMismatch,
    );
    expect(calls).toHaveLength(0);
  });

  it('needs replace when the Telegram user already has an account', async () => {
    const db = await fresh();
    const code = await prepareSetup(db);
    const { api } = fakeServer({ exists: true });
    const err = await register(db, api, { initData: 'd', startParam: code }, { replace: false, clock: atNow() }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'account_exists' });
    expect(await readAccount(db)).toMatchObject({ state: 'pending' });
    await register(db, api, { initData: 'd', startParam: code }, { replace: true, clock: atNow() });
    expect(await readAccount(db)).toMatchObject({ state: 'registered' });
  });
});

describe('logging in', () => {
  it("learns from the token the server's clock that messages are dated by, as registering does", async () => {
    const db = await fresh();
    const code = await prepareSetup(db);
    const { api } = fakeServer();
    // 40 seconds fast: logins still go through on the device's own time.
    const clock = createClock(() => (NOW + 40) * 1000);
    await register(db, api, { initData: 'd', startParam: code }, { replace: false, clock });
    expect(Math.abs(clock.messageNow() - NOW * 1000)).toBeLessThanOrEqual(1000);
    const again = createClock(() => (NOW + 40) * 1000);
    expect(again.messageNow()).toBe((NOW + 40) * 1000);
    await logIn(db, api, again);
    expect(Math.abs(again.messageNow() - NOW * 1000)).toBeLessThanOrEqual(1000);
    expect(again.now()).toBe((NOW + 40) * 1000);
  });

  it('signs again by the server clock when this device is 5 minutes fast', async () => {
    const db = await fresh();
    const code = await prepareSetup(db);
    const { api, calls } = fakeServer();
    await register(db, api, { initData: 'd', startParam: code }, { replace: false, clock: atNow() });

    const clock = createClock(() => (NOW + 300) * 1000);
    await logIn(db, api, clock);
    const logins = calls.filter((c) => c.path === '/session').map((c) => Number(c.body.timestamp));
    expect(logins).toHaveLength(2);
    expect(logins[0]).toBe(NOW + 300);
    expect(Math.abs(logins[1]! - NOW)).toBeLessThanOrEqual(1);
    expect(Math.abs(clock.offset() + 300_000)).toBeLessThanOrEqual(1000);
    // A new nonce for the second try.
    expect(calls.at(-1)!.body.nonce).not.toBe(calls.at(-2)!.body.nonce);
  });

  it('tries once only, so a server that keeps saying so is an error', async () => {
    const db = await fresh();
    const code = await prepareSetup(db);
    const { api } = fakeServer();
    await register(db, api, { initData: 'd', startParam: code }, { replace: false, clock: atNow() });
    let tries = 0;
    const lying: Api = {
      ...api,
      post: () => {
        tries++;
        return Promise.reject(new ApiError(401, 'clock_skew', NOW + 7200 * tries));
      },
    };
    await expect(logIn(db, lying, atNow())).rejects.toMatchObject({ code: 'clock_skew' });
    expect(tries).toBe(2);
  });
});

describe('replaced accounts', () => {
  it('records the replacement, and sets up with new keys only when asked to start over', async () => {
    const db = await fresh();
    const code = await prepareSetup(db);
    const { api } = fakeServer({ replaced: true });
    await register(db, api, { initData: 'd', startParam: code }, { replace: false, clock: atNow() });

    const err = await logIn(db, api, atNow()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'account_replaced' });
    expect(await readAccount(db)).toMatchObject({ state: 'replaced' });

    await expect(prepareSetup(db)).rejects.toThrow();
    expect(await readAccount(db)).toMatchObject({ state: 'replaced' });
    const next = await prepareSetup(db, { restart: true });
    expect(next).not.toBe(code);
    expect(await readAccount(db)).toMatchObject({ state: 'pending' });
  });

  it('asks again, and takes it back when the server lets the device in', async () => {
    const db = await fresh();
    const code = await prepareSetup(db);
    const server = { replaced: true };
    const { api } = fakeServer(server);
    await register(db, api, { initData: 'd', startParam: code }, { replace: false, clock: atNow() });
    await expect(logIn(db, api, atNow())).rejects.toMatchObject({ code: 'account_replaced' });
    expect(await readAccount(db)).toMatchObject({ state: 'replaced' });

    server.replaced = false;
    await logIn(db, api, atNow());
    expect(await readAccount(db)).toMatchObject({ state: 'registered' });
  });

  it('records a refused login, keeps a replacement over it, and clears both when let in', async () => {
    const db = await fresh();
    const code = await prepareSetup(db);
    const server: { replaced?: boolean; refused?: boolean } = { refused: true };
    const { api } = fakeServer(server);
    await register(db, api, { initData: 'd', startParam: code }, { replace: false, clock: atNow() });
    await expect(logIn(db, api, atNow())).rejects.toMatchObject({ code: 'login_refused' });
    expect(await readAccount(db)).toMatchObject({ state: 'refused' });
    // Setting up again over it still takes the typed confirmation (restart).
    await expect(prepareSetup(db)).rejects.toThrow();

    // Replaced: that's recorded; a later refusal (the server forgot the replacement) doesn't undo it.
    Object.assign(server, { refused: false, replaced: true });
    await expect(logIn(db, api, atNow())).rejects.toMatchObject({ code: 'account_replaced' });
    Object.assign(server, { refused: true, replaced: false });
    await expect(logIn(db, api, atNow())).rejects.toMatchObject({ code: 'login_refused' });
    expect(await readAccount(db)).toMatchObject({ state: 'replaced' });

    server.refused = false;
    await logIn(db, api, atNow());
    expect(await readAccount(db)).toMatchObject({ state: 'registered' });
  });
});

describe('links opened before setup', () => {
  it('remembers a link but never a registration code', async () => {
    const db = await fresh();
    await rememberLink(db, 'reg' + 'a'.repeat(43));
    expect(await getMeta(db, 'pending-link')).toBeUndefined();
    await rememberLink(db, 'bad link!');
    expect(await getMeta(db, 'pending-link')).toBeUndefined();
    await rememberLink(db, 'aBcDeFgHiJkLmNoPqRsTuV');
    expect(await getMeta(db, 'pending-link')).toBe('aBcDeFgHiJkLmNoPqRsTuV');
  });
});
