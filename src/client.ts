/**
 * Navio SDK Client
 * Main client class for interacting with the Navio blockchain
 *
 * This is the primary entry point for the SDK. It manages:
 * - Wallet database connection
 * - Backend connection (Electrum or P2P)
 * - Transaction keys synchronization
 * - Key management
 */

import { WalletDB, WalletDBOptions } from './wallet-db';
import { ElectrumClient, ElectrumOptions } from './electrum';
import { TransactionKeysSync, SyncOptions, BackgroundSyncOptions } from './tx-keys-sync';
import { KeyManager } from './key-manager';
import type { IWalletDB, WalletOutput } from './wallet-db.interface';
import { SyncProvider } from './sync-provider';
import { P2PSyncProvider } from './p2p-sync';
import { P2PConnectionOptions } from './p2p-protocol';
import { ElectrumSyncProvider } from './electrum-sync';
import * as blsctModule from 'navio-blsct';
import { BlsctChain, setChain } from 'navio-blsct';
import { sha256 } from '@noble/hashes/sha256';
import type { DatabaseAdapterType } from './database-adapter';

const {
  Scalar, PublicKey, SubAddr,
  Address, TokenId, CTxId, OutPoint, TxIn, TxOut,
  TxOutputType, PrivSpendingKey,
  buildCTx, createTxInVec, addToTxInVec, createTxOutVec, addToTxOutVec,
  deleteTxInVec, deleteTxOutVec, freeObj, getCTxId, serializeCTx,
} = blsctModule as any;

/**
 * Build a confidential transaction and return its serialized hex.
 * Uses serializeCTx + getCTxId from navio-blsct (works in both Node and WASM).
 */
function buildAndSerializeCTx(
  txIns: InstanceType<typeof TxIn>[],
  txOuts: InstanceType<typeof TxOut>[],
): { rawTx: string; txId: string } {
  const txInVec = createTxInVec();
  for (const txIn of txIns) addToTxInVec(txInVec, txIn.value());
  const txOutVec = createTxOutVec();
  for (const txOut of txOuts) addToTxOutVec(txOutVec, txOut.value());

  const rv = buildCTx(txInVec, txOutVec);

  if (rv.result !== 0) {
    deleteTxInVec(txInVec);
    deleteTxOutVec(txOutVec);
    const msg = `building tx failed. Error code = ${rv.result}`;
    freeObj(rv);
    throw new Error(msg);
  }

  const ctxPtr = rv.ctx;
  freeObj(rv);

  const rawTx: string = serializeCTx(ctxPtr);
  const txId: string = getCTxId(ctxPtr);

  deleteTxInVec(txInVec);
  deleteTxOutVec(txOutVec);

  return { rawTx, txId };
}

/**
 * Network type for Navio
 */
export type NetworkType = 'mainnet' | 'testnet' | 'signet' | 'regtest';

/**
 * Fee per input+output in satoshis (matches navio-core default)
 */
const DEFAULT_FEE_PER_COMPONENT = 200_000;

/**
 * Options for sending a transaction
 */
export interface SendTransactionOptions {
  /** Destination address (bech32m encoded) */
  address: string;
  /** Amount to send in satoshis */
  amount: bigint;
  /** Optional memo to include in the output */
  memo?: string;
  /** Whether to subtract the fee from the sent amount (default: false) */
  subtractFeeFromAmount?: boolean;
  /** Optional token ID (null for NAV) */
  tokenId?: string | null;
}

/**
 * Result of a sent transaction
 */
export interface SendTransactionResult {
  /** Transaction ID (hex) */
  txId: string;
  /** Serialized transaction (hex) */
  rawTx: string;
  /** Fee paid in satoshis */
  fee: bigint;
  /** Inputs used */
  inputCount: number;
  /** Outputs created (including change) */
  outputCount: number;
}

/**
 * Backend type for NavioClient
 */
export type BackendType = 'electrum' | 'p2p';

/**
 * P2P connection options for NavioClient
 */
export interface P2POptions extends P2PConnectionOptions {
  /** Maximum headers to fetch per request */
  maxHeadersPerRequest?: number;
}

/**
 * Configuration for NavioClient
 */
export interface NavioClientConfig {
  /** Path to wallet database file */
  walletDbPath: string;

