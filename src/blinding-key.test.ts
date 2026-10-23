import { afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import {
  CTxId,
  OutPoint,
  PublicKey,
  Scalar,
  Signature,
  SubAddr,
  SubAddrId,
  TokenId,
  TxIn,
  TxOut,
  TxOutputType,
  UnsignedInput,
  UnsignedOutput,
  UnsignedTransaction,
} from '@nav-io/navio-blsct';
import { sha256 } from '@noble/hashes/sha256';
import {
  BLINDING_DOMAIN_SEPARATOR,
  BLINDING_MATERIAL_SIZE,
  BLS12_381_GROUP_ORDER,
  BlindingKeyAllocator,
  LEGACY_BLINDING_MATERIAL_SIZE,
  MAX_GENERATION_SEARCH,
  MAX_OUTPUT_SEARCH,
  blindingPublicKeyHex,
  buildBlindingMaterial,
  buildLegacyBlindingMaterial,
  canonicalAnchorOutid,
  deriveBlindingKey,
  deriveBlindingScalarHex,
  deriveLegacyBlindingKey,
  deriveLegacyBlindingScalarHex,
  outidDisplayHexToBytes,
  searchBlindingKey,
  seedScalarToBytes,
} from './blinding-key';
import { NavioClient } from './client';
import { KeyManager } from './key-manager';
import { parseTransaction } from './p2p-block-parser';
import {
  isSealedBlindingKey,
  openOutputBlindingKey,
  sealOutputBlindingKey,
} from './output-blinding-key-store';

/** An output hash outside any transaction these tests build. */
const OUTPUT_ELSEWHERE = 'c3'.repeat(32);

/**
 * The normative cross-implementation vector, copied verbatim from navio-core's
 * `src/test/blsct/wallet/blinding_key_tests.cpp` (`normative_test_vector`):
 * `DeriveBlindingKey(seed = 0x01 * 32, outid = 0xab * 32, ordinal, generation)`.
 * Both sides must produce exactly these scalars for the same inputs.
 */
const VECTOR = {
  seed: new Uint8Array(32).fill(0x01),
  outid: new Uint8Array(32).fill(0xab),
  expected: [
    { ordinal: 0, generation: 0, scalar: '70ea97ae2ad8845dcf73f86bd510dc7aa4cd3e6cbeddf71e5101708866a074fa' },
    { ordinal: 1, generation: 0, scalar: '4b385dd6567923dab38680aa9120ed854bfc58a4d502f7a9113741c0aa4f6b91' },
    { ordinal: 0, generation: 1, scalar: '63fd46abd3afbc6a1454d278fe175a1cbe186853ae3dc98c411d7a18116151ff' },
  ],
};

/**
 * The same inputs under the generation-less 91-byte layout navio-sdk 0.4 and
 * earlier used. Recovery must keep reproducing these, or the outputs those
 * versions built become unrecoverable.
 */
const LEGACY_VECTOR = [
  '6f57f45d6d6ceb748b859f3f7b16b08ee720cc91f947aab1ba4b3d825a5cb281',
  '41d3910421dc8f3b19079bdd9d9f8769e3ed691fabe978dc6dd2aa0f4448e2c1',
];

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon art';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function makeDestination(): InstanceType<typeof SubAddr> {
  return SubAddr.generate(
    new Scalar(91),
    PublicKey.fromScalar(new Scalar(92)),
    SubAddrId.generate(7, 9),
  );
}

/**
 * Build a signed transaction spending the given outids, in order, and paying
 * one output per supplied blinding scalar.
 */
function buildTransaction(
  inputOutids: string | string[],
  blindingScalars: Array<InstanceType<typeof Scalar>>,
): string {
  const destination = makeDestination();
  const outids = Array.isArray(inputOutids) ? inputOutids : [inputOutids];

  const tx = UnsignedTransaction.create();
  for (const [i, outid] of outids.entries()) {
    tx.addInput(UnsignedInput.fromTxIn(TxIn.generate(
      5_000_000,
      new Scalar(7 + i * 2),
      new Scalar(8 + i * 2),
      TokenId.default(),
      OutPoint.generate(CTxId.deserialize(outid)),
      false,
      false,
    )));
  }
  for (const [index, scalar] of blindingScalars.entries()) {
    tx.addOutput(UnsignedOutput.fromTxOut(TxOut.generate(
      destination,
      500_000,
      `memo-${index}`,
      TokenId.default(),
      TxOutputType.Normal,
      0,
      false,
      scalar,
    )));
  }
  tx.setFee(500_000);
  return tx.sign();
}

/** A 64-hex outid that is not ours, standing in for a stranger's input. */
function foreignOutid(tag: number): string {
  return tag.toString(16).padStart(2, '0').repeat(32);
}

/**
 * A client wired up just enough to recover blinding keys: a seed, a backend
 * that serves one raw transaction, and an empty blinding-key table.
 */
