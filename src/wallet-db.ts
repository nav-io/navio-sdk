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
import * as blsctModule from '@nav-io/navio-blsct';
import type { IDatabaseAdapter, DatabaseAdapterOptions, RowObject } from './database-adapter';
import { createDatabaseAdapter } from './database-adapter';
import type { SyncState, StoreOutputParams, TxType, CreatedCollectionRecord, SubAddressEntry, StandingOrderRow } from './wallet-db.interface';
export type { SyncState, WalletOutput, WalletMetadata, StoreOutputParams, IWalletDB, TxType, CreatedCollectionRecord, SubAddressEntry } from './wallet-db.interface';

// WalletOutput is re-exported from wallet-db.interface.ts
import type { WalletOutput } from './wallet-db.interface';
import { isStakedCommitmentOutputHex } from './staking';
import { NAV_TOKEN_ID_FORMS, decodeAmount, encodeAmount } from './storage-codec';

/**
 * SQL condition selecting NAV outputs: no token id, or the NAV token id in
 * any stored spelling. The one filter every NAV query uses.
 */
const NAV_TOKEN_FILTER_SQL =
  `(token_id IS NULL OR lower(token_id) IN (${NAV_TOKEN_ID_FORMS.map((form) => `'${form}'`).join(', ')}))`;

/** Token filter for a query on wallet_outputs: NAV for null, else a bound token id. */
function tokenFilter(tokenId: string | null): { sql: string; params: string[] } {
  return tokenId === null
    ? { sql: NAV_TOKEN_FILTER_SQL, params: [] }
    : { sql: 'token_id = ?', params: [tokenId] };
}

/** Columns read into a WalletOutput. */
const WALLET_OUTPUT_COLUMNS = `output_hash, tx_hash, output_index, block_height, amount, gamma, memo, token_id,
             blinding_key, ephemeral_key, spending_key, is_spent, spent_tx_hash, spent_block_height,
             tx_type, timestamp, is_staked_commitment`;

/** Map a wallet_outputs row (WALLET_OUTPUT_COLUMNS) to a WalletOutput. */
function rowToWalletOutput(row: RowObject): WalletOutput {
  return {
    outputHash: row.output_hash as string,
    txHash: row.tx_hash as string,
    outputIndex: row.output_index as number,
    blockHeight: row.block_height as number,
    amount: decodeAmount(row.amount),
    gamma: (row.gamma as string) || '0',
    memo: row.memo as string | null,
    tokenId: row.token_id as string | null,
    blindingKey: row.blinding_key as string,
    ephemeralKey: (row.ephemeral_key as string | null) ?? null,
    spendingKey: row.spending_key as string,
    isSpent: (row.is_spent as number) === 1,
    spentTxHash: row.spent_tx_hash as string | null,
    spentBlockHeight: row.spent_block_height as number | null,
    txType: ((row.tx_type as string) || 'received') as TxType,
    timestamp: (row.timestamp as number) || 0,
    isStakedCommitment: (row.is_staked_commitment as number) === 1,
  };
}

