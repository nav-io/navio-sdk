/**
 * P2P Sync Provider
 *
 * Implements the SyncProvider interface using direct P2P connections
 * to Navio full nodes. Parses blocks using navio-blsct for transaction
 * key extraction.
 */

import { sha256 } from '@noble/hashes/sha256';
import { BaseSyncProvider, BlockHeadersResult, ChainTip, SyncProviderOptions } from './sync-provider';
import { P2PClient, P2PMessage, InvType, MessageType } from './p2p-protocol';
import type { BlockTransactionKeys, TransactionKeys } from './electrum';

// Import navio-blsct for transaction parsing (will be used for full implementation)
// const blsctModule = require('navio-blsct');

/**
 * P2P sync provider options
 */
export interface P2PSyncOptions extends SyncProviderOptions {
  /** Host to connect to */
  host: string;
  /** Port (default based on network) */
  port?: number;
  /** Network type */
  network?: 'mainnet' | 'testnet' | 'regtest';
  /** User agent string */
  userAgent?: string;
  /** Maximum blocks to fetch per request */
  maxBlocksPerRequest?: number;
  /** Maximum headers to fetch per request */
  maxHeadersPerRequest?: number;
}

/**
 * Parsed transaction output keys
 */
interface ParsedOutputKeys {
  /** Output hash */
  outputHash: string;
  /** Blinding key (G1 point, 48 bytes hex) */
  blindingKey: string;
  /** Spending key (G1 point, 48 bytes hex) */
  spendingKey: string;
  /** Ephemeral key (G1 point, 48 bytes hex) */
  ephemeralKey: string;
  /** View tag (16-bit) */
  viewTag: number;
  /** Has range proof */
  hasRangeProof: boolean;
}

/**
 * Block header cache entry
 */
interface CachedHeader {
  height: number;
  hash: string;
  rawHex: string;
  prevHash: string;
}

/**
 * P2P Sync Provider
 *
 * Connects directly to a Navio full node via P2P protocol.
 * Fetches blocks and extracts transaction keys for wallet scanning.
 * 
 * @category Sync
 */
export class P2PSyncProvider extends BaseSyncProvider {
  readonly type = 'p2p' as const;

  private client: P2PClient;
  private options: Required<P2PSyncOptions>;

  // Header chain state
  private headersByHash: Map<string, CachedHeader> = new Map();
  private headersByHeight: Map<number, CachedHeader> = new Map();
  private chainTipHeight: number = -1;
  private chainTipHash: string = '';
  private genesisHash: string = '';

  // Block cache (limited size)
  private blockCache: Map<string, Buffer> = new Map();
  private maxBlockCacheSize = 10;

  // Pending block requests
  private pendingBlocks: Map<string, Promise<Buffer>> = new Map();

  constructor(options: P2PSyncOptions) {
    super(options);

    this.options = {
      host: options.host,
      port: options.port ?? 33570,
      network: options.network ?? 'testnet',
      timeout: options.timeout ?? 30000,
      debug: options.debug ?? false,
      userAgent: options.userAgent ?? '/navio-sdk:0.1.0/',
      maxBlocksPerRequest: options.maxBlocksPerRequest ?? 16,
      maxHeadersPerRequest: options.maxHeadersPerRequest ?? 2000,
    };

    this.client = new P2PClient({
      host: this.options.host,
      port: this.options.port,
      network: this.options.network,
      timeout: this.options.timeout,
      debug: this.options.debug,
      userAgent: this.options.userAgent,
    });
  }

  /**
   * Connect to the P2P node
   */
  async connect(): Promise<void> {
    await this.client.connect();
    this.log('Connected to P2P node');

    // Request headers-first announcements
    this.client.sendSendHeaders();

    // Get initial chain state
    this.chainTipHeight = this.client.getPeerStartHeight();
    this.log(`Peer reports height: ${this.chainTipHeight}`);

    // Register block handler
    this.client.onMessage(MessageType.BLOCK, (msg) => {
      this.handleBlockMessage(msg);
    });

    // Sync headers to get chain tip
    if (this.chainTipHeight > 0) {
      await this.syncHeaders(0, Math.min(100, this.chainTipHeight));
    }
  }

