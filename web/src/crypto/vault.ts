// The vault seals extractable keys (made so to be copied to another device,
// which the app doesn't do: one device per account) under a non-extractable
// AES-GCM key kept in the app's storage on this device.
//
// Honest limits: any script running on the app's origin can ask the vault key
// to unseal. The non-extractable flag only stops code from reading a key out;
// sealing keeps copyable keys out of plain sight in storage and limits them to
// this origin. Neither protects against a copy of the storage itself: the
// vault key is kept next to what it seals, and on Android, Windows and Linux
// the web view writes non-extractable keys to disk as they are, so a copy of
// the app's storage holds every key and clones the account (docs/data.md).

import { concat, randomBytes } from './encoding';

const AES: AesKeyGenParams = { name: 'AES-GCM', length: 256 };
const IV_LENGTH = 12;

/** A new non-extractable vault key. */
export function generateVaultKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(AES, false, ['wrapKey', 'unwrapKey']);
}

/**
 * Seals an extractable key under the vault key: a private key as PKCS8, or a
 * secret (the account secret, an HMAC key) as raw bytes. The key's name
 * is authenticated with it, so sealed keys can't be swapped between names.
 */
export async function seal(
  vaultKey: CryptoKey,
  privateKey: CryptoKey,
  name: string,
  format: 'pkcs8' | 'raw' = 'pkcs8',
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = randomBytes(IV_LENGTH);
  const wrapped = await crypto.subtle.wrapKey(format, privateKey, vaultKey, {
    name: 'AES-GCM',
    iv,
    additionalData: new TextEncoder().encode(name),
  });
  return concat(iv, new Uint8Array(wrapped));
}

/**
 * Unseals a private key as a non-extractable working copy with the given
 * algorithm and usages. Fails if the bytes or the name don't match.
 */
export function unseal(
  vaultKey: CryptoKey,
  sealed: Uint8Array<ArrayBuffer>,
  name: string,
  algorithm: EcKeyImportParams | HmacImportParams,
  usages: KeyUsage[],
  format: 'pkcs8' | 'raw' = 'pkcs8',
): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    format,
    sealed.slice(IV_LENGTH),
    vaultKey,
    { name: 'AES-GCM', iv: sealed.slice(0, IV_LENGTH), additionalData: new TextEncoder().encode(name) },
    algorithm,
    false,
    usages,
  );
}
