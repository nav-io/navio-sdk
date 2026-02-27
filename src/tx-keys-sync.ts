/**
 * Transaction Keys Sync Module
 *
 * Synchronizes transaction keys from a sync provider to wallet database
 * - Supports multiple backends: Electrum, P2P, or custom providers
 * - Tracks sync progress and resumes from last state
 * - Handles block reorganizations
 * - Persists sync state in wallet database
 */

import { SyncProvider } from './sync-provider';
import { ElectrumClient } from './electrum';
import { KeyManager } from './key-manager';
import type { BlockTransactionKeys, TransactionKeys } from './electrum';
import type { IWalletDB, SyncState } from './wallet-db.interface';
import * as blsctModule from 'navio-blsct';
import { sha256 } from '@noble/hashes/sha256';

/**
 * Yield control back to the browser's event loop so it can repaint and
 * handle user input.  Uses setTimeout(0) which schedules a macrotask,
 * guaranteeing that pending paint / input tasks run before we resume.
 * In Node.js environments this is a near-instant no-op.
 */
const yieldToMainThread = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/**
 * How often (in blocks) the sync loop yields to the main thread.
 * Tuned so each uninterrupted run is short enough (~5-15 ms) to keep
 * the UI responsive while not adding excessive overhead.
 */
const YIELD_EVERY_N_BLOCKS = 50;

export type { SyncState } from './wallet-db.interface';

/**
 * Sync progress callback
 */
export type SyncProgressCallback = (
  currentHeight: number,
  chainTip: number,
  blocksProcessed: number,
  txKeysProcessed: number,
  isReorg: boolean
) => void;

/**
 * Sync options
 */
export interface SyncOptions {
  /** Start height (default: last synced height + 1) */
  startHeight?: number;
  /** End height (default: chain tip) */
  endHeight?: number;
  /** Progress callback */
  onProgress?: SyncProgressCallback;
  /** Stop on reorganization (default: true) */
  stopOnReorg?: boolean;
  /** Verify block hashes (default: true) */
  verifyHashes?: boolean;
  /** Save database after N blocks (default: 100) - 0 to save only at end */
  saveInterval?: number;
  /** Keep transaction keys in database after processing (default: false) */
  keepTxKeys?: boolean;
  /** Keep block hashes for last N blocks only (default: 10000) - 0 to keep all */
  blockHashRetention?: number;
}

/**
 * Background sync options for continuous synchronization
 */
export interface BackgroundSyncOptions extends SyncOptions {
  /** 
   * Polling interval in milliseconds 
   * @default 10000 (10 seconds)
   */
  pollInterval?: number;

  /**
   * Callback when a new block is detected
   */
  onNewBlock?: (height: number, hash: string) => void;

  /**
   * Callback when new transactions are detected for the wallet
   */
  onNewTransaction?: (txHash: string, outputHash: string, amount: bigint) => void;

  /**
   * Callback when balance changes
   */
  onBalanceChange?: (newBalance: bigint, oldBalance: bigint) => void;

  /**
   * Callback on sync error (background sync continues after errors)
   */
  onError?: (error: Error) => void;
}

/**
 * Reorganization information
 */
export interface ReorganizationInfo {
  /** Height where reorganization occurred */
  height: number;
  /** Old block hash */
  oldHash: string;
  /** New block hash */
  newHash: string;
  /** Number of blocks to revert */
  blocksToRevert: number;
}

/**
 * Transaction Keys Sync Manager
 *
 * Can be initialized with either:
 * - A SyncProvider (recommended) - works with Electrum, P2P, or custom backends
 * - An ElectrumClient (legacy) - for backwards compatibility
 * 
 * @category Sync
 */
export class TransactionKeysSync {
  private walletDB: IWalletDB;
  private syncProvider: SyncProvider;
  private keyManager: KeyManager | null = null;
  private syncState: SyncState | null = null;
  private blockHashRetention: number = 10000;

  /**
   * Create a new TransactionKeysSync instance
   * @param walletDB - The wallet database (WalletDB or IndexedDBWalletDB)
   * @param provider - A SyncProvider or ElectrumClient instance
   */
  constructor(walletDB: IWalletDB, provider: SyncProvider | ElectrumClient) {
    this.walletDB = walletDB;

    // Support both SyncProvider and legacy ElectrumClient
    if ('type' in provider && (provider.type === 'electrum' || provider.type === 'p2p' || provider.type === 'custom')) {
      // It's a SyncProvider
      this.syncProvider = provider;
    } else {
      // It's a legacy ElectrumClient - wrap it in an adapter
      this.syncProvider = this.wrapElectrumClient(provider as ElectrumClient);
    }
  }

