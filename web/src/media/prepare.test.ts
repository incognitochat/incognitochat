import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toBase64Url } from '../crypto/encoding';
import { preparePhoto } from './prepare';

// Tests run without a browser: the decoder (createImageBitmap) and the
// canvas are stand-ins. The canvas "encodes" a JPEG made only of what was
// drawn on it, so the file's own bytes can reach the output only if
// preparePhoto passed them on.

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

let canvases: FakeCanvas[];
let failNext: boolean;

function bitmap(width: number, height: number) {
  return { width, height, close: vi.fn() };
}

beforeEach(() => {
  canvases = [];
  failNext = false;
  vi.stubGlobal('HTMLVideoElement', class {});
  vi.stubGlobal('document', {
    createElement(tag: string) {
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
