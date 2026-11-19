import { afterEach, describe, expect, it, vi } from 'vitest';
import { concat, utf8 } from '../crypto/encoding';
import { generateCopyableAgreementKey, exportPublicKey, SUITE } from '../crypto/keys';
import { fixedKeys, seedCrypto } from '../testing/crypto';
import { Random } from '../testing/random';
import {
  EnvelopeError,
  keyId,
  MAX_ENVELOPE,
  MAX_INNER,
  MAX_WRAPS,
  openEnvelope,
  pad,
  PADDED_SIZES,
  parseEnvelope,
  sealEnvelope,
  sendTokensFor,
  TOKEN_BYTES,
  unpad,
  WRAP_LENGTH,
  type ParsedEnvelope,
  type RecipientKey,
} from './envelope';

async function recipient(): Promise<RecipientKey & { publicKey: Uint8Array<ArrayBuffer>; id: Uint8Array }> {
  const pair = await generateCopyableAgreementKey();
  const publicKey = await exportPublicKey(pair.publicKey);
  return { privateKey: pair.privateKey, publicKey, id: await keyId(publicKey) };
}

const finder = (...keys: { id: Uint8Array; privateKey: CryptoKey; publicKey: Uint8Array }[]) => async (id: Uint8Array) =>
  keys.find((k) => k.id.every((b, i) => b === id[i]));

describe('padding', () => {
  it('pads to fixed sizes and back', () => {
    for (const n of [0, 1, 508, 509, 2044, 2045, MAX_INNER]) {
      const inner = new Uint8Array(n).fill(7);
      const padded = pad(inner);
      expect(PADDED_SIZES).toContain(padded.length);
      expect(unpad(padded)).toEqual(inner);
    }
    expect(pad(new Uint8Array(508))).toHaveLength(512);
    expect(pad(new Uint8Array(509))).toHaveLength(2048);
    expect(() => pad(new Uint8Array(MAX_INNER + 1))).toThrow(EnvelopeError);
  });

  it('rejects padding that was tampered with', () => {
    const padded = pad(new Uint8Array([1, 2, 3]));
    const junk = padded.slice();
    junk[100] = 1;
    expect(() => unpad(junk)).toThrow(EnvelopeError);
    const long = padded.slice();
    new DataView(long.buffer).setUint32(0, 600);
    expect(() => unpad(long)).toThrow(EnvelopeError);
    expect(() => unpad(new Uint8Array(513))).toThrow(EnvelopeError);
  });
});

describe('envelope', () => {
  it('opens for the recipient, only', async () => {
    const alice = await recipient();
    const bob = await recipient();
    const envelope = await sealEnvelope([alice.publicKey], utf8('hello'));
    expect(envelope.length).toBe(2 + WRAP_LENGTH + 12 + 512 + 16);
    const opened = await openEnvelope(envelope, finder(alice));
    expect(new TextDecoder().decode(opened.inner)).toBe('hello');
    expect(opened.keyId).toEqual(alice.id);
    await expect(openEnvelope(envelope, finder(bob))).rejects.toThrow('no key');
  });

  it('opens for every recipient of a multi-wrap envelope', async () => {
    const keys = [await recipient(), await recipient(), await recipient()];
    const envelope = await sealEnvelope(
      keys.map((k) => k.publicKey),
      utf8('to all my devices'),
    );
    for (const k of keys) {
      expect(new TextDecoder().decode((await openEnvelope(envelope, finder(k))).inner)).toBe('to all my devices');
    }
  });

  it('catches a wrap moved onto another body, and a changed body', async () => {
    const alice = await recipient();
    const a = parseEnvelope(await sealEnvelope([alice.publicKey], utf8('first')));
    const b = await sealEnvelope([alice.publicKey], utf8('second'));
    // a's wrap on b's body.
    const spliced = new Uint8Array(b);
    spliced.set([...a.wraps[0]!.keyId, ...a.wraps[0]!.enc, ...a.wraps[0]!.ct], 2);
    await expect(openEnvelope(spliced, finder(alice))).rejects.toThrow(EnvelopeError);

    const flipped = new Uint8Array(b);
    flipped[flipped.length - 1]! ^= 1;
    await expect(openEnvelope(flipped, finder(alice))).rejects.toThrow(EnvelopeError);
  });

  it('rejects malformed layouts before any crypto', () => {
    expect(() => parseEnvelope(new Uint8Array([2, 1]))).toThrow('unknown suite');
    expect(() => parseEnvelope(new Uint8Array([1, 0]))).toThrow('bad wrap count');
    expect(() => parseEnvelope(new Uint8Array(2 + WRAP_LENGTH + 100).fill(1, 0, 2))).toThrow('bad body size');
    expect(() => parseEnvelope(new Uint8Array(MAX_ENVELOPE + 1))).toThrow('bad size');
  });

  it('gives each key a stable 8-byte ID', async () => {
    const k = await recipient();
    expect(k.id).toHaveLength(8);
    expect(await keyId(k.publicKey)).toEqual(k.id);
  });
});

