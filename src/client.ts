/**
 * Navio SDK Client
 * Main client class for interacting with the Navio blockchain
 *
 * This is the primary entry point for the SDK. It manages:
 * - Wallet database connection
 * - Backend connection (Electrum or P2P)
 * - Transaction keys synchronization
 * - Key management
 */

import { WalletDB, WalletDBOptions } from './wallet-db';
import { ElectrumClient, ElectrumOptions } from './electrum';
import { TransactionKeysSync, SyncOptions, BackgroundSyncOptions } from './tx-keys-sync';
import { KeyManager } from './key-manager';
import type { IWalletDB, WalletOutput } from './wallet-db.interface';
import { SyncProvider } from './sync-provider';
import { P2PSyncProvider } from './p2p-sync';
import { P2PConnectionOptions } from './p2p-protocol';
import { ElectrumSyncProvider } from './electrum-sync';
import * as blsctModule from 'navio-blsct';
import { BlsctChain, setChain } from 'navio-blsct';
import { sha256 } from '@noble/hashes/sha256';
import type { DatabaseAdapterType } from './database-adapter';

const {
  Scalar, PublicKey, SubAddr,
  Address, TokenId, CTxId, OutPoint, TxIn, TxOut,
  TxOutputType, PrivSpendingKey,
  CTx, UnsignedInput, UnsignedOutput, UnsignedTransaction,
  TokenInfo, TokenType,
  calcCollectionTokenHashHex, deriveCollectionTokenKeyFromMaster, deriveCollectionTokenPublicKeyFromMaster,
  buildCTx, createTxInVec, addToTxInVec, createTxOutVec, addToTxOutVec,
  deleteTxInVec, deleteTxOutVec, freeObj, getCTxId, serializeCTx,
} = blsctModule as any;

/**
 * Build a confidential transaction and return its serialized hex.
 * Uses serializeCTx + getCTxId from navio-blsct (works in both Node and WASM).
 */
function buildAndSerializeCTx(
  txIns: InstanceType<typeof TxIn>[],
  txOuts: InstanceType<typeof TxOut>[],
): { rawTx: string; txId: string } {
  const txInVec = createTxInVec();
  for (const txIn of txIns) addToTxInVec(txInVec, txIn.value());
  const txOutVec = createTxOutVec();
  for (const txOut of txOuts) addToTxOutVec(txOutVec, txOut.value());

  const rv = buildCTx(txInVec, txOutVec);

  if (rv.result !== 0) {
    deleteTxInVec(txInVec);
    deleteTxOutVec(txOutVec);
    const msg = `building tx failed. Error code = ${rv.result}`;
    freeObj(rv);
    throw new Error(msg);
  }

  const ctxPtr = rv.ctx;
  freeObj(rv);

  const rawTx: string = serializeCTx(ctxPtr);
  const txId: string = getCTxId(ctxPtr);

  deleteTxInVec(txInVec);
  deleteTxOutVec(txOutVec);

  return { rawTx, txId };
}

/**
 * Network type for Navio
 */
export type NetworkType = 'mainnet' | 'testnet' | 'signet' | 'regtest';

/**
 * Fee per input+output in satoshis (matches navio-core default)
 */
const DEFAULT_FEE_PER_COMPONENT = 200_000;
const TOKEN_HASH_HEX_LENGTH = 64;
const TOKEN_ID_HEX_LENGTH = 80;
const TOKEN_ID_SUBID_HEX_LENGTH = 16;
const TOKEN_ID_NO_SUBID_HEX = 'f'.repeat(TOKEN_ID_SUBID_HEX_LENGTH);
const DEFAULT_NAV_TOKEN_HASH_HEX = '0'.repeat(TOKEN_HASH_HEX_LENGTH);
const DEFAULT_NAV_STORED_TOKEN_ID_HEX = DEFAULT_NAV_TOKEN_HASH_HEX + TOKEN_ID_NO_SUBID_HEX;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const BLSCT_DEFAULT_FEE_RATE = 125n;

/**
 * Options for sending a transaction
 */
export interface SendTransactionOptions {
  /** Destination address (bech32m encoded) */
  address: string;
  /** Amount to send in satoshis */
  amount: bigint;
  /** Optional memo to include in the output */
  memo?: string;
  /** Whether to subtract the fee from the sent amount (default: false) */
  subtractFeeFromAmount?: boolean;
  /** Optional token ID (null for NAV) */
  tokenId?: string | null;
  /**
   * Optional list of specific UTXOs to use as inputs.
   * Each entry must be an outputHash of an unspent, confirmed output.
   * When provided, automatic UTXO selection is skipped.
   */
  selectedUtxos?: string[];
}

/**
 * A single recipient when sending NAV to multiple destinations.
 */
export interface SendRecipient {
  /** Destination address (bech32m encoded) */
  address: string;
  /** Amount to send to this recipient in satoshis */
  amount: bigint;
  /** Optional memo to include in this output */
  memo?: string;
  /**
   * Whether this recipient should pay (a share of) the fee.
   * When set on multiple recipients, the fee is split evenly among them
   * (any rounding remainder is absorbed by the first such recipient).
   * Defaults to false.
   */
  subtractFeeFromAmount?: boolean;
}

/**
 * Options for sending NAV to multiple destinations in a single transaction.
 *
 * All recipients share the same set of selected/auto-selected NAV inputs
 * and a single optional change output. Token/NFT sends are not supported
 * by this helper – use `sendToken`/`sendNft` for those.
 */
export interface SendToManyOptions {
  /** One or more destinations to receive NAV. Must be non-empty. */
  recipients: SendRecipient[];
  /**
   * Optional list of specific UTXOs to use as inputs.
   * Each entry must be an outputHash of an unspent, confirmed NAV output.
   * When provided, automatic UTXO selection is skipped.
   */
  selectedUtxos?: string[];
}

/**
 * Options for sending a fungible token.
 */
export interface SendTokenOptions extends Omit<SendTransactionOptions, 'tokenId'> {
  /**
   * Token ID to spend.
   * Accepts either:
   * - a 64-hex collection token hash from navio-core RPCs, or
   * - an 80-hex token ID in the same byte order (`token hash || subid`).
   */
  tokenId: string;
}

/**
 * Options for sending a single NFT.
 */
export interface SendNftOptions extends Omit<SendTransactionOptions, 'tokenId' | 'amount' | 'subtractFeeFromAmount'> {
  /**
   * Full 80-hex NFT token ID in navio-core/RPC byte order.
   * Optional when `collectionTokenId` + `nftId` are provided.
   */
  tokenId?: string;
  /**
   * Collection token ID.
   * Accepts either:
   * - a 64-hex collection token hash from navio-core RPCs, or
   * - an 80-hex token ID with `ffffffffffffffff` as the subid suffix.
   */
  collectionTokenId?: string;
  /** NFT id within the collection. Required with `collectionTokenId`. */
  nftId?: bigint | number;
}

export type TokenMetadata = Record<string, string>;

export interface CreateTokenCollectionOptions {
  /** Metadata embedded in the collection predicate. */
  metadata?: TokenMetadata;
  /** Maximum total supply allowed for the collection. */
  totalSupply: bigint | number;
  /** Optional NAV UTXOs to fund the transaction fee. */
  selectedUtxos?: string[];
}

export interface CreateNftCollectionOptions {
  /** Metadata embedded in the collection predicate. */
  metadata?: TokenMetadata;
  /** Optional maximum total supply recorded for the collection. Defaults to 0. */
  totalSupply?: bigint | number;
  /** Optional NAV UTXOs to fund the transaction fee. */
  selectedUtxos?: string[];
}

export interface MintTokenOptions {
  /** Destination address receiving the minted fungible token output. */
  address: string;
  /** Collection token ID or collection token hash. */
  collectionTokenId: string;
  /** Amount of fungible tokens to mint. */
  amount: bigint | number;
  /** Optional NAV UTXOs to fund the transaction fee. */
  selectedUtxos?: string[];
}

export interface MintNftOptions {
  /** Destination address receiving the minted NFT. */
  address: string;
  /** Collection token ID or collection token hash. */
  collectionTokenId: string;
  /** NFT sub-id within the collection. */
  nftId: bigint | number;
  /** Metadata embedded in the mint predicate. */
  metadata?: TokenMetadata;
  /** Optional NAV UTXOs to fund the transaction fee. */
  selectedUtxos?: string[];
}

/**
 * Result of a sent transaction
 */
export interface SendTransactionResult {
  /** Transaction ID (hex) */
  txId: string;
  /** Serialized transaction (hex) */
  rawTx: string;
  /** Fee paid in satoshis */
  fee: bigint;
  /** Inputs used */
  inputCount: number;
  /** Outputs created (including change) */
  outputCount: number;
}

export interface AggregateTransactionsResult {
  /** Transaction ID (hex) of the aggregated transaction */
  txId: string;
  /** Serialized aggregated transaction (hex) */
  rawTx: string;
  /** Total inputs in the aggregated transaction */
  inputCount: number;
  /** Total outputs in the aggregated transaction */
  outputCount: number;
}

export type WalletAssetKind = 'token' | 'nft';

/**
 * Current balance summary for a wallet-owned asset.
 */
export interface WalletAssetBalance {
  /** Asset token ID */
  tokenId: string;
  /** Asset type derived from token ID shape */
  kind: WalletAssetKind;
  /** Current unspent balance for this asset */
  balance: bigint;
  /** Number of unspent outputs contributing to the balance */
  outputCount: number;
  /** Collection token ID for NFTs, otherwise null */
  collectionTokenId: string | null;
  /** NFT sub-id for NFTs, otherwise null */
  nftId: bigint | null;
}

export interface CreateCollectionResult extends SendTransactionResult {
  /** Asset type for the created collection. */
  kind: WalletAssetKind;
  /** Collection token ID in navio-core/RPC byte order. */
  collectionTokenId: string;
  /** Derived collection token public key. */
  tokenPublicKey: string;
}

export interface MintAssetResult extends SendTransactionResult {
  /** Asset type for the minted output. */
  kind: WalletAssetKind;
  /** Collection token ID in navio-core/RPC byte order. */
  collectionTokenId: string;
  /** Token ID of the minted asset in navio-core/RPC byte order. */
  tokenId: string;
  /** Derived collection token public key. */
  tokenPublicKey: string;
}

function reverseHexBytes(hex: string): string {
  if (hex.length % 2 !== 0) {
    throw new Error('Hex string must have an even length');
  }

  const bytes = hex.match(/../g);
  if (!bytes) {
    return '';
  }
  return bytes.reverse().join('');
}

function normalizeHex(tokenIdHex: string): string {
  const normalized = tokenIdHex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized)) {
    throw new Error('Token ID must be hexadecimal');
  }
  return normalized;
}

