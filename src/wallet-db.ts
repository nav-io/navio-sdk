/**
 * WalletDB - Database persistence layer for KeyManager
 * 
 * Provides cross-platform SQLite database support with efficient page-level persistence:
 * - Browser: wa-sqlite with OPFS (best performance, requires Web Worker)
 * - Browser fallback: wa-sqlite with IndexedDB (for Safari incognito, etc.)
 * - Node.js: better-sqlite3 (native bindings, best performance)
 * - In-memory: better-sqlite3 with ':memory:' path (for testing)
 *
 * All adapters use page-level persistence - only changed blocks are written,
 * making them efficient for databases of any size.
 *
 * Database schema replicates navio-core wallet database structure.
 * 
 * @example
 * ```typescript
 * // Auto-detect best adapter for environment
 * const db = new WalletDB();
 * await db.open('wallet.db');
 * 
 * // In-memory database
 * const db = new WalletDB({ type: 'memory' });
 * await db.open(':memory:');
 * 
 * // Force specific adapter
 * const db = new WalletDB({ type: 'better-sqlite3' });
 * await db.open('./wallet.db');
 * ```
 */

import { KeyManager } from './key-manager';
import type { HDChain, SubAddressIdentifier } from './key-manager.types';
import * as blsctModule from 'navio-blsct';
import type { IDatabaseAdapter, DatabaseAdapterOptions } from './database-adapter';
import { createDatabaseAdapter } from './database-adapter';
import type { SyncState, StoreOutputParams } from './wallet-db.interface';
export type { SyncState, WalletOutput, WalletMetadata, StoreOutputParams, IWalletDB } from './wallet-db.interface';

// WalletOutput is re-exported from wallet-db.interface.ts
import type { WalletOutput } from './wallet-db.interface';

/**
 * Options for WalletDB
 */
export interface WalletDBOptions extends DatabaseAdapterOptions {
  /** Custom database adapter (overrides type) */
  adapter?: IDatabaseAdapter;
}

/**
 * WalletDB - Manages wallet database persistence.
 * 
 * Provides cross-platform SQLite database support with efficient page-level persistence.
 * The adapter is auto-detected based on the runtime environment:
 * - Browser: wa-sqlite with OPFS (best) or IndexedDB (fallback)
 * - Node.js: better-sqlite3 (native bindings)
 * - Testing: better-sqlite3 with ':memory:' path
 * 
 * All database operations are async to support Web Worker-based adapters.
 * 
 * @example
 * ```typescript
 * // Auto-detect best adapter
 * const db = new WalletDB();
 * await db.open('wallet.db');
 * const km = await db.loadWallet();
 * 
 * // Force Node.js adapter
 * const db = new WalletDB({ type: 'better-sqlite3' });
 * await db.open('./wallet.db');
 * 
 * // Use custom adapter
 * const adapter = new MyCustomAdapter();
 * const db = new WalletDB({ adapter });
 * await db.open('wallet.db');
 * ```
 * 
 * @category Wallet
 */
export class WalletDB {
  private adapter: IDatabaseAdapter | null = null;
  private adapterOptions: WalletDBOptions;
  private dbPath: string = '';
  private keyManager: KeyManager | null = null;
  private opened = false;

  /**
   * Create a new WalletDB instance
   * @param options - Database adapter options
   */
  constructor(options: WalletDBOptions = {}) {
    this.adapterOptions = options;

    // Use provided adapter if given
    if (options.adapter) {
      this.adapter = options.adapter;
    }
  }

  /**
   * Open the database
   * @param path - Database path/name
   * @param data - Optional initial data to import
   */
  async open(path: string, data?: Uint8Array): Promise<void> {
    if (this.opened) {
      throw new Error('Database already open');
    }

    this.dbPath = path;

    // Create adapter if not provided
    if (!this.adapter) {
      this.adapter = await createDatabaseAdapter(this.adapterOptions);
    }

    // Open the database
    await this.adapter.open(path, data);

    // Create schema
    await this.createSchema();
    this.opened = true;
  }

  /**
   * Check if the database is open
   */
  isOpen(): boolean {
    return this.opened && this.adapter !== null && this.adapter.isOpen();
  }

  /**
   * Get the adapter type being used
   */
  getAdapterType(): string {
    return this.adapter?.constructor.name ?? 'none';
  }

  /**
   * Create database schema
   * Replicates navio-core wallet database structure
   */
  private async createSchema(): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');

