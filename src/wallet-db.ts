/**
 * WalletDB - Database persistence layer for KeyManager
 * Uses SQL.js (SQLite compiled to WebAssembly) for cross-platform compatibility
 * Works on web browsers, Node.js, and mobile platforms
 *
 * Database schema replicates navio-core wallet database structure
 */

import { KeyManager } from './key-manager';
import type { HDChain, SubAddressIdentifier } from './key-manager.types';
import * as blsctModule from 'navio-blsct';

/**
 * Wallet output structure returned by getUnspentOutputs and getAllOutputs
 */
export interface WalletOutput {
  outputHash: string;
  txHash: string;
  outputIndex: number;
  blockHeight: number;
  amount: bigint;
  memo: string | null;
  tokenId: string | null;
  blindingKey: string;
  spendingKey: string;
  isSpent: boolean;
  spentTxHash: string | null;
  spentBlockHeight: number | null;
}

// Import SQL.js for cross-platform SQLite support
// In browser: uses WebAssembly SQLite
// In Node.js: uses native SQLite bindings if available, falls back to WASM
let initSqlJs: any;
let SQL: any;

// Lazy load SQL.js to support both browser and Node.js
async function loadSQL(): Promise<any> {
  if (SQL) return SQL;

  try {
    // Try to load SQL.js
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (globalThis as any).window !== 'undefined') {
      // Browser environment
      const sqlJs = await import('sql.js');
      initSqlJs = sqlJs.default;
      SQL = await initSqlJs({
        // Prefer explicit override, otherwise use CDN to avoid requiring a local wasm file
        locateFile: (file: string) => {
          if (file === 'sql-wasm.wasm') {
            const override = (globalThis as any).NAVIO_SQL_WASM_URL;
            if (typeof override === 'string' && override.length > 0) {
              return override;
            }
          }
          return `https://sql.js.org/dist/${file}`;
        },
      });
    } else {
      // Node.js environment
      const sqlJs = require('sql.js');
      initSqlJs = sqlJs.default || sqlJs;
      const fs = require('fs');
      SQL = await initSqlJs({
        locateFile: (file: string) => {
          // Try to find sql.js WASM file
          const path = require('path');
          const wasmPath = path.join(__dirname, '../node_modules/sql.js/dist/sql-wasm.wasm');
          if (fs.existsSync(wasmPath)) {
            return wasmPath;
          }
          return file;
        },
      });
    }
    return SQL;
  } catch (error) {
    throw new Error(`Failed to load SQL.js: ${error}. Please install sql.js: npm install sql.js`);
  }
}

/**
 * WalletDB - Manages wallet database persistence.
 * 
 * Uses SQL.js (SQLite compiled to WebAssembly) for cross-platform compatibility.
 * Works on web browsers, Node.js, and mobile platforms.
 * 
 * @category Wallet
 */
export class WalletDB {
  private db: any = null;
  private dbPath: string;
  private keyManager: KeyManager | null = null;
  private isOpen = false;

  /**
   * Create a new WalletDB instance
   * @param dbPath - Path to the database file (or name for in-memory)
   * @param createIfNotExists - Create database if it doesn't exist
   */
  constructor(dbPath: string = ':memory:', _createIfNotExists = true) {
    this.dbPath = dbPath;
    // Database will be opened when loadWallet, createWallet, or restoreWallet is called
    // Note: _createIfNotExists reserved for future use
  }

  /**
   * Initialize the database connection and schema
   */
  private async initDatabase(): Promise<void> {
    if (this.isOpen) return;

    const SQL = await loadSQL();
    const fs = this.getFileSystem();

    // Load existing database or create new one
    if (this.dbPath !== ':memory:' && fs && fs.existsSync && fs.existsSync(this.dbPath)) {
      try {
        const buffer = fs.readFileSync(this.dbPath);
        this.db = new SQL.Database(buffer);
      } catch (error) {
        // If read fails, create new database
        this.db = new SQL.Database();
      }
    } else {
      this.db = new SQL.Database();
    }

    // Create schema
    this.createSchema();
    this.isOpen = true;
  }