function normalizePublicTokenIdHex(tokenIdHex: string): string {
  const normalized = normalizeHex(tokenIdHex);
  if (normalized.length === TOKEN_HASH_HEX_LENGTH) {
    return normalized;
  }
  if (normalized.length !== TOKEN_ID_HEX_LENGTH) {
    throw new Error(`Invalid tokenId length: expected ${TOKEN_HASH_HEX_LENGTH} or ${TOKEN_ID_HEX_LENGTH} hex chars`);
  }
  const tokenHashHex = normalized.slice(0, TOKEN_HASH_HEX_LENGTH);
  const subidHex = normalized.slice(TOKEN_HASH_HEX_LENGTH);
  return subidHex === TOKEN_ID_NO_SUBID_HEX ? tokenHashHex : normalized;
}

function normalizeStoredTokenIdHex(tokenIdHex: string): string {
  const normalized = normalizeHex(tokenIdHex);
  if (normalized.length === TOKEN_ID_HEX_LENGTH) {
    return normalized;
  }
  if (normalized.length === 128) {
    return normalized.slice(0, TOKEN_ID_HEX_LENGTH);
  }
  throw new Error(`Invalid stored tokenId length: expected ${TOKEN_ID_HEX_LENGTH} or 128 hex chars`);
}

function publicToStoredTokenIdHex(tokenIdHex: string): string {
  const normalized = normalizePublicTokenIdHex(tokenIdHex);
  const fullTokenId = normalized.length === TOKEN_HASH_HEX_LENGTH
    ? normalized + TOKEN_ID_NO_SUBID_HEX
    : normalized;
  return reverseHexBytes(fullTokenId.slice(0, TOKEN_HASH_HEX_LENGTH)) + fullTokenId.slice(TOKEN_HASH_HEX_LENGTH);
}

function storedToPublicTokenIdHex(tokenIdHex: string): string {
  const normalized = normalizeStoredTokenIdHex(tokenIdHex);
  const tokenHashHex = reverseHexBytes(normalized.slice(0, TOKEN_HASH_HEX_LENGTH));
  const subidHex = normalized.slice(TOKEN_HASH_HEX_LENGTH);
  return subidHex === TOKEN_ID_NO_SUBID_HEX ? tokenHashHex : tokenHashHex + subidHex;
}

function normalizeTokenIdHex(tokenIdHex: string): string {
  return normalizePublicTokenIdHex(tokenIdHex);
}

function getTokenIdCandidates(tokenIdHex: string): string[] {
  const normalized = normalizeHex(tokenIdHex);
  if (normalized.length === TOKEN_HASH_HEX_LENGTH) {
    return [normalizePublicTokenIdHex(normalized)];
  }

  if (normalized.length !== TOKEN_ID_HEX_LENGTH) {
    throw new Error(`Invalid tokenId length: expected ${TOKEN_HASH_HEX_LENGTH} or ${TOKEN_ID_HEX_LENGTH} hex chars`);
  }

  const publicCandidate = normalizePublicTokenIdHex(normalized);
  const legacySerializedCandidate = storedToPublicTokenIdHex(normalized);
  return legacySerializedCandidate === publicCandidate
    ? [publicCandidate]
    : [publicCandidate, legacySerializedCandidate];
}

function toPublicTokenId(tokenIdHex: string | null): string | null {
  if (tokenIdHex === null) {
    return null;
  }

  const normalizedStoredTokenId = normalizeStoredTokenIdHex(tokenIdHex);
  if (normalizedStoredTokenId === DEFAULT_NAV_STORED_TOKEN_ID_HEX) {
    return null;
  }

  const publicTokenId = storedToPublicTokenIdHex(normalizedStoredTokenId);
  return publicTokenId === DEFAULT_NAV_TOKEN_HASH_HEX ? null : publicTokenId;
}

function encodeUint64LEHex(value: bigint): string {
  if (value < 0n || value > MAX_UINT64) {
    throw new Error(`NFT id must be between 0 and ${MAX_UINT64.toString()}`);
  }

  let remaining = value;
  let hex = '';
  for (let i = 0; i < 8; i++) {
    hex += Number(remaining & 0xffn).toString(16).padStart(2, '0');
    remaining >>= 8n;
  }
  return hex;
}

function composeNftTokenId(collectionTokenIdHex: string, nftId: bigint | number): string {
  const collectionTokenId = normalizeTokenIdHex(collectionTokenIdHex);
  const normalizedNftId = typeof nftId === 'bigint' ? nftId : BigInt(nftId);
  const tokenHashHex = collectionTokenId.slice(0, TOKEN_HASH_HEX_LENGTH);
  return tokenHashHex + encodeUint64LEHex(normalizedNftId);
}

function describeTokenId(tokenIdHex: string): Pick<WalletAssetBalance, 'kind' | 'collectionTokenId' | 'nftId'> {
  const normalizedTokenId = normalizeTokenIdHex(tokenIdHex);
  if (normalizedTokenId.length === TOKEN_HASH_HEX_LENGTH) {
    return {
      kind: 'token',
      collectionTokenId: normalizedTokenId,
      nftId: null,
    };
  }

  const subidHex = normalizedTokenId.slice(TOKEN_ID_HEX_LENGTH - TOKEN_ID_SUBID_HEX_LENGTH);

  if (subidHex === TOKEN_ID_NO_SUBID_HEX) {
    return {
      kind: 'token',
      collectionTokenId: normalizedTokenId.slice(0, TOKEN_HASH_HEX_LENGTH),
      nftId: null,
    };
  }

  const nftIdBytes = Buffer.from(subidHex, 'hex');
  const nftId = nftIdBytes.reduceRight((acc, byte) => (acc << 8n) + BigInt(byte), 0n);

  return {
    kind: 'nft',
    collectionTokenId: normalizedTokenId.slice(0, TOKEN_HASH_HEX_LENGTH),
    nftId,
  };
}

function normalizeCollectionTokenHashHex(tokenIdHex: string): string {
  const normalizedTokenId = normalizeTokenIdHex(tokenIdHex);
  const tokenInfo = describeTokenId(normalizedTokenId);
  if (tokenInfo.kind !== 'token' || !tokenInfo.collectionTokenId) {
    throw new Error('collectionTokenId must reference a fungible collection token hash.');
  }
  return tokenInfo.collectionTokenId;
}

function normalizeTokenMetadata(metadata?: TokenMetadata): TokenMetadata {
  if (!metadata) {
    return {};
  }

  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => {
    if (typeof value !== 'string') {
      throw new Error(`Metadata value for "${key}" must be a string.`);
    }
    return [key, value];
  }));
}

function toSafeInteger(value: bigint | number, fieldName: string): number {
  const bigintValue = typeof value === 'bigint' ? value : BigInt(value);

  if (bigintValue < 0n) {
    throw new Error(`${fieldName} must be non-negative`);
  }
  if (bigintValue > MAX_SAFE_INTEGER_BIGINT) {
    throw new Error(`${fieldName} exceeds JavaScript's safe integer range`);
  }

  return Number(bigintValue);
}

function mapOutputToPublic(output: WalletOutput): WalletOutput {
  let tokenId = output.tokenId;
  try {
    tokenId = toPublicTokenId(output.tokenId);
  } catch {
    tokenId = output.tokenId;
  }

  return {
    ...output,
    tokenId,
  };
}

function resolveRequestedTokenId(tokenIdHex: string, outputs: readonly Pick<WalletOutput, 'tokenId'>[]): string {
  const candidates = getTokenIdCandidates(tokenIdHex);
  if (candidates.length === 1) {
    return candidates[0];
  }

  const matchedCandidates = candidates.filter((candidate) =>
    outputs.some((output) => output.tokenId === candidate)
  );

  return matchedCandidates.length === 1 ? matchedCandidates[0] : candidates[0];
}

/**
 * Backend type for NavioClient
 */
export type BackendType = 'electrum' | 'p2p';

/**
 * P2P connection options for NavioClient
 */
export interface P2POptions extends P2PConnectionOptions {
  /** Maximum headers to fetch per request */
  maxHeadersPerRequest?: number;
}

/**
 * Configuration for NavioClient
 */
export interface NavioClientConfig {
  /** Path to wallet database file */
  walletDbPath: string;

  /**
   * Database adapter type to use for wallet storage.
   * - 'indexeddb' / 'browser': Native IndexedDB (used automatically in browsers)
   * - 'better-sqlite3': Node.js native SQLite (use ':memory:' path for testing)
   * 
   * If not specified, auto-detected: IndexedDB in browsers, better-sqlite3 in Node.js.
   */
  databaseAdapter?: DatabaseAdapterType;

  /**
   * Backend type to use for synchronization
   * - 'electrum': Connect to an Electrum server (recommended for wallets)
   * - 'p2p': Connect directly to a Navio full node
   * @default 'electrum'
   */
  backend?: BackendType;

  /**
   * Electrum server connection options
   * Required when backend is 'electrum'
   */
  electrum?: ElectrumOptions;

  /**
   * P2P connection options
   * Required when backend is 'p2p'
   */
  p2p?: P2POptions;

  /** Create wallet if it doesn't exist (default: false) */
  createWalletIfNotExists?: boolean;

  /** Restore wallet from seed (hex string) */
  restoreFromSeed?: string;

  /** Restore wallet from mnemonic phrase (24 words) */
  restoreFromMnemonic?: string;

  /**
   * Restore a watch-only wallet from a BLSCT audit key.
   * Format matches navio-core getblsctauditkey / IMPORT_VIEW_KEY:
   * 32-byte private view key || 48-byte public spending key.
   */
  restoreFromAuditKey?: string;

  /**
   * Block height to start scanning from when restoring a wallet from seed, mnemonic, or audit key.
   * This is the height when the wallet was originally created.
   * Setting this avoids scanning blocks before the wallet existed.
   *
   * Note: This option is only used when a restore input is provided.
   * For newly created wallets, the creation height is automatically set
   * to the current chain tip minus a safety margin (100 blocks).
   *
   * @default 0 (scan from genesis when restoring)
   */
  restoreFromHeight?: number;

  /**
   * Override the creation height for newly created wallets.
   * By default, new wallets use `chainTip - 100` to avoid scanning old blocks.
   * Set this to 0 to sync from genesis (useful for testing).
   *
   * Note: This is only used when `createWalletIfNotExists` is true and
   * no wallet exists. It does NOT override `restoreFromHeight` when
   * restoring from seed.
   */
  creationHeight?: number;

  /**
   * Network to use for address encoding/decoding and cryptographic operations.
   * This configures the navio-blsct library to use the correct chain parameters.
   *
   * @default 'mainnet'
   */
  network?: NetworkType;
}