  /**
   * Disconnect from the P2P node
   */
  disconnect(): void {
    this.client.disconnect();
    this.headersByHash.clear();
    this.headersByHeight.clear();
    this.blockCache.clear();
    this.chainTipHeight = -1;
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
    // If we have synced headers, use that
    if (this.chainTipHeight >= 0) {
      return this.chainTipHeight;
    }

    // Otherwise use peer's reported height
    return this.client.getPeerStartHeight();
  }

  /**
   * Get current chain tip
   */
  async getChainTip(): Promise<ChainTip> {
    return {
      height: this.chainTipHeight,
      hash: this.chainTipHash,
    };
  }

  /**
   * Get a single block header
   */
  async getBlockHeader(height: number): Promise<string> {
    // Check cache
    const cached = this.headersByHeight.get(height);
    if (cached) {
      return cached.rawHex;
    }

    // Need to fetch headers up to this height
    await this.syncHeaders(height, 1);

    const header = this.headersByHeight.get(height);
    if (!header) {
      throw new Error(`Failed to fetch header at height ${height}`);
    }

    return header.rawHex;
  }

  /**
   * Get multiple block headers
   */
  async getBlockHeaders(startHeight: number, count: number): Promise<BlockHeadersResult> {
    // Ensure we have headers cached
    await this.syncHeaders(startHeight, count);

    const headers: string[] = [];
    for (let h = startHeight; h < startHeight + count; h++) {
      const cached = this.headersByHeight.get(h);
      if (cached) {
        headers.push(cached.rawHex);
      } else {
        break;
      }
    }

    return {
      count: headers.length,
      hex: headers.join(''),
      max: this.options.maxHeadersPerRequest,
    };
  }

  /**
   * Sync headers from the network
   */
  private async syncHeaders(fromHeight: number, count: number): Promise<void> {
    // Build locator from known headers
    const locatorHashes: Buffer[] = [];

    // Start from just before the requested height
    let step = 1;
    let height = fromHeight > 0 ? fromHeight - 1 : 0;

    while (height >= 0) {
      const header = this.headersByHeight.get(height);
      if (header) {
        locatorHashes.push(P2PClient.hashFromDisplay(header.hash));
      }
      if (height === 0) break;
      height -= step;
      if (locatorHashes.length > 10) step *= 2;
    }

    // Always include genesis if we have it
    if (this.genesisHash && locatorHashes.length === 0) {
      locatorHashes.push(P2PClient.hashFromDisplay(this.genesisHash));
    }

    // If no locators, start from genesis
    if (locatorHashes.length === 0) {
      locatorHashes.push(Buffer.alloc(32)); // Zero hash = start from genesis
    }

    // Request headers
    const rawHeaders = await this.client.getHeaders(locatorHashes);
    this.log(`Received ${rawHeaders.length} headers`);

    // Process headers - they arrive in order after the locator
    // For initial sync from genesis, first header is block 0

    // First pass: Find any headers we can chain from known blocks
    const pendingHeaders: Array<{ rawHeader: Buffer; hash: string; prevHash: string; headerHex: string }> = [];

    for (const rawHeader of rawHeaders) {
      const headerHex = rawHeader.toString('hex');
      const hash = this.extractBlockHash(headerHex);
      // Block header: version(4) + prevBlockHash(32) + merkleRoot(32) + timestamp(4) + bits(4) + nonce(4) = 80 bytes
      // prevBlockHash is at offset 4, length 32 (bytes 4-35 inclusive)
      // subarray(4, 36) gives bytes at indices 4,5,...,35 (32 bytes total)
      const prevHashBytes = rawHeader.subarray(4, 36);
      // Reverse for display format (little-endian to big-endian)
      const prevHash = Buffer.from(prevHashBytes).reverse().toString('hex');

      pendingHeaders.push({ rawHeader, hash, prevHash, headerHex });
    }

    // Process headers - they come in chain order from getheaders
    // Headers are returned in order: each header's prevHash points to the previous header in the response
    for (let i = 0; i < pendingHeaders.length; i++) {
      const { hash, prevHash, headerHex } = pendingHeaders[i];

      let headerHeight: number;

      if (prevHash === '0'.repeat(64)) {
        // Genesis block (prevHash is all zeros)
        headerHeight = 0;
        this.genesisHash = hash;
      } else if (this.headersByHash.has(prevHash)) {
        // We have the parent in our cache, chain from it
        const prevHeader = this.headersByHash.get(prevHash)!;
        headerHeight = prevHeader.height + 1;
      } else if (i === 0 && this.headersByHeight.size === 0) {
        // First header in initial sync - this is genesis (height 0)
        // Genesis block in Navio might have a non-zero prevHash for the PoS genesis
        this.log(`Initial sync: first header is genesis (height 0)`);
        headerHeight = 0;
        this.genesisHash = hash;
      } else if (i > 0) {
        // Chain from the previous header in THIS batch
        // Since getheaders returns headers in chain order, header[i].prevHash should equal header[i-1].hash
        const prevInBatch = pendingHeaders[i - 1];
        if (prevInBatch.hash === prevHash) {
          const prevCached = this.headersByHash.get(prevInBatch.hash);
          if (prevCached) {
            headerHeight = prevCached.height + 1;
          } else {
            this.log(`Previous header in batch not yet cached: ${prevInBatch.hash.substring(0, 16)}...`);
            continue;
          }
        } else {
          // Skip verbose logging after first few
          if (i < 5) {
            this.log(`Header ${hash.substring(0, 16)}... doesn't chain from previous in batch`);
          }
          continue;
        }
      } else {
        this.log(`Cannot determine height for header ${hash.substring(0, 16)}...`);
        continue;
      }

      const cached: CachedHeader = {
        height: headerHeight,
        hash,
        rawHex: headerHex,
        prevHash,
      };

      this.headersByHash.set(hash, cached);
      this.headersByHeight.set(headerHeight, cached);

      // Update chain tip
      if (headerHeight > this.chainTipHeight) {
        this.chainTipHeight = headerHeight;
        this.chainTipHash = hash;
      }
    }

    this.log(`Processed headers. Chain tip: height=${this.chainTipHeight}, cached=${this.headersByHeight.size} headers`);

    // Continue syncing if we got max headers and need more
    if (rawHeaders.length >= this.options.maxHeadersPerRequest - 1 && this.chainTipHeight < this.client.getPeerStartHeight()) {
      // Request more headers from where we left off
      await this.syncHeaders(this.chainTipHeight, count);
    }
  }

