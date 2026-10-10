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
import type { IWalletDB, SyncState, TxType } from './wallet-db.interface';
import * as blsctModule from '@nav-io/navio-blsct';
import { sha256 } from '@noble/hashes/sha256';
import { canonicalAnchorOutid, searchBlindingKey } from './blinding-key';
import { parseOutputHex, parseTransaction, type ParsedOutput } from './p2p-block-parser';
import { isStakedCommitmentOutput, isStakedCommitmentOutputHex } from './staking';

/**
 * Serialization of an empty bulletproofs+ range proof: just the zero Vs
 * count. Token/NFT mint outputs (transparent value) carry one of these.
 * `RangeProof.recoverAmounts` on an empty proof terminates the process with
 * an uncatchable native exception, so every recovery site must check this
 * before calling it.
 */
const EMPTY_RANGE_PROOF_HEX = '00';

/**
 * Hex spellings of the NAV (default) token id as they appear from different
 * sources: the bare 32-byte zero hash, and TokenId.serialize()'s 40-byte
 * form (zero hash + ffff… no-subid marker).
 */
const NAV_TOKEN_ID_HEX_FORMS = new Set([
  '0'.repeat(64),
  '0'.repeat(64) + 'ffffffffffffffff',
]);

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
  /**
   * Throw a {@link ReorgError} on a chain reorganization instead of reverting
   * the orphaned blocks and re-syncing from the fork (default: false). Reorgs
   * too deep to recover throw {@link DeepReorgError} either way.
   */
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
  /** Fork height: the first block that differs between the two chains */
  height: number;
  /** Hash of the block the wallet had synced at `height` */
  oldHash: string;
  /** Hash of the server's block at `height` */
  newHash: string;
  /** Number of blocks to revert (`height` up to the last synced height) */
  blocksToRevert: number;
}

/**
 * Thrown by sync() with `stopOnReorg: true` when the chain was reorganized.
 * Nothing has been reverted; `info` says where the fork is.
 */
export class ReorgError extends Error {
  constructor(public readonly info: ReorganizationInfo) {
    super(
      `Chain reorganization detected at height ${info.height}. ` +
        `Old hash: ${info.oldHash}, New hash: ${info.newHash}. ` +
        `Need to revert ${info.blocksToRevert} blocks.`
    );
    this.name = 'ReorgError';
  }
}

/**
 * How many blocks back sync() searches for the fork point of a reorg.
 *
 * Navio's PoS chain normally reorganizes by one or two blocks; 100 leaves a
 * wide margin while keeping the search to a single header request of at most
 * 100 headers. It is further capped at `blockHashRetention - 1`, since the
 * hashes to compare against are pruned below it. A deeper reorg throws
 * {@link DeepReorgError} rather than walking back towards genesis.
 */
export const MAX_REORG_DEPTH = 100;

/**
 * Thrown by sync() when a reorg's fork point cannot be found: it is deeper
 * than {@link MAX_REORG_DEPTH} (or `blockHashRetention`), or the walk reached
 * a height whose hash the wallet no longer stores. The wallet is left as it
 * was. Recover with `resetSyncState()` on the TransactionKeysSync
 * (`client.getSyncManager()`) and a fresh sync.
 *
 * No hashes exist below the first height the wallet synced (its creation or
 * restore height), so a reorg reaching below it throws with `reason`
 * `'missing-history'` however shallow it is.
 */
