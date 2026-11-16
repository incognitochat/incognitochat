import { describe, expect, it } from 'vitest';
import { ApiError, checkTokenResponse, createApi, NetworkError, type Fetch } from './api';

const ok = { account: 'AAAAAAAAAAAAAAAAAAAAAA', token: 'v1.abc.def', expires: 1_800_000_900 };

function fake(status: number, body: string, seen: { url?: string; init?: RequestInit } = {}): Fetch {
  return async (url, init) => {
    seen.url = url;
    seen.init = init;
    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  };
}

describe('api', () => {
  it('posts JSON without cookies or referrer and checks the answer', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const api = createApi('https://api.example', fake(200, JSON.stringify(ok), seen));
    expect(await api.post('/session', { a: 1 }, checkTokenResponse)).toEqual(ok);
    expect(seen.url).toBe('https://api.example/session');
    expect(seen.init).toMatchObject({
      method: 'POST',
      body: '{"a":1}',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      redirect: 'error',
    });
    // The body's SHA-256, which CloudFront's signature to the backend covers.
    expect((seen.init?.headers as Record<string, string>)['X-Amz-Content-Sha256']).toBe(
      '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
    );
    // A request without a body carries no hash.
    await api.request('GET', '/account', {}, checkTokenResponse);
    expect(Object.keys(seen.init?.headers as Record<string, string>)).not.toContain('X-Amz-Content-Sha256');
    expect(new Headers(seen.init!.headers).get('content-type')).toBe('application/json');
  });

  it('turns error responses into ApiError with a known code', async () => {
    const api = createApi('https://api.example', fake(410, '{"error":"account_replaced"}'));
    const err = await api.post('/session', {}, checkTokenResponse).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 410, code: 'account_replaced' });

    const odd = createApi('https://api.example', fake(400, '{"error":"<script>"}'));
    expect(await odd.post('/x', {}, checkTokenResponse).catch((e: unknown) => e)).toMatchObject({ code: 'unknown' });
  });

  it("reads the server's clock from a clock_skew answer, and nothing odd", async () => {
    const skew = createApi('https://api.example', fake(401, '{"error":"clock_skew","now":1800000000}'));
    expect(await skew.post('/session', {}, checkTokenResponse).catch((e: unknown) => e)).toMatchObject({
      status: 401,
      code: 'clock_skew',
      serverTime: 1_800_000_000,
    });
    for (const now of ['"1800000000"', '-5', '1.5', '1e300', 'null']) {
      const odd = createApi('https://api.example', fake(401, `{"error":"clock_skew","now":${now}}`));
      const err = (await odd.post('/session', {}, checkTokenResponse).catch((e: unknown) => e)) as ApiError;
      expect(err.code).toBe('clock_skew');
      expect(err.serverTime).toBeUndefined();
    }
    // Only with clock_skew.
    const other = createApi('https://api.example', fake(401, '{"error":"login_refused","now":1800000000}'));
    expect(((await other.post('/session', {}, checkTokenResponse).catch((e: unknown) => e)) as ApiError).serverTime).toBeUndefined();
  });

  it('reports unreachable servers and unexpected bodies as NetworkError', async () => {
    const down = createApi('https://api.example', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(down.post('/x', {}, checkTokenResponse)).rejects.toBeInstanceOf(NetworkError);
    const html = createApi('https://api.example', fake(502, '<html>'));
    await expect(html.post('/x', {}, checkTokenResponse)).rejects.toBeInstanceOf(NetworkError);
    const wrong = createApi('https://api.example', fake(200, '{"account":"x"}'));
    await expect(wrong.post('/x', {}, checkTokenResponse)).rejects.toBeInstanceOf(NetworkError);
  });

  it('checks token responses strictly', () => {
    expect(() => checkTokenResponse({ ...ok, account: 'short' })).toThrow();
    expect(() => checkTokenResponse({ ...ok, token: 'v2.abc.def' })).toThrow();
    expect(() => checkTokenResponse({ ...ok, expires: '1' })).toThrow();
    expect(() => checkTokenResponse(null)).toThrow();
  });
});