/**
 * Navio SDK Client
 * Main client for wallet operations and blockchain synchronization.
 *
 * Supports two backend types:
 * - Electrum: Connect to an Electrum server (recommended for light wallets)
 * - P2P: Connect directly to a Navio full node (for advanced use cases)
 *
 * @example
 * // Using Electrum backend (recommended)
 * const client = new NavioClient({
 *   walletDbPath: './wallet.db',
 *   backend: 'electrum',
 *   electrum: { host: 'electrum.example.com', port: 50001, ssl: true }
 * });
 *
 * @example
 * // Using P2P backend
 * const client = new NavioClient({
 *   walletDbPath: './wallet.db',
 *   backend: 'p2p',
 *   p2p: { host: '127.0.0.1', port: 44440, network: 'mainnet' }
 * });
 *
 * @category Client
 */
export class NavioClient {
  private walletDB: IWalletDB | null = null;
  private syncProvider: SyncProvider;
  private syncManager: TransactionKeysSync | null = null;
  private keyManager: KeyManager | null = null;
  private config: NavioClientConfig;
  private initialized = false;

  // Legacy: keep electrumClient reference for backwards compatibility
  private electrumClient: ElectrumClient | null = null;

  // Background sync state
  private backgroundSyncTimer: ReturnType<typeof setInterval> | null = null;
  private backgroundSyncOptions: BackgroundSyncOptions | null = null;
  private isBackgroundSyncing = false;
  private isSyncInProgress = false;
  private lastKnownBalance: bigint = 0n;

  // Block header subscription callback (for unsubscribe)
  private blockHeaderCallback: ((header: { height: number; hex: string }) => void) | null = null;
  private usingSubscriptions = false;

  /**
   * Create a new NavioClient instance
   * @param config - Client configuration
   */
  constructor(config: NavioClientConfig) {
    // Handle legacy config (just electrum, no backend specified)
    if ('electrum' in config && !('backend' in config)) {
      this.config = {
        ...config,
        backend: 'electrum',
      };
    } else {
      this.config = config as NavioClientConfig;
    }

    // Default to electrum if no backend specified
    this.config.backend = this.config.backend || 'electrum';

    // Default to mainnet if no network specified
    this.config.network = this.config.network || 'mainnet';

    // Configure navio-blsct for the correct network
    NavioClient.configureNetwork(this.config.network);

    // Validate config
    if (this.config.backend === 'electrum' && !this.config.electrum) {
      throw new Error('Electrum options required when backend is "electrum"');
    }
    if (this.config.backend === 'p2p' && !this.config.p2p) {
      throw new Error('P2P options required when backend is "p2p"');
    }
    const restoreSources = [
      this.config.restoreFromSeed,
      this.config.restoreFromMnemonic,
      this.config.restoreFromAuditKey,
    ].filter((value) => value !== undefined);
    if (restoreSources.length > 1) {
      throw new Error('Specify only one of restoreFromSeed, restoreFromMnemonic, or restoreFromAuditKey');
    }

    // Create sync provider based on backend type
    if (this.config.backend === 'p2p') {
      this.syncProvider = new P2PSyncProvider(this.config.p2p!);
    } else {
      // Electrum backend
      this.electrumClient = new ElectrumClient(this.config.electrum!);
      this.syncProvider = new ElectrumSyncProvider(this.config.electrum!);
    }

    // Note: WalletDB and SyncManager are created in initialize() since open() is async
  }

  /**
   * Parse the walletDbPath and determine adapter options
   */
  private getWalletDbOptions(): { path: string; options: WalletDBOptions } {
    const path = this.config.walletDbPath;
    const options: WalletDBOptions = {};

    // Use explicit adapter type if specified
    if (this.config.databaseAdapter) {
      options.type = this.config.databaseAdapter;
    }

    return { path, options };
  }

  /**
   * Configure the navio-blsct library for the specified network
   */
  private static configureNetwork(network: NetworkType): void {
    const chainMap: Record<NetworkType, BlsctChain> = {
      mainnet: BlsctChain.Mainnet,
      testnet: BlsctChain.Testnet,
      signet: BlsctChain.Signet,
      regtest: BlsctChain.Regtest,
    };

    setChain(chainMap[network]);
  }

  /**
   * Get the current network configuration
   */
  getNetwork(): NetworkType {
    return this.config.network || 'mainnet';
  }

  /**
   * Safety margin (in blocks) when setting creation height for new wallets.
   * This ensures we don't miss any transactions that might be in recent blocks.
   */
  private static readonly CREATION_HEIGHT_MARGIN = 100;

  /**
   * Initialize the client
   * Loads or creates wallet, connects to backend, and initializes sync manager
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Create and open WalletDB
    // Browser environments use IndexedDB (no WASM needed).
    // Node.js environments use the SQL adapter (better-sqlite3).
    const adapterType = this.config.databaseAdapter;
    const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
    const useIndexedDB = adapterType === 'indexeddb'
      || adapterType === 'browser'
      || (!adapterType && isBrowser);

    if (useIndexedDB) {
      const { IndexedDBWalletDB } = await import('./adapters/indexeddb-wallet-db');
      this.walletDB = new IndexedDBWalletDB();
      await this.walletDB.open(this.config.walletDbPath);
    } else {
      const { path, options } = this.getWalletDbOptions();
      this.walletDB = new WalletDB(options);
      await this.walletDB.open(path);
    }

    // Create sync manager now that WalletDB is ready
    this.syncManager = new TransactionKeysSync(this.walletDB, this.syncProvider);

    // Load or create wallet
    if (this.config.restoreFromSeed) {
      // Restore from seed with user-provided height (or 0 to scan from genesis)
      this.keyManager = await this.walletDB.restoreWallet(
        this.config.restoreFromSeed,
        this.config.restoreFromHeight
      );

      // Set KeyManager for sync manager (enables output detection)
      this.syncManager.setKeyManager(this.keyManager);

      // Connect to backend
      await this.syncProvider.connect();
    } else if (this.config.restoreFromMnemonic) {
      // Restore from mnemonic with user-provided height (or 0 to scan from genesis)
      this.keyManager = await this.walletDB.restoreWalletFromMnemonic(
        this.config.restoreFromMnemonic,
        this.config.restoreFromHeight
      );

      // Set KeyManager for sync manager (enables output detection)
      this.syncManager.setKeyManager(this.keyManager);

      // Connect to backend
      await this.syncProvider.connect();
    } else if (this.config.restoreFromAuditKey) {
      // Restore watch-only wallet from audit key with user-provided height (or 0 to scan from genesis)
      this.keyManager = await this.walletDB.restoreWalletFromAuditKey(
        this.config.restoreFromAuditKey,
        this.config.restoreFromHeight
      );

      // Set KeyManager for sync manager (enables output detection)
      this.syncManager.setKeyManager(this.keyManager);

      // Connect to backend
      await this.syncProvider.connect();
    } else {
      // Try to load existing wallet
      let walletLoaded = false;
      try {
        this.keyManager = await this.walletDB.loadWallet();
        walletLoaded = true;
      } catch {
        // Wallet doesn't exist in the database
      }

      if (walletLoaded) {
        this.syncManager.setKeyManager(this.keyManager!);
        await this.syncProvider.connect();
      } else if (this.config.createWalletIfNotExists) {
        // Determine creation height
        let creationHeight: number;

        if (this.config.creationHeight !== undefined) {
          creationHeight = this.config.creationHeight;
        } else {
          await this.syncProvider.connect();
          const chainTip = await this.syncProvider.getChainTipHeight();
          creationHeight = Math.max(0, chainTip - NavioClient.CREATION_HEIGHT_MARGIN);
        }

        this.keyManager = await this.walletDB.createWallet(creationHeight);
        this.syncManager.setKeyManager(this.keyManager);
      } else {
        throw new Error(
          `Wallet not found at ${this.config.walletDbPath}. ` +
            `Set createWalletIfNotExists: true to create a new wallet.`
        );
      }
    }

    // Initialize sync manager
    await this.syncManager.initialize();

    this.initialized = true;
  }

  /**
   * Get the backend type being used
   */
  getBackendType(): BackendType {
    return this.config.backend || 'electrum';
  }

  /**
   * Get the sync provider
   */
  getSyncProvider(): SyncProvider {
    return this.syncProvider;
  }

  /**
   * Get the KeyManager instance
   * @returns KeyManager instance
   */
  getKeyManager(): KeyManager {
    if (!this.keyManager) {
      throw new Error('Client not initialized. Call initialize() first.');
    }
    return this.keyManager;
  }

  /**
   * Export the BLSCT audit key as hex.
   * Format matches navio-core getblsctauditkey / IMPORT_VIEW_KEY payload:
   *   32-byte private view key || 48-byte public spending key
   */
  getAuditKeyHex(): string {
    return this.getKeyManager().getAuditKeyHex();
  }

  /**
   * Backward-compatible alias for the audit key export.
   * @deprecated Use getAuditKeyHex()
   */
  getWalletViewKeyHex(): string {
    return this.getAuditKeyHex();
  }

  /**
   * Get the WalletDB instance
   * @returns WalletDB instance (WalletDB or IndexedDBWalletDB)
   */
  getWalletDB(): IWalletDB {
    if (!this.walletDB) {
      throw new Error('Client not initialized. Call initialize() first.');
    }
    return this.walletDB;
  }

  /**
   * Get the ElectrumClient instance (only available when using electrum backend)
   * @returns ElectrumClient instance or null if using P2P backend
   * @deprecated Use getSyncProvider() instead for backend-agnostic code
   */
  getElectrumClient(): ElectrumClient | null {
    return this.electrumClient;
  }

  /**
   * Get the TransactionKeysSync instance
   * @returns TransactionKeysSync instance
   */
  getSyncManager(): TransactionKeysSync {
    if (!this.syncManager) {
      throw new Error('Client not initialized. Call initialize() first.');
    }
    return this.syncManager;
  }

