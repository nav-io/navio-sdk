/**
 * Recoverable output blinding keys.
 *
 * Every BLSCT output carries a blinding key: the public point goes on chain in
 * `CTxOut.blsctData.blindingKey`, while the private scalar is chosen by the
 * sender. Historically that scalar was `Scalar.random()` and was thrown away,
 * so a sender had no way to prove after the fact that it created a given
 * output. This module derives the scalar deterministically from the wallet
 * seed instead, so it can be recomputed from a seed-only restore.
 *
 * The derivation is normative and shared with navio-core's C++ implementation
 * (`docs/BLINDING-KEY-RECOVERY.md` in the bridge repo). It must not be
 * "improved" — a change here silently strands every output created under the
 * old rule.
 *
 * ```
 * material = "navio-blsct-blinding/v1"   // ASCII, exactly 23 bytes, no NUL
 *          ‖ seed                        // 32 bytes, big-endian, ZERO-PADDED
 *          ‖ anchor.outid                // 32 bytes, INTERNAL byte order
 *          ‖ counter                     // uint32, big-endian
 *                                        // total: 91 bytes
 * k = sha256(material) as a big-endian integer, reduced mod r
 * ```
 *
 * Four details are easy to get wrong and each produces a silent, permanent
 * divergence between implementations:
 *
 * - **There is no output index.** Navio's `COutPoint` is a bare 32-byte hash
 *   (the class comment in navio-core's `primitives/transaction.h` is stale
 *   Bitcoin text). No zero field stands in for one.
 * - **The anchor is canonical, not positional.** It is the lexicographically
 *   smallest outid among the inputs the *sender* contributed — not `vin[0]`,
 *   whose order is deliberately destroyed. See {@link canonicalAnchorOutid}.
 * - **`outid` is not a txid.** It is the hash of a serialized `CTxOut`. The SDK
 *   stores output hashes in *display* (reversed) order, so they are reversed
 *   back to internal order before hashing.
 * - **The seed is zero-padded.** `Scalar.serialize()` returns unpadded hex, so
 *   a seed with leading zero bytes would otherwise hash differently per side.
 *
 * @module blinding-key
 */

import { sha256 } from '@noble/hashes/sha256';
import { PublicKey, Scalar } from '@nav-io/navio-blsct';

/** ASCII domain separator. Exactly 23 bytes, no NUL terminator. */
export const BLINDING_DOMAIN_SEPARATOR = 'navio-blsct-blinding/v1';

/** Length of the hash pre-image: 23 + 32 + 32 + 4. */
export const BLINDING_MATERIAL_SIZE = 91;

/**
 * How many sender-assigned ordinals recovery tries per candidate anchor input
 * before giving up.
 *
 * Navio merges every non-coinbase transaction in a block into one, so an
 * output's index in the transaction that lands on chain is *not* the index the
 * sender assigned; recovery cannot trust the on-chain position and searches
 * instead. A wallet-built transaction has at most a handful of outputs (one
 * per recipient plus change), so 16 is ample.
 *
 * Recovery searches this many ordinals for *each* input of the containing
 * transaction — see {@link searchBlindingKey} for why the anchor input cannot
 * be assumed to be the first one either.
 */
export const MAX_OUTPUT_SEARCH = 16;

/** Order of the BLS12-381 G1 group. */
export const BLS12_381_GROUP_ORDER =
  0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;

/**
 * The 32-byte big-endian, zero-padded encoding of a seed scalar.
 *
 * `Scalar.serialize()` returns unpadded hex (`new Scalar(5).serialize()` is
 * `"5"`), so padding here is load-bearing for cross-implementation agreement.
 *
 * @param seed - The wallet's HD seed scalar
 * @returns 32 bytes
 */
export function seedScalarToBytes(seed: InstanceType<typeof Scalar>): Uint8Array {
  const hex = seed.serialize().padStart(64, '0');
  if (hex.length !== 64) {
    throw new Error(`Seed scalar serializes to ${hex.length} hex chars, expected at most 64`);
  }
  return hexToBytes(hex);
}

/**
 * Convert an output hash from the SDK's display (reversed) hex to the internal
 * byte order the derivation hashes.
 *
 * @param outidDisplayHex - Output hash as stored in `WalletOutput.outputHash`
 * @returns 32 bytes in internal order
 */
