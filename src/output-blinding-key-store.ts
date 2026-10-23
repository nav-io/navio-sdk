/**
 * At-rest protection for stored output blinding scalars.
 *
 * The wallet database keeps the private blinding scalar of every output this
 * wallet built (see `IWalletDB.saveOutputBlindingKey`), as a fast path for
 * `recoverBlindingKey` / `signOutput`. The scalar is the key that signs for an
 * output, so an encrypted wallet stores it encrypted with the wallet key, the
 * same way it stores its private keys and seed. An unencrypted wallet stores
 * the 64-hex scalar as before.
 *
 * The two forms are told apart by {@link SEALED_BLINDING_KEY_PREFIX}: a
 * plaintext record is exactly 64 hex characters and can never start with it.
 *
 * @module output-blinding-key-store
 */

import type { KeyManager } from './key-manager';
import type { IWalletDB } from './wallet-db.interface';

/** Prefix of a stored blinding scalar encrypted with the wallet key. */
export const SEALED_BLINDING_KEY_PREFIX = 'enc1:';

/**
 * Whether a stored blinding-key record is encrypted.
 *
 * @param stored - The record as returned by `IWalletDB.getOutputBlindingKey`
 * @returns True for an encrypted record
 */
export function isSealedBlindingKey(stored: string): boolean {
  return stored.startsWith(SEALED_BLINDING_KEY_PREFIX);
}

/**
 * The record to store for a blinding scalar: encrypted when the wallet is
 * encrypted, the scalar itself otherwise.
 *
 * @param keyManager - The wallet's key manager
 * @param scalarHex - The private scalar, 64 hex characters
 * @returns The record for `IWalletDB.saveOutputBlindingKey`
 * @throws If the wallet is encrypted and locked
 */
export async function sealOutputBlindingKey(
  keyManager: Pick<KeyManager, 'isEncrypted' | 'encryptSecret'>,
  scalarHex: string
): Promise<string> {
  if (!keyManager.isEncrypted()) {
    return scalarHex;
  }
  const sealed = await keyManager.encryptSecret(hexToBytes(scalarHex));
  return SEALED_BLINDING_KEY_PREFIX + bytesToHex(sealed);
}

/**
 * The scalar in a stored blinding-key record.
 *
 * @param keyManager - The wallet's key manager
 * @param stored - The record as returned by `IWalletDB.getOutputBlindingKey`
 * @returns The scalar as 64 hex characters, or null when the record is
 *   encrypted and the wallet is locked, or it does not decrypt (it was
 *   encrypted under an earlier password)
 */
export async function openOutputBlindingKey(
  keyManager: Pick<KeyManager, 'isEncrypted' | 'isUnlocked' | 'decryptSecret'>,
  stored: string
): Promise<string | null> {
  if (!isSealedBlindingKey(stored)) {
    return stored;
  }
  if (!keyManager.isEncrypted() || !keyManager.isUnlocked()) {
    return null;
  }
  try {
    const plaintext = await keyManager.decryptSecret(
      hexToBytes(stored.slice(SEALED_BLINDING_KEY_PREFIX.length))
    );
    return bytesToHex(plaintext);
  } catch {
    return null;
  }
}

/**
 * Encrypt every plaintext blinding scalar an encrypted wallet still stores:
 * rows written before the wallet was encrypted, or by an SDK version that did
 * not encrypt them.
 *
 * Does nothing for an unencrypted or locked wallet. Safe to call repeatedly.
 *
 * @param walletDB - The wallet database
 * @param keyManager - The wallet's key manager
 * @returns How many rows were encrypted
 */
export async function sealPlaintextOutputBlindingKeys(
  walletDB: Pick<IWalletDB, 'getAllOutputBlindingKeys' | 'saveOutputBlindingKey'>,
  keyManager: Pick<KeyManager, 'isEncrypted' | 'isUnlocked' | 'encryptSecret'>
): Promise<number> {
  if (!keyManager.isEncrypted() || !keyManager.isUnlocked()) {
    return 0;
  }
  let sealed = 0;
  for (const { outputHash, blindingKey } of await walletDB.getAllOutputBlindingKeys()) {
    if (isSealedBlindingKey(blindingKey)) continue;
    await walletDB.saveOutputBlindingKey(
      outputHash,
      await sealOutputBlindingKey(keyManager, blindingKey)
    );
    sealed++;
  }
  return sealed;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('Invalid hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
