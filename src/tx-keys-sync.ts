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
 * Thrown by sync() when the server's data does not match the hash it is
 * served under: an output whose serialization does not hash to its output
 * hash or whose keys differ from the keys the server listed for it, or a
 * transaction that does not hash to its id. Without the check a malicious or
 * broken server could make the wallet record any amount it liked.
 *
 * Nothing from the failing batch is committed: the sync state stays at the
 * last good batch, so the next sync retries from there (against a server
 * that answers correctly).
 */
export class SyncVerificationError extends Error {
  constructor(message: string) {
    super(`Server returned inconsistent data: ${message}`);
    this.name = 'SyncVerificationError';
  }
}

/**
 * How many times one sync() call restarts a pass after the chain changed
 * between fetching a batch's keys and its headers, before giving up.
 */
const MAX_SYNC_RESTARTS = 3;

/**
 * The chain changed under a sync pass: the keys and the headers of a batch
 * may come from different branches. Internal; sync() restarts the pass.
 */
class ChainChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainChangedError';
  }
}

/**
 * What sync expects of an output it found to be the wallet's: the output
 * hash and keys from the block's tx keys (lowercase hex).
 */
interface ExpectedOutputKeys {
  outputHash: string;
  blindingKey: string;
  spendingKey: string;
  viewTag: number;
  /** Only the P2P provider lists it */
  ephemeralKey: string | null;
}

/** Counters carried across the passes of one sync() call. */
interface SyncPassProgress {
  blocksProcessed: number;
  txKeysSynced: number;
}

/**
 * Mark a promise that may never be awaited (a prefetch) as observed, so its
 * rejection cannot crash Node as an unhandled rejection. Returns the same
 * promise: awaiting it still throws.
 */
function observed<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