  /**
   * Get transaction keys for a range of blocks
   */
  async getBlockTransactionKeysRange(startHeight: number): Promise<{
    blocks: BlockTransactionKeys[];
    nextHeight: number;
  }> {
    const blocks: BlockTransactionKeys[] = [];
    const maxBlocks = this.options.maxBlocksPerRequest;

    // Calculate end height for this batch
    const batchEndHeight = Math.min(startHeight + maxBlocks - 1, this.chainTipHeight);

    // Try to ensure we have headers up to the batch end height
    // This may fail if we're at the chain tip, which is OK
    try {
      await this.ensureHeadersSyncedTo(batchEndHeight);
    } catch (e) {
      this.log(`Could not sync headers to ${batchEndHeight}: ${e}`);
      // Continue with what we have
    }

    // Find the highest header we actually have
    let highestCached = 0;
    for (const h of this.headersByHeight.keys()) {
      if (h > highestCached) highestCached = h;
    }

    // Don't try to sync past what we have headers for
    const effectiveTip = Math.min(this.chainTipHeight, highestCached);

    // If start height is beyond what we can sync, return empty
    if (startHeight > effectiveTip) {
      return {
        blocks: [],
        nextHeight: startHeight,
      };
    }

    for (let height = startHeight; height < startHeight + maxBlocks && height <= effectiveTip; height++) {
      try {
        const txKeys = await this.getBlockTransactionKeys(height);
        blocks.push({
          height,
          txKeys,
        });
      } catch (e) {
        this.log(`Error getting tx keys for block ${height}: ${e}`);
        // Stop on error - don't skip blocks
        break;
      }
    }

    const lastHeight = blocks.length > 0 ? blocks[blocks.length - 1].height : startHeight;
    return {
      blocks,
      nextHeight: lastHeight + 1,
    };
  }

  /**
   * Get transaction keys for a single block
   */
  async getBlockTransactionKeys(height: number): Promise<TransactionKeys[]> {
    // Ensure we have headers synced up to this height
    await this.ensureHeadersSyncedTo(height);

    const header = this.headersByHeight.get(height);
    if (!header) {
      throw new Error(`Cannot get header for height ${height}`);
    }

    // Fetch block
    const blockData = await this.fetchBlock(header.hash);

    // Parse block and extract transaction keys
    return this.parseBlockTransactionKeys(blockData);
  }