  /**
   * Database adapter type to use for wallet storage.
   * - 'indexeddb' / 'browser': Native IndexedDB (used automatically in browsers)
   * - 'better-sqlite3': Node.js native SQLite (use ':memory:' path for testing)
   * 
   * If not specified, auto-detected: IndexedDB in browsers, better-sqlite3 in Node.js.
   */
  databaseAdapter?: DatabaseAdapterType;

  /**
   * Backend type to use for synchronization
   * - 'electrum': Connect to an Electrum server (recommended for wallets)
   * - 'p2p': Connect directly to a Navio full node
   * @default 'electrum'
   */
  backend?: BackendType;

  /**
   * Electrum server connection options
   * Required when backend is 'electrum'
   */
  electrum?: ElectrumOptions;

  /**
   * P2P connection options
   * Required when backend is 'p2p'
   */
  p2p?: P2POptions;

  /** Create wallet if it doesn't exist (default: false) */
  createWalletIfNotExists?: boolean;

  /** Restore wallet from seed (hex string) */
  restoreFromSeed?: string;

  /** Restore wallet from mnemonic phrase (24 words) */
  restoreFromMnemonic?: string;

  /**
   * Block height to start scanning from when restoring a wallet from seed or mnemonic.
   * This is the height when the wallet was originally created.
   * Setting this avoids scanning blocks before the wallet existed.
   *
   * Note: This option is only used when `restoreFromSeed` is provided.
   * For newly created wallets, the creation height is automatically set
   * to the current chain tip minus a safety margin (100 blocks).
   *
   * @default 0 (scan from genesis when restoring)
   */
  restoreFromHeight?: number;

  /**
   * Override the creation height for newly created wallets.
   * By default, new wallets use `chainTip - 100` to avoid scanning old blocks.
   * Set this to 0 to sync from genesis (useful for testing).
   *
   * Note: This is only used when `createWalletIfNotExists` is true and
   * no wallet exists. It does NOT override `restoreFromHeight` when
   * restoring from seed.
   */
  creationHeight?: number;

  /**
   * Network to use for address encoding/decoding and cryptographic operations.
   * This configures the navio-blsct library to use the correct chain parameters.
   *
   * @default 'mainnet'
   */
  network?: NetworkType;
}

/**
 * Navio SDK Client
 * Main client for wallet operations and blockchain synchronization.
 *
 * Supports two backend types:
 * - Electrum: Connect to an Electrum server (recommended for light wallets)
 * - P2P: Connect directly to a Navio full node (for advanced use cases)
 *
 * @example
 * // Using Electrum backend (recommended)
 * const client = new NavioClient({
 *   walletDbPath: './wallet.db',
 *   backend: 'electrum',
 *   electrum: { host: 'electrum.example.com', port: 50001, ssl: true }
 * });
 *
 * @example
 * // Using P2P backend
 * const client = new NavioClient({
 *   walletDbPath: './wallet.db',
 *   backend: 'p2p',
 *   p2p: { host: '127.0.0.1', port: 44440, network: 'mainnet' }
 * });
 *
 * @category Client
 */
export class NavioClient {
  private walletDB: IWalletDB | null = null;
  private syncProvider: SyncProvider;
  private syncManager: TransactionKeysSync | null = null;
  private keyManager: KeyManager | null = null;
  private config: NavioClientConfig;
  private initialized = false;

  // Legacy: keep electrumClient reference for backwards compatibility
  private electrumClient: ElectrumClient | null = null;

  // Background sync state
  private backgroundSyncTimer: ReturnType<typeof setInterval> | null = null;
  private backgroundSyncOptions: BackgroundSyncOptions | null = null;
  private isBackgroundSyncing = false;
  private isSyncInProgress = false;
  private lastKnownBalance: bigint = 0n;

  // Block header subscription callback (for unsubscribe)
  private blockHeaderCallback: ((header: { height: number; hex: string }) => void) | null = null;
  private usingSubscriptions = false;

