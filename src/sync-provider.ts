/**
 * Sync Provider Interface
 *
 * Abstract interface for blockchain synchronization providers.
 * Supports multiple backends: Electrum, P2P, or custom implementations.
 */

import type { BlockTransactionKeys, TransactionKeys } from './electrum';
import { sha256 } from '@noble/hashes/sha256';

/**
 * Block header information (for sync provider)
 */
export interface SyncBlockHeader {
  /** Block height */
  height: number;
  /** Block hash (hex string, little-endian display format) */
  hash: string;
  /** Previous block hash */
  prevHash: string;
  /** Merkle root */
  merkleRoot: string;
  /** Block timestamp */
  timestamp: number;
  /** Block version */
  version: number;
  /** Difficulty target (bits) */
  bits: number;
  /** Nonce */
  nonce: number;
  /** Raw header hex (80 bytes) */
  rawHex?: string;
}

/**
 * Block headers result (for batch fetches)
 */
export interface BlockHeadersResult {
  /** Number of headers returned */
  count: number;
  /** Concatenated headers hex */
  hex: string;
  /** Maximum headers the server can return */
  max?: number;
}

/**
 * Chain tip information
 */
export interface ChainTip {
  /** Current chain height */
  height: number;
  /** Block hash at tip */
  hash: string;
}

/**
 * Block header notification from subscription
 */
export interface BlockHeaderNotification {
  /** Block height */
  height: number;
  /** Block header hex (80 bytes) */
  hex: string;
}

/**
 * Block header subscription callback
 */
export type BlockHeaderCallback = (header: BlockHeaderNotification) => void;

/**
 * Sync provider options
 */
export interface SyncProviderOptions {
  /** Connection timeout in milliseconds */
  timeout?: number;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Abstract sync provider interface
 *
 * Implementations must provide methods for:
 * - Connecting/disconnecting
 * - Fetching block headers
 * - Fetching transaction keys for wallet scanning
 * - Fetching transaction outputs by hash
 * - Broadcasting transactions
 * 
 * @category Sync
 */
export interface SyncProvider {
  /**
   * Provider type identifier
   */
  readonly type: 'electrum' | 'p2p' | 'custom';

  /**
   * Connect to the provider
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the provider
   */
  disconnect(): void;

  /**
   * Check if connected
   */
  isConnected(): boolean;

  /**
   * Get the current chain tip height
   */
  getChainTipHeight(): Promise<number>;

  /**
   * Get the current chain tip
   */
  getChainTip(): Promise<ChainTip>;

  /**
   * Get a single block header
   * @param height - Block height
   * @returns Block header hex (80 bytes)
   */
  getBlockHeader(height: number): Promise<string>;

  /**
   * Get multiple block headers
   * @param startHeight - Starting block height
   * @param count - Number of headers to fetch
   * @returns Block headers result
   */
  getBlockHeaders(startHeight: number, count: number): Promise<BlockHeadersResult>;

  /**
   * Get transaction keys for a range of blocks
   * Used for wallet scanning - extracts keys needed for output detection
   * @param startHeight - Starting block height
   * @returns Block transaction keys with next height for pagination
   */
  getBlockTransactionKeysRange(startHeight: number): Promise<{
    blocks: BlockTransactionKeys[];
    nextHeight: number;
  }>;

  /**
   * Get transaction keys for a single block
   * @param height - Block height
   * @returns Array of transaction keys
   */
  getBlockTransactionKeys(height: number): Promise<TransactionKeys[]>;

  /**
   * Get serialized transaction output by output hash
   * @param outputHash - Output hash (hex string)
   * @returns Serialized output (hex string)
   */
  getTransactionOutput(outputHash: string): Promise<string>;

  /**
   * Broadcast a transaction
   * @param rawTx - Raw transaction (hex string)
   * @returns Transaction hash if successful
   */
  broadcastTransaction(rawTx: string): Promise<string>;

  /**
   * Get raw transaction
   * @param txHash - Transaction hash (hex string)
   * @param verbose - Return verbose data
   * @returns Raw transaction hex or verbose object
   */
  getRawTransaction(txHash: string, verbose?: boolean): Promise<string | unknown>;

  // ============================================================================
  // Optional Subscription Methods (not all providers support these)
  // ============================================================================

  /**
   * Subscribe to new block headers (optional)
   * Not all providers support real-time subscriptions.
   * 
   * @param callback - Callback invoked for each new block
   * @returns The initial/current block header
   */
  subscribeBlockHeaders?(callback: BlockHeaderCallback): Promise<BlockHeaderNotification>;

  /**
   * Unsubscribe a specific block header callback (optional)
   * 
   * @param callback - The callback to remove (same reference as subscribeBlockHeaders)
   * @returns True if callback was found and removed
   */
  unsubscribeBlockHeaders?(callback: BlockHeaderCallback): boolean;

  /**
   * Unsubscribe all block header callbacks (optional)
   */
  unsubscribeAllBlockHeaders?(): void;

  /**
   * Check if there are active block header subscriptions (optional)
   */
  hasBlockHeaderSubscriptions?(): boolean;
}

/**
 * Base class for sync providers with common utility methods.
 * 
 * @category Sync
 */
export abstract class BaseSyncProvider implements SyncProvider {
  abstract readonly type: 'electrum' | 'p2p' | 'custom';
  protected debug: boolean;
  protected timeout: number;

  constructor(options: SyncProviderOptions = {}) {
    this.debug = options.debug ?? false;
    this.timeout = options.timeout ?? 30000;
  }

  protected log(...args: unknown[]): void {
    if (this.debug) {
      console.log(`[${this.type}]`, ...args);
    }
  }

  /**
   * Extract block hash from raw block header (80 bytes hex)
   * Block hash is double SHA256 of header, reversed for display
   */
  protected extractBlockHash(headerHex: string): string {
    const headerBytes = Buffer.from(headerHex, 'hex');
    const hash = sha256(sha256(headerBytes));
    return Buffer.from(hash).reverse().toString('hex');
  }

  /**
   * Parse a raw block header into structured format
   */
  protected parseBlockHeader(headerHex: string, height: number): SyncBlockHeader {
    const header = Buffer.from(headerHex, 'hex');
    if (header.length !== 80) {
      throw new Error(`Invalid header length: ${header.length}, expected 80`);
    }

    return {
      height,
      hash: this.extractBlockHash(headerHex),
      version: header.readInt32LE(0),
      prevHash: header.subarray(4, 36).reverse().toString('hex'),
      merkleRoot: header.subarray(36, 68).reverse().toString('hex'),
      timestamp: header.readUInt32LE(68),
      bits: header.readUInt32LE(72),
      nonce: header.readUInt32LE(76),
      rawHex: headerHex,
    };
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): void;
  abstract isConnected(): boolean;
  abstract getChainTipHeight(): Promise<number>;
  abstract getChainTip(): Promise<ChainTip>;
  abstract getBlockHeader(height: number): Promise<string>;
  abstract getBlockHeaders(startHeight: number, count: number): Promise<BlockHeadersResult>;
  abstract getBlockTransactionKeysRange(startHeight: number): Promise<{
    blocks: BlockTransactionKeys[];
    nextHeight: number;
  }>;
  abstract getBlockTransactionKeys(height: number): Promise<TransactionKeys[]>;
  abstract getTransactionOutput(outputHash: string): Promise<string>;
  abstract broadcastTransaction(rawTx: string): Promise<string>;
  abstract getRawTransaction(txHash: string, verbose?: boolean): Promise<string | unknown>;
}