  /**
   * Wrap an ElectrumClient as a SyncProvider for backwards compatibility
   */
  private wrapElectrumClient(client: ElectrumClient): SyncProvider {
    return {
      type: 'electrum' as const,
      connect: () => client.connect(),
      disconnect: () => client.disconnect(),
      isConnected: () => client.isConnected(),
      getChainTipHeight: () => client.getChainTipHeight(),
      getChainTip: async () => {
        const height = await client.getChainTipHeight();
        const header = await client.getBlockHeader(height);
        const hash = Buffer.from(sha256(sha256(Buffer.from(header, 'hex')))).reverse().toString('hex');
        return { height, hash };
      },
      getBlockHeader: (height: number) => client.getBlockHeader(height),
      getBlockHeaders: (startHeight: number, count: number) => client.getBlockHeaders(startHeight, count),
      getBlockTransactionKeysRange: (startHeight: number) => client.getBlockTransactionKeysRange(startHeight),
      getBlockTransactionKeys: async (height: number) => {
        const result = await client.getBlockTransactionKeys(height);
        return Array.isArray(result) ? result : [];
      },
      getTransactionKeys: (txHash: string) => client.getTransactionKeys(txHash),
      getTransactionOutput: (outputHash: string) => client.getTransactionOutput(outputHash),
      broadcastTransaction: (rawTx: string) => client.broadcastTransaction(rawTx),
      getRawTransaction: (txHash: string, verbose?: boolean) => client.getRawTransaction(txHash, verbose),
    };
  }

  /**
   * Get the sync provider being used
   */
  getSyncProvider(): SyncProvider {
    return this.syncProvider;
  }

  /**
   * Get the provider type (electrum, p2p, or custom)
   */
  getProviderType(): 'electrum' | 'p2p' | 'custom' {
    return this.syncProvider.type;
  }

  /**
   * Set the KeyManager instance for output detection
   * @param keyManager - The KeyManager instance
   */
  setKeyManager(keyManager: KeyManager): void {
    this.keyManager = keyManager;
  }

  /**
   * Initialize sync manager
   * Loads sync state from database
   */
  async initialize(): Promise<void> {
    // Only load/create wallet if keyManager wasn't already set via setKeyManager()
    if (!this.keyManager) {
      // Ensure database is initialized
      // Try to load wallet (will initialize DB if needed)
      try {
        this.keyManager = await this.walletDB.loadWallet();
      } catch {
        // If wallet doesn't exist, create it
        this.keyManager = await this.walletDB.createWallet();
      }
    }

    // Load sync state from database
    this.syncState = await this.loadSyncState();
  }

  /**
   * Get current sync state
   */
  getSyncState(): SyncState | null {
    return this.syncState;
  }

  /**
   * Get last synced height
   */
  getLastSyncedHeight(): number {
    return this.syncState?.lastSyncedHeight ?? -1;
  }

  /**
   * Check if sync is needed
   */
  async isSyncNeeded(): Promise<boolean> {
    if (!this.syncState) {
      return true;
    }

    const chainTip = await this.syncProvider.getChainTipHeight();
    return chainTip > this.syncState.lastSyncedHeight;
  }