/** Parse stored tx keys JSON; corrupt rows read as absent (null), on every backend. */
function parseTxKeys(txHash: string, keysData: unknown): any | null {
  try {
    return JSON.parse(keysData as string);
  } catch {
    console.warn(`[WalletDB] Ignoring corrupt tx keys for ${txHash}`);
    return null;
  }
}

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
   * Tail of the queue of transactional sections. The connection is shared,
   * so a BEGIN issued while another section's transaction is open would fail
   * (or fold the two together); sections run one at a time instead.
   */
  private transactionQueue: Promise<void> = Promise.resolve();

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

    // Zero deleted content, so a plaintext mnemonic replaced by its encrypted
    // form does not linger in free pages of the saved file.
    try {
      await this.adapter.run('PRAGMA secure_delete = ON');
    } catch {
      // Not supported by this backend – ignore
    }

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
   * Run `body` inside BEGIN/COMMIT, rolling back if it throws. Sections are
   * serialized on the shared connection: one waits for the previous to
   * finish. `body` must not start another section (it would wait for itself).
   */
  private async inTransaction<T>(body: (adapter: IDatabaseAdapter) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (!this.adapter) throw new Error('Database not open');
      const adapter = this.adapter;
      await adapter.run('BEGIN TRANSACTION');
      try {
        const result = await body(adapter);
        await adapter.run('COMMIT');
        return result;
      } catch (error) {
        try {
          await adapter.run('ROLLBACK');
        } catch {
          // No transaction left to roll back (e.g. COMMIT already ended it)
        }
        throw error;
      }
    };
    const result = this.transactionQueue.then(run);
    this.transactionQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * Run a query and collect every row. The statement is freed even when
   * stepping throws: a better-sqlite3 statement left mid-iteration keeps the
   * connection busy and every later write on it fails.
   */
  private async selectRows(sql: string, params?: unknown[]): Promise<RowObject[]> {
    if (!this.adapter) throw new Error('Database not open');
    const stmt = await this.adapter.prepare(sql);
    try {
      if (params) stmt.bind(params);
      const rows: RowObject[] = [];
      while (await stmt.step()) {
        rows.push(await stmt.getAsObject());
      }
      return rows;
    } finally {
      await stmt.free();
    }
  }

  /** The first row of a query, or null. */
  private async selectFirst(sql: string, params?: unknown[]): Promise<RowObject | null> {
    const rows = await this.selectRows(sql, params);
    return rows.length > 0 ? rows[0] : null;
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
    // We store the mnemonic directly because Scalar.deserialize/serialize may not roundtrip correctly.
    // An encrypted wallet stores only encrypted_seed (KeyManager.getEncryptedSeed).
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS master_seed (
        id INTEGER PRIMARY KEY,
        seed_hex TEXT,
        mnemonic TEXT,
        encrypted_seed TEXT
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

    // Collections created by this wallet (recorded at creation time)
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS created_collections (
        collection_token_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        token_public_key TEXT NOT NULL,
        metadata TEXT NOT NULL,
        total_supply TEXT NOT NULL,
        tx_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    // Standing swap orders published by this wallet (maker side)
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS standing_orders (
        local_id TEXT PRIMARY KEY,
        quote_id TEXT,
        status TEXT NOT NULL,
        offer_token_id TEXT,
        offer_amount TEXT NOT NULL,
        want_token_id TEXT,
        want_amount TEXT NOT NULL,
        expiry INTEGER NOT NULL,
        inputs TEXT NOT NULL,
        half_tx_hex TEXT NOT NULL,
        fee TEXT NOT NULL,
        created_at INTEGER NOT NULL
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
        amount TEXT NOT NULL DEFAULT '0',
        gamma TEXT NOT NULL DEFAULT '0',
        memo TEXT,
        token_id TEXT,
        blinding_key TEXT,
        ephemeral_key TEXT,
        spending_key TEXT,
        is_spent INTEGER NOT NULL DEFAULT 0,
        spent_tx_hash TEXT,
        spent_block_height INTEGER,
        created_at INTEGER NOT NULL,
        tx_type TEXT NOT NULL DEFAULT 'received',
        timestamp INTEGER NOT NULL DEFAULT 0,
        is_staked_commitment INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Private blinding scalars for outputs this wallet created. Kept in its
    // own table rather than as a column on wallet_outputs because that table's
    // row mappers feed WalletOutput, which the public getters hand to callers
    // — a secret must not ride along by accident.
    //
    // Safe on existing databases: CREATE TABLE IF NOT EXISTS just adds it, and
    // a wallet with no rows here falls back to the seed derivation.
    await this.adapter.run(`
      CREATE TABLE IF NOT EXISTS output_blinding_keys (
        output_hash TEXT PRIMARY KEY,
        blinding_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    try {
      await this.adapter.run(`ALTER TABLE master_seed ADD COLUMN encrypted_seed TEXT`);
    } catch {
      // Column already exists – ignore
    }

    // Migrate existing databases: add tx_type and timestamp columns if missing
    try {
      await this.adapter.run(`ALTER TABLE wallet_outputs ADD COLUMN tx_type TEXT NOT NULL DEFAULT 'received'`);
    } catch {
      // Column already exists – ignore
    }
    try {
      await this.adapter.run(`ALTER TABLE wallet_outputs ADD COLUMN timestamp INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists – ignore
    }
    try {
      // The output's ephemeral key (k*G). Nullable, so existing rows simply
      // carry NULL until they are re-synced.
      await this.adapter.run(`ALTER TABLE wallet_outputs ADD COLUMN ephemeral_key TEXT`);
    } catch {
      // Column already exists – ignore
    }
    // The column and its backfill commit together. Otherwise a crash between
    // them leaves the column in place, so the backfill never runs again and
    // old staked outputs stay spendable.
    await this.inTransaction(async (adapter) => {
      let addedStakedCommitmentColumn = false;
      try {
        await adapter.run(
          `ALTER TABLE wallet_outputs ADD COLUMN is_staked_commitment INTEGER NOT NULL DEFAULT 0`
        );
        addedStakedCommitmentColumn = true;
      } catch {
        // Column already exists – ignore
      }
      if (addedStakedCommitmentColumn) {
        await this.backfillStakedCommitments();
      }
    });

    // Amounts used to be INTEGER columns: a u64 above 2^63 - 1 does not fit,
    // and the JS numbers they were read into lost precision above 2^53. They
    // are decimal TEXT now. Each rebuild commits with its data conversion, so
    // an interrupted one leaves the old table in place and runs again.
    await this.inTransaction(async (adapter) => {
      const rebuilt = await this.retypeColumnAsText(
        'wallet_outputs', 'amount', 'amount INTEGER NOT NULL DEFAULT 0', "amount TEXT NOT NULL DEFAULT '0'"
      );
      if (rebuilt) {
        // Store the NAV token id as null, as sync writes it now.
        await adapter.run(`UPDATE wallet_outputs SET token_id = NULL WHERE ${NAV_TOKEN_FILTER_SQL}`);
      }
    });
    await this.inTransaction(() => this.retypeColumnAsText(
      'created_collections', 'total_supply', 'total_supply INTEGER NOT NULL', 'total_supply TEXT NOT NULL'
    ));

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
   * Rebuild `table` with `column` declared TEXT instead of INTEGER, converting
   * its values to decimal strings. Returns false (and does nothing) when the
   * column is not declared INTEGER. Must run inside a transaction.
   *
   * Follows SQLite's generalized ALTER TABLE procedure: the new table is
   * declared from the stored CREATE statement with only `fromDecl` replaced,
   * so columns added by earlier migrations survive, and the table's indexes
   * are recreated.
   */
  private async retypeColumnAsText(
    table: string,
    column: string,
    fromDecl: string,
    toDecl: string
  ): Promise<boolean> {
    if (!this.adapter) throw new Error('Database not open');
    const info = await this.selectRows(`PRAGMA table_info(${table})`);
    const target = info.find((col) => col.name === column);
    if (!target || String(target.type).toUpperCase() !== 'INTEGER') {
      return false;
    }

    const schema = await this.selectRows(
      'SELECT type, sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL',
      [table]
    );
    const createSql = schema.find((row) => row.type === 'table')?.sql as string | undefined;
    const tableName = /^CREATE TABLE\s+(IF NOT EXISTS\s+)?["`[]?\w+["`\]]?/i;
    if (!createSql || !createSql.includes(fromDecl) || !tableName.test(createSql)) {
      throw new Error(`Cannot migrate ${table}.${column}: unexpected table definition`);
    }
    const tempTable = `${table}_migrating`;
    const newCreateSql = createSql
      .replace(fromDecl, toDecl)
      .replace(tableName, `CREATE TABLE ${tempTable}`);

    // Exact for integers. A REAL (an amount that had already overflowed)
    // keeps its integral part.
    const columns = info.map((col) => String(col.name));
    const values = columns.map((name) => name !== column ? name : `
      CASE typeof(${column})
        WHEN 'integer' THEN CAST(${column} AS TEXT)
        WHEN 'real' THEN printf('%.0f', ${column})
        WHEN 'text' THEN ${column}
        ELSE '0'
      END`);

    await this.adapter.run(`DROP TABLE IF EXISTS ${tempTable}`);
    await this.adapter.run(newCreateSql);
    await this.adapter.run(
      `INSERT INTO ${tempTable} (${columns.join(', ')}) SELECT ${values.join(', ')} FROM ${table}`
    );
    await this.adapter.run(`DROP TABLE ${table}`);
    await this.adapter.run(`ALTER TABLE ${tempTable} RENAME TO ${table}`);
    for (const row of schema) {
      if (row.type === 'index') {
        await this.adapter.run(String(row.sql));
      }
    }
    return true;
  }

  /**
   * Flag the staked commitments among outputs stored before the
   * is_staked_commitment column existed, from their serialized output.
   */
  private async backfillStakedCommitments(): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    const rows = await this.selectRows(
      `SELECT output_hash, output_data FROM wallet_outputs WHERE output_data != ''`
    );
    const staked = rows
      .filter((row) => isStakedCommitmentOutputHex(row.output_data as string))
      .map((row) => row.output_hash as string);
    for (const outputHash of staked) {
      await this.adapter.run(
        'UPDATE wallet_outputs SET is_staked_commitment = 1 WHERE output_hash = ?',
        [outputHash]
      );
    }
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
    let walletFound = false;

    // Load HD chain when available. Watch-only audit-key wallets do not have one.
    const hdChainResult = await this.adapter.exec('SELECT * FROM hd_chain LIMIT 1');
    if (hdChainResult.length > 0 && hdChainResult[0].values.length > 0) {
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
      walletFound = true;
    }

    // Load mnemonic for recovery
    // First try to load mnemonic (new format), then fall back to seed_hex (old format)
    const masterSeedResult = await this.adapter.exec(
      'SELECT mnemonic, seed_hex, encrypted_seed FROM master_seed WHERE id = 0'
    );
    if (masterSeedResult.length > 0 && masterSeedResult[0].values.length > 0) {
      const mnemonic = masterSeedResult[0].values[0][0] as string | null;
      const seedHex = masterSeedResult[0].values[0][1] as string | null;
      const encryptedSeed = masterSeedResult[0].values[0][2] as string | null;

      if (encryptedSeed) {
        // Decrypted on unlock()
        keyManager.loadEncryptedSeed(encryptedSeed);
        walletFound = true;
      } else if (mnemonic) {
        keyManager.setHDSeedFromMnemonic(mnemonic);
        walletFound = true;
      } else if (seedHex) {
        // Legacy: load from seed hex (may not roundtrip correctly)
        keyManager.loadMasterSeed(seedHex);
        walletFound = true;
      }
    }

    // Load view key
    const viewKeyResult = await this.adapter.exec('SELECT * FROM view_key LIMIT 1');
    if (viewKeyResult.length > 0 && viewKeyResult[0].values.length > 0) {
      const row = viewKeyResult[0].values[0];
      const viewKey = this.deserializeViewKey(row[1] as string);
      keyManager.loadViewKey(viewKey);
      walletFound = true;
    }

    // Load spend key
    const spendKeyResult = await this.adapter.exec('SELECT * FROM spend_key LIMIT 1');
    if (spendKeyResult.length > 0 && spendKeyResult[0].values.length > 0) {
      const row = spendKeyResult[0].values[0];
      const publicKey = this.deserializePublicKey(row[0] as string);
      keyManager.loadSpendKey(publicKey);
      walletFound = true;
    }

    if (!walletFound) {
      throw new Error('No wallet found in database');
    }

    // Load keys
    const keysResult = await this.adapter.exec('SELECT * FROM keys');
    if (keysResult.length > 0) {
      for (const row of keysResult[0].values) {
        const secretKey = this.deserializeScalar(row[1] as string);
        const publicKey = this.deserializePublicKey(row[2] as string);
        keyManager.loadKey(secretKey, publicKey);

        // Load metadata
        const metadataRow = await this.selectFirst('SELECT create_time FROM key_metadata WHERE key_id = ?', [row[0]]);
        if (metadataRow) {
          keyManager.loadKeyMetadata(this.hexToBytes(row[0] as string), {
            nCreateTime: metadataRow.create_time as number,
          });
        }
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

    // Regenerate the default sub-address pools (like navio-core does during
    // startup). The pools are deterministic from the keys, so this always
    // yields the same first entries regardless of what was persisted.
    keyManager.newSubAddressPool(0);
    keyManager.newSubAddressPool(-1);
    keyManager.newSubAddressPool(-2);

    // Then load persisted sub-addresses on top: entries past the default pools
    // (fresh receive addresses handed out in earlier sessions, recovered
    // mappings) are only known through these rows. Loading also advances the
    // per-account counters past them so generation never reuses an index.
    const subAddressesResult = await this.adapter.exec('SELECT hash_id, account, address FROM sub_addresses');
    if (subAddressesResult.length > 0) {
      for (const row of subAddressesResult[0].values) {
        const hashId = this.hexToBytes(row[0] as string);
        const id: SubAddressIdentifier = {
          account: Number(row[1]),
          address: Number(row[2]),
        };
        keyManager.loadSubAddress(hashId, id);
      }
    }

    // An encrypted wallet loads locked
    const encryptionMetadata = await this.getEncryptionMetadata();
    if (encryptionMetadata) {
      keyManager.setEncryptionParams(encryptionMetadata.salt, encryptionMetadata.verificationHash);
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

    // Drop outputs/sync data left by a different wallet, then save the
    // wallet and its metadata, all in one transaction
    await this.replaceWallet(keyManager, {
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

    // Drop outputs/sync data left by a different wallet, then save the
    // wallet and its metadata, all in one transaction
    await this.replaceWallet(keyManager, {
      creationHeight: creationHeight ?? 0,
      creationTime: Date.now(),
      restoredFromSeed: true,
    });

    this.keyManager = keyManager;
    return keyManager;
  }

  /**
   * Restore a watch-only wallet from a BLSCT audit key.
   * Format matches navio-core getblsctauditkey / IMPORT_VIEW_KEY:
   * 32-byte private view key || 48-byte public spending key.
   */
  async restoreWalletFromAuditKey(auditKeyHex: string, creationHeight?: number): Promise<KeyManager> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not open. Call open() first.');
    }
    if (!/^[0-9a-fA-F]{160}$/.test(auditKeyHex)) {
      throw new Error('Audit key must be 160 hex characters long');
    }

    const keyManager = new KeyManager();
    const imported = keyManager.setupGeneration(this.hexToBytes(auditKeyHex), 'IMPORT_VIEW_KEY');
    if (!imported) {
      throw new Error('Failed to import audit key');
    }

    // Drop outputs/sync data left by a different wallet, then save the
    // wallet and its metadata, all in one transaction
    await this.replaceWallet(keyManager, {
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

    // Drop outputs/sync data left by a different wallet, then save the
    // wallet and its metadata, all in one transaction
    await this.replaceWallet(keyManager, {
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

    await this.writeWalletMetadata(metadata);

    // Persist to disk
    await this.persistToDisk();
  }

  private async writeWalletMetadata(metadata: {
    creationHeight: number;
    creationTime: number;
    restoredFromSeed: boolean;
  }): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    await this.adapter.run(
      `INSERT OR REPLACE INTO wallet_metadata (id, creation_height, creation_time, restored_from_seed, version)
       VALUES (0, ?, ?, ?, 1)`,
      [metadata.creationHeight, metadata.creationTime, metadata.restoredFromSeed ? 1 : 0]
    );
  }

  /**
   * Write a newly created or restored wallet: drop data a different wallet
   * left behind, save the keys and the metadata. One transaction, so a crash
   * cannot leave the old wallet's outputs gone but the new keys unsaved (or
   * the new keys saved next to the old wallet's outputs).
   */
  private async replaceWallet(
    keyManager: KeyManager,
    metadata: { creationHeight: number; creationTime: number; restoredFromSeed: boolean }
  ): Promise<void> {
    await this.inTransaction(async () => {
      await this.discardForeignWalletData(keyManager);
      await this.writeWallet(keyManager);
      await this.writeWalletMetadata(metadata);
    });
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
   * Exports the current database and imports into a new adapter. With the
   * better-sqlite3 adapter, a file path receives the database (owner-only
   * permissions) and later writes persist there; an existing file is never
   * overwritten. ':memory:' keeps the copy in memory.
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

    await this.inTransaction(() => this.writeWallet(km));
    await this.persistToDisk();
  }

  /** Replace the stored keys with `km`'s. Must run inside a transaction. */
  private async writeWallet(km: KeyManager): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    const adapter = this.adapter;

    // Clear existing data (for simplicity, we'll replace everything)
    // In production, you might want to do incremental updates
    await adapter.run('DELETE FROM keys');
    await adapter.run('DELETE FROM out_keys');
    await adapter.run('DELETE FROM crypted_keys');
    await adapter.run('DELETE FROM crypted_out_keys');
    await adapter.run('DELETE FROM view_key');
    await adapter.run('DELETE FROM spend_key');
    await adapter.run('DELETE FROM hd_chain');
    await adapter.run('DELETE FROM master_seed');
    await adapter.run('DELETE FROM sub_addresses');
    await adapter.run('DELETE FROM sub_addresses_str');
    await adapter.run('DELETE FROM sub_address_pool');
    await adapter.run('DELETE FROM sub_address_counter');
    await adapter.run('DELETE FROM key_metadata');
    await adapter.run('DELETE FROM encryption_metadata');

    // Save HD chain
    const hdChain = km.getHDChain();
    if (hdChain) {
      const stmt = await adapter.prepare(
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

    // Save the seed for recovery when reopening wallet: encrypted for an
    // encrypted wallet, otherwise the mnemonic (stored directly because
    // Scalar.deserialize/serialize may not roundtrip correctly).
    // None for a view-only wallet.
    const seed = km.getSeedForStorage();
    if (seed) {
      const seedStmt = await adapter.prepare(
        'INSERT INTO master_seed (id, mnemonic, seed_hex, encrypted_seed) VALUES (0, ?, ?, ?)'
      );
      await seedStmt.run([
        'mnemonic' in seed ? seed.mnemonic : null,
        'seedHex' in seed ? seed.seedHex : null,
        'encryptedSeed' in seed ? seed.encryptedSeed : null,
      ]);
      await seedStmt.free();
    }

    const encryptionParams = km.getEncryptionParams();
    if (encryptionParams) {
      await adapter.run(
        `INSERT INTO encryption_metadata (id, is_encrypted, salt, verification_hash, encryption_version)
         VALUES (0, 1, ?, ?, 1)`,
        [encryptionParams.salt, encryptionParams.verificationHash]
      );
    }

    // Save view key
    try {
      const viewKey = km.getPrivateViewKey();
      const viewPublicKey = this.getPublicKeyFromViewKey(viewKey);
      const stmt = await adapter.prepare('INSERT INTO view_key (public_key, secret_key) VALUES (?, ?)');
      await stmt.run([this.serializePublicKey(viewPublicKey), this.serializeViewKey(viewKey)]);
      await stmt.free();
    } catch {
      // View key not available
    }

    // Save spend key
    try {
      const spendPublicKey = km.getPublicSpendingKey();
      const stmt = await adapter.prepare('INSERT INTO spend_key (public_key) VALUES (?)');
      await stmt.run([this.serializePublicKey(spendPublicKey)]);
      await stmt.free();
    } catch {
      // Spend key not available
    }

    // Save sub-address mappings (hashId -> account/address) so sub-addresses
    // past the default pools survive a reload.
    await this.insertSubAddressRows(km.getSubAddressEntries());

    // Note: Keys, output keys and encrypted keys are reconstructed from the
    // seed / view key on load.
  }

  async saveSubAddresses(entries: SubAddressEntry[]): Promise<void> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not open');
    }
    if (entries.length === 0) {
      return;
    }
    await this.insertSubAddressRows(entries);
    await this.persistToDisk();
  }

  private async insertSubAddressRows(entries: SubAddressEntry[]): Promise<void> {
    if (!this.adapter || entries.length === 0) {
      return;
    }
    const stmt = await this.adapter.prepare(
      'INSERT OR REPLACE INTO sub_addresses (hash_id, account, address) VALUES (?, ?, ?)'
    );
    for (const entry of entries) {
      await stmt.run([entry.hashId, entry.account, entry.address]);
    }
    await stmt.free();
  }

  /**
   * Drop data that belongs to a previously stored wallet when a different
   * wallet (different spending key) is written into this database.
   *
   * Outputs, created collections and sync progress are tied to the keys that
   * detected them: kept across a restore with a different seed they show up
   * in the new wallet's balance and get selected as inputs, and the spend
   * then fails with "does not map to a known sub-address in this wallet".
   * Restoring the same seed again keeps everything (no re-sync needed).
   * Must run inside a transaction (see replaceWallet).
   */
  private async discardForeignWalletData(incoming: KeyManager): Promise<void> {
    if (!this.adapter) {
      return;
    }
    if (!(await this.holdsDifferentWallet(incoming))) {
      return;
    }
    await this.adapter.run('DELETE FROM wallet_outputs');
    await this.adapter.run('DELETE FROM created_collections');
    await this.adapter.run('DELETE FROM standing_orders');
    // Another seed's blinding scalars are not ours and can never verify.
    await this.adapter.run('DELETE FROM output_blinding_keys');
    await this.clearSyncData();
  }

  private async holdsDifferentWallet(incoming: KeyManager): Promise<boolean> {
    if (!this.adapter) {
      return false;
    }
    const outputs = await this.adapter.exec('SELECT COUNT(*) FROM wallet_outputs');
    const syncState = await this.adapter.exec('SELECT COUNT(*) FROM sync_state');
    const count = (rows: typeof outputs) => (rows.length > 0 ? Number(rows[0].values[0][0]) : 0);
    if (count(outputs) === 0 && count(syncState) === 0) {
      return false;
    }

    const stored = await this.adapter.exec('SELECT public_key FROM spend_key LIMIT 1');
    if (stored.length === 0 || stored[0].values.length === 0) {
      // Wallet data without a wallet: nothing it can belong to.
      return true;
    }
    let incomingSpendKey: string;
    try {
      incomingSpendKey = this.serializePublicKey(incoming.getPublicSpendingKey());
    } catch {
      return true;
    }
    return String(stored[0].values[0][0]) !== incomingSpendKey;
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

  async saveCreatedCollection(record: CreatedCollectionRecord): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    const stmt = await this.adapter.prepare(`
      INSERT OR REPLACE INTO created_collections
      (collection_token_id, kind, token_public_key, metadata, total_supply, tx_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    await stmt.run([
      record.collectionTokenId,
      record.kind,
      record.tokenPublicKey,
      JSON.stringify(record.metadata),
      encodeAmount(record.totalSupply, 'totalSupply'),
      record.txId,
      record.createdAt,
    ]);
    await stmt.free();
    await this.persistToDisk();
  }

  async saveStandingOrder(row: StandingOrderRow): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    const stmt = await this.adapter.prepare(`
      INSERT OR REPLACE INTO standing_orders
      (local_id, quote_id, status, offer_token_id, offer_amount, want_token_id, want_amount, expiry, inputs, half_tx_hex, fee, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    await stmt.run([
      row.localId, row.quoteId, row.status, row.offerTokenId, row.offerAmount, row.wantTokenId, row.wantAmount,
      row.expiry, JSON.stringify(row.inputs), row.halfTxHex, row.fee, row.createdAt,
    ]);
    await stmt.free();
    await this.persistToDisk();
  }

  async getStandingOrders(): Promise<StandingOrderRow[]> {
    if (!this.adapter) throw new Error('Database not open');
    const result = await this.adapter.exec(
      'SELECT local_id, quote_id, status, offer_token_id, offer_amount, want_token_id, want_amount, expiry, inputs, half_tx_hex, fee, created_at FROM standing_orders ORDER BY created_at'
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => ({
      localId: String(row[0]),
      quoteId: row[1] === null || row[1] === undefined ? null : String(row[1]),
      status: String(row[2]) as StandingOrderRow['status'],
      offerTokenId: row[3] === null || row[3] === undefined ? null : String(row[3]),
      offerAmount: String(row[4]),
      wantTokenId: row[5] === null || row[5] === undefined ? null : String(row[5]),
      wantAmount: String(row[6]),
      expiry: Number(row[7]),
      inputs: JSON.parse(String(row[8])) as string[],
      halfTxHex: String(row[9]),
      fee: String(row[10]),
      createdAt: Number(row[11]),
    }));
  }

  async deleteStandingOrder(localId: string): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    const stmt = await this.adapter.prepare('DELETE FROM standing_orders WHERE local_id = ?');
    await stmt.run([localId]);
    await stmt.free();
    await this.persistToDisk();
  }

  async getCreatedCollections(): Promise<CreatedCollectionRecord[]> {
    if (!this.adapter) throw new Error('Database not open');
    const result = await this.adapter.exec(
      'SELECT collection_token_id, kind, token_public_key, metadata, total_supply, tx_id, created_at FROM created_collections ORDER BY created_at'
    );
    if (result.length === 0) {
      return [];
    }
    return result[0].values.map((row) => {
      let metadata: Record<string, string> = {};
      try {
        metadata = JSON.parse(row[3] as string);
      } catch {
        // Corrupt metadata JSON is non-fatal; return the record without it.
      }
      return {
        collectionTokenId: row[0] as string,
        kind: row[1] as 'token' | 'nft',
        tokenPublicKey: row[2] as string,
        metadata,
        totalSupply: decodeAmount(row[4]),
        txId: row[5] as string,
        createdAt: row[6] as number,
      };
    });
  }

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
    const row = await this.selectFirst('SELECT hash FROM block_hashes WHERE height = ?', [height]);
    return row ? (row.hash as string) : null;
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
    const row = await this.selectFirst('SELECT keys_data FROM tx_keys WHERE tx_hash = ?', [txHash]);
    return row ? parseTxKeys(txHash, row.keys_data) : null;
  }

  async getTxKeysByHeight(height: number): Promise<{ txHash: string; keys: any }[]> {
    if (!this.adapter) throw new Error('Database not open');
    const rows = await this.selectRows('SELECT tx_hash, keys_data FROM tx_keys WHERE block_height = ?', [height]);
    const results: { txHash: string; keys: any }[] = [];
    for (const row of rows) {
      const keys = parseTxKeys(row.tx_hash as string, row.keys_data);
      if (keys !== null) {
        results.push({ txHash: row.tx_hash as string, keys });
      }
    }
    return results;
  }

  async deleteTxKeysByHeight(height: number): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    const stmt = await this.adapter.prepare('DELETE FROM tx_keys WHERE block_height = ?');
    await stmt.run([height]);
    await stmt.free();
  }

  async saveOutputBlindingKey(outputHash: string, blindingKeyPrivate: string): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    const stmt = await this.adapter.prepare(
      `INSERT OR REPLACE INTO output_blinding_keys (output_hash, blinding_key, created_at)
       VALUES (?, ?, ?)`
    );
    await stmt.run([outputHash, blindingKeyPrivate, Date.now()]);
    await stmt.free();
  }

  async getOutputBlindingKey(outputHash: string): Promise<string | null> {
    if (!this.adapter) throw new Error('Database not open');
    const row = await this.selectFirst(
      'SELECT blinding_key FROM output_blinding_keys WHERE output_hash = ?',
      [outputHash]
    );
    return (row?.blinding_key as string | undefined) ?? null;
  }

  async getOutputData(outputHash: string): Promise<string | null> {
    if (!this.adapter) throw new Error('Database not open');
    const row = await this.selectFirst('SELECT output_data FROM wallet_outputs WHERE output_hash = ?', [outputHash]);
    return (row?.output_data as string | undefined) || null;
  }

  async storeWalletOutput(p: StoreOutputParams): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    // Upsert, not INSERT OR REPLACE: re-processing a block must not reset a
    // spent output to unspent, nor its creation time. Once a row is spent its
    // spent state is kept; unspending is revertBlocksFrom's job.
    await this.adapter.run(
      `INSERT INTO wallet_outputs
       (output_hash, tx_hash, output_index, block_height, output_data, amount, gamma, memo, token_id,
        blinding_key, ephemeral_key, spending_key, is_spent, spent_tx_hash, spent_block_height, created_at,
        tx_type, timestamp, is_staked_commitment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(output_hash) DO UPDATE SET
         tx_hash = excluded.tx_hash,
         output_index = excluded.output_index,
         block_height = excluded.block_height,
         output_data = excluded.output_data,
         amount = excluded.amount,
         gamma = excluded.gamma,
         memo = excluded.memo,
         token_id = excluded.token_id,
         blinding_key = excluded.blinding_key,
         ephemeral_key = excluded.ephemeral_key,
         spending_key = excluded.spending_key,
         tx_type = excluded.tx_type,
         timestamp = excluded.timestamp,
         is_staked_commitment = excluded.is_staked_commitment,
         spent_tx_hash = CASE WHEN wallet_outputs.is_spent = 1
           THEN wallet_outputs.spent_tx_hash ELSE excluded.spent_tx_hash END,
         spent_block_height = CASE WHEN wallet_outputs.is_spent = 1
           THEN wallet_outputs.spent_block_height ELSE excluded.spent_block_height END,
         is_spent = CASE WHEN wallet_outputs.is_spent = 1 THEN 1 ELSE excluded.is_spent END`,
      [
        p.outputHash, p.txHash, p.outputIndex, p.blockHeight, p.outputData,
        encodeAmount(p.amount), p.gamma, p.memo, p.tokenId, p.blindingKey, p.ephemeralKey ?? null, p.spendingKey,
        p.isSpent ? 1 : 0, p.spentTxHash, p.spentBlockHeight, Date.now(),
        p.txType, p.timestamp, p.isStakedCommitment ? 1 : 0,
      ]
    );
  }

  async isOutputUnspent(outputHash: string): Promise<boolean> {
    if (!this.adapter) throw new Error('Database not open');
    const row = await this.selectFirst(
      'SELECT output_hash FROM wallet_outputs WHERE output_hash = ? AND is_spent = 0',
      [outputHash]
    );
    return row !== null;
  }

  async isOutputSpentInMempool(outputHash: string): Promise<boolean> {
    if (!this.adapter) throw new Error('Database not open');
    const row = await this.selectFirst(
      'SELECT output_hash FROM wallet_outputs WHERE output_hash = ? AND is_spent = 1 AND spent_block_height = 0',
      [outputHash]
    );
    return row !== null;
  }

  async getMempoolSpentTxHash(outputHash: string): Promise<string | null> {
    if (!this.adapter) throw new Error('Database not open');
    const row = await this.selectFirst(
      'SELECT spent_tx_hash FROM wallet_outputs WHERE output_hash = ? AND is_spent = 1 AND spent_block_height = 0',
      [outputHash]
    );
    return (row?.spent_tx_hash as string | undefined) || null;
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

  async revertBlocksFrom(fromHeight: number, state: SyncState): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    // Height 0 marks mempool rows; a revert must never reach them.
    if (!Number.isInteger(fromHeight) || fromHeight < 1) {
      throw new Error(`Invalid revert height: ${fromHeight}`);
    }

    await this.inTransaction(async (adapter) => {
      await this.saveSyncState(state);
      await adapter.run('DELETE FROM tx_keys WHERE block_height >= ?', [fromHeight]);
      await adapter.run('DELETE FROM wallet_outputs WHERE block_height >= ?', [fromHeight]);
      await adapter.run(
        `UPDATE wallet_outputs SET is_spent = 0, spent_tx_hash = NULL, spent_block_height = NULL
         WHERE spent_block_height >= ?`,
        [fromHeight]
      );
      await adapter.run('DELETE FROM block_hashes WHERE height >= ?', [fromHeight]);
    });
  }

  async getPendingSpentAmount(tokenId: string | null = null): Promise<bigint> {
    if (!this.adapter) throw new Error('Database not open');

    // Summed in JS: SQL SUM over u64 amounts overflows (and the column is TEXT).
    const filter = tokenFilter(tokenId);
    return this.sumAmounts(
      `SELECT amount FROM wallet_outputs WHERE is_spent = 1 AND spent_block_height = 0 AND ${filter.sql}`,
      filter.params
    );
  }

  /** Sum the amount column of a query's rows exactly. */
  private async sumAmounts(sql: string, params: unknown[]): Promise<bigint> {
    const rows = await this.selectRows(sql, params);
    return rows.reduce((total, row) => total + decodeAmount(row.amount), 0n);
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

    // Spendable balance: staked commitments are locked for staking. NAV is
    // any of the stored spellings of its token id (see NAV_TOKEN_FILTER_SQL).
    // Summed in JS: SQL SUM over u64 amounts overflows (and the column is TEXT).
    const filter = tokenFilter(tokenId);
    return this.sumAmounts(
      `SELECT amount FROM wallet_outputs WHERE is_spent = 0 AND is_staked_commitment = 0 AND ${filter.sql}`,
      filter.params
    );
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

    const filter = tokenFilter(tokenId);
    const rows = await this.selectRows(
      `SELECT ${WALLET_OUTPUT_COLUMNS}
       FROM wallet_outputs
       WHERE is_spent = 0 AND is_staked_commitment = 0 AND ${filter.sql}
       ORDER BY block_height ASC`,
      filter.params
    );
    return rows.map(rowToWalletOutput);
  }

  /**
   * Get all outputs (spent and unspent)
   * @returns Array of all wallet outputs
   */
  async getAllOutputs(): Promise<WalletOutput[]> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not initialized');
    }

    const rows = await this.selectRows(
      `SELECT ${WALLET_OUTPUT_COLUMNS} FROM wallet_outputs ORDER BY block_height ASC`
    );
    return rows.map(rowToWalletOutput);
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

    const row = await this.selectFirst('SELECT is_encrypted FROM encryption_metadata WHERE id = 0');
    return row !== null && (row.is_encrypted as number) === 1;
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

    const row = await this.selectFirst(
      'SELECT salt, verification_hash FROM encryption_metadata WHERE id = 0 AND is_encrypted = 1'
    );
    if (row && row.salt && row.verification_hash) {
      return {
        salt: row.salt as string,
        verificationHash: row.verification_hash as string,
      };
    }
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

    const row = await this.selectFirst(
      'SELECT public_key, encrypted_secret FROM crypted_keys WHERE key_id = ?',
      [keyId]
    );
    return row
      ? { publicKey: row.public_key as string, encryptedSecret: row.encrypted_secret as string }
      : null;
  }

  /**
   * Get all encrypted keys from the database
   * @returns Array of encrypted key data
   */
  async getAllEncryptedKeys(): Promise<Array<{ keyId: string; publicKey: string; encryptedSecret: string }>> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not initialized');
    }

    const rows = await this.selectRows('SELECT key_id, public_key, encrypted_secret FROM crypted_keys');
    return rows.map((row) => ({
      keyId: row.key_id as string,
      publicKey: row.public_key as string,
      encryptedSecret: row.encrypted_secret as string,
    }));
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

    const row = await this.selectFirst(
      'SELECT public_key, encrypted_secret FROM crypted_out_keys WHERE out_id = ?',
      [outId]
    );
    return row
      ? { publicKey: row.public_key as string, encryptedSecret: row.encrypted_secret as string }
      : null;
  }

  /**
   * Get all encrypted output keys from the database
   * @returns Array of encrypted output key data
   */
  async getAllEncryptedOutKeys(): Promise<Array<{ outId: string; publicKey: string; encryptedSecret: string }>> {
    if (!this.opened || !this.adapter) {
      throw new Error('Database not initialized');
    }

    const rows = await this.selectRows('SELECT out_id, public_key, encrypted_secret FROM crypted_out_keys');
    return rows.map((row) => ({
      outId: row.out_id as string,
      publicKey: row.public_key as string,
      encryptedSecret: row.encrypted_secret as string,
    }));
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