  /**
   * Ensure headers are synced up to the specified height
   */
  private async ensureHeadersSyncedTo(targetHeight: number): Promise<void> {
    // Already have the header
    if (this.headersByHeight.has(targetHeight)) {
      return;
    }

    // Find highest height we have
    let highestKnown = -1;
    for (const h of this.headersByHeight.keys()) {
      if (h > highestKnown) highestKnown = h;
    }

    // If we're already at or past the target, we're done
    if (highestKnown >= targetHeight) {
      return;
    }

    // Keep syncing until we have headers up to target height or can't make progress
    let attempts = 0;
    const maxAttempts = 100; // Prevent infinite loop

    while (!this.headersByHeight.has(targetHeight) && attempts < maxAttempts) {
      attempts++;

      this.log(`Need header ${targetHeight}, highest known: ${highestKnown}`);

      // Sync more headers starting from where we are
      const syncFrom = highestKnown + 1;
      await this.syncHeaders(syncFrom, this.options.maxHeadersPerRequest);

      // Check if we made progress
      let newHighest = -1;
      for (const h of this.headersByHeight.keys()) {
        if (h > newHighest) newHighest = h;
      }

      if (newHighest <= highestKnown) {
        // No progress made - we're at the chain tip
        // This is OK if we're close to the target
        this.log(`No new headers available, highest: ${highestKnown}`);
        return; // Don't throw, just return what we have
      }

      highestKnown = newHighest;
    }
  }

  /**
   * Fetch a block by hash
   */
  private async fetchBlock(hashHex: string): Promise<Buffer> {
    // Check cache
    const cached = this.blockCache.get(hashHex);
    if (cached) {
      return cached;
    }

    // Check for pending request
    const pending = this.pendingBlocks.get(hashHex);
    if (pending) {
      return pending;
    }

    // Request block
    const blockHashBuffer = P2PClient.hashFromDisplay(hashHex);
    const promise = this.client.getBlock(blockHashBuffer).then((msg) => {
      this.pendingBlocks.delete(hashHex);

      // Cache the block
      if (this.blockCache.size >= this.maxBlockCacheSize) {
        // Remove oldest entry
        const oldest = this.blockCache.keys().next().value;
        if (oldest) this.blockCache.delete(oldest);
      }
      this.blockCache.set(hashHex, msg.payload);

      return msg.payload;
    });

    this.pendingBlocks.set(hashHex, promise);
    return promise;
  }

  /**
   * Handle incoming block message
   */
  private handleBlockMessage(msg: P2PMessage): void {
    // Extract block hash from header
    const headerHex = msg.payload.subarray(0, 80).toString('hex');
    const hash = this.extractBlockHash(headerHex);

    // Cache the block
    if (this.blockCache.size >= this.maxBlockCacheSize) {
      const oldest = this.blockCache.keys().next().value;
      if (oldest) this.blockCache.delete(oldest);
    }
    this.blockCache.set(hash, msg.payload);

    this.log(`Received block: ${hash}`);
  }

  /**
   * Parse block data and extract transaction keys
   *
   * Parses all transactions in the block and extracts BLSCT output keys
   * for wallet output detection.
   */
  private parseBlockTransactionKeys(blockData: Buffer): TransactionKeys[] {
    const txKeys: TransactionKeys[] = [];
    let offset = 80; // Skip header

    // Check if this is a PoS block (version bit 24 set = 0x01000000)
    const version = blockData.readInt32LE(0);
    const isPoS = (version & 0x01000000) !== 0;

    this.log(`Block version: 0x${version.toString(16)}, isPoS: ${isPoS}, size: ${blockData.length}`);

    // Skip PoS proof if present
    if (isPoS) {
      // Navio PoS blocks have a CStakeProof after the header
      // Need to read and skip the proof carefully
      const proofSkipResult = this.skipPoSProof(blockData, offset);
      if (proofSkipResult.error) {
        this.log(`Error skipping PoS proof: ${proofSkipResult.error}`);
        return txKeys;
      }
      offset = proofSkipResult.newOffset;
      this.log(`Skipped PoS proof, offset now: ${offset}`);
    }

    // Parse transaction count
    const { value: txCount, bytesRead } = this.decodeVarInt(blockData, offset);
    offset += bytesRead;

    this.log(`Parsing ${txCount} transactions from block (offset: ${offset})`);

    // Parse each transaction
    for (let txIndex = 0; txIndex < Number(txCount); txIndex++) {
      const result = this.parseBlsctTransaction(blockData, offset);
      if (result.error) {
        this.log(`Error parsing tx ${txIndex}/${txCount}: ${result.error}`);
        break;
      }

      offset = result.newOffset;

      if (result.outputKeys.length > 0) {
        txKeys.push({
          txHash: result.txHash,
          keys: this.formatOutputKeys(result.outputKeys),
        });
      }
    }

    return txKeys;
  }