  /**
   * Get file system interface (Node.js only)
   */
  private getFileSystem(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (globalThis as any).window === 'undefined' && typeof require !== 'undefined') {
      try {
        return require('fs');
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Create database schema
   * Replicates navio-core wallet database structure
   */
  private createSchema(): void {
    // Keys table - stores key pairs
    this.db.run(`
      CREATE TABLE IF NOT EXISTS keys (
        key_id TEXT PRIMARY KEY,
        secret_key TEXT NOT NULL,
        public_key TEXT NOT NULL,
        create_time INTEGER NOT NULL
      )
    `);

    // Output keys table - stores output-specific keys
    this.db.run(`
      CREATE TABLE IF NOT EXISTS out_keys (
        out_id TEXT PRIMARY KEY,
        secret_key TEXT NOT NULL
      )
    `);

    // Encrypted keys table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS crypted_keys (
        key_id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        encrypted_secret TEXT NOT NULL
      )
    `);

    // Encrypted output keys table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS crypted_out_keys (
        out_id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        encrypted_secret TEXT NOT NULL
      )
    `);

    // View key table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS view_key (
        public_key TEXT PRIMARY KEY,
        secret_key TEXT NOT NULL
      )
    `);

    // Spend key table (public key only)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS spend_key (
        public_key TEXT PRIMARY KEY
      )
    `);

    // HD chain table
    this.db.run(`
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

    // Sub-addresses table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sub_addresses (
        hash_id TEXT PRIMARY KEY,
        account INTEGER NOT NULL,
        address INTEGER NOT NULL
      )
    `);

    // Sub-address strings table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sub_addresses_str (
        sub_address TEXT PRIMARY KEY,
        hash_id TEXT NOT NULL
      )
    `);

    // Sub-address pool table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sub_address_pool (
        account INTEGER NOT NULL,
        address INTEGER NOT NULL,
        create_time INTEGER NOT NULL,
        PRIMARY KEY (account, address)
      )
    `);

    // Sub-address counter table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sub_address_counter (
        account INTEGER PRIMARY KEY,
        counter INTEGER NOT NULL
      )
    `);

    // Key metadata table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS key_metadata (
        key_id TEXT PRIMARY KEY,
        create_time INTEGER NOT NULL
      )
    `);

    // Transaction keys table (for sync)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tx_keys (
        tx_hash TEXT PRIMARY KEY,
        block_height INTEGER NOT NULL,
        keys_data TEXT NOT NULL
      )
    `);

    // Create index for block_height
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_tx_keys_block_height ON tx_keys(block_height)
    `);

    // Block hashes table (for reorganization detection)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS block_hashes (
        height INTEGER PRIMARY KEY,
        hash TEXT NOT NULL
      )
    `);

    // Sync state table (single row, always id = 0)
    this.db.run(`
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
    this.db.run(`
      CREATE TABLE IF NOT EXISTS wallet_metadata (
        id INTEGER PRIMARY KEY,
        creation_height INTEGER NOT NULL DEFAULT 0,
        creation_time INTEGER NOT NULL,
        restored_from_seed INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1
      )
    `);

    // Wallet outputs table (UTXOs)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS wallet_outputs (
        output_hash TEXT PRIMARY KEY,
        tx_hash TEXT NOT NULL,
        output_index INTEGER NOT NULL,
        block_height INTEGER NOT NULL,
        output_data TEXT NOT NULL,
        amount INTEGER NOT NULL DEFAULT 0,
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
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_wallet_outputs_tx_hash ON wallet_outputs(tx_hash)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_wallet_outputs_block_height ON wallet_outputs(block_height)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_wallet_outputs_is_spent ON wallet_outputs(is_spent)
    `);
  }

  /**
   * Load wallet from database
   * @returns The loaded KeyManager instance
   * @throws Error if no wallet exists in the database
   */
  async loadWallet(): Promise<KeyManager> {
    await this.initDatabase();

    const keyManager = new KeyManager();

    // Load HD chain
    const hdChainResult = this.db.exec('SELECT * FROM hd_chain LIMIT 1');
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

    // Load view key
    const viewKeyResult = this.db.exec('SELECT * FROM view_key LIMIT 1');
    if (viewKeyResult.length > 0 && viewKeyResult[0].values.length > 0) {
      const row = viewKeyResult[0].values[0];
      const viewKey = this.deserializeViewKey(row[1] as string);
      keyManager.loadViewKey(viewKey);
    }

    // Load spend key
    const spendKeyResult = this.db.exec('SELECT * FROM spend_key LIMIT 1');
    if (spendKeyResult.length > 0 && spendKeyResult[0].values.length > 0) {
      const row = spendKeyResult[0].values[0];
      const publicKey = this.deserializePublicKey(row[0] as string);
      keyManager.loadSpendKey(publicKey);
    }

    // Load keys
    const keysResult = this.db.exec('SELECT * FROM keys');
    if (keysResult.length > 0) {
      for (const row of keysResult[0].values) {
        const secretKey = this.deserializeScalar(row[1] as string);
        const publicKey = this.deserializePublicKey(row[2] as string);
        keyManager.loadKey(secretKey, publicKey);

        // Load metadata
        const stmt = this.db.prepare('SELECT create_time FROM key_metadata WHERE key_id = ?');
        stmt.bind([row[0]]);
        if (stmt.step()) {
          const metadataRow = stmt.getAsObject();
          keyManager.loadKeyMetadata(this.hexToBytes(row[0] as string), {
            nCreateTime: metadataRow.create_time as number,
          });
        }
        stmt.free();
      }
    }

    // Load output keys
    const outKeysResult = this.db.exec('SELECT * FROM out_keys');
    if (outKeysResult.length > 0) {
      for (const row of outKeysResult[0].values) {
        const secretKey = this.deserializeScalar(row[1] as string);
        const outId = this.hexToBytes(row[0] as string);
        keyManager.loadOutKey(secretKey, outId);
      }
    }

    // Load encrypted keys
    const cryptedKeysResult = this.db.exec('SELECT * FROM crypted_keys');
    if (cryptedKeysResult.length > 0) {
      for (const row of cryptedKeysResult[0].values) {
        const publicKey = this.deserializePublicKey(row[1] as string);
        const encryptedSecret = this.hexToBytes(row[2] as string);
        keyManager.loadCryptedKey(publicKey, encryptedSecret, true);
      }
    }

    // Load encrypted output keys
    const cryptedOutKeysResult = this.db.exec('SELECT * FROM crypted_out_keys');
    if (cryptedOutKeysResult.length > 0) {
      for (const row of cryptedOutKeysResult[0].values) {
        const outId = this.hexToBytes(row[0] as string);
        const publicKey = this.deserializePublicKey(row[1] as string);
        const encryptedSecret = this.hexToBytes(row[2] as string);
        keyManager.loadCryptedOutKey(outId, publicKey, encryptedSecret, true);
      }
    }

    // Load sub-addresses
    const subAddressesResult = this.db.exec('SELECT * FROM sub_addresses');
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
    const counterResult = this.db.exec('SELECT * FROM sub_address_counter');
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
    await this.initDatabase();

    const keyManager = new KeyManager();

    // Generate new seed
    const seed = keyManager.generateNewSeed();
    keyManager.setHDSeed(seed);

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
    await this.initDatabase();

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
   * Save wallet metadata to database
   */
  private async saveWalletMetadata(metadata: {
    creationHeight: number;
    creationTime: number;
    restoredFromSeed: boolean;
  }): Promise<void> {
    if (!this.isOpen) {
      await this.initDatabase();
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO wallet_metadata (id, creation_height, creation_time, restored_from_seed, version)
      VALUES (0, ?, ?, ?, 1)
    `);
    stmt.run([metadata.creationHeight, metadata.creationTime, metadata.restoredFromSeed ? 1 : 0]);
    stmt.free();

    // Persist to disk
    this.persistToDisk();
  }

  /**
   * Persist database to disk (if not in-memory)
   */
  private persistToDisk(): void {
    if (this.dbPath !== ':memory:' && this.db) {
      const fs = this.getFileSystem();
      if (fs) {
        const data = this.db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(this.dbPath, buffer);
      }
    }
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
    if (!this.isOpen) {
      await this.initDatabase();
    }

    const result = this.db.exec('SELECT creation_height, creation_time, restored_from_seed, version FROM wallet_metadata WHERE id = 0');
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
    if (!this.isOpen) {
      await this.initDatabase();
    }

    // Check if metadata exists
    const existing = await this.getWalletMetadata();
    if (existing) {
      const stmt = this.db.prepare('UPDATE wallet_metadata SET creation_height = ? WHERE id = 0');
      stmt.run([height]);
      stmt.free();
      this.persistToDisk();
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
    if (!this.isOpen) {
      await this.initDatabase();
    }

    const km = keyManager || this.keyManager;
    if (!km) {
      throw new Error('No KeyManager instance to save');
    }

    // Start transaction
    this.db.run('BEGIN TRANSACTION');

    try {
      // Clear existing data (for simplicity, we'll replace everything)
      // In production, you might want to do incremental updates
      this.db.run('DELETE FROM keys');
      this.db.run('DELETE FROM out_keys');
      this.db.run('DELETE FROM crypted_keys');
      this.db.run('DELETE FROM crypted_out_keys');
      this.db.run('DELETE FROM view_key');
      this.db.run('DELETE FROM spend_key');
      this.db.run('DELETE FROM hd_chain');
      this.db.run('DELETE FROM sub_addresses');
      this.db.run('DELETE FROM sub_addresses_str');
      this.db.run('DELETE FROM sub_address_pool');
      this.db.run('DELETE FROM sub_address_counter');
      this.db.run('DELETE FROM key_metadata');

      // Save HD chain
      const hdChain = km.getHDChain();
      if (hdChain) {
        const stmt = this.db.prepare(
          `INSERT INTO hd_chain (version, seed_id, spend_id, view_id, token_id, blinding_id)
           VALUES (?, ?, ?, ?, ?, ?)`
        );
        stmt.run([
          hdChain.version,
          this.bytesToHex(hdChain.seedId),
          this.bytesToHex(hdChain.spendId),
          this.bytesToHex(hdChain.viewId),
          this.bytesToHex(hdChain.tokenId),
          this.bytesToHex(hdChain.blindingId),
        ]);
        stmt.free();
      }

      // Save view key
      try {
        const viewKey = km.getPrivateViewKey();
        const viewPublicKey = this.getPublicKeyFromViewKey(viewKey);
        const stmt = this.db.prepare('INSERT INTO view_key (public_key, secret_key) VALUES (?, ?)');
        stmt.run([this.serializePublicKey(viewPublicKey), this.serializeViewKey(viewKey)]);
        stmt.free();
      } catch {
        // View key not available
      }

      // Save spend key
      try {
        const spendPublicKey = km.getPublicSpendingKey();
        const stmt = this.db.prepare('INSERT INTO spend_key (public_key) VALUES (?)');
        stmt.run([this.serializePublicKey(spendPublicKey)]);
        stmt.free();
      } catch {
        // Spend key not available
      }

      // Note: Keys, output keys, encrypted keys, and sub-addresses would be saved here
      // For now, we're saving the essential HD chain and master keys
      // Full implementation would iterate through all keys and save them

      // Commit transaction
      this.db.run('COMMIT');

      // Persist to disk
      this.persistToDisk();
    } catch (error) {
      this.db.run('ROLLBACK');
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
   * Get the database instance (for use by sync modules)
   * @internal
   */
  getDatabase(): any {
    if (!this.isOpen) {
      throw new Error(
        'Database not initialized. Call loadWallet(), createWallet(), or restoreWallet() first.'
      );
    }
    return this.db;
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
    if (this.dbPath === ':memory:' || !this.isOpen) {
      return;
    }
    this.persistToDisk();
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.isOpen = false;
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
    if (!this.isOpen) {
      throw new Error('Database not initialized');
    }

    let query = 'SELECT SUM(amount) as total FROM wallet_outputs WHERE is_spent = 0';
    const params: any[] = [];

    if (tokenId === null) {
      // NAV balance - outputs with no token_id or default token_id
      query += ' AND (token_id IS NULL OR token_id = ?)';
      params.push('0000000000000000000000000000000000000000000000000000000000000000');
    } else {
      query += ' AND token_id = ?';
      params.push(tokenId);
    }

    const result = this.db.exec(query);
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
    if (!this.isOpen) {
      throw new Error('Database not initialized');
    }

    let query = `
      SELECT output_hash, tx_hash, output_index, block_height, amount, memo, token_id, 
             blinding_key, spending_key, is_spent, spent_tx_hash, spent_block_height
      FROM wallet_outputs 
      WHERE is_spent = 0
    `;
    const params: any[] = [];

    if (tokenId === null) {
      // NAV - outputs with no token_id or default token_id
      query += ' AND (token_id IS NULL OR token_id = ?)';
      params.push('0000000000000000000000000000000000000000000000000000000000000000');
    } else {
      query += ' AND token_id = ?';
      params.push(tokenId);
    }

    query += ' ORDER BY block_height ASC';

    const stmt = this.db.prepare(query);
    if (params.length > 0) {
      stmt.bind(params);
    }

    const outputs: WalletOutput[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      outputs.push({
        outputHash: row.output_hash as string,
        txHash: row.tx_hash as string,
        outputIndex: row.output_index as number,
        blockHeight: row.block_height as number,
        amount: BigInt(row.amount as number),
        memo: row.memo as string | null,
        tokenId: row.token_id as string | null,
        blindingKey: row.blinding_key as string,
        spendingKey: row.spending_key as string,
        isSpent: (row.is_spent as number) === 1,
        spentTxHash: row.spent_tx_hash as string | null,
        spentBlockHeight: row.spent_block_height as number | null,
      });
    }
    stmt.free();

    return outputs;
  }

  /**
   * Get all outputs (spent and unspent)
   * @returns Array of all wallet outputs
   */
  async getAllOutputs(): Promise<WalletOutput[]> {
    if (!this.isOpen) {
      throw new Error('Database not initialized');
    }

    const stmt = this.db.prepare(`
      SELECT output_hash, tx_hash, output_index, block_height, amount, memo, token_id, 
             blinding_key, spending_key, is_spent, spent_tx_hash, spent_block_height
      FROM wallet_outputs 
      ORDER BY block_height ASC
    `);

    const outputs: WalletOutput[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      outputs.push({
        outputHash: row.output_hash as string,
        txHash: row.tx_hash as string,
        outputIndex: row.output_index as number,
        blockHeight: row.block_height as number,
        amount: BigInt(row.amount as number),
        memo: row.memo as string | null,
        tokenId: row.token_id as string | null,
        blindingKey: row.blinding_key as string,
        spendingKey: row.spending_key as string,
        isSpent: (row.is_spent as number) === 1,
        spentTxHash: row.spent_tx_hash as string | null,
        spentBlockHeight: row.spent_block_height as number | null,
      });
    }
    stmt.free();

    return outputs;
  }
}