  /**
   * Synchronize transaction keys from Electrum server
   * @param options - Sync options
   * @returns Number of transaction keys synced
   */
  async sync(options: SyncOptions = {}): Promise<number> {
    if (!this.keyManager) {
      await this.initialize();
    }

    const {
      startHeight,
      endHeight,
      onProgress,
      stopOnReorg = true,
      verifyHashes = true,
      saveInterval = 100,
      keepTxKeys = false,
      blockHashRetention = 10000,
    } = options;

    // Update retention setting
    this.blockHashRetention = blockHashRetention;

    // Determine start and end heights
    const lastSynced = this.syncState?.lastSyncedHeight ?? -1;

    // For first sync, use wallet creation height if available
    let defaultStartHeight = lastSynced + 1;
    if (lastSynced === -1) {
      const creationHeight = await this.walletDB.getCreationHeight();
      if (creationHeight > 0) {
        defaultStartHeight = creationHeight;
      }
    }

    const syncStartHeight = startHeight ?? defaultStartHeight;
    const chainTip = await this.syncProvider.getChainTipHeight();
    const syncEndHeight = endHeight ?? chainTip;

    if (syncStartHeight > syncEndHeight) {
      return 0; // Already synced
    }

    // Check for reorganization
    if (this.syncState && verifyHashes) {
      const reorgInfo = await this.checkReorganization(this.syncState.lastSyncedHeight);
      if (reorgInfo) {
        if (stopOnReorg) {
          throw new Error(
            `Chain reorganization detected at height ${reorgInfo.height}. ` +
              `Old hash: ${reorgInfo.oldHash}, New hash: ${reorgInfo.newHash}. ` +
              `Need to revert ${reorgInfo.blocksToRevert} blocks.`
          );
        } else {
          // Handle reorganization
          await this.handleReorganization(reorgInfo);
        }
      }
    }

    let totalTxKeysSynced = 0;
    let currentHeight = syncStartHeight;
    let blocksProcessed = 0;
    let lastSaveHeight = syncStartHeight - 1;

    // Pipeline: prefetch the next batch of tx keys + headers while
    // processing the current batch, eliminating the ~2s pause between batches.
    // The first batch is fetched inside the loop; subsequent batches are
    // prefetched at the end of each iteration so the download overlaps with
    // processing.

    let pendingRangePromise: Promise<{ blocks: BlockTransactionKeys[]; nextHeight: number }> | null = null;

    while (currentHeight <= syncEndHeight) {
      let rangeResult: { blocks: BlockTransactionKeys[]; nextHeight: number };

      if (pendingRangePromise) {
        try {
          rangeResult = await pendingRangePromise;
        } catch {
          rangeResult = await this.withRetry(() =>
            this.syncProvider.getBlockTransactionKeysRange(currentHeight)
          );
        }
        pendingRangePromise = null;
      } else {
        rangeResult = await this.withRetry(() =>
          this.syncProvider.getBlockTransactionKeysRange(currentHeight)
        );
      }

      const blocksToProcess = rangeResult.blocks.filter(b => b.height <= syncEndHeight);
      if (blocksToProcess.length === 0) break;

      const firstHeight = blocksToProcess[0].height;
      const lastHeight = blocksToProcess[blocksToProcess.length - 1].height;
      const nextBatchHeight = rangeResult.nextHeight;

      // Safety check to prevent infinite loops
      if (nextBatchHeight <= rangeResult.blocks[rangeResult.blocks.length - 1]?.height) {
        throw new Error(
          `Server did not advance next_height properly. Current: ${nextBatchHeight}, Last block: ${rangeResult.blocks[rangeResult.blocks.length - 1]?.height}`
        );
      }

      // Immediately start prefetching the NEXT batch of tx keys so it
      // downloads in parallel with our processing of the current batch.
      if (nextBatchHeight <= syncEndHeight) {
        pendingRangePromise = this.syncProvider.getBlockTransactionKeysRange(nextBatchHeight);
      }

      // Header pipeline: one-ahead prefetch so the next chunk loads while we process the current one
      const CS = TransactionKeysSync.HEADER_CHUNK_SIZE;
      let chunkStart = firstHeight;
      let currentHeaders = await this.fetchHeaderChunk(chunkStart, CS);
      let nextChunkStart = chunkStart + CS;
      let nextHeadersPromise: Promise<Map<number, string>> | null =
        nextChunkStart <= lastHeight ? this.fetchHeaderChunk(nextChunkStart, CS) : null;

      let lastBlockHash = '';
      // Process each block using the current chunk; when we cross into the next chunk, swap and prefetch
      for (let blockIdx = 0; blockIdx < blocksToProcess.length; blockIdx++) {
        const block = blocksToProcess[blockIdx];

        // Yield to the event loop periodically so the browser can repaint
        // and handle user input, preventing UI freezes during long syncs.
        if (blockIdx > 0 && blockIdx % YIELD_EVERY_N_BLOCKS === 0) {
          await yieldToMainThread();
        }

        if (!currentHeaders.has(block.height) && nextHeadersPromise) {
          currentHeaders = await nextHeadersPromise;
          nextHeadersPromise = null;
          chunkStart = nextChunkStart;
          nextChunkStart = chunkStart + CS;
          if (nextChunkStart <= lastHeight) {
            nextHeadersPromise = this.fetchHeaderChunk(nextChunkStart, CS);
          }
        }
        const headerHex = currentHeaders.get(block.height)!;
        const blockHash = this.extractBlockHash(headerHex);
        lastBlockHash = blockHash;

        if (verifyHashes) {
          await this.storeBlockHash(block.height, blockHash, chainTip);

          if (this.syncState && block.height <= this.syncState.lastSyncedHeight) {
            const storedHash = await this.getStoredBlockHash(block.height);
            if (storedHash && storedHash !== blockHash) {
              const reorgInfo: ReorganizationInfo = {
                height: block.height,
                oldHash: storedHash,
                newHash: blockHash,
                blocksToRevert: this.syncState.lastSyncedHeight - block.height + 1,
              };

              if (stopOnReorg) {
                throw new Error(
                  `Chain reorganization detected at height ${block.height}. ` +
                    `Old hash: ${storedHash}, New hash: ${blockHash}.`
                );
              } else {
                await this.handleReorganization(reorgInfo);
              }
            }
          }
        } else {
          await this.storeBlockHash(block.height, blockHash, chainTip);
        }

        const txKeysCount = await this.storeBlockTransactionKeys(block, blockHash, keepTxKeys);

        if (this.keyManager) {
          await this.processBlockForSpentOutputs(block, blockHash);
        }

        totalTxKeysSynced += txKeysCount;
        blocksProcessed++;

        if (onProgress) {
          onProgress(block.height, syncEndHeight, blocksProcessed, totalTxKeysSynced, false);
        }
      }

      // Update sync state after processing batch (lastBlockHash was set in the loop)
      const lastBlock = blocksToProcess[blocksToProcess.length - 1];
      await this.updateSyncState({
        lastSyncedHeight: lastBlock.height,
        lastSyncedHash: lastBlockHash,
        totalTxKeysSynced: (this.syncState?.totalTxKeysSynced ?? 0) + totalTxKeysSynced,
        lastSyncTime: Date.now(),
        chainTipAtLastSync: chainTip,
      });

      if (saveInterval > 0 && lastBlock.height - lastSaveHeight >= saveInterval) {
        await this.walletDB.saveDatabase();
        lastSaveHeight = lastBlock.height;
      }

      currentHeight = nextBatchHeight;
    }

    // Final save after sync completes to ensure state is persisted
    await this.walletDB.saveDatabase();

    return totalTxKeysSynced;
  }