function makeRecoveryClient(options: {
  seed: InstanceType<typeof Scalar> | null;
  rawTx: string;
  storedBlindingKeys?: Map<string, string>;
  unlocked?: boolean;
  /** A real key manager to use instead of the stub built from `seed`. */
  keyManager?: KeyManager;
}) {
  const client = new NavioClient({
    network: 'testnet',
    backend: 'electrum',
    electrum: { host: 'testnet.nav.io', port: 50005 },
    walletDbPath: ':memory:',
  });

  const stored = options.storedBlindingKeys ?? new Map<string, string>();
  const getRawTransaction = vi.fn().mockResolvedValue(options.rawTx);

  (client as any).initialized = true;
  (client as any).walletDB = {
    getOutputBlindingKey: vi.fn(async (hash: string) => stored.get(hash) ?? null),
    saveOutputBlindingKey: vi.fn(async (hash: string, key: string) => { stored.set(hash, key); }),
    getAllOutputBlindingKeys: vi.fn(async () =>
      [...stored].map(([outputHash, blindingKey]) => ({ outputHash, blindingKey }))),
  };
  (client as any).keyManager = options.keyManager ?? {
    isEncrypted: () => false,
    isUnlocked: () => options.unlocked !== false,
    getMasterSeedKey: () => {
      if (options.seed === null) throw new Error('HD is not enabled');
      return options.seed;
    },
  };
  (client as any).syncProvider = {
    isConnected: () => true,
    getRawTransaction,
  };

  return { client, getRawTransaction, stored };
}

