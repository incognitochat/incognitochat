import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { concat, toBase64Url } from '../crypto/encoding';
import { neutralName, prepareAudio, prepareFile, prepareGif, preparePhoto, prepareVideo } from './prepare';

// Tests run without a browser: the decoder (createImageBitmap), the canvas
// and the video and audio elements are stand-ins. The canvas "encodes" a
// JPEG made only of what was drawn on it, so the file's own bytes can reach
// the output only if preparePhoto passed them on.

const encoder = new TextEncoder();

/** A photo as a camera writes it: JPEG with EXIF metadata naming a place. */
const EXIF = encoder.encode('Exif\0\0GPS 12.3456 N 65.4321 E; camera: example');
const original = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, EXIF.length + 2, ...EXIF, 0xff, 0xd9]);

interface Encoded {
  type: string;
  quality: number;
}

class FakeCanvas {
  width = 0;
  height = 0;
  /** What was done on the canvas, in order. */
  ops: string[] = [];
  /** What drawImage was given. */
  sources: unknown[] = [];
  encoded: Encoded[] = [];
  /** Encoding fails (toBlob gives null). */
  fails = false;

  getContext(kind: string) {
    if (kind !== '2d') return null;
    const canvas = this;
    return {
      fillStyle: '',
      fillRect(x: number, y: number, w: number, h: number) {
        canvas.ops.push(`fill ${this.fillStyle} ${x},${y} ${w}x${h}`);
      },
      drawImage(source: unknown, x: number, y: number, w: number, h: number) {
        canvas.sources.push(source);
        canvas.ops.push(`draw ${x},${y} ${w}x${h}`);
      },
    };
  }

  /** The JPEG this canvas encodes to: a marker, its size and what was done on it. */
  jpeg(): Uint8Array<ArrayBuffer> {
    return new Uint8Array([0xff, 0xd8, ...encoder.encode(`redrawn ${this.width}x${this.height}: ${this.ops.join('; ')}`), 0xff, 0xd9]);
  }

  toBlob(done: (blob: Blob | null) => void, type: string, quality: number) {
    this.encoded.push({ type, quality });
    done(this.fails ? null : new Blob([this.jpeg()], { type }));
  }
}

/**
 * A stand-in <video> or <audio>: given a source, it opens at once (or fails
 * to, as for a format the browser can't play), and it seeks at once.
 */
class FakeMedia extends EventTarget {
  videoWidth = 1920;
  videoHeight = 1080;
  duration = 3.4;
  readyState = 4;
  muted = false;
  playsInline = false;
  preload = '';
  #src = '';

  constructor(readonly opens: boolean) {
    super();
  }

  get src() {
    return this.#src;
  }

  set src(url: string) {
    this.#src = url;
    queueMicrotask(() => this.dispatchEvent(new Event(this.opens ? 'loadedmetadata' : 'error')));
  }

  get currentTime() {
    return 0;
  }

  set currentTime(_seconds: number) {
    queueMicrotask(() => this.dispatchEvent(new Event('seeked')));
  }

  removeAttribute() {}
  load() {}
  async play() {}
  pause() {}
}

let canvases: FakeCanvas[];
let failNext: boolean;
/** Whether the video and audio elements open what they're given. */
let mediaOpens: boolean;

function bitmap(width: number, height: number) {
  return { width, height, close: vi.fn() };
}

