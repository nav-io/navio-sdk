/**
 * Navio SDK Client
 * Main client class for interacting with the Navio blockchain
 * 
 * This is the primary entry point for the SDK. It manages:
 * - Wallet database connection
 * - Electrum server connection
 * - Transaction keys synchronization
 * - Key management
 */

import { WalletDB } from './wallet-db';
import { ElectrumClient, ElectrumOptions } from './electrum';
import { TransactionKeysSync, SyncOptions } from './tx-keys-sync';
import { KeyManager } from './key-manager';

/**
 * Configuration for NavioClient
 */
export interface NavioClientConfig {
  /** Path to wallet database file */
  walletDbPath: string;
  /** Electrum server connection options */
  electrum: ElectrumOptions;
  /** Create wallet if it doesn't exist (default: false) */
  createWalletIfNotExists?: boolean;
  /** Restore wallet from seed (hex string) */
  restoreFromSeed?: string;
}

/**
 * Navio SDK Client
 * Main client for wallet operations and blockchain synchronization
 */
export class NavioClient {
  private walletDB: WalletDB;
  private electrumClient: ElectrumClient;
  private syncManager: TransactionKeysSync;
  private keyManager: KeyManager | null = null;
  private config: NavioClientConfig;
  private initialized = false;

  /**
   * Create a new NavioClient instance
   * @param config - Client configuration
   */
  constructor(config: NavioClientConfig) {
    this.config = config;
    
    // Initialize components
    this.walletDB = new WalletDB(config.walletDbPath);
    this.electrumClient = new ElectrumClient(config.electrum);
    this.syncManager = new TransactionKeysSync(this.walletDB, this.electrumClient);
  }

  /**
   * Initialize the client
   * Loads or creates wallet, connects to Electrum server, and initializes sync manager
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Load or create wallet
    if (this.config.restoreFromSeed) {
      this.keyManager = await this.walletDB.restoreWallet(this.config.restoreFromSeed);
    } else {
      try {
        this.keyManager = await this.walletDB.loadWallet();
      } catch (error) {
        if (this.config.createWalletIfNotExists) {
          this.keyManager = await this.walletDB.createWallet();
        } else {
          throw new Error(
            `Wallet not found at ${this.config.walletDbPath}. ` +
            `Set createWalletIfNotExists: true to create a new wallet.`
          );
        }
      }
    }

    // Set KeyManager for sync manager (enables output detection)
    this.syncManager.setKeyManager(this.keyManager);

    // Connect to Electrum server
    await this.electrumClient.connect();

    // Initialize sync manager
    await this.syncManager.initialize();

    this.initialized = true;
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
   * Get the ElectrumClient instance
   * @returns ElectrumClient instance
   */
  getElectrumClient(): ElectrumClient {
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
   * Synchronize transaction keys from Electrum server
   * @param options - Sync options
   * @returns Number of transaction keys synced
   */
  async sync(options?: SyncOptions): Promise<number> {
    if (!this.initialized) {
      await this.initialize();
    }

    return this.syncManager.sync(options || {});
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
   * Disconnect from Electrum server and close database
   */
  async disconnect(): Promise<void> {
    if (this.electrumClient) {
      await this.electrumClient.disconnect();
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
}