describe('blinding key derivation', () => {
  it('reproduces navio-core\'s normative test vector', () => {
    // This is the shared check against navio-core's C++ implementation. If it
    // fails, the two sides have diverged and outputs created by one are not
    // recoverable by the other.
    for (const { ordinal, generation, scalar } of VECTOR.expected) {
      expect(deriveBlindingScalarHex(VECTOR.seed, VECTOR.outid, ordinal, generation)).toBe(scalar);
    }
  });

  it('reproduces navio-core\'s vector independently of the implementation', () => {
    // Recompute from the definition in navio-core's blinding_key.h with
    // nothing but sha256 and BigInt, so a layout bug shared by
    // buildBlindingMaterial and its own test cannot hide.
    const preimage = new Uint8Array([
      ...new TextEncoder().encode('navio-blsct-blinding/v1'),
      ...new Uint8Array(32).fill(0x01),
      ...new Uint8Array(32).fill(0xab),
      0, 0, 0, 0, // ordinal 0, big-endian
      0, 0, 0, 1, // generation 1, big-endian
    ]);
    expect(preimage.length).toBe(95);
    const k = BigInt(`0x${bytesToHex(sha256(preimage))}`) % BLS12_381_GROUP_ORDER;
    expect(k.toString(16).padStart(64, '0')).toBe(VECTOR.expected[2].scalar);
  });

  it('still reproduces the generation-less vector of navio-sdk 0.4 for recovery', () => {
    for (const [counter, expected] of LEGACY_VECTOR.entries()) {
      expect(deriveLegacyBlindingScalarHex(VECTOR.seed, VECTOR.outid, counter)).toBe(expected);
    }
  });

  it('lays out exactly 95 bytes of material in the specified order', () => {
    const material = buildBlindingMaterial(VECTOR.seed, VECTOR.outid, 1, 0x01020304);

    expect(material.length).toBe(BLINDING_MATERIAL_SIZE);
    expect(material.length).toBe(95);
    expect(new TextDecoder().decode(material.subarray(0, 23))).toBe(BLINDING_DOMAIN_SEPARATOR);
    expect(bytesToHex(material.subarray(23, 55))).toBe('01'.repeat(32));
    expect(bytesToHex(material.subarray(55, 87))).toBe('ab'.repeat(32));
    // ordinal, big-endian
    expect(bytesToHex(material.subarray(87, 91))).toBe('00000001');
    // generation, big-endian
    expect(bytesToHex(material.subarray(91, 95))).toBe('01020304');

    // The legacy layout is the same prefix with no generation.
    const legacy = buildLegacyBlindingMaterial(VECTOR.seed, VECTOR.outid, 1);
    expect(legacy.length).toBe(LEGACY_BLINDING_MATERIAL_SIZE);
    expect(legacy.length).toBe(91);
    expect(bytesToHex(legacy)).toBe(bytesToHex(material.subarray(0, 91)));
  });

  it('is deterministic and separates ordinals, generations, seeds and outids', () => {
    const otherSeed = new Uint8Array(32).fill(0x02);
    const otherOutid = new Uint8Array(32).fill(0xcd);

    expect(deriveBlindingScalarHex(VECTOR.seed, VECTOR.outid, 0, 0))
      .toBe(deriveBlindingScalarHex(VECTOR.seed, VECTOR.outid, 0, 0));

    const distinct = new Set([
      deriveBlindingScalarHex(VECTOR.seed, VECTOR.outid, 0, 0),
      deriveBlindingScalarHex(VECTOR.seed, VECTOR.outid, 1, 0),
      deriveBlindingScalarHex(VECTOR.seed, VECTOR.outid, 0, 1),
      deriveBlindingScalarHex(otherSeed, VECTOR.outid, 0, 0),
      deriveBlindingScalarHex(VECTOR.seed, otherOutid, 0, 0),
      deriveLegacyBlindingScalarHex(VECTOR.seed, VECTOR.outid, 0),
    ]);
    expect(distinct.size).toBe(6);
  });

  it('gives every generation of one anchor and ordinal a distinct scalar', () => {
    // The reason the generation exists: a rebuild over the same inputs must
    // not reuse k, or two range proofs share their randomness.
    const seen = new Set<string>();
    for (let generation = 0; generation < MAX_GENERATION_SEARCH; generation++) {
      seen.add(deriveBlindingScalarHex(VECTOR.seed, VECTOR.outid, 0, generation));
    }
    expect(seen.size).toBe(MAX_GENERATION_SEARCH);
    expect(MAX_GENERATION_SEARCH).toBe(32);
  });

  it('reduces the digest modulo the group order', () => {
    // The vector's own values are below r on purpose, so exercise the
    // reduction separately: every derived scalar must be a canonical field
    // element, and navio-blsct must agree with the reduction done here.
    for (let counter = 0; counter < 64; counter++) {
      const hex = deriveBlindingScalarHex(VECTOR.seed, VECTOR.outid, counter, counter % 3);
      expect(hex).toHaveLength(64);

      const value = BigInt(`0x${hex}`);
      expect(value).toBeGreaterThan(0n);
      expect(value).toBeLessThan(BLS12_381_GROUP_ORDER);

      // navio-blsct reduces the same way, so a round trip is the identity.
      expect(Scalar.deserialize(hex).serialize().padStart(64, '0')).toBe(hex);
    }

    // And the reduction is the real thing, not a mask: r + 7 reduces to 7.
    const overflow = (BLS12_381_GROUP_ORDER + 7n).toString(16).padStart(64, '0');
    expect(Scalar.deserialize(overflow).toBigInt()).toBe(7n);

    // navio-core's modular_reduction vector: 2^256 - 1 reduced mod r.
    expect(((1n << 256n) - 1n) % BLS12_381_GROUP_ORDER)
      .toBe(0x1824b159acc5056f998c4fefecbc4ff55884b7fa0003480200000001fffffffdn);
  });

  it('zero-pads a seed scalar whose serialization is short', () => {
    // Scalar.serialize() is unpadded, so this is the padding the spec calls
    // out as load-bearing for cross-implementation agreement.
    expect(new Scalar(5).serialize()).toBe('5');
    expect(bytesToHex(seedScalarToBytes(new Scalar(5)))).toBe('00'.repeat(31) + '05');
  });

  it('reverses display-order outids into internal byte order', () => {
    const display = '00'.repeat(31) + 'ff';
    expect(bytesToHex(outidDisplayHexToBytes(display))).toBe('ff' + '00'.repeat(31));
  });

  it('rejects malformed inputs rather than hashing something unintended', () => {
    expect(() => outidDisplayHexToBytes('abcd')).toThrow(/64 hex characters/);
    expect(() => buildBlindingMaterial(new Uint8Array(31), VECTOR.outid, 0, 0)).toThrow(/32 bytes/);
    expect(() => buildBlindingMaterial(VECTOR.seed, new Uint8Array(33), 0, 0)).toThrow(/32 bytes/);
    expect(() => buildBlindingMaterial(VECTOR.seed, VECTOR.outid, -1, 0)).toThrow(/uint32/);
    expect(() => buildBlindingMaterial(VECTOR.seed, VECTOR.outid, 1.5, 0)).toThrow(/uint32/);
    expect(() => buildBlindingMaterial(VECTOR.seed, VECTOR.outid, 0, -1)).toThrow(/uint32/);
    expect(() => buildBlindingMaterial(VECTOR.seed, VECTOR.outid, 0, 2 ** 32)).toThrow(/uint32/);
    expect(() => buildLegacyBlindingMaterial(VECTOR.seed, VECTOR.outid, -1)).toThrow(/uint32/);
  });
});

describe('canonicalAnchorOutid', () => {
  it('picks the lexicographically smallest outid in INTERNAL byte order', () => {
    // Outids are stored display-reversed, so the smallest internally is the one
    // whose LAST display byte is smallest — picking on the display string would
    // choose differently, which is the mistake this guards.
    const low = '99'.repeat(31) + '01';   // internal: 01 99 99 …
    const high = '11'.repeat(31) + '02';  // internal: 02 11 11 …

    expect(canonicalAnchorOutid([high, low])).toBe(low);
    expect(canonicalAnchorOutid([low, high])).toBe(low);
    // …and the display-order answer would have been the other one.
    expect([low, high].sort()[0]).toBe(high);
  });

  it('is invariant under input order, which is exactly the point', () => {
    const outids = [foreignOutid(0x44), foreignOutid(0x11), foreignOutid(0x99)];
    const anchor = canonicalAnchorOutid(outids);
    expect(canonicalAnchorOutid([...outids].reverse())).toBe(anchor);
    expect(anchor).toBe(foreignOutid(0x11));
  });

  it('returns null for an empty or entirely malformed set', () => {
    expect(canonicalAnchorOutid([])).toBeNull();
    expect(canonicalAnchorOutid(['', 'nope'])).toBeNull();
    expect(canonicalAnchorOutid(['nope', foreignOutid(0x55)])).toBe(foreignOutid(0x55));
  });
});

