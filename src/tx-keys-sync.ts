/**
 * Transaction Keys Sync Module
 * 
 * Synchronizes transaction keys from Electrum server to wallet database
 * - Tracks sync progress and resumes from last state
 * - Handles block reorganizations
 * - Persists sync state in wallet database
 */

import { ElectrumClient } from './electrum';
import { WalletDB } from './wallet-db';
import { KeyManager } from './key-manager';
import type { BlockTransactionKeys, TransactionKeys } from './electrum';

/**
 * Sync state stored in database
 */
export interface SyncState {
  /** Last synced block height */
  lastSyncedHeight: number;
  /** Last synced block hash */
  lastSyncedHash: string;
  /** Total transaction keys synced */
  totalTxKeysSynced: number;
  /** Last sync timestamp */
  lastSyncTime: number;
  /** Chain tip at last sync */
  chainTipAtLastSync: number;
}

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
 */
export class TransactionKeysSync {
  private walletDB: WalletDB;
  private electrumClient: ElectrumClient;
  private keyManager: KeyManager | null = null;
  private syncState: SyncState | null = null;
  private blockHashRetention: number = 10000; // Keep last 10k block hashes by default

  constructor(walletDB: WalletDB, electrumClient: ElectrumClient) {
    this.walletDB = walletDB;
    this.electrumClient = electrumClient;
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
    // Ensure database is initialized
    // Try to load wallet (will initialize DB if needed)
    try {
      this.keyManager = await this.walletDB.loadWallet();
    } catch {
      // If wallet doesn't exist, create it
      this.keyManager = await this.walletDB.createWallet();
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

    const chainTip = await this.electrumClient.getChainTipHeight();
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
      blockHashRetention = 1000,
    } = options;

    // Update retention setting
    this.blockHashRetention = blockHashRetention;

    // Determine start and end heights
    const lastSynced = this.syncState?.lastSyncedHeight ?? -1;
    const syncStartHeight = startHeight ?? lastSynced + 1;
    const chainTip = await this.electrumClient.getChainTipHeight();
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

    // Sync in batches - server will return as many blocks as fit in max_send
    // We keep fetching until we reach the end height
    while (currentHeight <= syncEndHeight) {
      // Fetch transaction keys - server will return maximum possible blocks
      const rangeResult = await this.electrumClient.getBlockTransactionKeysRange(currentHeight);

      // Batch fetch all block headers for this batch
      const blockHeights = rangeResult.blocks
        .filter(block => block.height <= syncEndHeight)
        .map(block => block.height);
      
      let blockHeadersMap: Map<number, string> = new Map();
      if (blockHeights.length > 0 && verifyHashes) {
        // Fetch headers in batch using getBlockHeaders
        const firstHeight = blockHeights[0];
        const count = blockHeights.length;
        const headersResult = await this.electrumClient.getBlockHeaders(firstHeight, count);
        
        // Parse concatenated hex string - each header is 80 bytes (160 hex chars)
        const headerSize = 160; // 80 bytes * 2 hex chars per byte
        const hex = headersResult.hex;
        
        // Map headers by height
        for (let i = 0; i < count && i * headerSize < hex.length; i++) {
          const height = firstHeight + i;
          const headerStart = i * headerSize;
          const headerEnd = headerStart + headerSize;
          const headerHex = hex.substring(headerStart, headerEnd);
          blockHeadersMap.set(height, headerHex);
        }
      }

      // Process each block in the batch
      for (const block of rangeResult.blocks) {
        if (block.height > syncEndHeight) {
          break;
        }

        // Get block header and hash (from batch or fetch individually if not verifying)
        let blockHash: string;
        if (verifyHashes && blockHeadersMap.has(block.height)) {
          const blockHeader = blockHeadersMap.get(block.height)!;
          blockHash = this.extractBlockHash(blockHeader);
        } else if (verifyHashes) {
          // Fallback: fetch individual header if not in batch
          const blockHeader = await this.electrumClient.getBlockHeader(block.height);
          blockHash = this.extractBlockHash(blockHeader);
        } else {
          // If not verifying, we can skip header fetch for now
          // But we still need a hash for storage - use a placeholder or fetch minimal
          // For now, let's fetch it but this could be optimized further
          const blockHeader = await this.electrumClient.getBlockHeader(block.height);
          blockHash = this.extractBlockHash(blockHeader);
        }
        
        // Verify block hash if requested
        if (verifyHashes) {
          // Store block hash for future verification (pass chainTip to avoid repeated fetches)
          await this.storeBlockHash(block.height, blockHash, chainTip);
          
          // Check for reorganization
          if (this.syncState && block.height <= this.syncState.lastSyncedHeight) {
            const storedHash = await this.getStoredBlockHash(block.height);
            if (storedHash && storedHash !== blockHash) {
              // Reorganization detected
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
          // Still store block hash even if not verifying (pass chainTip to avoid repeated fetches)
          await this.storeBlockHash(block.height, blockHash, chainTip);
        }

        // Store transaction keys for this block
        const txKeysCount = await this.storeBlockTransactionKeys(block, blockHash, keepTxKeys);
        
        // Check for spent outputs in this block's transactions
        if (this.keyManager) {
          await this.processBlockForSpentOutputs(block, blockHash);
        }
        
        totalTxKeysSynced += txKeysCount;
        blocksProcessed++;

        // Progress callback
        if (onProgress) {
          onProgress(block.height, syncEndHeight, blocksProcessed, totalTxKeysSynced, false);
        }
      }

      // Update sync state after processing batch
      if (rangeResult.blocks.length > 0) {
        const lastBlock = rangeResult.blocks[rangeResult.blocks.length - 1];
        let lastBlockHash: string;
        
        if (blockHeadersMap.has(lastBlock.height)) {
          const lastBlockHeader = blockHeadersMap.get(lastBlock.height)!;
          lastBlockHash = this.extractBlockHash(lastBlockHeader);
        } else {
          // Fallback: fetch if not in batch
          const lastBlockHeader = await this.electrumClient.getBlockHeader(lastBlock.height);
          lastBlockHash = this.extractBlockHash(lastBlockHeader);
        }
        
        await this.updateSyncState({
          lastSyncedHeight: lastBlock.height,
          lastSyncedHash: lastBlockHash,
          totalTxKeysSynced: (this.syncState?.totalTxKeysSynced ?? 0) + totalTxKeysSynced,
          lastSyncTime: Date.now(),
          chainTipAtLastSync: chainTip,
        });
        
        // Save database periodically if saveInterval is set
        if (saveInterval > 0 && (lastBlock.height - lastSaveHeight) >= saveInterval) {
          await this.walletDB.saveDatabase();
          lastSaveHeight = lastBlock.height;
        }
      }

      // Move to next batch (server tells us where to continue)
      currentHeight = rangeResult.nextHeight;
      
      // Safety check to prevent infinite loops
      if (currentHeight <= rangeResult.blocks[rangeResult.blocks.length - 1]?.height) {
        throw new Error(`Server did not advance next_height properly. Current: ${currentHeight}, Last block: ${rangeResult.blocks[rangeResult.blocks.length - 1]?.height}`);
      }
    }

    // Final save after sync completes to ensure state is persisted
    await this.walletDB.saveDatabase();

    return totalTxKeysSynced;
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
    const currentHeader = await this.electrumClient.getBlockHeader(height);
    const currentHash = this.extractBlockHash(currentHeader);

    // Get stored block hash
    const storedHash = await this.getStoredBlockHash(height);

    if (storedHash && storedHash !== currentHash) {
      // Reorganization detected - find common ancestor
      let commonHeight = height - 1;
      while (commonHeight >= 0) {
        const commonHeader = await this.electrumClient.getBlockHeader(commonHeight);
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
    console.log(`Handling reorganization: reverting ${reorgInfo.blocksToRevert} blocks from height ${reorgInfo.height}`);

    // Revert blocks in database
    const revertHeight = reorgInfo.height + reorgInfo.blocksToRevert - 1;
    await this.revertBlocks(reorgInfo.height, revertHeight);

    // Update sync state
    await this.updateSyncState({
      lastSyncedHeight: reorgInfo.height - 1,
      lastSyncedHash: await this.getStoredBlockHash(reorgInfo.height - 1) || '',
      totalTxKeysSynced: this.syncState?.totalTxKeysSynced ?? 0,
      lastSyncTime: Date.now(),
      chainTipAtLastSync: await this.electrumClient.getChainTipHeight(),
    });
  }

  /**
   * Process block transactions to detect spent outputs
   * @param block - Block transaction keys
   * @param _blockHash - Block hash (for reference)
   */
  private async processBlockForSpentOutputs(block: BlockTransactionKeys, _blockHash: string): Promise<void> {
    for (const txKeys of block.txKeys) {
      const txHash = txKeys.txHash || '';
      if (!txHash) {
        continue;
      }

      // Transaction keys structure may contain inputs
      // Inputs reference outputs by outputHash
      const keys = txKeys.keys || {};
      const inputs = keys?.inputs || keys?.vin || [];

      if (Array.isArray(inputs)) {
        for (const input of inputs) {
          const outputHash = input?.outputHash || input?.output_hash || input?.prevout?.hash;
          
          if (outputHash) {
            // Check if we own this output
            const db = this.walletDB.getDatabase();
            const stmt = db.prepare('SELECT output_hash FROM wallet_outputs WHERE output_hash = ? AND is_spent = 0');
            stmt.bind([outputHash]);
            
            if (stmt.step()) {
              // We own this output, mark it as spent
              const updateStmt = db.prepare(
                `UPDATE wallet_outputs 
                 SET is_spent = 1, spent_tx_hash = ?, spent_block_height = ?
                 WHERE output_hash = ?`
              );
              updateStmt.run([txHash, block.height, outputHash]);
              updateStmt.free();
            }
            
            stmt.free();
          }
        }
      }
    }
  }

  /**
   * Revert blocks from database
   * @param startHeight - Start height to revert from
   * @param endHeight - End height to revert to
   */
  private async revertBlocks(startHeight: number, endHeight: number): Promise<void> {
    // Delete transaction keys for reverted blocks
    const db = this.walletDB.getDatabase();

    for (let height = startHeight; height <= endHeight; height++) {
      // Delete transaction keys for this block
      const stmt = db.prepare('DELETE FROM tx_keys WHERE block_height = ?');
      stmt.run([height]);
      stmt.free();
      
      // Revert wallet outputs: delete outputs created in this block and unspend outputs spent in this block
      // Delete outputs created in this block
      const deleteOutputsStmt = db.prepare('DELETE FROM wallet_outputs WHERE block_height = ?');
      deleteOutputsStmt.run([height]);
      deleteOutputsStmt.free();
      
      // Unspend outputs that were spent in this block
      const unspendStmt = db.prepare(
        `UPDATE wallet_outputs 
         SET is_spent = 0, spent_tx_hash = NULL, spent_block_height = NULL
         WHERE spent_block_height = ?`
      );
      unspendStmt.run([height]);
      unspendStmt.free();

      // Delete block hash
      const hashStmt = db.prepare('DELETE FROM block_hashes WHERE height = ?');
      hashStmt.run([height]);
      hashStmt.free();
    }
  }

  /**
   * Store transaction keys for a block
   * @param block - Block transaction keys
   * @param blockHash - Block hash
   * @param keepTxKeys - Whether to keep transaction keys in database after processing
   * @returns Number of transaction keys stored
   */
  private async storeBlockTransactionKeys(block: BlockTransactionKeys, blockHash: string, keepTxKeys: boolean = false): Promise<number> {
    const db = this.walletDB.getDatabase();

    let count = 0;

    for (const txKeys of block.txKeys) {
      // Extract txHash from keys if not provided
      // The keys structure from electrumx may contain the tx hash
      let txHash = txKeys.txHash;
      if (!txHash && txKeys.keys && typeof txKeys.keys === 'object') {
        // Try to extract hash from keys object
        txHash = (txKeys.keys as any).txHash || (txKeys.keys as any).hash || '';
      }
      
      // If still no hash, generate a placeholder (shouldn't happen in production)
      if (!txHash) {
        txHash = `block_${block.height}_tx_${count}`;
      }

      // Process outputs if KeyManager is available (before storing keys)
      if (this.keyManager) {
        await this.processTransactionKeys(txHash, txKeys.keys, block.height, blockHash);
      }

      // Store transaction keys only if keepTxKeys is true
      // After processing, we don't need them anymore - wallet outputs are stored separately
      if (keepTxKeys) {
        const stmt = db.prepare(
          'INSERT OR REPLACE INTO tx_keys (tx_hash, block_height, keys_data) VALUES (?, ?, ?)'
        );
        stmt.run([
          txHash,
          block.height,
          JSON.stringify(txKeys.keys),
        ]);
        stmt.free();
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
      return;
    }

    // Transaction keys structure: { outputs: [{ blindingKey, spendingKey, viewTag, outputHash, ... }, ...] }
    // The exact structure depends on electrumx implementation
    const outputs = keys[1]?.outputs || keys[1]?.vout || [];
    
    if (!Array.isArray(outputs)) {
      return;
    }

    for (let outputIndex = 0; outputIndex < outputs.length; outputIndex++) {
      const outputKeys = outputs[outputIndex];
      
      // Extract keys from output
      const blindingKey = outputKeys?.blindingKey || outputKeys?.blinding_key;
      const spendingKey = outputKeys?.spendingKey || outputKeys?.spending_key;
      const viewTag = outputKeys?.viewTag ?? outputKeys?.view_tag;
      const outputHash = outputKeys?.outputHash || outputKeys?.output_hash;

      if (!blindingKey || !spendingKey || viewTag === undefined || !outputHash) {
        console.warn(`Invalid output keys: blindingKey: ${blindingKey}, spendingKey: ${spendingKey}, viewTag: ${viewTag}, outputHash: ${outputHash}, blockHeight: ${blockHeight}`);
        continue;
      }

      // Convert keys to PublicKey format if needed (they might be hex strings or serialized)
      const { PublicKey } = require('navio-blsct');
      let blindingKeyObj: any = PublicKey.deserialize(blindingKey); 
      let spendingKeyObj: any = PublicKey.deserialize(spendingKey);

      // Check if output belongs to wallet
      const isMine = this.keyManager.isMineByKeys(blindingKeyObj, spendingKeyObj, viewTag);
      if (isMine) {
        // Fetch output from Electrum server
        try {
          const outputHex = await this.electrumClient.getTransactionOutput(outputHash);
          
          // Store output as spendable
          await this.storeWalletOutput(
            outputHash,
            txHash,
            outputIndex,
            blockHeight,
            outputHex,
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
   * Store wallet output in database
   * @param outputHash - Output hash
   * @param txHash - Transaction hash
   * @param outputIndex - Output index
   * @param blockHeight - Block height
   * @param outputData - Serialized output data (hex)
   * @param isSpent - Whether output is spent
   * @param spentTxHash - Transaction hash that spent this output (if spent)
   * @param spentBlockHeight - Block height where output was spent (if spent)
   */
  private async storeWalletOutput(
    outputHash: string,
    txHash: string,
    outputIndex: number,
    blockHeight: number,
    outputData: string,
    isSpent: boolean,
    spentTxHash: string | null,
    spentBlockHeight: number | null
  ): Promise<void> {
    const db = this.walletDB.getDatabase();

    const stmt = db.prepare(
      `INSERT OR REPLACE INTO wallet_outputs 
       (output_hash, tx_hash, output_index, block_height, output_data, is_spent, spent_tx_hash, spent_block_height, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run([
      outputHash,
      txHash,
      outputIndex,
      blockHeight,
      outputData,
      isSpent ? 1 : 0,
      spentTxHash,
      spentBlockHeight,
      Date.now(),
    ]);
    stmt.free();
  }

  /**
   * Extract block hash from block header
   * @param headerHex - Block header in hex
   * @returns Block hash (hex string)
   */
  private extractBlockHash(headerHex: string): string {
    // Block hash is double SHA256 of header, reversed for display
    const { sha256 } = require('@noble/hashes/sha256');
    const headerBytes = Buffer.from(headerHex, 'hex');
    const hash = sha256(sha256(headerBytes));
    return Buffer.from(hash).reverse().toString('hex');
  }

  /**
   * Get stored block hash from database
   * @param height - Block height
   * @returns Block hash or null if not found
   */
  private async getStoredBlockHash(height: number): Promise<string | null> {
    const db = this.walletDB.getDatabase();

    const stmt = db.prepare('SELECT hash FROM block_hashes WHERE height = ?');
    stmt.bind([height]);
    
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row.hash as string;
    }
    
    stmt.free();
    return null;
  }

  /**
   * Store block hash in database
   * Only stores if within retention window (if retention is enabled)
   * @param height - Block height
   * @param hash - Block hash
   * @param chainTip - Current chain tip (optional, to avoid repeated fetches)
   */
  private async storeBlockHash(height: number, hash: string, chainTip?: number): Promise<void> {
    const db = this.walletDB.getDatabase();

    // If retention is enabled (non-zero), only store recent block hashes
    if (this.blockHashRetention > 0) {
      // Get chain tip if not provided
      const currentChainTip = chainTip ?? await this.electrumClient.getChainTipHeight();
      const retentionStart = Math.max(0, currentChainTip - this.blockHashRetention + 1);
      
      // Only store if within retention window
      if (height < retentionStart) {
        return; // Skip storing old block hashes
      }

      // Periodically clean up old block hashes outside retention window
      // Only do this occasionally to avoid overhead (every 100 blocks)
      if (height % 100 === 0) {
        const cleanupStmt = db.prepare('DELETE FROM block_hashes WHERE height < ?');
        cleanupStmt.run([retentionStart]);
        cleanupStmt.free();
      }
    }

    const stmt = db.prepare('INSERT OR REPLACE INTO block_hashes (height, hash) VALUES (?, ?)');
    stmt.run([height, hash]);
    stmt.free();
  }

  /**
   * Load sync state from database
   * @returns Sync state or null if not found
   */
  private async loadSyncState(): Promise<SyncState | null> {
    try {
      const db = this.walletDB.getDatabase();

      const result = db.exec('SELECT * FROM sync_state LIMIT 1');
      if (result.length > 0 && result[0].values.length > 0) {
        const row = result[0].values[0];
        return {
          lastSyncedHeight: row[1] as number,
          lastSyncedHash: row[2] as string,
          totalTxKeysSynced: row[3] as number,
          lastSyncTime: row[4] as number,
          chainTipAtLastSync: row[5] as number,
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Update sync state in database
   * @param state - Sync state to update
   */
  private async updateSyncState(state: Partial<SyncState>): Promise<void> {
    const db = this.walletDB.getDatabase();

    const currentState = this.syncState || {
      lastSyncedHeight: -1,
      lastSyncedHash: '',
      totalTxKeysSynced: 0,
      lastSyncTime: 0,
      chainTipAtLastSync: 0,
    };

    const newState: SyncState = {
      ...currentState,
      ...state,
    };

    // Use id = 0 for the single sync state row
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO sync_state 
       (id, last_synced_height, last_synced_hash, total_tx_keys_synced, last_sync_time, chain_tip_at_last_sync)
       VALUES (0, ?, ?, ?, ?, ?)`
    );
    stmt.run([
      newState.lastSyncedHeight,
      newState.lastSyncedHash,
      newState.totalTxKeysSynced,
      newState.lastSyncTime,
      newState.chainTipAtLastSync,
    ]);
    stmt.free();

    this.syncState = newState;
  }

  /**
   * Get transaction keys for a specific transaction
   * @param txHash - Transaction hash
   * @returns Transaction keys or null if not found
   */
  async getTransactionKeys(txHash: string): Promise<any | null> {
    try {
      const db = this.walletDB.getDatabase();

    const stmt = db.prepare('SELECT keys_data FROM tx_keys WHERE tx_hash = ?');
    stmt.bind([txHash]);
    
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return JSON.parse(row.keys_data as string);
    }
    
      stmt.free();
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get transaction keys for a block
   * @param height - Block height
   * @returns Array of transaction keys
   */
  async getBlockTransactionKeys(height: number): Promise<TransactionKeys[]> {
    try {
      const db = this.walletDB.getDatabase();

    const result = db.exec('SELECT tx_hash, keys_data FROM tx_keys WHERE block_height = ?', [height]);
    if (result.length > 0) {
      return result[0].values.map((row: any[]) => ({
        txHash: row[0] as string,
        keys: JSON.parse(row[1] as string),
      }));
    }

      return [];
    } catch {
      return [];
    }
  }

  /**
   * Reset sync state (for testing or full resync)
   */
  async resetSyncState(): Promise<void> {
    const db = this.walletDB.getDatabase();

    // Delete all sync state
    db.run('DELETE FROM sync_state');
    db.run('DELETE FROM tx_keys');
    db.run('DELETE FROM block_hashes');

    this.syncState = null;
  }
}

