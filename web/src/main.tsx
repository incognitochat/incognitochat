import { render } from 'preact';
import { trackKeyboard } from './a11y/keys';
import { App } from './app';
import { config } from './config';
import { applyLanguage, pickLanguage } from './i18n';
import { createApi } from './net/api';
import { isTelegramLaunch, parseLaunch } from './platform/launch';
import { connectTelegram } from './platform/telegram';
import { applyInsets, applyTheme } from './platform/theme';
import { readTicket, SAVE_PREFIX } from './media/save';
import { SavePage } from './save';
import { createApp } from './state/app';
import { loadLanguageSetting } from './state/language';
import { openDatabase, requestPersistence, StorageError, type Database } from './storage/db';
import { StorageScreen } from './storage-screen';
import { databaseName, profileFor } from './storage/profile';
import { openChannel, useProfile } from './sync/locks';
import './app.css';

// Opened in the device's browser to save an attachment: that page alone, and
// the key is taken out of the address (and with it, the history entry).
const saving = location.hash.startsWith(SAVE_PREFIX) ? readTicket(location.hash) : undefined;
if (saving !== undefined) history.replaceState(null, '', location.pathname + location.search);

// Launch data is read once: a reload can lose the URL fragment.
const launch = parseLaunch(location.hash, location.search);
const telegram = connectTelegram(isTelegramLaunch(launch));
// Telegram's language until the storage, which may hold another choice, is open.
const language = pickLanguage(launch.userLanguage, navigator.language);
applyLanguage(language);
applyTheme(launch.themeParams);

/** How long the storage may wait for another copy of the app before the app says so. */
const BLOCKED_DELAY_MS = 500;

if (telegram) {
  telegram.on('theme_changed', (d) => applyTheme(d.theme_params));
  telegram.on('safe_area_changed', (d) => applyInsets({ safe: d }));
  telegram.on('content_safe_area_changed', (d) => applyInsets({ content: d }));
  telegram.post('web_app_ready');
  telegram.post('web_app_expand');
  telegram.post('web_app_request_theme');
  telegram.post('web_app_request_safe_area');
  telegram.post('web_app_request_content_safe_area');
}

async function main(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) return;
  if (saving !== undefined) {
    render(<SavePage ticket={saving} language={language} />, root);
    return;
  }
  // Each Telegram account on this app gets its own local profile.
  const profile = await profileFor(launch.userId);
  useProfile(profile);
  let db: Database;
  // Another copy holding the storage open: said only if it doesn't let go
  // at once (an older copy closes and reloads on its own, within moments).
  let blocked: ReturnType<typeof setTimeout> | undefined;
  try {
    db = await openDatabase(databaseName(profile), {
      // Shown until the other copy closes; then the app starts over it.
      onBlocked: () => (blocked ??= setTimeout(() => render(<StorageScreen problem="blocked" language={language} />, root), BLOCKED_DELAY_MS)),
    });
  } catch (err) {
    // On this device only, for whoever debugs it: the app sends no logs.
    console.error(err instanceof StorageError ? err.cause : err);
    render(<StorageScreen problem={err instanceof StorageError ? err.kind : 'failed'} language={language} />, root);
    return;
  } finally {
    clearTimeout(blocked);
  }
  void requestPersistence();
  const setting = await loadLanguageSetting(db, [launch.userLanguage, navigator.language]);

  let restart = (): void => {};
  const channel = openChannel((event) => {
    // Another copy changed the account (e.g. finished registering): catch up.
    if (event.type === 'account-changed') restart();
    // Another copy sent or received messages: redraw.
    if (event.type === 'data-changed') void app.refresh();
    // Another copy deleted old keys: forget them here too.
    if (event.type === 'keys-changed') app.keysChanged();
    // Another copy started a sync: syncs asked for before it are answered.
    if (event.type === 'sync-started') app.syncStarted(event.at, event.paced);
  });
  const app = createApp({
    config,
    api: config ? createApi(config.apiUrl) : null,
    db,
    launch,
    bridge: telegram,
    broadcast: (event) => channel?.send(event),
  });
  restart = () => void app.accountChanged();
  // No browser menu on a long press (messages open their own); fields keep theirs.
  document.addEventListener('contextmenu', (e) => {
    if (!(e.target instanceof Element && e.target.closest('input, textarea'))) e.preventDefault();
  });
  // The message box's focus ring is for keyboard users only.
  trackKeyboard();
  render(<App app={app} setting={setting} />, root);
  await app.start();
}

void main();
