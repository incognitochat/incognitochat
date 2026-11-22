/**
 * Where the running build's source code is, for the "Source code" link
 * (AGPL-3.0, section 13): the repository and commit its manifest names. The
 * hosting workflow writes manifest.json next to the app and signs it with
 * everything else (docs/verifying.md), so the link names the exact code
 * that's running; a copy of the app run by anyone else names its own. A
 * build served without a manifest (local development) has no link to give.
 *
 * Only a GitHub repository name and a full commit are taken from it, so a
 * manifest can't send anyone anywhere but a source tree on GitHub.
 */

const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** The source tree a manifest names, or null if it doesn't name one. */
export function sourceUrl(manifest: unknown): string | null {
  if (!manifest || typeof manifest !== 'object') return null;
  const { repository, commit } = manifest as Record<string, unknown>;
  if (typeof repository !== 'string' || !REPOSITORY.test(repository)) return null;
  const name = repository.split('/')[1]!;
  if (name === '.' || name === '..') return null;
  if (typeof commit !== 'string' || !COMMIT.test(commit)) return null;
  return `https://github.com/${repository}/tree/${commit}`;
}

/**
 * Reads the manifest served next to the app at base (its URL without query
 * or fragment), and returns the source tree it names, or null.
 */
export async function findSourceUrl(base: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetcher(new URL('manifest.json', base).href, { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) return null;
    return sourceUrl(await response.json());
  } catch {
    return null;
  }
}