  /**
   * Retry a function on transient network errors (timeout, disconnect).
   * Reconnects the sync provider between attempts.
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    baseDelayMs: number = 2000
  ): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        const msg = lastError.message || '';
        const isRetryable =
          msg.includes('Not connected') ||
          msg.includes('Connection closed') ||
          msg.includes('Request timeout') ||
          msg.includes('reconnection failed') ||
          msg.includes('WebSocket');

        if (!isRetryable || attempt === maxRetries) {
          throw lastError;
        }

        const delay = baseDelayMs * Math.pow(2, attempt);
        console.warn(
          `[tx-keys-sync] Retryable error (attempt ${attempt + 1}/${maxRetries}): ${msg}. ` +
            `Retrying in ${delay}ms...`
        );
        await new Promise(resolve => setTimeout(resolve, delay));

        if (!this.syncProvider.isConnected()) {
          try {
            await this.syncProvider.connect();
          } catch (connectError) {
            console.warn(`[tx-keys-sync] Reconnection attempt failed:`, connectError);
          }
        }
      }
    }
    throw lastError!;
  }

  /**
   * Check for chain reorganization
   * @param height - Height to check
   * @returns Reorganization info if detected, null otherwise
   */
  private async checkReorganization(height: number): Promise<ReorganizationInfo | null> {
    if (!this.syncState || height < 0) {
      return null;
    }

    // Get current block hash from server
    const currentHeader = await this.syncProvider.getBlockHeader(height);
    const currentHash = this.extractBlockHash(currentHeader);

    // Get stored block hash
    const storedHash = await this.getStoredBlockHash(height);

    if (storedHash && storedHash !== currentHash) {
      // Reorganization detected - find common ancestor
      let commonHeight = height - 1;
      while (commonHeight >= 0) {
        const commonHeader = await this.syncProvider.getBlockHeader(commonHeight);
        const commonHash = this.extractBlockHash(commonHeader);
        const storedCommonHash = await this.getStoredBlockHash(commonHeight);

        if (storedCommonHash === commonHash) {
          break;
        }
        commonHeight--;
      }

      return {
        height: commonHeight + 1,
        oldHash: storedHash,
        newHash: currentHash,
        blocksToRevert: height - commonHeight,
      };
    }

    return null;
  }

  /**
   * Handle chain reorganization
   * @param reorgInfo - Reorganization information
   */
  private async handleReorganization(reorgInfo: ReorganizationInfo): Promise<void> {
    console.log(
      `Handling reorganization: reverting ${reorgInfo.blocksToRevert} blocks from height ${reorgInfo.height}`
    );

    // Revert blocks in database
    const revertHeight = reorgInfo.height + reorgInfo.blocksToRevert - 1;
    await this.revertBlocks(reorgInfo.height, revertHeight);

    // Update sync state
    await this.updateSyncState({
      lastSyncedHeight: reorgInfo.height - 1,
      lastSyncedHash: (await this.getStoredBlockHash(reorgInfo.height - 1)) || '',
      totalTxKeysSynced: this.syncState?.totalTxKeysSynced ?? 0,
      lastSyncTime: Date.now(),
      chainTipAtLastSync: await this.syncProvider.getChainTipHeight(),
    });
  }

  /**
   * Process block transactions to detect spent outputs
   * @param block - Block transaction keys
   * @param _blockHash - Block hash (for reference)
   */
  private async processBlockForSpentOutputs(
    block: BlockTransactionKeys,
    _blockHash: string
  ): Promise<void> {
    const replacedMempoolTxIds = new Set<string>();

    for (const txKeys of block.txKeys) {
      const txHash = txKeys.txHash || '';
      if (!txHash) continue;

      const keys = txKeys.keys || {};
      const txData = keys[1] || keys;
      const inputs = txData?.inputs || txData?.vin || [];

      if (Array.isArray(inputs)) {
        for (const input of inputs) {
          const outputHash = input?.prevoutHash || input?.outputHash || input?.output_hash || input?.prevout?.hash;
          if (!outputHash) continue;

          if (await this.walletDB.isOutputUnspent(outputHash)) {
            await this.walletDB.markOutputSpent(outputHash, txHash, block.height);
          } else {
            // Check if this output was spent in a mempool tx. BLSCT aggregates
            // transactions at block level, so the confirmed tx hash will differ
            // from the mempool tx hash.
            const oldMempoolTxId = await this.walletDB.getMempoolSpentTxHash(outputHash);
            if (oldMempoolTxId) {
              replacedMempoolTxIds.add(oldMempoolTxId);
              await this.walletDB.markOutputSpent(outputHash, txHash, block.height);
            }
          }
        }
      }
    }

    // Clean up synthetic pending outputs from replaced mempool transactions.
    // The real outputs are already stored by storeBlockTransactionKeys.
    for (const oldTxId of replacedMempoolTxIds) {
      await this.walletDB.deleteUnconfirmedOutputsByTxHash(oldTxId);
    }
  }

