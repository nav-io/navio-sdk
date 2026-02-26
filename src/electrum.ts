/**
 * Electrum Client - Connect and interact with Electrum servers
 *
 * Supports WebSocket and TCP connections
 * Implements Electrum protocol for fetching transaction keys and blockchain data
 *
 * Based on electrumx server implementation and Navio-specific extensions
 */

import { sha256 } from '@noble/hashes/sha2';
import { ripemd160 } from '@noble/hashes/legacy';
import type { BlockHeaderNotification } from './sync-provider';

// Import WebSocket - use native WebSocket in browser, ws in Node.js
let WebSocketClass: any;
let isBrowserWebSocket = false;
let wsInitError: Error | null = null;

// Allow overriding WebSocket class for testing
let webSocketOverride: any = null;

/**
 * Set a custom WebSocket class for testing purposes.
 * Call with null to restore default behavior.
 * @internal
 */
export function setWebSocketClass(wsClass: any): void {
  webSocketOverride = wsClass;
}

/**
 * Get the current WebSocket class being used
 * @internal
 */
export function getWebSocketClass(): any {
  if (webSocketOverride) {
    return webSocketOverride;
  }
  if (wsInitError) {
    throw wsInitError;
  }
  return WebSocketClass;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (typeof (globalThis as any).window !== 'undefined' && (globalThis as any).window?.WebSocket) {
  // Browser environment - use native WebSocket
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  WebSocketClass = (globalThis as any).window.WebSocket;
  isBrowserWebSocket = true;
} else {
  // Node.js environment - use ws library
  // Handle both CommonJS (require available) and ESM (need createRequire)
  try {
    // Check if require is available (CommonJS)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    if (typeof require === 'function') {
      WebSocketClass = require('ws');
    } else {
      // ESM environment - defer error until ws is actually needed
      // The dynamic import will be handled by ensureWebSocketLoaded()
      wsInitError = new Error('WebSocket not available. In Node.js, install ws: npm install ws');
    }
  } catch {
    wsInitError = new Error('WebSocket not available. In Node.js, install ws: npm install ws');
  }
}

// For ESM environments, load ws dynamically
let wsLoadPromise: Promise<void> | null = null;

/**
 * Ensure WebSocket is loaded (handles async loading for ESM)
 * @internal
 */
export async function ensureWebSocketLoaded(): Promise<void> {
  if (WebSocketClass || webSocketOverride) {
    return;
  }
  if (!wsLoadPromise) {
    wsLoadPromise = (async () => {
      try {
        // Dynamic import for ESM
        const ws = await import('ws');
        WebSocketClass = ws.default || ws;
        wsInitError = null;
      } catch {
        wsInitError = new Error('WebSocket not available. In Node.js, install ws: npm install ws');
        throw wsInitError;
      }
    })();
  }
  return wsLoadPromise;
}

/**
 * Helper to attach WebSocket event handlers that works with both
 * Node.js ws library (.on()) and browser WebSocket (.onX / addEventListener)
 */
function attachWebSocketHandler(
  ws: any,
  event: 'open' | 'message' | 'error' | 'close',
  handler: (data?: any) => void
): void {
  if (isBrowserWebSocket) {
    // Browser WebSocket uses onX properties or addEventListener
    switch (event) {
      case 'open':
        ws.onopen = handler;
        break;
      case 'message':
        // Browser WebSocket passes MessageEvent, extract data
        ws.onmessage = (evt: MessageEvent) => handler(evt.data);
        break;
      case 'error':
        ws.onerror = () => handler(new Error('WebSocket error'));
        break;
      case 'close':
        ws.onclose = handler;
        break;
    }
  } else {
    // Node.js ws library uses .on()
    ws.on(event, handler);
  }
}

/**
 * Electrum server connection options
 */
export interface ElectrumOptions {
  /** Server host (default: localhost) */
  host?: string;
  /** Server port (default: 50001) */
  port?: number;
  /** Use SSL/TLS (default: false) */
  ssl?: boolean;
  /** Connection timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Client name for server.version (default: 'navio-sdk') */
  clientName?: string;
  /** Client version for server.version (default: '1.4') */
  clientVersion?: string;
}

/**
 * Transaction keys structure
 * Represents the keys associated with a transaction
 */
export interface TransactionKeys {
  /** Transaction hash */
  txHash: string;
  /** Transaction keys (structure depends on coin implementation) */
  keys: any;
}

