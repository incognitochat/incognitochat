import { afterEach, describe, expect, it, vi } from 'vitest';
import { concat } from '../crypto/encoding';
import { canRecord, centreSquare, hasCamera, levelsOf, pickType, startRecording, waveform, WAVEFORM_BARS } from './record';

describe('pickType', () => {
  it('prefers AAC in MP4, so iPhone and Android play each other', () => {
    expect(pickType(() => true)).toBe('audio/mp4;codecs=mp4a.40.2');
  });

  it('falls back to Opus, then to the default', () => {
    expect(pickType((t) => t.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus');
    expect(pickType((t) => t === 'audio/ogg;codecs=opus')).toBe('audio/ogg;codecs=opus');
    expect(pickType(() => false)).toBe('');
  });

  it('prefers H.264 and AAC in MP4 for video messages, then WebM', () => {
    const video = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
    expect(pickType(() => true, video)).toBe('video/mp4;codecs=avc1.42E01E,mp4a.40.2');
    expect(pickType((t) => t.startsWith('video/webm'), video)).toBe('video/webm;codecs=vp9,opus');
  });
});

describe('levelsOf', () => {
  it('measures each stretch of a decoded recording', () => {
    const samples = new Float32Array([0, 0, 0.1, -0.1, 0.5, -0.5, 0]);
    const levels = levelsOf(samples, 2);
    expect(levels.length).toBe(4);
    expect(levels[0]).toBe(0);
    expect(levels[1]).toBeCloseTo(0.4);
    expect(levels[2]).toBe(1);
    expect(levels[3]).toBe(0);
  });
});

describe('centreSquare', () => {
  it('crops the middle of a landscape or portrait picture', () => {
    expect(centreSquare(640, 480)).toEqual({ x: 80, y: 0, side: 480 });
    expect(centreSquare(720, 1280)).toEqual({ x: 0, y: 280, side: 720 });
    expect(centreSquare(500, 500)).toEqual({ x: 0, y: 0, side: 500 });
  });
});

describe('waveform', () => {
  it('scales the loudest bar to 255', () => {
    const bars = waveform([0.1, 0.2, 0.4, 0.2], 4);
    expect([...bars]).toEqual([64, 128, 255, 128]);
  });

  it('keeps the peak of each stretch when shrinking, and repeats when stretching', () => {
    expect([...waveform([0, 1, 0, 0, 0.5, 0], 2)]).toEqual([255, 128]);
    expect([...waveform([0.5, 1], 4)]).toEqual([128, 128, 255, 255]);
  });

  it('is flat for silence or nothing', () => {
    expect(waveform([], WAVEFORM_BARS).every((b) => b === 0)).toBe(true);
    expect(waveform([0, 0, 0]).length).toBe(WAVEFORM_BARS);
  });
});

describe('startRecording', () => {
  const text = (s: string) => new TextEncoder().encode(s);
  const types = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);
  function box(type: string, ...children: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const body = concat(...children);
    const out = new Uint8Array(8 + body.length);
    new DataView(out.buffer).setUint32(0, out.length);
    out.set(text(type), 4);
    out.set(body, 8);
    return out;
  }
  /** A header (version 0) with the device's clock in its times (0xAA here), then its timescale and duration. */
  const header = (type: string) => box(type, new Uint8Array(4), new Uint8Array(8).fill(0xaa), new Uint8Array([0, 0, 0x03, 0xe8, 0, 0, 0x07, 0xd0]));
  /** A voice message as a browser records it in MP4. */
  const mp4 = concat(
    box('ftyp', text('isom')),
    box('moov', header('mvhd'), box('trak', header('tkhd'), box('mdia', header('mdhd'), box('hdlr', new Uint8Array(8), text('soun'), new Uint8Array(12), text('SoundHandler\0'))))),
    box('mdat', text('sound')),
  );
  /** And in WebM, which names its muxer. */
  const webm = concat(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f]), text('webm MuxingApp Chrome WritingApp Chrome'), new Uint8Array(8).fill(0xaa));

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Records two seconds with stand-ins for the microphone and for a MediaRecorder that writes `bytes` as `type`. */
  async function record(type: string, bytes: Uint8Array<ArrayBuffer>) {
    class FakeRecorder {
      static isTypeSupported = (t: string) => t === type;
      state = 'inactive';
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: ((e: Event) => void) | null = null;
      onerror: (() => void) | null = null;
      mimeType: string;
      constructor(_stream: unknown, options: { mimeType?: string }) {
        this.mimeType = options.mimeType ?? '';
      }
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob([bytes]) });
        this.onstop?.(new Event('stop'));
      }
    }
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [], getVideoTracks: () => [] }) } });
    vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {} });
    const recorder = await startRecording();
    now = 2000;
    return recorder.stop();
  }

  it("takes the device's clock and the browser's handler name out of an MP4 voice message", async () => {
    const recording = await record('audio/mp4', mp4);
    expect(recording).toMatchObject({ type: 'audio/mp4', length: 2 });
    const file = recording!.file;
    expect(file.length).toBe(mp4.length);
    expect(file.includes(0xaa)).toBe(false);
    expect(types(file)).not.toContain('SoundHandler');
    // Its timescale and duration (1000 and 2000) are as they were, and the sound.
    expect(types(file)).toContain('\0\0\x03\xe8\0\0\x07\xd0');
    expect(types(file)).toContain('sound');
  });

  it('leaves a WebM recording as it is', async () => {
    const recording = await record('audio/webm', webm);
    expect(recording).toMatchObject({ type: 'audio/webm', length: 2 });
    expect(recording!.file).toEqual(webm);
  });
});

it('says recording is unavailable where there is no MediaRecorder', async () => {
  expect(canRecord()).toBe(false);
  expect(await hasCamera()).toBe(false);
});
