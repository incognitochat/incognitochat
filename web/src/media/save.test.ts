import { describe, expect, it } from 'vitest';
import { encryptFile, newFileKey } from '../crypto/media';
import { fromBase64Url, toBase64Url } from '../crypto/encoding';
import { ApiError, type Api } from '../net/api';
import { MAX_FILE_BYTES, type Media } from '../protocol/message';
import { fetchForSaving, Gone, readTicket, saveUrl, SAVE_PREFIX } from './save';

const key = newFileKey();
const media: Media = {
  t: 'file',
  id: 'AAAAAAAAAAAAAAAAAAAAAA',
  k: toBase64Url(key),
  d: 'BBBBBBBBBBBBBBBBBBBBBA',
  s: 5,
  n: 'notes ✓.txt',
  m: 'text/plain',
};

describe('save tickets', () => {
  it('carry what the save page needs, after the # only', () => {
    const url = saveUrl('https://example.github.io/', media);
    expect(url.startsWith(`https://example.github.io/${SAVE_PREFIX}`)).toBe(true);
    const ticket = readTicket(new URL(url).hash);
    expect(ticket).toEqual({ id: media.id, k: media.k, s: 5, n: 'notes ✓.txt', m: 'text/plain' });
  });

  it('refuse broken ones', () => {
    expect(readTicket('#save=nonsense')).toBeNull();
    expect(readTicket('#other')).toBeNull();
    // No bigger than a message allows, since the page reads that much.
    expect(readTicket(new URL(saveUrl('https://x/', { ...media, s: MAX_FILE_BYTES })).hash)).not.toBeNull();
    expect(readTicket(new URL(saveUrl('https://x/', { ...media, s: MAX_FILE_BYTES + 1 })).hash)).toBeNull();
    expect(readTicket(new URL(saveUrl('https://x/', { ...media, s: Number.MAX_SAFE_INTEGER })).hash)).toBeNull();
    const bad = saveUrl('https://x/', { ...media, k: 'AAAA' });
    expect(readTicket(new URL(bad).hash)).toBeNull();
  });

  it('clean the name anyone can put in one, and cap it at 255', () => {
    const ticket = (n: unknown) => `#save=${toBase64Url(new TextEncoder().encode(JSON.stringify({ id: media.id, k: media.k, s: 5, n })))}`;
    expect(readTicket(ticket('photo_\u202Egpj.exe'))?.n).toBe('photo_gpj.exe');
    expect(readTicket(ticket('../a/b\nc.txt'))?.n).toBe('.._a_b c.txt');
    expect(readTicket(ticket('x'.repeat(10_000) + '.exe'))?.n).toBe('x'.repeat(255));
    expect(readTicket(ticket('😀'.repeat(200)))?.n).toBe('😀'.repeat(127));
    // Nothing left: no name, so the page says "file".
    expect(readTicket(ticket('\u202E\uFEFF'))).toEqual({ id: media.id, k: media.k, s: 5 });
    expect(readTicket(ticket(42))).toBeNull();
    // What the app makes is unchanged.
    expect(readTicket(new URL(saveUrl('https://x/', { ...media, n: 'نامه\u200Cها 👨\u200D👩\u200D👧.pdf' })).hash)?.n).toBe('نامه\u200Cها 👨\u200D👩\u200D👧.pdf');
    // And the app's link is clean already.
    expect(readTicket(new URL(saveUrl('https://x/', { ...media, n: 'a\u202Eb/c' })).hash)?.n).toBe('ab_c');
  });

  it('carries no delete secret, and still reads older links that did', () => {
    const url = saveUrl('https://x/', media);
    expect(new TextDecoder().decode(fromBase64Url(new URL(url).hash.slice(SAVE_PREFIX.length)))).not.toContain(media.d);
    const old = `#save=${toBase64Url(new TextEncoder().encode(JSON.stringify({ id: media.id, k: media.k, d: media.d, s: 5 })))}`;
    expect(readTicket(old)).toEqual({ id: media.id, k: media.k, s: 5 });
  });

  it('fetches and decrypts the upload, and leaves it on the server; a gone upload says so', async () => {
    const upload = await encryptFile(new TextEncoder().encode('hello'), key);
    const calls: string[] = [];
    const api: Api = {
      post: (path, body, check) => api.request('POST', path, { body: JSON.stringify(body) }, check),
      async request(method, path, _init, check) {
        calls.push(`${method} ${path}`);
        if (path === `/media/${media.id}`) return check({ url: 'https://bucket.example/m/x' });
        throw new ApiError(404, 'not_found');
      },
    };
    const transfer = { put: async () => {}, get: async () => upload };
    const ticket = readTicket(new URL(saveUrl('https://x/', media)).hash)!;
    const file = await fetchForSaving(api, transfer, ticket);
    expect(file.name).toBe('notes ✓.txt');
    // Only images, audio and video keep the sender's type.
    expect(file.type).toBe('application/octet-stream');
    expect(new TextDecoder().decode(await file.arrayBuffer())).toBe('hello');
    expect(calls).toEqual([`GET /media/${media.id}`]);
    await expect(fetchForSaving(api, transfer, { ...ticket, id: 'CCCCCCCCCCCCCCCCCCCCCA' })).rejects.toBeInstanceOf(Gone);
  });

  it("passes on a refusal for the day's downloads, with until when, for the page to say", async () => {
    const limited = new ApiError(429, 'download_limit', undefined, undefined, 7200);
    const api: Api = {
      post: (path, body, check) => api.request('POST', path, { body: JSON.stringify(body) }, check),
      async request() {
        throw limited;
      },
    };
    const transfer = { put: async () => {}, get: async () => new Uint8Array() };
    const ticket = readTicket(new URL(saveUrl('https://x/', media)).hash)!;
    await expect(fetchForSaving(api, transfer, ticket)).rejects.toMatchObject({ code: 'download_limit', retryAfter: 7200 });
  });

  it("never hands the browser an active type the sender claims: it's plain bytes", async () => {
    const upload = await encryptFile(new TextEncoder().encode('hello'), key);
    const api: Api = {
      post: (path, body, check) => api.request('POST', path, { body: JSON.stringify(body) }, check),
      request: async (_method, _path, _init, check) => check({ url: 'https://bucket.example/m/x' }),
    };
    const transfer = { put: async () => {}, get: async () => upload };
    const typeOf = async (m: string) => (await fetchForSaving(api, transfer, { id: media.id, k: media.k, s: 5, m })).type;
    expect(await typeOf('image/svg+xml')).toBe('application/octet-stream');
    expect(await typeOf('text/html')).toBe('application/octet-stream');
    expect(await typeOf('application/xhtml+xml')).toBe('application/octet-stream');
    expect(await typeOf('image/jpeg')).toBe('image/jpeg');
    expect(await typeOf('video/mp4')).toBe('video/mp4');
    expect(await typeOf('audio/ogg')).toBe('audio/ogg');
  });
});
