// Fixed keys and seeded randomness for tests that seal envelopes, so every
// byte they make is the same on every run. Tests only; nothing in the app
// imports this.

import { vi } from 'vitest';
import vectors from '../../../backend/internal/envelope/testdata/vectors.json';
import { fromHex, toBase64Url } from '../crypto/encoding';
import type { Random } from './random';

/** A key from the vectors: its scalar and uncompressed point, in hex. */
export interface HexKey {
  privateKey: string;
  publicKey: string;
}

/** Imports a P-256 ECDH key pair from its scalar and uncompressed point. */
export async function keyPair(k: HexKey): Promise<CryptoKeyPair> {
  const point = fromHex(k.publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', x: toBase64Url(point.slice(1, 33)), y: toBase64Url(point.slice(33, 65)) };
  const params = { name: 'ECDH', namedCurve: 'P-256' };
  return {
    privateKey: await crypto.subtle.importKey('jwk', { ...jwk, d: toBase64Url(fromHex(k.privateKey)) }, params, false, ['deriveBits']),
    publicKey: await crypto.subtle.importKey('jwk', jwk, params, true, []),
  };
}

interface FixedKey {
  pair: CryptoKeyPair;
  privateKey: CryptoKey;
  publicKey: Uint8Array<ArrayBuffer>;
}

/**
 * The made-up key pairs in the shared test vectors
 * (backend/internal/envelope/testdata/vectors.json), always in the same order.
 */
export async function fixedKeys(): Promise<FixedKey[]> {
  const keys = new Map<string, HexKey>();
  for (const v of vectors.messages) for (const k of [v.sender, v.recipient, v.ephemeral]) keys.set(k.publicKey, k);
  return Promise.all(
    [...keys.values()].map(async (k) => {
      const pair = await keyPair(k);
      return { pair, privateKey: pair.privateKey, publicKey: fromHex(k.publicKey) };
    }),
  );
}

/**
 * From now until vi.restoreAllMocks: WebCrypto's random bytes (content keys,
 * nonces, IDs) come from r, and every key pair it makes (an HPKE ephemeral
 * key) is `ephemeral`.
 */
export function seedCrypto(r: Random, ephemeral: CryptoKeyPair): void {
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(((array: ArrayBufferView) => {
    if (!(array instanceof Uint8Array)) throw new Error('seedCrypto: only Uint8Array');
    array.set(r.bytes(array.length));
    return array;
  }) as typeof crypto.getRandomValues);
  vi.spyOn(crypto.subtle, 'generateKey').mockResolvedValue(ephemeral as never);
}
