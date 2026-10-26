/**
 * Recoverable output blinding keys.
 *
 * Every BLSCT output is built with a secret blinding scalar `k`. The public
 * point `k * G` goes on chain as the output's `blsctData.ephemeralKey`.
 * Historically `k` was `Scalar.random()` and was thrown away, so a sender had
 * no way to prove after the fact that it created a given output. This module
 * derives the scalar deterministically from the wallet seed instead, so it can
 * be recomputed from a seed-only restore.
 *
 * The derivation is normative and shared with navio-core's C++ implementation
 * (`src/blsct/wallet/blinding_key.h`, and `docs/BLINDING-KEY-RECOVERY.md` in
 * the bridge repo). It must not be "improved" — a change here silently
 * strands every output created under the old rule.
 *
 * ```
 * material = "navio-blsct-blinding/v1"   // ASCII, exactly 23 bytes, no NUL
 *          ‖ seed                        // 32 bytes, big-endian, ZERO-PADDED
 *          ‖ anchor.outid                // 32 bytes, INTERNAL byte order
 *          ‖ ordinal                     // uint32, big-endian
 *          ‖ generation                  // uint32, big-endian
 *                                        // total: 95 bytes
 * k = sha256(material) as a big-endian integer, reduced mod r
 * ```
 *
 * Five details are easy to get wrong and each produces a silent, permanent
 * divergence between implementations, or worse:
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
 * - **Every build claims a fresh generation.** Without it the derivation is a
 *   pure function of (seed, anchor, ordinal), so rebuilding a transaction over
 *   the same inputs with a different amount would reuse `k`. `k` seeds the
 *   range proof's randomness, and two proofs sharing it leak the committed
 *   amounts. The wallet keeps a per-anchor counter
 *   (`IWalletDB.reserveBlindingGeneration`) and recovery searches
 *   {@link MAX_GENERATION_SEARCH} generations.
 *
 * navio-sdk 0.4 and earlier used a 91-byte layout without the generation (see
 * {@link buildLegacyBlindingMaterial}). Recovery still tries it, right after
 * generation 0 of the current layout, so outputs those versions created stay
 * recoverable.
 *
 * @module blinding-key
 */

import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes } from '@noble/hashes/utils';
import { PublicKey, Scalar } from '@nav-io/navio-blsct';

/** ASCII domain separator. Exactly 23 bytes, no NUL terminator. */
export const BLINDING_DOMAIN_SEPARATOR = 'navio-blsct-blinding/v1';

/** Length of the hash pre-image: 23 + 32 + 32 + 4 + 4. */
export const BLINDING_MATERIAL_SIZE = 95;

/**
 * Length of the pre-image navio-sdk 0.4 and earlier hashed: 23 + 32 + 32 + 4,
 * with no generation. Only recovery uses it.
 */
export const LEGACY_BLINDING_MATERIAL_SIZE = 91;

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

/**
 * How many build generations recovery tries per (anchor, ordinal), matching
 * navio-core's `MAX_GENERATION_SEARCH`.
 *
 * A wallet bumps an anchor's generation on every build that uses it, so a
 * rebuild over the same inputs never reuses a blinding scalar. Recovery cannot
 * read that counter after a seed-only restore, so it searches instead. Once an
 * anchor has used all of its generations, further builds on it get random,
 * unrecoverable keys rather than a derived key recovery could not reach.
 *
 * The counter is per wallet database: two wallets restored from the same seed
 * share no counter and both start at generation 0. Do not run two wallets on
 * one seed and spend from both.
 */
export const MAX_GENERATION_SEARCH = 32;

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
 * Assemble the 95-byte hash pre-image.
 *
 * @param seedBytes - 32 bytes, big-endian, zero-padded
 * @param outidBytes - 32 bytes, internal order
 * @param ordinal - The sender's output ordinal in the transaction it built
 * @param generation - The build generation reserved for this anchor
 * @returns The 95-byte material
 */
