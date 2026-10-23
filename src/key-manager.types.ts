/**
 * Type definitions for KeyManager
 * These types represent the BLS CT key structures from navio-blsct
 * Replicates types from navio-core's blsct::keyman
 */

/**
 * Secret key type (opaque type from navio-blsct)
 * This represents a BLS secret key (MclScalar)
 */
export type SecretKey = unknown;

/**
 * Public key type (opaque type from navio-blsct)
 * This represents a BLS public key (MclG1Point)
 */
export type PublicKey = unknown;

/**
 * Sub-address identifier
 * Replicates SubAddressIdentifier from navio-core
 */
export interface SubAddressIdentifier {
  /** Account number (0 = main, -1 = change, -2 = staking) */
  account: number;
  /** Address index within the account */
  address: number;
}

/**
 * Sub-address type
 * Replicates SubAddress from navio-core
 */
export type SubAddress = unknown;

/**
 * HD Chain structure
 * Replicates HDChain from navio-core
 */
export interface HDChain {
  /** Chain version */
  version: number;
  /** Seed ID (hash160 of seed public key) */
  seedId: Uint8Array;
  /** Spend key ID */
  spendId: Uint8Array;
  /** View key ID */
  viewId: Uint8Array;
  /** Token key ID */
  tokenId: Uint8Array;
  /** Blinding key ID */
  blindingId: Uint8Array;
}

/**
 * Seed type for import
 * Replicates SeedType enum from navio-core
 */
export type SeedType = 'IMPORT_MASTER_KEY' | 'IMPORT_VIEW_KEY';

/**
 * How a mnemonic becomes the wallet's master key.
 *
 * - `'core'`: navio-core's derivation (KeyMan::SetupMnemonicFromEntropy),
 *   also used by navio-electrum. The master key is EIP-2333
 *   `derive_master_SK` of the 32-byte mnemonic entropy, or, with a
 *   passphrase, of the 64-byte BIP39 seed. 24-word mnemonics (or 26-word
 *   Navio birthday mnemonics) only.
 * - `'legacy'`: what navio-sdk 0.4.0 and earlier did. The master key is the
 *   mnemonic entropy read directly as a scalar. Accepts 12–24 words, no
 *   passphrase. The same mnemonic restores a different wallet in navio-core.
 */
export type MnemonicDerivation = 'core' | 'legacy';

/**
 * Options for turning a mnemonic into a wallet.
 */
export interface MnemonicOptions {
  /** Derivation to use (default `'core'`) */
  derivation?: MnemonicDerivation;
  /**
   * BIP39 passphrase (`'core'` derivation only). As in navio-core it is
   * used as raw UTF-8 without NFKD normalization; new wallets must use an
   * ASCII passphrase.
   */
  passphrase?: string;
}

/**
 * Key storage interface for persistent storage
 */
export interface KeyStorage {
  /** Save a key pair with a label */
  save(label: string, secretKey: SecretKey, publicKey: PublicKey): Promise<void>;
  /** Load a key pair by label */
  load(label: string): Promise<{ secretKey: SecretKey; publicKey: PublicKey } | null>;
  /** Delete a key pair by label */
  delete(label: string): Promise<boolean>;
  /** List all stored key labels */
  list(): Promise<string[]>;
}

/**
 * BLS CT transaction output data
 * Replicates CTxOutBLSCTData from navio-core
 */
export interface CTxOutBLSCTData {
  /** Spending public key */
  spendingKey: unknown; // PublicKeyType
  /** Ephemeral public key */
  ephemeralKey: unknown; // PublicKeyType
  /** Blinding public key */
  blindingKey: unknown; // PublicKeyType
  /** Range proof */
  rangeProof: unknown; // RangeProof
  /** View tag (16-bit) */
  viewTag: number;
}

/**
 * Transaction output
 * Replicates CTxOut from navio-core
 */
export interface CTxOut {
  /** Value (amount) */
  nValue: bigint;
  /** Script public key */
  scriptPubKey: Uint8Array;
  /** BLS CT data */
  blsctData: CTxOutBLSCTData;
  /** Token ID */
  tokenId: Uint8Array;
  /** Predicate (optional) */
  predicate?: unknown;
}

/**
 * Transaction destination
 * Replicates CTxDestination from navio-core
 */
export type CTxDestination = unknown; // Can be SubAddress keys or other destination types

/**
 * Amount recovery result
 * Replicates AmountRecoveryResult from navio-core
 */
export interface AmountRecoveryResult {
  /** Success flag */
  success: boolean;
  /** Recovered amounts */
  amounts: bigint[];
  /** Indices of outputs that were recovered */
  indices: number[];
}
