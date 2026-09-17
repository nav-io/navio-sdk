/**
 * P2P Sync Provider
 *
 * Implements the SyncProvider interface using a direct P2P connection to a
 * Navio full node: headers via getheaders, blocks via getdata, BLSCT output
 * keys parsed locally from block data, broadcasts via an unsolicited `tx`
 * message, and outputs/transactions via getdata.
 */

import {
  BaseSyncProvider,
  BlockHeaderCallback,
  BlockHeaderNotification,
  BlockHeadersResult,
  ChainTip,
  SyncProviderOptions,
} from './sync-provider';
import {
  DefaultPorts,
  InvType,
  MAX_HEADERS_RESULTS,
  MessageType,
  P2PClient,
  P2PMessage,
  P2PNetwork,
} from './p2p-protocol';
import { parseBlock, parseTransaction, ParsedBlock, ParsedTransaction } from './p2p-block-parser';
import type { BlockTransactionKeys, TransactionKeys } from './electrum';

/**
 * P2P sync provider options
 */
export interface P2PSyncOptions extends SyncProviderOptions {
  /** Host to connect to */
  host: string;
  /** Port (default based on network) */
  port?: number;
  /** Network type (default: mainnet) */
  network?: P2PNetwork;
  /** User agent string */
  userAgent?: string;
  /** Maximum blocks returned per getBlockTransactionKeysRange call (default 16) */
  maxBlocksPerRequest?: number;
  /** Maximum headers to fetch per getheaders request (default 2000, the node's limit) */
  maxHeadersPerRequest?: number;
  /** Maximum concurrent block downloads (default 8) */
  maxConcurrentBlockRequests?: number;
  /**
   * Number of txid -> block height entries remembered from scanned blocks so
   * getRawTransaction can serve confirmed transactions the node no longer
   * offers over getdata (default 100000).
   */
  txLocationCacheSize?: number;
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

const ZERO_HASH = '0'.repeat(64);

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

  // Header chain state: headersByHeight is contiguous from 1 (genesis is
  // fetched lazily as a block, since getheaders never returns it).
  private headersByHash: Map<string, CachedHeader> = new Map();
  private headersByHeight: Map<number, CachedHeader> = new Map();
  private chainTipHeight: number = -1;
  private chainTipHash: string = '';
  private genesisHash: string = '';
  /** Set when the node announces a block we have no header for. */
  private tipDirty = false;
  /** Serializes getheaders round-trips (responses carry no request id). */
  private headerSyncInFlight: Promise<void> | null = null;

  // Parsed block cache (bounded)
  private blockCache: Map<string, ParsedBlock> = new Map();
  private maxBlockCacheSize = 32;

  // Serialized-output cache, keyed by display-hex output hash. Populated
  // while parsing blocks so wallet amount recovery can read outputs we have
  // already downloaded: the daemon's getoutputdata only serves the mempool
  // and the most recent block, so historical outputs must come from here.
  private outputDataCache: Map<string, string> = new Map();
  private maxOutputDataCacheSize = 50000;

  // txid -> block height for scanned blocks (bounded), for getRawTransaction
  private txLocations: Map<string, number> = new Map();

  // Pending block requests (dedupe concurrent fetches of one hash)
  private pendingBlocks: Map<string, Promise<ParsedBlock>> = new Map();
  private activeBlockRequests = 0;
  private blockRequestQueue: Array<() => void> = [];

  // Block header subscriptions
  private blockHeaderCallbacks: BlockHeaderCallback[] = [];
  private inboundBlockHashes: Set<string> = new Set();

  constructor(options: P2PSyncOptions) {
    super(options);

    const network = options.network ?? 'mainnet';
    this.options = {
      host: options.host,
      port: options.port ?? DefaultPorts[network.toUpperCase() as keyof typeof DefaultPorts],
      network,
      timeout: options.timeout ?? 30000,
      debug: options.debug ?? false,
      userAgent: options.userAgent ?? '/navio-sdk:0.1.0/',
      maxBlocksPerRequest: options.maxBlocksPerRequest ?? 16,
      maxHeadersPerRequest: Math.min(
        options.maxHeadersPerRequest ?? MAX_HEADERS_RESULTS,
        MAX_HEADERS_RESULTS
      ),
      maxConcurrentBlockRequests: options.maxConcurrentBlockRequests ?? 8,
      txLocationCacheSize: options.txLocationCacheSize ?? 100000,
    };

    this.client = this.createClient();
  }

