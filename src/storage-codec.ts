/**
 * Encoding shared by the wallet storage backends.
 *
 * Amounts are u64 on chain, which neither a JS number (exact only up to
 * 2^53) nor an SQLite INTEGER (signed 64-bit) can hold. Both backends store
 * them as decimal strings and hand them out as bigint.
 *
 * @module storage-codec
 * @internal
 */

import type { WalletMetadata } from './wallet-db.interface';

/** Largest amount an output (or a token supply) can carry: 2^64 - 1. */
export const MAX_STORED_AMOUNT = (1n << 64n) - 1n;

/** The NAV token id: the zero hash. */
export const NAV_TOKEN_ID = '0'.repeat(64);

/**
 * Every spelling of the NAV token id found in stored rows: the bare zero
 * hash, and `TokenId.serialize()`'s zero hash + ffff… no-subid marker
 * (written by older mempool processing). Lower case.
 */
export const NAV_TOKEN_ID_FORMS: readonly string[] = [
  NAV_TOKEN_ID,
  NAV_TOKEN_ID + 'ffffffffffffffff',
];

/**
 * Whether a stored token id denotes NAV: no token id, or one of
 * {@link NAV_TOKEN_ID_FORMS}.
 */
export function isNavTokenId(tokenId: string | null | undefined): boolean {
  return !tokenId || NAV_TOKEN_ID_FORMS.includes(tokenId.toLowerCase());
}

/**
 * Encode an amount for storage as a decimal string.
 *
 * @param value - The amount; must be a bigint in [0, 2^64 - 1]
 * @param field - Field name for the error message
 * @throws TypeError if the value is not a bigint, RangeError if it is out of range
 */
export function encodeAmount(value: bigint, field = 'amount'): string {
  if (typeof value !== 'bigint') {
    throw new TypeError(`${field} must be a bigint, got ${typeof value}`);
  }
  if (value < 0n || value > MAX_STORED_AMOUNT) {
    throw new RangeError(`${field} out of range: ${value}`);
  }
  return value.toString();
}

/**
 * Decode a stored amount, range-checked like {@link encodeAmount}. Accepts
 * the decimal strings this SDK writes, and the numbers earlier versions
 * wrote: those above 2^53 had already lost precision and keep what is left,
 * but one that rounded past 2^64 - 1 is out of range. Missing values decode
 * to 0.
 *
 * @throws TypeError if the value is not a decimal string or an integer
 *   number, RangeError if it is outside [0, 2^64 - 1]
 */
export function decodeAmount(value: unknown): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  let amount: bigint;
  if (typeof value === 'bigint') {
    amount = value;
  } else if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new TypeError(`stored amount is not an integer: ${value}`);
    amount = BigInt(value);
  } else if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    amount = BigInt(value);
  } else {
    throw new TypeError(`stored amount is not a decimal string: ${String(value)}`);
  }
  if (amount < 0n || amount > MAX_STORED_AMOUNT) {
    throw new RangeError(`stored amount out of range: ${amount}`);
  }
  return amount;
}

const reportedBadAmounts = new Set<string>();

/**
 * Read a stored amount, containing a corrupt one: returns null (and warns
 * once per `rowId`) instead of throwing, so one bad row is left out of a
 * balance or an output listing rather than failing it for the whole wallet.
 *
 * @param value - The stored amount
 * @param rowId - Identifies the row in the warning (e.g. the output hash)
 */
export function readStoredAmount(value: unknown, rowId: string): bigint | null {
  try {
    return decodeAmount(value);
  } catch (err) {
    if (!reportedBadAmounts.has(rowId)) {
      reportedBadAmounts.add(rowId);
      console.warn(`[storage] Ignoring ${rowId}: ${(err as Error).message}`);
    }
    return null;
  }
}

/** Parse stored tx keys JSON; corrupt rows read as absent (null), on every backend. */
export function parseTxKeys(txHash: string, keysData: unknown): any | null {
  try {
    return JSON.parse(keysData as string);
  } catch {
    console.warn(`[storage] Ignoring corrupt tx keys for ${txHash}`);
    return null;
  }
}

/** Key of the IndexedDB `config` record that holds the wallet metadata. */
export const WALLET_METADATA_KEY = 'walletMetadata';

/**
 * The stored wallet metadata record: exactly the {@link WalletMetadata}
 * fields under {@link WALLET_METADATA_KEY}, whatever else `meta` carries.
 */
export function walletMetadataRecord(meta: WalletMetadata): WalletMetadata & { key: string } {
  return {
    key: WALLET_METADATA_KEY,
    creationHeight: meta.creationHeight,
    creationTime: meta.creationTime,
    restoredFromSeed: meta.restoredFromSeed,
    version: meta.version,
  };
}
