/**
 * Navio SDK - TypeScript library for interacting with the Navio blockchain
 */

export * from './client';
export * from './types';
export * from './key-manager';
export * from './key-manager.types';
export * from './wallet-db';
export * from './wallet-db.interface';
export * from './electrum';
export * from './tx-keys-sync';
export * from './crypto';

// Database Adapters (cross-platform SQLite)
export {
  createDatabaseAdapter,
  detectEnvironment,
  isOpfsAvailable,
  isWorkerAvailable,
  type IDatabaseAdapter,
  type IPreparedStatement,
  type QueryResult,
  type RowObject,
  type DatabaseAdapterType,
  type DatabaseAdapterOptions,
} from './database-adapter';

// IndexedDB Adapter (browser, no WASM)
export { IndexedDBWalletDB } from './adapters/indexeddb-wallet-db';

// Sync Provider Architecture
export * from './sync-provider';
export * from './electrum-sync';
export * from './p2p-protocol';
export * from './p2p-sync';

// Re-export BlsctChain from navio-blsct for convenience
export { BlsctChain, getChain, setChain } from 'navio-blsct';