    // Keys table - stores key pairs
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS keys (
        key_id TEXT PRIMARY KEY,
        secret_key TEXT NOT NULL,
        public_key TEXT NOT NULL,
        create_time INTEGER NOT NULL
      )
    `);

    // Output keys table - stores output-specific keys
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS out_keys (
        out_id TEXT PRIMARY KEY,
        secret_key TEXT NOT NULL
      )
    `);

    // Encrypted keys table
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS crypted_keys (
        key_id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        encrypted_secret TEXT NOT NULL
      )
    `);

    // Encrypted output keys table
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS crypted_out_keys (
        out_id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        encrypted_secret TEXT NOT NULL
      )
    `);

    // View key table
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS view_key (
        public_key TEXT PRIMARY KEY,
        secret_key TEXT NOT NULL
      )
    `);

    // Spend key table (public key only)
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS spend_key (
        public_key TEXT PRIMARY KEY
      )
    `);

    // HD chain table
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS hd_chain (
        id INTEGER PRIMARY KEY,
        version INTEGER NOT NULL,
        seed_id TEXT NOT NULL,
        spend_id TEXT NOT NULL,
        view_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        blinding_id TEXT NOT NULL
      )
    `);

    // Master seed table (stores the mnemonic for recovery)
    // Note: This should be encrypted when wallet encryption is enabled
    // We store the mnemonic directly because Scalar.deserialize/serialize may not roundtrip correctly
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS master_seed (
        id INTEGER PRIMARY KEY,
        seed_hex TEXT,
        mnemonic TEXT
      )
    `);

    // Sub-addresses table
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS sub_addresses (
        hash_id TEXT PRIMARY KEY,
        account INTEGER NOT NULL,
        address INTEGER NOT NULL
      )
    `);

    // Sub-address strings table
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS sub_addresses_str (
        sub_address TEXT PRIMARY KEY,
        hash_id TEXT NOT NULL
      )
    `);

    // Sub-address pool table
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS sub_address_pool (
        account INTEGER NOT NULL,
        address INTEGER NOT NULL,
        create_time INTEGER NOT NULL,
        PRIMARY KEY (account, address)
      )
    `);

    // Sub-address counter table
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS sub_address_counter (
        account INTEGER PRIMARY KEY,
        counter INTEGER NOT NULL
      )
    `);

    // Key metadata table
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS key_metadata (
        key_id TEXT PRIMARY KEY,
        create_time INTEGER NOT NULL
      )
    `);

    // Transaction keys table (for sync)
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS tx_keys (
        tx_hash TEXT PRIMARY KEY,
        block_height INTEGER NOT NULL,
        keys_data TEXT NOT NULL
      )
    `);

    // Create index for block_height
    await this.adapter.run(`
      CREATE INDEX IF NOT EXISTS idx_tx_keys_block_height ON tx_keys(block_height)
    `);

    // Block hashes table (for reorganization detection)
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS block_hashes (
        height INTEGER PRIMARY KEY,
        hash TEXT NOT NULL
      )
    `);

    // Sync state table (single row, always id = 0)
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS sync_state (
        id INTEGER PRIMARY KEY,
        last_synced_height INTEGER NOT NULL,
        last_synced_hash TEXT NOT NULL,
        total_tx_keys_synced INTEGER NOT NULL,
        last_sync_time INTEGER NOT NULL,
        chain_tip_at_last_sync INTEGER NOT NULL
      )
    `);

    // Wallet metadata table (single row, always id = 0)
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS wallet_metadata (
        id INTEGER PRIMARY KEY,
        creation_height INTEGER NOT NULL DEFAULT 0,
        creation_time INTEGER NOT NULL,
        restored_from_seed INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1
      )
    `);

    // Encryption metadata table (for wallet password protection)
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS encryption_metadata (
        id INTEGER PRIMARY KEY,
        is_encrypted INTEGER NOT NULL DEFAULT 0,
        salt TEXT,
        verification_hash TEXT,
        encryption_version INTEGER NOT NULL DEFAULT 1
      )
    `);

    // Wallet outputs table (UTXOs)
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS wallet_outputs (
        output_hash TEXT PRIMARY KEY,
        tx_hash TEXT NOT NULL,
        output_index INTEGER NOT NULL,
        block_height INTEGER NOT NULL,
        output_data TEXT NOT NULL,
        amount INTEGER NOT NULL DEFAULT 0,
        gamma TEXT NOT NULL DEFAULT '0',
        memo TEXT,
        token_id TEXT,
        blinding_key TEXT,
        spending_key TEXT,
        is_spent INTEGER NOT NULL DEFAULT 0,
        spent_tx_hash TEXT,
        spent_block_height INTEGER,
        created_at INTEGER NOT NULL
      )
    `);

    // Create indexes for wallet_outputs
    await this.adapter.run(`
      CREATE INDEX IF NOT EXISTS idx_wallet_outputs_tx_hash ON wallet_outputs(tx_hash)
    `);
    await this.adapter.run(`
      CREATE INDEX IF NOT EXISTS idx_wallet_outputs_block_height ON wallet_outputs(block_height)
    `);
    await this.adapter.run(`
      CREATE INDEX IF NOT EXISTS idx_wallet_outputs_is_spent ON wallet_outputs(is_spent)
    `);
  }

  /**
   * Load wallet from database
   * @returns The loaded KeyManager instance
   * @throws Error if no wallet exists in the database
   */
  async loadWallet(): Promise<KeyManager> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not open. Call open() first.');
    }

    const keyManager = new KeyManager();

    // Load HD chain
    const hdChainResult = await this.adapter.exec('SELECT * FROM hd_chain LIMIT 1');
    if (hdChainResult.length === 0 || hdChainResult[0].values.length === 0) {
      throw new Error('No wallet found in database');
    }

    const row = hdChainResult[0].values[0];
    const hdChain: HDChain = {
      version: row[1] as number,
      seedId: this.hexToBytes(row[2] as string),
      spendId: this.hexToBytes(row[3] as string),
      viewId: this.hexToBytes(row[4] as string),
      tokenId: this.hexToBytes(row[5] as string),
      blindingId: this.hexToBytes(row[6] as string),
    };
    keyManager.loadHDChain(hdChain);

    // Load mnemonic for recovery
    // First try to load mnemonic (new format), then fall back to seed_hex (old format)
    const masterSeedResult = await this.adapter.exec(
      'SELECT mnemonic, seed_hex FROM master_seed WHERE id = 0'
    );
    if (masterSeedResult.length > 0 && masterSeedResult[0].values.length > 0) {
      const mnemonic = masterSeedResult[0].values[0][0] as string | null;
      const seedHex = masterSeedResult[0].values[0][1] as string | null;
      
      if (mnemonic) {
        keyManager.setHDSeedFromMnemonic(mnemonic);
      } else if (seedHex) {
        // Legacy: load from seed hex (may not roundtrip correctly)
        keyManager.loadMasterSeed(seedHex);
      }
    }

    // Load view key
    const viewKeyResult = await this.adapter.exec('SELECT * FROM view_key LIMIT 1');
    if (viewKeyResult.length > 0 && viewKeyResult[0].values.length > 0) {
      const row = viewKeyResult[0].values[0];
      const viewKey = this.deserializeViewKey(row[1] as string);
      keyManager.loadViewKey(viewKey);
    }

    // Load spend key
    const spendKeyResult = await this.adapter.exec('SELECT * FROM spend_key LIMIT 1');
    if (spendKeyResult.length > 0 && spendKeyResult[0].values.length > 0) {
      const row = spendKeyResult[0].values[0];
      const publicKey = this.deserializePublicKey(row[0] as string);
      keyManager.loadSpendKey(publicKey);
    }

    // Load keys
    const keysResult = await this.adapter.exec('SELECT * FROM keys');
    if (keysResult.length > 0) {
      for (const row of keysResult[0].values) {
        const secretKey = this.deserializeScalar(row[1] as string);
        const publicKey = this.deserializePublicKey(row[2] as string);
        keyManager.loadKey(secretKey, publicKey);

        // Load metadata
        const stmt = await this.adapter.prepare('SELECT create_time FROM key_metadata WHERE key_id = ?');
        stmt.bind([row[0]]);
        if (await stmt.step()) {
          const metadataRow = await stmt.getAsObject();
          keyManager.loadKeyMetadata(this.hexToBytes(row[0] as string), {
            nCreateTime: metadataRow.create_time as number,
          });
        }
        await stmt.free();
      }
    }

    // Load output keys
    const outKeysResult = await this.adapter.exec('SELECT * FROM out_keys');
    if (outKeysResult.length > 0) {
      for (const row of outKeysResult[0].values) {
        const secretKey = this.deserializeScalar(row[1] as string);
        const outId = this.hexToBytes(row[0] as string);
        keyManager.loadOutKey(secretKey, outId);
      }
    }

    // Load encrypted keys
    const cryptedKeysResult = await this.adapter.exec('SELECT * FROM crypted_keys');
    if (cryptedKeysResult.length > 0) {
      for (const row of cryptedKeysResult[0].values) {
        const publicKey = this.deserializePublicKey(row[1] as string);
        const encryptedSecret = this.hexToBytes(row[2] as string);
        keyManager.loadCryptedKey(publicKey, encryptedSecret, true);
      }
    }

    // Load encrypted output keys
    const cryptedOutKeysResult = await this.adapter.exec('SELECT * FROM crypted_out_keys');
    if (cryptedOutKeysResult.length > 0) {
      for (const row of cryptedOutKeysResult[0].values) {
        const outId = this.hexToBytes(row[0] as string);
        const publicKey = this.deserializePublicKey(row[1] as string);
        const encryptedSecret = this.hexToBytes(row[2] as string);
        keyManager.loadCryptedOutKey(outId, publicKey, encryptedSecret, true);
      }
    }

    // Load sub-addresses
    const subAddressesResult = await this.adapter.exec('SELECT * FROM sub_addresses');
    if (subAddressesResult.length > 0) {
      for (const row of subAddressesResult[0].values) {
        const hashId = this.hexToBytes(row[0] as string);
        const id: SubAddressIdentifier = {
          account: row[1] as number,
          address: row[2] as number,
        };
        keyManager.loadSubAddress(hashId, id);
      }
    }

    // Load sub-address counters
    const counterResult = await this.adapter.exec('SELECT * FROM sub_address_counter');
    if (counterResult.length > 0) {
      for (const _row of counterResult[0].values) {
        // This would need to be stored in KeyManager
        // For now, we'll rely on the sub-addresses to reconstruct counters
      }
    }

    // If no sub-addresses were loaded from DB, regenerate the pools
    // This is needed because sub-address saving was not fully implemented
    if (subAddressesResult.length === 0 || subAddressesResult[0].values.length === 0) {
      // Regenerate sub-address pools (like navio-core does during startup)
      keyManager.newSubAddressPool(0);
      keyManager.newSubAddressPool(-1);
      keyManager.newSubAddressPool(-2);
    }

    this.keyManager = keyManager;
    return keyManager;
  }

  /**
   * Create a new wallet
   * @param creationHeight - Optional block height when wallet was created (for sync optimization)
   * @returns The new KeyManager instance
   */
  async createWallet(creationHeight?: number): Promise<KeyManager> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not open. Call open() first.');
    }

    const keyManager = new KeyManager();

    // Generate new mnemonic and set as HD seed
    // This ensures we have a mnemonic to store for recovery
    keyManager.generateNewMnemonic();

    // Initialize sub-address pools
    keyManager.newSubAddressPool(0);
    keyManager.newSubAddressPool(-1);
    keyManager.newSubAddressPool(-2);

    // Save to database
    await this.saveWallet(keyManager);

    // Save wallet metadata
    await this.saveWalletMetadata({
      creationHeight: creationHeight ?? 0,
      creationTime: Date.now(),
      restoredFromSeed: false,
    });

    this.keyManager = keyManager;
    return keyManager;
  }

  /**
   * Restore wallet from seed
   * @param seedHex - The seed as hex string
   * @param creationHeight - Optional block height to start scanning from (for faster restore)
   * @returns The restored KeyManager instance
   */
  async restoreWallet(seedHex: string, creationHeight?: number): Promise<KeyManager> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not open. Call open() first.');
    }

    const keyManager = new KeyManager();

    // Deserialize seed
    const seed = this.deserializeScalar(seedHex);
    keyManager.setHDSeed(seed);

    // Initialize sub-address pools
    keyManager.newSubAddressPool(0);
    keyManager.newSubAddressPool(-1);
    keyManager.newSubAddressPool(-2);

    // Save to database
    await this.saveWallet(keyManager);

    // Save wallet metadata with restore height
    await this.saveWalletMetadata({
      creationHeight: creationHeight ?? 0,
      creationTime: Date.now(),
      restoredFromSeed: true,
    });

    this.keyManager = keyManager;
    return keyManager;
  }

  /**
   * Restore wallet from mnemonic phrase
   * @param mnemonic - The BIP39 mnemonic phrase (12-24 words)
   * @param creationHeight - Optional block height to start scanning from (for faster restore)
   * @returns The restored KeyManager instance
   */
  async restoreWalletFromMnemonic(mnemonic: string, creationHeight?: number): Promise<KeyManager> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not open. Call open() first.');
    }

    const keyManager = new KeyManager();

    // Set seed from mnemonic
    keyManager.setHDSeedFromMnemonic(mnemonic);

    // Initialize sub-address pools
    keyManager.newSubAddressPool(0);
    keyManager.newSubAddressPool(-1);
    keyManager.newSubAddressPool(-2);

    // Save to database
    await this.saveWallet(keyManager);

    // Save wallet metadata with restore height
    await this.saveWalletMetadata({
      creationHeight: creationHeight ?? 0,
      creationTime: Date.now(),
      restoredFromSeed: true,
    });

    this.keyManager = keyManager;
    return keyManager;
  }

  /**
   * Save wallet metadata to database
   */
  private async saveWalletMetadata(metadata: {
    creationHeight: number;
    creationTime: number;
    restoredFromSeed: boolean;
  }): Promise<void> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not open');
    }

    const stmt = await this.adapter.prepare(`
      INSERT OR REPLACE INTO wallet_metadata (id, creation_height, creation_time, restored_from_seed, version)
      VALUES (0, ?, ?, ?, 1)
    `);
    await stmt.run([metadata.creationHeight, metadata.creationTime, metadata.restoredFromSeed ? 1 : 0]);
    await stmt.free();

    // Persist to disk
    await this.persistToDisk();
  }

  /**
   * Persist database to disk (if not in-memory)
   */
  private async persistToDisk(): Promise<void> {
    if (this.dbPath === ':memory:' || !this.adapter) {
      return;
    }

    // Call save if adapter supports it
    if (this.adapter.save) {
      try {
        await this.adapter.save();
      } catch (err) {
        console.warn('[WalletDB] Save failed:', err);
      }
    }
  }

  /**
   * Explicitly save the database to persistent storage.
   * 
   * This forces a checkpoint/flush to ensure data is persisted.
   * For file-based databases (Node.js), this is typically a no-op.
   * For browser databases, this forces a WAL checkpoint.
   * 
   * @example
   * ```typescript
   * // Make important changes
   * await db.createWallet();
   * 
   * // Force immediate save
   * await db.save();
   * ```
   */
  async save(): Promise<void> {
    await this.persistToDisk();
  }

  /**
   * Migrate to a different adapter type.
   * 
   * Exports the current database and imports into a new adapter.
   * 
   * @param newPath - Path for the new database
   * @param options - Options for the new adapter
   * @returns A new WalletDB instance
   * 
   * @example
   * ```typescript
   * // Migrate from memory to persistent storage
   * const memDb = new WalletDB({ type: 'memory' });
   * await memDb.open(':memory:');
   * await memDb.createWallet();
   * 
   * // Browser: use wa-sqlite-opfs or wa-sqlite-idb
   * const persistentDb = await memDb.migrate('wallet.db');
   * ```
   */
  async migrate(newPath: string, options: WalletDBOptions = {}): Promise<WalletDB> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database must be open before migration');
    }

    // Export current database
    const data = await this.adapter.export();

    // Create new WalletDB with specified adapter
    const newDb = new WalletDB(options);
    await newDb.open(newPath, data);

    // Transfer keyManager reference
    newDb.keyManager = this.keyManager;

    return newDb;
  }

  /**
   * Get wallet metadata from database
   * @returns Wallet metadata or null if not found
   */
  async getWalletMetadata(): Promise<{
    creationHeight: number;
    creationTime: number;
    restoredFromSeed: boolean;
    version: number;
  } | null> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not open');
    }

    const result = await this.adapter.exec('SELECT creation_height, creation_time, restored_from_seed, version FROM wallet_metadata WHERE id = 0');
    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }

    const [creationHeight, creationTime, restoredFromSeed, version] = result[0].values[0];
    return {
      creationHeight: creationHeight as number,
      creationTime: creationTime as number,
      restoredFromSeed: (restoredFromSeed as number) === 1,
      version: version as number,
    };
  }

  /**
   * Get the wallet creation height (block height to start scanning from)
   * @returns Creation height or 0 if not set
   */
  async getCreationHeight(): Promise<number> {
    const metadata = await this.getWalletMetadata();
    return metadata?.creationHeight ?? 0;
  }

  /**
   * Set the wallet creation height
   * @param height - Block height
   */
  async setCreationHeight(height: number): Promise<void> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not open');
    }

    // Check if metadata exists
    const existing = await this.getWalletMetadata();
    if (existing) {
      const stmt = await this.adapter.prepare('UPDATE wallet_metadata SET creation_height = ? WHERE id = 0');
      await stmt.run([height]);
      await stmt.free();
      await this.persistToDisk();
    } else {
      await this.saveWalletMetadata({
        creationHeight: height,
        creationTime: Date.now(),
        restoredFromSeed: false,
      });
    }
  }

  /**
   * Save wallet to database
   * @param keyManager - The KeyManager instance to save (optional, uses stored instance if not provided)
   */
  async saveWallet(keyManager?: KeyManager): Promise<void> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not open');
    }

    const km = keyManager || this.keyManager;
    if (!km) {
      throw new Error('No KeyManager instance to save');
    }

    // Start transaction
    await this.adapter.run('BEGIN TRANSACTION');

    try {
      // Clear existing data (for simplicity, we'll replace everything)
      // In production, you might want to do incremental updates
      await this.adapter.run('DELETE FROM keys');
      await this.adapter.run('DELETE FROM out_keys');
      await this.adapter.run('DELETE FROM crypted_keys');
      await this.adapter.run('DELETE FROM crypted_out_keys');
      await this.adapter.run('DELETE FROM view_key');
      await this.adapter.run('DELETE FROM spend_key');
      await this.adapter.run('DELETE FROM hd_chain');
      await this.adapter.run('DELETE FROM master_seed');
      await this.adapter.run('DELETE FROM sub_addresses');
      await this.adapter.run('DELETE FROM sub_addresses_str');
      await this.adapter.run('DELETE FROM sub_address_pool');
      await this.adapter.run('DELETE FROM sub_address_counter');
      await this.adapter.run('DELETE FROM key_metadata');

      // Save HD chain
      const hdChain = km.getHDChain();
      if (hdChain) {
        const stmt = await this.adapter.prepare(
          `INSERT INTO hd_chain (version, seed_id, spend_id, view_id, token_id, blinding_id)
           VALUES (?, ?, ?, ?, ?, ?)`
        );
        await stmt.run([
          hdChain.version,
          this.bytesToHex(hdChain.seedId),
          this.bytesToHex(hdChain.spendId),
          this.bytesToHex(hdChain.viewId),
          this.bytesToHex(hdChain.tokenId),
          this.bytesToHex(hdChain.blindingId),
        ]);
        await stmt.free();
      }

      // Save mnemonic for recovery when reopening wallet
      // We store the mnemonic directly because Scalar.deserialize/serialize may not roundtrip correctly
      try {
        const mnemonic = km.getMnemonic();
        const seedStmt = await this.adapter.prepare(
          'INSERT INTO master_seed (id, mnemonic) VALUES (0, ?)'
        );
        await seedStmt.run([mnemonic]);
        await seedStmt.free();
      } catch {
        // Mnemonic not available (e.g., view-only wallet)
      }

      // Save view key
      try {
        const viewKey = km.getPrivateViewKey();
        const viewPublicKey = this.getPublicKeyFromViewKey(viewKey);
        const stmt = await this.adapter.prepare('INSERT INTO view_key (public_key, secret_key) VALUES (?, ?)');
        await stmt.run([this.serializePublicKey(viewPublicKey), this.serializeViewKey(viewKey)]);
        await stmt.free();
      } catch {
        // View key not available
      }

      // Save spend key
      try {
        const spendPublicKey = km.getPublicSpendingKey();
        const stmt = await this.adapter.prepare('INSERT INTO spend_key (public_key) VALUES (?)');
        await stmt.run([this.serializePublicKey(spendPublicKey)]);
        await stmt.free();
      } catch {
        // Spend key not available
      }

      // Note: Keys, output keys, encrypted keys, and sub-addresses would be saved here
      // For now, we're saving the essential HD chain and master keys
      // Full implementation would iterate through all keys and save them

      // Commit transaction
      await this.adapter.run('COMMIT');

      // Persist to disk
      await this.persistToDisk();
    } catch (error) {
      await this.adapter.run('ROLLBACK');
      throw error;
    }
  }

  /**
   * Get the current KeyManager instance
   */
  getKeyManager(): KeyManager | null {
    return this.keyManager;
  }

  /**
   * Get the database adapter (for use by sync modules)
   * @internal
   */
  getAdapter(): IDatabaseAdapter {
    if (!this.opened || !this.adapter) {
      throw new Error(
        'Database not initialized. Call open() first.'
      );
    }
    return this.adapter;
  }

  /**
   * Get the database path
   * @internal
   */
  getDatabasePath(): string {
    return this.dbPath;
  }

  /**
   * Save database to disk (if not in-memory)
   */
  async saveDatabase(): Promise<void> {
    await this.persistToDisk();
  }

  // ============================================================================
  // Sync data methods (used by TransactionKeysSync via IWalletDB interface)
  // ============================================================================

  async loadSyncState(): Promise<SyncState | null> {
    if (!this.adapter) return null;
    try {
      const result = await this.adapter.exec('SELECT * FROM sync_state LIMIT 1');
      if (result.length > 0 && result[0].values.length > 0) {
        const row = result[0].values[0];
        return {
          lastSyncedHeight: row[1] as number,
          lastSyncedHash: row[2] as string,
          totalTxKeysSynced: row[3] as number,
          lastSyncTime: row[4] as number,
          chainTipAtLastSync: row[5] as number,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  async saveSyncState(state: SyncState): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    const stmt = await this.adapter.prepare(
      `INSERT OR REPLACE INTO sync_state
       (id, last_synced_height, last_synced_hash, total_tx_keys_synced, last_sync_time, chain_tip_at_last_sync)
       VALUES (0, ?, ?, ?, ?, ?)`
    );
    await stmt.run([
      state.lastSyncedHeight,
      state.lastSyncedHash,
      state.totalTxKeysSynced,
      state.lastSyncTime,
      state.chainTipAtLastSync,
    ]);
    await stmt.free();
  }

  async clearSyncData(): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    await this.adapter.run('DELETE FROM sync_state');
    await this.adapter.run('DELETE FROM tx_keys');
    await this.adapter.run('DELETE FROM block_hashes');
  }

  async getBlockHash(height: number): Promise<string | null> {
    if (!this.adapter) throw new Error('Database not open');
    const stmt = await this.adapter.prepare('SELECT hash FROM block_hashes WHERE height = ?');
    stmt.bind([height]);
    if (await stmt.step()) {
      const row = await stmt.getAsObject();
      await stmt.free();
      return row.hash as string;
    }
    await stmt.free();
    return null;
  }

  async saveBlockHash(height: number, hash: string): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    const stmt = await this.adapter.prepare('INSERT OR REPLACE INTO block_hashes (height, hash) VALUES (?, ?)');
    await stmt.run([height, hash]);
    await stmt.free();
  }

  async deleteBlockHash(height: number): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    const stmt = await this.adapter.prepare('DELETE FROM block_hashes WHERE height = ?');
    await stmt.run([height]);
    await stmt.free();
  }

  async deleteBlockHashesBefore(height: number): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    const stmt = await this.adapter.prepare('DELETE FROM block_hashes WHERE height < ?');
    await stmt.run([height]);
    await stmt.free();
  }

  async saveTxKeys(txHash: string, height: number, keysData: string): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    const stmt = await this.adapter.prepare(
      'INSERT OR REPLACE INTO tx_keys (tx_hash, block_height, keys_data) VALUES (?, ?, ?)'
    );
    await stmt.run([txHash, height, keysData]);
    await stmt.free();
  }

  async getTxKeys(txHash: string): Promise<any | null> {
    if (!this.adapter) throw new Error('Database not open');
    const stmt = await this.adapter.prepare('SELECT keys_data FROM tx_keys WHERE tx_hash = ?');
    stmt.bind([txHash]);
    if (await stmt.step()) {
      const row = await stmt.getAsObject();
      await stmt.free();
      return JSON.parse(row.keys_data as string);
    }
    await stmt.free();
    return null;
  }

  async getTxKeysByHeight(height: number): Promise<{ txHash: string; keys: any }[]> {
    if (!this.adapter) throw new Error('Database not open');
    const stmt = await this.adapter.prepare('SELECT tx_hash, keys_data FROM tx_keys WHERE block_height = ?');
    stmt.bind([height]);
    const results: { txHash: string; keys: any }[] = [];
    while (await stmt.step()) {
      const row = await stmt.getAsObject();
      results.push({ txHash: row.tx_hash as string, keys: JSON.parse(row.keys_data as string) });
    }
    await stmt.free();
    return results;
  }

  async deleteTxKeysByHeight(height: number): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    const stmt = await this.adapter.prepare('DELETE FROM tx_keys WHERE block_height = ?');
    await stmt.run([height]);
    await stmt.free();
  }

  async storeWalletOutput(p: StoreOutputParams): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    const stmt = await this.adapter.prepare(
      `INSERT OR REPLACE INTO wallet_outputs
       (output_hash, tx_hash, output_index, block_height, output_data, amount, gamma, memo, token_id,
        blinding_key, spending_key, is_spent, spent_tx_hash, spent_block_height, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    await stmt.run([
      p.outputHash, p.txHash, p.outputIndex, p.blockHeight, p.outputData,
      p.amount, p.gamma, p.memo, p.tokenId, p.blindingKey, p.spendingKey,
      p.isSpent ? 1 : 0, p.spentTxHash, p.spentBlockHeight, Date.now(),
    ]);
    await stmt.free();
  }

  async isOutputUnspent(outputHash: string): Promise<boolean> {
    if (!this.adapter) throw new Error('Database not open');
    const stmt = await this.adapter.prepare(
      'SELECT output_hash FROM wallet_outputs WHERE output_hash = ? AND is_spent = 0'
    );
    stmt.bind([outputHash]);
    const found = await stmt.step();
    await stmt.free();
    return found;
  }

  async isOutputSpentInMempool(outputHash: string): Promise<boolean> {
    if (!this.adapter) throw new Error('Database not open');
    const stmt = await this.adapter.prepare(
      'SELECT output_hash FROM wallet_outputs WHERE output_hash = ? AND is_spent = 1 AND spent_block_height = 0'
    );
    stmt.bind([outputHash]);
    const found = await stmt.step();
    await stmt.free();
    return found;
  }

  async getMempoolSpentTxHash(outputHash: string): Promise<string | null> {
    if (!this.adapter) throw new Error('Database not open');
    const stmt = await this.adapter.prepare(
      'SELECT spent_tx_hash FROM wallet_outputs WHERE output_hash = ? AND is_spent = 1 AND spent_block_height = 0'
    );
    stmt.bind([outputHash]);
    if (await stmt.step()) {
      const row = await stmt.getAsObject();
      await stmt.free();
      return (row.spent_tx_hash as string) || null;
    }
    await stmt.free();
    return null;
  }

  async markOutputSpent(outputHash: string, spentTxHash: string, spentBlockHeight: number): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    await this.adapter.run(
      `UPDATE wallet_outputs SET is_spent = 1, spent_tx_hash = ?, spent_block_height = ? WHERE output_hash = ?`,
      [spentTxHash, spentBlockHeight, outputHash]
    );
  }

  async deleteOutputsByHeight(height: number): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    const stmt = await this.adapter.prepare('DELETE FROM wallet_outputs WHERE block_height = ?');
    await stmt.run([height]);
    await stmt.free();
  }

  async unspendOutputsBySpentHeight(height: number): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    await this.adapter.run(
      `UPDATE wallet_outputs SET is_spent = 0, spent_tx_hash = NULL, spent_block_height = NULL WHERE spent_block_height = ?`,
      [height]
    );
  }

  async getPendingSpentAmount(tokenId: string | null = null): Promise<bigint> {
    if (!this.adapter) throw new Error('Database not open');

    let query = `SELECT SUM(amount) as total FROM wallet_outputs WHERE is_spent = 1 AND spent_block_height = 0`;
    if (tokenId === null) {
      query += " AND (token_id IS NULL OR token_id = '0000000000000000000000000000000000000000000000000000000000000000')";
    } else {
      query += ` AND token_id = '${tokenId}'`;
    }

    const stmt = await this.adapter.prepare(query);
    if (await stmt.step()) {
      const row = await stmt.getAsObject();
      await stmt.free();
      return BigInt(row.total as number || 0);
    }
    await stmt.free();
    return 0n;
  }

  async deleteUnconfirmedOutputsByTxHash(txHash: string): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    await this.adapter.run(
      'DELETE FROM wallet_outputs WHERE block_height = 0 AND tx_hash = ?',
      [txHash]
    );
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    if (this.adapter) {
      await this.adapter.close();
      this.adapter = null;
      this.opened = false;
    }
  }

  // ============================================================================
  // Serialization helpers
  // ============================================================================

  private deserializeScalar(hex: string): any {
    const Scalar = blsctModule.Scalar;
    return Scalar.deserialize(hex);
  }

  private serializeViewKey(viewKey: any): string {
    return viewKey.serialize();
  }

  private deserializeViewKey(hex: string): any {
    const Scalar = blsctModule.Scalar;
    
    return Scalar.deserialize(hex);
  }

  private serializePublicKey(publicKey: any): string {
    return publicKey.serialize();
  }

  private deserializePublicKey(hex: string): any {
    const PublicKey = blsctModule.PublicKey;
    return PublicKey.deserialize(hex);
  }

  private getPublicKeyFromViewKey(viewKey: any): any {
    const Scalar = blsctModule.Scalar;
    const PublicKey = blsctModule.PublicKey;
    const scalar = Scalar.deserialize(viewKey.serialize());
    return PublicKey.fromScalar(scalar);
  }

  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }

  /**
   * Get wallet balance (sum of unspent output amounts)
   * @param tokenId - Optional token ID to filter by (null for NAV)
   * @returns Balance in satoshis
   */
  async getBalance(tokenId: string | null = null): Promise<bigint> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not initialized');
    }

    let query = 'SELECT SUM(amount) as total FROM wallet_outputs WHERE is_spent = 0';

    if (tokenId === null) {
      // NAV balance - outputs with no token_id or default token_id
      query += " AND (token_id IS NULL OR token_id = '0000000000000000000000000000000000000000000000000000000000000000')";
    } else {
      query += ` AND token_id = '${tokenId}'`;
    }

    const result = await this.adapter.exec(query);
    if (result.length === 0 || result[0].values.length === 0 || result[0].values[0][0] === null) {
      return 0n;
    }

    return BigInt(result[0].values[0][0] as number);
  }

  /**
   * Get unspent outputs (UTXOs)
   * @param tokenId - Optional token ID to filter by (null for NAV)
   * @returns Array of unspent outputs
   */
  async getUnspentOutputs(tokenId: string | null = null): Promise<WalletOutput[]> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not initialized');
    }

    let query = `
      SELECT output_hash, tx_hash, output_index, block_height, amount, gamma, memo, token_id, 
             blinding_key, spending_key, is_spent, spent_tx_hash, spent_block_height
      FROM wallet_outputs 
      WHERE is_spent = 0
    `;

    if (tokenId === null) {
      // NAV - outputs with no token_id or default token_id
      query += " AND (token_id IS NULL OR token_id = '0000000000000000000000000000000000000000000000000000000000000000')";
    } else {
      query += ` AND token_id = '${tokenId}'`;
    }

    query += ' ORDER BY block_height ASC';

    const stmt = await this.adapter.prepare(query);

    const outputs: WalletOutput[] = [];
    while (await stmt.step()) {
      const row = await stmt.getAsObject();
      outputs.push({
        outputHash: row.output_hash as string,
        txHash: row.tx_hash as string,
        outputIndex: row.output_index as number,
        blockHeight: row.block_height as number,
        amount: BigInt(row.amount as number),
        gamma: (row.gamma as string) || '0',
        memo: row.memo as string | null,
        tokenId: row.token_id as string | null,
        blindingKey: row.blinding_key as string,
        spendingKey: row.spending_key as string,
        isSpent: (row.is_spent as number) === 1,
        spentTxHash: row.spent_tx_hash as string | null,
        spentBlockHeight: row.spent_block_height as number | null,
      });
    }
    await stmt.free();

    return outputs;
  }

  /**
   * Get all outputs (spent and unspent)
   * @returns Array of all wallet outputs
   */
  async getAllOutputs(): Promise<WalletOutput[]> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not initialized');
    }

    const stmt = await this.adapter.prepare(`
      SELECT output_hash, tx_hash, output_index, block_height, amount, gamma, memo, token_id, 
             blinding_key, spending_key, is_spent, spent_tx_hash, spent_block_height
      FROM wallet_outputs 
      ORDER BY block_height ASC
    `);

    const outputs: WalletOutput[] = [];
    while (await stmt.step()) {
      const row = await stmt.getAsObject();
      outputs.push({
        outputHash: row.output_hash as string,
        txHash: row.tx_hash as string,
        outputIndex: row.output_index as number,
        blockHeight: row.block_height as number,
        amount: BigInt(row.amount as number),
        gamma: (row.gamma as string) || '0',
        memo: row.memo as string | null,
        tokenId: row.token_id as string | null,
        blindingKey: row.blinding_key as string,
        spendingKey: row.spending_key as string,
        isSpent: (row.is_spent as number) === 1,
        spentTxHash: row.spent_tx_hash as string | null,
        spentBlockHeight: row.spent_block_height as number | null,
      });
    }
    await stmt.free();

    return outputs;
  }

  // ============================================================================
  // Encryption Methods
  // ============================================================================

  /**
   * Check if the database has encryption enabled
   * @returns True if encryption is enabled
   */
  async isEncrypted(): Promise<boolean> {
    if (!this.opened || !this.adapter) {
      return false;
    }

    const stmt = await this.adapter.prepare('SELECT is_encrypted FROM encryption_metadata WHERE id = 0');
    if (await stmt.step()) {
      const row = await stmt.getAsObject();
      await stmt.free();
      return (row.is_encrypted as number) === 1;
    }
    await stmt.free();
    return false;
  }

  /**
   * Save encryption metadata to the database
   * @param salt - Hex-encoded salt
   * @param verificationHash - Hex-encoded password verification hash
   */
  async saveEncryptionMetadata(salt: string, verificationHash: string): Promise<void> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not initialized');
    }

    // Insert or update encryption metadata
    await this.adapter.run(`
      INSERT OR REPLACE INTO encryption_metadata (id, is_encrypted, salt, verification_hash, encryption_version)
      VALUES (0, 1, ?, ?, 1)
    `, [salt, verificationHash]);
  }

  /**
   * Load encryption metadata from the database
   * @returns Encryption metadata or null if not encrypted
   */
  async getEncryptionMetadata(): Promise<{ salt: string; verificationHash: string } | null> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not initialized');
    }

    const stmt = await this.adapter.prepare(`
      SELECT salt, verification_hash FROM encryption_metadata WHERE id = 0 AND is_encrypted = 1
    `);

    if (await stmt.step()) {
      const row = await stmt.getAsObject();
      await stmt.free();
      if (row.salt && row.verification_hash) {
        return {
          salt: row.salt as string,
          verificationHash: row.verification_hash as string,
        };
      }
    }
    await stmt.free();
    return null;
  }

  /**
   * Save an encrypted key to the database
   * @param keyId - Key identifier (hex)
   * @param publicKey - Public key (hex)
   * @param encryptedSecret - Encrypted secret (JSON string)
   */
  async saveEncryptedKey(keyId: string, publicKey: string, encryptedSecret: string): Promise<void> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not initialized');
    }

    await this.adapter.run(`
      INSERT OR REPLACE INTO crypted_keys (key_id, public_key, encrypted_secret)
      VALUES (?, ?, ?)
    `, [keyId, publicKey, encryptedSecret]);
  }

  /**
   * Load an encrypted key from the database
   * @param keyId - Key identifier (hex)
   * @returns Encrypted key data or null if not found
   */
  async getEncryptedKey(keyId: string): Promise<{ publicKey: string; encryptedSecret: string } | null> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not initialized');
    }

    const stmt = await this.adapter.prepare(`
      SELECT public_key, encrypted_secret FROM crypted_keys WHERE key_id = ?
    `);
    stmt.bind([keyId]);

    if (await stmt.step()) {
      const row = await stmt.getAsObject();
      await stmt.free();
      return {
        publicKey: row.public_key as string,
        encryptedSecret: row.encrypted_secret as string,
      };
    }
    await stmt.free();
    return null;
  }

  /**
   * Get all encrypted keys from the database
   * @returns Array of encrypted key data
   */
  async getAllEncryptedKeys(): Promise<Array<{ keyId: string; publicKey: string; encryptedSecret: string }>> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not initialized');
    }

    const stmt = await this.adapter.prepare('SELECT key_id, public_key, encrypted_secret FROM crypted_keys');
    const keys: Array<{ keyId: string; publicKey: string; encryptedSecret: string }> = [];

    while (await stmt.step()) {
      const row = await stmt.getAsObject();
      keys.push({
        keyId: row.key_id as string,
        publicKey: row.public_key as string,
        encryptedSecret: row.encrypted_secret as string,
      });
    }
    await stmt.free();

    return keys;
  }

  /**
   * Save an encrypted output key to the database
   * @param outId - Output identifier (hex)
   * @param publicKey - Public key (hex)
   * @param encryptedSecret - Encrypted secret (JSON string)
   */
  async saveEncryptedOutKey(outId: string, publicKey: string, encryptedSecret: string): Promise<void> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not initialized');
    }

    await this.adapter.run(`
      INSERT OR REPLACE INTO crypted_out_keys (out_id, public_key, encrypted_secret)
      VALUES (?, ?, ?)
    `, [outId, publicKey, encryptedSecret]);
  }

  /**
   * Load an encrypted output key from the database
   * @param outId - Output identifier (hex)
   * @returns Encrypted output key data or null if not found
   */
  async getEncryptedOutKey(outId: string): Promise<{ publicKey: string; encryptedSecret: string } | null> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not initialized');
    }

    const stmt = await this.adapter.prepare(`
      SELECT public_key, encrypted_secret FROM crypted_out_keys WHERE out_id = ?
    `);
    stmt.bind([outId]);

    if (await stmt.step()) {
      const row = await stmt.getAsObject();
      await stmt.free();
      return {
        publicKey: row.public_key as string,
        encryptedSecret: row.encrypted_secret as string,
      };
    }
    await stmt.free();
    return null;
  }

  /**
   * Get all encrypted output keys from the database
   * @returns Array of encrypted output key data
   */
  async getAllEncryptedOutKeys(): Promise<Array<{ outId: string; publicKey: string; encryptedSecret: string }>> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not initialized');
    }

    const stmt = await this.adapter.prepare('SELECT out_id, public_key, encrypted_secret FROM crypted_out_keys');
    const keys: Array<{ outId: string; publicKey: string; encryptedSecret: string }> = [];

    while (await stmt.step()) {
      const row = await stmt.getAsObject();
      keys.push({
        outId: row.out_id as string,
        publicKey: row.public_key as string,
        encryptedSecret: row.encrypted_secret as string,
      });
    }
    await stmt.free();

    return keys;
  }

  /**
   * Delete plaintext keys (after encryption)
   * This removes the unencrypted keys from the database
   */
  async deletePlaintextKeys(): Promise<void> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not initialized');
    }

    await this.adapter.run('DELETE FROM keys');
    await this.adapter.run('DELETE FROM out_keys');
  }

  /**
   * Export the database as an encrypted binary blob
   * Uses the encryption module to encrypt the entire SQLite database
   * 
   * @param password - Password to encrypt the export
   * @returns Encrypted database bytes
   */
  async exportEncrypted(password: string): Promise<Uint8Array> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not initialized');
    }

    // Import encryption functions
    const { encryptDatabase } = await import('./crypto');

    // Export the raw database
    const dbBuffer = await this.adapter.export();

    // Encrypt the database
    const encrypted = await encryptDatabase(dbBuffer, password);

    return encrypted;
  }

  /**
   * Load a database from an encrypted binary blob
   * 
   * @param encryptedData - Encrypted database bytes
   * @param password - Password to decrypt
   * @param options - Database options
   * @returns New WalletDB instance with decrypted data
   */
  static async loadEncrypted(
    encryptedData: Uint8Array,
    password: string,
    options: WalletDBOptions = {}
  ): Promise<WalletDB> {
    // Import decryption function
    const { decryptDatabase, isEncryptedDatabase } = await import('./crypto');

    // Check if it's actually encrypted
    if (!isEncryptedDatabase(encryptedData)) {
      throw new Error('Data does not appear to be an encrypted database');
    }

    // Decrypt the database
    const decryptedBuffer = await decryptDatabase(encryptedData, password);

    // Create new WalletDB instance
    const walletDb = new WalletDB(options);
    await walletDb.open(':memory:', decryptedBuffer);

    return walletDb;
  }

  /**
   * Get the raw database bytes (unencrypted)
   * @returns Database bytes
   */
  async export(): Promise<Uint8Array> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not initialized');
    }

    return await this.adapter.export();
  }

  /**
   * Load a database from raw bytes
   * 
   * @param data - Raw database bytes
   * @param options - Database options
   * @returns New WalletDB instance
   */
  static async loadFromBytes(data: Uint8Array, options: WalletDBOptions = {}): Promise<WalletDB> {
    const walletDb = new WalletDB(options);
    await walletDb.open(':memory:', data);
    return walletDb;
  }
}