/**
 * Block transaction keys
 * Contains all transaction keys for a block
 */
export interface BlockTransactionKeys {
  /** Block height */
  height: number;
  /** Transaction keys for this block */
  txKeys: TransactionKeys[];
}

/**
 * Range result for block transaction keys
 */
export interface BlockTransactionKeysRange {
  /** Blocks with their transaction keys */
  blocks: BlockTransactionKeys[];
  /** Next height to query (for pagination) */
  nextHeight: number;
}

/**
 * Block header information
 */
export interface BlockHeader {
  /** Block height */
  height: number;
  /** Block hash */
  hash: string;
  /** Previous block hash */
  prevHash: string;
  /** Merkle root */
  merkleRoot: string;
  /** Block timestamp */
  timestamp: number;
  /** Block version */
  version: number;
  /** Difficulty target */
  bits: number;
  /** Nonce */
  nonce: number;
}

/**
 * Electrum RPC error
 */
export class ElectrumError extends Error {
  constructor(
    message: string,
    public code?: number,
    public data?: any
  ) {
    super(message);
    this.name = 'ElectrumError';
  }
}



/**
 * Subscription callback type
 */
export type SubscriptionCallback = (params: any) => void;

/**
 * Electrum Client - Connects to Electrum servers.
 * 
 * Low-level client for the Electrum protocol. For most use cases,
 * use NavioClient with the 'electrum' backend instead.
 * 
 * @category Protocol
 */
