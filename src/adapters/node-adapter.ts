/**
 * Node.js Database Adapter
 *
 * Uses better-sqlite3 for high-performance native SQLite.
 * This is the recommended adapter for Node.js applications.
 *
 * @module adapters/node-adapter
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type {
  IDatabaseAdapter,
  IPreparedStatement,
  QueryResult,
  RowObject,
  DatabaseAdapterOptions,
} from '../database-adapter';

/** Paths that name an in-memory (or SQLite temporary) database, not a file. */
function isMemoryPath(path: string): boolean {
  return path === ':memory:' || path === '';
}

/**
 * A copy of a serialized database that SQLite can open in memory.
 *
 * A database serialized from a WAL-mode file keeps WAL in its header (bytes
 * 18 and 19 = 2), and an in-memory database cannot open such an image
 * (SQLITE_CANTOPEN). Mark the copy as rollback-journal (1) instead; the page
 * content is unaffected.
 */
function toInMemoryImage(data: Uint8Array): Buffer {
  const image = Buffer.from(data);
  if (image.length >= 20 && image[18] === 2 && image[19] === 2) {
    image[18] = 1;
    image[19] = 1;
  }
  return image;
}

/**
 * Write imported database bytes to a new file, readable by the owner only.
 *
 * Refuses to replace an existing database (or a leftover -wal / -shm file,
 * which SQLite would replay over the import).
 */
function writeNewDatabaseFile(path: string, data: Uint8Array): void {
  const fs = require('fs');
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (fs.existsSync(candidate)) {
      throw new Error(`Refusing to import over existing file: ${candidate}`);
    }
  }
  // 'wx' fails if the file appeared since the check; the mode applies to the
  // new file (before umask, which can only narrow it), chmod makes it exact.
  fs.writeFileSync(path, Buffer.from(data), { mode: 0o600, flag: 'wx' });
  fs.chmodSync(path, 0o600);
}

/**
 * Prepared statement wrapper for better-sqlite3
 */
class NodePreparedStatement implements IPreparedStatement {
  private stmt: any;
  private boundParams: any[] | null = null;
  private iterator: Iterator<any> | null = null;
  private currentRow: any = null;
  private columns: string[] | null = null;

  constructor(stmt: any) {
    this.stmt = stmt;
  }

  bind(params?: any[]): IPreparedStatement {
    this.boundParams = params || null;
    // Reset iterator
    this.iterator = null;
    this.currentRow = null;
    return this;
  }

  async step(): Promise<boolean> {
    // Initialize iterator on first step
    if (!this.iterator) {
      const iterable = this.boundParams ? this.stmt.iterate(...this.boundParams) : this.stmt.iterate();
      this.iterator = iterable[Symbol.iterator]();
    }

    const result = this.iterator!.next();
    if (result.done) {
      this.currentRow = null;
      return false;
    }

    this.currentRow = result.value;

    // Cache column names from first row
    if (!this.columns && this.currentRow) {
      this.columns = Object.keys(this.currentRow);
    }

    return true;
  }

  async getAsObject(): Promise<RowObject> {
    if (!this.currentRow) {
      return {};
    }
    return this.currentRow;
  }

  async get(): Promise<any[]> {
    if (!this.currentRow) {
      return [];
    }
    return Object.values(this.currentRow);
  }

  async run(params?: any[]): Promise<void> {
    const p = params || this.boundParams || [];
    this.stmt.run(...p);
  }

  async free(): Promise<void> {
    // Close the active iterator to release the database connection.
    // better-sqlite3 keeps the connection "busy" while an iterator is open.
    if (this.iterator) {
      if (typeof this.iterator.return === 'function') {
        this.iterator.return(undefined);
      }
      this.iterator = null;
    }
    this.currentRow = null;
  }
}

/**
 * Node.js database adapter using better-sqlite3
 */
export class NodeAdapter implements IDatabaseAdapter {
  private db: any = null;
  private path: string = '';
  private debug: boolean;
  private Database: any = null;