  /**
   * Create a new NavioClient instance
   * @param config - Client configuration
   */
  constructor(config: NavioClientConfig) {
    // Handle legacy config (just electrum, no backend specified)
    if ('electrum' in config && !('backend' in config)) {
      this.config = {
        ...config,
        backend: 'electrum',
      };
    } else {
      this.config = config as NavioClientConfig;
    }

    // Default to electrum if no backend specified
    this.config.backend = this.config.backend || 'electrum';

    // Default to mainnet if no network specified
    this.config.network = this.config.network || 'mainnet';

    // Configure navio-blsct for the correct network
    NavioClient.configureNetwork(this.config.network);

    // Validate config
    if (this.config.backend === 'electrum' && !this.config.electrum) {
      throw new Error('Electrum options required when backend is "electrum"');
    }
    if (this.config.backend === 'p2p' && !this.config.p2p) {
      throw new Error('P2P options required when backend is "p2p"');
    }

    // Create sync provider based on backend type
    if (this.config.backend === 'p2p') {
      this.syncProvider = new P2PSyncProvider(this.config.p2p!);
    } else {
      // Electrum backend
      this.electrumClient = new ElectrumClient(this.config.electrum!);
      this.syncProvider = new ElectrumSyncProvider(this.config.electrum!);
    }

    // Note: WalletDB and SyncManager are created in initialize() since open() is async
  }

  /**
   * Parse the walletDbPath and determine adapter options
   */
  private getWalletDbOptions(): { path: string; options: WalletDBOptions } {
    const path = this.config.walletDbPath;
    const options: WalletDBOptions = {};

    // Use explicit adapter type if specified
    if (this.config.databaseAdapter) {
      options.type = this.config.databaseAdapter;
    }

    return { path, options };
  }

  /**
   * Configure the navio-blsct library for the specified network
   */
  private static configureNetwork(network: NetworkType): void {
    const chainMap: Record<NetworkType, BlsctChain> = {
      mainnet: BlsctChain.Mainnet,
      testnet: BlsctChain.Testnet,
      signet: BlsctChain.Signet,
      regtest: BlsctChain.Regtest,
    };

    setChain(chainMap[network]);
  }

  /**
   * Get the current network configuration
   */
  getNetwork(): NetworkType {
    return this.config.network || 'mainnet';
  }

  /**
   * Safety margin (in blocks) when setting creation height for new wallets.
   * This ensures we don't miss any transactions that might be in recent blocks.
   */
  private static readonly CREATION_HEIGHT_MARGIN = 100;

  /**
   * Initialize the client
   * Loads or creates wallet, connects to backend, and initializes sync manager
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Create and open WalletDB
    // Browser environments use IndexedDB (no WASM needed).
    // Node.js environments use the SQL adapter (better-sqlite3).
    const adapterType = this.config.databaseAdapter;
    const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
    const useIndexedDB = adapterType === 'indexeddb'
      || adapterType === 'browser'
      || (!adapterType && isBrowser);

    if (useIndexedDB) {
      const { IndexedDBWalletDB } = await import('./adapters/indexeddb-wallet-db');
      this.walletDB = new IndexedDBWalletDB();
      await this.walletDB.open(this.config.walletDbPath);
    } else {
      const { path, options } = this.getWalletDbOptions();
      this.walletDB = new WalletDB(options);
      await this.walletDB.open(path);
    }

    // Create sync manager now that WalletDB is ready
    this.syncManager = new TransactionKeysSync(this.walletDB, this.syncProvider);

    // Load or create wallet
    if (this.config.restoreFromSeed) {
      // Restore from seed with user-provided height (or 0 to scan from genesis)
      this.keyManager = await this.walletDB.restoreWallet(
        this.config.restoreFromSeed,
        this.config.restoreFromHeight
      );

      // Set KeyManager for sync manager (enables output detection)
      this.syncManager.setKeyManager(this.keyManager);

      // Connect to backend
      await this.syncProvider.connect();
    } else if (this.config.restoreFromMnemonic) {
      // Restore from mnemonic with user-provided height (or 0 to scan from genesis)
      this.keyManager = await this.walletDB.restoreWalletFromMnemonic(
        this.config.restoreFromMnemonic,
        this.config.restoreFromHeight
      );

      // Set KeyManager for sync manager (enables output detection)
      this.syncManager.setKeyManager(this.keyManager);

      // Connect to backend
      await this.syncProvider.connect();
    } else {
      // Try to load existing wallet
      let walletLoaded = false;
      try {
        this.keyManager = await this.walletDB.loadWallet();
        walletLoaded = true;
      } catch {
        // Wallet doesn't exist in the database
      }

      if (walletLoaded) {
        this.syncManager.setKeyManager(this.keyManager!);
        await this.syncProvider.connect();
      } else if (this.config.createWalletIfNotExists) {
        // Determine creation height
        let creationHeight: number;

        if (this.config.creationHeight !== undefined) {
          creationHeight = this.config.creationHeight;
        } else {
          await this.syncProvider.connect();
          const chainTip = await this.syncProvider.getChainTipHeight();
          creationHeight = Math.max(0, chainTip - NavioClient.CREATION_HEIGHT_MARGIN);
        }

        this.keyManager = await this.walletDB.createWallet(creationHeight);
        this.syncManager.setKeyManager(this.keyManager);
      } else {
        throw new Error(
          `Wallet not found at ${this.config.walletDbPath}. ` +
            `Set createWalletIfNotExists: true to create a new wallet.`
        );
      }
    }

    // Initialize sync manager
    await this.syncManager.initialize();

    this.initialized = true;
  }

  /**
   * Get the backend type being used
   */
  getBackendType(): BackendType {
    return this.config.backend || 'electrum';
  }