/** Display-hex double SHA-256, as block, transaction and output hashes are shown. */
function hash256Display(data: Uint8Array): string {
  return Buffer.from(sha256(sha256(data))).reverse().toString('hex');
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
  /** Tail of the queue that serializes sync() calls; never rejects. */
  private syncQueue: Promise<void> = Promise.resolve();

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
   * Synchronize transaction keys from the sync provider.
   *
   * Calls are serialized: a sync() made while another is running (for
   * example `client.sync()` during a background sync) waits for that one to
   * finish and then runs with its own options.
   *
   * @param options - Sync options
   * @returns Number of transaction keys synced
   * @throws SyncVerificationError if the server's data does not hash to what
   *   it claims; the batch holding it is not committed
   */
  sync(options: SyncOptions = {}): Promise<number> {
    const run = this.syncQueue.then(() => this.runSync(options));
    // The queue only orders runs; each caller sees its own result.
    this.syncQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * One serialized sync() call: sync passes, restarted when the chain changes
   * under a pass (at most {@link MAX_SYNC_RESTARTS} times).
   */
  private async runSync(options: SyncOptions): Promise<number> {
    if (!this.keyManager) {
      await this.initialize();
    }

    // Update retention setting
    this.blockHashRetention = options.blockHashRetention ?? 10000;

    const progress: SyncPassProgress = { blocksProcessed: 0, txKeysSynced: 0 };
    let startHeight = options.startHeight;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.syncPass({ ...options, startHeight }, progress);
        return progress.txKeysSynced;
      } catch (error) {
        if (!(error instanceof ChainChangedError)) {
          throw error;
        }
        if (attempt >= MAX_SYNC_RESTARTS) {
          throw new Error(
            `The chain kept changing during sync (${error.message}); ` +
              `gave up after ${MAX_SYNC_RESTARTS + 1} attempts. Nothing past height ` +
              `${this.getLastSyncedHeight()} was stored; sync again later.`
          );
        }
        // Batches already committed stay; the next pass checks them for a
        // reorg and continues after the last one.
        if (progress.blocksProcessed > 0) {
          startHeight = undefined;
        }
      }
    }
  }

  /**
   * One pass from the start height to the chain tip seen when it began.
   *
   * Before anything else is fetched it records the hash of the block at the
   * end height (the anchor). Every batch is checked against it after its keys
   * and headers arrived: while the anchor block is unchanged, so is every
   * block below it, so the keys, the headers and the reorg check all describe
   * one chain. A changed anchor (or a provider block hash that differs from
   * the header) throws ChainChangedError before the batch is stored.
   */
  private async syncPass(options: SyncOptions, progress: SyncPassProgress): Promise<void> {
    const {
      startHeight,
      endHeight,
      onProgress,
      stopOnReorg = false,
      verifyHashes = true,
      saveInterval = 100,
      keepTxKeys = false,
    } = options;

    const chainTip = await this.syncProvider.getChainTipHeight();
    // Blocks past the tip seen here are left for the next sync: the anchor
    // below does not cover them.
    const syncEndHeight = Math.min(endHeight ?? chainTip, chainTip);

    const anchor =
      verifyHashes && syncEndHeight >= 0
        ? { height: syncEndHeight, hash: await this.fetchBlockHash(syncEndHeight) }
        : null;

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
      return; // Already synced
    }

    let currentHeight = syncStartHeight;
    let lastSaveHeight = syncStartHeight - 1;

    // Pipeline: prefetch the next batch of tx keys while processing the
    // current batch, eliminating the ~2s pause between batches. The first
    // batch is fetched inside the loop; subsequent batches are prefetched as
    // soon as the current one arrives so the download overlaps with
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
      // downloads in parallel with our processing of the current batch. This
      // batch can still throw before the prefetch is awaited, so a rejection
      // must not go unobserved (Node exits on an unhandled rejection).
      if (nextBatchHeight <= syncEndHeight) {
        pendingRangePromise = observed(
          this.syncProvider.getBlockTransactionKeysRange(nextBatchHeight)
        );
      }

      // All headers of the batch, fetched after its keys so that the anchor
      // check below covers both.
      const headers = await this.fetchHeaderRange(firstHeight, lastHeight);
      if (anchor) {
        await this.verifyBatchChain(blocksToProcess, headers, anchor);
      }

      let lastBlockHash = '';
      for (let blockIdx = 0; blockIdx < blocksToProcess.length; blockIdx++) {
        const block = blocksToProcess[blockIdx];

        // Yield to the event loop periodically so the browser can repaint
        // and handle user input, preventing UI freezes during long syncs.
        if (blockIdx > 0 && blockIdx % YIELD_EVERY_N_BLOCKS === 0) {
          await yieldToMainThread();
        }

        const headerHex = headers.get(block.height);
        if (!headerHex) {
          throw new Error(`Server returned no header for block ${block.height}`);
        }
        const blockHash = this.extractBlockHash(headerHex);
        lastBlockHash = blockHash;

        // Extract block timestamp and PoS flag from the 80-byte header
        let blockTimestamp = 0;
        let isPoS = false;
        if (headerHex.length >= 160) {
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

        progress.txKeysSynced += txKeysCount;
        progress.blocksProcessed++;

        if (onProgress) {
          onProgress(block.height, syncEndHeight, progress.blocksProcessed, progress.txKeysSynced, false);
        }
      }

      // Update sync state after processing batch (lastBlockHash was set in the loop)
      await this.updateSyncState({
        lastSyncedHeight: lastHeight,
        lastSyncedHash: lastBlockHash,
        totalTxKeysSynced: (this.syncState?.totalTxKeysSynced ?? 0) + progress.txKeysSynced,
        lastSyncTime: Date.now(),
        chainTipAtLastSync: chainTip,
      });

      if (saveInterval > 0 && lastHeight - lastSaveHeight >= saveInterval) {
        await this.walletDB.saveDatabase();
        lastSaveHeight = lastHeight;
      }

      currentHeight = nextBatchHeight;
    }

    // Final save after sync completes to ensure state is persisted
    await this.walletDB.saveDatabase();
  }

  /**
   * Check that a batch's keys and headers describe the chain the pass
   * started on: each block hash the provider reported matches the header at
   * its height, and the anchor block is still the server's block at the
   * anchor height.
   * @throws ChainChangedError on any mismatch
   */
  private async verifyBatchChain(
    blocks: BlockTransactionKeys[],
    headers: Map<number, string>,
    anchor: { height: number; hash: string }
  ): Promise<void> {
    for (const block of blocks) {
      const headerHex = headers.get(block.height);
      if (block.hash && headerHex) {
        const headerHash = this.extractBlockHash(headerHex);
        if (block.hash.toLowerCase() !== headerHash) {
          throw new ChainChangedError(
            `block ${block.height}: keys are from ${block.hash}, header is ${headerHash}`
          );
        }
      }
    }
    const anchorHash = await this.fetchBlockHash(anchor.height);
    if (anchorHash !== anchor.hash) {
      throw new ChainChangedError(
        `block ${anchor.height} changed from ${anchor.hash} to ${anchorHash}`
      );
    }
  }

  /** Hash of the server's block at `height`. */
  private async fetchBlockHash(height: number): Promise<string> {
    return this.extractBlockHash(
      await this.withRetry(() => this.syncProvider.getBlockHeader(height))
    );
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
        // The keys isMine accepted; whatever the server serves for this
        // output must carry exactly these.
        const expectedKeys: ExpectedOutputKeys = {
          outputHash: String(outputHash).toLowerCase(),
          blindingKey: String(blindingKey).toLowerCase(),
          spendingKey: String(spendingKey).toLowerCase(),
          viewTag: Number(viewTag),
          ephemeralKey: outputKeys?.ephemeralKey || outputKeys?.ephemeral_key || null,
        };

        let outputHex = '';
        try {
          outputHex = await this.withRetry(() =>
            this.syncProvider.getTransactionOutput(outputHash)
          );
        } catch {
          // Some providers may not expose standalone output serialization.
          // Recovery falls back to parsing the full raw transaction below.
        }
        if (outputHex) {
          this.verifyServedOutput(outputHex, expectedKeys, `output ${outputHash}`);
        }

        const recoveredOutput = await this.recoverConfirmedOutput(
          txHash,
          blindingKeyObj,
          outputHex,
          expectedKeys
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

  /**
   * Check a serialized output the server returned: it must hash to the
   * output hash it was requested by, parse, and carry the keys the wallet's
   * ownership check used.
   * @param outputHex - Serialized CTxOut (hex)
   * @param expected - The output hash and keys from the block's tx keys
   * @param what - What the output is, for the error message
   * @returns The parsed output
   * @throws SyncVerificationError on any mismatch
   */
  private verifyServedOutput(
    outputHex: string,
    expected: ExpectedOutputKeys,
    what: string
  ): ParsedOutput {
    if (outputHex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(outputHex)) {
      throw new SyncVerificationError(`${what} is not hex`);
    }
    const actualHash = hash256Display(Buffer.from(outputHex, 'hex'));
    if (actualHash !== expected.outputHash) {
      throw new SyncVerificationError(`${what} hashes to ${actualHash}`);
    }
    let parsed: ParsedOutput;
    try {
      parsed = parseOutputHex(outputHex);
    } catch (error) {
      throw new SyncVerificationError(`${what} does not parse: ${(error as Error).message}`);
    }
    this.checkOutputKeys(parsed, expected, what);
    return parsed;
  }

  /**
   * Check that a parsed output carries the keys the wallet's ownership check
   * used.
   * @throws SyncVerificationError on any difference
   */
  private checkOutputKeys(parsed: ParsedOutput, expected: ExpectedOutputKeys, what: string): void {
    const keys = parsed.keys;
    if (!keys) {
      throw new SyncVerificationError(`${what} carries no BLSCT keys`);
    }
    const mismatched: string[] = [];
    if (keys.blindingKey !== expected.blindingKey) mismatched.push('blinding key');
    if (keys.spendingKey !== expected.spendingKey) mismatched.push('spending key');
    if (keys.viewTag !== expected.viewTag) mismatched.push('view tag');
    if (expected.ephemeralKey && keys.ephemeralKey !== expected.ephemeralKey.toLowerCase()) {
      mismatched.push('ephemeral key');
    }
    if (mismatched.length > 0) {
      throw new SyncVerificationError(
        `${what} does not carry the keys listed for it (${mismatched.join(', ')} differ)`
      );
    }
  }

  /**
   * Fetch the raw transaction holding an output and check it: it must hash
   * to `txHash` and contain the output, with the expected keys.
   * @returns The raw transaction and the output's index in it, or null when
   *   the provider returns no hex
   * @throws SyncVerificationError on any mismatch
   */
  private async fetchVerifiedRawTransaction(
    txHash: string,
    expected: ExpectedOutputKeys
  ): Promise<{ rawTx: string; outputIndex: number } | null> {
    const rawTx = await this.withRetry(() => this.syncProvider.getRawTransaction(txHash));
    if (typeof rawTx !== 'string') {
      return null;
    }
    let parsed: ReturnType<typeof parseTransaction>;
    try {
      const bytes = Buffer.from(rawTx, 'hex');
      parsed = parseTransaction(bytes);
      if (parsed.end !== bytes.length || bytes.length * 2 !== rawTx.length) {
        throw new Error('trailing data');
      }
    } catch (error) {
      throw new SyncVerificationError(
        `transaction ${txHash} does not parse: ${(error as Error).message}`
      );
    }
    const wanted = txHash.toLowerCase();
    if (parsed.txid !== wanted && parsed.wtxid !== wanted) {
      throw new SyncVerificationError(`transaction ${txHash} hashes to ${parsed.txid}`);
    }
    const output = parsed.outputs.find((o) => o.outputHash === expected.outputHash);
    if (!output) {
      throw new SyncVerificationError(
        `transaction ${txHash} does not contain output ${expected.outputHash}`
      );
    }
    this.checkOutputKeys(output, expected, `output ${expected.outputHash} of transaction ${txHash}`);
    return { rawTx, outputIndex: output.index };
  }

  private async recoverConfirmedOutput(
    txHash: string,
    blindingKeyObj: any,
    outputHex: string,
    expected: ExpectedOutputKeys
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

    // The output is located by its hash rather than by position: the key
    // lists of both providers skip outputs, so a list index need not be the
    // output's index in the transaction.
    const verified = await this.fetchVerifiedRawTransaction(txHash, expected);
    if (verified) {
      const rawRecovery = this.tryRecoverFromRawTransaction(
        verified.rawTx,
        verified.outputIndex,
        blindingKeyObj
      );
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
   * Fetch the headers of heights `firstHeight`..`lastHeight` as a map of
   * height -> header hex, in concurrent chunks of HEADER_CHUNK_SIZE.
   */
  private async fetchHeaderRange(
    firstHeight: number,
    lastHeight: number
  ): Promise<Map<number, string>> {
    const CS = TransactionKeysSync.HEADER_CHUNK_SIZE;
    const chunks: Promise<Map<number, string>>[] = [];
    for (let start = firstHeight; start <= lastHeight; start += CS) {
      chunks.push(this.fetchHeaderChunk(start, Math.min(CS, lastHeight - start + 1)));
    }
    const map = new Map<number, string>();
    for (const chunk of await Promise.all(chunks)) {
      for (const [height, hex] of chunk) map.set(height, hex);
    }
    return map;
  }

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
