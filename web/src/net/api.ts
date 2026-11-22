// The HTTPS API. Requests carry no cookies, no referrer and no cache; every
// response is checked before use, since the server isn't trusted.

import { toHex } from '../crypto/encoding';

/** Error codes the backend returns (backend/internal/api). */
type ErrorCode =
  | 'bad_request'
  | 'unsupported_media_type'
  | 'init_data_rejected'
  | 'signature_rejected'
  | 'invalid_device_list'
  | 'account_exists'
  | 'conflict'
  | 'rate_limited'
  | 'daily_limit'
  | 'link_busy'
  | 'download_limit'
  | 'device_limit'
  | 'login_refused'
  | 'clock_skew'
  | 'account_replaced'
  | 'session_expired'
  | 'invitation_required'
  | 'invalid_link'
  | 'link_limit'
  | 'signing_key_taken'
  | 'no_invitations_left'
  | 'invalid_invitation'
  | 'already_member'
  | 'own_invitation'
  | 'not_member'
  | 'admin_only'
  | 'invalid_envelope'
  | 'mailbox_limit'
  | 'notices_off'
  | 'invalid_token'
  | 'tokens_needed'
  | 'unknown_issuer_key'
  | 'uploads_paused'
  | 'downloads_paused'
  | 'in_progress'
  | 'unavailable'
  | 'account_deleting'
  | 'internal'
  | 'not_found'
  | 'method_not_allowed';

const CODES = new Set<string>([
  'bad_request',
  'unsupported_media_type',
  'init_data_rejected',
  'signature_rejected',
  'invalid_device_list',
  'account_exists',
  'conflict',
  'rate_limited',
  'daily_limit',
  'link_busy',
  'download_limit',
  'device_limit',
  'login_refused',
  'clock_skew',
  'account_replaced',
  'session_expired',
  'invitation_required',
  'invalid_link',
  'link_limit',
  'signing_key_taken',
  'no_invitations_left',
  'invalid_invitation',
  'already_member',
  'own_invitation',
  'not_member',
  'admin_only',
  'invalid_envelope',
  'mailbox_limit',
  'notices_off',
  'invalid_token',
  'tokens_needed',
  'unknown_issuer_key',
  'uploads_paused',
  'downloads_paused',
  'in_progress',
  'unavailable',
  'account_deleting',
  'internal',
  'not_found',
  'method_not_allowed',
]);

/** The server answered with an error. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'unknown',
    /** With clock_skew: the server's clock, in Unix seconds. */
    readonly serverTime?: number,
    /** With tokens_needed: how many send tokens the envelope costs. */
    readonly needed?: number,
    /** How many seconds the server asked to wait (Retry-After), if it said. */
    readonly retryAfter?: number,
  ) {
    super(`API error ${status} ${code}`);
    this.name = 'ApiError';
  }
}

/** The server couldn't be reached, or answered with something unexpected. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 15_000;

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface Api {
  /** Sends a request. body is the exact JSON text, since signatures cover it. */
  request<T>(method: Method, path: string, init: { body?: string; headers?: Record<string, string> }, check: (value: unknown) => T): Promise<T>;
  post<T>(path: string, body: unknown, check: (value: unknown) => T): Promise<T>;
}

export function createApi(baseUrl: string, fetchImpl: Fetch = (input, init) => fetch(input, init)): Api {
  const api: Api = {
    post: (path, body, check) => api.request('POST', path, { body: JSON.stringify(body) }, check),
    async request(method, path, init, check) {
      let response: Response;
      try {
        // Content-Type only with a body: without one (and without a login),
        // a GET is a simple request, which the browser sends with no CORS
        // preflight first (GET /links/{id}, GET /media/{id}).
        const headers: Record<string, string> = { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...init.headers };
        // CloudFront, in front of the API, signs each request to the backend,
        // and the signature must cover the body: its hash travels with it.
        if (init.body !== undefined) headers['X-Amz-Content-Sha256'] = await sha256Hex(init.body);
        response = await fetchImpl(baseUrl + path, {
          method,
          headers,
          ...(init.body === undefined ? {} : { body: init.body }),
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
          mode: 'cors',
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new NetworkError('request failed');
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new NetworkError(`unreadable response (${response.status})`);
      }
      if (!response.ok) {
        const { error: code, now, needed } = value && typeof value === 'object' ? (value as { error?: unknown; now?: unknown; needed?: unknown }) : {};
        const known = typeof code === 'string' && CODES.has(code) ? (code as ErrorCode) : 'unknown';
        // A time outside the window: the server's clock comes with it.
        if (known === 'clock_skew') {
          const serverTime = typeof now === 'number' && Number.isSafeInteger(now) && now > 0 ? now : undefined;
          throw new ApiError(response.status, known, serverTime);
        }
        // Too few send tokens for the envelope: how many it costs.
        if (known === 'tokens_needed') {
          throw new ApiError(response.status, known, undefined, typeof needed === 'number' && Number.isSafeInteger(needed) && needed > 0 ? needed : undefined);
        }
        throw new ApiError(response.status, known, undefined, undefined, retryAfter(response.headers.get('Retry-After')));
      }
      try {
        return check(value);
      } catch {
        throw new NetworkError('unexpected response');
      }
    },
  };
  return api;
}

/** Retry-After in seconds (its other form, a date, the server doesn't send), at most a day. */
function retryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d{1,9}$/.test(value.trim())) return undefined;
  return Math.min(Number(value.trim()), 86_400);
}

async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

/** Accepts any JSON object, for responses whose content doesn't matter. */
export function checkObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
  return value as Record<string, unknown>;
}

/** A session token and when it expires, as /register and /session return. */
export interface TokenResponse {
  account: string;
  token: string;
  /** Unix seconds. */
  expires: number;
}

const ID = /^[A-Za-z0-9_-]{22}$/;

export function checkTokenResponse(value: unknown): TokenResponse {
  if (!value || typeof value !== 'object') throw new Error('not an object');
  const { account, token, expires } = value as Record<string, unknown>;
  if (typeof account !== 'string' || !ID.test(account)) throw new Error('bad account');
  if (typeof token !== 'string' || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length > 512) {
    throw new Error('bad token');
  }
  if (typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires <= 0) throw new Error('bad expiry');
  return { account, token, expires };
}
