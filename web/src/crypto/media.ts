// Attachment encryption (docs/protocol.md, Media). Each file gets a fresh
// AES-256-GCM key, which travels inside the encrypted message. The file is
// padded first, so its upload size says little about what it is:
//
//   upload = nonce (12) ‖ AES-GCM(key, nonce, file ‖ zeros, aad = label)
//
// Upload sizes: the next power of two from 16 KiB up to 1 MiB, then the
// next whole MiB.

import { utf8 } from './encoding';

export const LABEL_MEDIA = 'incognitochat/v2/media';
const NONCE = 12;
const TAG = 16;
const KiB = 1024;
const MiB = 1024 * KiB;

/** The upload size for a file of n bytes. */
export function uploadSize(n: number): number {
  const total = n + NONCE + TAG;
  if (total <= MiB) {
    let size = 16 * KiB;
    while (size < total) size *= 2;
    return size;
  }
  return Math.ceil(total / MiB) * MiB;
}

/** A new random file key (32 bytes). */
export function newFileKey(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32));
}

function importKey(raw: Uint8Array<ArrayBuffer>, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [usage]);
}

// Files are up to 50 MB, and a phone's WebView may have little memory to
// spare: the functions below make as few full-size copies as they can,
// working on views (subarray) of the buffers rather than copies (slice).

/** Pads and encrypts a file for upload. */
export async function encryptFile(file: Uint8Array, key: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const size = uploadSize(file.length);
  // The file is padded in place, where its ciphertext then goes: WebCrypto
  // reads its input before it starts, so writing over it after is safe.
  const out = new Uint8Array(size);
  out.set(file, NONCE);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: utf8(LABEL_MEDIA) },
      await importKey(key, 'encrypt'),
      out.subarray(NONCE, size - TAG),
    ),
  );
  out.set(nonce);
  out.set(ct, NONCE);
  return out;
}

/**
 * Decrypts an upload and cuts the padding off: size is the file's size from
 * the message. Throws if it was tampered with. What it returns is a view
 * that leaves the padding out of the decrypted buffer, not a copy: whatever
 * stores it as it is (IndexedDB's structured clone keeps a view's whole
 * buffer) must store a copy. putMedia stores it sealed, a new buffer.
 */
export async function decryptFile(upload: Uint8Array<ArrayBuffer>, key: Uint8Array<ArrayBuffer>, size: number): Promise<Uint8Array<ArrayBuffer>> {
  if (upload.length !== uploadSize(size)) throw new Error('media: wrong size');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: upload.subarray(0, NONCE), additionalData: utf8(LABEL_MEDIA) },
    await importKey(key, 'decrypt'),
    upload.subarray(NONCE),
  );
  return new Uint8Array(pt, 0, size);
}
