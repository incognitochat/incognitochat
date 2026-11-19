import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { generateVaultKey } from '../crypto/vault';
import { keyId } from '../protocol/envelope';
import { deleteSealed, getMeta, openDatabase, putKey } from '../storage/db';
import { createConversationKey, keyFinder, type KeyEntry } from './keys';

let n = 0;
async function db() {
  const d = await openDatabase(`keys-test-${n++}`);
  await putKey(d, 'vault-key', await generateVaultKey());
  return d;
}

describe('keyFinder', () => {
  it('keeps what it unseals, but not what a find that started before a clear unsealed', async () => {
    const d = await db();
    const { publicKey } = await createConversationKey(d, 'c1');
    const id = await keyId(publicKey);
    const [entry] = Object.values((await getMeta<Record<string, KeyEntry>>(d, 'recipient-keys'))!);
    const find = keyFinder(d);
    // Cleared while it unseals: the key may have just been deleted.
    const racing = find(id);
    find.clear();
    expect((await racing)!.publicKey).toEqual(publicKey);
    await deleteSealed(d, entry!.name);
    await expect(find(id)).rejects.toThrow('missing key');

    // Found and kept, with no clear meanwhile: the vault isn't read again.
    const other = await createConversationKey(d, 'c2');
    const otherId = await keyId(other.publicKey);
    const name = Object.values((await getMeta<Record<string, KeyEntry>>(d, 'recipient-keys'))!).find((e) => e.conv === 'c2')!.name;
    expect((await find(otherId))!.publicKey).toEqual(other.publicKey);
    await deleteSealed(d, name);
    expect((await find(otherId))!.publicKey).toEqual(other.publicKey);
    find.clear();
    await expect(find(otherId)).rejects.toThrow('missing key');
  });
});
