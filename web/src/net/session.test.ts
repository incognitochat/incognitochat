import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { prepareSetup, readAccount, register } from '../account/account';
import { openDatabase } from '../storage/db';
import { ApiError, checkObject, NetworkError, type Api } from './api';
import { createClock } from './clock';
import { createSession, LOGIN_RETRY_MAX_MS, LOGIN_RETRY_MS } from './session';

let n = 0;
const NOW = 1_800_000_000;
/** A device whose clock agrees with the server's, or is off by skew seconds. */
const deviceClock = (skew = 0) => createClock(() => (NOW + skew) * 1000);

/** A server that answers logins and records what each call carried; it checks times as the backend does. */
function server(options: { expireFirst?: boolean; replaced?: boolean; refuseFirstLogins?: number } = {}) {
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
          // The server's login read not seeing a device set up a moment ago.
          if (logins <= (options.refuseFirstLogins ?? 0)) throw new ApiError(401, 'login_refused');
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
  it('right after a setup in another copy, tries a refused login once more', async () => {
    const s = server({ refuseFirstLogins: 1 });
    const db = await registeredDb(s.api);
    let clockMs = 0;
    const session = createSession(db, s.api, deviceClock(), () => clockMs);
    session.setUp();
    clockMs = 2_000;
    await session.call('GET', '/account', undefined, checkObject);
    expect(s.logins()).toBe(2);
    expect((await readAccount(db))?.state).toBe('registered');
  });

  it('records a refused login at once otherwise, and after one retry', async () => {
    const late = server({ refuseFirstLogins: 1 });
    const db = await registeredDb(late.api);
    let clockMs = 0;
    const session = createSession(db, late.api, deviceClock(), () => clockMs);
    session.setUp();
    clockMs = 60_000; // long after the setup
    await expect(session.call('GET', '/account', undefined, checkObject)).rejects.toMatchObject({ code: 'login_refused' });
    expect(late.logins()).toBe(1);
    expect((await readAccount(db))?.state).toBe('refused');

    const gone = server({ refuseFirstLogins: 5 });
    const db2 = await registeredDb(gone.api);
    const fresh = createSession(db2, gone.api, deviceClock(), () => 0);
    fresh.setUp();
    await expect(fresh.call('GET', '/account', undefined, checkObject)).rejects.toMatchObject({ code: 'login_refused' });
    expect(gone.logins()).toBe(2);
    expect((await readAccount(db2))?.state).toBe('refused');
  });

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

describe('logins that fail for want of the server', () => {
  /** A server whose logins fail with fail() while it returns an error, and succeed otherwise. */
  function failing(fail: () => Error | null) {
    const s = server();
    let tries = 0;
    const api: Api = {
      post: (path, body, check) => api.request('POST', path, { body: JSON.stringify(body) }, check),
      async request(method, path, init, check) {
        if (path === '/session') {
          tries++;
          const err = fail();
          if (err) throw err;
        }
        return s.api.request(method, path, init, check);
      },
    };
    return { api, setUpWith: s.api, tries: () => tries };
  }

  it.each([
    ['the firewall turning it away', () => new ApiError(429, 'rate_limited')],
    ['the server failing', () => new ApiError(500, 'internal')],
    ['no answer', () => new NetworkError('request failed')],
  ])('waits, longer each time, after %s', async (_, error) => {
    let down = true;
    const f = failing(() => (down ? error() : null));
    const db = await registeredDb(f.setUpWith);
    let clockMs = 1_000_000;
    // The longest wait each time (no jitter off it).
    const session = createSession(db, f.api, deviceClock(), () => clockMs, () => 0.999_999);
    const get = () => session.call('GET', '/account', undefined, checkObject);

    const first: unknown = await get().catch((e: unknown) => e);
    expect(f.tries()).toBe(1);
    // Every request until the wait is over gets the same error, without a login.
    clockMs += LOGIN_RETRY_MS - 10;
    await expect(get()).rejects.toBe(first);
    expect(f.tries()).toBe(1);
    clockMs += 10;
    await expect(get()).rejects.toThrow();
    expect(f.tries()).toBe(2);
    // Twice as long the second time.
    clockMs += LOGIN_RETRY_MS;
    await expect(get()).rejects.toThrow();
    expect(f.tries()).toBe(2);
    clockMs += LOGIN_RETRY_MS;
    await expect(get()).rejects.toThrow();
    expect(f.tries()).toBe(3);
    // Never longer than the most.
    for (let i = 0; i < 10; i++) {
      clockMs += LOGIN_RETRY_MAX_MS;
      await expect(get()).rejects.toThrow();
    }
    expect(f.tries()).toBe(13);
    // And once the server is back, the next try logs in.
    down = false;
    clockMs += LOGIN_RETRY_MAX_MS;
    await get();
    expect(f.tries()).toBe(14);
  });

  it('spreads the waits of apps behind one address', async () => {
    const f = failing(() => new ApiError(429, 'rate_limited'));
    const db = await registeredDb(f.setUpWith);
    let clockMs = 1_000_000;
    // Half the wait, the shortest.
    const session = createSession(db, f.api, deviceClock(), () => clockMs, () => 0);
    const get = () => session.call('GET', '/account', undefined, checkObject);
    await expect(get()).rejects.toMatchObject({ code: 'rate_limited' });
    clockMs += LOGIN_RETRY_MS / 2;
    await expect(get()).rejects.toMatchObject({ code: 'rate_limited' });
    expect(f.tries()).toBe(2);
  });

  it("doesn't wait after a refusal, and logs in once for everything that needs it at the same time", async () => {
    const s = server();
    const session = createSession(await registeredDb(s.api), s.api, deviceClock());
    await Promise.all([1, 2, 3].map(() => session.call('GET', '/account', undefined, checkObject)));
    expect(s.logins()).toBe(1);

    const refused = failing(() => new ApiError(401, 'login_refused'));
    const db = await registeredDb(refused.setUpWith);
    const again = createSession(db, refused.api, deviceClock(), () => 0);
    await expect(again.call('GET', '/account', undefined, checkObject)).rejects.toMatchObject({ code: 'login_refused' });
    await expect(again.call('GET', '/account', undefined, checkObject)).rejects.toMatchObject({ code: 'login_refused' });
    expect(refused.tries()).toBe(2);
  });

  it('logs in at once after a setup in another copy', async () => {
    let down = true;
    const f = failing(() => (down ? new NetworkError('request failed') : null));
    const db = await registeredDb(f.setUpWith);
    const session = createSession(db, f.api, deviceClock(), () => 1_000_000);
    await expect(session.call('GET', '/account', undefined, checkObject)).rejects.toBeInstanceOf(NetworkError);
    down = false;
    session.setUp();
    await session.call('GET', '/account', undefined, checkObject);
    expect(f.tries()).toBe(2);
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