  constructor(options: DatabaseAdapterOptions = {}) {
    this.debug = options.debug ?? false;
  }

  async open(path: string, data?: Uint8Array): Promise<void> {
    // Dynamic import of better-sqlite3 (CommonJS module)
    try {
      this.Database = require('better-sqlite3');
    } catch (error) {
      throw new Error(
        `Failed to load better-sqlite3: ${error}. Install with: npm install better-sqlite3`
      );
    }

    this.path = path;
    const fs = require('fs');
    const createsFile = !isMemoryPath(path) && !data && !fs.existsSync(path);

    if (data && isMemoryPath(path)) {
      // Deserialize straight into memory. The bytes may be a decrypted
      // wallet, so they never touch the disk.
      this.db = new this.Database(toInMemoryImage(data));
    } else if (data) {
      // Import into the file at `path`, so later writes persist there. If
      // the bytes do not open, remove what the import created (none of it
      // existed before), so a retry is not refused as an existing file.
      writeNewDatabaseFile(path, data);
      try {
        this.db = new this.Database(path);
        this.db.pragma('journal_mode = WAL');
      } catch (error) {
        this.discardImportedFile(path);
        throw error;
      }
    } else if (path === ':memory:') {
      this.db = new this.Database(':memory:');
    } else {
      // Open or create file
      this.db = new this.Database(path);
    }

    // Enable WAL mode for better concurrent access
    if (!isMemoryPath(path) && !data) {
      this.db.pragma('journal_mode = WAL');
    }

    if (createsFile) {
      // A new wallet file holds keys: owner only. SQLite gives -wal / -shm
      // files it creates later the same permissions as the database.
      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
      }
    }

    if (this.debug) {
      console.log('[NodeAdapter] Opened database:', path);
    }
  }

  /** Close and delete a database file this adapter just imported, with its -wal / -shm files. */
  private discardImportedFile(path: string): void {
    const fs = require('fs');
    try {
      this.db?.close();
    } catch {
      // Already unusable; the files go either way.
    }
    this.db = null;
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      fs.rmSync(file, { force: true });
    }
  }

  async exec(sql: string): Promise<QueryResult[]> {
    if (!this.db) throw new Error('Database not open');

    // Split multiple statements
    const statements = sql.split(';').filter((s) => s.trim().length > 0);
    const results: QueryResult[] = [];

    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;

      // Check if it's a SELECT-like statement
      const isQuery = /^\s*(SELECT|PRAGMA|EXPLAIN)/i.test(trimmed);

      if (isQuery) {
        try {
          const prepared = this.db.prepare(trimmed);
          const rows = prepared.all();

          if (rows.length > 0) {
            const columns = Object.keys(rows[0]);
            const values = rows.map((row: any) => Object.values(row));
            results.push({ columns, values });
          }
        } catch (error) {
          // Statement might not return results
          this.db.exec(trimmed);
        }
      } else {
        this.db.exec(trimmed);
      }
    }

    return results;
  }

  async run(sql: string, params?: any[]): Promise<void> {
    if (!this.db) throw new Error('Database not open');

    if (params && params.length > 0) {
      const stmt = this.db.prepare(sql);
      stmt.run(...params);
    } else {
      this.db.exec(sql);
    }
  }

  async prepare(sql: string): Promise<IPreparedStatement> {
    if (!this.db) throw new Error('Database not open');
    return new NodePreparedStatement(this.db.prepare(sql));
  }

  async export(): Promise<Uint8Array> {
    if (!this.db) throw new Error('Database not open');

    // Serialize the database
    const buffer = this.db.serialize();
    return new Uint8Array(buffer);
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  isOpen(): boolean {
    return this.db !== null;
  }

  getPath(): string {
    return this.path;
  }

  async save(): Promise<void> {
    // better-sqlite3 is synchronous and auto-persists
    // Nothing to do
  }
}