  /**
   * Process a mempool (unconfirmed) transaction using the same ownership
   * detection logic as confirmed blocks. Outputs owned by this wallet are
   * stored with blockHeight=0 and inputs that spend wallet outputs are
   * marked as spent with spentBlockHeight=0.
   *
   * The raw transaction hex is deserialized locally to extract output keys
   * and range proofs, avoiding round-trips to ElectrumX which may not serve
   * mempool output data.
   *
   * @param txHash - The transaction hash (as returned by broadcast)
   * @param rawTx - The serialized transaction hex
   */
  async processMempoolTransaction(txHash: string, rawTx: string): Promise<void> {
    if (!this.keyManager) {
      console.log(`[tx-keys-sync] processMempoolTransaction: no keyManager, skipping`);
      return;
    }

    const {
      CTx, PublicKey, Point, RangeProof, AmountRecoveryReq,
      getCTxOutBlindingKey, getCTxOutSpendingKey, getCTxOutViewTag,
    } = blsctModule as any;

    let ctx: any;
    try {
      ctx = CTx.deserialize(rawTx);
    } catch (err) {
      console.warn(`[tx-keys-sync] Failed to deserialize mempool tx ${txHash}:`, err);
      return;
    }

    const outs = ctx.getCTxOuts();
    const numOuts = outs.size();
    console.log(`[tx-keys-sync] processMempoolTransaction: txHash=${txHash}, ${numOuts} outputs`);

    for (let i = 0; i < numOuts; i++) {
      const ctxOut = outs.at(i);

      const blindingKeyRawPtr = getCTxOutBlindingKey(ctxOut.obj);
      const spendingKeyRawPtr = getCTxOutSpendingKey(ctxOut.obj);
      const viewTag = getCTxOutViewTag(ctxOut.obj);

      const blindingKeyObj = PublicKey.fromPoint(Point.fromObj(blindingKeyRawPtr));
      const spendingKeyObj = PublicKey.fromPoint(Point.fromObj(spendingKeyRawPtr));

      const isMine = this.keyManager.isMineByKeys(blindingKeyObj, spendingKeyObj, viewTag);
      console.log(`[tx-keys-sync] mempool output ${i}: viewTag=${viewTag}, isMine=${isMine}`);

      if (!isMine) continue;

      let recoveredAmount = 0;
      let recoveredGamma = '0';
      let recoveredMemo: string | null = null;
      let tokenIdHex: string | null = null;

      try {
        const nonce = this.keyManager.calculateNonce(blindingKeyObj);
        const rangeProof = ctxOut.getRangeProof();
        const tokenId = ctxOut.getTokenId();
        tokenIdHex = tokenId.serialize();

        const req = new AmountRecoveryReq(rangeProof, nonce, tokenId);
        const results = RangeProof.recoverAmounts([req]);

        if (results.length > 0 && results[0].isSucc) {
          recoveredAmount = Number(results[0].amount);
          recoveredGamma = results[0].gamma ?? '0';
          recoveredMemo = results[0].msg || null;
        }
        console.log(`[tx-keys-sync] mempool output ${i} recovery: amount=${recoveredAmount}, gamma=${recoveredGamma}`);
      } catch (err) {
        console.warn(`[tx-keys-sync] Amount recovery failed for mempool output ${i}:`, err);
      }

      const blindingKeyHex = blindingKeyObj.serialize();
      const spendingKeyHex = spendingKeyObj.serialize();
      const outputHash = `mempool:${txHash}:${i}`;

      await this.storeWalletOutput(
        outputHash, txHash, i, 0, '',
        recoveredAmount, recoveredGamma, recoveredMemo, tokenIdHex,
        blindingKeyHex, spendingKeyHex,
        false, null, null
      );
    }

    // Process inputs to mark wallet outputs as spent in mempool
    try {
      const ins = ctx.getCTxIns();
      const numIns = ins.size();
      for (let i = 0; i < numIns; i++) {
        const ctxIn = ins.at(i);
        const prevOutHash = ctxIn.getPrevOutHash();
        if (prevOutHash) {
          const outputHash = typeof prevOutHash === 'string' ? prevOutHash : prevOutHash.serialize();
          if (await this.walletDB.isOutputUnspent(outputHash)) {
            await this.walletDB.markOutputSpent(outputHash, txHash, 0);
          }
        }
      }
    } catch (err) {
      console.warn(`[tx-keys-sync] Failed to process mempool tx inputs:`, err);
    }
  }

  /**
   * Revert blocks from database
   * @param startHeight - Start height to revert from
   * @param endHeight - End height to revert to
   */
  private async revertBlocks(startHeight: number, endHeight: number): Promise<void> {
    for (let height = startHeight; height <= endHeight; height++) {
      await this.walletDB.deleteTxKeysByHeight(height);
      await this.walletDB.deleteOutputsByHeight(height);
      await this.walletDB.unspendOutputsBySpentHeight(height);
      await this.walletDB.deleteBlockHash(height);
    }
  }