  /**
   * Skip PoS proof in block data
   */
  private skipPoSProof(
    data: Buffer,
    offset: number
  ): { newOffset: number; error?: string } {
    try {
      // PoS proof structure (blsct::ProofOfStake) from navio-core/src/blsct/pos/proof.h:
      // - SetMemProof setMemProof
      // - RangeProof rangeProof (serialized as RangeProofWithoutVs)
      //
      // SetMemProof contains:
      // - 8 Points (phi, A1, A2, S1, S2, S3, T1, T2) = 8 × 48 = 384 bytes
      // - 6 Scalars (tau_x, mu, z_alpha, z_tau, z_beta, t) = 6 × 32 = 192 bytes
      // - Ls vector (variable: varint count + count × 48 bytes)
      // - Rs vector (variable: varint count + count × 48 bytes)
      // - 3 Scalars (a, b, omega) = 3 × 32 = 96 bytes

      const G1_SIZE = 48;
      const SCALAR_SIZE = 32;

      // SetMemProof fixed part: 8 points + 6 scalars
      offset += 8 * G1_SIZE; // phi, A1, A2, S1, S2, S3, T1, T2
      offset += 6 * SCALAR_SIZE; // tau_x, mu, z_alpha, z_tau, z_beta, t

      // Ls vector
      const { value: lsCount, bytesRead: lsCountBytes } = this.decodeVarInt(data, offset);
      offset += lsCountBytes;
      offset += Number(lsCount) * G1_SIZE;

      // Rs vector
      const { value: rsCount, bytesRead: rsCountBytes } = this.decodeVarInt(data, offset);
      offset += rsCountBytes;
      offset += Number(rsCount) * G1_SIZE;

      // 3 more scalars: a, b, omega
      offset += 3 * SCALAR_SIZE;

      // Now skip the RangeProof (RangeProofWithoutVs - no Vs vector)
      // RangeProofWithoutVs contains:
      // - Ls vector (varint + points)
      // - Rs vector (varint + points)
      // - A, A_wip, B (3 points)
      // - r_prime, s_prime, delta_prime, alpha_hat, tau_x (5 scalars)

      // Ls vector
      const { value: rpLsCount, bytesRead: rpLsCountBytes } = this.decodeVarInt(data, offset);
      offset += rpLsCountBytes;
      offset += Number(rpLsCount) * G1_SIZE;

      // Rs vector
      const { value: rpRsCount, bytesRead: rpRsCountBytes } = this.decodeVarInt(data, offset);
      offset += rpRsCountBytes;
      offset += Number(rpRsCount) * G1_SIZE;

      // A, A_wip, B (3 points)
      offset += 3 * G1_SIZE;

      // r_prime, s_prime, delta_prime, alpha_hat, tau_x (5 scalars)
      offset += 5 * SCALAR_SIZE;

      return { newOffset: offset };
    } catch (e) {
      return { newOffset: offset, error: String(e) };
    }
  }

  // ============================================================================
  // BLSCT Constants
  // ============================================================================

  private static readonly G1_POINT_SIZE = 48; // Compressed G1 point
  private static readonly SCALAR_SIZE = 32; // MCL Scalar
  private static readonly MAX_AMOUNT = BigInt('0x7FFFFFFFFFFFFFFF');
  private static readonly BLSCT_MARKER = 0x1;
  private static readonly TOKEN_MARKER = 0x2;
  private static readonly PREDICATE_MARKER = 0x4;
  private static readonly TRANSPARENT_VALUE_MARKER = 0x8;

