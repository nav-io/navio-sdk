/**
 * Electrum Sync Provider
 *
 * Implements the SyncProvider interface using an Electrum server connection.
 * This is a wrapper around ElectrumClient that provides the standardized sync interface.
 */

import { BaseSyncProvider, BlockHeadersResult, ChainTip, SyncProviderOptions } from './sync-provider';
import { ElectrumClient, ElectrumOptions, BlockTransactionKeys, TransactionKeys } from './electrum';

/**
 * Electrum sync provider options
 */
export interface ElectrumSyncOptions extends SyncProviderOptions, ElectrumOptions {}

/**
 * Electrum Sync Provider
 *
 * Uses an Electrum server for blockchain synchronization.
 * Provides efficient transaction key fetching through Electrum's preprocessed data.
 * 
 * @category Sync
 */
export class ElectrumSyncProvider extends BaseSyncProvider {
  readonly type = 'electrum' as const;

  private client: ElectrumClient;
  private chainTipHeight: number = -1;
  private chainTipHash: string = '';

  constructor(options: ElectrumSyncOptions = {}) {
    super(options);
    this.client = new ElectrumClient(options);
  }

  /**
   * Get the underlying ElectrumClient for direct access to additional methods
   */
  getClient(): ElectrumClient {
    return this.client;
  }

  /**
   * Connect to the Electrum server
   */
  async connect(): Promise<void> {
    await this.client.connect();
    this.log('Connected to Electrum server');

    // Cache initial chain tip
    this.chainTipHeight = await this.client.getChainTipHeight();
    const header = await this.client.getBlockHeader(this.chainTipHeight);
    this.chainTipHash = this.extractBlockHash(header);
  }

  /**
   * Disconnect from the Electrum server
   */
  disconnect(): void {
    this.client.disconnect();
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.client.isConnected();
  }

  /**
   * Get current chain tip height
   */
  async getChainTipHeight(): Promise<number> {
    this.chainTipHeight = await this.client.getChainTipHeight();
    return this.chainTipHeight;
  }

  /**
   * Get current chain tip
   */
  async getChainTip(): Promise<ChainTip> {
    const height = await this.getChainTipHeight();
    const header = await this.client.getBlockHeader(height);
    this.chainTipHash = this.extractBlockHash(header);

    return {
      height,
      hash: this.chainTipHash,
    };
  }

  /**
   * Get a single block header
   */
  async getBlockHeader(height: number): Promise<string> {
    return this.client.getBlockHeader(height);
  }

  /**
   * Get multiple block headers
   */
  async getBlockHeaders(startHeight: number, count: number): Promise<BlockHeadersResult> {
    return this.client.getBlockHeaders(startHeight, count);
  }

  /**
   * Get transaction keys for a range of blocks
   */
  async getBlockTransactionKeysRange(startHeight: number): Promise<{
    blocks: BlockTransactionKeys[];
    nextHeight: number;
  }> {
    return this.client.getBlockTransactionKeysRange(startHeight);
  }

  /**
   * Get transaction keys for a single block
   */
  async getBlockTransactionKeys(height: number): Promise<TransactionKeys[]> {
    const result = await this.client.getBlockTransactionKeys(height);

    // Transform to TransactionKeys format
    if (Array.isArray(result)) {
      return result.map((txKeyData: any, index: number) => {
        if (typeof txKeyData === 'object' && txKeyData !== null) {
          if ('txHash' in txKeyData && 'keys' in txKeyData) {
            return txKeyData as TransactionKeys;
          } else {
            return {
              txHash: txKeyData.txHash || txKeyData.hash || `tx_${index}`,
              keys: txKeyData,
            };
          }
        }
        return {
          txHash: `tx_${index}`,
          keys: txKeyData,
        };
      });
    }

    return [];
  }

  /**
   * Get serialized transaction output by output hash
   */
  async getTransactionOutput(outputHash: string): Promise<string> {
    return this.client.getTransactionOutput(outputHash);
  }

  /**
   * Broadcast a transaction
   */
  async broadcastTransaction(rawTx: string): Promise<string> {
    return this.client.broadcastTransaction(rawTx);
  }

  /**
   * Get raw transaction
   */
  async getRawTransaction(txHash: string, verbose?: boolean): Promise<string | unknown> {
    return this.client.getRawTransaction(txHash, verbose);
  }

  // ============================================================================
  // Additional Electrum-specific Methods (passthrough)
  // ============================================================================

  /**
   * Get server version
   */
  async getServerVersion(): Promise<[string, string]> {
    return this.client.getServerVersion();
  }

  /**
   * Subscribe to block headers
   */
  async subscribeBlockHeaders(callback: (header: any) => void): Promise<void> {
    return this.client.subscribeBlockHeaders(callback);
  }

  /**
   * Get transaction keys for a specific transaction
   */
  async getTransactionKeys(txHash: string): Promise<any> {
    return this.client.getTransactionKeys(txHash);
  }

  /**
   * Fetch all transaction keys from genesis to chain tip
   */
  async fetchAllTransactionKeys(
    progressCallback?: (height: number, totalHeight: number, blocksProcessed: number) => void
  ): Promise<BlockTransactionKeys[]> {
    return this.client.fetchAllTransactionKeys(progressCallback);
  }

  /**
   * Get transaction history for a script hash
   */
  async getHistory(scriptHash: string): Promise<any[]> {
    return this.client.getHistory(scriptHash);
  }

  /**
   * Get unspent transaction outputs for a script hash
   */
  async getUnspent(scriptHash: string): Promise<any[]> {
    return this.client.getUnspent(scriptHash);
  }

  /**
   * Subscribe to script hash updates
   */
  async subscribeScriptHash(scriptHash: string, callback: (status: string) => void): Promise<void> {
    return this.client.subscribeScriptHash(scriptHash, callback);
  }
}