  private createClient(): P2PClient {
    const client = new P2PClient({
      host: this.options.host,
      port: this.options.port,
      network: this.options.network,
      timeout: this.options.timeout,
      debug: this.options.debug,
      userAgent: this.options.userAgent,
    });
    client.onMessage(MessageType.INV, msg => this.handleInvMessage(msg));
    client.onClose(() => {
      this.log('Connection closed');
    });
    return client;
  }

  /**
   * Get the underlying P2P client
   */
  getClient(): P2PClient {
    return this.client;
  }

  /**
   * Connect to the P2P node and sync headers to the tip
   */
  async connect(): Promise<void> {
    if (this.client.isConnected()) {
      return;
    }
    // A closed P2PClient keeps its socket state; start fresh on reconnect.
    this.client = this.createClient();
    await this.client.connect();
    this.log(`Connected to P2P node (peer height ${this.client.getPeerStartHeight()})`);

    await this.syncHeaders();
    this.log(`Headers synced to ${this.chainTipHeight}`);
  }

  /**
   * Disconnect from the P2P node
   */
  disconnect(): void {
    this.client.disconnect();
    this.pendingBlocks.clear();
    this.blockRequestQueue = [];
    this.activeBlockRequests = 0;
    this.headerSyncInFlight = null;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.client.isConnected();
  }

  // ============================================================================
  // Chain tip / headers
  // ============================================================================

  /**
   * Get current chain tip height.
   *
   * Always refreshes from the peer (one getheaders round-trip; the reply is
   * empty when nothing changed), like the Electrum provider does, so callers
   * that fix a sync range from this value never race a block the node has
   * connected but not yet announced to us.
   */
  async getChainTipHeight(): Promise<number> {
    if (!this.client.isConnected()) {
      if (this.chainTipHeight < 0) {
        throw new Error('Not connected');
      }
      // Serve the last known tip while disconnected; block/header fetches
      // fail with "Not connected", which makes TransactionKeysSync reconnect.
      return this.chainTipHeight;
    }
    try {
      await this.syncHeaders();
    } catch (err: any) {
      if (this.chainTipHeight < 0) {
        throw err;
      }
      // Keep serving the cached tip; the next poll retries.
      this.log(`Tip refresh failed: ${err?.message ?? err}`);
    }
    return this.chainTipHeight;
  }

  /**
   * Get current chain tip
   */
  async getChainTip(): Promise<ChainTip> {
    const height = await this.getChainTipHeight();
    return { height, hash: this.chainTipHash };
  }

  /**
   * Get a single block header (80 bytes hex)
   */
  async getBlockHeader(height: number): Promise<string> {
    if (height < 0) {
      throw new Error(`Invalid block height: ${height}`);
    }
    const cached = this.headersByHeight.get(height);
    if (cached) {
      return cached.rawHex;
    }

    if (height === 0) {
      return (await this.getGenesisHeader()).rawHex;
    }

    if (height > this.chainTipHeight) {
      await this.syncHeaders();
    }

    const header = this.headersByHeight.get(height);
    if (!header) {
      throw new Error(`Block height ${height} is beyond the chain tip (${this.chainTipHeight})`);
    }
    return header.rawHex;
  }

  /**
   * Get multiple block headers
   */
  async getBlockHeaders(startHeight: number, count: number): Promise<BlockHeadersResult> {
    if (startHeight + count - 1 > this.chainTipHeight) {
      await this.syncHeaders();
    }

    const headers: string[] = [];
    for (let h = startHeight; h < startHeight + count; h++) {
      if (h === 0) {
        headers.push((await this.getGenesisHeader()).rawHex);
        continue;
      }
      const cached = this.headersByHeight.get(h);
      if (!cached) {
        break;
      }
      headers.push(cached.rawHex);
    }

    return {
      count: headers.length,
      hex: headers.join(''),
      max: this.options.maxHeadersPerRequest,
    };
  }