  /**
   * Parse a BLSCT transaction and extract output keys
   */
  private parseBlsctTransaction(
    data: Buffer,
    offset: number
  ): { txHash: string; outputKeys: ParsedOutputKeys[]; newOffset: number; error?: string } {
    const startOffset = offset;
    const outputKeys: ParsedOutputKeys[] = [];

    try {
      // Version (4 bytes)
      const version = data.readInt32LE(offset);
      offset += 4;

      // Transaction BLSCT marker is 0x20 (1 << 5), different from block's 0x40000000
      const TX_BLSCT_MARKER = 0x20;
      const isBLSCT = (version & TX_BLSCT_MARKER) !== 0;

      // Check for witness marker (0x00 followed by flags)
      let hasWitness = false;
      let witnessFlags = 0;
      if (data[offset] === 0x00) {
        // Read potential flags byte
        if (offset + 1 < data.length && data[offset + 1] !== 0x00) {
          witnessFlags = data[offset + 1];
          hasWitness = (witnessFlags & 0x01) !== 0;
          offset += 2; // Skip marker and flag
        }
      }

      // Input count
      const { value: inputCount, bytesRead: inputCountBytes } = this.decodeVarInt(data, offset);
      offset += inputCountBytes;

      // Parse inputs
      // NOTE: Navio's COutPoint only contains hash (no index/n field)
      // This is different from Bitcoin where COutPoint has both hash and n
      for (let i = 0; i < Number(inputCount); i++) {
        offset += 32; // Previous output hash (prevout.hash) - Navio has no prevout.n!
        
        // scriptSig length + data
        const { value: scriptSigLen, bytesRead: sigLenBytes } = this.decodeVarInt(data, offset);
        offset += sigLenBytes;
        if (Number(scriptSigLen) > 10000) {
          return { txHash: '', outputKeys: [], newOffset: offset, error: `Invalid scriptSig length: ${scriptSigLen}` };
        }
        offset += Number(scriptSigLen);
        offset += 4; // sequence
      }

      // Output count
      const { value: outputCount, bytesRead: outputCountBytes } = this.decodeVarInt(data, offset);
      offset += outputCountBytes;

      // Parse outputs
      for (let i = 0; i < Number(outputCount); i++) {
        const outputResult = this.parseBlsctOutput(data, offset, i);
        if (outputResult.error) {
          return { txHash: '', outputKeys: [], newOffset: offset, error: outputResult.error };
        }
        offset = outputResult.newOffset;
        if (outputResult.keys) {
          outputKeys.push(outputResult.keys);
        }
      }

      // Parse witness data if present
      if (hasWitness) {
        for (let i = 0; i < Number(inputCount); i++) {
          const { value: witnessCount, bytesRead: wcBytes } = this.decodeVarInt(data, offset);
          offset += wcBytes;

          for (let j = 0; j < Number(witnessCount); j++) {
            const { value: itemLen, bytesRead: ilBytes } = this.decodeVarInt(data, offset);
            offset += ilBytes;
            offset += Number(itemLen);
          }
        }
      }

      // Lock time
      offset += 4;

      // BLSCT signature if present
      if (isBLSCT) {
        // blsct::Signature is 2 G1 points (96 bytes)
        offset += 96;
      }

      // Calculate transaction hash
      const txData = data.subarray(startOffset, offset);
      const txHash = this.calculateBlsctTxHash(txData, hasWitness, startOffset, version);

      return {
        txHash,
        outputKeys,
        newOffset: offset,
      };
    } catch (e) {
      return {
        txHash: '',
        outputKeys: [],
        newOffset: offset,
        error: `Parse error: ${e}`,
      };
    }
  }