  /**
   * Store transaction keys for a block
   * @param block - Block transaction keys
   * @param blockHash - Block hash
   * @param keepTxKeys - Whether to keep transaction keys in database after processing
   * @returns Number of transaction keys stored
   */
  private async storeBlockTransactionKeys(
    block: BlockTransactionKeys,
    blockHash: string,
    keepTxKeys: boolean = false
  ): Promise<number> {
    let count = 0;

    if (block.height <= 100005 || block.height % 5000 === 0) {
      console.log(`[tx-keys-sync] storeBlockTransactionKeys: height=${block.height}, txKeys count=${block.txKeys.length}, keyManager=${!!this.keyManager}`);
    }

    for (const txKeys of block.txKeys) {
      let txHash = txKeys.txHash;
      if (!txHash && txKeys.keys && typeof txKeys.keys === 'object') {
        txHash = (txKeys.keys as any).txHash || (txKeys.keys as any).hash || '';
      }
      if (!txHash) {
        txHash = `block_${block.height}_tx_${count}`;
      }

      if (this.keyManager) {
        await this.processTransactionKeys(txHash, txKeys.keys, block.height, blockHash);
      }

      if (keepTxKeys) {
        await this.walletDB.saveTxKeys(txHash, block.height, JSON.stringify(txKeys.keys));
      }

      count++;
    }

    return count;
  }

  /**
   * Process transaction keys to detect and store wallet outputs
   * @param txHash - Transaction hash
   * @param keys - Transaction keys data
   * @param blockHeight - Block height
   * @param _blockHash - Block hash (for reference, currently unused)
   */
  private async processTransactionKeys(
    txHash: string,
    keys: any,
    blockHeight: number,
    _blockHash: string
  ): Promise<void> {
    if (!this.keyManager) {
      console.log(`[tx-keys-sync] processTransactionKeys called but keyManager is null`);
      return;
    }

    // Log raw keys structure for first few blocks to understand format
    if (blockHeight <= 100005 || blockHeight % 5000 === 0) {
      console.log(`[tx-keys-sync] processTransactionKeys: height=${blockHeight}, keys type=${typeof keys}, isArray=${Array.isArray(keys)}, structure:`, JSON.stringify(keys).slice(0, 500));
    }

    // Transaction keys structure: { outputs: [{ blindingKey, spendingKey, viewTag, outputHash, ... }, ...] }
    // The exact structure depends on electrumx implementation
    const outputs = keys[1]?.outputs || keys[1]?.vout || [];

    if (!Array.isArray(outputs)) {
      console.log(`[tx-keys-sync] outputs is not array, keys[1]:`, JSON.stringify(keys[1]).slice(0, 300));
      return;
    }

    if (outputs.length > 0) {
      console.log(`[tx-keys-sync] height=${blockHeight}, txHash=${txHash}, ${outputs.length} outputs, first:`, JSON.stringify(outputs[0]).slice(0, 300));
    }

    for (let outputIndex = 0; outputIndex < outputs.length; outputIndex++) {
      const outputKeys = outputs[outputIndex];

      // Extract keys from output
      const blindingKey = outputKeys?.blindingKey || outputKeys?.blinding_key;
      const spendingKey = outputKeys?.spendingKey || outputKeys?.spending_key;
      const viewTag = outputKeys?.viewTag ?? outputKeys?.view_tag;
      const outputHash = outputKeys?.outputHash || outputKeys?.output_hash;

      if (!blindingKey || !spendingKey || viewTag === undefined || !outputHash) {
        console.warn(
          `[tx-keys-sync] Invalid output keys at height ${blockHeight}: blindingKey=${!!blindingKey}, spendingKey=${!!spendingKey}, viewTag=${viewTag}, outputHash=${!!outputHash}. Raw keys:`, JSON.stringify(outputKeys).slice(0, 300)
        );
        continue;
      }

      // Convert keys to PublicKey format if needed (they might be hex strings or serialized)
      const PublicKey = blsctModule.PublicKey;
      let blindingKeyObj: any = PublicKey.deserialize(blindingKey);
      let spendingKeyObj: any = PublicKey.deserialize(spendingKey);

      // Check if output belongs to wallet
      const isMine = this.keyManager.isMineByKeys(blindingKeyObj, spendingKeyObj, viewTag);
      if (blockHeight >= 100000 && outputs.length > 0) {
        console.log(`[tx-keys-sync] isMine check: height=${blockHeight}, outputIndex=${outputIndex}, viewTag=${viewTag}, isMine=${isMine}`);
      }
      if (isMine) {
        console.log(`[tx-keys-sync] OUTPUT IS MINE at height ${blockHeight}, txHash=${txHash}, outputHash=${outputHash}`);
        // Fetch output data from backend
        try {
          const outputHex = await this.withRetry(() =>
            this.syncProvider.getTransactionOutput(outputHash)
          );
          console.log(`[tx-keys-sync] Got output hex, length=${outputHex.length}`);

          // Recover the amount from the range proof
          const RangeProof = blsctModule.RangeProof;
          const AmountRecoveryReq = blsctModule.AmountRecoveryReq;
          
          let recoveredAmount = 0;
          let recoveredGamma = '0';
          let recoveredMemo: string | null = null;
          let tokenIdHex: string | null = null;

          try {
            // Calculate the nonce (shared secret) for amount recovery
            const nonce = this.keyManager.calculateNonce(blindingKeyObj);
            console.log(`[tx-keys-sync] Nonce calculated, type=${typeof nonce}, constructor=${nonce?.constructor?.name}`);
            
            // Parse the range proof from the output data
            const rangeProofResult = this.extractRangeProofFromOutput(outputHex);
            console.log(`[tx-keys-sync] Range proof extracted: hasProof=${!!rangeProofResult.rangeProofHex}, proofLen=${rangeProofResult.rangeProofHex?.length}, tokenId=${rangeProofResult.tokenIdHex}`);
            
            if (rangeProofResult.rangeProofHex) {
              const rangeProof = RangeProof.deserialize(rangeProofResult.rangeProofHex);
              console.log(`[tx-keys-sync] Range proof deserialized, type=${rangeProof?.constructor?.name}`);
              
              // Create recovery request
              const req = new AmountRecoveryReq(rangeProof, nonce);
              console.log(`[tx-keys-sync] AmountRecoveryReq created`);
              
              // Recover the amount using static method
              const results = RangeProof.recoverAmounts([req]);
              console.log(`[tx-keys-sync] Recovery results: count=${results.length}, isSucc=${results[0]?.isSucc}, amount=${results[0]?.amount}, msg=${results[0]?.msg}`);
              
              if (results.length > 0 && results[0].isSucc) {
                recoveredAmount = Number(results[0].amount);
                recoveredGamma = results[0].gamma ?? '0';
                recoveredMemo = results[0].msg || null;
              }
            }
            
            tokenIdHex = rangeProofResult.tokenIdHex;
          } catch (amountError) {
            console.warn(
              `[tx-keys-sync] Amount recovery FAILED for output ${outputHash} at height ${blockHeight}:`,
              amountError
            );
          }
          
          console.log(`[tx-keys-sync] STORING output: amount=${recoveredAmount}, gamma=${recoveredGamma}, memo=${recoveredMemo}`);

          // Store output as spendable with recovered amount
          await this.storeWalletOutput(
            outputHash,
            txHash,
            outputIndex,
            blockHeight,
            outputHex,
            recoveredAmount,
            recoveredGamma,
            recoveredMemo,
            tokenIdHex,
            blindingKey,
            spendingKey,
            false, // not spent
            null, // spent_tx_hash
            null // spent_block_height
          );
        } catch (error) {
          // Output might not be available yet, skip for now
          console.warn(`Failed to fetch output ${outputHash} for tx ${txHash}:`, error);
        }
      }
    }
  }

