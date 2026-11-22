// The save page: opened in the device's own browser to save an attachment
// (media/save.ts). It runs without Telegram and touches no stored data.

import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { config } from './config';
import { clockTime, formatSaveSize, nextUtc, t, type Language } from './i18n';
import { fetchForSaving, Gone, type SaveTicket } from './media/save';
import { ApiError, createApi } from './net/api';
import { httpTransfer } from './net/transfer';

/** paused: the operator has paused downloads for now. limited: the file was downloaded as often as a day allows. */
type State = 'fetching' | 'ready' | 'done' | 'gone' | 'paused' | 'limited' | 'failed' | 'broken';

export function SavePage({ ticket, language }: { ticket: SaveTicket | null; language: Language }) {
  const tr = (key: Parameters<typeof t>[1], values?: Record<string, string | number>) => t(language, key, values);
  const state = useSignal<State>(ticket && config ? 'fetching' : 'broken');
  const file = useSignal<{ file: File; url: string } | null>(null);
  const progress = useSignal(0);
  /** When limited: when the file can be fetched again (Unix ms). */
  const until = useSignal(0);
  const api = config ? createApi(config.apiUrl) : null;

  const load = async () => {
    if (!ticket || !api) return;
    state.value = 'fetching';
    try {
      const f = await fetchForSaving(api, httpTransfer, ticket, (p) => (progress.value = p));
      file.value = { file: f, url: URL.createObjectURL(f) };
      state.value = 'ready';
    } catch (err) {
      if (err instanceof ApiError && err.code === 'download_limit') {
        // As the server said, or else when the UTC day ends.
        until.value = err.retryAfter === undefined ? nextUtc(24 * 60 * 60 * 1000) : Date.now() + err.retryAfter * 1000;
        state.value = 'limited';
        return;
      }
      state.value = err instanceof Gone ? 'gone' : err instanceof ApiError && err.code === 'downloads_paused' ? 'paused' : 'failed';
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const size = ticket ? formatSaveSize(language, ticket.s) : '';
  // Raster images only: fetchForSaving gives no other image type.
  const image = file.value && file.value.file.type.startsWith('image/');
  return (
    <main class="page">
      <h1>{tr('saveTitle')}</h1>
      {ticket && (
        <p class="muted" dir="auto">
          {ticket.n ?? tr('file')} · {size}
        </p>
      )}
      {state.value === 'fetching' && (
        <p role="status">
          {tr('saveFetching')} {Math.round(progress.value * 100)}%
        </p>
      )}
      {state.value === 'ready' && file.value && (
        <>
          {image && <img class="attach-preview" src={file.value.url} alt="" />}
          <a
            class="button primary"
            href={file.value.url}
            download={file.value.file.name}
            onClick={() => {
              setTimeout(() => (state.value = 'done'), 0);
            }}
          >
            {tr('saveButton')}
          </a>
        </>
      )}
      {state.value === 'done' && file.value && (
        <>
          <p class="notice" role="status">
            {tr('saveDone')}
          </p>
          <a class="button secondary" href={file.value.url} download={file.value.file.name}>
            {tr('saveAgain')}
          </a>
        </>
      )}
      {state.value === 'gone' && <p class="notice">{tr('saveGone')}</p>}
      {state.value === 'broken' && <p class="notice">{tr('saveBroken')}</p>}
      {(state.value === 'failed' || state.value === 'paused' || state.value === 'limited') && (
        <>
          <p class="notice" role="alert">
            {state.value === 'limited'
              ? tr('errorDownloadLimit', { time: clockTime(language, until.value) })
              : tr(state.value === 'paused' ? 'errorMediaPaused' : 'errorNetwork')}
          </p>
          <button type="button" class="button secondary" onClick={() => void load()}>
            {tr('tryAgain')}
          </button>
        </>
      )}
    </main>
  );
}
