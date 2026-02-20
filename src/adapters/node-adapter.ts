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

    const result = this.iterator.next();
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

    if (data) {
      // Create database from buffer
      // better-sqlite3 can open from file, so we need to write to temp file first
      // or use the memory option with serialization
      const fs = require('fs');
      const os = require('os');
      const pathModule = require('path');

      // Write to temp file
      const tempPath = pathModule.join(os.tmpdir(), `navio-import-${Date.now()}.db`);
      fs.writeFileSync(tempPath, Buffer.from(data));

      // Open from temp file
      this.db = new this.Database(tempPath);

      // Delete temp file
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Ignore cleanup errors
      }
    } else if (path === ':memory:') {
      this.db = new this.Database(':memory:');
    } else {
      // Open or create file
      this.db = new this.Database(path);
    }

    // Enable WAL mode for better concurrent access
    if (path !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }

    if (this.debug) {
      console.log('[NodeAdapter] Opened database:', path);
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
