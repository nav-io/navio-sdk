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
import type {
  RequestQuoteOptions,
  RequestQuoteResult,
  QuoteSummary,
  AcceptQuoteOptions,
  AcceptQuoteResult,
  SwapIntentOptions,
  SwapIntent,
  PendingQuoteRequest,
  ReplyQuoteOptions,
  MakerQuoteResult,
  BroadcastOrderOptions,
} from './trading.types';

const {
  Scalar, PublicKey, SubAddr,
  Address, TokenId, CTxId, OutPoint, TxIn, TxOut,
  TxOutputType, PrivSpendingKey,
  CTx, UnsignedInput, UnsignedOutput, UnsignedTransaction,
  TokenInfo, TokenType,
  calcCollectionTokenHashHex, deriveCollectionTokenKeyFromMaster, deriveCollectionTokenPublicKeyFromMaster,
} = blsctModule as any;

/**
 * Network type for Navio
 */
export type NetworkType = 'mainnet' | 'testnet' | 'signet' | 'regtest';

/**
 * Fee per input+output in satoshis (matches navio-core default)
 */
const DEFAULT_FEE_PER_COMPONENT = 200_000;

/**
 * BLSCT address prefix (bech32_mod_hrp) per network, from navio-core
 * chainparams. Signet reuses the mainnet prefix.
 */
const NETWORK_ADDRESS_HRP: Record<NetworkType, string> = {
  mainnet: 'nav',
  testnet: 'tnv',
  signet: 'nav',
  regtest: 'rnv',
};

/**
 * Extra fee a maker's swap half over-funds so the combined transaction (its
 * half + the taker's fee-free half) clears the consensus minimum for the
 * COMBINED weight. Mirrors navio-core's per-candidate allowance:
 * aggregation::CANDIDATE_WEIGHT_ESTIMATE (2500) * BLSCT_DEFAULT_FEE (125).
 */
const MAKER_TAKER_FEE_ALLOWANCE = 2500n * 125n;
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
 * Consensus (blsct::VerifyTx) requires
 *   nFee >= GetTransactionWeight(tx) * nBLSCTDefaultFee
 * where the weight is `GetSerializeSize(TX_WITH_WITNESS(tx))` — the witness-
 * inclusive serialization. The light-client `serializeCTx` produces the
 * base (non-witness) form, which is a handful of bytes shorter (BLSCT witness
 * framing the binding does not expose a size for), so fee = base_bytes * rate
 * lands just under the consensus minimum and the node rejects the tx with
 * `blsct-fee-below-min`. Add headroom — the larger of 10% or 256 bytes — over
 * the measured base size. BLSCT outputs are large (range proofs), so the
 * overpay is a negligible fraction of the fee while guaranteeing acceptance
 * regardless of input/output count.
 */
function requiredBlsctFee(baseBytes: number): bigint {
  const bytes = BigInt(baseBytes);
  const headroom = bytes / 10n > 256n ? bytes / 10n : 256n;
  return (bytes + headroom) * BLSCT_DEFAULT_FEE_RATE;
}

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
  /**
   * Optionally mint an initial amount of the new token in the SAME
   * transaction as the collection creation. Consensus executes output
   * predicates in order, so the create-collection output registers the token
   * before the mint output is validated — collection and first supply land
   * in one transaction (and therefore one block). Without this, a mint can
   * only be broadcast after the collection transaction has confirmed.
   */
  initialMint?: {
    /** Destination address receiving the minted fungible token output. */
    address: string;
    /** Amount of fungible tokens to mint. */
    amount: bigint | number;
  };
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
  /** Collection metadata, when known (local creation record or server token registry). */
  metadata?: TokenMetadata;
  /** Collection max total supply, when known. */
  totalSupply?: bigint;
}

export interface CreateCollectionResult extends SendTransactionResult {
  /** Asset type for the created collection. */
  kind: WalletAssetKind;
  /** Collection token ID in navio-core/RPC byte order. */
  collectionTokenId: string;
  /** Derived collection token public key. */
  tokenPublicKey: string;
  /** Public on-chain token id (hash of the token public key) — the id explorers, `gettoken`, and balance methods report. */
  publicTokenId: string;
  /** Amount minted in the same transaction when `initialMint` was used. */
  mintedAmount?: bigint;
}

/**
 * A collection this wallet created, as reported by
 * {@link NavioClient.listCreatedCollections}.
 */
export interface CreatedCollectionInfo {
  /** Asset type of the collection. */
  kind: WalletAssetKind;
  /** Creation id — pass this to mintToken/mintNft. */
  collectionTokenId: string;
  /** Public on-chain token id (hash of the token public key) — matches getAssetBalances/getTokenBalances and the explorer. */
  publicTokenId: string;
  /** Derived collection token public key (hex). */
  tokenPublicKey: string;
  /** Metadata the collection was created with. */
  metadata: TokenMetadata;
  /** Maximum total supply recorded at creation. */
  totalSupply: bigint;
  /** Create-collection transaction id (known for locally recorded creations). */
  txId?: string;
  /** Unix timestamp (seconds) of the creation broadcast (locally recorded creations). */
  createdAt?: number;
  /**
   * Where the entry came from: `local` = recorded by this wallet database at
   * creation time; `chain` = re-derived from an owned token output via the
   * server's token registry (covers restored wallets).
   */
  source: 'local' | 'chain';
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
  /** Public on-chain token id (hash of the token public key) — matches getAssetBalances/getTokenBalances. */
  publicTokenId: string;
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

/**
 * Compute the public on-chain token id of a collection from its token public
 * key: navio-core `PublicKey::GetHash()` double-SHA256s the *serialized
 * vector* (compact-size length prefix + point bytes), and token ids display
 * in reversed byte order. This is the id explorers, `gettoken`, and wallet
 * outputs use — verified against live registry entries.
 */
function publicTokenIdFromPublicKeyHex(tokenPublicKeyHex: string): string {
  const keyBytes = Buffer.from(tokenPublicKeyHex, 'hex');
  if (keyBytes.length === 0 || keyBytes.length >= 0xfd) {
    throw new Error('Unexpected token public key length');
  }
  const prefixed = Buffer.concat([Buffer.from([keyBytes.length]), keyBytes]);
  return Buffer.from(sha256(sha256(prefixed))).reverse().toString('hex');
}

/**
 * Convert the metadata shape served by `gettoken`/`blockchain.token.get_token`
 * (an array of `{key, value}` entries, or already a plain object) back into
 * the SDK's TokenMetadata record.
 */
function tokenMetadataFromChainRecord(metadata: unknown): TokenMetadata {
  if (!metadata) {
    return {};
  }
  if (Array.isArray(metadata)) {
    return Object.fromEntries(
      metadata
        .filter((entry) => entry && typeof entry.key === 'string')
        .map((entry) => [entry.key, String(entry.value ?? '')])
    );
  }
  if (typeof metadata === 'object') {
    return normalizeTokenMetadata(metadata as TokenMetadata);
  }
  return {};
}

/**
 * Give the opaque `failed-to-execute-predicate` network rejection an
 * actionable explanation when it comes out of a mint.
 */
function augmentMintBroadcastError(err: unknown, collectionTokenId: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.includes('failed-to-execute-predicate')) {
    return err instanceof Error ? err : new Error(message);
  }
  return new Error(
    `${message}\n` +
    `The network rejected the mint predicate for collection ${collectionTokenId.slice(0, 16)}…. Common causes: ` +
    '(1) the id passed is the on-chain/explorer token id instead of the creation id returned by ' +
    'createTokenCollection/createNftCollection — the SDK resolves this automatically when the connected server ' +
    'bridges blockchain.token.get_token, but this server does not; ' +
    '(2) the collection was created by a different wallet (the mint key derives from the creator\'s seed); ' +
    '(3) the mint type does not match the collection type (fungible amount into an NFT collection, or vice versa).'
  );
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