  /**
   * Parse a BLSCT output and extract keys
   */
  private parseBlsctOutput(
    data: Buffer,
    offset: number,
    outputIndex: number
  ): { keys: ParsedOutputKeys | null; newOffset: number; error?: string } {
    try {
      // Read value (8 bytes)
      const rawValue = data.readBigInt64LE(offset);
      offset += 8;

      let flags = 0n;

      // Check for extended format (value = MAX_AMOUNT indicates flags follow)
      if (rawValue === P2PSyncProvider.MAX_AMOUNT) {
        // Extended format with flags
        flags = data.readBigUInt64LE(offset);
        offset += 8;

        if (flags & BigInt(P2PSyncProvider.TRANSPARENT_VALUE_MARKER)) {
          // Skip the actual value (we don't need it for key extraction)
          offset += 8;
        }
      }

      // Parse scriptPubKey
      const { value: scriptLen, bytesRead: scriptLenBytes } = this.decodeVarInt(data, offset);
      offset += scriptLenBytes;
      offset += Number(scriptLen);

      const hasBlsctData = (flags & BigInt(P2PSyncProvider.BLSCT_MARKER)) !== 0n;
      const hasTokenId = (flags & BigInt(P2PSyncProvider.TOKEN_MARKER)) !== 0n;
      const hasPredicate = (flags & BigInt(P2PSyncProvider.PREDICATE_MARKER)) !== 0n;

      let keys: ParsedOutputKeys | null = null;

      // Parse BLSCT data if present
      if (hasBlsctData) {
        const blsctResult = this.parseBlsctData(data, offset, outputIndex);
        if (blsctResult.error) {
          return { keys: null, newOffset: offset, error: blsctResult.error };
        }
        offset = blsctResult.newOffset;
        keys = blsctResult.keys;
      }

      // Skip token ID if present
      if (hasTokenId) {
        // TokenId is 2 uint256s (64 bytes)
        offset += 64;
      }

      // Skip predicate if present
      if (hasPredicate) {
        const { value: predicateLen, bytesRead: predLenBytes } = this.decodeVarInt(data, offset);
        offset += predLenBytes;
        offset += Number(predicateLen);
      }

      return { keys, newOffset: offset };
    } catch (e) {
      return { keys: null, newOffset: offset, error: `Output parse error: ${e}` };
    }
  }

  /**
   * Parse BLSCT data from output
   */
  private parseBlsctData(
    data: Buffer,
    offset: number,
    outputIndex: number
  ): { keys: ParsedOutputKeys | null; newOffset: number; error?: string } {
    try {
      // Parse range proof
      const proofResult = this.parseRangeProof(data, offset);
      if (proofResult.error) {
        return { keys: null, newOffset: offset, error: proofResult.error };
      }
      offset = proofResult.newOffset;

      // Parse keys (only if range proof has data)
      if (proofResult.hasData) {
        // spendingKey (G1 point)
        const spendingKey = data.subarray(offset, offset + P2PSyncProvider.G1_POINT_SIZE).toString('hex');
        offset += P2PSyncProvider.G1_POINT_SIZE;

        // blindingKey (G1 point)
        const blindingKey = data.subarray(offset, offset + P2PSyncProvider.G1_POINT_SIZE).toString('hex');
        offset += P2PSyncProvider.G1_POINT_SIZE;

        // ephemeralKey (G1 point)
        const ephemeralKey = data.subarray(offset, offset + P2PSyncProvider.G1_POINT_SIZE).toString('hex');
        offset += P2PSyncProvider.G1_POINT_SIZE;

        // viewTag (2 bytes)
        const viewTag = data.readUInt16LE(offset);
        offset += 2;

        // Create output hash from output index (simplified)
        const outputHash = this.hashBuffer(Buffer.from(`output:${outputIndex}`));

        return {
          keys: {
            blindingKey,
            spendingKey,
            ephemeralKey,
            viewTag,
            outputHash,
            hasRangeProof: true,
          },
          newOffset: offset,
        };
      }

      return { keys: null, newOffset: offset };
    } catch (e) {
      return { keys: null, newOffset: offset, error: `BLSCT data parse error: ${e}` };
    }
  }