export function outidDisplayHexToBytes(outidDisplayHex: string): Uint8Array {
  const hex = outidDisplayHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(
      `Invalid outid: expected 64 hex characters, got ${JSON.stringify(outidDisplayHex)}`
    );
  }
  return hexToBytes(hex).reverse();
}

/**
 * Assemble the 91-byte hash pre-image.
 *
 * @param seedBytes - 32 bytes, big-endian, zero-padded
 * @param outidBytes - 32 bytes, internal order
 * @param counter - The sender's output ordinal in the transaction it built
 * @returns The 91-byte material
 */
export function buildBlindingMaterial(
  seedBytes: Uint8Array,
  outidBytes: Uint8Array,
  counter: number
): Uint8Array {
  if (seedBytes.length !== 32) {
    throw new Error(`Seed must be 32 bytes, got ${seedBytes.length}`);
  }
  if (outidBytes.length !== 32) {
    throw new Error(`Outid must be 32 bytes, got ${outidBytes.length}`);
  }
  if (!Number.isInteger(counter) || counter < 0 || counter > 0xffffffff) {
    throw new Error(`Counter must be a uint32, got ${counter}`);
  }

  const material = new Uint8Array(BLINDING_MATERIAL_SIZE);
  const separator = new TextEncoder().encode(BLINDING_DOMAIN_SEPARATOR);
  // Guards the one constant that is pure convention; a typo here is otherwise
  // invisible until a cross-implementation test fails.
  if (separator.length !== 23) {
    throw new Error(`Domain separator must be 23 bytes, got ${separator.length}`);
  }

  material.set(separator, 0);
  material.set(seedBytes, 23);
  material.set(outidBytes, 55);
  // counter, big-endian
  material[87] = (counter >>> 24) & 0xff;
  material[88] = (counter >>> 16) & 0xff;
  material[89] = (counter >>> 8) & 0xff;
  material[90] = counter & 0xff;

  return material;
}

/**
 * Derive the blinding scalar as 64 zero-padded hex characters.
 *
 * The SHA-256 digest is read as a big-endian integer and reduced mod r. The
 * reduction is done here rather than left to `Scalar.deserialize` so the rule
 * is explicit and independently testable, though navio-blsct reduces the same
 * way.
 *
 * @param seedBytes - 32 bytes, big-endian, zero-padded
 * @param outidBytes - 32 bytes, internal order
 * @param counter - The sender's output ordinal
 * @returns The scalar as 64 hex characters
 */
export function deriveBlindingScalarHex(
  seedBytes: Uint8Array,
  outidBytes: Uint8Array,
  counter: number
): string {
  const digest = sha256(buildBlindingMaterial(seedBytes, outidBytes, counter));
  const reduced = bytesToBigInt(digest) % BLS12_381_GROUP_ORDER;

  // Probability ~2^-255. The spec deliberately carries no retry path, so fail
  // loudly rather than pretend an untestable branch works.
  if (reduced === 0n) {
    throw new Error(
      'Derived blinding scalar is zero (probability ~2^-255). Refusing to continue; ' +
        'please report this, it indicates a bug rather than bad luck.'
    );
  }

  return reduced.toString(16).padStart(64, '0');
}

/**
 * Derive the blinding scalar for one output.
 *
 * @param seed - The wallet's HD seed scalar
 * @param anchorOutidDisplayHex - The anchor outid, display (reversed) hex
 * @param counter - The sender's output ordinal in the transaction it built
 * @returns The blinding scalar
 */
export function deriveBlindingKey(
  seed: InstanceType<typeof Scalar>,
  anchorOutidDisplayHex: string,
  counter: number
): InstanceType<typeof Scalar> {
  const hex = deriveBlindingScalarHex(
    seedScalarToBytes(seed),
    outidDisplayHexToBytes(anchorOutidDisplayHex),
    counter
  );
  return Scalar.deserialize(hex);
}