  /**
   * Synchronize transaction keys from the backend.
   * 
   * By default, syncs once to the current chain tip and returns.
   * Use `startBackgroundSync()` to enable continuous synchronization.
   * 
   * @param options - Sync options
   * @returns Number of transaction keys synced
   */
  async sync(options?: SyncOptions): Promise<number> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.syncManager) {
      throw new Error('Client not initialized');
    }
    return this.syncManager.sync(options || {});
  }

  // ============================================================
  // Background Sync Methods
  // ============================================================

  /**
   * Start continuous background synchronization.
   * 
   * The client will poll for new blocks and automatically sync new transactions.
   * Callbacks are invoked for new blocks, transactions, and balance changes.
   * 
   * @param options - Background sync options
   * 
   * @example
   * ```typescript
   * await client.startBackgroundSync({
   *   pollInterval: 10000, // Check every 10 seconds
   *   onNewBlock: (height) => console.log(`New block: ${height}`),
   *   onBalanceChange: (newBal, oldBal) => {
   *     console.log(`Balance changed: ${Number(oldBal)/1e8} -> ${Number(newBal)/1e8} NAV`);
   *   },
   *   onError: (err) => console.error('Sync error:', err),
   * });
   * ```
   */
  async startBackgroundSync(options: BackgroundSyncOptions = {}): Promise<void> {
    if (this.isBackgroundSyncing) {
      return; // Already running
    }

    if (!this.initialized) {
      await this.initialize();
    }

    this.backgroundSyncOptions = {
      pollInterval: options.pollInterval ?? 10000,
      ...options,
    };
    this.isBackgroundSyncing = true;

    // Get initial balance
    this.lastKnownBalance = await this.getBalance();

    // Perform initial sync to tip
    await this.performBackgroundSync();

    // Try to use subscriptions if available (Electrum backend supports this)
    if (this.syncProvider.subscribeBlockHeaders) {
      try {
        // Create callback for block notifications
        this.blockHeaderCallback = async (_header: { height: number; hex: string }) => {
          // New block received - trigger sync
          await this.performBackgroundSync();
        };

        // Subscribe to block headers
        await this.syncProvider.subscribeBlockHeaders(this.blockHeaderCallback);
        this.usingSubscriptions = true;

        // Still use polling as backup, but with longer interval when using subscriptions
        // This handles cases where subscription notifications might be missed
        const backupInterval = Math.max(this.backgroundSyncOptions.pollInterval! * 3, 30000);
        this.backgroundSyncTimer = setInterval(async () => {
          await this.performBackgroundSync();
        }, backupInterval);

        return;
      } catch (error) {
        // Subscription failed, fall back to polling
        console.warn('Block header subscription failed, falling back to polling:', error);
        this.usingSubscriptions = false;
        this.blockHeaderCallback = null;
      }
    }

    // Polling-based sync (for P2P backend or when subscriptions fail)
    this.backgroundSyncTimer = setInterval(async () => {
      await this.performBackgroundSync();
    }, this.backgroundSyncOptions.pollInterval!);
  }

  /**
   * Stop background synchronization.
   */
  stopBackgroundSync(): void {
    // Stop polling timer
    if (this.backgroundSyncTimer) {
      clearInterval(this.backgroundSyncTimer);
      this.backgroundSyncTimer = null;
    }

    // Unsubscribe from block headers if using subscriptions
    if (this.usingSubscriptions && this.blockHeaderCallback && this.syncProvider.unsubscribeBlockHeaders) {
      this.syncProvider.unsubscribeBlockHeaders(this.blockHeaderCallback);
    }

    this.blockHeaderCallback = null;
    this.usingSubscriptions = false;
    this.isBackgroundSyncing = false;
    this.backgroundSyncOptions = null;
  }

  /**
   * Check if background sync is running.
   * @returns True if background sync is active
   */
  isBackgroundSyncActive(): boolean {
    return this.isBackgroundSyncing;
  }

  /**
   * Check if background sync is using real-time subscriptions.
   * When true, the client receives instant notifications on new blocks.
   * When false, the client uses polling at the configured interval.
   * @returns True if using subscriptions
   */
  isUsingSubscriptions(): boolean {
    return this.usingSubscriptions;
  }

  /**
   * Perform a single background sync cycle.
   * Called by the polling timer.
   */
  private async performBackgroundSync(): Promise<void> {
    if (this.isSyncInProgress) {
      return; // Skip if sync already in progress
    }

    this.isSyncInProgress = true;
    const opts = this.backgroundSyncOptions;

    try {
      // Check if we need to sync
      const needsSync = await this.isSyncNeeded();
      const chainTip = await this.syncProvider.getChainTipHeight();
      const lastSynced = this.getLastSyncedHeight();

      if (!needsSync) {
        // Fire onProgress once so callers know the current state
        if (opts?.onProgress) {
          opts.onProgress(lastSynced, chainTip, 0, 0, false);
        }
        this.isSyncInProgress = false;
        return;
      }

      // Sync to tip
      if (!this.syncManager) {
        throw new Error('Client not initialized');
      }
      await this.syncManager.sync({
        onProgress: opts?.onProgress,
        saveInterval: opts?.saveInterval,
        verifyHashes: opts?.verifyHashes,
        keepTxKeys: opts?.keepTxKeys,
        blockHashRetention: opts?.blockHashRetention,
        stopOnReorg: false,
      });

      // Notify of new block(s) if we synced past our last known height
      if (opts?.onNewBlock && chainTip > lastSynced) {
        // Get the block hash for the tip
        try {
          const headerHex = await this.syncProvider.getBlockHeader(chainTip);
          const hash = this.hashBlockHeader(headerHex);
          opts.onNewBlock(chainTip, hash);
        } catch {
          opts.onNewBlock(chainTip, '');
        }
      }

      // Check for balance change
      if (opts?.onBalanceChange) {
        const newBalance = await this.getBalance();
        if (newBalance !== this.lastKnownBalance) {
          opts.onBalanceChange(newBalance, this.lastKnownBalance);
          this.lastKnownBalance = newBalance;
        }
      }

    } catch (error) {
      if (opts?.onError) {
        opts.onError(error as Error);
      }
    } finally {
      this.isSyncInProgress = false;
    }
  }

  /**
   * Check if synchronization is needed
   * @returns True if sync is needed
   */
  async isSyncNeeded(): Promise<boolean> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.syncManager) {
      throw new Error('Client not initialized');
    }
    return this.syncManager.isSyncNeeded();
  }

  /**
   * Get last synced block height
   * @returns Last synced height, or -1 if never synced
   */
  getLastSyncedHeight(): number {
    if (!this.syncManager) {
      return -1;
    }
    return this.syncManager.getLastSyncedHeight();
  }

  /**
   * Get sync state
   * @returns Current sync state
   */
  getSyncState() {
    if (!this.syncManager) {
      return null;
    }
    return this.syncManager.getSyncState();
  }

  /**
   * Get the wallet creation height (block height to start scanning from)
   * @returns Creation height or 0 if not set
   */
  async getCreationHeight(): Promise<number> {
    if (!this.walletDB) {
      throw new Error('Client not initialized');
    }
    return this.walletDB.getCreationHeight();
  }

  /**
   * Set the wallet creation height
   * @param height - Block height when wallet was created
   */
  async setCreationHeight(height: number): Promise<void> {
    if (!this.walletDB) {
      throw new Error('Client not initialized');
    }
    await this.walletDB.setCreationHeight(height);
  }

  /**
   * Get wallet metadata
   * @returns Wallet metadata or null if not available
   */
  async getWalletMetadata(): Promise<{
    creationHeight: number;
    creationTime: number;
    restoredFromSeed: boolean;
    version: number;
  } | null> {
    if (!this.walletDB) {
      throw new Error('Client not initialized');
    }
    return this.walletDB.getWalletMetadata();
  }

  /**
   * Get chain tip from the backend
   * @returns Current chain tip height and hash
   */
  async getChainTip(): Promise<{ height: number; hash: string }> {
    if (!this.initialized) {
      await this.initialize();
    }

    const height = await this.syncProvider.getChainTipHeight();

    // For P2P provider, we can get the chain tip directly if available
    if (this.config.backend === 'p2p') {
      const p2pProvider = this.syncProvider as any;
      if (typeof p2pProvider.getChainTip === 'function') {
        return p2pProvider.getChainTip();
      }
    }

    // Fallback: try to get header at tip height
    try {
      const headerHex = await this.syncProvider.getBlockHeader(height);
      const hash = this.hashBlockHeader(headerHex);
      return { height, hash };
    } catch {
      // If we can't get the header, return height with empty hash
      return { height, hash: '' };
    }
  }

  /**
   * Disconnect from backend and close database
   */
  async disconnect(): Promise<void> {
    // Stop background sync if running
    this.stopBackgroundSync();

    if (this.syncProvider) {
      this.syncProvider.disconnect();
    }
    if (this.walletDB) {
      await this.walletDB.close();
    }
    this.initialized = false;
  }

  /**
   * Get the current configuration
   */
  getConfig(): NavioClientConfig {
    return { ...this.config };
  }

  /**
   * Check if client is connected to the backend
   */
  isConnected(): boolean {
    return this.syncProvider?.isConnected() ?? false;
  }

  /**
   * Hash a block header to get block hash
   */
  private hashBlockHeader(headerHex: string): string {
    const headerBytes = Buffer.from(headerHex, 'hex');
    const hash = sha256(sha256(headerBytes));
    return Buffer.from(hash).reverse().toString('hex');
  }

  // ============================================================
  // Wallet Balance & Output Methods
  // ============================================================

  /**
   * Get wallet balance in satoshis
   * @param tokenId - Optional token ID to filter by (null for NAV)
   * @returns Balance in satoshis as bigint
   */
  async getBalance(tokenId: string | null = null): Promise<bigint> {
    if (!this.walletDB) {
      throw new Error('Client not initialized');
    }
    if (tokenId !== null) {
      const outputs = await this.getAllOutputs();
      const resolvedTokenId = resolveRequestedTokenId(tokenId, outputs);
      return outputs.reduce((total, output) => {
        if (output.isSpent || output.tokenId !== resolvedTokenId) {
          return total;
        }
        return total + output.amount;
      }, 0n);
    }
    return this.walletDB.getBalance(tokenId);
  }

  /**
   * Get wallet balance in NAV (with decimals)
   * @param tokenId - Optional token ID to filter by (null for NAV)
   * @returns Balance as a number with 8 decimal places
   */
  async getBalanceNav(tokenId: string | null = null): Promise<number> {
    const balanceSatoshis = await this.getBalance(tokenId);
    return Number(balanceSatoshis) / 1e8;
  }

  /**
   * Get the current balance for a specific token or NFT.
   * @param tokenId - Asset token ID
   * @returns Balance in raw on-chain units
   */
  async getTokenBalance(tokenId: string): Promise<bigint> {
    return this.getBalance(tokenId);
  }

  /**
   * Get unspent outputs for a specific token or NFT.
   * @param tokenId - Asset token ID
   * @returns Matching unspent outputs
   */
  async getTokenOutputs(tokenId: string): Promise<WalletOutput[]> {
    return this.getUnspentOutputs(tokenId);
  }

  /**
   * Get current balances for all non-NAV assets owned by the wallet.
   * Aggregates unspent outputs by token ID.
   */
  async getAssetBalances(): Promise<WalletAssetBalance[]> {
    if (!this.walletDB) {
      throw new Error('Client not initialized');
    }

    const outputs = await this.getAllOutputs();
    const balances = new Map<string, WalletAssetBalance>();

    for (const output of outputs) {
      if (output.isSpent || output.tokenId === null) {
        continue;
      }

      const current = balances.get(output.tokenId);
      if (current) {
        current.balance += output.amount;
        current.outputCount += 1;
        continue;
      }

      let tokenInfo: Pick<WalletAssetBalance, 'kind' | 'collectionTokenId' | 'nftId'>;
      try {
        tokenInfo = describeTokenId(output.tokenId);
      } catch {
        // Skip malformed token IDs from older sync data instead of failing the whole asset view.
        continue;
      }
      balances.set(output.tokenId, {
        tokenId: output.tokenId,
        balance: output.amount,
        outputCount: 1,
        ...tokenInfo,
      });
    }

    return [...balances.values()].sort((a, b) => a.tokenId.localeCompare(b.tokenId));
  }

  /**
   * Get current balances for all fungible tokens owned by the wallet.
   */
  async getTokenBalances(): Promise<WalletAssetBalance[]> {
    return (await this.getAssetBalances()).filter((asset) => asset.kind === 'token');
  }

  /**
   * Get current balances for all NFTs owned by the wallet.
   */
  async getNftBalances(): Promise<WalletAssetBalance[]> {
    return (await this.getAssetBalances()).filter((asset) => asset.kind === 'nft');
  }

  /**
   * Get the total amount locked in unconfirmed (mempool) spends, in satoshis.
   */
  async getPendingSpentAmount(tokenId: string | null = null): Promise<bigint> {
    if (!this.walletDB) {
      throw new Error('Client not initialized');
    }
    if (tokenId !== null) {
      const outputs = await this.getAllOutputs();
      const resolvedTokenId = resolveRequestedTokenId(tokenId, outputs);
      return outputs.reduce((total, output) => {
        if (!output.isSpent || output.spentBlockHeight !== 0 || output.tokenId !== resolvedTokenId) {
          return total;
        }
        return total + output.amount;
      }, 0n);
    }
    return this.walletDB.getPendingSpentAmount(tokenId);
  }

  /**
   * Get the total amount locked in unconfirmed (mempool) spends, in NAV.
   */
  async getPendingSpentNav(tokenId: string | null = null): Promise<number> {
    const satoshis = await this.getPendingSpentAmount(tokenId);
    return Number(satoshis) / 1e8;
  }

  /**
   * Get unspent outputs (UTXOs)
   * @param tokenId - Optional token ID to filter by (null for NAV)
   * @returns Array of unspent wallet outputs
   */
  async getUnspentOutputs(tokenId: string | null = null): Promise<WalletOutput[]> {
    if (!this.walletDB) {
      throw new Error('Client not initialized');
    }
    const outputs = await this.getAllOutputs();
    const resolvedTokenId = tokenId === null ? null : resolveRequestedTokenId(tokenId, outputs);
    return outputs.filter((output) => {
      if (output.isSpent) {
        return false;
      }
      if (resolvedTokenId === null) {
        return output.tokenId === null;
      }
      return output.tokenId === resolvedTokenId;
    });
  }

  /**
   * Get all wallet outputs (spent and unspent)
   * @returns Array of all wallet outputs
   */
  async getAllOutputs(): Promise<WalletOutput[]> {
    if (!this.walletDB) {
      throw new Error('Client not initialized');
    }
    return (await this.walletDB.getAllOutputs()).map(mapOutputToPublic);
  }

  // ============================================================
  // Transaction Creation & Broadcasting
  // ============================================================

  /**
   * Aggregate one or more signed transaction hex strings into a single signed transaction.
   *
   * This is a thin wrapper around `navio-blsct`'s `CTx.aggregateTransactions()`.
   * The returned transaction is not broadcast automatically.
   */
  aggregateTransactions(txHexes: string[]): AggregateTransactionsResult {
    if (!Array.isArray(txHexes) || txHexes.length === 0) {
      throw new Error('Provide at least one signed transaction hex to aggregate.');
    }

    const normalizedTxHexes = txHexes.map((txHex, index) => {
      const normalized = txHex.trim();
      if (normalized.length === 0) {
        throw new Error(`Transaction hex at index ${index} is empty.`);
      }
      if (normalized.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(normalized)) {
        throw new Error(`Transaction hex at index ${index} is not valid hex.`);
      }
      return normalized.toLowerCase();
    });

    const rawTx = CTx.aggregateTransactions(normalizedTxHexes);
    const ctx = CTx.deserialize(rawTx);

    return {
      txId: ctx.getCTxId().serialize(),
      rawTx,
      inputCount: ctx.getCTxIns().size(),
      outputCount: ctx.getCTxOuts().size(),
    };
  }

  /**
   * Send NAV (or a token) to a destination address.
   *
   * Selects UTXOs, builds a confidential transaction with change,
   * and broadcasts it via the connected backend.
   *
   * @param options - Send options (address, amount, memo, etc.)
   * @returns Transaction result with txId and details
   *
   * @example
   * ```typescript
   * const result = await client.sendTransaction({
   *   address: 'tnv1...',
   *   amount: 100_000_000n, // 1 NAV
   *   memo: 'Payment',
   * });
   * console.log('Sent tx:', result.txId);
   * ```
   */
  async sendTransaction(options: SendTransactionOptions): Promise<SendTransactionResult> {
    const { walletDB } = await this.ensureSpendReady();

    const {
      address,
      amount,
      memo = '',
      subtractFeeFromAmount = false,
      tokenId = null,
      selectedUtxos,
    } = options;

    if (amount <= 0n) {
      throw new Error('Amount must be positive');
    }

    // --- Decode destination address ---
    const destSubAddr = NavioClient.decodeAddress(address);

    if (tokenId !== null) {
      if (subtractFeeFromAmount) {
        throw new Error('subtractFeeFromAmount is not supported for token or NFT sends. Fees are paid with NAV.');
      }

      const allOutputs = await this.getAllOutputs();
      const normalizedTokenId = resolveRequestedTokenId(tokenId, allOutputs);
      const blsctTokenId = TokenId.deserialize(publicToStoredTokenIdHex(normalizedTokenId));
      const requestedAssetOutputs = allOutputs.filter((output) => !output.isSpent && output.tokenId === normalizedTokenId);
      const navOutputs = allOutputs.filter((output) => !output.isSpent && output.tokenId === null);
      const confirmedAssetOutputs = requestedAssetOutputs.filter((output) => output.blockHeight > 0);
      const confirmedNavOutputs = navOutputs.filter((output) => output.blockHeight > 0);

      const manualHashes = selectedUtxos ?? [];
      const manualAssetByHash = new Map(confirmedAssetOutputs.map((output) => [output.outputHash, output]));
      const manualNavByHash = new Map(confirmedNavOutputs.map((output) => [output.outputHash, output]));

      const manualAssetOutputs: WalletOutput[] = [];
      const manualNavOutputs: WalletOutput[] = [];
      if (manualHashes.length > 0) {
        const spendableOutputHashes = new Set([
          ...requestedAssetOutputs.map((output) => output.outputHash),
          ...navOutputs.map((output) => output.outputHash),
        ]);

        for (const hash of manualHashes) {
          const assetOutput = manualAssetByHash.get(hash);
          if (assetOutput) {
            manualAssetOutputs.push(assetOutput);
            continue;
          }

          const navOutput = manualNavByHash.get(hash);
          if (navOutput) {
            manualNavOutputs.push(navOutput);
            continue;
          }

          if (spendableOutputHashes.has(hash)) {
            throw new Error(`Selected UTXO is unconfirmed and cannot be spent yet: ${hash.slice(0, 16)}...`);
          }
          throw new Error(`Selected UTXO not found or not spendable: ${hash.slice(0, 16)}...`);
        }
      }

      let selectedAssetOutputs: WalletOutput[];
      let totalAssetIn: bigint;

      if (manualAssetOutputs.length > 0) {
        selectedAssetOutputs = manualAssetOutputs;
        totalAssetIn = manualAssetOutputs.reduce((sum, output) => sum + output.amount, 0n);
      } else {
        if (confirmedAssetOutputs.length === 0) {
          if (requestedAssetOutputs.length > 0) {
            throw new Error('All requested asset outputs are unconfirmed. Wait for block confirmation before spending.');
          }
          throw new Error('No unspent outputs available for the requested asset.');
        }
        ({ selected: selectedAssetOutputs, totalIn: totalAssetIn } = NavioClient.selectInputsByAmount(
          confirmedAssetOutputs,
          amount,
        ));
      }

      if (totalAssetIn < amount) {
        throw new Error(
          `Insufficient asset funds: need ${amount} units but only have ${totalAssetIn} units available`
        );
      }

      const assetChangeAmount = totalAssetIn - amount;
      let selectedNavOutputs = manualNavOutputs;
      let totalNavIn = manualNavOutputs.reduce((sum, output) => sum + output.amount, 0n);
      let fee = 0n;
      let includeNavChange = selectedNavOutputs.length > 0;

      for (let attempt = 0; attempt < 6; attempt++) {
        if (manualNavOutputs.length === 0 && selectedNavOutputs.length === 0) {
          if (confirmedNavOutputs.length === 0) {
            if (navOutputs.length > 0) {
              throw new Error('All NAV outputs available for fees are unconfirmed. Wait for block confirmation before spending.');
            }
            throw new Error('No unspent NAV outputs available to fund the transaction fee.');
          }

          ({ selected: selectedNavOutputs, totalIn: totalNavIn } = NavioClient.selectInputsByAmount(
            confirmedNavOutputs,
            1n,
          ));
        }

        const candidateOutputs = this.buildUnsignedSendOutputs(
          destSubAddr,
          blsctTokenId,
          amount,
          memo,
          assetChangeAmount,
          includeNavChange ? 1n : 0n,
        );
        const candidateInputs = [
          ...selectedAssetOutputs.map((output) => ({ output, tokenId: blsctTokenId })),
          ...selectedNavOutputs.map((output) => ({ output, tokenId: TokenId.default() })),
        ];
        const estimatedFee = this.estimateSignedUnsignedTransactionFee(candidateInputs, candidateOutputs);

        if (manualNavOutputs.length > 0) {
          if (totalNavIn < estimatedFee) {
            throw new Error(
              `Insufficient NAV funds for fees: need ${estimatedFee} sat but only have ${totalNavIn} sat selected`
            );
          }
        } else if (totalNavIn < estimatedFee) {
          ({ selected: selectedNavOutputs, totalIn: totalNavIn } = NavioClient.selectInputsByAmount(
            confirmedNavOutputs,
            estimatedFee,
          ));
          if (totalNavIn < estimatedFee) {
            throw new Error(
              `Insufficient NAV funds for fees: need ${estimatedFee} sat but only have ${totalNavIn} sat available`
            );
          }
        }

        const nextIncludeNavChange = totalNavIn > estimatedFee;
        if (estimatedFee === fee && nextIncludeNavChange === includeNavChange) {
          fee = estimatedFee;
          includeNavChange = nextIncludeNavChange;
          break;
        }

        fee = estimatedFee;
        includeNavChange = nextIncludeNavChange;
      }

      const navChangeAmount = totalNavIn - fee;
      const selectedInputs = [
        ...selectedAssetOutputs.map((output) => ({ output, tokenId: blsctTokenId })),
        ...selectedNavOutputs.map((output) => ({ output, tokenId: TokenId.default() })),
      ];
      const outputs = this.buildUnsignedSendOutputs(
        destSubAddr,
        blsctTokenId,
        amount,
        memo,
        assetChangeAmount,
        navChangeAmount,
      );

      return this.signAndBroadcastUnsignedTransaction(walletDB, selectedInputs, outputs, fee);
    }

    // --- Select inputs ---
    const allOutputs = tokenId === null ? null : await walletDB.getAllOutputs();
    const normalizedTokenCandidates = tokenId === null ? null : getTokenIdCandidates(tokenId);
    const normalizedTokenId = normalizedTokenCandidates === null
      ? null
      : allOutputs?.reduce<string | null>((matched, output) => {
        if (matched !== null) {
          return matched;
        }
        try {
          const publicTokenId = toPublicTokenId(output.tokenId);
          return publicTokenId !== null && normalizedTokenCandidates.includes(publicTokenId)
            ? publicTokenId
            : null;
        } catch {
          return null;
        }
      }, null) ?? normalizedTokenCandidates[0];

    const allUtxos = tokenId === null
      ? await walletDB.getUnspentOutputs(null)
      : (allOutputs ?? []).filter((utxo) => {
        if (utxo.isSpent) {
          return false;
        }

        try {
          return toPublicTokenId(utxo.tokenId) === normalizedTokenId;
        } catch {
          return false;
        }
      });

    // Filter out unconfirmed (mempool) outputs – they have synthetic output
    // hashes that are not valid CTxIds and cannot be spent until confirmed.
    const confirmedUtxos = allUtxos.filter(u => u.blockHeight > 0);

    let selected: WalletOutput[];
    let totalIn: bigint;

      if (selectedUtxos && selectedUtxos.length > 0) {
      // Manual UTXO selection
      const utxoMap = new Map(confirmedUtxos.map(u => [u.outputHash, u]));
      selected = [];
      totalIn = 0n;
      for (const hash of selectedUtxos) {
        const utxo = utxoMap.get(hash);
        if (!utxo) {
          throw new Error(`Selected UTXO not found or not spendable: ${hash.slice(0, 16)}...`);
        }
        selected.push(utxo);
        totalIn += utxo.amount;
      }
    } else {
      // Automatic selection
      if (confirmedUtxos.length === 0) {
        if (allUtxos.length > 0) {
          throw new Error('All outputs are unconfirmed. Wait for block confirmation before spending.');
        }
        throw new Error('No unspent outputs available');
      }
      ({ selected, totalIn } = NavioClient.selectInputs(confirmedUtxos, amount, subtractFeeFromAmount));
    }

    // Calculate fee: (inputs + 2 outputs) * DEFAULT_FEE_PER_COMPONENT
    // 2 outputs = destination + change (change may be zero but the fee estimate includes it)
    const numComponents = selected.length + 2;
    const fee = BigInt(numComponents * DEFAULT_FEE_PER_COMPONENT);

    let sendAmount: bigint;
    let changeAmount: bigint;

    if (subtractFeeFromAmount) {
      sendAmount = amount - fee;
      if (sendAmount <= 0n) {
        throw new Error(`Fee (${fee} sat) exceeds send amount (${amount} sat)`);
      }
      changeAmount = totalIn - amount;
    } else {
      sendAmount = amount;
      const needed = amount + fee;
      if (totalIn < needed) {
        throw new Error(
          `Insufficient funds: need ${needed} sat (${amount} + ${fee} fee) but only have ${totalIn} sat`
        );
      }
      changeAmount = totalIn - amount - fee;
    }

    // --- Build token ID ---
    const blsctTokenId = normalizedTokenId
      ? TokenId.deserialize(publicToStoredTokenIdHex(normalizedTokenId))
      : TokenId.default();

    // --- Build inputs ---
    const txIns: InstanceType<typeof TxIn>[] = [];
    for (const utxo of selected) {
      const txIn = this.buildTxInput(utxo, blsctTokenId);
      txIns.push(txIn);
    }

    // --- Build outputs ---
    const txOuts: InstanceType<typeof TxOut>[] = [];

    // Destination output
    const destTxOut = TxOut.generate(
      destSubAddr,
      Number(sendAmount),
      memo,
      blsctTokenId,
      TxOutputType.Normal,
      0,
      false,
      Scalar.random(),
    );
    txOuts.push(destTxOut);

    // Change output (send back to ourselves at a change sub-address)
    if (changeAmount > 0n) {
      const changeSubAddr = this.getChangeSubAddress();
      const changeTxOut = TxOut.generate(
        changeSubAddr,
        Number(changeAmount),
        '',
        blsctTokenId,
        TxOutputType.Normal,
        0,
        false,
        Scalar.random(),
      );
      txOuts.push(changeTxOut);
    }

    // --- Build and serialize the confidential transaction ---
    const { rawTx, txId } = buildAndSerializeCTx(txIns, txOuts);

    // --- Broadcast ---
    await this.broadcastRawTransaction(rawTx);

    // --- Mark spent inputs immediately (safety net) ---
    for (const utxo of selected) {
      await walletDB.markOutputSpent(utxo.outputHash, txId, 0);
    }

    // --- Process the mempool transaction using the same ownership detection
    //     logic as confirmed blocks (blockHeight=0 for unconfirmed). The raw
    //     tx is deserialized locally to extract keys and range proofs. ---
    if (this.syncManager) {
      try {
        await this.syncManager.processMempoolTransaction(txId, rawTx);
      } catch {
        // Mempool tx processing is best-effort; failures are non-fatal
      }
    }

    return {
      txId,
      rawTx,
      fee,
      inputCount: txIns.length,
      outputCount: txOuts.length,
    };
  }

  /**
   * Send NAV to multiple destinations in a single confidential transaction.
   *
   * Selects (or accepts a manual selection of) NAV UTXOs sufficient to cover
   * the sum of all recipient amounts plus the fee, builds one output per
   * recipient, plus an optional change output, and broadcasts the result via
   * the connected backend.
   *
   * Token and NFT sends are not supported here; use `sendToken` / `sendNft`
   * for asset transfers.
   *
   * @param options - Recipients and optional manual UTXO selection
   * @returns Transaction result with txId and details
   *
   * @example
   * ```typescript
   * const result = await client.sendToMany({
   *   recipients: [
   *     { address: 'tnv1...', amount: 100_000_000n, memo: 'invoice 1' },
   *     { address: 'tnv1...', amount:  50_000_000n },
   *     { address: 'tnv1...', amount:  25_000_000n, subtractFeeFromAmount: true },
   *   ],
   * });
   * console.log('Sent tx:', result.txId);
   * ```
   */
  async sendToMany(options: SendToManyOptions): Promise<SendTransactionResult> {
    const { walletDB } = await this.ensureSpendReady();

    const { recipients, selectedUtxos } = options;

    if (!Array.isArray(recipients) || recipients.length === 0) {
      throw new Error('At least one recipient is required');
    }

    const decodedRecipients = recipients.map((recipient, index) => {
      if (recipient.amount === undefined || recipient.amount === null) {
        throw new Error(`Recipient at index ${index} is missing an amount`);
      }
      if (typeof recipient.amount !== 'bigint') {
        throw new Error(`Recipient amount at index ${index} must be a bigint`);
      }
      if (recipient.amount <= 0n) {
        throw new Error(`Recipient amount at index ${index} must be positive`);
      }

      return {
        subAddr: NavioClient.decodeAddress(recipient.address),
        amount: recipient.amount,
        memo: recipient.memo ?? '',
        subtractFee: recipient.subtractFeeFromAmount === true,
      };
    });

    const totalSendAmount = decodedRecipients.reduce((sum, r) => sum + r.amount, 0n);
    const subtractIndices = decodedRecipients
      .map((recipient, index) => (recipient.subtractFee ? index : -1))
      .filter((index) => index >= 0);
    const subtractFee = subtractIndices.length > 0;

    // --- Select inputs ---
    const allUtxos = await walletDB.getUnspentOutputs(null);
    const confirmedUtxos = allUtxos.filter((utxo) => utxo.blockHeight > 0);

    let selected: WalletOutput[];
    let totalIn: bigint;

    if (selectedUtxos && selectedUtxos.length > 0) {
      const utxoMap = new Map(confirmedUtxos.map((utxo) => [utxo.outputHash, utxo]));
      selected = [];
      totalIn = 0n;
      for (const hash of selectedUtxos) {
        const utxo = utxoMap.get(hash);
        if (!utxo) {
          throw new Error(`Selected UTXO not found or not spendable: ${hash.slice(0, 16)}...`);
        }
        selected.push(utxo);
        totalIn += utxo.amount;
      }
    } else {
      if (confirmedUtxos.length === 0) {
        if (allUtxos.length > 0) {
          throw new Error('All outputs are unconfirmed. Wait for block confirmation before spending.');
        }
        throw new Error('No unspent outputs available');
      }

      const sorted = [...confirmedUtxos].sort((a, b) => {
        if (b.amount > a.amount) return 1;
        if (b.amount < a.amount) return -1;
        return 0;
      });

      selected = [];
      totalIn = 0n;
      for (const utxo of sorted) {
        selected.push(utxo);
        totalIn += utxo.amount;

        // Estimate fee against the current input count, recipients + change.
        const numComponents = selected.length + recipients.length + 1;
        const estimatedFee = BigInt(numComponents * DEFAULT_FEE_PER_COMPONENT);
        const needed = subtractFee ? totalSendAmount : totalSendAmount + estimatedFee;
        if (totalIn >= needed) {
          break;
        }
      }
    }

    // Final fee uses the actual number of selected inputs and recipient outputs,
    // assuming a change output (consistent with single-recipient sendTransaction).
    const numComponents = selected.length + recipients.length + 1;
    const fee = BigInt(numComponents * DEFAULT_FEE_PER_COMPONENT);

    const sendAmounts = decodedRecipients.map((recipient) => recipient.amount);
    let changeAmount: bigint;

    if (subtractFee) {
      const payerCount = BigInt(subtractIndices.length);
      const baseShare = fee / payerCount;
      const remainder = fee % payerCount;

      for (let k = 0; k < subtractIndices.length; k++) {
        const recipientIndex = subtractIndices[k];
        const extra = BigInt(k) < remainder ? 1n : 0n;
        const share = baseShare + extra;
        const adjusted = sendAmounts[recipientIndex] - share;
        if (adjusted <= 0n) {
          throw new Error(
            `Fee share (${share} sat) exceeds recipient ${recipientIndex} amount ` +
            `(${sendAmounts[recipientIndex]} sat)`
          );
        }
        sendAmounts[recipientIndex] = adjusted;
      }

      if (totalIn < totalSendAmount) {
        throw new Error(
          `Insufficient funds: need ${totalSendAmount} sat but only have ${totalIn} sat`
        );
      }
      changeAmount = totalIn - totalSendAmount;
    } else {
      const needed = totalSendAmount + fee;
      if (totalIn < needed) {
        throw new Error(
          `Insufficient funds: need ${needed} sat (${totalSendAmount} + ${fee} fee) but only have ${totalIn} sat`
        );
      }
      changeAmount = totalIn - totalSendAmount - fee;
    }

    const navTokenId = TokenId.default();

    // --- Build inputs ---
    const txIns: InstanceType<typeof TxIn>[] = [];
    for (const utxo of selected) {
      txIns.push(this.buildTxInput(utxo, navTokenId));
    }

    // --- Build outputs ---
    const txOuts: InstanceType<typeof TxOut>[] = [];
    for (let i = 0; i < decodedRecipients.length; i++) {
      const recipient = decodedRecipients[i];
      txOuts.push(TxOut.generate(
        recipient.subAddr,
        Number(sendAmounts[i]),
        recipient.memo,
        navTokenId,
        TxOutputType.Normal,
        0,
        false,
        Scalar.random(),
      ));
    }

    if (changeAmount > 0n) {
      const changeSubAddr = this.getChangeSubAddress();
      txOuts.push(TxOut.generate(
        changeSubAddr,
        Number(changeAmount),
        '',
        navTokenId,
        TxOutputType.Normal,
        0,
        false,
        Scalar.random(),
      ));
    }

    const { rawTx, txId } = buildAndSerializeCTx(txIns, txOuts);

    await this.broadcastRawTransaction(rawTx);

    for (const utxo of selected) {
      await walletDB.markOutputSpent(utxo.outputHash, txId, 0);
    }

    if (this.syncManager) {
      try {
        await this.syncManager.processMempoolTransaction(txId, rawTx);
      } catch {
        // Mempool tx processing is best-effort; failures are non-fatal
      }
    }

    return {
      txId,
      rawTx,
      fee,
      inputCount: txIns.length,
      outputCount: txOuts.length,
    };
  }

  /**
   * Send a fungible token output.
   */
  async sendToken(options: SendTokenOptions): Promise<SendTransactionResult> {
    const normalizedTokenId = normalizeTokenIdHex(options.tokenId);
    const tokenInfo = describeTokenId(normalizedTokenId);
    if (tokenInfo.kind !== 'token') {
      throw new Error('sendToken only supports fungible token IDs. Use sendNft() for NFT token IDs.');
    }

    return this.sendTransaction({
      ...options,
      tokenId: normalizedTokenId,
    });
  }

  /**
   * Send a single NFT.
   */
  async sendNft(options: SendNftOptions): Promise<SendTransactionResult> {
    const hasTokenId = options.tokenId !== undefined && options.tokenId.trim().length > 0;
    const hasCollectionSource = options.collectionTokenId !== undefined || options.nftId !== undefined;

    if (hasTokenId && hasCollectionSource) {
      throw new Error('Specify either tokenId or collectionTokenId + nftId for sendNft().');
    }

    let nftTokenId: string;
    if (hasTokenId) {
      nftTokenId = normalizeTokenIdHex(options.tokenId!);
    } else {
      if (!options.collectionTokenId || options.nftId === undefined) {
        throw new Error('sendNft requires tokenId, or collectionTokenId + nftId.');
      }
      nftTokenId = composeNftTokenId(options.collectionTokenId, options.nftId);
    }

    const tokenInfo = describeTokenId(nftTokenId);
    if (tokenInfo.kind !== 'nft') {
      throw new Error('sendNft requires an NFT token ID.');
    }

    const { tokenId: _tokenId, collectionTokenId: _collectionTokenId, nftId: _nftId, ...sendOptions } = options;

    return this.sendTransaction({
      ...sendOptions,
      amount: 1n,
      tokenId: nftTokenId,
    });
  }

  /**
   * Create a fungible token collection.
   */
  async createTokenCollection(options: CreateTokenCollectionOptions): Promise<CreateCollectionResult> {
    await this.ensureSpendReady();

    const metadata = normalizeTokenMetadata(options.metadata);
    const totalSupply = toSafeInteger(options.totalSupply, 'totalSupply');
    if (totalSupply <= 0) {
      throw new Error('totalSupply must be positive');
    }

    const collectionTokenId = calcCollectionTokenHashHex(metadata, totalSupply);
    const { tokenKey, tokenPublicKey } = this.buildCollectionTokenContext(collectionTokenId);
    const tokenInfo = TokenInfo.build(TokenType.Token, tokenPublicKey, metadata, totalSupply);

    const result = await this.buildAndBroadcastUnsignedTransaction(
      UnsignedOutput.createTokenCollection(tokenKey, tokenInfo),
      options.selectedUtxos
    );

    return {
      ...result,
      kind: 'token',
      collectionTokenId,
      tokenPublicKey: tokenPublicKey.serialize(),
    };
  }

  /**
   * Create an NFT collection.
   */
  async createNftCollection(options: CreateNftCollectionOptions): Promise<CreateCollectionResult> {
    await this.ensureSpendReady();

    const metadata = normalizeTokenMetadata(options.metadata);
    const totalSupply = toSafeInteger(options.totalSupply ?? 0, 'totalSupply');
    const collectionTokenId = calcCollectionTokenHashHex(metadata, totalSupply);
    const { tokenKey, tokenPublicKey } = this.buildCollectionTokenContext(collectionTokenId);
    const tokenInfo = TokenInfo.build(TokenType.Nft, tokenPublicKey, metadata, totalSupply);

    const result = await this.buildAndBroadcastUnsignedTransaction(
      UnsignedOutput.createTokenCollection(tokenKey, tokenInfo),
      options.selectedUtxos
    );

    return {
      ...result,
      kind: 'nft',
      collectionTokenId,
      tokenPublicKey: tokenPublicKey.serialize(),
    };
  }

  /**
   * Mint a fungible token output from an existing collection.
   */
  async mintToken(options: MintTokenOptions): Promise<MintAssetResult> {
    await this.ensureSpendReady();

    const mintAmount = toSafeInteger(options.amount, 'amount');
    if (mintAmount <= 0) {
      throw new Error('amount must be positive');
    }

    const destination = NavioClient.decodeAddress(options.address);
    const collectionTokenId = normalizeCollectionTokenHashHex(options.collectionTokenId);
    const { tokenKey, tokenPublicKey } = this.buildCollectionTokenContext(collectionTokenId);

    const result = await this.buildAndBroadcastUnsignedTransaction(
      UnsignedOutput.mintToken(destination, mintAmount, Scalar.random(), tokenKey, tokenPublicKey),
      options.selectedUtxos
    );

    return {
      ...result,
      kind: 'token',
      collectionTokenId,
      tokenId: collectionTokenId,
      tokenPublicKey: tokenPublicKey.serialize(),
    };
  }

  /**
   * Mint an NFT output from an existing collection.
   */
  async mintNft(options: MintNftOptions): Promise<MintAssetResult> {
    await this.ensureSpendReady();

    const normalizedNftId = typeof options.nftId === 'bigint' ? options.nftId : BigInt(options.nftId);
    const nftId = toSafeInteger(normalizedNftId, 'nftId');
    const metadata = normalizeTokenMetadata(options.metadata);
    const destination = NavioClient.decodeAddress(options.address);
    const collectionTokenId = normalizeCollectionTokenHashHex(options.collectionTokenId);
    const { tokenKey, tokenPublicKey } = this.buildCollectionTokenContext(collectionTokenId);

    const result = await this.buildAndBroadcastUnsignedTransaction(
      UnsignedOutput.mintNft(destination, Scalar.random(), tokenKey, tokenPublicKey, nftId, metadata),
      options.selectedUtxos
    );

    return {
      ...result,
      kind: 'nft',
      collectionTokenId,
      tokenId: composeNftTokenId(collectionTokenId, normalizedNftId),
      tokenPublicKey: tokenPublicKey.serialize(),
    };
  }

  /**
   * Broadcast a raw transaction hex via the connected backend.
   * @param rawTx - Serialized transaction hex
   * @returns Transaction hash returned by the server
   */
  async broadcastRawTransaction(rawTx: string): Promise<string> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.isConnected()) {
      throw new Error('Not connected to backend. Please reconnect before broadcasting.');
    }

    // Use the sync provider which holds the active connection
    const provider = this.syncProvider as any;
    if (typeof provider.broadcastTransaction === 'function') {
      return provider.broadcastTransaction(rawTx);
    }

    throw new Error('Connected backend does not support transaction broadcasting');
  }

  /**
   * Decode a bech32m address string into a SubAddr for use as a destination.
   */
  private static decodeAddress(addressStr: string): InstanceType<typeof SubAddr> {
    try {
      const dpk = Address.decode(addressStr);
      return SubAddr.fromDoublePublicKey(dpk);
    } catch (err: any) {
      throw new Error(`Invalid address "${addressStr}": ${err.message}`);
    }
  }

  /**
   * Select UTXOs to cover the target amount.
   * Uses a simple largest-first strategy.
   */
  private static selectInputs(
    utxos: WalletOutput[],
    targetAmount: bigint,
    subtractFee: boolean,
  ): { selected: WalletOutput[]; totalIn: bigint } {
    // Sort descending by amount for efficient selection
    const sorted = [...utxos].sort((a, b) => {
      if (b.amount > a.amount) return 1;
      if (b.amount < a.amount) return -1;
      return 0;
    });

    const selected: WalletOutput[] = [];
    let totalIn = 0n;

    for (const utxo of sorted) {
      selected.push(utxo);
      totalIn += utxo.amount;

      // Estimate fee with current selection
      const numComponents = selected.length + 2;
      const estimatedFee = BigInt(numComponents * DEFAULT_FEE_PER_COMPONENT);
      const needed = subtractFee ? targetAmount : targetAmount + estimatedFee;

      if (totalIn >= needed) {
        return { selected, totalIn };
      }
    }

    // Not enough, but return what we have; the caller will check and throw
    return { selected, totalIn };
  }

  private static selectInputsByAmount(
    utxos: WalletOutput[],
    targetAmount: bigint,
  ): { selected: WalletOutput[]; totalIn: bigint } {
    const sorted = [...utxos].sort((a, b) => {
      if (b.amount > a.amount) return 1;
      if (b.amount < a.amount) return -1;
      return 0;
    });

    const selected: WalletOutput[] = [];
    let totalIn = 0n;

    for (const utxo of sorted) {
      selected.push(utxo);
      totalIn += utxo.amount;

      if (totalIn >= targetAmount) {
        return { selected, totalIn };
      }
    }

    return { selected, totalIn };
  }

  private async ensureSpendReady(): Promise<{ keyManager: KeyManager; walletDB: IWalletDB }> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.keyManager || !this.walletDB) {
      throw new Error('Client not initialized');
    }
    if (!this.isConnected()) {
      throw new Error('Not connected to backend. Please reconnect before sending.');
    }
    if (!this.keyManager.isUnlocked()) {
      throw new Error('Wallet is locked. Unlock it before sending.');
    }

    return {
      keyManager: this.keyManager,
      walletDB: this.walletDB,
    };
  }

  private buildCollectionTokenContext(collectionTokenId: string): {
    tokenKey: InstanceType<typeof Scalar>;
    tokenPublicKey: InstanceType<typeof PublicKey>;
  } {
    if (!this.keyManager) {
      throw new Error('KeyManager not available');
    }

    const collectionTokenHashHex = normalizeCollectionTokenHashHex(collectionTokenId);
    const masterTokenKey = this.keyManager.getMasterTokenKey();

    return {
      tokenKey: deriveCollectionTokenKeyFromMaster(masterTokenKey, collectionTokenHashHex),
      tokenPublicKey: deriveCollectionTokenPublicKeyFromMaster(masterTokenKey, collectionTokenHashHex),
    };
  }

  private async selectFundingUtxos(
    walletDB: IWalletDB,
    selectedUtxos?: string[],
  ): Promise<{ selected: WalletOutput[]; totalIn: bigint; fee: bigint }> {
    const allUtxos = await walletDB.getUnspentOutputs(null);
    const confirmedUtxos = allUtxos.filter((utxo) => utxo.blockHeight > 0);

    let selected: WalletOutput[];
    let totalIn: bigint;

    if (selectedUtxos && selectedUtxos.length > 0) {
      const utxoMap = new Map(confirmedUtxos.map((utxo) => [utxo.outputHash, utxo]));
      selected = [];
      totalIn = 0n;

      for (const hash of selectedUtxos) {
        const utxo = utxoMap.get(hash);
        if (!utxo) {
          throw new Error(`Selected UTXO not found or not spendable: ${hash.slice(0, 16)}...`);
        }
        selected.push(utxo);
        totalIn += utxo.amount;
      }
    } else {
      if (confirmedUtxos.length === 0) {
        if (allUtxos.length > 0) {
          throw new Error('All outputs are unconfirmed. Wait for block confirmation before spending.');
        }
        throw new Error('No unspent NAV outputs available to fund the transaction.');
      }
      ({ selected, totalIn } = NavioClient.selectInputs(confirmedUtxos, 0n, false));
    }

    const fee = BigInt((selected.length + 2) * DEFAULT_FEE_PER_COMPONENT);
    if (totalIn < fee) {
      throw new Error(`Insufficient funds: need ${fee} sat for fees but only have ${totalIn} sat`);
    }

    return { selected, totalIn, fee };
  }

  private async buildAndBroadcastUnsignedTransaction(
    unsignedOutput: InstanceType<typeof UnsignedOutput>,
    selectedUtxos?: string[],
  ): Promise<SendTransactionResult> {
    const { walletDB } = await this.ensureSpendReady();
    const { selected, totalIn } = await this.selectFundingUtxos(walletDB, selectedUtxos);
    const inputs = selected.map((utxo) => ({ output: utxo, tokenId: TokenId.default() }));

    let outputs = [unsignedOutput];
    let fee = 0n;
    let previousNavChange: bigint | null = null;

    // Creating collections and minting only consume NAV for fees, so they need
    // an explicit NAV change output whenever the selected funding input exceeds
    // the final fee.
    for (let i = 0; i < 3; i++) {
      fee = this.estimateSignedUnsignedTransactionFee(inputs, outputs);
      if (totalIn < fee) {
        throw new Error(`Insufficient funds: need ${fee} sat for fees but only have ${totalIn} sat`);
      }

      const navChangeAmount = totalIn - fee;
      const nextOutputs = [unsignedOutput];
      if (navChangeAmount > 0n) {
        nextOutputs.push(this.buildUnsignedNavChangeOutput(navChangeAmount));
      }

      if (previousNavChange !== null && navChangeAmount === previousNavChange) {
        outputs = nextOutputs;
        break;
      }

      outputs = nextOutputs;
      previousNavChange = navChangeAmount;
    }

    return this.signAndBroadcastUnsignedTransaction(
      walletDB,
      inputs,
      outputs,
      fee,
    );
  }

  private buildUnsignedNavChangeOutput(amount: bigint): InstanceType<typeof UnsignedOutput> {
    return UnsignedOutput.fromTxOut(TxOut.generate(
      this.getChangeSubAddress(),
      Number(amount),
      '',
      TokenId.default(),
      TxOutputType.Normal,
      0,
      false,
      Scalar.random(),
    ));
  }

  private buildUnsignedSendOutputs(
    destination: InstanceType<typeof SubAddr>,
    assetTokenId: InstanceType<typeof TokenId>,
    amount: bigint,
    memo: string,
    assetChangeAmount: bigint,
    navChangeAmount: bigint,
  ): InstanceType<typeof UnsignedOutput>[] {
    const outputs: InstanceType<typeof UnsignedOutput>[] = [];
    const changeSubAddr = this.getChangeSubAddress();

    outputs.push(UnsignedOutput.fromTxOut(TxOut.generate(
      destination,
      Number(amount),
      memo,
      assetTokenId,
      TxOutputType.Normal,
      0,
      false,
      Scalar.random(),
    )));

    if (assetChangeAmount > 0n) {
      outputs.push(UnsignedOutput.fromTxOut(TxOut.generate(
        changeSubAddr,
        Number(assetChangeAmount),
        '',
        assetTokenId,
        TxOutputType.Normal,
        0,
        false,
        Scalar.random(),
      )));
    }

    if (navChangeAmount > 0n) {
      outputs.push(UnsignedOutput.fromTxOut(TxOut.generate(
        changeSubAddr,
        Number(navChangeAmount),
        '',
        TokenId.default(),
        TxOutputType.Normal,
        0,
        false,
        Scalar.random(),
      )));
    }

    return outputs;
  }

  private estimateSignedUnsignedTransactionFee(
    inputs: Array<{ output: WalletOutput; tokenId: InstanceType<typeof TokenId> }>,
    outputs: InstanceType<typeof UnsignedOutput>[],
  ): bigint {
    const { rawTx } = this.signUnsignedTransaction(inputs, outputs, 0n);
    return BigInt(rawTx.length / 2) * BLSCT_DEFAULT_FEE_RATE;
  }

  private async signAndBroadcastUnsignedTransaction(
    walletDB: IWalletDB,
    inputs: Array<{ output: WalletOutput; tokenId: InstanceType<typeof TokenId> }>,
    outputs: InstanceType<typeof UnsignedOutput>[],
    fee: bigint,
  ): Promise<SendTransactionResult> {
    const { rawTx, txId, ctx } = this.signUnsignedTransaction(inputs, outputs, fee);

    await this.broadcastRawTransaction(rawTx);

    for (const input of inputs) {
      await walletDB.markOutputSpent(input.output.outputHash, txId, 0);
    }

    if (this.syncManager) {
      try {
        await this.syncManager.processMempoolTransaction(txId, rawTx);
      } catch {
        // Mempool tx processing is best-effort; failures are non-fatal
      }
    }

    return {
      txId,
      rawTx,
      fee,
      inputCount: ctx.getCTxIns().size(),
      outputCount: ctx.getCTxOuts().size(),
    };
  }

  private signUnsignedTransaction(
    inputs: Array<{ output: WalletOutput; tokenId: InstanceType<typeof TokenId> }>,
    outputs: InstanceType<typeof UnsignedOutput>[],
    fee: bigint,
  ): { rawTx: string; txId: string; ctx: InstanceType<typeof CTx> } {
    const unsignedTx = UnsignedTransaction.create();
    for (const input of inputs) {
      const txIn = this.buildTxInput(input.output, input.tokenId);
      unsignedTx.addInput(UnsignedInput.fromTxIn(txIn));
    }
    for (const output of outputs) {
      unsignedTx.addOutput(output);
    }
    unsignedTx.setFee(Number(fee));

    const rawTx = unsignedTx.sign();
    const ctx = CTx.deserialize(rawTx);
    const txId = ctx.getCTxId().serialize();

    return { rawTx, txId, ctx };
  }

  /**
   * Build a TxIn from a wallet output.
   */
  private buildTxInput(
    utxo: WalletOutput,
    tokenId: InstanceType<typeof TokenId>,
  ): InstanceType<typeof TxIn> {
    if (!this.keyManager) {
      throw new Error('KeyManager not available');
    }

    // Reconstruct the blinding public key from the stored hex
    const blindingPubKey = PublicKey.deserialize(utxo.blindingKey);

    // Derive the private spending key for this output
    const viewKey = this.keyManager.getPrivateViewKey();
    const masterSpendKey = this.keyManager.getSpendingKey();

    // Find the sub-address this output belongs to via hash ID
    const spendingPubKey = PublicKey.deserialize(utxo.spendingKey);
    const hashId = this.keyManager.calculateHashId(blindingPubKey, spendingPubKey);
    const hashIdHex = Array.from(hashId).map(b => b.toString(16).padStart(2, '0')).join('');
    const subAddrId = { account: 0, address: 0 };
    if (!this.keyManager.getSubAddressId(hashId, subAddrId)) {
      throw new Error(
        `Cannot derive spending key: output ${utxo.outputHash.slice(0, 16)}… ` +
        `does not map to a known sub-address in this wallet (hashId=${hashIdHex})`
      );
    }

    // Compute the private spending key for this output
    const privSpendingKey = new PrivSpendingKey(
      blindingPubKey,
      viewKey,
      masterSpendKey,
      subAddrId.account,
      subAddrId.address,
    );

    const ctxId = CTxId.deserialize(utxo.outputHash);
    const outPoint = OutPoint.generate(ctxId);

    const gamma = utxo.gamma && utxo.gamma !== '0' && utxo.gamma.length > 0
      ? Scalar.deserialize(utxo.gamma)
      : new Scalar(0);

    return TxIn.generate(
      Number(utxo.amount),
      gamma,
      privSpendingKey,
      tokenId,
      outPoint,
    );
  }

  /**
   * Get a SubAddr for receiving change.
   * Uses the change account (account -1).
   */
  private getChangeSubAddress(): InstanceType<typeof SubAddr> {
    if (!this.keyManager) {
      throw new Error('KeyManager not available');
    }
    return this.keyManager.getSubAddress({ account: -1, address: 0 });
  }
}