describe('searchBlindingKey', () => {
  const seed = Scalar.deserialize('07'.repeat(32));
  const ours = 'de'.repeat(31) + '01';

  it('finds the scalar when our input is not the first', () => {
    // Block aggregation merges other senders' inputs into the transaction and
    // navio-core shuffles vin before broadcast, so a stranger's input can sit
    // at index 0. Anchoring on vin[0] alone would silently fail here.
    const target = blindingPublicKeyHex(deriveBlindingKey(seed, ours, 2, 0));
    const match = searchBlindingKey(seed, [foreignOutid(0x11), foreignOutid(0x22), ours], target);

    expect(match).not.toBeNull();
    expect(match!.outid).toBe(ours);
    expect(match!.counter).toBe(2);
    expect(match!.generation).toBe(0);
    expect(blindingPublicKeyHex(match!.scalar)).toBe(target);
  });

  it('finds a key built on a later generation', () => {
    const target = blindingPublicKeyHex(deriveBlindingKey(seed, ours, 3, 7));
    const match = searchBlindingKey(seed, [ours], target);

    expect(match!.counter).toBe(3);
    expect(match!.generation).toBe(7);
    expect(blindingPublicKeyHex(match!.scalar)).toBe(target);
  });

  it('finds a key built with the generation-less layout of navio-sdk 0.4', () => {
    const legacy = deriveLegacyBlindingKey(seed, ours, 1);
    const match = searchBlindingKey(seed, [foreignOutid(0x11), ours], blindingPublicKeyHex(legacy));

    expect(match!.outid).toBe(ours);
    expect(match!.counter).toBe(1);
    expect(match!.generation).toBeNull();
    expect(match!.scalar.serialize()).toBe(legacy.serialize());
  });

  it('returns null when none of the inputs is the anchor', () => {
    const target = blindingPublicKeyHex(deriveBlindingKey(seed, ours, 0, 0));
    expect(searchBlindingKey(seed, [foreignOutid(0x11), foreignOutid(0x22)], target)).toBeNull();
  });

  it('returns null for a seed that did not create the output', () => {
    const target = blindingPublicKeyHex(deriveBlindingKey(seed, ours, 0, 0));
    const otherSeed = Scalar.deserialize('08'.repeat(32));
    expect(searchBlindingKey(otherSeed, [ours], target)).toBeNull();
  });

  it('does not search past the ordinal or generation bound', () => {
    const target = blindingPublicKeyHex(deriveBlindingKey(seed, ours, MAX_OUTPUT_SEARCH, 0));
    expect(searchBlindingKey(seed, [ours], target)).toBeNull();
    const inBound = blindingPublicKeyHex(deriveBlindingKey(seed, ours, MAX_OUTPUT_SEARCH - 1, 0));
    expect(searchBlindingKey(seed, [ours], inBound)!.counter).toBe(MAX_OUTPUT_SEARCH - 1);

    const pastGenerations = blindingPublicKeyHex(deriveBlindingKey(seed, ours, 0, MAX_GENERATION_SEARCH));
    expect(searchBlindingKey(seed, [ours], pastGenerations)).toBeNull();
    const lastGeneration = blindingPublicKeyHex(deriveBlindingKey(seed, ours, 0, MAX_GENERATION_SEARCH - 1));
    expect(searchBlindingKey(seed, [ours], lastGeneration)!.generation).toBe(MAX_GENERATION_SEARCH - 1);
  });

  it('skips malformed input hashes instead of failing the search', () => {
    const target = blindingPublicKeyHex(deriveBlindingKey(seed, ours, 0, 0));
    const match = searchBlindingKey(seed, ['', 'not-hex', 'abcd', ours], target);
    expect(match!.outid).toBe(ours);
  });
});

