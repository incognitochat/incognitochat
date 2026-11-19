// What the app keeps on this device and fetches by itself (the Data and
// storage screen). Kept in the meta store; defaults until changed.

import { shownAs } from '../protocol/message';
import { getMeta, putMeta, type Database } from '../storage/db';

const NAME = 'media-settings';
const DAY = 24 * 60 * 60 * 1000;
const MiB = 1024 * 1024;

/** How long attachments stay on this device. */
export type KeepMedia = 'forever' | 'month' | 'week';

export interface MediaSettings {
  keep: KeepMedia;
  /** Which received attachments are fetched as soon as their conversation is open. */
  auto: { photos: boolean; voice: boolean; gifs: boolean };
}

export const DEFAULT_MEDIA_SETTINGS: MediaSettings = { keep: 'forever', auto: { photos: true, voice: true, gifs: true } };

/**
 * The largest attachment of each kind fetched without a tap, by the size
 * its message gives; anything larger waits for a tap. (The download stops
 * as soon as the upload turns out bigger than that size says.) Set from
 * what this app sends, with room to spare: a photo is redrawn at most
 * 1280 px as JPEG, which stays under its raw pixels (1280 × 1280 × 3 bytes,
 * 4.7 MiB); a voice message is at most 15 minutes at 48 kbit/s (5.1 MiB)
 * and a video message a minute at about 650 kbit/s (4.6 MiB), twice that
 * for recorders that don't keep to the bitrate asked. A GIF is sent as it
 * is.
 */
const AUTO_LIMITS = { photo: 5 * MiB, voice: 10 * MiB, round: 10 * MiB, gif: 10 * MiB } as const;

/**
 * Whether a received attachment is fetched as soon as its conversation is
 * open: photos, voice and video messages, and GIFs (each as the settings
 * say), up to AUTO_LIMITS. Videos, music and files, and anything shown as
 * a file (an SVG called a photo, say), wait for a tap.
 */
export function fetchesByItself(media: { t: string; s: number; m?: string | undefined }, auto: MediaSettings['auto']): boolean {
  const kind = shownAs(media);
  const on = { photo: auto.photos, voice: auto.voice, round: auto.voice, gif: auto.gifs }[kind as keyof typeof AUTO_LIMITS] ?? false;
  return on && media.s <= AUTO_LIMITS[kind as keyof typeof AUTO_LIMITS];
}

const KEEP_DAYS: Record<KeepMedia, number | null> = { forever: null, month: 30, week: 7 };

export async function getMediaSettings(db: Database): Promise<MediaSettings> {
  const stored = await getMeta<Partial<MediaSettings>>(db, NAME);
  const keep = stored?.keep && stored.keep in KEEP_DAYS ? stored.keep : DEFAULT_MEDIA_SETTINGS.keep;
  return { keep, auto: { ...DEFAULT_MEDIA_SETTINGS.auto, ...stored?.auto } };
}

export async function putMediaSettings(db: Database, settings: MediaSettings): Promise<void> {
  await putMeta(db, NAME, settings);
}

/** The time before which attachments are cleared from this device, or null to keep them. */
export function keepCutoff(keep: KeepMedia, now: number): number | null {
  const days = KEEP_DAYS[keep];
  return days === null ? null : now - days * DAY;
}
