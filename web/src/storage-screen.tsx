// What shows when the app's storage can't be opened, before anything else
// can start: plain, with no stored data and no network.

import { t, type Language } from './i18n';

/**
 * failed: opening or upgrading failed (often, no space left); newer: a
 * newer version of the app has been used on this device; blocked: another
 * copy of the app, on an older version, still has the storage open.
 */
export type StorageProblem = 'failed' | 'newer' | 'blocked';

const TEXT = { failed: 'storageFailed', newer: 'storageNewer', blocked: 'storageBlocked' } as const;

export function StorageScreen({ problem, language }: { problem: StorageProblem; language: Language }) {
  return (
    <main class="page">
      <p role="alert">{t(language, TEXT[problem])}</p>
      {problem !== 'blocked' && (
        <button type="button" class="button primary" onClick={() => location.reload()}>
          {t(language, problem === 'newer' ? 'reload' : 'tryAgain')}
        </button>
      )}
    </main>
  );
}