  /**
   * Parse bulletproofs_plus range proof
   */
  private parseRangeProof(
    data: Buffer,
    offset: number
  ): { hasData: boolean; newOffset: number; error?: string } {
    try {
      // ProofBase: Vs, Ls, Rs (vectors of Points)
      // First, parse Vs
      const { value: vsCount, bytesRead: vsCountBytes } = this.decodeVarInt(data, offset);
      offset += vsCountBytes;

      const numVs = Number(vsCount);
      offset += numVs * P2PSyncProvider.G1_POINT_SIZE; // Vs

      if (numVs > 0) {
        // Parse Ls
        const { value: lsCount, bytesRead: lsCountBytes } = this.decodeVarInt(data, offset);
        offset += lsCountBytes;
        offset += Number(lsCount) * P2PSyncProvider.G1_POINT_SIZE;

        // Parse Rs
        const { value: rsCount, bytesRead: rsCountBytes } = this.decodeVarInt(data, offset);
        offset += rsCountBytes;
        offset += Number(rsCount) * P2PSyncProvider.G1_POINT_SIZE;

        // RangeProof additional fields
        offset += P2PSyncProvider.G1_POINT_SIZE; // A
        offset += P2PSyncProvider.G1_POINT_SIZE; // A_wip
        offset += P2PSyncProvider.G1_POINT_SIZE; // B
        offset += P2PSyncProvider.SCALAR_SIZE; // r_prime
        offset += P2PSyncProvider.SCALAR_SIZE; // s_prime
        offset += P2PSyncProvider.SCALAR_SIZE; // delta_prime
        offset += P2PSyncProvider.SCALAR_SIZE; // alpha_hat
        offset += P2PSyncProvider.SCALAR_SIZE; // tau_x
      }

      return { hasData: numVs > 0, newOffset: offset };
    } catch (e) {
      return { hasData: false, newOffset: offset, error: `RangeProof parse error: ${e}` };
    }
  }

  /**
   * Calculate BLSCT transaction hash
   */
  private calculateBlsctTxHash(txData: Buffer, _hasWitness: boolean, _startOffset: number, _version: number): string {
    // For now, simple double SHA256 of the full transaction
    // TODO: Handle witness stripping for proper txid calculation
    const hash = sha256(sha256(txData));
    return Buffer.from(hash).reverse().toString('hex');
  }

  /**
   * Hash a buffer using SHA256
   */
  private hashBuffer(data: Buffer): string {
    return Buffer.from(sha256(data)).toString('hex');
  }

  /**
   * Format output keys for the sync interface
   */
  private formatOutputKeys(outputKeys: ParsedOutputKeys[]): { outputs: ParsedOutputKeys[] } {
    return {
      outputs: outputKeys,
    };
  }

  /**
   * Get serialized transaction output by output hash
   */
  async getTransactionOutput(outputHash: string): Promise<string> {
    // Use GETOUTPUTDATA P2P message
    const outputHashBuffer = Buffer.from(outputHash, 'hex');
    const response = await this.client.getOutputData([outputHashBuffer]);

    // Response should be a TX message containing the transaction
    return response.payload.toString('hex');
  }

  /**
   * Broadcast a transaction
   */
  async broadcastTransaction(rawTx: string): Promise<string> {
    // Parse transaction to get hash
    const txData = Buffer.from(rawTx, 'hex');
    const txHash = this.calculateBlsctTxHash(txData, false, 0, 0);

    // TODO: Implement proper broadcast with INV/GETDATA dance
    // For now, we would need to:
    // 1. Send INV announcing the transaction
    // 2. Wait for GETDATA request
    // 3. Send the TX
    // This requires exposing sendMessage as public or adding a broadcast method to P2PClient

    this.log(`Broadcasting transaction: ${txHash}`);

    return txHash;
  }

  /**
   * Get raw transaction
   */
  async getRawTransaction(txHash: string, _verbose?: boolean): Promise<string> {
    // Request transaction via GETDATA
    const inv = [{ type: InvType.MSG_WITNESS_TX, hash: P2PClient.hashFromDisplay(txHash) }];

    // Send getdata
    await this.client.getData(inv);

    // Wait for TX message
    const response = await this.client.waitForMessage(MessageType.TX, this.options.timeout);

    return response.payload.toString('hex');
  }

  /**
   * Decode variable-length integer from buffer
   */
  private decodeVarInt(buffer: Buffer, offset: number): { value: bigint; bytesRead: number } {
    const first = buffer.readUInt8(offset);

    if (first < 0xfd) {
      return { value: BigInt(first), bytesRead: 1 };
    } else if (first === 0xfd) {
      return { value: BigInt(buffer.readUInt16LE(offset + 1)), bytesRead: 3 };
    } else if (first === 0xfe) {
      return { value: BigInt(buffer.readUInt32LE(offset + 1)), bytesRead: 5 };
    } else {
      return { value: buffer.readBigUInt64LE(offset + 1), bytesRead: 9 };
    }
  }
}