  /**
   * getheaders never returns the genesis block itself, so serve height 0 by
   * fetching the genesis block (hash learned from block 1's prevHash).
   */
  private async getGenesisHeader(): Promise<CachedHeader> {
    const cached = this.headersByHeight.get(0);
    if (cached) return cached;
    if (!this.genesisHash) {
      await this.syncHeaders();
      if (!this.genesisHash) {
        throw new Error('Genesis hash unknown: the node returned no headers');
      }
    }
    const block = await this.fetchBlock(this.genesisHash);
    const header: CachedHeader = {
      height: 0,
      hash: this.genesisHash,
      rawHex: block.headerHex,
      prevHash: ZERO_HASH,
    };
    this.headersByHash.set(this.genesisHash, header);
    this.headersByHeight.set(0, header);
    return header;
  }

  /**
   * Sync headers from our tip to the node's tip (handles reorgs by
   * truncating to the fork point). Concurrent calls share one round-trip.
   */
  private syncHeaders(): Promise<void> {
    if (this.headerSyncInFlight) {
      return this.headerSyncInFlight;
    }
    const run = this.syncHeadersInner().finally(() => {
      this.headerSyncInFlight = null;
    });
    this.headerSyncInFlight = run;
    return run;
  }

  private async syncHeadersInner(): Promise<void> {
    this.tipDirty = false;

    for (let round = 0; ; round++) {
      const locator = this.buildLocator();
      const rawHeaders = await this.client.getHeaders(locator);
      this.log(`Received ${rawHeaders.length} headers (round ${round})`);

      const accepted = this.processHeaders(rawHeaders);
      if (accepted.length > 0) {
        this.notifyBlockHeaderSubscribers(accepted);
      }

      // Fewer than a full batch means we reached the node's tip.
      if (rawHeaders.length < MAX_HEADERS_RESULTS || accepted.length === 0) {
        break;
      }
      if (round > 100000) {
        throw new Error('Header sync did not converge');
      }
    }
  }

  /**
   * Block locator: dense near the tip, exponentially sparser below, genesis last
   */
  private buildLocator(): Buffer[] {
    const hashes: Buffer[] = [];
    if (this.chainTipHeight >= 1) {
      let step = 1;
      let height = this.chainTipHeight;
      while (height >= 1) {
        const header = this.headersByHeight.get(height);
        if (header) {
          hashes.push(P2PClient.hashFromDisplay(header.hash));
        }
        if (hashes.length >= 10) step *= 2;
        height -= step;
      }
    }
    if (this.genesisHash) {
      hashes.push(P2PClient.hashFromDisplay(this.genesisHash));
    }
    if (hashes.length === 0) {
      // Unknown hash: the node answers from block 1
      hashes.push(Buffer.alloc(32));
    }
    return hashes;
  }