beforeEach(() => {
  canvases = [];
  failNext = false;
  mediaOpens = true;
  vi.stubGlobal('HTMLVideoElement', FakeMedia);
  vi.stubGlobal('document', {
    createElement(tag: string) {
      if (tag === 'video' || tag === 'audio') return new FakeMedia(mediaOpens);
      if (tag !== 'canvas') throw new Error(`created a ${tag}`);
      const canvas = new FakeCanvas();
      canvas.fails = failNext;
      canvases.push(canvas);
      return canvas;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

describe('preparePhoto', () => {
  it('sends the photo redrawn as JPEG at up to 1280 px, never the original bytes', async () => {
    const image = bitmap(4000, 3000);
    const decode = vi.fn(async (_file: Blob, _options?: ImageBitmapOptions) => image);
    vi.stubGlobal('createImageBitmap', decode);
    const file = new Blob([original], { type: 'image/jpeg' });

    const out = await preparePhoto(file);

    // Decoded upright (EXIF orientation applied), then dropped.
    expect(decode).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' });
    expect(image.close).toHaveBeenCalledOnce();

    // The photo: the decoded image drawn on white at 1280 x 960, as JPEG.
    const [full, tiny] = canvases;
    expect(canvases).toHaveLength(2);
    expect(full!.sources).toEqual([image]);
    expect(full!.ops).toEqual(['fill #ffffff 0,0 1280x960', 'draw 0,0 1280x960']);
    expect(full!.encoded).toEqual([{ type: 'image/jpeg', quality: 0.85 }]);
    expect(out.file).toEqual(full!.jpeg());

    // Nothing of the file itself: not its bytes, not its metadata.
    expect(out.file).not.toEqual(original);
    expect(contains(out.file, EXIF)).toBe(false);
    expect(contains(out.file, encoder.encode('GPS'))).toBe(false);

    // The preview is drawn from the redrawn photo, not from the file.
    expect(tiny!.sources).toEqual([full]);
    expect(tiny!.ops).toEqual(['fill #ffffff 0,0 40x30', 'draw 0,0 40x30']);
    expect(tiny!.encoded).toEqual([{ type: 'image/jpeg', quality: 0.5 }]);
    expect(out.media).toEqual({ t: 'photo', s: out.file.length, m: 'image/jpeg', w: 1280, h: 960, p: toBase64Url(tiny!.jpeg()) });
  });

  it('redraws a small photo too, without enlarging it', async () => {
    const image = bitmap(300, 500);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => image));

    const out = await preparePhoto(new Blob([original], { type: 'image/png' }));

    expect(canvases[0]!.ops).toEqual(['fill #ffffff 0,0 300x500', 'draw 0,0 300x500']);
    expect(out.file).toEqual(canvases[0]!.jpeg());
    expect(contains(out.file, EXIF)).toBe(false);
    expect(out.media).toMatchObject({ t: 'photo', m: 'image/jpeg', w: 300, h: 500 });
  });

  it('sends nothing if the photo cannot be redrawn, and still lets go of the image', async () => {
    const image = bitmap(4000, 3000);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => image));
    failNext = true;

    await expect(preparePhoto(new Blob([original], { type: 'image/jpeg' }))).rejects.toThrow('encode');
    expect(image.close).toHaveBeenCalledOnce();
  });
});

describe('names', () => {
  const types = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);
  /** As phones name what they take: the moment (to the millisecond), or a counter that grows with each photo. */
  const named = (name: string, type: string, bytes: Uint8Array<ArrayBuffer> = original) => new File([bytes], name, { type });
  function box(type: string, ...children: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const body = concat(...children);
    const out = new Uint8Array(8 + body.length);
    new DataView(out.buffer).setUint32(0, out.length);
    out.set(encoder.encode(type), 4);
    out.set(body, 8);
    return out;
  }
  /** An iPhone's movie, as far as it matters here: its video track's handler names the phone's media framework. */
  const movie = concat(
    box('ftyp', encoder.encode('qt  ')),
    box('moov', box('trak', box('mdia', box('hdlr', new Uint8Array(8), encoder.encode('vide'), new Uint8Array(12), encoder.encode('Core Media Video'))))),
    box('mdat', encoder.encode('frames')),
  );

  it('sends photos, videos and GIFs without their own names', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap(4000, 3000)));
    const photo = await preparePhoto(named('PXL_20261119_103512123.jpg', 'image/jpeg'));
    const gif = await prepareGif(named('Screenshot_20261119-103512_Chrome.gif', 'image/gif'));
    const video = await prepareVideo(named('IMG_4821.MOV', 'video/quicktime', movie));
    for (const out of [photo, gif, video]) expect(out.media.n).toBeUndefined();
    expect(photo.media.t).toBe('photo');
    expect(gif.media.t).toBe('gif');
    expect(video.media).toMatchObject({ t: 'video', s: movie.length, m: 'video/quicktime', w: 1920, h: 1080, l: 3 });
    // Nor the name of the phone's media framework, inside the video.
    expect(types(video.file)).not.toContain('Core Media');
    expect(types(video.file)).toContain('frames');
  });

  it('sends a video it can not open as a file named only for what it is', async () => {
    mediaOpens = false;
    const out = await prepareVideo(named('IMG_4821.MOV', 'video/quicktime', movie));
    expect(out.media).toEqual({ t: 'file', s: movie.length, n: 'video.mov', m: 'video/quicktime' });
    // As a file: untouched.
    expect(out.file).toEqual(movie);
  });

  it('keeps the names of files and music, which the sender chose or sees', async () => {
    expect((await prepareFile(named('IMG_4821.JPG', 'image/jpeg'))).media).toMatchObject({ t: 'file', n: 'IMG_4821.JPG' });
    expect((await prepareAudio(named('Song of the day.mp3', 'audio/mpeg'))).media).toMatchObject({ t: 'audio', n: 'Song of the day.mp3', l: 3 });
    // Music this browser can't play goes as a file, under its name too.
    mediaOpens = false;
    expect((await prepareAudio(named('Song of the day.flac', 'audio/flac'))).media).toMatchObject({ t: 'file', n: 'Song of the day.flac' });
  });
});

describe('neutralName', () => {
  it('names a photo or video by its kind, keeping only the extension', () => {
    const name = (name: string, type: string) => neutralName(new File([], name, { type }));
    expect(name('IMG_4821.MOV', 'video/quicktime')).toBe('video.mov');
    expect(name('PXL_20261119_103512123.heic', 'image/heic')).toBe('photo.heic');
    expect(name('VID_20261119_103512.3gp', 'video/3gpp')).toBe('video.3gp');
    expect(name('Screenshot 2026-11-19 at 10.35.12', 'image/png')).toBe('photo');
    expect(name('IMG_4821', '')).toBe('file');
    expect(name('scan.tiff', 'image/tiff')).toBe('photo.tiff');
  });
});