  /**
   * Extract range proof from serialized CTxOut data
   * @param outputHex - Serialized output data (hex)
   * @returns Object containing rangeProofHex and tokenIdHex
   */
  private extractRangeProofFromOutput(outputHex: string): { rangeProofHex: string | null; tokenIdHex: string | null } {
    try {
      const data = Buffer.from(outputHex, 'hex');
      let offset = 0;

      // CTxOut serialization format:
      // - value (8 bytes) - either transparent or MAX_AMOUNT marker
      // - if MAX_AMOUNT: flags (8 bytes)
      // - if flags & TRANSPARENT_VALUE: transparent value (8 bytes)
      // - scriptPubKey (varint length + data)
      // - if flags & HAS_BLSCT_KEYS: rangeProof + blsctData
      // - if flags & HAS_TOKENID: tokenId (64 bytes)
      // - if flags & HAS_PREDICATE: predicate (varint length + data)

      const MAX_AMOUNT = 0x7fffffffffffffffn;
      const HAS_BLSCT_KEYS = 1n;
      const HAS_TOKENID = 2n;

      // Read value
      const value = data.readBigInt64LE(offset);
      offset += 8;

      let flags = 0n;
      if (value === MAX_AMOUNT) {
        flags = data.readBigUInt64LE(offset);
        offset += 8;
        
        // Skip transparent value if present
        if ((flags & 8n) !== 0n) {
          offset += 8;
        }
      }

      // Skip scriptPubKey
      const scriptLen = data[offset];
      offset += 1 + scriptLen;

      let rangeProofHex: string | null = null;
      let tokenIdHex: string | null = null;

      // Extract range proof if present
      if ((flags & HAS_BLSCT_KEYS) !== 0n) {
        // Range proof structure:
        // - Vs: vector of G1 points (varint count + 48 bytes each)
        // - If Vs.size > 0:
        //   - Ls: vector of G1 points
        //   - Rs: vector of G1 points  
        //   - A, A_wip, B: 3 G1 points (48 bytes each)
        //   - r', s', delta', alpha_hat, tau_x: 5 scalars (32 bytes each)
        // - spendingKey, blindingKey, ephemeralKey: 3 G1 points (48 bytes each)
        // - viewTag: 2 bytes
        
        const rangeProofStart = offset;
        
        // Parse Vs
        const vsCount = data[offset];
        offset += 1;
        offset += vsCount * 48;
        
        if (vsCount > 0) {
          // Ls
          const lsCount = data[offset];
          offset += 1;
          offset += lsCount * 48;
          
          // Rs
          const rsCount = data[offset];
          offset += 1;
          offset += rsCount * 48;
          
          // A, A_wip, B (3 points)
          offset += 3 * 48;
          
          // 5 scalars: r', s', delta', alpha_hat, tau_x
          offset += 5 * 32;
        }
        
        const rangeProofEnd = offset;
        rangeProofHex = data.subarray(rangeProofStart, rangeProofEnd).toString('hex');
        
        // Skip BLSCT keys (spendingKey, blindingKey, ephemeralKey, viewTag)
        offset += 3 * 48 + 2;
      }

      // Extract tokenId if present
      if ((flags & HAS_TOKENID) !== 0n) {
        tokenIdHex = data.subarray(offset, offset + 64).toString('hex');
      }

      return { rangeProofHex, tokenIdHex };
    } catch (e) {
      return { rangeProofHex: null, tokenIdHex: null };
    }
  }

