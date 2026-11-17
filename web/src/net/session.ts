// Logged-in requests. Keeps the session token in memory (never in storage),
// logs in again when it expires, and signs sensitive requests with the device
// key on top of the token. Times the server checks come from the server's
// clock as this device knows it (clock.ts), not the device's own.

import { isSetUp, logIn, readAccount, recordRefusal, signRequest } from '../account/account';
import type { Database } from '../storage/db';
import { ApiError, NetworkError, type Api, type Method, type TokenResponse } from './api';
import { createClock, type Clock } from './clock';

/** Renew this long before the server's expiry, to allow for clock skew. */
const MARGIN_SECONDS = 60;
/** For this long after a setup, a refused login is tried once more (logIn's justSetUp). */
const JUST_SET_UP_MS = 10_000;
/**
 * After a login that failed for want of the server, the next waits about
 * this long, twice as long after each further failure, up to
 * LOGIN_RETRY_MAX_MS; each wait is between half of that and all of it, so
 * copies of the app behind one address don't try together. Every sync and
 * socket would otherwise log in again at once, and the apps behind an
 * address the firewall has turned away would keep it busy themselves.
 */
export const LOGIN_RETRY_MS = 10_000;
export const LOGIN_RETRY_MAX_MS = 120_000;

/** A failed login worth waiting out: the server out of reach, turning requests away (429, the firewall's too), or failing. */
function waitAfter(err: unknown): boolean {
  return err instanceof NetworkError || (err instanceof ApiError && (err.status === 429 || err.status >= 500));
}

export interface Session {
  /**
   * Sends a logged-in request. sign adds a device signature (needed to
   * create, rotate or revoke links). Retries once after an expired token, and
   * once after the server says this device's clock is off.
   */
  call<T>(method: Method, path: string, body: unknown, check: (value: unknown) => T, options?: { sign?: boolean }): Promise<T>;
  /** Uses a token just received (from registration). */
  use(token: TokenResponse): void;
  /**
   * A current session token (for the push socket), logging in if needed.
   * After a login failed for want of the server, the same error comes back
   * without a request until a wait is over (LOGIN_RETRY_MS).
   */
  token(): Promise<string>;
}

/** The app's own session, which also hears about setups in other copies. */
export interface AppSession extends Session {
  /** The account was just set up in another copy of the app: a login refused in the next few seconds is tried once more. */
  setUp(): void;
}

export function createSession(
  db: Database,
  api: Api,
  clock: Clock = createClock(),
  now: () => number = Date.now,
  random: () => number = Math.random,
): AppSession {
  let current: TokenResponse | null = null;
  /** When the account was last set up, here or in another copy (Unix ms). */
  let setUpAt = -Infinity;
  /** The login under way, which everything that needs a token meanwhile waits for. */
  let pending: Promise<TokenResponse> | null = null;
  /** Logins that failed in a row for want of the server, the last one's error, and when the next may be tried (Unix ms). */
  let failures = 0;
  let failed: unknown = null;
  let retryAt = -Infinity;

  async function login(): Promise<TokenResponse> {
    try {
      const t = await logIn(db, api, clock, now() - setUpAt < JUST_SET_UP_MS);
      failures = 0;
      retryAt = -Infinity;
      return t;
    } catch (err) {
      if (waitAfter(err)) {
        failures++;
        const wait = Math.min(LOGIN_RETRY_MS * 2 ** (failures - 1), LOGIN_RETRY_MAX_MS);
        retryAt = now() + wait * (0.5 + random() / 2);
        failed = err;
      }
      throw err;
    }
  }

  async function token(): Promise<string> {
    // The expiry is the server's time, so it's compared with the server's clock.
    if (!current || current.expires - MARGIN_SECONDS <= clock.seconds()) {
      // Until the wait is over, the last failure again, without a request.
      if (!pending && now() < retryAt) throw failed;
      pending ??= login().finally(() => (pending = null));
      current = await pending;
    }
    return current.token;
  }

  return {
    use(t) {
      current = t;
      setUpAt = now();
      failures = 0;
      retryAt = -Infinity;
    },
    setUp() {
      setUpAt = now();
      // A login may be refused just after a setup and is tried again (JUST_SET_UP_MS): not held back.
      retryAt = -Infinity;
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