describe('BlindingKeyAllocator', () => {
  const outid = 'ab'.repeat(32);
  const seed = Scalar.deserialize('01'.repeat(32));

  it('anchors on the canonical input, not the one passed first', () => {
    const low = '99'.repeat(31) + '01';
    const high = '11'.repeat(31) + '02';

    const a = new BlindingKeyAllocator(seed, [high, low], 0);
    const b = new BlindingKeyAllocator(seed, [low, high], 0);

    expect(a.anchorOutid).toBe(low);
    expect(b.anchorOutid).toBe(low);
    // Same anchor, therefore byte-identical keys regardless of selection order.
    expect(a.next().serialize()).toBe(b.next().serialize());
    // And that is the key the anchor alone would have produced.
    expect(new BlindingKeyAllocator(seed, [high, low], 0).next().serialize())
      .toBe(deriveBlindingKey(seed, low, 0, 0).serialize());
  });

  it('hands out the derived scalars in ordinal order', () => {
    const allocator = new BlindingKeyAllocator(seed, outid, 0);

    expect(allocator.isDeterministic).toBe(true);
    expect(allocator.generation).toBe(0);
    expect(allocator.next().serialize().padStart(64, '0')).toBe(VECTOR.expected[0].scalar);
    expect(allocator.next().serialize().padStart(64, '0')).toBe(VECTOR.expected[1].scalar);
  });

  it('derives from its generation, so two builds on one anchor share no key', () => {
    const first = new BlindingKeyAllocator(seed, outid, 0);
    const second = new BlindingKeyAllocator(seed, outid, 1);

    expect(second.next().serialize().padStart(64, '0')).toBe(VECTOR.expected[2].scalar);
    const firstKeys = [first.next(), first.next()].map((k) => k.serialize());
    second.reset();
    const secondKeys = [second.next(), second.next()].map((k) => k.serialize());
    expect(secondKeys.some((k) => firstKeys.includes(k))).toBe(false);
  });

  it('refuses to derive without a valid reserved generation', () => {
    // Defaulting to generation 0 is the key reuse the generation prevents.
    expect(() => new BlindingKeyAllocator(seed, outid)).toThrow(/reserved generation/);
    expect(() => new BlindingKeyAllocator(seed, outid, -1)).toThrow(/reserved generation/);
    expect(() => new BlindingKeyAllocator(seed, outid, MAX_GENERATION_SEARCH))
      .toThrow(/reserved generation/);
    // Random keys need none.
    expect(new BlindingKeyAllocator(null, outid).isDeterministic).toBe(false);
    expect(new BlindingKeyAllocator(seed, []).isDeterministic).toBe(false);
  });

  it('replays the same scalars after a reset, and remembers both rounds', () => {
    // Fee estimation rebuilds outputs; a rebuild must not shift the keys.
    const allocator = new BlindingKeyAllocator(seed, outid, 0);
    const first = [allocator.next(), allocator.next()].map((k) => k.serialize().padStart(64, '0'));
    allocator.reset();
    const second = [allocator.next(), allocator.next()].map((k) => k.serialize().padStart(64, '0'));

    expect(second).toEqual(first);
    expect(allocator.assignedByPublicKey().size).toBe(2);
  });

  it('resumes from a marked position so a stable prefix need not be rebuilt', () => {
    const allocator = new BlindingKeyAllocator(seed, outid, 0);
    allocator.next();
    const mark = allocator.position;
    const firstTail = allocator.next().serialize().padStart(64, '0');
    allocator.reset(mark);

    expect(allocator.next().serialize().padStart(64, '0')).toBe(firstTail);
  });

  it('refuses to build more outputs than recovery could search', () => {
    const allocator = new BlindingKeyAllocator(seed, outid, 0);
    for (let i = 0; i < MAX_OUTPUT_SEARCH; i++) {
      allocator.next();
    }
    expect(() => allocator.next()).toThrow(/would not be recoverable/);
  });

  it('falls back to unrecoverable random keys with no seed', () => {
    const allocator = BlindingKeyAllocator.random();

    expect(allocator.isDeterministic).toBe(false);
    expect(allocator.next().serialize()).not.toBe(allocator.next().serialize());
    expect(allocator.assignedByPublicKey().size).toBe(0);
  });
});

