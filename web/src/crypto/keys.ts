// P-256 keys in WebCrypto.
//
// Device keys are generated non-extractable: they can be used, but never read
// out by code, not even by our own. That's all the flag does: the web view
// still stores them in the app's storage, readable to a copy of it (see
// vault.ts). Copyable keys (the account key, link keys and conversation keys,
// made so to be copied to another device, which the app doesn't do: one
// device per account) are generated once as extractable, sealed into the
// vault (vault.ts), and then used through a non-extractable working copy.

import { toBase64Url } from './encoding';
import { message } from './signing';

/** Algorithm suite: P-256, HKDF-SHA256, AES-256-GCM. Recorded with every key. */
export const SUITE = 0x01;

const SIGNING: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };
const AGREEMENT: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' };

/** A new non-extractable ECDSA key pair (a device signing key). */
export function generateSigningKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(SIGNING, false, ['sign', 'verify']);
}

/** A new non-extractable ECDH key pair (a device encryption key). */
export function generateAgreementKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(AGREEMENT, false, ['deriveBits']);
}

/** A new ECDSA key pair whose private key can be sealed and copied. */
export function generateCopyableSigningKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(SIGNING, true, ['sign', 'verify']);
}

/** A new ECDH key pair whose private key can be sealed and copied (link and conversation keys). */
export function generateCopyableAgreementKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(AGREEMENT, true, ['deriveBits']);
}

/** Import parameters for unsealing keys from the vault. */
export const SIGNING_IMPORT: EcKeyImportParams = { name: 'ECDSA', namedCurve: 'P-256' };
export const AGREEMENT_IMPORT: EcKeyImportParams = { name: 'ECDH', namedCurve: 'P-256' };

/** The 65-byte uncompressed public point, as the backend parses it. */
export async function exportPublicKey(publicKey: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
}

/** Imports a 65-byte public point for verifying signatures. */
export function importSigningPublicKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, SIGNING, true, ['verify']);
}

/** Imports a 65-byte public point to encrypt to (ECDH). Throws if it isn't on the curve. */
export function importAgreementPublicKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, AGREEMENT, true, []);
}

/**
 * A key's fingerprint: SHA-256 over a labelled message holding the suite and
 * the public point, written as 43 base64url characters. It's what links carry,
 * so a server that swaps keys is caught.
 */
export async function fingerprint(publicKey: CryptoKey): Promise<string> {
  const raw = await exportPublicKey(publicKey);
  const digest = await crypto.subtle.digest('SHA-256', message('incognitochat/v2/fingerprint', new Uint8Array([SUITE]), raw));
  return toBase64Url(new Uint8Array(digest));
}
