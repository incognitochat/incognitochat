// One local profile per Telegram account.
//
// Storage belongs to the web origin, not to a Mini App: whatever opens this
// page on its origin (this bot, or any bot's web_app button) finds the same
// storage, shared by all the Telegram accounts logged in to that Telegram
// app (Telegram Desktop, the mobile apps and Telegram Web all allow
// several). Without profiles, a second account on the same app would open
// the first account's keys, links and conversations.
//
// So each Telegram account gets its own database, locks and channel, named
// after a hash of its user ID. The hash only keeps the ID out of plain
// sight: user IDs are few enough to try them all, so whoever can read the
// storage can tell which Telegram account a profile is for, and the
// database's name stays after the account is deleted. The ID is never sent
// anywhere. Outside Telegram there is one default profile.

import { toBase64Url, utf8 } from '../crypto/encoding';
import { DB_NAME } from './db';

const LABEL = 'incognitochat/v2/local-profile:';

/** The profile for a Telegram user ID ('' for the default profile). */
export async function profileFor(userId: string): Promise<string> {
  if (!userId) return '';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(LABEL + userId)));
  return toBase64Url(digest.slice(0, 12));
}

/** The database name of a profile. */
export function databaseName(profile: string): string {
  return profile ? `${DB_NAME}-${profile}` : DB_NAME;
}
