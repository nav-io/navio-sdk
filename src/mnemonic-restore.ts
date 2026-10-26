/**
 * Matching a mnemonic restore against the wallet a database already holds.
 *
 * @module mnemonic-restore
 * @internal
 */

import { KeyManager } from './key-manager';
import type {
  MnemonicDerivation,
  MnemonicOptions,
  RestoreMnemonicOptions,
} from './key-manager.types';
import { parseBirthdayMnemonic } from './crypto/birthday-mnemonic';

/**
 * What a wallet database holds, for matching a restore against it.
 * @internal
 */
export interface StoredWalletIdentity {
  /** The stored wallet's serialized public spending key, or null for none */
  spendPublicKey: string | null;
  /** The stored plaintext mnemonic, or null (none stored, or encrypted) */
  mnemonic: { mnemonic: string; derivation: MnemonicDerivation; passphrase?: string } | null;
}

/**
 * Build the KeyManager a mnemonic restore writes into a database holding
 * `stored` (see {@link RestoreMnemonicOptions}).
 * @returns The KeyManager, and whether it is the stored wallet (the phrase
 *   restores it) rather than a new or replacing one
 * @param spendKeyOf - Serialize a KeyManager's public spending key as the
 *   database stores it
 * @throws When the restore would replace a stored wallet that might be this
 *   phrase's with another derivation or passphrase, unless
 *   `options.replaceExisting` is set
 * @internal
 */
export function keyManagerForMnemonicRestore(
  mnemonic: string,
  options: RestoreMnemonicOptions,
  stored: StoredWalletIdentity,
  spendKeyOf: (km: KeyManager) => string
): { keyManager: KeyManager; matchesStored: boolean } {
  const { replaceExisting, ...mnemonicOptions } = options;
  const build = (o: MnemonicOptions): KeyManager => {
    const km = new KeyManager();
    km.setHDSeedFromMnemonic(mnemonic, o);
    return km;
  };
  if (!stored.spendPublicKey) {
    return { keyManager: build(mnemonicOptions), matchesStored: false };
  }

  const storedPhrase = stored.mnemonic;
  const samePhrase = storedPhrase !== null && sameMnemonic(storedPhrase.mnemonic, mnemonic);
  const candidates: MnemonicOptions[] = [];
  if (samePhrase) {
    candidates.push({
      derivation: options.derivation ?? storedPhrase.derivation,
      passphrase: options.passphrase ?? storedPhrase.passphrase,
    });
  } else if (options.derivation) {
    candidates.push(mnemonicOptions);
  } else {
    candidates.push({ derivation: 'core', passphrase: options.passphrase });
    if (!options.passphrase) {
      candidates.push({ derivation: 'legacy' });
    }
  }

  for (const candidate of candidates) {
    let km: KeyManager;
    try {
      km = build(candidate);
    } catch {
      continue; // e.g. a 12-word phrase with 'core'
    }
    if (spendKeyOf(km) === stored.spendPublicKey) {
      return { keyManager: km, matchesStored: true };
    }
  }

  // The stored wallet is not the one this phrase restores
  if (replaceExisting || (storedPhrase !== null && !samePhrase)) {
    return { keyManager: build(mnemonicOptions), matchesStored: false };
  }
  throw new Error(
    (samePhrase
      ? 'The wallet database stores this mnemonic with another derivation or passphrase'
      : 'The wallet database holds a different wallet, which may be this mnemonic with another derivation or passphrase') +
      '. Restoring would replace it and delete its outputs and sync state: check the derivation and ' +
      'passphrase, or pass replaceExisting: true (NavioClient: replaceExistingWallet) to replace it.'
  );
}

/**
 * Whether two phrases are the same mnemonic (same entropy; a birthday
 * mnemonic matches its 24 base words)
 */
function sameMnemonic(a: string, b: string): boolean {
  try {
    const x = parseBirthdayMnemonic(a).entropy;
    const y = parseBirthdayMnemonic(b).entropy;
    return x.length === y.length && x.every((byte, i) => byte === y[i]);
  } catch {
    return false;
  }
}
