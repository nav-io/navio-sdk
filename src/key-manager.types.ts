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