  /**
   * Chain received headers onto our cache. Returns the accepted headers in
   * height order.
   */
  private processHeaders(rawHeaders: Buffer[]): CachedHeader[] {
    const accepted: CachedHeader[] = [];
    let expectedPrev: string | null = null;
    let nextHeight = -1;

    for (const rawHeader of rawHeaders) {
      const headerHex = rawHeader.toString('hex');
      const hash = this.extractBlockHash(headerHex);
      const prevHash = Buffer.from(rawHeader.subarray(4, 36)).reverse().toString('hex');

      if (this.headersByHash.has(hash)) {
        // Already known (node re-sent from the fork point)
        const known = this.headersByHash.get(hash)!;
        expectedPrev = hash;
        nextHeight = known.height + 1;
        continue;
      }

      if (expectedPrev === null) {
        // First new header of the batch: chain onto a known ancestor
        const parent = this.headersByHash.get(prevHash);
        if (parent) {
          nextHeight = parent.height + 1;
        } else if (
          this.headersByHeight.size === 0 ||
          prevHash === this.genesisHash ||
          !this.genesisHash
        ) {
          // The node's response starts at block 1, whose prevHash is the
          // genesis hash (getheaders never returns genesis itself).
          nextHeight = 1;
          this.genesisHash = prevHash;
        } else {
          this.log(
            `Header ${hash.substring(0, 16)}... does not connect to a known block; ignoring batch`
          );
          break;
        }
        // Reorg: drop everything at/after the attach height
        if (nextHeight <= this.chainTipHeight) {
          this.log(
            `Reorg: replacing headers from height ${nextHeight} (tip was ${this.chainTipHeight})`
          );
          this.truncateHeaders(nextHeight);
        }
      } else if (prevHash !== expectedPrev) {
        this.log(`Header ${hash.substring(0, 16)}... breaks the chain in this batch; stopping`);
        break;
      }

      const cached: CachedHeader = { height: nextHeight, hash, rawHex: headerHex, prevHash };
      this.headersByHash.set(hash, cached);
      this.headersByHeight.set(nextHeight, cached);
      this.chainTipHeight = nextHeight;
      this.chainTipHash = hash;
      accepted.push(cached);

      expectedPrev = hash;
      nextHeight += 1;
    }

    return accepted;
  }

  private truncateHeaders(fromHeight: number): void {
    for (let h = fromHeight; h <= this.chainTipHeight; h++) {
      const header = this.headersByHeight.get(h);
      if (header) {
        this.headersByHash.delete(header.hash);
        this.headersByHeight.delete(h);
      }
    }
    this.chainTipHeight = fromHeight - 1;
    const tip = this.headersByHeight.get(this.chainTipHeight);
    this.chainTipHash = tip ? tip.hash : this.chainTipHeight === 0 ? this.genesisHash : '';
  }

  /**
   * Node announced inventory. Block announcements mark the tip dirty and,
   * when subscribers exist, trigger an immediate header refresh.
   */
  private handleInvMessage(msg: P2PMessage): void {
    let invs;
    try {
      invs = P2PClient.parseInvPayload(msg.payload);
    } catch {
      return;
    }
    let sawBlock = false;
    for (const inv of invs) {
      if ((inv.type & ~InvType.MSG_WITNESS_FLAG) === InvType.MSG_BLOCK) {
        const hash = P2PClient.hashToDisplay(inv.hash);
        if (!this.headersByHash.has(hash)) {
          sawBlock = true;
          this.inboundBlockHashes.add(hash);
        }
      }
    }
    if (sawBlock) {
      this.tipDirty = true;
      if (this.blockHeaderCallbacks.length > 0) {
        this.syncHeaders().catch(err =>
          this.log(`Header refresh after inv failed: ${err?.message ?? err}`)
        );
      }
    }
  }

  // ============================================================================
  // Block header subscriptions (inv-driven)
  // ============================================================================

  /**
   * Subscribe to new block headers. Announcements arrive as `inv` messages
   * from the node and trigger a header refresh; each newly accepted header
   * is delivered to the callback.
   */
  async subscribeBlockHeaders(callback: BlockHeaderCallback): Promise<BlockHeaderNotification> {
    this.blockHeaderCallbacks.push(callback);
    const height = await this.getChainTipHeight();
    const hex = height >= 0 ? await this.getBlockHeader(height) : '';
    return { height, hex };
  }

  unsubscribeBlockHeaders(callback: BlockHeaderCallback): boolean {
    const idx = this.blockHeaderCallbacks.indexOf(callback);
    if (idx < 0) return false;
    this.blockHeaderCallbacks.splice(idx, 1);
    return true;
  }

  unsubscribeAllBlockHeaders(): void {
    this.blockHeaderCallbacks = [];
  }

  hasBlockHeaderSubscriptions(): boolean {
    return this.blockHeaderCallbacks.length > 0;
  }

