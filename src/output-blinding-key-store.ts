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

import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
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
 * not encrypt them. Each row is rewritten in place, keeping its creation time,
 * and only if it still holds the plaintext that was read.
 *
 * Does nothing for an unencrypted or locked wallet. Safe to call repeatedly.
 *
 * @param walletDB - The wallet database
 * @param keyManager - The wallet's key manager
 * @returns How many rows were encrypted
 */
export async function sealPlaintextOutputBlindingKeys(
  walletDB: Pick<IWalletDB, 'getUnsealedOutputBlindingKeys' | 'replaceOutputBlindingKey'>,
  keyManager: Pick<KeyManager, 'isEncrypted' | 'isUnlocked' | 'encryptSecret'>
): Promise<number> {
  if (!keyManager.isEncrypted() || !keyManager.isUnlocked()) {
    return 0;
  }
  let sealed = 0;
  for (const { outputHash, blindingKey } of await walletDB.getUnsealedOutputBlindingKeys()) {
    if (isSealedBlindingKey(blindingKey)) continue;
    const record = await sealOutputBlindingKey(keyManager, blindingKey);
    if (await walletDB.replaceOutputBlindingKey(outputHash, blindingKey, record)) {
      sealed++;
    }
  }
  return sealed;
}

/** Per database: whether its rows are sealed, and how many attempts failed. */
const sealState = new WeakMap<object, { sealed: boolean; failures: number }>();

/**
 * Record that every plaintext row of `walletDB` has been sealed, so
 * {@link ensureOutputBlindingKeysSealed} stops scanning it.
 *
 * @param walletDB - The wallet database
 */
export function markOutputBlindingKeysSealed(walletDB: object): void {
  sealState.set(walletDB, { sealed: true, failures: 0 });
}

/**
 * {@link sealPlaintextOutputBlindingKeys}, at most once per database while the
 * wallet is encrypted and unlocked, and never throwing.
 *
 * The client and the sync engine call it whenever they touch the table. Once
 * a pass succeeds no plaintext row can reappear: every write after it goes
 * through {@link sealOutputBlindingKey}, and an encrypted, locked wallet cannot
 * write one at all. A failed pass leaves the plaintext readable, is retried on
 * the next call, and is reported with `console.warn` on the first failure and
 * then at every power of two, so a database that keeps failing is visible
 * without flooding the log.
 *
 * @param walletDB - The wallet database
 * @param keyManager - The wallet's key manager
 */
export async function ensureOutputBlindingKeysSealed(
  walletDB: Pick<IWalletDB, 'getUnsealedOutputBlindingKeys' | 'replaceOutputBlindingKey'>,
  keyManager: Pick<KeyManager, 'isEncrypted' | 'isUnlocked' | 'encryptSecret'>
): Promise<void> {
  const state = sealState.get(walletDB) ?? { sealed: false, failures: 0 };
  if (state.sealed || !keyManager.isEncrypted() || !keyManager.isUnlocked()) {
    return;
  }
  try {
    await sealPlaintextOutputBlindingKeys(walletDB, keyManager);
    markOutputBlindingKeysSealed(walletDB);
  } catch (error) {
    state.failures++;
    sealState.set(walletDB, state);
    if ((state.failures & (state.failures - 1)) === 0) {
      console.warn(
        `Could not encrypt the plaintext output blinding keys of an encrypted wallet ` +
          `(attempt ${state.failures}); they stay on disk in plaintext until this succeeds. ` +
          'Retrying on the next use.',
        error
      );
    }
  }
}