  /**
   * Cache of collection info keyed by public token id. Token metadata and
   * max supply are immutable once a collection is created, so entries never
   * expire; `null` marks a failed lookup (unknown token or a server without
   * the get_token bridge) so it is not retried every call.
   */
  private tokenRegistryCache = new Map<string, {
    metadata: TokenMetadata;
    totalSupply: bigint;
    kind: WalletAssetKind;
  } | null>();

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
   *
   * Each entry carries the collection `metadata` and `totalSupply` when they
   * can be resolved — from this wallet's own creation records, or from the
   * server's token registry (`blockchain.token.get_token`), cached for the
   * client's lifetime since collection info is immutable. Pass
   * `{ includeMetadata: false }` to skip resolution.
   */
  async getAssetBalances(options: { includeMetadata?: boolean } = {}): Promise<WalletAssetBalance[]> {
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

    const assets = [...balances.values()].sort((a, b) => a.tokenId.localeCompare(b.tokenId));

    if (options.includeMetadata ?? true) {
      for (const asset of assets) {
        try {
          const publicId = asset.collectionTokenId ?? describeTokenId(asset.tokenId).collectionTokenId;
          if (!publicId) {
            continue;
          }
          const info = await this.resolveCollectionInfoByPublicId(publicId);
          if (info) {
            asset.metadata = info.metadata;
            asset.totalSupply = info.totalSupply;
          }
        } catch {
          // Metadata resolution is best-effort; balances stay authoritative.
        }
      }
    }

    return assets;
  }

