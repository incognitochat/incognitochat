import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openDatabase, putMeta } from '../storage/db';
import { DEFAULT_MEDIA_SETTINGS, fetchesByItself, getMediaSettings, keepCutoff, putMediaSettings } from './settings';

describe('media settings', () => {
  it('starts with keeping everything and fetching photos, voice and GIFs', async () => {
    const db = await openDatabase(`settings-${crypto.randomUUID()}`);
    expect(await getMediaSettings(db)).toEqual(DEFAULT_MEDIA_SETTINGS);
  });

  it('keeps what was saved, and fills in what an older version left out', async () => {
    const db = await openDatabase(`settings-${crypto.randomUUID()}`);
    await putMediaSettings(db, { keep: 'week', auto: { photos: false, voice: true, gifs: false } });
    expect(await getMediaSettings(db)).toEqual({ keep: 'week', auto: { photos: false, voice: true, gifs: false } });
    await putMeta(db, 'media-settings', { keep: 'nonsense', auto: { photos: false } });
    expect(await getMediaSettings(db)).toEqual({ keep: 'forever', auto: { photos: false, voice: true, gifs: true } });
  });

  it('fetches photos, voice and video messages and GIFs by themselves only up to a size for each kind', () => {
    const MiB = 1024 * 1024;
    const on = DEFAULT_MEDIA_SETTINGS.auto;
    const photo = { t: 'photo', m: 'image/jpeg' };
    expect(fetchesByItself({ ...photo, s: 5 * MiB }, on)).toBe(true);
    expect(fetchesByItself({ ...photo, s: 5 * MiB + 1 }, on)).toBe(false);
    for (const t of ['voice', 'round']) {
      expect(fetchesByItself({ t, s: 10 * MiB, m: 'audio/mp4' }, on)).toBe(true);
      expect(fetchesByItself({ t, s: 10 * MiB + 1, m: 'audio/mp4' }, on)).toBe(false);
    }
    expect(fetchesByItself({ t: 'gif', s: 10 * MiB, m: 'image/gif' }, on)).toBe(true);
    expect(fetchesByItself({ t: 'gif', s: 10 * MiB + 1, m: 'image/gif' }, on)).toBe(false);
    // Videos, music and files wait for a tap, however small.
    for (const t of ['video', 'audio', 'file', 'voice_note']) expect(fetchesByItself({ t, s: 1000 }, on)).toBe(false);
    // So does anything shown as a file: an SVG called a photo.
    expect(fetchesByItself({ t: 'photo', s: 1000, m: 'image/svg+xml' }, on)).toBe(false);
    // Each kind as the settings say.
    expect(fetchesByItself({ ...photo, s: 1000 }, { ...on, photos: false })).toBe(false);
    expect(fetchesByItself({ t: 'round', s: 1000, m: 'video/mp4' }, { ...on, voice: false })).toBe(false);
    expect(fetchesByItself({ t: 'gif', s: 1000, m: 'image/gif' }, { ...on, gifs: false })).toBe(false);
  });

  it('turns "keep media" into a cutoff time', () => {
    const now = Date.UTC(2026, 10, 14);
    expect(keepCutoff('forever', now)).toBeNull();
    expect(keepCutoff('week', now)).toBe(now - 7 * 24 * 3600 * 1000);
    expect(keepCutoff('month', now)).toBe(now - 30 * 24 * 3600 * 1000);
  });
});