export class ElectrumClient {
  private ws: any = null;
  private requestId = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }
  >();
  private connected = false;
  private options: Required<ElectrumOptions>;
  private reconnectAttempts = 0;

  /**
   * Cached chain tip from blockchain.headers.subscribe.
   * Updated via subscription notifications so we don't re-subscribe on every call.
   */
  private cachedChainTip: { height: number; hex: string } | null = null;
  private chainTipSubscribed = false;

  /**
   * Subscription callbacks map
   * Key: subscription method name (e.g., 'blockchain.headers.subscribe')
   * Value: Set of callbacks to invoke when notification is received
   */
  private subscriptionCallbacks = new Map<string, Set<SubscriptionCallback>>();

  constructor(options: ElectrumOptions = {}) {
    this.options = {
      host: options.host || 'localhost',
      port: options.port || 50001,
      ssl: options.ssl || false,
      timeout: options.timeout || 30000,
      clientName: options.clientName || 'navio-sdk',
      clientVersion: options.clientVersion || '1.4',
    };
  }

  /**
   * Connect to the Electrum server
   */
  async connect(): Promise<void> {
    if (this.connected && this.ws) {
      return;
    }

    // Ensure WebSocket is loaded (handles async loading for ESM)
    await ensureWebSocketLoaded();

    return new Promise((resolve, reject) => {
      const protocol = this.options.ssl ? 'wss' : 'ws';
      const url = `${protocol}://${this.options.host}:${this.options.port}`;

      try {
        const WsClass = getWebSocketClass();
        this.ws = new WsClass(url);

        attachWebSocketHandler(this.ws, 'open', async () => {
          this.connected = true;
          this.reconnectAttempts = 0;

          // Send server.version as required by Electrum protocol
          try {
            await this.call('server.version', this.options.clientName, this.options.clientVersion);
            resolve();
          } catch (error) {
            reject(error);
          }
        });

        attachWebSocketHandler(this.ws, 'message', (data: Buffer | string) => {
          try {
            // Handle both Buffer (Node.js) and string (browser) data
            const dataStr = typeof data === 'string' ? data : data.toString();
            const response = JSON.parse(dataStr);
            this.handleResponse(response);
          } catch (error) {
            console.error('Error parsing response:', error);
          }
        });

        attachWebSocketHandler(this.ws, 'error', (error: Error) => {
          this.connected = false;
          if (this.reconnectAttempts === 0) {
            reject(error);
          }
        });

        attachWebSocketHandler(this.ws, 'close', () => {
          this.connected = false;
          this.chainTipSubscribed = false;
          this.cachedChainTip = null;
          this.ws = null;
          for (const [, { reject, timeout }] of Array.from(this.pendingRequests)) {
            clearTimeout(timeout);
            reject(new Error('Connection closed'));
          }
          this.pendingRequests.clear();
          // Clear subscription callbacks on disconnect
          this.subscriptionCallbacks.clear();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Handle incoming response from server
   */
  private handleResponse(response: any): void {
    // Handle subscription notifications (has method, no id or id is null)
    // Electrum sends notifications like: {"method": "blockchain.headers.subscribe", "params": [...]}
    if (response.method && response.params !== undefined && response.id === undefined) {
      this.handleNotification(response.method, response.params);
      return;
    }

    // Handle request/response messages
    if (response.id !== undefined && this.pendingRequests.has(response.id)) {
      const { resolve, reject, timeout } = this.pendingRequests.get(response.id)!;
      clearTimeout(timeout);
      this.pendingRequests.delete(response.id);

      if (response.error) {
        const error = new ElectrumError(
          response.error.message || JSON.stringify(response.error),
          response.error.code,
          response.error.data
        );
        reject(error);
      } else {
        resolve(response.result);
      }
    }
  }

  /**
   * Handle subscription notification from server
   * @param method - Subscription method name
   * @param params - Notification parameters
   */
  private handleNotification(method: string, params: any): void {
    const callbacks = this.subscriptionCallbacks.get(method);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          callback(params);
        } catch (error) {
          console.error(`Error in subscription callback for ${method}:`, error);
        }
      }
    }
  }

  /**
   * Make an RPC call to the Electrum server
   * @param method - RPC method name
   * @param params - Method parameters
   * @returns Promise resolving to the result
   */
  async call(method: string, ...params: any[]): Promise<any> {
    if (!this.connected || !this.ws) {
      try {
        await this.connect();
      } catch (reconnectError) {
        throw new Error(
          `Not connected to Electrum server and reconnection failed: ${(reconnectError as Error).message}`
        );
      }
    }

    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const request = {
        id,
        method,
        params,
      };

      // Set timeout for request
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout for method: ${method}`));
        }
      }, this.options.timeout);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      try {
        this.ws!.send(JSON.stringify(request));
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the server
   */
  disconnect(): void {
    this.subscriptionCallbacks.clear();
    this.cachedChainTip = null;
    this.chainTipSubscribed = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  /**
   * Check if connected to server
   */
  isConnected(): boolean {
    return this.connected;
  }

  // ============================================================================
  // Blockchain Methods
  // ============================================================================

  /**
   * Get server version
   * @returns Server version information
   */
  async getServerVersion(): Promise<[string, string]> {
    return this.call('server.version', this.options.clientName, this.options.clientVersion);
  }

  /**
   * Get block header for a given height
   * @param height - Block height
   * @returns Block header
   */
  async getBlockHeader(height: number): Promise<string> {
    return this.call('blockchain.block.header', height);
  }

  /**
   * Get block headers for a range of heights
   * @param startHeight - Starting block height
   * @param count - Number of headers to fetch
   * @returns Block headers
   */
  async getBlockHeaders(
    startHeight: number,
    count: number
  ): Promise<{ count: number; hex: string; max: number }> {
    return this.call('blockchain.block.headers', startHeight, count);
  }

  /**
   * Subscribe to block headers
   * Registers a callback that will be invoked for each new block.
   * The callback receives block header notifications with height and hex.
   * 
   * @param callback - Callback function for new headers
   * @returns The initial header (current chain tip)
   */
  async subscribeBlockHeaders(callback: (header: BlockHeaderNotification) => void): Promise<BlockHeaderNotification> {
    const method = 'blockchain.headers.subscribe';

    // Ensure we have an active subscription (sends RPC only once)
    await this.ensureChainTipSubscription();

    // Register the caller's callback for ongoing notifications
    if (!this.subscriptionCallbacks.has(method)) {
      this.subscriptionCallbacks.set(method, new Set());
    }
    this.subscriptionCallbacks.get(method)!.add(callback);

    return { height: this.cachedChainTip!.height, hex: this.cachedChainTip!.hex };
  }

  /**
   * Unsubscribe from block headers
   * Removes a previously registered callback.
   * 
   * @param callback - The callback to remove (must be the same reference)
   * @returns True if callback was found and removed
   */
  unsubscribeBlockHeaders(callback: (header: BlockHeaderNotification) => void): boolean {
    const method = 'blockchain.headers.subscribe';
    const callbacks = this.subscriptionCallbacks.get(method);
    if (callbacks) {
      return callbacks.delete(callback);
    }
    return false;
  }

  /**
   * Remove all block header subscription callbacks
   */
  unsubscribeAllBlockHeaders(): void {
    const method = 'blockchain.headers.subscribe';
    this.subscriptionCallbacks.delete(method);
  }

  /**
   * Check if there are active block header subscriptions
   */
  hasBlockHeaderSubscriptions(): boolean {
    const method = 'blockchain.headers.subscribe';
    const callbacks = this.subscriptionCallbacks.get(method);
    return callbacks !== undefined && callbacks.size > 0;
  }

  /**
   * Get chain tip height
   * @returns Current chain tip height
   */
  async getChainTipHeight(): Promise<number> {
    if (!this.chainTipSubscribed) {
      await this.ensureChainTipSubscription();
    }
    return this.cachedChainTip!.height;
  }

  /**
   * Subscribe to chain tip once and cache the result.
   * Subsequent calls to getChainTipHeight() return the cached value,
   * which is kept up-to-date via subscription notifications.
   */
  private async ensureChainTipSubscription(): Promise<void> {
    if (this.chainTipSubscribed) return;

    const method = 'blockchain.headers.subscribe';
    const response = await this.call(method);

    if (typeof response === 'number') {
      this.cachedChainTip = { height: response, hex: '' };
    } else if (response && typeof response.height === 'number') {
      this.cachedChainTip = { height: response.height, hex: response.hex || '' };
    } else {
      throw new Error(`Unexpected blockchain.headers.subscribe response: ${JSON.stringify(response)}`);
    }

    // Register an internal callback to keep the cache updated
    if (!this.subscriptionCallbacks.has(method)) {
      this.subscriptionCallbacks.set(method, new Set());
    }
    this.subscriptionCallbacks.get(method)!.add((params: any) => {
      const header = Array.isArray(params) ? params[0] : params;
      if (header && typeof header.height === 'number') {
        this.cachedChainTip = { height: header.height, hex: header.hex || '' };
      }
    });

    this.chainTipSubscribed = true;
  }

  // ============================================================================
  // Transaction Key Methods (Navio-specific)
  // ============================================================================

  /**
   * Get transaction keys for a specific transaction
   * @param txHash - Transaction hash (hex string)
   * @returns Transaction keys
   */
  async getTransactionKeys(txHash: string): Promise<any> {
    return this.call('blockchain.transaction.get_keys', txHash);
  }

  /**
   * Get all transaction keys for a block
   * @param height - Block height
   * @returns Array of transaction keys for the block
   */
  async getBlockTransactionKeys(height: number): Promise<any[]> {
    return this.call('blockchain.block.get_txs_keys', height);
  }

  /**
   * Get transaction keys for a range of blocks (paginated)
   * @param startHeight - Starting block height
   * @returns Range result with blocks and next height
   */
  async getBlockTransactionKeysRange(startHeight: number): Promise<BlockTransactionKeysRange> {
    const result = await this.call('blockchain.block.get_range_txs_keys', startHeight);

    // Transform result to our format
    // result.blocks is an array where each element is an array of transaction keys for that block
    const blocks: BlockTransactionKeys[] = [];

    if (result.blocks && Array.isArray(result.blocks)) {
      for (let i = 0; i < result.blocks.length; i++) {
        const blockData = result.blocks[i];
        const blockHeight = startHeight + i;

        // blockData is an array of transaction keys for this block
        // Each element may be just the keys object, or an object with txHash and keys
        const txKeys: TransactionKeys[] = [];

        if (Array.isArray(blockData)) {
          for (const txKeyData of blockData) {
            if (Array.isArray(txKeyData) && txKeyData.length >= 2) {
              // Server format: [txHash, {vin: [], vout: [...]}]
              txKeys.push({
                txHash: txKeyData[0] || '',
                keys: txKeyData,
              });
            } else if (typeof txKeyData === 'object' && txKeyData !== null) {
              // Check if it's already in our format
              if ('txHash' in txKeyData && 'keys' in txKeyData) {
                txKeys.push({
                  txHash: txKeyData.txHash || '',
                  keys: txKeyData.keys,
                });
              } else {
                // It's just the keys object, try to extract hash
                const txHash = (txKeyData as any).txHash || (txKeyData as any).hash || '';
                txKeys.push({
                  txHash,
                  keys: txKeyData,
                });
              }
            }
          }
        }

        blocks.push({
          height: blockHeight,
          txKeys,
        });
      }
    }

    return {
      blocks,
      nextHeight: result.next_height || startHeight + blocks.length,
    };
  }

  /**
   * Fetch all transaction keys from genesis to chain tip
   * @param progressCallback - Optional callback for progress updates
   * @returns Array of all block transaction keys
   */
  async fetchAllTransactionKeys(
    progressCallback?: (height: number, totalHeight: number, blocksProcessed: number) => void
  ): Promise<BlockTransactionKeys[]> {
    const tipHeight = await this.getChainTipHeight();
    const allBlocks: BlockTransactionKeys[] = [];
    let currentHeight = 0;
    let totalBlocksProcessed = 0;

    while (currentHeight <= tipHeight) {
      const rangeResult = await this.getBlockTransactionKeysRange(currentHeight);

      allBlocks.push(...rangeResult.blocks);
      totalBlocksProcessed += rangeResult.blocks.length;

      if (progressCallback) {
        progressCallback(currentHeight, tipHeight, totalBlocksProcessed);
      }

      currentHeight = rangeResult.nextHeight;

      // Safety check to prevent infinite loops
      if (currentHeight <= rangeResult.blocks[rangeResult.blocks.length - 1]?.height) {
        throw new Error('Server did not advance next_height properly');
      }
    }

    return allBlocks;
  }

  /**
   * Get serialized transaction output by output hash (Navio-specific)
   * @param outputHash - Output hash (hex string)
   * @returns Serialized output (hex string)
   */
  async getTransactionOutput(outputHash: string): Promise<string> {
    return this.call('blockchain.transaction.get_output', outputHash);
  }

  // ============================================================================
  // Transaction Methods
  // ============================================================================

  /**
   * Get raw transaction
   * @param txHash - Transaction hash (hex string)
   * @param verbose - Return verbose transaction data
   * @param blockHash - Optional block hash for context
   * @returns Raw transaction or verbose transaction data
   */
  async getRawTransaction(
    txHash: string,
    verbose = false,
    blockHash?: string
  ): Promise<string | any> {
    return this.call('blockchain.transaction.get', txHash, verbose, blockHash);
  }

  /**
   * Broadcast a transaction
   * @param rawTx - Raw transaction (hex string)
   * @returns Transaction hash if successful
   */
  async broadcastTransaction(rawTx: string): Promise<string> {
    return this.call('blockchain.transaction.broadcast', rawTx);
  }

  // ============================================================================
  // Address/Script Hash Methods
  // ============================================================================

  /**
   * Get transaction history for a script hash
   * @param scriptHash - Script hash (hex string, reversed)
   * @returns Transaction history
   */
  async getHistory(scriptHash: string): Promise<any[]> {
    return this.call('blockchain.scripthash.get_history', scriptHash);
  }

  /**
   * Get unspent transaction outputs for a script hash
   * @param scriptHash - Script hash (hex string, reversed)
   * @returns Unspent outputs
   */
  async getUnspent(scriptHash: string): Promise<any[]> {
    return this.call('blockchain.scripthash.listunspent', scriptHash);
  }

  /**
   * Subscribe to script hash updates
   * @param scriptHash - Script hash (hex string, reversed)
   * @param callback - Callback for status updates
   */
  async subscribeScriptHash(scriptHash: string, callback: (status: string) => void): Promise<void> {
    const status = await this.call('blockchain.scripthash.subscribe', scriptHash);
    callback(status);
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Calculate script hash from address (for Electrum protocol)
   * @param address - Address string
   * @returns Script hash (hex string, reversed for Electrum)
   */
  static calculateScriptHash(address: string): string {
    // This is a placeholder - actual implementation depends on address format
    // For Navio, this would need to handle BLS CT addresses
    const hash = ripemd160(sha256(Buffer.from(address, 'utf-8')));
    // Reverse for Electrum protocol
    return Buffer.from(hash).reverse().toString('hex');
  }

  /**
   * Reverse a hex string (for Electrum protocol hash format)
   * @param hex - Hex string
   * @returns Reversed hex string
   */
  static reverseHex(hex: string): string {
    const bytes = Buffer.from(hex, 'hex');
    return Buffer.from(bytes.reverse()).toString('hex');
  }
}
