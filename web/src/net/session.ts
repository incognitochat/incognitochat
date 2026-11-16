// Logged-in requests. Keeps the session token in memory (never in storage),
// logs in again when it expires, and signs sensitive requests with the device
// key on top of the token. Times the server checks come from the server's
// clock as this device knows it (clock.ts), not the device's own.

import { isSetUp, logIn, readAccount, recordRefusal, signRequest } from '../account/account';
import type { Database } from '../storage/db';
import { ApiError, type Api, type Method, type TokenResponse } from './api';
import { createClock, type Clock } from './clock';

/** Renew this long before the server's expiry, to allow for clock skew. */
const MARGIN_SECONDS = 60;
/** For this long after a setup, a refused login is tried once more (logIn's justSetUp). */
const JUST_SET_UP_MS = 10_000;

export interface Session {
  /**
   * Sends a logged-in request. sign adds a device signature (needed to
   * create, rotate or revoke links). Retries once after an expired token, and
   * once after the server says this device's clock is off.
   */
  call<T>(method: Method, path: string, body: unknown, check: (value: unknown) => T, options?: { sign?: boolean }): Promise<T>;
  /** Uses a token just received (from registration). */
  use(token: TokenResponse): void;
  /** A current session token (for the push socket), logging in if needed. */
  token(): Promise<string>;
}

/** The app's own session, which also hears about setups in other copies. */
export interface AppSession extends Session {
  /** The account was just set up in another copy of the app: a login refused in the next few seconds is tried once more. */
  setUp(): void;
}

export function createSession(db: Database, api: Api, clock: Clock = createClock(), now: () => number = Date.now): AppSession {
  let current: TokenResponse | null = null;
  /** When the account was last set up, here or in another copy (Unix ms). */
  let setUpAt = -Infinity;

  async function token(): Promise<string> {
    // The expiry is the server's time, so it's compared with the server's clock.
    if (!current || current.expires - MARGIN_SECONDS <= clock.seconds()) {
      current = await logIn(db, api, clock, now() - setUpAt < JUST_SET_UP_MS);
    }
    return current.token;
  }

  return {
    use(t) {
      current = t;
      setUpAt = now();
    },
    setUp() {
      setUpAt = now();
    },
    token,
    async call(method, path, body, check, options = {}) {
      const text = body === undefined ? '' : JSON.stringify(body);
      let renewed = false;
      let retimed = false;
      for (;;) {
        const headers: Record<string, string> = { 'X-Session': await token() };
        if (options.sign) headers['X-Device-Signature'] = await signRequest(db, method, path, text, () => clock.seconds());
        try {
          return await api.request(method, path, text === '' ? { headers } : { body: text, headers }, check);
        } catch (err) {
          if (err instanceof ApiError && err.code === 'session_expired' && !renewed) {
            renewed = true;
            current = null;
            continue;
          }
          // The signature's time was off: signed again by the server's clock.
          if (options.sign && !retimed && clock.learn(err)) {
            retimed = true;
            continue;
          }
          // Replaced, or no longer accepted: recorded, and asked again at the next launch.
          if (err instanceof ApiError && (err.code === 'account_replaced' || err.code === 'login_refused')) {
            const account = await readAccount(db);
            if (isSetUp(account)) await recordRefusal(db, account.accountId, err);
          }
          throw err;
        }
      }
    },
  };
}
