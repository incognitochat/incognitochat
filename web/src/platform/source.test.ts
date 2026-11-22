import { describe, expect, it, vi } from 'vitest';
import { findSourceUrl, sourceUrl } from './source';

const commit = '41ee5804e4fcf04c74d650cc44541da131336d60';

describe('sourceUrl', () => {
  it('names the source tree of the build: its repository at its commit', () => {
    expect(sourceUrl({ repository: 'example/app', ref: 'v2.7.0', commit })).toBe(`https://github.com/example/app/tree/${commit}`);
    expect(sourceUrl({ repository: 'Some-Org/app.github.io', commit })).toBe(`https://github.com/Some-Org/app.github.io/tree/${commit}`);
  });

  it("takes nothing that isn't a GitHub repository name and a full commit", () => {
    for (const manifest of [
      null,
      'x',
      {},
      { repository: 'example/app' },
      { commit },
      { repository: 'example', commit },
      { repository: 'example/app/extra', commit },
      { repository: 'evil.example/app', commit },
      { repository: '../app', commit },
      { repository: 'example/..', commit },
      { repository: 'example/.', commit },
      { repository: 'https://evil.example', commit },
      { repository: 'example/app?x=1', commit },
      { repository: 'example/app', commit: 'main' },
      { repository: 'example/app', commit: commit.slice(0, 12) },
      { repository: 'example/app', commit: commit.toUpperCase() },
      { repository: 'example/app', commit: `${commit}/../../evil` },
      { repository: 1, commit },
    ]) {
      expect(sourceUrl(manifest), JSON.stringify(manifest)).toBeNull();
    }
  });
});

describe('findSourceUrl', () => {
  const answer = (status: number, body: string): typeof fetch =>
    async () => new Response(body, { status, headers: { 'content-type': 'application/json' } });

  it('gives up on the manifest after 10 seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      await findSourceUrl('https://example.github.io/', async () => new Response('{}'));
      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it('reads the manifest next to the app, uncached and without credentials', async () => {
    const asked: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      asked.push({ url: String(input), init });
      return new Response(JSON.stringify({ repository: 'example/app', commit }));
    };
    expect(await findSourceUrl('https://example.github.io/', fetcher)).toBe(`https://github.com/example/app/tree/${commit}`);
    expect(asked).toEqual([
      { url: 'https://example.github.io/manifest.json', init: { cache: 'no-store', credentials: 'omit', signal: expect.any(AbortSignal) } },
    ]);
  });

  it('reads it beside the app when the app is served from a path', async () => {
    const asked: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      asked.push(String(input));
      return new Response('{}');
    };
    await findSourceUrl('https://example.github.io/app/', fetcher);
    await findSourceUrl('https://example.github.io/app/index.html', fetcher);
    expect(asked).toEqual(['https://example.github.io/app/manifest.json', 'https://example.github.io/app/manifest.json']);
  });

  it('has nothing to give without a good manifest', async () => {
    expect(await findSourceUrl('https://example.github.io/', answer(404, 'not found'))).toBeNull();
    // An error page is never read as a manifest, whatever it holds.
    const manifest = JSON.stringify({ repository: 'example/app', commit });
    expect(await findSourceUrl('https://example.github.io/', answer(404, manifest))).toBeNull();
    expect(await findSourceUrl('https://example.github.io/', answer(500, manifest))).toBeNull();
    expect(await findSourceUrl('https://example.github.io/', answer(200, 'not json'))).toBeNull();
    expect(await findSourceUrl('https://example.github.io/', answer(200, '{"repository":"evil.example/x","commit":"1"}'))).toBeNull();
    const offline: typeof fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    expect(await findSourceUrl('https://example.github.io/', offline)).toBeNull();
  });
});
