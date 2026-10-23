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

/** Largest amount an output (or a token supply) can carry: 2^64 - 1. */
export const MAX_STORED_AMOUNT = (1n << 64n) - 1n;

/** The NAV token id: the zero hash. */
export const NAV_TOKEN_ID = '0'.repeat(64);

/**
 * Every spelling of the NAV token id found in stored rows: the bare zero
 * hash, and `TokenId.serialize()`'s zero hash + ffff… no-subid marker
 * (written by older mempool processing). Lower case.
 */
export const NAV_TOKEN_ID_FORMS: readonly string[] = [NAV_TOKEN_ID, NAV_TOKEN_ID + 'ffffffffffffffff'];

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
 * Decode a stored amount. Accepts the decimal strings this SDK writes, and
 * the numbers earlier versions wrote (which may already have lost precision).
 * Missing values decode to 0.
 */
export function decodeAmount(value: unknown): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n;
  }
  return BigInt(String(value));
}