/**
 * The public blinding point `k * G`, as the 48-byte hex that appears on chain.
 *
 * On chain this is the output's `blsctData.ephemeralKey`, NOT the field
 * navio-core calls `blsctData.blindingKey` — that one is `k * sk_destination`,
 * bound to the recipient's spend key, and nothing signed with `k` verifies
 * against it.
 *
 * @param scalar - A blinding scalar
 * @returns Serialized public key hex
 */
export function blindingPublicKeyHex(scalar: InstanceType<typeof Scalar>): string {
  return PublicKey.fromScalar(scalar).serialize().toLowerCase();
}

/**
 * Pick the derivation anchor from the outids of the inputs the sender itself
 * contributed: the lexicographically smallest, comparing the 32 bytes in
 * internal order.
 *
 * The anchor is canonical rather than positional because position is
 * deliberately destroyed. navio-core's `TxFactoryBase::BuildTx` shuffles `vin`
 * before broadcast to hide coin-selection order, and block aggregation then
 * splices other senders' inputs into the same transaction, so the input at
 * index 0 may well belong to a stranger. A canonical choice over the sender's
 * own input *set* survives both.
 *
 * @param ownInputOutids - Outids of the inputs this wallet contributed,
 *   display (reversed) hex. Malformed entries are ignored.
 * @returns The anchor outid in display hex, or null if there are none
 */
export function canonicalAnchorOutid(ownInputOutids: string[]): string | null {
  let best: string | null = null;
  let bestBytes: Uint8Array | null = null;

  for (const outid of ownInputOutids) {
    let bytes: Uint8Array;
    try {
      bytes = outidDisplayHexToBytes(outid);
    } catch {
      continue;
    }
    if (bestBytes === null || compareBytes(bytes, bestBytes) < 0) {
      best = outid;
      bestBytes = bytes;
    }
  }

  return best;
}

/**
 * A blinding scalar found by {@link searchBlindingKey}.
 */
export interface BlindingKeySearchResult {
  /** The recovered scalar. */
  scalar: InstanceType<typeof Scalar>;
  /** The input outid that turned out to be the derivation anchor. */
  outid: string;
  /** The sender-assigned ordinal that matched. */
  counter: number;
}

/**
 * Search for the blinding scalar of an output with public point
 * `targetPublicKeyHex`, over each candidate anchor and every ordinal.
 *
 * Callers pass the canonical anchor first (see {@link canonicalAnchorOutid})
 * and then every input of the containing transaction as a fallback. Both parts
 * earn their place:
 *
 * - The **canonical anchor** is what the sender actually derived from, so in
 *   the normal case it hits immediately and the search costs
 *   `MAX_OUTPUT_SEARCH` scalar multiplications.
 * - The **fallback** covers the case where the wallet's notion of "my own
 *   inputs" differs between building and recovering — after a partial rescan,
 *   say. Without it a canonical-only scheme would fail silently there.
 * - **Ordinals** are searched because Navio merges every non-coinbase
 *   transaction in a block into one, so an output's final index is not the one
 *   its sender assigned.
 *
 * The worst case is `|vin| * MAX_OUTPUT_SEARCH` scalar multiplications, well
 * under a second even for a fully aggregated block. The search is
 * self-verifying: a wrong anchor simply never matches, so it can only cost
 * time, never produce a false key. Duplicate candidates are skipped.
 *
 * @param seed - The wallet's HD seed scalar
 * @param candidateOutids - Anchors to try, in order, display (reversed) hex
 * @param targetPublicKeyHex - The output's on-chain ephemeral key (`k * G`)
 * @returns The match, or null if this seed did not create the output
 */
export function searchBlindingKey(
  seed: InstanceType<typeof Scalar>,
  candidateOutids: string[],
  targetPublicKeyHex: string
): BlindingKeySearchResult | null {
  const seedBytes = seedScalarToBytes(seed);
  const target = targetPublicKeyHex.toLowerCase();
  const tried = new Set<string>();

  for (const outid of candidateOutids) {
    if (tried.has(outid)) continue;
    tried.add(outid);

    let outidBytes: Uint8Array;
    try {
      outidBytes = outidDisplayHexToBytes(outid);
    } catch {
      // A malformed input hash is simply not a candidate anchor.
      continue;
    }

    for (let counter = 0; counter < MAX_OUTPUT_SEARCH; counter++) {
      const scalar = Scalar.deserialize(deriveBlindingScalarHex(seedBytes, outidBytes, counter));
      if (blindingPublicKeyHex(scalar) === target) {
        return { scalar, outid, counter };
      }
    }
  }

  return null;
}