export function buildBlindingMaterial(
  seedBytes: Uint8Array,
  outidBytes: Uint8Array,
  ordinal: number,
  generation: number
): Uint8Array {
  assertUint32(generation, 'Generation');
  const material = new Uint8Array(BLINDING_MATERIAL_SIZE);
  writeMaterialPrefix(material, seedBytes, outidBytes, ordinal);
  writeUint32BE(material, 91, generation);
  return material;
}

/**
 * Assemble the 91-byte pre-image navio-sdk 0.4 and earlier hashed: the
 * current layout without the trailing generation.
 *
 * Only for recovering outputs those versions created; never build with it.
 *
 * @param seedBytes - 32 bytes, big-endian, zero-padded
 * @param outidBytes - 32 bytes, internal order
 * @param counter - The sender's output ordinal
 * @returns The 91-byte material
 */
export function buildLegacyBlindingMaterial(
  seedBytes: Uint8Array,
  outidBytes: Uint8Array,
  counter: number
): Uint8Array {
  const material = new Uint8Array(LEGACY_BLINDING_MATERIAL_SIZE);
  writeMaterialPrefix(material, seedBytes, outidBytes, counter);
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
 * @param ordinal - The sender's output ordinal
 * @param generation - The build generation reserved for this anchor
 * @returns The scalar as 64 hex characters
 */
export function deriveBlindingScalarHex(
  seedBytes: Uint8Array,
  outidBytes: Uint8Array,
  ordinal: number,
  generation: number
): string {
  return digestToScalarHex(
    sha256(buildBlindingMaterial(seedBytes, outidBytes, ordinal, generation))
  );
}

/**
 * Derive a blinding scalar with the 91-byte layout of navio-sdk 0.4 and
 * earlier. Only for recovery; see {@link buildLegacyBlindingMaterial}.
 *
 * @param seedBytes - 32 bytes, big-endian, zero-padded
 * @param outidBytes - 32 bytes, internal order
 * @param counter - The sender's output ordinal
 * @returns The scalar as 64 hex characters
 */
export function deriveLegacyBlindingScalarHex(
  seedBytes: Uint8Array,
  outidBytes: Uint8Array,
  counter: number
): string {
  return digestToScalarHex(sha256(buildLegacyBlindingMaterial(seedBytes, outidBytes, counter)));
}

/**
 * Derive the blinding scalar for one output.
 *
 * @param seed - The wallet's HD seed scalar
 * @param anchorOutidDisplayHex - The anchor outid, display (reversed) hex
 * @param ordinal - The sender's output ordinal in the transaction it built
 * @param generation - The build generation reserved for this anchor
 * @returns The blinding scalar
 */
export function deriveBlindingKey(
  seed: InstanceType<typeof Scalar>,
  anchorOutidDisplayHex: string,
  ordinal: number,
  generation: number
): InstanceType<typeof Scalar> {
  const hex = deriveBlindingScalarHex(
    seedScalarToBytes(seed),
    outidDisplayHexToBytes(anchorOutidDisplayHex),
    ordinal,
    generation
  );
  return Scalar.deserialize(hex);
}

/**
 * Derive a blinding scalar the way navio-sdk 0.4 and earlier did. Only for
 * recovery and tests; see {@link buildLegacyBlindingMaterial}.
 *
 * @param seed - The wallet's HD seed scalar
 * @param anchorOutidDisplayHex - The anchor outid, display (reversed) hex
 * @param counter - The sender's output ordinal
 * @returns The blinding scalar
 */
export function deriveLegacyBlindingKey(
  seed: InstanceType<typeof Scalar>,
  anchorOutidDisplayHex: string,
  counter: number
): InstanceType<typeof Scalar> {
  const hex = deriveLegacyBlindingScalarHex(
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
  /**
   * The build generation that matched, or null when the output was built with
   * the generation-less layout of navio-sdk 0.4 and earlier.
   */
  generation: number | null;
}

/**
 * Options for {@link searchBlindingKey}.
 */
export interface BlindingKeySearchOptions {
  /**
   * How many generations of the current layout to try for a candidate anchor:
   * generations `0` to `limit - 1`. Clamped to
   * `[0, MAX_GENERATION_SEARCH]`; return `undefined` for the full
   * {@link MAX_GENERATION_SEARCH}. The legacy layout is tried regardless.
   *
   * A caller that knows how many generations were handed out for an anchor
   * (its `IWalletDB` counter) can pass that to skip the rest; one that knows
   * nothing should leave it out, since after a seed-only restore, or on a
   * second wallet sharing the seed, the local counter says nothing about what
   * was built.
   */
  generationLimit?: (outid: string) => number | undefined;
}

/**
 * Search for the blinding scalar of an output with public point
 * `targetPublicKeyHex`, over each candidate anchor, every generation and every
 * ordinal.
 *
 * Callers pass the canonical anchor first (see {@link canonicalAnchorOutid})
 * and then every input of the containing transaction as a fallback. Each part
 * earns its place:
 *
 * - The **canonical anchor** is what the sender actually derived from, so in
 *   the normal case it hits within the first `MAX_OUTPUT_SEARCH` candidates.
 * - The **fallback** covers the case where the wallet's notion of "my own
 *   inputs" differs between building and recovering — after a partial rescan,
 *   say. Without it a canonical-only scheme would fail silently there.
 * - **Ordinals** are searched because Navio merges every non-coinbase
 *   transaction in a block into one, so an output's final index is not the one
 *   its sender assigned.
 * - **Generations** are searched because the counter that picked one is not
 *   available after a seed-only restore.
 * - The **legacy layout** of navio-sdk 0.4 and earlier keeps outputs those
 *   versions created recoverable.
 *
 * Order: the first candidate completely — generation 0, the legacy layout,
 * then generations 1 and up — and then, for the fallbacks, generation 0 and
 * the legacy layout of each before any of their higher generations. So an
 * output built once on its canonical anchor (nearly all of them) costs at most
 * `2 * MAX_OUTPUT_SEARCH` checks whichever layout built it, and a fallback
 * match does not wait behind 31 unused generations of every other input.
 *
 * The worst case, paid only for an output this seed did not create, is
 * `|candidates| * MAX_OUTPUT_SEARCH * (generations + 1)` scalar
 * multiplications, with `generations` from
 * {@link BlindingKeySearchOptions.generationLimit} (default
 * {@link MAX_GENERATION_SEARCH}). The search is self-verifying: a wrong
 * candidate never matches the public point, so it can only cost time, never
 * produce a false key. Duplicate candidates are skipped.
 *
 * @param seed - The wallet's HD seed scalar
 * @param candidateOutids - Anchors to try, in order, display (reversed) hex
 * @param targetPublicKeyHex - The output's on-chain ephemeral key (`k * G`)
 * @param options - Optional per-anchor generation bounds
 * @returns The match, or null if this seed did not create the output
 */
export function searchBlindingKey(
  seed: InstanceType<typeof Scalar>,
  candidateOutids: string[],
  targetPublicKeyHex: string,
  options: BlindingKeySearchOptions = {}
): BlindingKeySearchResult | null {
  const seedBytes = seedScalarToBytes(seed);
  const target = targetPublicKeyHex.toLowerCase();

  const check = (scalarHex: string): InstanceType<typeof Scalar> | null => {
    const scalar = Scalar.deserialize(scalarHex);
    return blindingPublicKeyHex(scalar) === target ? scalar : null;
  };

  const anchors: Array<{ outid: string; bytes: Uint8Array; generations: number }> = [];
  const seen = new Set<string>();
  for (const outid of candidateOutids) {
    if (seen.has(outid)) continue;
    seen.add(outid);
    let bytes: Uint8Array;
    try {
      bytes = outidDisplayHexToBytes(outid);
    } catch {
      // A malformed input hash is simply not a candidate anchor.
      continue;
    }
    const limit = options.generationLimit?.(outid);
    const generations =
      limit === undefined || !Number.isFinite(limit)
        ? MAX_GENERATION_SEARCH
        : Math.max(0, Math.min(MAX_GENERATION_SEARCH, Math.floor(limit)));
    anchors.push({ outid, bytes, generations });
  }

  const tryGeneration = (
    anchor: (typeof anchors)[number],
    generation: number
  ): BlindingKeySearchResult | null => {
    for (let counter = 0; counter < MAX_OUTPUT_SEARCH; counter++) {
      const scalar = check(deriveBlindingScalarHex(seedBytes, anchor.bytes, counter, generation));
      if (scalar) return { scalar, outid: anchor.outid, counter, generation };
    }
    return null;
  };

  const tryLegacy = (anchor: (typeof anchors)[number]): BlindingKeySearchResult | null => {
    for (let counter = 0; counter < MAX_OUTPUT_SEARCH; counter++) {
      const scalar = check(deriveLegacyBlindingScalarHex(seedBytes, anchor.bytes, counter));
      if (scalar) return { scalar, outid: anchor.outid, counter, generation: null };
    }
    return null;
  };

  /** Generations 1 and up, generation as the outer loop. */
  const searchGenerations = (
    list: Array<(typeof anchors)[number]>
  ): BlindingKeySearchResult | null => {
    for (let generation = 1; generation < MAX_GENERATION_SEARCH; generation++) {
      for (const anchor of list) {
        if (generation >= anchor.generations) continue;
        const match = tryGeneration(anchor, generation);
        if (match) return match;
      }
    }
    return null;
  };

  const [primary, ...fallbacks] = anchors;
  if (primary) {
    // The first candidate is the canonical anchor, right in the normal case:
    // search it completely before any fallback.
    const match =
      (primary.generations > 0 ? tryGeneration(primary, 0) : null) ??
      tryLegacy(primary) ??
      searchGenerations([primary]);
    if (match) return match;
  }

  // Fallbacks: the layouts nearly every output uses first, for every one of
  // them, and only then rebuild generations.
  for (const anchor of fallbacks) {
    const match = (anchor.generations > 0 ? tryGeneration(anchor, 0) : null) ?? tryLegacy(anchor);
    if (match) return match;
  }
  return searchGenerations(fallbacks);
}

/**
 * Hands out the blinding scalars for the outputs of one transaction.
 *
 * Output builders take their keys from here so the ordinal is assigned in
 * build order and the assignments can be persisted afterwards. When no seed or
 * input is available — or a caller explicitly asked for random keys — it
 * falls back to `Scalar.random()`, which is the pre-existing behaviour and
 * simply yields outputs that cannot be recovered.
 *
 * A deterministic allocator needs a generation reserved for its anchor (see
 * `IWalletDB.reserveBlindingGeneration`), once per build. Reusing a
 * generation for a second build over the same inputs reuses its blinding
 * scalars, which leaks the amounts of both.
 */
export class BlindingKeyAllocator {
  private counter = 0;
  /**
   * Every scalar handed out so far, keyed by its public point.
   *
   * Never cleared by {@link reset}: callers rebuild their outputs repeatedly
   * while a fee converges, and a rebuild must not forget keys it already
   * issued. Re-deriving the same ordinal is idempotent, and entries for
   * candidate outputs that never reached the wire are harmless — the caller
   * stores only the ones whose public point appears in the broadcast
   * transaction.
   */
  private readonly assignments = new Map<string, string>();
  private readonly seedBytes: Uint8Array | null;
  private readonly outidBytes: Uint8Array | null;
  /** The anchor these keys derive from, display hex, or null when random. */
  readonly anchorOutid: string | null;
  /** The build generation these keys derive from, or null when random. */
  readonly generation: number | null;

  /**
   * @param seed - The wallet HD seed, or null to fall back to random keys
   * @param ownInputOutids - Outids of the inputs this wallet is contributing to
   *   the transaction. The anchor is the canonical (lexicographically smallest,
   *   internal order) one; pass null or an empty list for random keys.
   * @param generation - The build generation reserved for that anchor.
   *   Required whenever a seed and an anchor are given.
   * @throws If keys would be derived without a valid generation
   */
  constructor(
    seed: InstanceType<typeof Scalar> | null,
    ownInputOutids: string | string[] | null,
    generation: number | null = null
  ) {
    const outids =
      ownInputOutids === null
        ? []
        : Array.isArray(ownInputOutids)
          ? ownInputOutids
          : [ownInputOutids];

    const anchorOutid = canonicalAnchorOutid(outids);
    if (seed === null || anchorOutid === null) {
      this.anchorOutid = null;
      this.generation = null;
      this.seedBytes = null;
      this.outidBytes = null;
      return;
    }

    if (
      generation === null ||
      !Number.isInteger(generation) ||
      generation < 0 ||
      generation >= MAX_GENERATION_SEARCH
    ) {
      // Defaulting to 0 here is exactly the reuse the generation prevents.
      throw new Error(
        `Deterministic blinding keys need a reserved generation in [0, ${MAX_GENERATION_SEARCH}), ` +
          `got ${generation}`
      );
    }

    this.anchorOutid = anchorOutid;
    this.generation = generation;
    this.seedBytes = seedScalarToBytes(seed);
    this.outidBytes = outidDisplayHexToBytes(anchorOutid);
  }

  /** An allocator that always yields random, unrecoverable keys. */
  static random(): BlindingKeyAllocator {
    return new BlindingKeyAllocator(null, null);
  }

  /** Whether this allocator produces recoverable keys. */
  get isDeterministic(): boolean {
    return this.seedBytes !== null && this.outidBytes !== null;
  }

  /** The ordinal the next {@link next} call will use. */
  get position(): number {
    return this.counter;
  }

  /**
   * The next blinding scalar, advancing the ordinal.
   *
   * Callers rebuild their outputs several times while iterating to a fee
   * fixpoint, so {@link reset} restarts the ordinal between rounds and an
   * output's key depends on its position rather than on how many rounds the
   * fixpoint took. Only one of those rounds is broadcast, so they may share
   * the build's generation.
   */
  next(): InstanceType<typeof Scalar> {
    if (this.seedBytes === null || this.outidBytes === null || this.generation === null) {
      return Scalar.random();
    }
    const counter = this.counter++;
    if (counter >= MAX_OUTPUT_SEARCH) {
      // Beyond this the output would build fine but never be recovered, since
      // the bounded search would not reach its ordinal. Fail rather than
      // quietly create an unrecoverable output.
      throw new Error(
        `Transaction has more than ${MAX_OUTPUT_SEARCH} wallet-built outputs; ` +
          'blinding keys past that bound would not be recoverable.'
      );
    }
    const scalar = Scalar.deserialize(
      deriveBlindingScalarHex(this.seedBytes, this.outidBytes, counter, this.generation)
    );
    this.assignments.set(blindingPublicKeyHex(scalar), scalar.serialize().padStart(64, '0'));
    return scalar;
  }

  /**
   * Restart ordinal assignment.
   *
   * @param to - The ordinal to resume from (default 0), so a caller that
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

function writeMaterialPrefix(
  material: Uint8Array,
  seedBytes: Uint8Array,
  outidBytes: Uint8Array,
  ordinal: number
): void {
  if (seedBytes.length !== 32) {
    throw new Error(`Seed must be 32 bytes, got ${seedBytes.length}`);
  }
  if (outidBytes.length !== 32) {
    throw new Error(`Outid must be 32 bytes, got ${outidBytes.length}`);
  }
  assertUint32(ordinal, 'Counter');

  const separator = new TextEncoder().encode(BLINDING_DOMAIN_SEPARATOR);
  // Guards the one constant that is pure convention; a typo here is otherwise
  // invisible until a cross-implementation test fails.
  if (separator.length !== 23) {
    throw new Error(`Domain separator must be 23 bytes, got ${separator.length}`);
  }

  material.set(separator, 0);
  material.set(seedBytes, 23);
  material.set(outidBytes, 55);
  writeUint32BE(material, 87, ordinal);
}

function digestToScalarHex(digest: Uint8Array): string {
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

function assertUint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${name} must be a uint32, got ${value}`);
  }
}

function writeUint32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
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