  /**
   * Get the sync provider
   */
  getSyncProvider(): SyncProvider {
    return this.syncProvider;
  }

  /**
   * Get the KeyManager instance
   * @returns KeyManager instance
   */
  getKeyManager(): KeyManager {
    if (!this.keyManager) {
      throw new Error('Client not initialized. Call initialize() first.');
    }
    return this.keyManager;
  }

  /**
   * Get the WalletDB instance
   * @returns WalletDB instance (WalletDB or IndexedDBWalletDB)
   */
  getWalletDB(): IWalletDB {
    if (!this.walletDB) {
      throw new Error('Client not initialized. Call initialize() first.');
    }
    return this.walletDB;
  }

  /**
   * Get the ElectrumClient instance (only available when using electrum backend)
   * @returns ElectrumClient instance or null if using P2P backend
   * @deprecated Use getSyncProvider() instead for backend-agnostic code
   */
  getElectrumClient(): ElectrumClient | null {
    return this.electrumClient;
  }

  /**
   * Get the TransactionKeysSync instance
   * @returns TransactionKeysSync instance
   */
  getSyncManager(): TransactionKeysSync {
    if (!this.syncManager) {
      throw new Error('Client not initialized. Call initialize() first.');
    }
    return this.syncManager;
  }

  /**
   * Synchronize transaction keys from the backend.
   * 
   * By default, syncs once to the current chain tip and returns.
   * Use `startBackgroundSync()` to enable continuous synchronization.
   * 
   * @param options - Sync options
   * @returns Number of transaction keys synced
   */
  async sync(options?: SyncOptions): Promise<number> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.syncManager) {
      throw new Error('Client not initialized');
    }
    return this.syncManager.sync(options || {});
  }

  // ============================================================
  // Background Sync Methods
  // ============================================================

  /**
   * Start continuous background synchronization.
   * 
   * The client will poll for new blocks and automatically sync new transactions.
   * Callbacks are invoked for new blocks, transactions, and balance changes.
   * 
   * @param options - Background sync options
   * 
   * @example
   * ```typescript
   * await client.startBackgroundSync({
   *   pollInterval: 10000, // Check every 10 seconds
   *   onNewBlock: (height) => console.log(`New block: ${height}`),
   *   onBalanceChange: (newBal, oldBal) => {
   *     console.log(`Balance changed: ${Number(oldBal)/1e8} -> ${Number(newBal)/1e8} NAV`);
   *   },
   *   onError: (err) => console.error('Sync error:', err),
   * });
   * ```
   */
  async startBackgroundSync(options: BackgroundSyncOptions = {}): Promise<void> {
    if (this.isBackgroundSyncing) {
      return; // Already running
    }

    if (!this.initialized) {
      await this.initialize();
    }

    this.backgroundSyncOptions = {
      pollInterval: options.pollInterval ?? 10000,
      ...options,
    };
    this.isBackgroundSyncing = true;

    // Get initial balance
    this.lastKnownBalance = await this.getBalance();

    // Perform initial sync to tip
    await this.performBackgroundSync();

    // Try to use subscriptions if available (Electrum backend supports this)
    if (this.syncProvider.subscribeBlockHeaders) {
      try {
        // Create callback for block notifications
        this.blockHeaderCallback = async (_header: { height: number; hex: string }) => {
          // New block received - trigger sync
          await this.performBackgroundSync();
        };

        // Subscribe to block headers
        await this.syncProvider.subscribeBlockHeaders(this.blockHeaderCallback);
        this.usingSubscriptions = true;

        // Still use polling as backup, but with longer interval when using subscriptions
        // This handles cases where subscription notifications might be missed
        const backupInterval = Math.max(this.backgroundSyncOptions.pollInterval! * 3, 30000);
        this.backgroundSyncTimer = setInterval(async () => {
          await this.performBackgroundSync();
        }, backupInterval);

        return;
      } catch (error) {
        // Subscription failed, fall back to polling
        console.warn('Block header subscription failed, falling back to polling:', error);
        this.usingSubscriptions = false;
        this.blockHeaderCallback = null;
      }
    }

    // Polling-based sync (for P2P backend or when subscriptions fail)
    this.backgroundSyncTimer = setInterval(async () => {
      await this.performBackgroundSync();
    }, this.backgroundSyncOptions.pollInterval!);
  }

  /**
   * Stop background synchronization.
   */
  stopBackgroundSync(): void {
    // Stop polling timer
    if (this.backgroundSyncTimer) {
      clearInterval(this.backgroundSyncTimer);
      this.backgroundSyncTimer = null;
    }

    // Unsubscribe from block headers if using subscriptions
    if (this.usingSubscriptions && this.blockHeaderCallback && this.syncProvider.unsubscribeBlockHeaders) {
      this.syncProvider.unsubscribeBlockHeaders(this.blockHeaderCallback);
    }

    this.blockHeaderCallback = null;
    this.usingSubscriptions = false;
    this.isBackgroundSyncing = false;
    this.backgroundSyncOptions = null;
  }

  /**
   * Check if background sync is running.
   * @returns True if background sync is active
   */
  isBackgroundSyncActive(): boolean {
    return this.isBackgroundSyncing;
  }

  /**
   * Check if background sync is using real-time subscriptions.
   * When true, the client receives instant notifications on new blocks.
   * When false, the client uses polling at the configured interval.
   * @returns True if using subscriptions
   */
  isUsingSubscriptions(): boolean {
    return this.usingSubscriptions;
  }

  /**
   * Perform a single background sync cycle.
   * Called by the polling timer.
   */
  private async performBackgroundSync(): Promise<void> {
    if (this.isSyncInProgress) {
      return; // Skip if sync already in progress
    }

    this.isSyncInProgress = true;
    const opts = this.backgroundSyncOptions;

    try {
      // Check if we need to sync
      const needsSync = await this.isSyncNeeded();
      const chainTip = await this.syncProvider.getChainTipHeight();
      const lastSynced = this.getLastSyncedHeight();

      if (!needsSync) {
        // Fire onProgress once so callers know the current state
        if (opts?.onProgress) {
          opts.onProgress(lastSynced, chainTip, 0, 0, false);
        }
        this.isSyncInProgress = false;
        return;
      }

      // Sync to tip
      if (!this.syncManager) {
        throw new Error('Client not initialized');
      }
      await this.syncManager.sync({
        onProgress: opts?.onProgress,
        saveInterval: opts?.saveInterval,
        verifyHashes: opts?.verifyHashes,
        keepTxKeys: opts?.keepTxKeys,
        blockHashRetention: opts?.blockHashRetention,
        stopOnReorg: false,
      });

      // Notify of new block(s) if we synced past our last known height
      if (opts?.onNewBlock && chainTip > lastSynced) {
        // Get the block hash for the tip
        try {
          const headerHex = await this.syncProvider.getBlockHeader(chainTip);
          const hash = this.hashBlockHeader(headerHex);
          opts.onNewBlock(chainTip, hash);
        } catch {
          opts.onNewBlock(chainTip, '');
        }
      }

      // Check for balance change
      if (opts?.onBalanceChange) {
        const newBalance = await this.getBalance();
        if (newBalance !== this.lastKnownBalance) {
          opts.onBalanceChange(newBalance, this.lastKnownBalance);
          this.lastKnownBalance = newBalance;
        }
      }

    } catch (error) {
      if (opts?.onError) {
        opts.onError(error as Error);
      }
    } finally {
      this.isSyncInProgress = false;
    }
  }

  /**
   * Check if synchronization is needed
   * @returns True if sync is needed
   */
  async isSyncNeeded(): Promise<boolean> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.syncManager) {
      throw new Error('Client not initialized');
    }
    return this.syncManager.isSyncNeeded();
  }

  /**
   * Get last synced block height
   * @returns Last synced height, or -1 if never synced
   */
  getLastSyncedHeight(): number {
    if (!this.syncManager) {
      return -1;
    }
    return this.syncManager.getLastSyncedHeight();
  }

  /**
   * Get sync state
   * @returns Current sync state
   */
  getSyncState() {
    if (!this.syncManager) {
      return null;
    }
    return this.syncManager.getSyncState();
  }

  /**
   * Get the wallet creation height (block height to start scanning from)
   * @returns Creation height or 0 if not set
   */
  async getCreationHeight(): Promise<number> {
    if (!this.walletDB) {
      throw new Error('Client not initialized');
    }
    return this.walletDB.getCreationHeight();
  }

  /**
   * Set the wallet creation height
   * @param height - Block height when wallet was created
   */
  async setCreationHeight(height: number): Promise<void> {
    if (!this.walletDB) {
      throw new Error('Client not initialized');
    }
    await this.walletDB.setCreationHeight(height);
  }

  /**
   * Get wallet metadata
   * @returns Wallet metadata or null if not available
   */
  async getWalletMetadata(): Promise<{
    creationHeight: number;
    creationTime: number;
    restoredFromSeed: boolean;
    version: number;
  } | null> {
    if (!this.walletDB) {
      throw new Error('Client not initialized');
    }
    return this.walletDB.getWalletMetadata();
  }

  /**
   * Get chain tip from the backend
   * @returns Current chain tip height and hash
   */
  async getChainTip(): Promise<{ height: number; hash: string }> {
    if (!this.initialized) {
      await this.initialize();
    }

    const height = await this.syncProvider.getChainTipHeight();

    // For P2P provider, we can get the chain tip directly if available
    if (this.config.backend === 'p2p') {
      const p2pProvider = this.syncProvider as any;
      if (typeof p2pProvider.getChainTip === 'function') {
        return p2pProvider.getChainTip();
      }
    }

    // Fallback: try to get header at tip height
    try {
      const headerHex = await this.syncProvider.getBlockHeader(height);
      const hash = this.hashBlockHeader(headerHex);
      return { height, hash };
    } catch {
      // If we can't get the header, return height with empty hash
      return { height, hash: '' };
    }
  }

  /**
   * Disconnect from backend and close database
   */
  async disconnect(): Promise<void> {
    // Stop background sync if running
    this.stopBackgroundSync();

    if (this.syncProvider) {
      this.syncProvider.disconnect();
    }
    if (this.walletDB) {
      await this.walletDB.close();
    }
    this.initialized = false;
  }

  /**
   * Get the current configuration
   */
  getConfig(): NavioClientConfig {
    return { ...this.config };
  }

  /**
   * Check if client is connected to the backend
   */
  isConnected(): boolean {
    return this.syncProvider?.isConnected() ?? false;
  }

  /**
   * Hash a block header to get block hash
   */
  private hashBlockHeader(headerHex: string): string {
    const headerBytes = Buffer.from(headerHex, 'hex');
    const hash = sha256(sha256(headerBytes));
    return Buffer.from(hash).reverse().toString('hex');
  }

  // ============================================================
  // Wallet Balance & Output Methods
  // ============================================================

  /**
   * Get wallet balance in satoshis
   * @param tokenId - Optional token ID to filter by (null for NAV)
   * @returns Balance in satoshis as bigint
   */
  async getBalance(tokenId: string | null = null): Promise<bigint> {
    if (!this.walletDB) {
      throw new Error('Client not initialized');
    }
    return this.walletDB.getBalance(tokenId);
  }

  /**
   * Get wallet balance in NAV (with decimals)
   * @param tokenId - Optional token ID to filter by (null for NAV)
   * @returns Balance as a number with 8 decimal places
   */
  async getBalanceNav(tokenId: string | null = null): Promise<number> {
    const balanceSatoshis = await this.getBalance(tokenId);
    return Number(balanceSatoshis) / 1e8;
  }

  /**
   * Get unspent outputs (UTXOs)
   * @param tokenId - Optional token ID to filter by (null for NAV)
   * @returns Array of unspent wallet outputs
   */
  async getUnspentOutputs(tokenId: string | null = null): Promise<WalletOutput[]> {
    if (!this.walletDB) {
      throw new Error('Client not initialized');
    }
    return this.walletDB.getUnspentOutputs(tokenId);
  }

  /**
   * Get all wallet outputs (spent and unspent)
   * @returns Array of all wallet outputs
   */
  async getAllOutputs(): Promise<WalletOutput[]> {
    if (!this.walletDB) {
      throw new Error('Client not initialized');
    }
    return this.walletDB.getAllOutputs();
  }

  // ============================================================
  // Transaction Creation & Broadcasting
  // ============================================================

  /**
   * Send NAV (or a token) to a destination address.
   *
   * Selects UTXOs, builds a confidential transaction with change,
   * and broadcasts it via the connected backend.
   *
   * @param options - Send options (address, amount, memo, etc.)
   * @returns Transaction result with txId and details
   *
   * @example
   * ```typescript
   * const result = await client.sendTransaction({
   *   address: 'tnv1...',
   *   amount: 100_000_000n, // 1 NAV
   *   memo: 'Payment',
   * });
   * console.log('Sent tx:', result.txId);
   * ```
   */
  async sendTransaction(options: SendTransactionOptions): Promise<SendTransactionResult> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.keyManager || !this.walletDB) {
      throw new Error('Client not initialized');
    }
    if (!this.isConnected()) {
      throw new Error('Not connected to backend. Please reconnect before sending.');
    }
    if (!this.keyManager.isUnlocked()) {
      throw new Error('Wallet is locked. Unlock it before sending.');
    }

    const {
      address,
      amount,
      memo = '',
      subtractFeeFromAmount = false,
      tokenId = null,
    } = options;

    if (amount <= 0n) {
      throw new Error('Amount must be positive');
    }

    // --- Decode destination address ---
    const destSubAddr = NavioClient.decodeAddress(address);

    // --- Select inputs ---
    const utxos = await this.walletDB.getUnspentOutputs(tokenId);
    if (utxos.length === 0) {
      throw new Error('No unspent outputs available');
    }

    const { selected, totalIn } = NavioClient.selectInputs(utxos, amount, subtractFeeFromAmount);

    // Calculate fee: (inputs + 2 outputs) * DEFAULT_FEE_PER_COMPONENT
    // 2 outputs = destination + change (change may be zero but the fee estimate includes it)
    const numComponents = selected.length + 2;
    const fee = BigInt(numComponents * DEFAULT_FEE_PER_COMPONENT);

    let sendAmount: bigint;
    let changeAmount: bigint;

    if (subtractFeeFromAmount) {
      sendAmount = amount - fee;
      if (sendAmount <= 0n) {
        throw new Error(`Fee (${fee} sat) exceeds send amount (${amount} sat)`);
      }
      changeAmount = totalIn - amount;
    } else {
      sendAmount = amount;
      const needed = amount + fee;
      if (totalIn < needed) {
        throw new Error(
          `Insufficient funds: need ${needed} sat (${amount} + ${fee} fee) but only have ${totalIn} sat`
        );
      }
      changeAmount = totalIn - amount - fee;
    }

    // --- Build token ID ---
    const blsctTokenId = tokenId
      ? TokenId.deserialize(tokenId)
      : TokenId.default();

    // --- Build inputs ---
    const txIns: InstanceType<typeof TxIn>[] = [];
    for (const utxo of selected) {
      const txIn = this.buildTxInput(utxo, blsctTokenId);
      txIns.push(txIn);
    }

    // --- Build outputs ---
    const txOuts: InstanceType<typeof TxOut>[] = [];

    // Destination output
    const destTxOut = TxOut.generate(
      destSubAddr,
      Number(sendAmount),
      memo,
      blsctTokenId,
      TxOutputType.Normal,
      0,
      false,
      Scalar.random(),
    );
    txOuts.push(destTxOut);

    // Change output (send back to ourselves at a change sub-address)
    if (changeAmount > 0n) {
      const changeSubAddr = this.getChangeSubAddress();
      const changeTxOut = TxOut.generate(
        changeSubAddr,
        Number(changeAmount),
        '',
        blsctTokenId,
        TxOutputType.Normal,
        0,
        false,
        Scalar.random(),
      );
      txOuts.push(changeTxOut);
    }

    // --- Build and serialize the confidential transaction ---
    const { rawTx, txId } = buildAndSerializeCTx(txIns, txOuts);

    // --- Broadcast ---
    await this.broadcastRawTransaction(rawTx);

    // --- Mark spent outputs ---
    for (const utxo of selected) {
      await this.walletDB.markOutputSpent(utxo.outputHash, txId, 0);
    }

    return {
      txId,
      rawTx,
      fee,
      inputCount: txIns.length,
      outputCount: txOuts.length,
    };
  }

  /**
   * Broadcast a raw transaction hex via the connected backend.
   * @param rawTx - Serialized transaction hex
   * @returns Transaction hash returned by the server
   */
  async broadcastRawTransaction(rawTx: string): Promise<string> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.isConnected()) {
      throw new Error('Not connected to backend. Please reconnect before broadcasting.');
    }

    // Use the sync provider which holds the active connection
    const provider = this.syncProvider as any;
    if (typeof provider.broadcastTransaction === 'function') {
      return provider.broadcastTransaction(rawTx);
    }

    throw new Error('Connected backend does not support transaction broadcasting');
  }

  /**
   * Decode a bech32m address string into a SubAddr for use as a destination.
   */
  private static decodeAddress(addressStr: string): InstanceType<typeof SubAddr> {
    try {
      const dpk = Address.decode(addressStr);
      return SubAddr.fromDoublePublicKey(dpk);
    } catch (err: any) {
      throw new Error(`Invalid address "${addressStr}": ${err.message}`);
    }
  }

  /**
   * Select UTXOs to cover the target amount.
   * Uses a simple largest-first strategy.
   */
  private static selectInputs(
    utxos: WalletOutput[],
    targetAmount: bigint,
    subtractFee: boolean,
  ): { selected: WalletOutput[]; totalIn: bigint } {
    // Sort descending by amount for efficient selection
    const sorted = [...utxos].sort((a, b) => {
      if (b.amount > a.amount) return 1;
      if (b.amount < a.amount) return -1;
      return 0;
    });

    const selected: WalletOutput[] = [];
    let totalIn = 0n;

    for (const utxo of sorted) {
      selected.push(utxo);
      totalIn += utxo.amount;

      // Estimate fee with current selection
      const numComponents = selected.length + 2;
      const estimatedFee = BigInt(numComponents * DEFAULT_FEE_PER_COMPONENT);
      const needed = subtractFee ? targetAmount : targetAmount + estimatedFee;

      if (totalIn >= needed) {
        return { selected, totalIn };
      }
    }

    // Not enough, but return what we have; the caller will check and throw
    return { selected, totalIn };
  }

  /**
   * Build a TxIn from a wallet output.
   */
  private buildTxInput(
    utxo: WalletOutput,
    tokenId: InstanceType<typeof TokenId>,
  ): InstanceType<typeof TxIn> {
    if (!this.keyManager) {
      throw new Error('KeyManager not available');
    }

    // Reconstruct the blinding public key from the stored hex
    const blindingPubKey = PublicKey.deserialize(utxo.blindingKey);

    // Derive the private spending key for this output
    const viewKey = this.keyManager.getPrivateViewKey();
    const masterSpendKey = this.keyManager.getSpendingKey();

    // Find the sub-address this output belongs to via hash ID
    const spendingPubKey = PublicKey.deserialize(utxo.spendingKey);
    const hashId = this.keyManager.calculateHashId(blindingPubKey, spendingPubKey);
    const subAddrId = { account: 0, address: 0 };
    this.keyManager.getSubAddressId(hashId, subAddrId);

    // Compute the private spending key for this output
    const privSpendingKey = new PrivSpendingKey(
      blindingPubKey,
      viewKey,
      masterSpendKey,
      subAddrId.account,
      subAddrId.address,
    );

    const ctxId = CTxId.deserialize(utxo.outputHash);
    const outPoint = OutPoint.generate(ctxId, 0);

    return TxIn.generate(
      Number(utxo.amount),
      0,
      privSpendingKey,
      tokenId,
      outPoint,
    );
  }

  /**
   * Get a SubAddr for receiving change.
   * Uses the change account (account -1).
   */
  private getChangeSubAddress(): InstanceType<typeof SubAddr> {
    if (!this.keyManager) {
      throw new Error('KeyManager not available');
    }
    return this.keyManager.getSubAddress({ account: -1, address: 0 });
  }
}
