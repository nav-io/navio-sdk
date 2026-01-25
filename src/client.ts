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

import { WalletDB } from './wallet-db';
import { ElectrumClient, ElectrumOptions } from './electrum';
import { TransactionKeysSync, SyncOptions, BackgroundSyncOptions } from './tx-keys-sync';
import { KeyManager } from './key-manager';
import { SyncProvider } from './sync-provider';
import { P2PSyncProvider } from './p2p-sync';
import { P2PConnectionOptions } from './p2p-protocol';
import { ElectrumSyncProvider } from './electrum-sync';
import { BlsctChain, setChain } from 'navio-blsct';
import { sha256 } from '@noble/hashes/sha256';

/**
 * Network type for Navio
 */
export type NetworkType = 'mainnet' | 'testnet' | 'signet' | 'regtest';

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

  /**
   * Block height to start scanning from when restoring a wallet from seed.
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
  private walletDB: WalletDB;
  private syncProvider: SyncProvider;
  private syncManager: TransactionKeysSync;
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

    // Initialize components
    this.walletDB = new WalletDB(this.config.walletDbPath);

    // Create sync provider based on backend type
    if (this.config.backend === 'p2p') {
      this.syncProvider = new P2PSyncProvider(this.config.p2p!);
    } else {
      // Electrum backend
      this.electrumClient = new ElectrumClient(this.config.electrum!);
      this.syncProvider = new ElectrumSyncProvider(this.config.electrum!);
    }

    this.syncManager = new TransactionKeysSync(this.walletDB, this.syncProvider);
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
    } else {
      try {
        this.keyManager = await this.walletDB.loadWallet();

        // Set KeyManager for sync manager (enables output detection)
        this.syncManager.setKeyManager(this.keyManager);

        // Connect to backend
        await this.syncProvider.connect();
      } catch (error) {
        if (this.config.createWalletIfNotExists) {
          // Determine creation height
          let creationHeight: number;

          if (this.config.creationHeight !== undefined) {
            // Use explicitly provided creation height
            creationHeight = this.config.creationHeight;
          } else {
            // For new wallets, connect first to get the current chain height
            await this.syncProvider.connect();

            // Get current chain tip and subtract safety margin
            const chainTip = await this.syncProvider.getChainTipHeight();
            creationHeight = Math.max(0, chainTip - NavioClient.CREATION_HEIGHT_MARGIN);
          }

          // Create new wallet with specified height as creation point
          this.keyManager = await this.walletDB.createWallet(creationHeight);

          // Set KeyManager for sync manager (enables output detection)
          this.syncManager.setKeyManager(this.keyManager);
        } else {
          throw new Error(
            `Wallet not found at ${this.config.walletDbPath}. ` +
              `Set createWalletIfNotExists: true to create a new wallet.`
          );
        }
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
   * @returns WalletDB instance
   */
  getWalletDB(): WalletDB {
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

    // Start polling
    this.backgroundSyncTimer = setInterval(async () => {
      await this.performBackgroundSync();
    }, this.backgroundSyncOptions.pollInterval!);
  }

  /**
   * Stop background synchronization.
   */
  stopBackgroundSync(): void {
    if (this.backgroundSyncTimer) {
      clearInterval(this.backgroundSyncTimer);
      this.backgroundSyncTimer = null;
    }
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
      
      if (!needsSync) {
        this.isSyncInProgress = false;
        return;
      }

      // Get current tip for onNewBlock callback
      const chainTip = await this.syncProvider.getChainTipHeight();
      const lastSynced = this.getLastSyncedHeight();

      // Sync to tip
      await this.syncManager.sync({
        onProgress: opts?.onProgress,
        saveInterval: opts?.saveInterval,
        verifyHashes: opts?.verifyHashes,
        keepTxKeys: opts?.keepTxKeys,
        blockHashRetention: opts?.blockHashRetention,
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

    return this.syncManager.isSyncNeeded();
  }

  /**
   * Get last synced block height
   * @returns Last synced height, or -1 if never synced
   */
  getLastSyncedHeight(): number {
    return this.syncManager.getLastSyncedHeight();
  }

  /**
   * Get sync state
   * @returns Current sync state
   */
  getSyncState() {
    return this.syncManager.getSyncState();
  }

  /**
   * Get the wallet creation height (block height to start scanning from)
   * @returns Creation height or 0 if not set
   */
  async getCreationHeight(): Promise<number> {
    return this.walletDB.getCreationHeight();
  }

  /**
   * Set the wallet creation height
   * @param height - Block height when wallet was created
   */
  async setCreationHeight(height: number): Promise<void> {
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
  async getUnspentOutputs(tokenId: string | null = null): Promise<import('./wallet-db').WalletOutput[]> {
    return this.walletDB.getUnspentOutputs(tokenId);
  }

  /**
   * Get all wallet outputs (spent and unspent)
   * @returns Array of all wallet outputs
   */
  async getAllOutputs(): Promise<import('./wallet-db').WalletOutput[]> {
    return this.walletDB.getAllOutputs();
  }
}