describe('send tokens', () => {
  // The same table is in backend/internal/envelope/envelope_test.go.
  it('cost one per started 2.5 KiB of envelope', () => {
    const size = (wraps: number, padded: number) => 2 + wraps * WRAP_LENGTH + 12 + padded + 16;
    const cases: [number, number][] = [
      [size(1, 512), 1],
      [size(1, 2048), 1],
      [size(2, 2048), 1],
      [size(1, 8192), 4],
      [size(1, 16384), 7],
      [size(MAX_WRAPS, 512), 1],
      [size(MAX_WRAPS, 2048), 2],
      [MAX_ENVELOPE, 8],
      [TOKEN_BYTES, 1],
      [TOKEN_BYTES + 1, 2],
    ];
    for (const [length, tokens] of cases) expect([length, sendTokensFor(length)]).toEqual([length, tokens]);
  });
});

describe('envelopes, on random input', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

  it('pad and unpad any inner message, to the smallest size that fits', () => {
    const r = new Random(0x656e7601);
    for (let round = 0; round < 300; round++) {
      const length = r.oneIn(2) ? r.pick([0, 1, 507, 508, 509, 2043, 2044, 2045, 8187, 8188, 8189, MAX_INNER]) : r.int(MAX_INNER + 1);
      const inner = r.bytes(length);
      const padded = pad(inner);
      expect(padded.length, `round ${round}`).toBe(PADDED_SIZES.find((size) => size >= length + 4));
      expect(unpad(padded), `round ${round}`).toEqual(inner);
    }
  });

  it('refuse random and changed padding with an EnvelopeError only', () => {
    const r = new Random(0x656e7602);
    for (let round = 0; round < 400; round++) {
      const input = r.oneIn(4) ? r.bytes(r.pick([...PADDED_SIZES, r.int(600)])) : r.mutate(pad(r.bytes(r.int(600))));
      let inner: Uint8Array;
      try {
        inner = unpad(input);
      } catch (err) {
        expect(err, `round ${round}`).toBeInstanceOf(EnvelopeError);
        continue;
      }
      // What it takes, it reads exactly: the length, those bytes, then only zeros.
      expect(PADDED_SIZES).toContain(input.length);
      expect(new DataView(input.buffer).getUint32(0)).toBe(inner.length);
      expect(input.subarray(4, 4 + inner.length)).toEqual(inner);
      expect(input.subarray(4 + inner.length).every((b) => b === 0)).toBe(true);
    }
  });

  it('refuse random and changed layouts with an EnvelopeError only, and split the rest exactly', () => {
    const r = new Random(0x656e7603);
    // The right layout around random bytes: nothing is checked but the sizes.
    const layout = (wraps: number) => concat(new Uint8Array([SUITE, wraps]), r.bytes(wraps * WRAP_LENGTH + 12), new Uint8Array(r.pick(PADDED_SIZES) + 16));
    for (let round = 0; round < 500; round++) {
      const input = r.oneIn(4) ? r.bytes(r.int(3000)) : r.mutate(layout(1 + r.int(3)));
      let parsed: ParsedEnvelope;
      try {
        parsed = parseEnvelope(input);
      } catch (err) {
        expect(err, `round ${round}`).toBeInstanceOf(EnvelopeError);
        continue;
      }
      expect(parsed.wraps).toHaveLength(input[1]!);
      expect(concat(input.subarray(0, 2), ...parsed.wraps.flatMap((w) => [w.keyId, w.enc, w.ct]), parsed.body), `round ${round}`).toEqual(input);
    }
  });

  it('open to exactly what was sealed, and never to anything else once changed', async () => {
    // Fixed keys and seeded randomness: a failing round fails the same way every run.
    const r = new Random(0x656e7604);
    const [a, b, c, ephemeral] = await fixedKeys();
    const keys = await Promise.all([a!, b!, c!].map(async (k) => ({ ...k, id: await keyId(k.publicKey) })));
    const find = finder(...keys);
    seedCrypto(r, ephemeral!.pair);
    for (let round = 0; round < 100; round++) {
      const inner = r.bytes(r.oneIn(2) ? r.pick([0, 1, 508, 509, MAX_INNER]) : r.int(3000));
      const to = keys.slice(0, 1 + r.int(keys.length));
      const envelope = await sealEnvelope(
        to.map((k) => k.publicKey),
        inner,
      );
      const opened = await openEnvelope(envelope, find);
      expect(opened.inner, `round ${round}`).toEqual(inner);
      expect(opened.keyId).toEqual(to[0]!.id);
      const changed = r.mutate(envelope);
      if (same(changed, envelope)) continue;
      const result = await openEnvelope(changed, find).then(
        (opened) => ({ opened }),
        (err: unknown) => ({ err }),
      );
      if ('err' in result) {
        expect(result.err, `round ${round}`).toBeInstanceOf(EnvelopeError);
      } else {
        // Only another recipient's wrap was changed: each checks only its own.
        expect(to.length, `round ${round}`).toBeGreaterThan(1);
        expect(result.opened.inner).toEqual(inner);
      }
    }
  });
});