  private async storeWalletOutput(
    outputHash: string,
    txHash: string,
    outputIndex: number,
    blockHeight: number,
    outputData: string,
    amount: number,
    gamma: string,
    memo: string | null,
    tokenId: string | null,
    blindingKey: string,
    spendingKey: string,
    isSpent: boolean,
    spentTxHash: string | null,
    spentBlockHeight: number | null
  ): Promise<void> {
    await this.walletDB.storeWalletOutput({
      outputHash, txHash, outputIndex, blockHeight, outputData,
      amount, gamma, memo, tokenId, blindingKey, spendingKey,
      isSpent, spentTxHash, spentBlockHeight,
    });
  }

  /**
   * Extract block hash from block header
   * @param headerHex - Block header in hex
   * @returns Block hash (hex string)
   */
  private extractBlockHash(headerHex: string): string {
    // Block hash is double SHA256 of header, reversed for display
    const headerBytes = Buffer.from(headerHex, 'hex');
    const hash = sha256(sha256(headerBytes));
    return Buffer.from(hash).reverse().toString('hex');
  }

  private static readonly HEADER_CHUNK_SIZE = 2016;

  /**
   * Fetch a chunk of block headers and return them as a map of height -> header hex.
   * Electrum servers cap responses at ~2016 headers, so callers should request
   * in chunks of that size.
   */
  private async fetchHeaderChunk(
    startHeight: number,
    count: number
  ): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    const headersResult = await this.withRetry(() =>
      this.syncProvider.getBlockHeaders(startHeight, count)
    );
    const headerSize = 160; // 80 bytes * 2 hex chars
    const hex = headersResult.hex;
    const returned = Math.min(headersResult.count, count);

    for (let i = 0; i < returned && i * headerSize < hex.length; i++) {
      map.set(startHeight + i, hex.substring(i * headerSize, (i + 1) * headerSize));
    }
    return map;
  }

  /**
   * Get stored block hash from database
   * @param height - Block height
   * @returns Block hash or null if not found
   */
  private async getStoredBlockHash(height: number): Promise<string | null> {
    return this.walletDB.getBlockHash(height);
  }

  /**
   * Store block hash in database
   * Only stores if within retention window (if retention is enabled)
   * @param height - Block height
   * @param hash - Block hash
   * @param chainTip - Current chain tip (optional, to avoid repeated fetches)
   */
  private async storeBlockHash(height: number, hash: string, chainTip?: number): Promise<void> {
    if (this.blockHashRetention > 0) {
      const currentChainTip = chainTip ?? (await this.syncProvider.getChainTipHeight());
      const retentionStart = Math.max(0, currentChainTip - this.blockHashRetention + 1);
      if (height < retentionStart) return;
      if (height % 100 === 0) {
        await this.walletDB.deleteBlockHashesBefore(retentionStart);
      }
    }
    await this.walletDB.saveBlockHash(height, hash);
  }

  /**
   * Load sync state from database
   * @returns Sync state or null if not found
   */
  private async loadSyncState(): Promise<SyncState | null> {
    return this.walletDB.loadSyncState();
  }

  /**
   * Update sync state in database
   * @param state - Sync state to update
   */
  private async updateSyncState(state: Partial<SyncState>): Promise<void> {
    const currentState = this.syncState || {
      lastSyncedHeight: -1,
      lastSyncedHash: '',
      totalTxKeysSynced: 0,
      lastSyncTime: 0,
      chainTipAtLastSync: 0,
    };
    const newState: SyncState = { ...currentState, ...state };
    await this.walletDB.saveSyncState(newState);
    this.syncState = newState;
  }

  /**
   * Get transaction keys for a specific transaction
   * @param txHash - Transaction hash
   * @returns Transaction keys or null if not found
   */
  async getTransactionKeys(txHash: string): Promise<any | null> {
    return this.walletDB.getTxKeys(txHash);
  }

  /**
   * Get transaction keys for a block
   * @param height - Block height
   * @returns Array of transaction keys
   */
  async getBlockTransactionKeys(height: number): Promise<TransactionKeys[]> {
    const entries = await this.walletDB.getTxKeysByHeight(height);
    return entries.map((e) => ({ txHash: e.txHash, keys: e.keys }));
  }

  /**
   * Reset sync state (for testing or full resync)
   */
  async resetSyncState(): Promise<void> {
    await this.walletDB.clearSyncData();
    this.syncState = null;
  }
}