export class DeepReorgError extends Error {
  constructor(
    /** Last synced height when the reorg was detected */
    public readonly lastSyncedHeight: number,
    /** Lowest height compared with the server */
    public readonly searchedDownTo: number,
    /** 'too-deep': no match within the depth limit; 'missing-history': no stored hash at `searchedDownTo` */
    public readonly reason: 'too-deep' | 'missing-history'
  ) {
    super(
      (reason === 'too-deep'
        ? `Chain reorganization below height ${lastSyncedHeight} is deeper than the search limit: ` +
          `no common block found down to height ${searchedDownTo}. `
        : `Chain reorganization below height ${lastSyncedHeight} reaches height ${searchedDownTo}, ` +
          'where no block hash is stored (pruned by blockHashRetention, or never synced). ') +
        'Call resetSyncState() and sync again.'
    );
    this.name = 'DeepReorgError';
  }
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
   * Check if sync is needed: the chain tip is past the last synced height, or
   * the block the wallet holds at the tip height is not the tip block (a
   * reorg replaced it). Without a hash to compare on either side (a provider
   * that does not report the tip hash, or an old sync state) only the heights
   * are compared.
   */
  async isSyncNeeded(): Promise<boolean> {
    if (!this.syncState) {
      return true;
    }

    const tip = await this.syncProvider.getChainTip();
    if (tip.height > this.syncState.lastSyncedHeight) {
      return true;
    }

    const heldHash = await this.heldBlockHash(tip.height);
    return Boolean(tip.hash && heldHash && tip.hash.toLowerCase() !== heldHash.toLowerCase());
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
      stopOnReorg = false,
      verifyHashes = true,
      saveInterval = 100,
      keepTxKeys = false,
      blockHashRetention = 10000,
    } = options;

    // Update retention setting
    this.blockHashRetention = blockHashRetention;

    const chainTip = await this.syncProvider.getChainTipHeight();
    const syncEndHeight = endHeight ?? chainTip;

    // Check for a reorganization before choosing where to start: a revert
    // moves lastSyncedHeight back to the fork, and the replacement blocks from
    // there on must be scanned. This also runs when the tip did not advance,
    // since a reorg can replace the tip block at the same height.
    let reorgInfo: ReorganizationInfo | null = null;
    if (this.syncState && verifyHashes) {
      reorgInfo = await this.checkReorganization(this.syncState.lastSyncedHeight, chainTip);
      if (reorgInfo) {
        if (stopOnReorg) {
          throw new ReorgError(reorgInfo);
        }
        await this.handleReorganization(reorgInfo, chainTip);
        if (onProgress) {
          onProgress(reorgInfo.height - 1, syncEndHeight, 0, 0, true);
        }
      }
    }

    // Determine the start height (after any revert above)
    const lastSynced = this.syncState?.lastSyncedHeight ?? -1;

    // For first sync, use wallet creation height if available
    let defaultStartHeight = lastSynced + 1;
    if (lastSynced === -1) {
      const creationHeight = await this.walletDB.getCreationHeight();
      if (creationHeight > 0) {
        defaultStartHeight = creationHeight;
      }
    }

    let syncStartHeight = startHeight ?? defaultStartHeight;
    if (reorgInfo && syncStartHeight > reorgInfo.height) {
      // An explicit start past the fork would skip the replacement blocks.
      syncStartHeight = reorgInfo.height;
    }