describe('NavioClient.recoverBlindingKey', () => {
  const outid = 'de'.repeat(31) + '01';

  it('recovers an output from the seed alone, as after a mnemonic restore', async () => {
    // A wallet restored from its mnemonic holds the seed and nothing else: no
    // stored scalars at all. This is the property the whole design exists for.
    const restored = new KeyManager();
    restored.setHDSeedFromMnemonic(TEST_MNEMONIC);
    const seed = restored.getMasterSeedKey();

    const scalars = [0, 1].map((counter) => deriveBlindingKey(seed, outid, counter, 0));
    const rawTx = buildTransaction(outid, scalars);

    // An empty stored-key table: nothing to fall back on but the derivation.
    const { client } = makeRecoveryClient({ seed, rawTx });

    const recovered = await client.recoverBlindingKey({ txid: 'irrelevant', vout: 0 });

    expect(recovered.source).toBe('derived');
    expect(recovered.counter).toBe(0);
    expect(recovered.blindingKey).toBe(scalars[0].serialize().padStart(64, '0'));
    expect(recovered.publicKey).toBe(blindingPublicKeyHex(scalars[0]));
  });

  it('derives the same keys from a re-derived seed as from the original wallet', async () => {
    const original = new KeyManager();
    original.setHDSeedFromMnemonic(TEST_MNEMONIC);
    const restored = new KeyManager();
    restored.setHDSeedFromMnemonic(TEST_MNEMONIC);

    expect(seedScalarToBytes(restored.getMasterSeedKey()))
      .toEqual(seedScalarToBytes(original.getMasterSeedKey()));
    expect(deriveBlindingKey(restored.getMasterSeedKey(), outid, 3, 0).serialize())
      .toBe(deriveBlindingKey(original.getMasterSeedKey(), outid, 3, 0).serialize());
  });

  it('recovers when the on-chain index differs from the sender-assigned counter', async () => {
    // Navio merges every non-coinbase transaction in a block into one, so our
    // output can sit at any index. Here ours was counter 0 but lands at vout 2
    // behind two foreign outputs — recovery must search rather than trust the
    // position.
    const seed = Scalar.deserialize('07'.repeat(32));
    const ours = deriveBlindingKey(seed, outid, 0, 0);
    const rawTx = buildTransaction(outid, [Scalar.random(), Scalar.random(), ours]);

    const { client } = makeRecoveryClient({ seed, rawTx });

    const recovered = await client.recoverBlindingKey({ txid: 'irrelevant', vout: 2 });

    expect(recovered.counter).toBe(0);
    expect(recovered.blindingKey).toBe(ours.serialize().padStart(64, '0'));

    // And the foreign outputs ahead of it are still correctly rejected.
    await expect(client.recoverBlindingKey({ txid: 'irrelevant', vout: 0 }))
      .rejects.toThrow(/not created by this wallet/);
  });

  it('recovers when a stranger\'s input sits first, as after aggregation', async () => {
    // The live failure this guards: two wallets' transactions merged into one
    // block transaction, ours second. Reading only vin[0] loses the output.
    const seed = Scalar.deserialize('07'.repeat(32));
    const ourInput = 'de'.repeat(31) + '01';
    const ours = deriveBlindingKey(seed, ourInput, 0, 0);
    const rawTx = buildTransaction(
      [foreignOutid(0x33), ourInput],
      [Scalar.random(), Scalar.random(), ours],
    );

    const { client } = makeRecoveryClient({ seed, rawTx });
    const parsed = parseTransaction(Buffer.from(rawTx, 'hex'));
    expect(parsed.inputHashes[0]).not.toBe(ourInput);

    const recovered = await client.recoverBlindingKey({ txid: 'irrelevant', vout: 2 });
    expect(recovered.anchorOutid).toBe(ourInput);
    expect(recovered.counter).toBe(0);
    expect(recovered.blindingKey).toBe(ours.serialize().padStart(64, '0'));
  });

  it('recovers an output whose anchor is not the first of our own inputs', async () => {
    // Two of our inputs; the sender anchors on the canonical one, which here is
    // deliberately the one that appears second in the transaction.
    const seed = Scalar.deserialize('07'.repeat(32));
    const low = '99'.repeat(31) + '01';
    const high = '11'.repeat(31) + '02';
    expect(canonicalAnchorOutid([high, low])).toBe(low);

    const ours = deriveBlindingKey(seed, low, 0, 0);
    const rawTx = buildTransaction([high, low], [ours]);

    const { client } = makeRecoveryClient({ seed, rawTx });
    const recovered = await client.recoverBlindingKey({ txid: 'irrelevant', vout: 0 });

    expect(recovered.anchorOutid).toBe(low);
    expect(recovered.blindingKey).toBe(ours.serialize().padStart(64, '0'));
  });

  it('finds an output assigned a counter other than zero', async () => {
    const seed = Scalar.deserialize('07'.repeat(32));
    const ours = deriveBlindingKey(seed, outid, 5, 0);
    const rawTx = buildTransaction(outid, [ours]);

    const { client } = makeRecoveryClient({ seed, rawTx });

    expect((await client.recoverBlindingKey({ txid: 'irrelevant', vout: 0 })).counter).toBe(5);
  });

  it('recovers outputs of a rebuild (later generation) and of navio-sdk 0.4 (legacy layout)', async () => {
    const seed = Scalar.deserialize('07'.repeat(32));
    const rebuilt = deriveBlindingKey(seed, outid, 1, 4);
    const legacy = deriveLegacyBlindingKey(seed, outid, 0);
    const rawTx = buildTransaction(outid, [rebuilt, legacy]);

    const { client, stored } = makeRecoveryClient({ seed, rawTx });

    const first = await client.recoverBlindingKey({ txid: 'irrelevant', vout: 0 });
    expect(first.source).toBe('derived');
    expect(first.counter).toBe(1);
    expect(first.generation).toBe(4);
    expect(first.blindingKey).toBe(rebuilt.serialize().padStart(64, '0'));

    const second = await client.recoverBlindingKey({ txid: 'irrelevant', vout: 1 });
    expect(second.counter).toBe(0);
    expect(second.generation).toBeNull();
    expect(second.blindingKey).toBe(legacy.serialize().padStart(64, '0'));

    // Both are written back, so the next lookup takes the fast path.
    expect(stored.size).toBe(2);
    expect((await client.recoverBlindingKey({ txid: 'irrelevant', vout: 1 })).source).toBe('stored');
  });

  it('prefers the stored scalar over deriving, and verifies it against the chain', async () => {
    const seed = Scalar.deserialize('09'.repeat(32));
    const ours = deriveBlindingKey(seed, outid, 0, 0);
    const rawTx = buildTransaction(outid, [ours]);
    const outputHash = parseTransaction(Buffer.from(rawTx, 'hex')).outputs[0].outputHash;

    const stored = new Map([[outputHash, ours.serialize().padStart(64, '0')]]);
    const { client } = makeRecoveryClient({ seed, rawTx, storedBlindingKeys: stored });

    const recovered = await client.recoverBlindingKey({ txid: 'irrelevant', vout: 0 });
    expect(recovered.source).toBe('stored');
    expect(recovered.blindingKey).toBe(ours.serialize().padStart(64, '0'));
  });

  it('ignores a stored scalar that does not match the chain and derives instead', async () => {
    const seed = Scalar.deserialize('09'.repeat(32));
    const ours = deriveBlindingKey(seed, outid, 0, 0);
    const rawTx = buildTransaction(outid, [ours]);
    const outputHash = parseTransaction(Buffer.from(rawTx, 'hex')).outputs[0].outputHash;

    const stale = new Map([[outputHash, Scalar.random().serialize().padStart(64, '0')]]);
    const { client } = makeRecoveryClient({ seed, rawTx, storedBlindingKeys: stale });

    const recovered = await client.recoverBlindingKey({ txid: 'irrelevant', vout: 0 });
    expect(recovered.source).toBe('derived');
    expect(recovered.blindingKey).toBe(ours.serialize().padStart(64, '0'));
  });

  it('fails when the output was not created by this wallet', async () => {
    // A random scalar stands in for any output this seed did not create,
    // including every output made before this feature existed.
    const rawTx = buildTransaction(outid, [Scalar.random()]);
    const { client } = makeRecoveryClient({ seed: Scalar.deserialize('11'.repeat(32)), rawTx });

    await expect(client.recoverBlindingKey({ txid: 'irrelevant', vout: 0 }))
      .rejects.toThrow(/Could not recover the blinding key/);
  });

  it('fails when the wallet is locked', async () => {
    const seed = Scalar.deserialize('07'.repeat(32));
    const rawTx = buildTransaction(outid, [deriveBlindingKey(seed, outid, 0, 0)]);
    const { client } = makeRecoveryClient({ seed, rawTx, unlocked: false });

    await expect(client.recoverBlindingKey({ txid: 'irrelevant', vout: 0 }))
      .rejects.toThrow(/locked/);
  });

  it('fails cleanly on an out-of-range vout', async () => {
    const seed = Scalar.deserialize('07'.repeat(32));
    const rawTx = buildTransaction(outid, [deriveBlindingKey(seed, outid, 0, 0)]);
    const { client } = makeRecoveryClient({ seed, rawTx });

    await expect(client.recoverBlindingKey({ txid: 'irrelevant', vout: 99 }))
      .rejects.toThrow(/out of range/);
  });
});