  /**
   * Resolve collection metadata/supply by public token id: local creation
   * records first (free), then the server's token registry, both cached for
   * the client's lifetime.
   */
  private async resolveCollectionInfoByPublicId(publicTokenId: string): Promise<{
    metadata: TokenMetadata;
    totalSupply: bigint;
    kind: WalletAssetKind;
  } | null> {
    const cached = this.tokenRegistryCache.get(publicTokenId);
    if (cached !== undefined) {
      return cached;
    }

    // Local creation records: compute each record's public id and match.
    if (this.walletDB) {
      try {
        for (const record of await this.walletDB.getCreatedCollections()) {
          const recordPublicId = publicTokenIdFromPublicKeyHex(record.tokenPublicKey);
          if (!this.tokenRegistryCache.has(recordPublicId)) {
            this.tokenRegistryCache.set(recordPublicId, {
              metadata: record.metadata,
              totalSupply: BigInt(record.totalSupply),
              kind: record.kind,
            });
          }
        }
        const localHit = this.tokenRegistryCache.get(publicTokenId);
        if (localHit !== undefined) {
          return localHit;
        }
      } catch {
        // Fall through to the registry lookup.
      }
    }

    if (!this.electrumClient) {
      return null; // not cached: a later connection may resolve it
    }

    try {
      const onChainToken: any = await this.electrumClient.getToken(publicTokenId);
      if (onChainToken && typeof onChainToken === 'object' && onChainToken.publicKey) {
        const info = {
          metadata: tokenMetadataFromChainRecord(onChainToken.metadata),
          totalSupply: BigInt(onChainToken.maxSupply ?? 0),
          kind: (onChainToken.type === 'nft' ? 'nft' : 'token') as WalletAssetKind,
        };
        this.tokenRegistryCache.set(publicTokenId, info);
        return info;
      }
      this.tokenRegistryCache.set(publicTokenId, null);
    } catch {
      // Unknown token or server without the bridge — cache the miss so it
      // is not retried on every balance call.
      this.tokenRegistryCache.set(publicTokenId, null);
    }
    return null;
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
    const destSubAddr = this.decodeDestinationAddress(address);

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

    // --- Build token ID ---
    const blsctTokenId = normalizedTokenId
      ? TokenId.deserialize(publicToStoredTokenIdHex(normalizedTokenId))
      : TokenId.default();

    // --- Build inputs (independent of the fee) ---
    const inputs = selected.map((utxo) => ({ output: utxo, tokenId: blsctTokenId }));

    // Build the dest + change outputs for a given fee via the manual
    // UnsignedTransaction path. NOTE: we do *not* use build_ctx here — that
    // native helper appends its own change output (to a zero/burn destination)
    // for any input-vs-output surplus and recomputes the fee itself, so any fee
    // we overpay is siphoned into a spurious extra output (an unspendable burn)
    // instead of being paid as fee. The unsigned path emits exactly the outputs
    // we specify plus a single fee output whose value is the fee we set.
    const buildOutputs = (fee: bigint): { outputs: InstanceType<typeof UnsignedOutput>[]; changeAmount: bigint } => {
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

      const outputs: InstanceType<typeof UnsignedOutput>[] = [];
      outputs.push(UnsignedOutput.fromTxOut(
        TxOut.generate(destSubAddr, Number(sendAmount), memo, blsctTokenId, TxOutputType.Normal, 0, false, Scalar.random()),
      ));
      if (changeAmount > 0n) {
        outputs.push(UnsignedOutput.fromTxOut(
          TxOut.generate(this.getChangeSubAddress(), Number(changeAmount), '', blsctTokenId, TxOutputType.Normal, 0, false, Scalar.random()),
        ));
      }
      return { outputs, changeAmount };
    };

    // Consensus rule (blsct::VerifyTx): nFee >= GetTransactionWeight(tx) *
    // nBLSCTDefaultFee. Unlike build_ctx, the fee we set here is the literal
    // on-chain fee, so it must clear the consensus minimum. Iterate to a
    // fixpoint on the actual signed (witness-inclusive) serialized size; raising
    // the fee shrinks the change (and thus the tx) monotonically, so this
    // converges in a couple of rounds.
    let fee = BigInt((selected.length + 2) * DEFAULT_FEE_PER_COMPONENT);
    let { outputs } = buildOutputs(fee);
    for (let i = 0; i < 6; i++) {
      const { rawTx } = this.signUnsignedTransaction(inputs, outputs, fee);
      const required = requiredBlsctFee(rawTx.length / 2);
      if (fee >= required) break;
      fee = required;
      ({ outputs } = buildOutputs(fee));
    }

    return this.signAndBroadcastUnsignedTransaction(walletDB, inputs, outputs, fee);
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
        subAddr: this.decodeDestinationAddress(recipient.address),
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

    const navTokenId = TokenId.default();
    const inputs = selected.map((utxo) => ({ output: utxo, tokenId: navTokenId }));
    const baseAmounts = decodedRecipients.map((recipient) => recipient.amount);

    // Build the recipient + change outputs for a candidate fee. Uses the manual
    // UnsignedTransaction path (not build_ctx): the tx then contains exactly the
    // recipient outputs, a single change output, and a single fee output.
    // build_ctx instead appends its own change output to a zero/burn destination
    // for any input-vs-output surplus and recomputes the fee itself, so an
    // overpaid fee would be siphoned into a spurious, unspendable extra output.
    const buildOutputs = (fee: bigint): { outputs: InstanceType<typeof UnsignedOutput>[]; changeAmount: bigint } => {
      const sendAmounts = [...baseAmounts];
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
              `(${baseAmounts[recipientIndex]} sat)`
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

      const outputs: InstanceType<typeof UnsignedOutput>[] = [];
      for (let i = 0; i < decodedRecipients.length; i++) {
        const recipient = decodedRecipients[i];
        outputs.push(UnsignedOutput.fromTxOut(TxOut.generate(
          recipient.subAddr,
          Number(sendAmounts[i]),
          recipient.memo,
          navTokenId,
          TxOutputType.Normal,
          0,
          false,
          Scalar.random(),
        )));
      }

      if (changeAmount > 0n) {
        outputs.push(UnsignedOutput.fromTxOut(TxOut.generate(
          this.getChangeSubAddress(),
          Number(changeAmount),
          '',
          navTokenId,
          TxOutputType.Normal,
          0,
          false,
          Scalar.random(),
        )));
      }

      return { outputs, changeAmount };
    };

    // Fee fixpoint on the actual signed (witness-inclusive) size. The flat
    // per-component estimate underprices BLSCT range proofs and the node rejects
    // with `blsct-fee-below-min`; iterate until the size-implied requirement
    // stops growing (raising the fee shrinks change and thus the tx).
    let fee = BigInt((selected.length + recipients.length + 1) * DEFAULT_FEE_PER_COMPONENT);
    let { outputs } = buildOutputs(fee);
    for (let i = 0; i < 6; i++) {
      const { rawTx } = this.signUnsignedTransaction(inputs, outputs, fee);
      const required = requiredBlsctFee(rawTx.length / 2);
      if (fee >= required) break;
      fee = required;
      ({ outputs } = buildOutputs(fee));
    }

    return this.signAndBroadcastUnsignedTransaction(walletDB, inputs, outputs, fee);
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

    const outputs = [UnsignedOutput.createTokenCollection(tokenKey, tokenInfo)];

    let mintedAmount: bigint | undefined;
    if (options.initialMint) {
      const mintAmount = toSafeInteger(options.initialMint.amount, 'initialMint.amount');
      if (mintAmount <= 0) {
        throw new Error('initialMint.amount must be positive');
      }
      if (mintAmount > totalSupply) {
        throw new Error('initialMint.amount exceeds totalSupply');
      }
      const mintDestination = this.decodeDestinationAddress(options.initialMint.address);
      // The create output must precede the mint output: consensus executes
      // predicates in output order, and the mint predicate requires the
      // token to already exist in the view.
      outputs.push(
        UnsignedOutput.mintToken(mintDestination, mintAmount, Scalar.random(), tokenKey, tokenPublicKey)
      );
      mintedAmount = BigInt(mintAmount);
    }

    let result: SendTransactionResult;
    try {
      result = await this.buildAndBroadcastUnsignedTransaction(outputs, options.selectedUtxos);
    } catch (err) {
      throw options.initialMint ? augmentMintBroadcastError(err, collectionTokenId) : err;
    }

    await this.recordCreatedCollection('token', collectionTokenId, tokenPublicKey.serialize(), metadata, totalSupply, result.txId);

    return {
      ...result,
      kind: 'token',
      collectionTokenId,
      tokenPublicKey: tokenPublicKey.serialize(),
      publicTokenId: publicTokenIdFromPublicKeyHex(tokenPublicKey.serialize()),
      ...(mintedAmount !== undefined ? { mintedAmount } : {}),
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

    await this.recordCreatedCollection('nft', collectionTokenId, tokenPublicKey.serialize(), metadata, totalSupply, result.txId);

    return {
      ...result,
      kind: 'nft',
      collectionTokenId,
      tokenPublicKey: tokenPublicKey.serialize(),
      publicTokenId: publicTokenIdFromPublicKeyHex(tokenPublicKey.serialize()),
    };
  }

  /**
   * Best-effort record of a collection created by this wallet, so
   * listCreatedCollections can report it without a chain lookup. Failure to
   * record never fails the (already broadcast) creation.
   */
  private async recordCreatedCollection(
    kind: 'token' | 'nft',
    collectionTokenId: string,
    tokenPublicKey: string,
    metadata: TokenMetadata,
    totalSupply: number,
    txId: string,
  ): Promise<void> {
    try {
      await this.walletDB?.saveCreatedCollection({
        collectionTokenId,
        kind,
        tokenPublicKey,
        metadata,
        totalSupply,
        txId,
        createdAt: Math.floor(Date.now() / 1000),
      });
    } catch {
      // Recording is informational only.
    }
  }

  /**
   * List the token/NFT collections this wallet created.
   *
   * Combines two sources:
   * - `local`: collections recorded in the wallet database when
   *   createTokenCollection/createNftCollection broadcast them.
   * - `chain`: for restored wallets (whose database has no local records),
   *   two discovery passes run against the electrum backend. Every distinct
   *   token held by the wallet is looked up in the server's token registry
   *   (`blockchain.token.get_token`), and the wallet's own transactions are
   *   scanned for create-token predicates — the create transaction spends
   *   the wallet's NAV, so its hash is known after a sync even when the
   *   collection was never minted or held. A collection is reported when its
   *   on-chain token public key re-derives from this wallet's seed — the
   *   same ownership proof minting uses.
   *
   * The returned `collectionTokenId` is the creation id, directly usable with
   * mintToken/mintNft.
   */
  async listCreatedCollections(options: { discoverFromChain?: boolean } = {}): Promise<CreatedCollectionInfo[]> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.walletDB) {
      throw new Error('Client not initialized');
    }

    const collections = new Map<string, CreatedCollectionInfo>();
    for (const record of await this.walletDB.getCreatedCollections()) {
      collections.set(record.collectionTokenId, {
        kind: record.kind,
        collectionTokenId: record.collectionTokenId,
        publicTokenId: publicTokenIdFromPublicKeyHex(record.tokenPublicKey),
        tokenPublicKey: record.tokenPublicKey,
        metadata: record.metadata,
        totalSupply: BigInt(record.totalSupply),
        txId: record.txId,
        createdAt: record.createdAt,
        source: 'local',
      });
    }