    if (syncStartHeight > syncEndHeight) {
      return 0; // Already synced
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

        // Extract block timestamp and PoS flag from the 80-byte header
        let blockTimestamp = 0;
        let isPoS = false;
        if (headerHex && headerHex.length >= 160) {
          const headerBytes = Buffer.from(headerHex, 'hex');
          blockTimestamp = headerBytes.readUInt32LE(68);
          const blockVersion = headerBytes.readInt32LE(0);
          isPoS = (blockVersion & 0x01000000) !== 0;
        }

        // Reorgs are caught by the check before this loop: once the block at
        // lastSyncedHeight matches the server, every block below it does too.
        await this.storeBlockHash(block.height, blockHash, chainTip);

        const txKeysCount = await this.storeBlockTransactionKeys(block, blockHash, keepTxKeys, blockTimestamp, isPoS);

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
        await new Promise(resolve => setTimeout(resolve, delay));

        if (!this.syncProvider.isConnected()) {
          try {
            await this.syncProvider.connect();
          } catch {
            // Reconnection failed; next iteration will retry
          }
        }
      }
    }
    throw lastError!;
  }

  /**
   * The hash of the block the wallet synced at `height`: the stored block
   * hash, or for the last synced height the hash kept in the sync state.
   */
  private async heldBlockHash(height: number): Promise<string | null> {
    const stored = await this.getStoredBlockHash(height);
    if (stored) return stored;
    if (
      this.syncState &&
      height === this.syncState.lastSyncedHeight &&
      this.syncState.lastSyncedHash
    ) {
      return this.syncState.lastSyncedHash;
    }
    return null;
  }

  /**
   * Check whether the chain the wallet synced is still the server's chain,
   * and if not, find the fork point.
   *
   * Compares the block at the last synced height (or at the server's tip, if
   * the server is behind) with the one the wallet holds. On a mismatch it
   * fetches the headers below in one batch and walks down to the highest
   * height where the stored hash still matches, at most {@link MAX_REORG_DEPTH}
   * blocks (and never past `blockHashRetention`).
   *
   * @param lastSynced - Last synced height
   * @param chainTip - Server chain tip height
   * @returns Reorganization info if detected, null otherwise
   * @throws DeepReorgError if no matching block is found within the depth
   *   limit, or the walk reaches a height with no stored hash
   */
  private async checkReorganization(
    lastSynced: number,
    chainTip: number
  ): Promise<ReorganizationInfo | null> {
    if (!this.syncState || lastSynced < 0) {
      return null;
    }

    // A server behind us (or a chain that got shorter) is compared at its tip:
    // a match there means nothing to revert yet.
    const top = Math.min(lastSynced, chainTip);
    const heldTop = await this.heldBlockHash(top);
    if (!heldTop) {
      return null; // nothing recorded to compare against
    }
    const serverTop = this.extractBlockHash(
      await this.withRetry(() => this.syncProvider.getBlockHeader(top))
    );
    if (serverTop === heldTop) {
      return null;
    }

    // Retention keeps the newest `blockHashRetention` hashes, so the deepest
    // height that can still match is `blockHashRetention - 1` below the tip.
    const maxDepth =
      this.blockHashRetention > 0
        ? Math.min(MAX_REORG_DEPTH, this.blockHashRetention - 1)
        : MAX_REORG_DEPTH;
    const lowest = Math.max(0, lastSynced - maxDepth);
    const headers =
      top > lowest ? await this.fetchHeaderChunk(lowest, top - lowest) : new Map<number, string>();

    // Hashes at the lowest diverging height found so far: the fork block.
    let oldHash = heldTop;
    let newHash = serverTop;
    for (let height = top - 1; height >= lowest; height--) {
      const headerHex =
        headers.get(height) ??
        (await this.withRetry(() => this.syncProvider.getBlockHeader(height)));
      const serverHash = this.extractBlockHash(headerHex);
      const storedHash = await this.getStoredBlockHash(height);
      if (storedHash === null) {
        throw new DeepReorgError(lastSynced, height, 'missing-history');
      }
      if (storedHash === serverHash) {
        return {
          height: height + 1,
          oldHash,
          newHash,
          blocksToRevert: lastSynced - height,
        };
      }
      oldHash = storedHash;
      newHash = serverHash;
    }

    throw new DeepReorgError(lastSynced, lowest, 'too-deep');
  }

  /**
   * Handle chain reorganization
   * @param reorgInfo - Reorganization information
   */
  private async handleReorganization(
    reorgInfo: ReorganizationInfo,
    chainTip: number
  ): Promise<void> {
    const forkParent = reorgInfo.height - 1;
    const newState: SyncState = {
      lastSyncedHeight: forkParent,
      lastSyncedHash: (await this.getStoredBlockHash(forkParent)) || '',
      totalTxKeysSynced: this.syncState?.totalTxKeysSynced ?? 0,
      lastSyncTime: Date.now(),
      chainTipAtLastSync: chainTip,
    };

    // The new state and the deletes land in one transaction, so a crash
    // mid-revert cannot leave the state pointing past the deleted rows.
    await this.walletDB.revertBlocksFrom(reorgInfo.height, newState);
    this.syncState = newState;
    await this.walletDB.saveDatabase();
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
    if (!this.keyManager) return;

    const {
      CTx, PublicKey, Point, RangeProof, AmountRecoveryReq,
      getCTxOutBlindingKey, getCTxOutSpendingKey, getCTxOutViewTag, getCTxOutEphemeralKey,
    } = blsctModule as any;

    let ctx: any;
    try {
      ctx = CTx.deserialize(rawTx);
    } catch {
      return;
    }

    // Determine txType: check if any inputs reference wallet-owned outputs.
    // Mempool transactions are never PoS blocks, so: spent wallet input → 'sent', else → 'received'.
    let mempoolTxType: TxType = 'received';
    try {
      const ins = ctx.getCTxIns();
      const numIns = ins.size();
      for (let i = 0; i < numIns; i++) {
        const ctxIn = ins.at(i);
        const prevOutHash = ctxIn.getPrevOutHash();
        if (prevOutHash) {
          const outputHash = typeof prevOutHash === 'string' ? prevOutHash : prevOutHash.serialize();
          if (await this.walletDB.isOutputUnspent(outputHash)) {
            mempoolTxType = 'sent';
            break;
          }
        }
      }
    } catch {
      // Input inspection is best-effort
    }

    // Use current time as unix epoch for mempool outputs (no block timestamp available)
    const mempoolTimestamp = Math.floor(Date.now() / 1000);

    const outs = ctx.getCTxOuts();
    const numOuts = outs.size();
    // The binding's CTxOut cannot show a whole scriptPubKey, so read the
    // outputs' scripts from the raw transaction to spot staked commitments.
    let parsedOutputs: ParsedOutput[] = [];
    try {
      parsedOutputs = parseTransaction(Buffer.from(rawTx, 'hex')).outputs;
    } catch (error) {
      // The outputs are stored as not staked until block sync rewrites them,
      // so a staked one counts in the balance meanwhile.
      console.warn(`Could not parse mempool transaction ${txHash} to find staked outputs:`, error);
    }

    for (let i = 0; i < numOuts; i++) {
      const ctxOut = outs.at(i);

      const blindingKeyRawPtr = getCTxOutBlindingKey(ctxOut.obj);
      const spendingKeyRawPtr = getCTxOutSpendingKey(ctxOut.obj);
      const viewTag = getCTxOutViewTag(ctxOut.obj);

      const blindingKeyObj = PublicKey.fromPoint(Point.fromObj(blindingKeyRawPtr));
      const spendingKeyObj = PublicKey.fromPoint(Point.fromObj(spendingKeyRawPtr));

      const isMine = this.keyManager.isMineByKeys(blindingKeyObj, spendingKeyObj, viewTag);

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

        if (rangeProof.serialize() === EMPTY_RANGE_PROOF_HEX) {
          // Token/NFT mint outputs have no range proof — their amount is the
          // transparent value. RangeProof.recoverAmounts on an empty proof
          // ABORTS the process (uncatchable native exception), so it must
          // never be called here: this path runs on every own broadcast and
          // killed apps the moment they minted an NFT.
          recoveredAmount = Number(ctxOut.getValue());
          recoveredGamma = '0';
        } else {
          const req = new AmountRecoveryReq(rangeProof, nonce, tokenId);
          const results = RangeProof.recoverAmounts([req]);

          if (results.length > 0 && results[0].isSucc) {
            recoveredAmount = Number(results[0].amount);
            recoveredGamma = results[0].gamma ?? '0';
            recoveredMemo = results[0].msg || null;
          }
        }
      } catch {
        // Amount recovery failed; store output with zero amount
      }

      const blindingKeyHex = blindingKeyObj.serialize();
      const spendingKeyHex = spendingKeyObj.serialize();
      const outputHash = `mempool:${txHash}:${i}`;

      // k*G, the public counterpart of the sender's blinding scalar and the
      // key signOutput's signatures verify against. Distinct from the
      // blindingKey above, which is k*sk_destination.
      let ephemeralKeyHex: string | null = null;
      try {
        ephemeralKeyHex = PublicKey.fromPoint(Point.fromObj(getCTxOutEphemeralKey(ctxOut.obj))).serialize();
      } catch {
        // Older bindings may not expose it; the field stays null.
      }

      await this.storeWalletOutput(
        outputHash, txHash, i, 0, '',
        recoveredAmount, recoveredGamma, recoveredMemo, tokenIdHex,
        blindingKeyHex, spendingKeyHex,
        false, null, null,
        mempoolTxType, mempoolTimestamp, ephemeralKeyHex,
        parsedOutputs[i] !== undefined && isStakedCommitmentOutput(parsedOutputs[i])
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
    } catch {
      // Input processing is best-effort
    }
  }

  /**
   * Store transaction keys for a block
   * @param block - Block transaction keys
   * @param blockHash - Block hash
   * @param keepTxKeys - Whether to keep transaction keys in database after processing
   * @param blockTimestamp - Unix epoch timestamp from the block header
   * @param isPoS - Whether this block is a Proof-of-Stake block
   * @returns Number of transaction keys stored
   */
  private async storeBlockTransactionKeys(
    block: BlockTransactionKeys,
    blockHash: string,
    keepTxKeys: boolean = false,
    blockTimestamp: number = 0,
    isPoS: boolean = false
  ): Promise<number> {
    let count = 0;

    for (const txKeys of block.txKeys) {
      let txHash = txKeys.txHash;
      if (!txHash && txKeys.keys && typeof txKeys.keys === 'object') {
        txHash = (txKeys.keys as any).txHash || (txKeys.keys as any).hash || '';
      }
      if (!txHash) {
        txHash = `block_${block.height}_tx_${count}`;
      }

      if (this.keyManager) {
        await this.processTransactionKeys(txHash, txKeys.keys, block.height, blockHash, blockTimestamp, isPoS);
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
   * @param blockTimestamp - Unix epoch timestamp of the block
   * @param isPoS - Whether this block is a Proof-of-Stake block
   */
  private async processTransactionKeys(
    txHash: string,
    keys: any,
    blockHeight: number,
    _blockHash: string,
    blockTimestamp: number = 0,
    isPoS: boolean = false
  ): Promise<void> {
    if (!this.keyManager) return;

    // Transaction keys structure depends on the provider: ElectrumX delivers
    // [txHash, { vout: [...] }] tuples, the P2P provider delivers
    // { outputs: [...] } objects. Accept both shapes.
    const outputs = keys?.[1]?.outputs || keys?.[1]?.vout || keys?.outputs || keys?.vout || [];

    if (!Array.isArray(outputs)) return;

    // Determine txType by checking if any inputs reference wallet-owned outputs.
    // - If yes and block is PoS: the wallet's stake UTXO was spent as a staking input → 'stake'
    // - If yes and block is not PoS: this is a change output from an outgoing transaction → 'sent'
    // - Otherwise: coins received from an external sender → 'received'
    const txData = keys[1] || keys;
    const inputs: any[] = txData?.inputs || txData?.vin || [];
    let txType: TxType = 'received';
    // Inputs this wallet recognises as spending its own outputs. Collected
    // here rather than short-circuiting because the blinding-key backfill
    // below needs the whole set to pick its canonical anchor.
    const ownInputOutids: string[] = [];
    if (Array.isArray(inputs) && inputs.length > 0) {
      for (const input of inputs) {
        const outputHash = input?.prevoutHash || input?.outputHash || input?.output_hash || input?.prevout?.hash;
        if (outputHash && await this.walletDB.isOutputUnspent(outputHash)) {
          txType = isPoS ? 'stake' : 'sent';
          ownInputOutids.push(outputHash);
        }
      }
    }

    // Derivation anchors for the backfill below: the canonical anchor over the
    // inputs this wallet owns, then every input of the transaction as a
    // fallback. Block aggregation merges other senders' inputs in and
    // navio-core shuffles `vin` before broadcast, so no position is reliable.
    //
    // Only worth trying when this wallet spent into the transaction at all,
    // which is what any txType other than 'received' means — checking for
    // 'sent' alone would miss every transaction that landed in a PoS block,
    // where the same condition is reported as 'stake'.
    const allInputOutids: string[] = inputs
      .map((input) => input?.prevoutHash || input?.outputHash || input?.output_hash || input?.prevout?.hash)
      .filter((hash): hash is string => typeof hash === 'string' && hash.length > 0);
    const anchor = canonicalAnchorOutid(ownInputOutids);
    const candidateOutids: string[] = txType === 'received'
      ? []
      : (anchor === null ? allInputOutids : [anchor, ...allInputOutids]);

    for (let outputIndex = 0; outputIndex < outputs.length; outputIndex++) {
      const outputKeys = outputs[outputIndex];

      // Extract keys from output
      const blindingKey = outputKeys?.blindingKey || outputKeys?.blinding_key;
      const spendingKey = outputKeys?.spendingKey || outputKeys?.spending_key;
      const viewTag = outputKeys?.viewTag ?? outputKeys?.view_tag;
      const outputHash = outputKeys?.outputHash || outputKeys?.output_hash;

      if (!blindingKey || !spendingKey || viewTag === undefined || !outputHash) {
        continue;
      }

      // Convert keys to PublicKey format if needed (they might be hex strings or serialized)
      const PublicKey = blsctModule.PublicKey;
      let blindingKeyObj: any;
      let spendingKeyObj: any;
      let isMine: boolean;
      try {
        blindingKeyObj = PublicKey.deserialize(blindingKey);
        spendingKeyObj = PublicKey.deserialize(spendingKey);
        // Check if output belongs to wallet
        isMine = this.keyManager.isMineByKeys(blindingKeyObj, spendingKeyObj, viewTag);
      } catch {
        // Anyone can broadcast an output whose BLSCT keys are not valid
        // curve points (testnet block 48020 has one). Such an output is
        // spendable by no wallet, so it cannot be ours — skip it instead of
        // letting one malformed output abort the sync loop forever.
        continue;
      }
      if (isMine) {
        let outputHex = '';
        try {
          outputHex = await this.withRetry(() =>
            this.syncProvider.getTransactionOutput(outputHash)
          );
        } catch {
          // Some providers may not expose standalone output serialization.
          // Recovery falls back to parsing the full raw transaction below.
        }

        const recoveredOutput = await this.recoverConfirmedOutput(
          txHash,
          outputIndex,
          blindingKeyObj,
          outputHex
        );

        // The public counterpart of the sender's blinding scalar is the
        // EPHEMERAL key (k*G), not the field called blindingKey, which is
        // k*sk_destination and bound to the recipient. The P2P backend reports
        // it with the other keys; the Electrum key server does not, so fall
        // back to reading it out of the serialized output.
        const ephemeralKey: string | null =
          outputKeys?.ephemeralKey
          || outputKeys?.ephemeral_key
          || (outputHex ? this.extractRangeProofFromOutput(outputHex).ephemeralKeyHex : null)
          || null;

        // Store output as spendable with recovered amount
        await this.storeWalletOutput(
          outputHash,
          txHash,
          outputIndex,
          blockHeight,
          outputHex,
          recoveredOutput.amount,
          recoveredOutput.gamma,
          recoveredOutput.memo,
          recoveredOutput.tokenIdHex,
          blindingKey,
          spendingKey,
          false, // not spent
          null, // spent_tx_hash
          null, // spent_block_height
          txType,
          blockTimestamp,
          ephemeralKey,
          isStakedCommitmentOutputHex(outputHex)
        );

        if (candidateOutids.length > 0 && ephemeralKey) {
          await this.backfillBlindingKey(outputHash, candidateOutids, ephemeralKey);
        }
      }
    }
  }

  /**
   * Populate the stored blinding scalar for an output this wallet both created
   * and can see — its own change, in practice.
   *
   * `recoverBlindingKey` derives on demand and does not need this, but filling
   * the table during sync restores the fast path after a wallet is rebuilt
   * from its mnemonic and re-scanned. Only attempted for transactions this
   * wallet spent into, which bounds the work to our own outgoing transactions.
   *
   * Entirely best-effort: a failure here must never interrupt a sync.
   *
   * @param outputHash - Output hash, display hex
   * @param candidateOutids - Anchors to try: the canonical one first, then
   *   every input of the containing transaction
   * @param ephemeralKey - The output's ephemeral key (k*G), hex
   */
  private async backfillBlindingKey(
    outputHash: string,
    candidateOutids: string[],
    ephemeralKey: string,
  ): Promise<void> {
    try {
      if (!this.keyManager || !this.keyManager.isUnlocked()) return;
      if (await this.walletDB.getOutputBlindingKey(outputHash)) return;

      const match = searchBlindingKey(this.keyManager.getMasterSeedKey(), candidateOutids, ephemeralKey);
      if (match) {
        await this.walletDB.saveOutputBlindingKey(
          outputHash,
          match.scalar.serialize().padStart(64, '0'),
        );
      }
    } catch {
      // Not ours, no seed, or a malformed key: nothing to store.
    }
  }

  private async recoverConfirmedOutput(
    txHash: string,
    outputIndex: number,
    blindingKeyObj: any,
    outputHex: string
  ): Promise<{ amount: number; gamma: string; memo: string | null; tokenIdHex: string | null }> {
    // Fast path: hand-parse the serialized output. This reliably recovers
    // plain (NAV) outputs, but the parser mis-handles token/predicate outputs
    // — their range proof sits behind a variable predicate layout — so it can
    // return amount 0 for a token that actually holds a balance. A zero here
    // is therefore inconclusive: fall through and confirm with the binding's
    // full-transaction parser, which understands every output shape. A
    // positive amount is always trustworthy and returned immediately.
    const fastRecovery = this.tryRecoverFromSerializedOutput(outputHex, blindingKeyObj);
    if (fastRecovery !== null && fastRecovery.amount > 0) {
      return fastRecovery;
    }

    const rawTx = await this.withRetry(() => this.syncProvider.getRawTransaction(txHash));
    if (typeof rawTx === 'string') {
      const rawRecovery = this.tryRecoverFromRawTransaction(rawTx, outputIndex, blindingKeyObj);
      if (rawRecovery !== null && rawRecovery.amount > 0) {
        return rawRecovery;
      }
    }

    // Neither path found a positive amount — return the fast result if we had
    // one (a genuine zero-value output), else zero.
    return fastRecovery ?? {
      amount: 0,
      gamma: '0',
      memo: null,
      tokenIdHex: null,
    };
  }

  private tryRecoverFromSerializedOutput(
    outputHex: string,
    blindingKeyObj: any
  ): { amount: number; gamma: string; memo: string | null; tokenIdHex: string | null } | null {
    if (!outputHex) {
      return null;
    }

    const RangeProof = blsctModule.RangeProof;
    const AmountRecoveryReq = blsctModule.AmountRecoveryReq;

    try {
      const nonce = this.keyManager!.calculateNonce(blindingKeyObj);
      const rangeProofResult = this.extractRangeProofFromOutput(outputHex);
      const tokenIdHex = rangeProofResult.tokenIdHex;

      // Token/NFT mint outputs carry their amount as a transparent value, not
      // in the range proof (which commits to 0). Use it directly — recovering
      // from the proof would read the amount as 0. Transparent amounts have no
      // blinding factor, so gamma is 0.
      if (rangeProofResult.transparentValue !== null && rangeProofResult.transparentValue > 0n) {
        return {
          amount: Number(rangeProofResult.transparentValue),
          gamma: '0',
          memo: null,
          tokenIdHex,
        };
      }

      if (!rangeProofResult.rangeProofHex
          || rangeProofResult.rangeProofHex === EMPTY_RANGE_PROOF_HEX) {
        // No proof (or the empty proof) — nothing to recover, and
        // recoverAmounts on an empty proof aborts the process.
        return {
          amount: 0,
          gamma: '0',
          memo: null,
          tokenIdHex,
        };
      }

      const rangeProof = RangeProof.deserialize(rangeProofResult.rangeProofHex);
      const tokenId = tokenIdHex
        ? blsctModule.TokenId.deserialize(tokenIdHex)
        : blsctModule.TokenId.default();

      const req = new AmountRecoveryReq(rangeProof, nonce, tokenId);
      const results = RangeProof.recoverAmounts([req]);

      if (results.length > 0 && results[0].isSucc) {
        return {
          amount: Number(results[0].amount),
          gamma: results[0].gamma ?? '0',
          memo: results[0].msg || null,
          tokenIdHex,
        };
      }
    } catch {
      // Fall through to raw-transaction recovery.
    }

    return null;
  }

  private tryRecoverFromRawTransaction(
    rawTx: string,
    outputIndex: number,
    blindingKeyObj: any
  ): { amount: number; gamma: string; memo: string | null; tokenIdHex: string | null } | null {
    const { CTx, RangeProof, AmountRecoveryReq } = blsctModule as any;

    try {
      const ctx = CTx.deserialize(rawTx);
      const outs = ctx.getCTxOuts();
      if (outputIndex < 0 || outputIndex >= outs.size()) {
        return null;
      }

      const ctxOut = outs.at(outputIndex);
      const nonce = this.keyManager!.calculateNonce(blindingKeyObj);
      const tokenId = ctxOut.getTokenId();
      const tokenIdHex = tokenId.serialize();
      const rangeProof = ctxOut.getRangeProof();

      if (rangeProof.serialize() === EMPTY_RANGE_PROOF_HEX) {
        // Mint outputs carry a transparent value and no range proof; calling
        // recoverAmounts on an empty proof aborts the process.
        return {
          amount: Number(ctxOut.getValue()),
          gamma: '0',
          memo: null,
          tokenIdHex,
        };
      }

      const req = new AmountRecoveryReq(rangeProof, nonce, tokenId);
      const results = RangeProof.recoverAmounts([req]);

      if (results.length > 0 && results[0].isSucc) {
        return {
          amount: Number(results[0].amount),
          gamma: results[0].gamma ?? '0',
          memo: results[0].msg || null,
          tokenIdHex,
        };
      }

      return {
        amount: 0,
        gamma: '0',
        memo: null,
        tokenIdHex,
      };
    } catch {
      return null;
    }
  }

  /**
   * Extract the fields amount recovery needs from a serialized CTxOut, with
   * the same parser the P2P path uses. All null when it does not parse.
   * @param outputHex - Serialized output data (hex)
   */
  private extractRangeProofFromOutput(outputHex: string): {
    rangeProofHex: string | null;
    tokenIdHex: string | null;
    transparentValue: bigint | null;
    ephemeralKeyHex: string | null;
  } {
    try {
      const output = parseOutputHex(outputHex);
      return {
        rangeProofHex: output.rangeProofHex,
        tokenIdHex: output.tokenIdHex,
        transparentValue: output.transparentValue,
        ephemeralKeyHex: output.keys?.ephemeralKey ?? null,
      };
    } catch {
      return { rangeProofHex: null, tokenIdHex: null, transparentValue: null, ephemeralKeyHex: null };
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
    spentBlockHeight: number | null,
    txType: TxType = 'received',
    timestamp: number = 0,
    ephemeralKey: string | null = null,
    isStakedCommitment: boolean = false
  ): Promise<void> {
    // Normalize the NAV token id to null at the single write choke point.
    // TokenId.serialize() renders NAV as 64 zero chars + the ffff… no-subid
    // marker; rows stored in that form fail the databases' NAV balance
    // filters (which match null / the 64-zero hash), making the wallet's own
    // unconfirmed change invisible until the next block ("balance shows 0
    // after minting/sending").
    const normalizedTokenId = tokenId !== null && NAV_TOKEN_ID_HEX_FORMS.has(tokenId.toLowerCase())
      ? null
      : tokenId;
    await this.walletDB.storeWalletOutput({
      outputHash, txHash, outputIndex, blockHeight, outputData,
      amount, gamma, memo, tokenId: normalizedTokenId, blindingKey, ephemeralKey, spendingKey,
      isSpent, spentTxHash, spentBlockHeight, txType, timestamp, isStakedCommitment,
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