describe('NavioClient stored blinding keys of an encrypted wallet', () => {
  const outid = 'de'.repeat(31) + '01';
  const PASSWORD = 'correct horse battery staple';
  let keyManager: KeyManager;

  beforeAll(async () => {
    keyManager = new KeyManager();
    keyManager.setHDSeedFromMnemonic(TEST_MNEMONIC);
    await keyManager.setPassword(PASSWORD);
  });

  afterEach(async () => {
    await keyManager.unlock(PASSWORD);
  });

  function setup(scalars: Array<InstanceType<typeof Scalar>>, stored?: Map<string, string>) {
    const rawTx = buildTransaction(outid, scalars);
    const outputHashes = parseTransaction(Buffer.from(rawTx, 'hex')).outputs.map((o) => o.outputHash);
    const ctx = makeRecoveryClient({ seed: null, rawTx, keyManager, storedBlindingKeys: stored });
    return { ...ctx, rawTx, outputHashes };
  }

  it('persists the scalars of a new transaction encrypted', async () => {
    const seed = keyManager.getMasterSeedKey();
    const allocator = new BlindingKeyAllocator(seed, outid, 0);
    const scalars = [allocator.next(), allocator.next()];
    const { client, rawTx, outputHashes, stored } = setup(scalars);

    await (client as any).persistBlindingKeys((client as any).walletDB, rawTx, allocator);

    expect(stored.size).toBe(2);
    for (const [i, hash] of outputHashes.slice(0, 2).entries()) {
      const record = stored.get(hash)!;
      const scalarHex = scalars[i].serialize().padStart(64, '0');
      expect(isSealedBlindingKey(record)).toBe(true);
      expect(record).not.toContain(scalarHex);
      expect(await openOutputBlindingKey(keyManager, record)).toBe(scalarHex);
    }

    // And reads them back on the fast path.
    const recovered = await client.recoverBlindingKey({ txid: 'irrelevant', vout: 1 });
    expect(recovered.source).toBe('stored');
    expect(recovered.blindingKey).toBe(scalars[1].serialize().padStart(64, '0'));
  });

  it('encrypts plaintext rows left from before, the first time it reads the table', async () => {
    const ours = deriveBlindingKey(keyManager.getMasterSeedKey(), outid, 0, 0);
    const scalarHex = ours.serialize().padStart(64, '0');
    const legacyRows = new Map([[OUTPUT_ELSEWHERE, '3c'.repeat(32)]]);
    const { client, outputHashes, stored } = setup([ours], legacyRows);
    stored.set(outputHashes[0], scalarHex);

    const recovered = await client.recoverBlindingKey({ txid: 'irrelevant', vout: 0 });
    expect(recovered.source).toBe('stored');
    expect(recovered.blindingKey).toBe(scalarHex);

    for (const record of stored.values()) {
      expect(isSealedBlindingKey(record)).toBe(true);
    }
    expect(await openOutputBlindingKey(keyManager, stored.get(OUTPUT_ELSEWHERE)!)).toBe('3c'.repeat(32));
    // The explicit hook agrees there is nothing left.
    expect(await client.sealStoredBlindingKeys()).toBe(0);
  });

  it('re-derives and rewrites a record it cannot decrypt', async () => {
    // A record sealed under another key, as after changePassword().
    const other = new KeyManager();
    other.setHDSeedFromMnemonic(TEST_MNEMONIC);
    await other.setPassword('another password');

    const ours = deriveBlindingKey(keyManager.getMasterSeedKey(), outid, 0, 0);
    const scalarHex = ours.serialize().padStart(64, '0');
    const { client, outputHashes, stored } = setup([ours]);
    stored.set(outputHashes[0], await sealOutputBlindingKey(other, scalarHex));

    const recovered = await client.recoverBlindingKey({ txid: 'irrelevant', vout: 0 });
    expect(recovered.source).toBe('derived');
    expect(recovered.blindingKey).toBe(scalarHex);
    expect(await openOutputBlindingKey(keyManager, stored.get(outputHashes[0])!)).toBe(scalarHex);
  });

  it('leaves the table alone while locked', async () => {
    const ours = deriveBlindingKey(keyManager.getMasterSeedKey(), outid, 0, 0);
    const { client, outputHashes, stored } = setup([ours]);
    stored.set(outputHashes[0], ours.serialize().padStart(64, '0'));
    keyManager.lock();

    await expect(client.recoverBlindingKey({ txid: 'irrelevant', vout: 0 })).rejects.toThrow(/locked/);
    expect(await client.sealStoredBlindingKeys()).toBe(0);
    expect(isSealedBlindingKey(stored.get(outputHashes[0])!)).toBe(false);
  });
});

