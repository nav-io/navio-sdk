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
 * Transaction type for a wallet output.
 * - `received`: coins received from an external sender
 * - `sent`: change output returned to the wallet from an outgoing transaction
 * - `stake`: staking reward from a Proof-of-Stake block
 */
export type TxType = 'received' | 'sent' | 'stake';

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
  /**
   * The output's `blsctData.blindingKey` from the chain: `k * sk_destination`,
   * bound to the recipient's spend key.
   *
   * This is NOT the public counterpart of the sender's blinding scalar — see
   * {@link WalletOutput.ephemeralKey} for that.
   */
  blindingKey: string;
  /**
   * The output's `blsctData.ephemeralKey` from the chain: `k * G`, the public
   * counterpart of the sender's blinding scalar, and the key an output
   * ownership signature (`signOutput`) verifies against.
   *
   * Public data — it is on chain. Null for outputs stored before this field
   * existed, and on backends that do not report it.
   */
  ephemeralKey: string | null;
  spendingKey: string;
  isSpent: boolean;
  spentTxHash: string | null;
  spentBlockHeight: number | null;
  /** Transaction type: received, sent, or stake */
  txType: TxType;
  /** Unix epoch timestamp of the block (or current time for mempool outputs) */
  timestamp: number;
  /**
   * Whether the output is a staked commitment: NAV locked for staking. It is
   * not part of the spendable balance and is not picked by coin selection.
   */
  isStakedCommitment: boolean;
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
  /** The output's `blsctData.ephemeralKey` (`k * G`), when the backend reports it. */
  ephemeralKey: string | null;
  spendingKey: string;
  isSpent: boolean;
  spentTxHash: string | null;
  spentBlockHeight: number | null;
  /** Transaction type: received, sent, or stake */
  txType: TxType;
  /** Unix epoch timestamp of the block (or current time for mempool outputs) */
  timestamp: number;
  /** Whether the output is a staked commitment (default false) */
  isStakedCommitment?: boolean;
}

/**
 * A token/NFT collection created by this wallet, recorded at creation time.
 */
export interface CreatedCollectionRecord {
  /** Creation id `Hash(metadata‖totalSupply)` — the id minting derives keys from. */
  collectionTokenId: string;
  /** Collection type. */
  kind: 'token' | 'nft';
  /** Derived collection token public key (hex). */
  tokenPublicKey: string;
  /** Metadata the collection was created with. */
  metadata: Record<string, string>;
  /** Maximum total supply recorded at creation. */
  totalSupply: number;
  /** Transaction id of the create-collection transaction. */
  txId: string;
  /** Unix timestamp (seconds) when the creation was broadcast. */
  createdAt: number;
}

/**
 * A standing swap order published by this wallet, as persisted (bigints as
 * decimal strings, inputs as outputHashes). See StandingOrderRecord.
 */
export interface StandingOrderRow {
  localId: string;
  quoteId: string | null;
  status: 'live' | 'unconfirmed';
  offerTokenId: string | null;
  offerAmount: string;
  wantTokenId: string | null;
  wantAmount: string;
  expiry: number;
  inputs: string[];
  halfTxHex: string;
  fee: string;
  createdAt: number;
}

/**
 * A persisted (hashId -> sub-address) mapping.
 */
export interface SubAddressEntry {
  /** Hash160 of the sub-address spending key, hex. */
  hashId: string;
  account: number;
  address: number;
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
  restoreWalletFromAuditKey(auditKeyHex: string, creationHeight?: number): Promise<KeyManager>;
  restoreWalletFromMnemonic(mnemonic: string, creationHeight?: number): Promise<KeyManager>;
  saveWallet(keyManager?: KeyManager): Promise<void>;
  /**
   * Persist (hashId -> sub-address) mappings so sub-addresses generated or
   * recovered past the default pools survive a reload. Existing rows for the
   * same hashId are replaced.
   */
  saveSubAddresses(entries: SubAddressEntry[]): Promise<void>;
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
  /**
   * The serialized output (hex) sync stored for an output, or null when the
   * output is unknown or none was stored (mempool outputs, and backends that
   * do not serve standalone outputs).
   *
   * @param outputHash - Output hash, display hex
   */
  getOutputData(outputHash: string): Promise<string | null>;
  deleteOutputsByHeight(height: number): Promise<void>;
  unspendOutputsBySpentHeight(height: number): Promise<void>;
  /**
   * Roll the wallet back to just below `fromHeight` after a chain
   * reorganization, in one atomic write: save `state` (which must describe
   * the block at `fromHeight - 1`), then drop every tx-keys row, wallet output
   * and block hash at or above `fromHeight`, and mark outputs spent at or
   * above it unspent again.
   *
   * Saving the state in the same transaction as the deletes is what makes it
   * crash-safe: either both land or neither does, so an interrupted revert
   * can never leave a sync state pointing at a block whose rows are gone.
   * Mempool rows (block height 0, spent height 0) are never touched.
   *
   * @param fromHeight - First height to revert; must be at least 1
   * @param state - Sync state to persist alongside the revert
   */
  revertBlocksFrom(fromHeight: number, state: SyncState): Promise<void>;

