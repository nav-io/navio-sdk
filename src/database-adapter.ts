/**
 * Cross-Platform Database Adapter Interface
 *
 * Provides a unified async API for SQLite database operations across:
 * - Node.js: better-sqlite3
 * - Testing: sql.js (in-memory)
 * - Mobile: Native SQLite via Capacitor/Expo (planned)
 *
 * Browser environments use IndexedDB directly via IndexedDBWalletDB,
 * bypassing the SQL adapter layer entirely.
 *
 * All implementations provide efficient page-level persistence (not full DB export/import).
 *
 * @module database-adapter
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Result from a SQL query
 */
export interface QueryResult {
  /** Column names */
  columns: string[];
  /** Array of rows, each row is an array of values */
  values: any[][];
}

/**
 * Row object returned by statement iteration
 */
export interface RowObject {
  [key: string]: any;
}

/**
 * Prepared statement interface
 */
export interface IPreparedStatement {
  /**
   * Bind parameters to the statement
   * @param params - Array of parameter values
   */
  bind(params?: any[]): IPreparedStatement;

  /**
   * Execute and advance to next row
   * @returns True if there is another row
   */
  step(): Promise<boolean>;

  /**
   * Get current row as object with column names as keys
   */
  getAsObject(): Promise<RowObject>;

  /**
   * Get current row as array
   */
  get(): Promise<any[]>;

  /**
   * Execute with params and reset (for INSERT/UPDATE/DELETE)
   * @param params - Optional parameters
   */
  run(params?: any[]): Promise<void>;

  /**
   * Free statement resources
   */
  free(): Promise<void>;
}

/**
 * Database adapter interface
 *
 * All methods are async to support Web Worker-based implementations.
 */
export interface IDatabaseAdapter {
  /**
   * Open or create a database
   * @param path - Database path/name (meaning varies by adapter)
   * @param data - Optional initial data to import
   */
  open(path: string, data?: Uint8Array): Promise<void>;

  /**
   * Execute one or more SQL statements
   * @param sql - SQL statement(s) to execute
   * @returns Array of query results
   */
  exec(sql: string): Promise<QueryResult[]>;

  /**
   * Execute a single SQL statement with optional parameters
   * @param sql - SQL statement
   * @param params - Optional parameter values
   */
  run(sql: string, params?: any[]): Promise<void>;

  /**
   * Prepare a statement for repeated execution
   * @param sql - SQL statement
   * @returns Prepared statement
   */
  prepare(sql: string): Promise<IPreparedStatement>;

  /**
   * Export the database as binary data
   * @returns Database bytes
   */
  export(): Promise<Uint8Array>;

  /**
   * Close the database connection
   */
  close(): Promise<void>;

  /**
   * Check if the database is currently open
   */
  isOpen(): boolean;

  /**
   * Get the database path/name
   */
  getPath(): string;

  /**
   * Force save to persistent storage (if applicable)
   * Some adapters auto-persist, others need explicit save.
   */
  save?(): Promise<void>;
}

/**
 * Database adapter types
 */
export type DatabaseAdapterType =
  | 'browser' // Alias for 'indexeddb' (handled by NavioClient)
  | 'indexeddb' // Browser with native IndexedDB (handled by NavioClient)
  | 'better-sqlite3' // Node.js native SQLite (supports :memory: paths)
  | 'capacitor' // Mobile (Capacitor)
  | 'expo'; // Mobile (Expo)

/**
 * Options for creating a database adapter
 */
export interface DatabaseAdapterOptions {
  /** Force a specific adapter type (auto-detected if not specified) */
  type?: DatabaseAdapterType;
  /** Auto-save interval in milliseconds (0 to disable) */
  autoSaveInterval?: number;
  /** Enable verbose logging */
  debug?: boolean;
}

/**
 * Detect the current runtime environment
 */
export function detectEnvironment(): 'browser' | 'node' | 'worker' | 'unknown' {
  if (typeof self !== 'undefined' && typeof (self as any).WorkerGlobalScope !== 'undefined') {
    return 'worker';
  }
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    return 'browser';
  }
  if (
    typeof process !== 'undefined' &&
    process.versions != null &&
    process.versions.node != null
  ) {
    return 'node';
  }
  return 'unknown';
}

/**
 * Check if OPFS is available (for browser environments)
 */
export async function isOpfsAvailable(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    return false;
  }

  try {
    // Try to access OPFS root
    await navigator.storage.getDirectory();
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Web Workers are available
 */
export function isWorkerAvailable(): boolean {
  return typeof Worker !== 'undefined';
}

/**
 * Create a database adapter appropriate for the current environment
 *
 * @param options - Adapter options
 * @returns Database adapter instance
 *
 * @example
 * ```typescript
 * // Auto-detect best adapter
 * const adapter = await createDatabaseAdapter();
 * await adapter.open('wallet.db');
 *
 * // Force specific adapter
 * const adapter = await createDatabaseAdapter({ type: 'better-sqlite3' });
 * ```
 */
export async function createDatabaseAdapter(
  options: DatabaseAdapterOptions = {}
): Promise<IDatabaseAdapter> {
  const env = detectEnvironment();

  // If type is explicitly specified, use that
  if (options.type) {
    return createAdapterByType(options.type, options);
  }

  // Auto-detect best adapter for environment
  switch (env) {
    case 'browser':
    case 'worker':
      throw new Error(
        'Browser environments should use IndexedDB via NavioClient (databaseAdapter: "indexeddb"). ' +
        'createDatabaseAdapter() only supports SQL-based adapters (better-sqlite3).'
      );

    case 'node':
      return createAdapterByType('better-sqlite3', options);

    default:
      return createAdapterByType('better-sqlite3', options);
  }
}

/**
 * Create a specific adapter type
 */
async function createAdapterByType(
  type: DatabaseAdapterType,
  options: DatabaseAdapterOptions
): Promise<IDatabaseAdapter> {
  switch (type) {
    case 'better-sqlite3': {
      const { NodeAdapter } = await import('./adapters/node-adapter');
      return new NodeAdapter(options);
    }

    case 'browser':
    case 'indexeddb':
      throw new Error(
        'Browser/IndexedDB adapters are handled by NavioClient directly, not through createDatabaseAdapter(). ' +
        'Use NavioClient with databaseAdapter: "indexeddb".'
      );

    case 'capacitor':
    case 'expo':
      throw new Error(`${type} adapter not yet implemented. Use manual integration.`);

    default:
      throw new Error(`Unknown adapter type: ${type}`);
  }
}