  private notifyBlockHeaderSubscribers(headers: CachedHeader[]): void {
    if (this.blockHeaderCallbacks.length === 0) return;
    for (const header of headers) {
      this.inboundBlockHashes.delete(header.hash);
      for (const cb of this.blockHeaderCallbacks) {
        try {
          const result: unknown = cb({ height: header.height, hex: header.rawHex });
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch(err =>
              this.log(`Block header callback failed: ${err}`)
            );
          }
        } catch (err) {
          this.log(`Block header callback threw: ${err}`);
        }
      }
    }
  }

  // ============================================================================
  // Blocks / transaction keys
  // ============================================================================

  /**
   * Get transaction keys for a range of blocks
   */
  async getBlockTransactionKeysRange(startHeight: number): Promise<{
    blocks: BlockTransactionKeys[];
    nextHeight: number;
  }> {
    const maxBlocks = this.options.maxBlocksPerRequest;
    const wantEnd = startHeight + maxBlocks - 1;
    if (startHeight > this.chainTipHeight || this.tipDirty) {
      await this.syncHeaders();
    }

    const endHeight = Math.min(wantEnd, this.chainTipHeight);
    if (startHeight > endHeight) {
      return { blocks: [], nextHeight: startHeight };
    }

    const heights: number[] = [];
    for (let h = startHeight; h <= endHeight; h++) heights.push(h);

    // Download concurrently (bounded by maxConcurrentBlockRequests inside
    // fetchBlock); keep results in height order.
    const parsed = await Promise.all(heights.map(h => this.fetchBlockAtHeight(h)));

    const blocks: BlockTransactionKeys[] = parsed.map((block, i) => ({
      height: heights[i],
      txKeys: this.extractTransactionKeys(block),
      timestamp: block.timestamp,
      isPoS: block.isPoS,
    }));

    return { blocks, nextHeight: endHeight + 1 };
  }

  /**
   * Get transaction keys for a single block
   */
  async getBlockTransactionKeys(height: number): Promise<TransactionKeys[]> {
    const block = await this.fetchBlockAtHeight(height);
    return this.extractTransactionKeys(block);
  }

  private async fetchBlockAtHeight(height: number): Promise<ParsedBlock> {
    if (height === 0) {
      return this.fetchBlock((await this.getGenesisHeader()).hash);
    }
    let header = this.headersByHeight.get(height);
    if (!header) {
      await this.syncHeaders();
      header = this.headersByHeight.get(height);
    }
    if (!header) {
      throw new Error(`Block height ${height} is beyond the chain tip (${this.chainTipHeight})`);
    }
    return this.fetchBlock(header.hash);
  }

  /**
   * Extract per-transaction BLSCT keys (the shape TransactionKeysSync scans)
   */
  private extractTransactionKeys(block: ParsedBlock): TransactionKeys[] {
    const txKeys: TransactionKeys[] = [];
    for (const tx of block.txs) {
      const outputs = tx.outputs.filter(o => o.keys !== null).map(o => o.keys!);
      if (outputs.length === 0 && tx.inputHashes.length === 0) {
        continue;
      }
      txKeys.push({
        txHash: tx.txid,
        keys: {
          outputs,
          inputs: tx.inputHashes.map(outputHash => ({ outputHash })),
        },
      });
    }
    return txKeys;
  }

  /**
   * Fetch and parse a block by hash (display hex), with caching, dedupe and
   * bounded concurrency
   */
  private async fetchBlock(hashHex: string): Promise<ParsedBlock> {
    const cached = this.blockCache.get(hashHex);
    if (cached) {
      return cached;
    }

    const pending = this.pendingBlocks.get(hashHex);
    if (pending) {
      return pending;
    }

    const promise = (async () => {
      await this.acquireBlockSlot();
      try {
        const msg = await this.client.getBlock(P2PClient.hashFromDisplay(hashHex));
        const block = parseBlock(msg.payload);
        this.rememberBlock(block);
        return block;
      } finally {
        this.releaseBlockSlot();
        this.pendingBlocks.delete(hashHex);
      }
    })();

    this.pendingBlocks.set(hashHex, promise);
    return promise;
  }

  private acquireBlockSlot(): Promise<void> {
    if (this.activeBlockRequests < this.options.maxConcurrentBlockRequests) {
      this.activeBlockRequests++;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.blockRequestQueue.push(() => {
        this.activeBlockRequests++;
        resolve();
      });
    });
  }

  private releaseBlockSlot(): void {
    this.activeBlockRequests--;
    const next = this.blockRequestQueue.shift();
    if (next) next();
  }

  private rememberBlock(block: ParsedBlock): void {
    if (this.blockCache.size >= this.maxBlockCacheSize) {
      const oldest = this.blockCache.keys().next().value;
      if (oldest !== undefined) this.blockCache.delete(oldest);
    }
    this.blockCache.set(block.hash, block);

    const header = this.headersByHash.get(block.hash);
    for (const tx of block.txs) {
      for (const out of tx.outputs) {
        if (out.keys) {
          this.cacheOutputData(out.outputHash, out.serializedHex);
        }
      }
      if (header) {
        this.rememberTxLocation(tx.txid, header.height);
      }
    }
  }

  private rememberTxLocation(txid: string, height: number): void {
    if (this.txLocations.size >= this.options.txLocationCacheSize) {
      const drop = Math.max(1, this.options.txLocationCacheSize >> 4);
      let n = 0;
      for (const key of this.txLocations.keys()) {
        this.txLocations.delete(key);
        if (++n >= drop) break;
      }
    }
    this.txLocations.set(txid, height);
  }

  private cacheOutputData(outputHash: string, serializedHex: string): void {
    if (this.outputDataCache.size >= this.maxOutputDataCacheSize) {
      // Drop the oldest entries (Map preserves insertion order).
      const drop = Math.max(1, this.maxOutputDataCacheSize >> 4);
      let n = 0;
      for (const key of this.outputDataCache.keys()) {
        this.outputDataCache.delete(key);
        if (++n >= drop) break;
      }
    }
    this.outputDataCache.set(outputHash, serializedHex);
  }

  // ============================================================================
  // Transactions / outputs
  // ============================================================================

  /**
   * Get transaction keys for a single transaction (mempool or recent block).
   * Returns `{ txHash, outputs, inputs }` in the same shape as block keys.
   */
  async getTransactionKeys(txHash: string): Promise<any> {
    const tx = await this.fetchTransaction(txHash);
    return {
      txHash: tx.txid,
      outputs: tx.outputs.filter(o => o.keys !== null).map(o => o.keys!),
      inputs: tx.inputHashes.map(outputHash => ({ outputHash })),
    };
  }

  /**
   * Get serialized transaction output by output hash (display hex)
   */
  async getTransactionOutput(outputHash: string): Promise<string> {
    const cached = this.outputDataCache.get(outputHash);
    if (cached) {
      return cached;
    }

    // Output-hash lookup (getdata MSG_WITNESS_TX) answers for mempool /
    // most-recent-block outputs only
    const wanted = outputHash.toLowerCase();
    let parsed: ParsedTransaction | null = null;
    const payload = await this.client.getOutputData(
      Buffer.from(wanted, 'hex').reverse(),
      txPayload => {
        try {
          const tx = parseTransaction(txPayload, 0);
          if (tx.outputs.some(o => o.outputHash === wanted)) {
            parsed = tx;
            return true;
          }
        } catch {
          // not the tx we want
        }
        return false;
      }
    );
    const tx: ParsedTransaction = parsed ?? parseTransaction(payload, 0);
    for (const out of tx.outputs) {
      if (out.keys) {
        this.cacheOutputData(out.outputHash, out.serializedHex);
      }
    }
    const output = tx.outputs.find(o => o.outputHash === wanted);
    if (!output) {
      throw new Error(`Output ${outputHash} not present in returned transaction ${tx.txid}`);
    }
    return output.serializedHex;
  }

  /**
   * Broadcast a transaction.
   *
   * Pushes an unsolicited `tx` message (navio-core accepts these), then
   * confirms mempool acceptance by asking the node for the transaction's
   * first output by output hash: the node answers that lookup straight from
   * its mempool, so a `notfound` means the transaction was rejected.
   */
  async broadcastTransaction(rawTx: string): Promise<string> {
    const txData = Buffer.from(rawTx, 'hex');
    const tx = parseTransaction(txData, 0);
    if (tx.end !== txData.length) {
      throw new Error(`Trailing bytes after transaction (${txData.length - tx.end})`);
    }
    if (tx.outputs.length === 0) {
      throw new Error('Transaction has no outputs');
    }

    this.log(`Broadcasting transaction ${tx.txid}`);
    this.client.sendTransaction(txData);

    // Messages from one peer are processed in order, so this request is
    // answered after the node validated the transaction.
    const probeHash = tx.outputs[0].outputHash;
    let holder: ParsedTransaction | null = null;
    try {
      await this.client.getOutputData(Buffer.from(probeHash, 'hex').reverse(), txPayload => {
        try {
          const candidate = parseTransaction(txPayload, 0);
          if (candidate.outputs.some(o => o.outputHash === probeHash)) {
            holder = candidate;
            return true;
          }
        } catch {
          // not a transaction we can parse
        }
        return false;
      });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg.startsWith('Output not found')) {
        throw new Error(
          `Transaction ${tx.txid} was not accepted by the node's mempool ` +
            '(the P2P protocol does not report the rejection reason; check the node debug log)'
        );
      }
      throw new Error(`Broadcast of ${tx.txid} could not be confirmed: ${msg}`);
    }
    const accepted = holder as ParsedTransaction | null;
    if (accepted && accepted.txid !== tx.txid && accepted.wtxid !== tx.wtxid) {
      throw new Error(
        `Transaction ${tx.txid} was not accepted by the node's mempool: ` +
          `a different transaction (${accepted.txid}) with the same output is already there`
      );
    }

    for (const out of tx.outputs) {
      if (out.keys) {
        this.cacheOutputData(out.outputHash, out.serializedHex);
      }
    }
    return tx.txid;
  }

  /**
   * Get raw transaction by txid (display hex).
   *
   * Served via getdata for mempool / most-recent-block transactions; older
   * confirmed transactions are located through the txid index built while
   * scanning blocks and re-read from the containing block.
   */
  async getRawTransaction(txHash: string, verbose?: boolean): Promise<string | unknown> {
    const tx = await this.fetchTransaction(txHash);
    if (!verbose) {
      return tx.rawHex;
    }
    const height = this.txLocations.get(tx.txid);
    const header = height !== undefined ? this.headersByHeight.get(height) : undefined;
    return {
      txid: tx.txid,
      hash: tx.wtxid,
      hex: tx.rawHex,
      size: tx.rawHex.length / 2,
      version: tx.version,
      ...(height !== undefined ? { height } : {}),
      ...(header ? { blockhash: header.hash } : {}),
      confirmations: height !== undefined ? this.chainTipHeight - height + 1 : 0,
    };
  }

  private async fetchTransaction(txHash: string): Promise<ParsedTransaction> {
    const wanted = txHash.toLowerCase();

    // Fast path: block cache
    for (const block of this.blockCache.values()) {
      const hit = block.txs.find(t => t.txid === wanted);
      if (hit) return hit;
    }

    // getdata: mempool or most recent block
    let parsed: ParsedTransaction | null = null;
    try {
      const payload = await this.client.getTransaction(
        Buffer.from(wanted, 'hex').reverse(),
        txPayload => {
          try {
            const tx = parseTransaction(txPayload, 0);
            if (tx.txid === wanted || tx.wtxid === wanted) {
              parsed = tx;
              return true;
            }
          } catch {
            // not the tx we want
          }
          return false;
        }
      );
      return parsed ?? parseTransaction(payload, 0);
    } catch (err: any) {
      if (!String(err?.message ?? err).startsWith('Transaction not found')) {
        throw err;
      }
    }

    // Confirmed transaction: re-read its block
    const height = this.txLocations.get(wanted);
    if (height === undefined) {
      throw new Error(
        `Transaction ${txHash} not found: not in the node's mempool or most recent block, ` +
          'and not in a block scanned by this provider'
      );
    }
    const block = await this.fetchBlockAtHeight(height);
    const hit = block.txs.find(t => t.txid === wanted);
    if (!hit) {
      throw new Error(`Transaction ${txHash} not found in block ${height} (reorg?)`);
    }
    return hit;
  }
}