  // -- pending/mempool balance ------------------------------------------
  getPendingSpentAmount(tokenId?: string | null): Promise<bigint>;
  deleteUnconfirmedOutputsByTxHash(txHash: string): Promise<void>;

  // -- output blinding keys (secret; never part of WalletOutput) ---------
  /**
   * Persist the PRIVATE blinding scalar of an output this wallet created.
   *
   * This is the fast path for `recoverBlindingKey`; the seed derivation is the
   * fallback that survives a restore. Deliberately kept out of `WalletOutput`
   * (whose `blindingKey` is the public point) because that struct is handed to
   * callers by `getUnspentOutputs`, `getAllOutputs` and friends.
   *
   * The record is stored as given. Callers pass what
   * `sealOutputBlindingKey` returns: the scalar encrypted with the wallet key
   * for an encrypted wallet, the 64-hex scalar otherwise. Existing rows for
   * the same output are replaced.
   *
   * @param outputHash - Output hash, display hex
   * @param blindingKeyPrivate - The record (see above)
   */
  saveOutputBlindingKey(outputHash: string, blindingKeyPrivate: string): Promise<void>;
  /**
   * The stored blinding-key record for an output, or null if this wallet did
   * not create it (or created it before this feature existed). Pass it
   * through `openOutputBlindingKey` to get the scalar.
   *
   * @param outputHash - Output hash, display hex
   */
  getOutputBlindingKey(outputHash: string): Promise<string | null>;
  /**
   * The stored blinding-key records that are not encrypted (do not start with
   * `SEALED_BLINDING_KEY_PREFIX`), as saved. Used to encrypt the plaintext rows
   * of a wallet that has been encrypted since they were written.
   */
  getUnsealedOutputBlindingKeys(): Promise<Array<{ outputHash: string; blindingKey: string }>>;
  /**
   * Replace an output's blinding-key record in place, only if it still holds
   * `expected`. Unlike {@link saveOutputBlindingKey} it keeps the row's
   * creation time, and it never overwrites a record written concurrently.
   *
   * @param outputHash - Output hash, display hex
   * @param expected - The record the caller read
   * @param replacement - The record to store instead
   * @returns Whether the row was replaced
   */
  replaceOutputBlindingKey(
    outputHash: string,
    expected: string,
    replacement: string
  ): Promise<boolean>;
  /**
   * Claim the next build generation for a blinding-key anchor, persisting the
   * bump before returning.
   *
   * The deterministic blinding scalar is otherwise a pure function of
   * (seed, anchor, ordinal), so two builds over the same inputs — a resend
   * after an abandoned or failed send, say — would reuse it for different
   * amounts, and two range proofs sharing it leak both amounts. Every build
   * that derives keys claims a generation here first, so no two builds on one
   * anchor share one. Concurrent claims on one anchor never return the same
   * value, and the counter survives a restart.
   *
   * Generations count from 0 and are never handed out twice. A value at or past
   * `MAX_GENERATION_SEARCH` means the anchor is used up: the caller must use
   * random keys rather than derive one recovery could not find.
   *
   * @param anchorOutid - The canonical anchor outid, display hex
   * @returns The generation for this build
   */
  reserveBlindingGeneration(anchorOutid: string): Promise<number>;
  /**
   * How many build generations this database has handed out for an anchor
   * (the next one {@link reserveBlindingGeneration} would return), without
   * claiming one. Null when it has never handed one out.
   *
   * Only says what *this* database reserved: after a seed-only restore, or on
   * another wallet sharing the seed, outputs may exist at higher generations.
   *
   * @param anchorOutid - The canonical anchor outid, display hex
   */
  getBlindingGeneration(anchorOutid: string): Promise<number | null>;

  // -- created collections ----------------------------------------------
  saveCreatedCollection(record: CreatedCollectionRecord): Promise<void>;

  // -- standing orders (maker side) -------------------------------------
  /** Insert or replace a tracked standing order (keyed by localId). */
  saveStandingOrder(row: StandingOrderRow): Promise<void>;
  /** All tracked standing orders, oldest first. */
  getStandingOrders(): Promise<StandingOrderRow[]>;
  /** Drop a tracked standing order by localId. */
  deleteStandingOrder(localId: string): Promise<void>;
  getCreatedCollections(): Promise<CreatedCollectionRecord[]>;

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