describe('NavioClient.signOutput', () => {
  const outid = 'de'.repeat(31) + '01';

  it('produces a signature that verifies against the public blinding key', async () => {
    const seed = Scalar.deserialize('07'.repeat(32));
    const ours = deriveBlindingKey(seed, outid, 1, 0);
    const rawTx = buildTransaction(outid, [Scalar.random(), ours]);
    const { client } = makeRecoveryClient({ seed, rawTx });

    const message = 'navio-hl-refund/v1|abc123|1|paid the wrong address';
    const { signature, blindingKey } = await client.signOutput({
      txid: 'irrelevant',
      vout: 1,
      message,
    });

    // The whole point: anyone holding the on-chain public key can check this.
    const publicKey = PublicKey.deserialize(blindingKey);
    expect(Signature.deserialize(signature).verify(publicKey, message)).toBe(true);

    // And it is bound to the message.
    expect(Signature.deserialize(signature).verify(publicKey, `${message} `)).toBe(false);
  });

  it('returns the point that is actually on chain for that output', async () => {
    // Guards the subtlety that k*G is the output's ephemeralKey, not the
    // field navio-core calls blsctData.blindingKey (which is k*sk_destination).
    const seed = Scalar.deserialize('07'.repeat(32));
    const ours = deriveBlindingKey(seed, outid, 0, 0);
    const rawTx = buildTransaction(outid, [ours]);
    const onChain = parseTransaction(Buffer.from(rawTx, 'hex')).outputs[0].keys!;

    const { client } = makeRecoveryClient({ seed, rawTx });
    const { blindingKey } = await client.signOutput({ txid: 'x', vout: 0, message: 'hi' });

    expect(blindingKey).toBe(onChain.ephemeralKey.toLowerCase());
    expect(blindingKey).toBe(blindingPublicKeyHex(ours));
    expect(blindingKey).not.toBe(onChain.blindingKey.toLowerCase());
  });

  it('signs an empty message without special-casing it', async () => {
    const seed = Scalar.deserialize('07'.repeat(32));
    const ours = deriveBlindingKey(seed, outid, 0, 0);
    const rawTx = buildTransaction(outid, [ours]);
    const { client } = makeRecoveryClient({ seed, rawTx });

    const { signature, blindingKey } = await client.signOutput({ txid: 'x', vout: 0, message: '' });
    expect(Signature.deserialize(signature).verify(PublicKey.deserialize(blindingKey), '')).toBe(true);
  });
});
