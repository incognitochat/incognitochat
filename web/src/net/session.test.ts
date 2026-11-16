import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { prepareSetup, readAccount, register } from '../account/account';
import { openDatabase } from '../storage/db';
import { ApiError, checkObject, type Api } from './api';
import { createClock } from './clock';
import { createSession } from './session';

let n = 0;
const NOW = 1_800_000_000;
/** A device whose clock agrees with the server's, or is off by skew seconds. */
const deviceClock = (skew = 0) => createClock(() => (NOW + skew) * 1000);

/** A server that answers logins and records what each call carried; it checks times as the backend does. */
function server(options: { expireFirst?: boolean; replaced?: boolean } = {}) {
  const seen: { method: string; path: string; auth: string | undefined; signature: string | undefined }[] = [];
  let logins = 0;
  let expired = options.expireFirst ?? false;
  const skewed = (timestamp: number) => Math.abs(timestamp - NOW) > 60;
  const api: Api = {
    post: (path, body, check) => api.request('POST', path, { body: JSON.stringify(body) }, check),
    async request(method, path, init, check) {
      if (path === '/register' || path === '/session') {
        if (path === '/session') {
          logins++;
          if (skewed((JSON.parse(init.body!) as { timestamp: number }).timestamp)) throw new ApiError(401, 'clock_skew', NOW);
        }
        return check({ account: 'BBBBBBBBBBBBBBBBBBBBBB', token: `v1.t${logins}.m`, expires: NOW + 900 });
      }
      const signature = init.headers?.['X-Device-Signature'];
      seen.push({ method, path, auth: init.headers?.['X-Session'], signature });
      if (signature && skewed(Number(signature.split('.')[0]))) throw new ApiError(401, 'clock_skew', NOW);
      if (expired) {
        expired = false;
        throw new ApiError(401, 'session_expired');
      }
      if (options.replaced) throw new ApiError(410, 'account_replaced');
      return check({});
    },
  };
  return { api, seen, logins: () => logins };
}

async function registeredDb(api: Api) {
  const db = await openDatabase(`session-test-${n++}`);
  const code = await prepareSetup(db);
  await register(db, api, { initData: 'd', startParam: code }, { replace: false, clock: deviceClock() });
  return db;
}

describe('session', () => {
  it('logs in once and reuses the token', async () => {
    const s = server();
    const session = createSession(await registeredDb(s.api), s.api, deviceClock());
    await session.call('GET', '/account', undefined, checkObject);
    await session.call('GET', '/account', undefined, checkObject);
    expect(s.logins()).toBe(1);
    expect(s.seen.map((c) => c.auth)).toEqual(['v1.t1.m', 'v1.t1.m']);
    expect(s.seen[0]!.signature).toBeUndefined();
  });

  it('logs in again after an expired token, once', async () => {
    const s = server({ expireFirst: true });
    const session = createSession(await registeredDb(s.api), s.api, deviceClock());
    await session.call('GET', '/account', undefined, checkObject);
    expect(s.logins()).toBe(2);
    expect(s.seen.map((c) => c.auth)).toEqual(['v1.t1.m', 'v1.t2.m']);
  });

  it('signs sensitive requests with a fresh nonce each time', async () => {
    const s = server();
    const session = createSession(await registeredDb(s.api), s.api, deviceClock());
    await session.call('POST', '/links', { id: 'x' }, checkObject, { sign: true });
    await session.call('POST', '/links', { id: 'x' }, checkObject, { sign: true });
    const [a, b] = s.seen.map((c) => c.signature!);
    expect(a).toMatch(new RegExp(`^${NOW}\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{86}$`));
    expect(a!.split('.')[1]).not.toBe(b!.split('.')[1]);
  });

  it('records a replaced account', async () => {
    const s = server({ replaced: true });
    const db = await registeredDb(s.api);
    const session = createSession(db, s.api, deviceClock());
    await expect(session.call('GET', '/account', undefined, checkObject)).rejects.toMatchObject({ code: 'account_replaced' });
    expect(await readAccount(db)).toMatchObject({ state: 'replaced' });
  });

  it("signs for an account recorded as replaced, so the server's answer says so", async () => {
    const s = server({ replaced: true });
    const db = await registeredDb(s.api);
    const session = createSession(db, s.api, deviceClock());
    session.use({ account: 'BBBBBBBBBBBBBBBBBBBBBB', token: 'v1.t.m', expires: NOW + 900 });
    await expect(session.call('GET', '/account', undefined, checkObject)).rejects.toMatchObject({ code: 'account_replaced' });
    // Not a "not registered" error from the device: the server's own answer.
    await expect(session.call('POST', '/links', { id: 'x' }, checkObject, { sign: true })).rejects.toMatchObject({ code: 'account_replaced' });
    expect(s.seen.at(-1)!.signature).toBeDefined();
  });

  it('records a device the server no longer accepts', async () => {
    const s = server();
    const db = await registeredDb(s.api);
    const refusing: typeof s.api = {
      ...s.api,
      request: async () => {
        throw new ApiError(401, 'login_refused');
      },
    };
    const session = createSession(db, refusing, deviceClock());
    session.use({ account: 'BBBBBBBBBBBBBBBBBBBBBB', token: 'v1.t.m', expires: NOW + 900 });
    await expect(session.call('GET', '/account', undefined, checkObject)).rejects.toMatchObject({ code: 'login_refused' });
    expect(await readAccount(db)).toMatchObject({ state: 'refused' });
  });
});

describe('a device clock that is off', () => {
  it('logs in by the server clock after one try, and keeps using it', async () => {
    const s = server();
    const clock = deviceClock(300);
    const session = createSession(await registeredDb(s.api), s.api, clock);
    await session.call('GET', '/account', undefined, checkObject);
    expect(s.logins()).toBe(2);
    // Signed requests are timed by the server's clock from then on, at once.
    await session.call('POST', '/links', { id: 'x' }, checkObject, { sign: true });
    expect(Math.abs(Number(s.seen.at(-1)!.signature!.split('.')[0]) - NOW)).toBeLessThanOrEqual(1);
    expect(s.seen).toHaveLength(2);
  });

  it('signs a request again by the server clock, once', async () => {
    const s = server();
    let local = NOW * 1000;
    const session = createSession(await registeredDb(s.api), s.api, createClock(() => local));
    await session.call('GET', '/account', undefined, checkObject);
    // The device's clock is set 10 minutes back while the app is open.
    local -= 600_000;
    await session.call('POST', '/links', { id: 'x' }, checkObject, { sign: true });
    const signed = s.seen.filter((c) => c.signature).map((c) => Number(c.signature!.split('.')[0]));
    expect(signed).toHaveLength(2);
    expect(signed[0]).toBe(NOW - 600);
    expect(Math.abs(signed[1]! - NOW)).toBeLessThanOrEqual(1);
    expect(s.logins()).toBe(1);
  });

  it("doesn't take a token that is still valid by the server's clock for expired", async () => {
    const s = server();
    // 20 minutes fast: by this device's own clock, every 15-minute token is already over.
    const session = createSession(await registeredDb(s.api), s.api, deviceClock(1200));
    await session.call('GET', '/account', undefined, checkObject);
    await session.call('GET', '/account', undefined, checkObject);
    await session.call('GET', '/account', undefined, checkObject);
    // One refused login and one accepted, then the token is reused.
    expect(s.logins()).toBe(2);
  });
});
