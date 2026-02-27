/**
 * Wallet Database Interface
 *
 * Defines the contract for wallet data persistence, decoupled from any
 * specific storage backend (SQLite, IndexedDB, etc.).
 *
 * @module wallet-db-interface
 */

import type { KeyManager } from './key-manager';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Sync state persisted between sessions
 */
export interface SyncState {
  lastSyncedHeight: number;
  lastSyncedHash: string;
  totalTxKeysSynced: number;
  lastSyncTime: number;
  chainTipAtLastSync: number;
}

/**
 * Wallet output (UTXO) as returned by query methods
 */
export interface WalletOutput {
  outputHash: string;
  txHash: string;
  outputIndex: number;
  blockHeight: number;
  amount: bigint;
  gamma: string;
  memo: string | null;
  tokenId: string | null;
  blindingKey: string;
  spendingKey: string;
  isSpent: boolean;
  spentTxHash: string | null;
  spentBlockHeight: number | null;
}

/**
 * Parameters for storing a new wallet output
 */
export interface StoreOutputParams {
  outputHash: string;
  txHash: string;
  outputIndex: number;
  blockHeight: number;
  outputData: string;
  amount: number;
  gamma: string;
  memo: string | null;
  tokenId: string | null;
  blindingKey: string;
  spendingKey: string;
  isSpent: boolean;
  spentTxHash: string | null;
  spentBlockHeight: number | null;
}

/**
 * Wallet metadata
 */
export interface WalletMetadata {
  creationHeight: number;
  creationTime: number;
  restoredFromSeed: boolean;
  version: number;
}

/**
 * Unified wallet database interface.
 *
 * Implemented by both the SQL-backed WalletDB (Node.js) and
 * IndexedDBWalletDB (browser).  TransactionKeysSync and NavioClient
 * program against this interface so the storage backend is swappable.
 */
export interface IWalletDB {
  // -- lifecycle --------------------------------------------------------
  open(path: string, data?: Uint8Array): Promise<void>;
  close(): Promise<void>;
  isOpen(): boolean;

  // -- wallet core ------------------------------------------------------
  loadWallet(): Promise<KeyManager>;
  createWallet(creationHeight?: number): Promise<KeyManager>;
  restoreWallet(seedHex: string, creationHeight?: number): Promise<KeyManager>;
  restoreWalletFromMnemonic(mnemonic: string, creationHeight?: number): Promise<KeyManager>;
  saveWallet(keyManager?: KeyManager): Promise<void>;
  getKeyManager(): KeyManager | null;

  // -- metadata ---------------------------------------------------------
  getWalletMetadata(): Promise<WalletMetadata | null>;
  getCreationHeight(): Promise<number>;
  setCreationHeight(height: number): Promise<void>;

  // -- balance & outputs (public queries) -------------------------------
  getBalance(tokenId?: string | null): Promise<bigint>;
  getUnspentOutputs(tokenId?: string | null): Promise<WalletOutput[]>;
  getAllOutputs(): Promise<WalletOutput[]>;

  // -- sync state -------------------------------------------------------
  loadSyncState(): Promise<SyncState | null>;
  saveSyncState(state: SyncState): Promise<void>;
  clearSyncData(): Promise<void>;

  // -- block hashes -----------------------------------------------------
  getBlockHash(height: number): Promise<string | null>;
  saveBlockHash(height: number, hash: string): Promise<void>;
  deleteBlockHash(height: number): Promise<void>;
  deleteBlockHashesBefore(height: number): Promise<void>;

  // -- transaction keys -------------------------------------------------
  saveTxKeys(txHash: string, height: number, keysData: string): Promise<void>;
  getTxKeys(txHash: string): Promise<any | null>;
  getTxKeysByHeight(height: number): Promise<{ txHash: string; keys: any }[]>;
  deleteTxKeysByHeight(height: number): Promise<void>;

  // -- wallet output mutations (used by sync) ---------------------------
  storeWalletOutput(params: StoreOutputParams): Promise<void>;
  isOutputUnspent(outputHash: string): Promise<boolean>;
  isOutputSpentInMempool(outputHash: string): Promise<boolean>;
  getMempoolSpentTxHash(outputHash: string): Promise<string | null>;
  markOutputSpent(outputHash: string, spentTxHash: string, spentBlockHeight: number): Promise<void>;
  deleteOutputsByHeight(height: number): Promise<void>;
  unspendOutputsBySpentHeight(height: number): Promise<void>;

  // -- pending/mempool balance ------------------------------------------
  getPendingSpentAmount(tokenId?: string | null): Promise<bigint>;
  deleteUnconfirmedOutputsByTxHash(txHash: string): Promise<void>;

  // -- persistence ------------------------------------------------------
  /** Flush to durable storage.  No-op for backends with immediate persistence. */
  saveDatabase(): Promise<void>;
  /** Alias for saveDatabase */
  save(): Promise<void>;

  // -- encryption -------------------------------------------------------
  isEncrypted(): Promise<boolean>;
  saveEncryptionMetadata(salt: string, verificationHash: string): Promise<void>;
  getEncryptionMetadata(): Promise<{ salt: string; verificationHash: string } | null>;
}