    const discover = options.discoverFromChain ?? true;
    if (discover && this.electrumClient && this.keyManager) {
      const assets = await this.getAssetBalances();
      const tokenHashes = new Set<string>();
      for (const asset of assets) {
        try {
          const hash = describeTokenId(asset.tokenId).collectionTokenId;
          if (hash) {
            tokenHashes.add(hash);
          }
        } catch {
          // Ignore malformed stored token ids.
        }
      }

      for (const tokenHash of tokenHashes) {
        let onChainToken: any;
        try {
          onChainToken = await this.electrumClient.getToken(tokenHash);
        } catch {
          continue; // unknown token or server without the bridge
        }
        if (!onChainToken || typeof onChainToken !== 'object' || !onChainToken.publicKey) {
          continue;
        }
        try {
          const kind: 'token' | 'nft' = onChainToken.type === 'nft' ? 'nft' : 'token';
          const metadata = tokenMetadataFromChainRecord(onChainToken.metadata);
          const totalSupply = toSafeInteger(BigInt(onChainToken.maxSupply ?? 0), 'maxSupply');
          const creationTokenId = normalizeCollectionTokenHashHex(calcCollectionTokenHashHex(metadata, totalSupply));
          const derived = this.buildCollectionTokenContext(creationTokenId);
          if (String(derived.tokenPublicKey.serialize()).toLowerCase()
              !== String(onChainToken.publicKey).toLowerCase()) {
            continue; // held, but created by someone else
          }
          if (!collections.has(creationTokenId)) {
            collections.set(creationTokenId, {
              kind,
              collectionTokenId: creationTokenId,
              publicTokenId: publicTokenIdFromPublicKeyHex(String(onChainToken.publicKey)),
              tokenPublicKey: String(onChainToken.publicKey).toLowerCase(),
              metadata,
              totalSupply: BigInt(totalSupply),
              source: 'chain',
            });
          }
        } catch {
          // Skip records that fail to parse or derive.
        }
      }

      // Second pass: scan the wallet's own transactions for create-token
      // predicates. This recovers collections the wallet created but never
      // minted or held an output of — the create transaction spends the
      // wallet's NAV and pays change back, so its hash is known even to a
      // freshly restored wallet after a sync.
      const txHashes = new Set<string>();
      for (const output of await this.getAllOutputs()) {
        if (output.txType === 'sent' && output.txHash && !output.txHash.startsWith('mempool:')) {
          txHashes.add(output.txHash);
        }
        if (output.isSpent && output.spentTxHash) {
          txHashes.add(output.spentTxHash);
        }
      }

      const {
        getPredicateType, parseCreateTokenPredicateTokenInfo, BlsctPredicateType,
      } = blsctModule as any;

      for (const txHash of txHashes) {
        let ctx: any;
        try {
          const rawTx = await this.electrumClient.getRawTransaction(txHash);
          ctx = CTx.deserialize(rawTx);
        } catch {
          continue; // pruned/unknown tx — nothing to scan
        }

        const outs = ctx.getCTxOuts();
        const numOuts = outs.size();
        for (let i = 0; i < numOuts; i++) {
          try {
            const predicateHex = outs.at(i).getVectorPredicate();
            if (!predicateHex
                || getPredicateType(predicateHex) !== BlsctPredicateType.BlsctCreateTokenPredicateType) {
              continue;
            }
            const info = parseCreateTokenPredicateTokenInfo(predicateHex);
            const metadata = normalizeTokenMetadata(info.getMetadata());
            const totalSupply = toSafeInteger(info.getTotalSupply(), 'totalSupply');
            const creationTokenId = normalizeCollectionTokenHashHex(
              calcCollectionTokenHashHex(metadata, totalSupply)
            );
            if (collections.has(creationTokenId)) {
              continue;
            }
            const derived = this.buildCollectionTokenContext(creationTokenId);
            const predicatePublicKey = String(info.getPublicKey().serialize()).toLowerCase();
            if (String(derived.tokenPublicKey.serialize()).toLowerCase() !== predicatePublicKey) {
              continue; // a create in the same (aggregated) tx by someone else
            }
            collections.set(creationTokenId, {
              kind: info.getType() === TokenType.Nft ? 'nft' : 'token',
              collectionTokenId: creationTokenId,
              publicTokenId: publicTokenIdFromPublicKeyHex(predicatePublicKey),
              tokenPublicKey: predicatePublicKey,
              metadata,
              totalSupply: BigInt(totalSupply),
              txId: txHash,
              source: 'chain',
            });
          } catch {
            // Skip outputs whose predicate fails to parse.
          }
        }
      }
    }

    return [...collections.values()];
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

    const destination = this.decodeDestinationAddress(options.address);
    const { collectionTokenId, tokenKey, tokenPublicKey } =
      await this.resolveCollectionTokenContext(options.collectionTokenId, 'token');

    let result: SendTransactionResult;
    try {
      result = await this.buildAndBroadcastUnsignedTransaction(
        UnsignedOutput.mintToken(destination, mintAmount, Scalar.random(), tokenKey, tokenPublicKey),
        options.selectedUtxos
      );
    } catch (err) {
      throw augmentMintBroadcastError(err, collectionTokenId);
    }

