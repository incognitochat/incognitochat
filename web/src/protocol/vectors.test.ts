// Fixed-input vectors for envelopes and inner messages, shared with the
// backend: backend/internal/envelope/testdata/vectors.json, whose
// vectors_test.go opens the same envelopes with Go's crypto/hpke. Each one is
// sealed again here from its keys and randomness and must come out byte for
// byte, so a changed label, part order, key ID, wrap info, body AAD or
// message tag fails on both sides instead of breaking older apps.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromHex, toBase64Url, toHex, utf8 } from '../crypto/encoding';
import { open } from '../crypto/hpke';
import { keyPair, type HexKey as Key } from '../testing/crypto';
import vectors from '../../../backend/internal/envelope/testdata/vectors.json';
import { bodyAad, keyId, openEnvelope, parseEnvelope, wrapInfo, type RecipientKey } from './envelope';
import { openMessage, sealMessage, type Draft } from './message';

async function recipientKey(k: Key): Promise<RecipientKey> {
  return { privateKey: (await keyPair(k)).privateKey, publicKey: fromHex(k.publicKey) };
}

/**
 * Makes the next seal use the vector's randomness: crypto.getRandomValues
 * gives the content key and then the nonce, and the HPKE ephemeral key is the
 * vector's.
 */
function fixRandomness(contentKey: Uint8Array, nonce: Uint8Array, ephemeral: CryptoKeyPair): void {
  const draws = [contentKey, nonce];
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => {
    const next = draws.shift();
    if (next?.length !== array.length) throw new Error('unexpected random draw');
    array.set(next);
    return array;
  }) as typeof crypto.getRandomValues);
  vi.spyOn(crypto.subtle, 'generateKey').mockResolvedValueOnce(ephemeral as never);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(vectors.messages.map((v) => [v.name, v] as const))('vector: %s', (_, v) => {
  it('seals byte for byte from the same keys and randomness', async () => {
    const { v: version, from, to, ...draft } = JSON.parse(v.json) as Record<string, unknown>;
    expect([version, from, to]).toEqual([1, toBase64Url(fromHex(v.sender.publicKey)), toBase64Url(fromHex(v.keyId))]);
    const sender = { privateKey: (await keyPair(v.sender)).privateKey, publicKey: fromHex(v.sender.publicKey) };
    fixRandomness(fromHex(v.contentKey), fromHex(v.nonce), await keyPair(v.ephemeral));
    const envelope = await sealMessage(draft as unknown as Draft, sender, fromHex(v.recipient.publicKey));
    expect(toHex(envelope)).toBe(v.envelope);
  });

  it('opens, with the key ID, wrap info, AAD and tag pinned', async () => {
    const recipient = await recipientKey(v.recipient);
    const envelope = fromHex(v.envelope);
    expect(toHex(await keyId(recipient.publicKey))).toBe(v.keyId);

    const { wraps, body } = parseEnvelope(envelope);
    expect(wraps).toHaveLength(1);
    expect(toHex(wraps[0]!.keyId)).toBe(v.keyId);
    expect(toHex(wraps[0]!.enc)).toBe(v.ephemeral.publicKey);
    expect(toHex(body.slice(0, 12))).toBe(v.nonce);
    expect(toHex(bodyAad())).toBe(v.aad);
    const info = await wrapInfo(wraps[0]!.keyId, body);
    expect(toHex(info)).toBe(v.wrapInfo);
    const contentKey = await open(wraps[0]!.enc, recipient.privateKey, recipient.publicKey, info, new Uint8Array(0), wraps[0]!.ct);
    expect(toHex(contentKey)).toBe(v.contentKey);

    const { inner } = await openEnvelope(envelope, async () => recipient);
    expect(toHex(inner.slice(0, 32))).toBe(v.authTag);
    expect(inner.slice(32)).toEqual(utf8(v.json));

    const opened = await openMessage(envelope, async () => recipient);
    expect(opened.message).toEqual(JSON.parse(v.json));
    expect(toHex(opened.keyId)).toBe(v.keyId);
  });
});