/**
 * Hands out the blinding scalars for the outputs of one transaction.
 *
 * Output builders take their keys from here so the counter is assigned in
 * build order and the assignments can be persisted afterwards. When no seed or
 * first input is available — or a caller explicitly asked for random keys —
 * it falls back to `Scalar.random()`, which is the pre-existing behaviour and
 * simply yields outputs that cannot be recovered.
 */
export class BlindingKeyAllocator {
  private counter = 0;
  /**
   * Every scalar handed out so far, keyed by its public point.
   *
   * Never cleared by {@link reset}: callers rebuild their outputs repeatedly
   * while a fee converges, and a rebuild must not forget keys it already
   * issued. Re-deriving the same counter is idempotent, and entries for
   * candidate outputs that never reached the wire are harmless — the caller
   * stores only the ones whose public point appears in the broadcast
   * transaction.
   */
  private readonly assignments = new Map<string, string>();
  private readonly seedBytes: Uint8Array | null;
  private readonly outidBytes: Uint8Array | null;
  /** The anchor these keys derive from, display hex, or null when random. */
  readonly anchorOutid: string | null;

  /**
   * @param seed - The wallet HD seed, or null to fall back to random keys
   * @param ownInputOutids - Outids of the inputs this wallet is contributing to
   *   the transaction. The anchor is the canonical (lexicographically smallest,
   *   internal order) one; pass null or an empty list for random keys.
   */
  constructor(seed: InstanceType<typeof Scalar> | null, ownInputOutids: string | string[] | null) {
    const outids =
      ownInputOutids === null
        ? []
        : Array.isArray(ownInputOutids)
          ? ownInputOutids
          : [ownInputOutids];

    this.anchorOutid = canonicalAnchorOutid(outids);
    this.seedBytes = seed === null ? null : seedScalarToBytes(seed);
    this.outidBytes = this.anchorOutid === null ? null : outidDisplayHexToBytes(this.anchorOutid);
  }

  /** An allocator that always yields random, unrecoverable keys. */
  static random(): BlindingKeyAllocator {
    return new BlindingKeyAllocator(null, null);
  }

  /** Whether this allocator produces recoverable keys. */
  get isDeterministic(): boolean {
    return this.seedBytes !== null && this.outidBytes !== null;
  }

  /** The counter the next {@link next} call will use. */
  get position(): number {
    return this.counter;
  }

  /**
   * The next blinding scalar, advancing the counter.
   *
   * Callers rebuild their outputs several times while iterating to a fee
   * fixpoint, so {@link reset} restarts the counter between rounds and an
   * output's key depends on its position rather than on how many rounds the
   * fixpoint took.
   */
  next(): InstanceType<typeof Scalar> {
    if (this.seedBytes === null || this.outidBytes === null) {
      return Scalar.random();
    }
    const counter = this.counter++;
    if (counter >= MAX_OUTPUT_SEARCH) {
      // Beyond this the output would build fine but never be recovered, since
      // the bounded search would not reach its counter. Fail rather than
      // quietly create an unrecoverable output.
      throw new Error(
        `Transaction has more than ${MAX_OUTPUT_SEARCH} wallet-built outputs; ` +
          'blinding keys past that bound would not be recoverable.'
      );
    }
    const scalar = Scalar.deserialize(
      deriveBlindingScalarHex(this.seedBytes, this.outidBytes, counter)
    );
    this.assignments.set(blindingPublicKeyHex(scalar), scalar.serialize().padStart(64, '0'));
    return scalar;
  }

  /**
   * Restart counter assignment.
   *
   * @param to - The counter to resume from (default 0), so a caller that
   *   built a stable prefix of outputs once can rebuild only the tail
   */
  reset(to = 0): void {
    this.counter = to;
  }

  /**
   * Every scalar handed out so far, keyed by the public point that identifies
   * the output on chain.
   *
   * @returns public blinding key hex -> private scalar hex
   */
  assignedByPublicKey(): Map<string, string> {
    return new Map(this.assignments);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}