    return {
      ...result,
      kind: 'token',
      collectionTokenId,
      tokenId: collectionTokenId,
      tokenPublicKey: tokenPublicKey.serialize(),
      publicTokenId: publicTokenIdFromPublicKeyHex(tokenPublicKey.serialize()),
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
    const destination = this.decodeDestinationAddress(options.address);
    const { collectionTokenId, tokenKey, tokenPublicKey } =
      await this.resolveCollectionTokenContext(options.collectionTokenId, 'nft');

    let result: SendTransactionResult;
    try {
      result = await this.buildAndBroadcastUnsignedTransaction(
        UnsignedOutput.mintNft(destination, Scalar.random(), tokenKey, tokenPublicKey, nftId, metadata),
        options.selectedUtxos
      );
    } catch (err) {
      throw augmentMintBroadcastError(err, collectionTokenId);
    }

    return {
      ...result,
      kind: 'nft',
      collectionTokenId,
      tokenId: composeNftTokenId(collectionTokenId, normalizedNftId),
      tokenPublicKey: tokenPublicKey.serialize(),
      publicTokenId: publicTokenIdFromPublicKeyHex(tokenPublicKey.serialize()),
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

  // ============================================================================
  // RFQ / Atomic-Swap Trading (Navio p2pmsg bus)
  //
  // Light-wallet participation in on-chain atomic swaps, both as taker and as
  // maker, bridged through the connected ElectrumX server. Swap halves are
  // BLSCT transactions that deliberately output a token they do not input
  // (the received leg); the counterparty's half supplies it, so the combined
  // transaction balances per token and the aggregate BLS signature verifies.
  // Halves are always built and signed locally — keys never leave the client.
  // ============================================================================

  /**
   * Require the electrum backend and return its client. Trading needs the
   * ElectrumX RFQ bridge; the raw P2P backend does not carry it.
   */
  private getTradingClient(): ElectrumClient {
    if (!this.electrumClient) {
      throw new Error('Trading requires the electrum backend');
    }
    return this.electrumClient;
  }

  /**
   * Normalize a public tokenId to the daemon's token-hash argument:
   * 64-hex display-order hash, or the empty string for NAV. NFT sub-ids are
   * not supported by the swap protocol.
   */
  private static toDaemonToken(tokenId: string | null): string {
    if (tokenId === null) {
      return '';
    }
    const normalized = tokenId.toLowerCase().replace(/^0x/, '');
    if (normalized.length === TOKEN_ID_HEX_LENGTH
        && normalized.slice(TOKEN_HASH_HEX_LENGTH) !== TOKEN_ID_NO_SUBID_HEX) {
      throw new Error('NFT token ids (with sub-id) are not supported for swaps');
    }
    if (normalized.length !== TOKEN_HASH_HEX_LENGTH
        && normalized.length !== TOKEN_ID_HEX_LENGTH) {
      throw new Error(`Invalid tokenId length: expected ${TOKEN_HASH_HEX_LENGTH} or ${TOKEN_ID_HEX_LENGTH} hex chars`);
    }
    const hash = normalized.slice(0, TOKEN_HASH_HEX_LENGTH);
    return hash === DEFAULT_NAV_TOKEN_HASH_HEX ? '' : hash;
  }

  /** Map a daemon token-hash result back to a public tokenId (null = NAV). */
  private static fromDaemonToken(tokenHash: string): string | null {
    if (!tokenHash || tokenHash === DEFAULT_NAV_TOKEN_HASH_HEX) {
      return null;
    }
    return tokenHash;
  }

  private static parseQuoteSummary(raw: any): QuoteSummary {
    return {
      quoteId: raw.quote_id,
      fill: BigInt(raw.fill),
      sellCost: BigInt(raw.sell_cost),
      price: Number(raw.price),
      orderExpiry: Number(raw.order_expiry),
    };
  }

  private static parsePendingQuoteRequest(raw: any): PendingQuoteRequest {
    return {
      uuid: raw.uuid,
      buyTokenId: NavioClient.fromDaemonToken(raw.buy_token),
      sellTokenId: NavioClient.fromDaemonToken(raw.sell_token),
      fill: BigInt(raw.fill),
      sellCost: BigInt(raw.sell_cost),
      replyKey: raw.reply_key,
    };
  }

  /**
   * Open a request-for-quote to buy `amount` of a token, paying with another
   * (taker side). The daemon broadcasts the request over the encrypted p2p
   * messaging bus and collects maker quotes; poll {@link listQuotes} and
   * accept one with {@link acceptQuote} before `expiry`.
   *
   * @example
   * ```typescript
   * const req = await client.requestQuote({
   *   buyTokenId: token, sellTokenId: null,
   *   amount: 100_000_000n, expiry: Math.floor(Date.now() / 1000) + 300,
   * });
   * // later:
   * const quotes = await client.listQuotes(req.uuid);
   * ```
   */
  async requestQuote(options: RequestQuoteOptions): Promise<RequestQuoteResult> {
    if (options.amount <= 0n) {
      throw new Error('Amount must be positive');
    }
    const electrum = this.getTradingClient();
    const res = await electrum.rfqRequestQuote(
      NavioClient.toDaemonToken(options.buyTokenId),
      NavioClient.toDaemonToken(options.sellTokenId),
      toSafeInteger(options.amount, 'amount'),
      options.expiry,
    );
    return { uuid: res.uuid, replyKey: res.reply_key };
  }

  /**
   * List maker quotes collected so far for an open request, cheapest first.
   */
  async listQuotes(uuid: string, minFillRatio = 1.0): Promise<QuoteSummary[]> {
    const electrum = this.getTradingClient();
    const quotes = await electrum.rfqListQuotes(uuid, minFillRatio);
    return quotes.map(NavioClient.parseQuoteSummary);
  }

  /** Cancel an open request-for-quote, discarding its collected quotes. */
  async cancelQuoteRequest(uuid: string): Promise<boolean> {
    return this.getTradingClient().rfqCancel(uuid);
  }

  /**
   * Accept a collected quote (taker side): builds and signs this wallet's
   * unbalanced half — paying the quoted sell amount from its coins and
   * receiving the quoted fill of the buy token — and submits it; the server's
   * daemon combines it with the maker half and broadcasts the atomic swap.
   *
   * `maxPay` / `minRecv` are mandatory slippage bounds. The BLSCT balance
   * proof guarantees no funds move unless both halves commit the same
   * amounts, but it cannot protect against an unfavourable *rate* — these
   * bounds are the taker's only trust anchor against a malicious quote.
   */
  async acceptQuote(options: AcceptQuoteOptions): Promise<AcceptQuoteResult> {
    const { uuid, quoteId, maxPay, minRecv } = options;
    if (maxPay === undefined || minRecv === undefined) {
      throw new Error('maxPay and minRecv slippage bounds are required');
    }
    const electrum = this.getTradingClient();

    const quotes = await this.listQuotes(uuid, 0);
    const quote = quotes.find((q) => q.quoteId === quoteId);
    if (!quote) {
      throw new Error(`Quote ${quoteId} not found for request ${uuid}`);
    }
    if (quote.sellCost > maxPay) {
      throw new Error(`Quote charges ${quote.sellCost} which exceeds maxPay ${maxPay}`);
    }
    if (quote.fill < minRecv) {
      throw new Error(`Quote delivers ${quote.fill} which is below minRecv ${minRecv}`);
    }

    // The taker half pays no fee: the maker half over-funds the combined fee.
    const { halfHex, fee, spentInputs } = await this.buildSwapHalf({
      payTokenId: options.sellTokenId,
      payAmount: quote.sellCost,
      recvTokenId: options.buyTokenId,
      recvAmount: quote.fill,
      makerFee: false,
      selectedUtxos: options.selectedUtxos,
    });

    const txId = await electrum.rfqAcceptQuote(uuid, quoteId, halfHex);

    const { walletDB } = await this.ensureSpendReady();
    for (const outputHash of spentInputs) {
      await walletDB.markOutputSpent(outputHash, txId, 0);
    }

    return { txId, quote, fee };
  }

  /**
   * Configure a maker swap intent on the connected daemon: offer to pay out
   * `tokenInId` for `tokenOutId` within a size band at a minimum price.
   * Matching inbound RFQ requests surface via
   * {@link getPendingQuoteRequests} / {@link subscribePendingQuoteRequests}
   * and are answered with {@link replyQuote}.
   *
   * Note: intents live on the daemon and are shared by all clients of the
   * same ElectrumX server; they do not survive a daemon restart.
   */
  async setSwapIntent(options: SwapIntentOptions): Promise<number> {
    if (options.minSize < 0n || options.maxSize < options.minSize) {
      throw new Error('Invalid size band');
    }
    if (options.priceMin < 0n) {
      throw new Error('priceMin must be non-negative');
    }
    const electrum = this.getTradingClient();
    return electrum.swapSetIntent(
      NavioClient.toDaemonToken(options.tokenInId),
      NavioClient.toDaemonToken(options.tokenOutId),
      toSafeInteger(options.minSize, 'minSize'),
      toSafeInteger(options.maxSize, 'maxSize'),
      toSafeInteger(options.priceMin, 'priceMin'),
      options.expiry,
    );
  }

  /** Remove a maker swap intent by id. */
  async clearSwapIntent(intentId: number): Promise<boolean> {
    return this.getTradingClient().swapClearIntent(intentId);
  }

  /** List the daemon's maker swap intents. */
  async listSwapIntents(): Promise<SwapIntent[]> {
    const intents = await this.getTradingClient().swapListIntents();
    return intents.map((raw: any) => ({
      id: Number(raw.id),
      tokenIn: NavioClient.fromDaemonToken(raw.token_in),
      tokenOut: NavioClient.fromDaemonToken(raw.token_out),
      minSize: BigInt(raw.min_size),
      maxSize: BigInt(raw.max_size),
      priceMin: BigInt(raw.price_min),
      expiry: Number(raw.expiry),
    }));
  }

  /**
   * List inbound RFQ requests that matched a swap intent and await a reply
   * (maker side). Answer with {@link replyQuote}.
   */
  async getPendingQuoteRequests(): Promise<PendingQuoteRequest[]> {
    const pending = await this.getTradingClient().swapPendingRequests();
    return pending.map(NavioClient.parsePendingQuoteRequest);
  }

  /**
   * Subscribe to pending matched RFQ requests (maker side). The callback
   * fires with the full updated list whenever it changes.
   * @returns The current pending list
   */
  async subscribePendingQuoteRequests(
    callback: (pending: PendingQuoteRequest[]) => void,
  ): Promise<PendingQuoteRequest[]> {
    const electrum = this.getTradingClient();
    const current = await electrum.subscribeSwapPendingRequests((pending) => {
      callback((pending ?? []).map(NavioClient.parsePendingQuoteRequest));
    });
    return (current ?? []).map(NavioClient.parsePendingQuoteRequest);
  }

  /** Stop pending quote request notifications. */
  async unsubscribePendingQuoteRequests(): Promise<boolean> {
    return this.getTradingClient().unsubscribeSwapPendingRequests();
  }

  /**
   * Answer a pending quote request (maker side): builds and signs this
   * wallet's unbalanced half — delivering the requested fill and receiving
   * the sell cost — and hands it to the daemon, which wraps it in a quote,
   * encrypts it to the taker's reply key and broadcasts it over the bus.
   *
   * The half over-funds the transaction fee so the taker can accept with a
   * fee-free half. The coins it spends are NOT locked: if the taker accepts,
   * the wallet sees them spent on-chain; if the quote expires unaccepted,
   * they remain spendable. Avoid spending them manually while a quote is
   * outstanding, or the swap will fail to confirm.
   */
  async replyQuote(options: ReplyQuoteOptions): Promise<MakerQuoteResult> {
    const { request } = options;
    const electrum = this.getTradingClient();
    const orderExpiry = options.orderExpiry ?? Math.floor(Date.now() / 1000) + 600;

    // The maker pays what the taker buys, and receives what the taker sells.
    const { halfHex, fee } = await this.buildSwapHalf({
      payTokenId: request.buyTokenId,
      payAmount: request.fill,
      recvTokenId: request.sellTokenId,
      recvAmount: request.sellCost,
      makerFee: true,
      selectedUtxos: options.selectedUtxos,
    });

    const quoteId = await electrum.swapSendQuote(
      request.uuid,
      request.replyKey,
      halfHex,
      NavioClient.toDaemonToken(request.buyTokenId),
      NavioClient.toDaemonToken(request.sellTokenId),
      toSafeInteger(request.fill, 'fill'),
      toSafeInteger(request.sellCost, 'sellCost'),
      orderExpiry,
    );

    return { quoteId, fee, halfTxHex: halfHex };
  }

  /**
   * Publish a standing swap order (maker side): a pre-signed half offering
   * `offerAmount` of `offerTokenId` for `wantAmount` of `wantTokenId`. Peers
   * cache it (up to 14 days) and can answer matching RFQs with it while this
   * wallet is offline. The same coin-locking caveat as {@link replyQuote}
   * applies for the lifetime of the order.
   */
  async broadcastOrder(options: BroadcastOrderOptions): Promise<MakerQuoteResult> {
    if (options.offerAmount <= 0n || options.wantAmount <= 0n) {
      throw new Error('Amounts must be positive');
    }
    const electrum = this.getTradingClient();

    const { halfHex, fee } = await this.buildSwapHalf({
      payTokenId: options.offerTokenId,
      payAmount: options.offerAmount,
      recvTokenId: options.wantTokenId,
      recvAmount: options.wantAmount,
      makerFee: true,
      selectedUtxos: options.selectedUtxos,
    });

    const quoteId = await electrum.swapBroadcastOrder(
      halfHex,
      NavioClient.toDaemonToken(options.offerTokenId),
      toSafeInteger(options.offerAmount, 'offerAmount'),
      NavioClient.toDaemonToken(options.wantTokenId),
      toSafeInteger(options.wantAmount, 'wantAmount'),
      options.expiry,
    );

    return { quoteId, fee, halfTxHex: halfHex };
  }

  /**
   * Build and sign an unbalanced swap half: inputs cover `payAmount` of the
   * pay token (plus the fee, when this half funds it); outputs are the
   * received leg (recv token, no matching input — the counterparty's half
   * supplies it), pay-token change, and NAV change when the fee is funded
   * from separate NAV inputs.
   *
   * Fee: a taker half sets fee = 0 (the maker over-funds); a maker half
   * iterates to the consensus-required fee for its own size plus a fixed
   * allowance covering the taker's fee-free half.
   */
  private async buildSwapHalf(params: {
    payTokenId: string | null;
    payAmount: bigint;
    recvTokenId: string | null;
    recvAmount: bigint;
    makerFee: boolean;
    selectedUtxos?: string[];
  }): Promise<{ halfHex: string; fee: bigint; spentInputs: string[] }> {
    const { keyManager } = await this.ensureSpendReady();
    const { payAmount, recvAmount, makerFee } = params;
    if (payAmount <= 0n || recvAmount <= 0n) {
      throw new Error('Swap amounts must be positive');
    }

    // Resolve token ids to the wallet's stored representation.
    const allOutputs = await this.getAllOutputs();
    const resolveToken = (tokenId: string | null): { publicId: string | null; blsct: InstanceType<typeof TokenId> } => {
      if (tokenId === null) {
        return { publicId: null, blsct: TokenId.default() };
      }
      const normalized = resolveRequestedTokenId(tokenId, allOutputs);
      return { publicId: normalized, blsct: TokenId.deserialize(publicToStoredTokenIdHex(normalized)) };
    };
    const pay = resolveToken(params.payTokenId);
    const recv = params.recvTokenId === null
      ? { publicId: null, blsct: TokenId.default() }
      : (() => {
        // The recv token may not appear in this wallet yet; fall back to the
        // raw public id when resolution finds no owned outputs.
        try {
          return resolveToken(params.recvTokenId);
        } catch {
          return {
            publicId: params.recvTokenId,
            blsct: TokenId.deserialize(publicToStoredTokenIdHex(params.recvTokenId!)),
          };
        }
      })();

    // resolveRequestedTokenId already yields the stored representation, so
    // compare stored tokenIds directly (same convention as sendTransaction's
    // token branch). NAV outputs are stored with tokenId === null.
    const spendable = (utxo: WalletOutput, publicId: string | null): boolean =>
      !utxo.isSpent && utxo.blockHeight > 0 && utxo.tokenId === publicId;
    const payUtxos = allOutputs.filter((utxo) => spendable(utxo, pay.publicId));
    const navUtxos = pay.publicId === null
      ? payUtxos
      : allOutputs.filter((utxo) => spendable(utxo, null));

    const manualHashes = params.selectedUtxos ?? [];
    const manualPay: WalletOutput[] = [];
    const manualNav: WalletOutput[] = [];
    if (manualHashes.length > 0) {
      const payByHash = new Map(payUtxos.map((utxo) => [utxo.outputHash, utxo]));
      const navByHash = new Map(navUtxos.map((utxo) => [utxo.outputHash, utxo]));
      for (const hash of manualHashes) {
        const payUtxo = payByHash.get(hash);
        if (payUtxo) {
          manualPay.push(payUtxo);
          continue;
        }
        const navUtxo = navByHash.get(hash);
        if (navUtxo) {
          manualNav.push(navUtxo);
          continue;
        }
        throw new Error(`Selected UTXO not found or not spendable: ${hash.slice(0, 16)}...`);
      }
    }

    // Receive the swapped leg on the wallet's primary subaddress: it is part
    // of the tracked subaddress pool, so the scanner detects the output when
    // the swap confirms (a freshly generated destination would not be).
    const recvDestination = keyManager.getSubAddress({ account: 0, address: 0 });
    const changeSubAddr = this.getChangeSubAddress();

    const buildOutputs = (
      payChange: bigint,
      navChange: bigint,
    ): InstanceType<typeof UnsignedOutput>[] => {
      const outputs: InstanceType<typeof UnsignedOutput>[] = [];
      // The received leg: an output with no matching input in this half.
      outputs.push(UnsignedOutput.fromTxOut(TxOut.generate(
        recvDestination, toSafeInteger(recvAmount, 'recvAmount'), 'swap-recv', recv.blsct,
        TxOutputType.Normal, 0, false, Scalar.random(),
      )));
      if (payChange > 0n) {
        outputs.push(UnsignedOutput.fromTxOut(TxOut.generate(
          changeSubAddr, toSafeInteger(payChange, 'pay change'), '', pay.blsct,
          TxOutputType.Normal, 0, false, Scalar.random(),
        )));
      }
      if (navChange > 0n) {
        outputs.push(UnsignedOutput.fromTxOut(TxOut.generate(
          changeSubAddr, toSafeInteger(navChange, 'NAV change'), '', TokenId.default(),
          TxOutputType.Normal, 0, false, Scalar.random(),
        )));
      }
      return outputs;
    };

    const payIsNav = pay.publicId === null;
    const feeGuess = makerFee
      ? BigInt(4 * DEFAULT_FEE_PER_COMPONENT) + MAKER_TAKER_FEE_ALLOWANCE
      : 0n;

    // Select pay-token inputs (covering the fee too when paying in NAV).
    let selectedPay: WalletOutput[];
    let totalPayIn: bigint;
    if (manualPay.length > 0) {
      selectedPay = manualPay;
      totalPayIn = manualPay.reduce((sum, utxo) => sum + utxo.amount, 0n);
    } else {
      ({ selected: selectedPay, totalIn: totalPayIn } = NavioClient.selectInputsByAmount(
        payUtxos, payAmount + (payIsNav ? feeGuess : 0n),
      ));
    }
    if (totalPayIn < payAmount) {
      throw new Error(
        `Insufficient funds: need ${payAmount} of the pay token but only have ${totalPayIn}`
      );
    }

    // Select separate NAV inputs for the fee when paying with a token.
    let selectedNav: WalletOutput[] = manualNav;
    let totalNavIn = manualNav.reduce((sum, utxo) => sum + utxo.amount, 0n);
    if (makerFee && !payIsNav && selectedNav.length === 0) {
      ({ selected: selectedNav, totalIn: totalNavIn } = NavioClient.selectInputsByAmount(
        navUtxos, feeGuess,
      ));
      if (totalNavIn === 0n) {
        throw new Error('No unspent NAV outputs available to fund the swap fee');
      }
    }

    const makeInputs = (): Array<{ output: WalletOutput; tokenId: InstanceType<typeof TokenId> }> => [
      ...selectedPay.map((output) => ({ output, tokenId: pay.blsct })),
      ...selectedNav.filter(() => !payIsNav).map((output) => ({ output, tokenId: TokenId.default() })),
    ];

    // Fee fixpoint. Taker halves pay 0; maker halves must clear the consensus
    // minimum for their own signed size plus the taker allowance.
    let fee = 0n;
    let halfHex = '';
    for (let i = 0; i < 6; i++) {
      const feeFromNav = payIsNav ? fee : 0n;
      const payChange = totalPayIn - payAmount - feeFromNav;
      const navChange = payIsNav ? 0n : totalNavIn - fee;
      if (payChange < 0n) {
        throw new Error(
          `Insufficient funds: need ${payAmount + feeFromNav} (amount + fee) but only have ${totalPayIn}`
        );
      }
      if (navChange < 0n) {
        throw new Error(
          `Insufficient NAV funds for the swap fee: need ${fee} but only have ${totalNavIn}`
        );
      }

      const outputs = buildOutputs(payChange, navChange);
      const { rawTx } = this.signUnsignedTransaction(makeInputs(), outputs, fee);
      halfHex = rawTx;

      if (!makerFee) {
        break;
      }
      const required = requiredBlsctFee(rawTx.length / 2) + MAKER_TAKER_FEE_ALLOWANCE;
      if (fee >= required) {
        break;
      }
      fee = required;
    }

    return {
      halfHex,
      fee,
      spentInputs: [
        ...selectedPay.map((utxo) => utxo.outputHash),
        ...(payIsNav ? [] : selectedNav.map((utxo) => utxo.outputHash)),
      ],
    };
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
   * Decode a destination address, first checking that its bech32 prefix
   * belongs to the network this client is configured for. Catches wallets
   * that mix up networks (e.g. a testnet address sent to a mainnet client)
   * before an invalid transaction is built and broadcast.
   */
  private decodeDestinationAddress(addressStr: string): InstanceType<typeof SubAddr> {
    const network = this.getNetwork();
    const expectedHrp = NETWORK_ADDRESS_HRP[network];
    const separator = addressStr.lastIndexOf('1');
    const hrp = separator > 0 ? addressStr.slice(0, separator).toLowerCase() : '';
    if (expectedHrp && hrp && hrp !== expectedHrp) {
      const addressNetworks = Object.entries(NETWORK_ADDRESS_HRP)
        .filter(([, prefix]) => prefix === hrp)
        .map(([net]) => net);
      const belongsTo = addressNetworks.length > 0 ? addressNetworks.join('/') : `unknown network (prefix "${hrp}")`;
      throw new Error(
        `Address "${addressStr.slice(0, 12)}…" is a ${belongsTo} address, but this client is configured for ${network} ` +
        `(expected prefix "${expectedHrp}1…").`
      );
    }
    return NavioClient.decodeAddress(addressStr);
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

    await this.verifyWalletMatchesChain();

    return {
      keyManager: this.keyManager,
      walletDB: this.walletDB,
    };
  }

  /**
   * Verify the wallet database was synced against the chain the connected
   * backend serves, by comparing the stored hash of the last synced block
   * with the backend's header at that height. A wallet database synced on
   * one network but spent against another selects UTXOs the node has never
   * seen, and every spend is rejected with `bad-txns-inputs-missingorspent`
   * — fail fast with an actionable message instead. A deep-reorg mismatch
   * trips the same check; re-syncing resolves both.
   *
   * Backend/transport errors are swallowed: this is a safety net and must
   * not add a new failure mode to spending.
   */
  private async verifyWalletMatchesChain(): Promise<void> {
    if (!this.walletDB || !this.syncProvider) {
      return;
    }

    let state;
    try {
      state = await this.walletDB.loadSyncState();
    } catch {
      return;
    }
    if (!state || state.lastSyncedHeight <= 0 || !state.lastSyncedHash) {
      return;
    }

    let headerHex: string;
    try {
      headerHex = await this.syncProvider.getBlockHeader(state.lastSyncedHeight);
    } catch {
      return;
    }
    if (!headerHex || typeof headerHex !== 'string') {
      return;
    }

    const headerHash = Buffer.from(sha256(sha256(Buffer.from(headerHex, 'hex'))))
      .reverse()
      .toString('hex');
    if (headerHash !== state.lastSyncedHash.toLowerCase()) {
      throw new Error(
        `Wallet state does not match the connected ${this.getNetwork()} chain: block ${state.lastSyncedHeight} ` +
        `is ${state.lastSyncedHash.slice(0, 16)}… in the wallet but ${headerHash.slice(0, 16)}… on the backend. ` +
        'The wallet database was synced against a different network (or the chain reorged past it). ' +
        'Re-sync this wallet against the connected backend — or use the wallet database that belongs to this network — before spending.'
      );
    }
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

  /**
   * Resolve the collection id a caller passed to a mint into the CREATION id
   * the mint predicate key derives from.
   *
   * A collection has two distinct 64-hex ids and mixing them up is the #1
   * mint failure: the creation id `Hash(metadata‖totalSupply)` (returned by
   * createTokenCollection/createNftCollection, input to the key derivation)
   * and the public on-chain id `hash(tokenPublicKey)` (what explorers,
   * `gettoken`, and wallet balances report). Deriving the mint key from the
   * public id produces a key the predicate rejects, and the node's only
   * feedback is an opaque `failed-to-execute-predicate`.
   *
   * When the connected server bridges `blockchain.token.get_token`, look the
   * id up on-chain: if it names an existing token, recompute the creation id
   * from the token's metadata and supply, re-derive the collection key, and
   * prove ownership by comparing the derived public key with the on-chain
   * one. Unknown ids (or servers without the bridge) fall back to treating
   * the id as a creation id, which is the pre-existing behavior.
   */
  private async resolveCollectionTokenContext(
    collectionTokenIdInput: string,
    expectedKind: 'token' | 'nft',
  ): Promise<{
    collectionTokenId: string;
    tokenKey: InstanceType<typeof Scalar>;
    tokenPublicKey: InstanceType<typeof PublicKey>;
  }> {
    const collectionTokenId = normalizeCollectionTokenHashHex(collectionTokenIdInput);

    let onChainToken: any = null;
    if (this.electrumClient) {
      try {
        onChainToken = await this.electrumClient.getToken(collectionTokenId);
      } catch {
        // Unknown token or a server without the RPC bridge — treat the id as
        // a creation id below.
        onChainToken = null;
      }
    }

    if (!onChainToken || typeof onChainToken !== 'object' || !onChainToken.publicKey) {
      return { collectionTokenId, ...this.buildCollectionTokenContext(collectionTokenId) };
    }

    const onChainKind: 'token' | 'nft' = onChainToken.type === 'nft' ? 'nft' : 'token';
    if (onChainKind !== expectedKind) {
      throw new Error(
        `Collection ${collectionTokenId.slice(0, 16)}… is an ${onChainKind === 'nft' ? 'NFT' : 'fungible token'} ` +
        `collection; use ${onChainKind === 'nft' ? 'mintNft' : 'mintToken'} for it.`
      );
    }

    const metadata = tokenMetadataFromChainRecord(onChainToken.metadata);
    const totalSupply = toSafeInteger(BigInt(onChainToken.maxSupply ?? 0), 'maxSupply');
    const creationTokenId = normalizeCollectionTokenHashHex(calcCollectionTokenHashHex(metadata, totalSupply));
    const resolved = this.buildCollectionTokenContext(creationTokenId);

    const derivedPublicKey = String(resolved.tokenPublicKey.serialize()).toLowerCase();
    const onChainPublicKey = String(onChainToken.publicKey).toLowerCase();
    if (derivedPublicKey !== onChainPublicKey) {
      throw new Error(
        `Collection ${collectionTokenId.slice(0, 16)}… exists on-chain but was not created by this wallet: ` +
        'its token key does not derive from this wallet\'s seed, so this wallet cannot sign the mint predicate. ' +
        'Mint from the wallet that created the collection.'
      );
    }

    return { collectionTokenId: creationTokenId, ...resolved };
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
    unsignedOutput: InstanceType<typeof UnsignedOutput> | InstanceType<typeof UnsignedOutput>[],
    selectedUtxos?: string[],
  ): Promise<SendTransactionResult> {
    // Output order is preserved through signing and consensus executes output
    // predicates in order, so callers may rely on it (e.g. a create-collection
    // output registering the token before a mint output in the same tx).
    const assetOutputs = Array.isArray(unsignedOutput) ? unsignedOutput : [unsignedOutput];
    const { walletDB } = await this.ensureSpendReady();
    const { selected, totalIn } = await this.selectFundingUtxos(walletDB, selectedUtxos);
    const inputs = selected.map((utxo) => ({ output: utxo, tokenId: TokenId.default() }));

    let outputs = [...assetOutputs];
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
      const nextOutputs = [...assetOutputs];
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
    // Consensus requires nFee >= GetTransactionWeight(tx) * BLSCT_DEFAULT_FEE_RATE,
    // where the weight is the *fully serialized* (witness-inclusive) byte length
    // of the broadcast transaction. The BLSCT fee output encodes the fee amount
    // as a variable-length script push, so a tx signed with fee=0 serializes
    // smaller than the final fee-bearing tx — estimating at fee=0 underpays and
    // the node rejects with `blsct-fee-below-min`. Iterate to a fixpoint: sign
    // with the current fee, measure the actual size, and bump until the
    // size-implied requirement stops growing (converges in 2-3 rounds since the
    // fee value's encoded length grows only logarithmically).
    let fee = 0n;
    for (let i = 0; i < 5; i++) {
      const { rawTx } = this.signUnsignedTransaction(inputs, outputs, fee);
      const required = requiredBlsctFee(rawTx.length / 2);
      if (required <= fee) break;
      fee = required;
    }
    return fee;
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
