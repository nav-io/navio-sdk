import { describe, it, expect, vi } from 'vitest';
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
import {
  BLINDING_DOMAIN_SEPARATOR,
  BLINDING_MATERIAL_SIZE,
  BLS12_381_GROUP_ORDER,
  BlindingKeyAllocator,
  MAX_OUTPUT_SEARCH,
  blindingPublicKeyHex,
  buildBlindingMaterial,
  canonicalAnchorOutid,
  deriveBlindingKey,
  deriveBlindingScalarHex,
  outidDisplayHexToBytes,
  searchBlindingKey,
  seedScalarToBytes,
} from './blinding-key';
import { NavioClient } from './client';
import { KeyManager } from './key-manager';
import { parseTransaction } from './p2p-block-parser';

/**
 * The normative cross-implementation vector from
 * docs/BLINDING-KEY-RECOVERY.md. navio-core's C++ implementation must produce
 * exactly these scalars for the same inputs.
 */
const VECTOR = {
  seed: new Uint8Array(32).fill(0x01),
  outid: new Uint8Array(32).fill(0xab),
  expected: [
    '6f57f45d6d6ceb748b859f3f7b16b08ee720cc91f947aab1ba4b3d825a5cb281',
    '41d3910421dc8f3b19079bdd9d9f8769e3ed691fabe978dc6dd2aa0f4448e2c1',
  ],
};

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
  };
  (client as any).keyManager = {
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
  it('reproduces the normative cross-implementation test vector', () => {
    // This is the shared check against navio-core's C++ implementation. If it
    // fails, the two sides have diverged and outputs created by one are not
    // recoverable by the other.
    for (const [counter, expected] of VECTOR.expected.entries()) {
      expect(deriveBlindingScalarHex(VECTOR.seed, VECTOR.outid, counter)).toBe(expected);
    }
  });

  it('lays out exactly 91 bytes of material in the specified order', () => {
    const material = buildBlindingMaterial(VECTOR.seed, VECTOR.outid, 1);

    expect(material.length).toBe(BLINDING_MATERIAL_SIZE);
    expect(material.length).toBe(91);
    expect(new TextDecoder().decode(material.subarray(0, 23))).toBe(BLINDING_DOMAIN_SEPARATOR);
    expect(bytesToHex(material.subarray(23, 55))).toBe('01'.repeat(32));
    expect(bytesToHex(material.subarray(55, 87))).toBe('ab'.repeat(32));
    // counter, big-endian
    expect(bytesToHex(material.subarray(87, 91))).toBe('00000001');
  });

  it('is deterministic and separates counters, seeds and outids', () => {
    const otherSeed = new Uint8Array(32).fill(0x02);
    const otherOutid = new Uint8Array(32).fill(0xcd);

    expect(deriveBlindingScalarHex(VECTOR.seed, VECTOR.outid, 0))
      .toBe(deriveBlindingScalarHex(VECTOR.seed, VECTOR.outid, 0));

    const distinct = new Set([
      deriveBlindingScalarHex(VECTOR.seed, VECTOR.outid, 0),
      deriveBlindingScalarHex(VECTOR.seed, VECTOR.outid, 1),
      deriveBlindingScalarHex(otherSeed, VECTOR.outid, 0),
      deriveBlindingScalarHex(VECTOR.seed, otherOutid, 0),
    ]);
    expect(distinct.size).toBe(4);
  });

  it('reduces the digest modulo the group order', () => {
    // The vector's own values are below r on purpose, so exercise the
    // reduction separately: every derived scalar must be a canonical field
    // element, and navio-blsct must agree with the reduction done here.
    for (let counter = 0; counter < 64; counter++) {
      const hex = deriveBlindingScalarHex(VECTOR.seed, VECTOR.outid, counter);
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
    expect(() => buildBlindingMaterial(new Uint8Array(31), VECTOR.outid, 0)).toThrow(/32 bytes/);
    expect(() => buildBlindingMaterial(VECTOR.seed, new Uint8Array(33), 0)).toThrow(/32 bytes/);
    expect(() => buildBlindingMaterial(VECTOR.seed, VECTOR.outid, -1)).toThrow(/uint32/);
    expect(() => buildBlindingMaterial(VECTOR.seed, VECTOR.outid, 1.5)).toThrow(/uint32/);
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
    const target = blindingPublicKeyHex(deriveBlindingKey(seed, ours, 2));
    const match = searchBlindingKey(seed, [foreignOutid(0x11), foreignOutid(0x22), ours], target);

    expect(match).not.toBeNull();
    expect(match!.outid).toBe(ours);
    expect(match!.counter).toBe(2);
    expect(blindingPublicKeyHex(match!.scalar)).toBe(target);
  });

  it('returns null when none of the inputs is the anchor', () => {
    const target = blindingPublicKeyHex(deriveBlindingKey(seed, ours, 0));
    expect(searchBlindingKey(seed, [foreignOutid(0x11), foreignOutid(0x22)], target)).toBeNull();
  });

  it('returns null for a seed that did not create the output', () => {
    const target = blindingPublicKeyHex(deriveBlindingKey(seed, ours, 0));
    const otherSeed = Scalar.deserialize('08'.repeat(32));
    expect(searchBlindingKey(otherSeed, [ours], target)).toBeNull();
  });

  it('does not search past the ordinal bound', () => {
    const target = blindingPublicKeyHex(deriveBlindingKey(seed, ours, MAX_OUTPUT_SEARCH));
    expect(searchBlindingKey(seed, [ours], target)).toBeNull();
    const inBound = blindingPublicKeyHex(deriveBlindingKey(seed, ours, MAX_OUTPUT_SEARCH - 1));
    expect(searchBlindingKey(seed, [ours], inBound)!.counter).toBe(MAX_OUTPUT_SEARCH - 1);
  });

  it('skips malformed input hashes instead of failing the search', () => {
    const target = blindingPublicKeyHex(deriveBlindingKey(seed, ours, 0));
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

    const a = new BlindingKeyAllocator(seed, [high, low]);
    const b = new BlindingKeyAllocator(seed, [low, high]);

    expect(a.anchorOutid).toBe(low);
    expect(b.anchorOutid).toBe(low);
    // Same anchor, therefore byte-identical keys regardless of selection order.
    expect(a.next().serialize()).toBe(b.next().serialize());
    // And that is the key the anchor alone would have produced.
    expect(new BlindingKeyAllocator(seed, [high, low]).next().serialize())
      .toBe(deriveBlindingKey(seed, low, 0).serialize());
  });

  it('hands out the derived scalars in counter order', () => {
    const allocator = new BlindingKeyAllocator(seed, outid);

    expect(allocator.isDeterministic).toBe(true);
    expect(allocator.next().serialize().padStart(64, '0')).toBe(VECTOR.expected[0]);
    expect(allocator.next().serialize().padStart(64, '0')).toBe(VECTOR.expected[1]);
  });

  it('replays the same scalars after a reset, and remembers both rounds', () => {
    // Fee estimation rebuilds outputs; a rebuild must not shift the keys.
    const allocator = new BlindingKeyAllocator(seed, outid);
    const first = [allocator.next(), allocator.next()].map((k) => k.serialize().padStart(64, '0'));
    allocator.reset();
    const second = [allocator.next(), allocator.next()].map((k) => k.serialize().padStart(64, '0'));

    expect(second).toEqual(first);
    expect(allocator.assignedByPublicKey().size).toBe(2);
  });

  it('resumes from a marked position so a stable prefix need not be rebuilt', () => {
    const allocator = new BlindingKeyAllocator(seed, outid);
    allocator.next();
    const mark = allocator.position;
    const firstTail = allocator.next().serialize().padStart(64, '0');
    allocator.reset(mark);

    expect(allocator.next().serialize().padStart(64, '0')).toBe(firstTail);
  });

  it('refuses to build more outputs than recovery could search', () => {
    const allocator = new BlindingKeyAllocator(seed, outid);
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

    const scalars = [0, 1].map((counter) => deriveBlindingKey(seed, outid, counter));
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
    expect(deriveBlindingKey(restored.getMasterSeedKey(), outid, 3).serialize())
      .toBe(deriveBlindingKey(original.getMasterSeedKey(), outid, 3).serialize());
  });

  it('recovers when the on-chain index differs from the sender-assigned counter', async () => {
    // Navio merges every non-coinbase transaction in a block into one, so our
    // output can sit at any index. Here ours was counter 0 but lands at vout 2
    // behind two foreign outputs — recovery must search rather than trust the
    // position.
    const seed = Scalar.deserialize('07'.repeat(32));
    const ours = deriveBlindingKey(seed, outid, 0);
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
    const ours = deriveBlindingKey(seed, ourInput, 0);
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

    const ours = deriveBlindingKey(seed, low, 0);
    const rawTx = buildTransaction([high, low], [ours]);

    const { client } = makeRecoveryClient({ seed, rawTx });
    const recovered = await client.recoverBlindingKey({ txid: 'irrelevant', vout: 0 });

    expect(recovered.anchorOutid).toBe(low);
    expect(recovered.blindingKey).toBe(ours.serialize().padStart(64, '0'));
  });

  it('finds an output assigned a counter other than zero', async () => {
    const seed = Scalar.deserialize('07'.repeat(32));
    const ours = deriveBlindingKey(seed, outid, 5);
    const rawTx = buildTransaction(outid, [ours]);

    const { client } = makeRecoveryClient({ seed, rawTx });

    expect((await client.recoverBlindingKey({ txid: 'irrelevant', vout: 0 })).counter).toBe(5);
  });

  it('prefers the stored scalar over deriving, and verifies it against the chain', async () => {
    const seed = Scalar.deserialize('09'.repeat(32));
    const ours = deriveBlindingKey(seed, outid, 0);
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
    const ours = deriveBlindingKey(seed, outid, 0);
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
    const rawTx = buildTransaction(outid, [deriveBlindingKey(seed, outid, 0)]);
    const { client } = makeRecoveryClient({ seed, rawTx, unlocked: false });

    await expect(client.recoverBlindingKey({ txid: 'irrelevant', vout: 0 }))
      .rejects.toThrow(/locked/);
  });

  it('fails cleanly on an out-of-range vout', async () => {
    const seed = Scalar.deserialize('07'.repeat(32));
    const rawTx = buildTransaction(outid, [deriveBlindingKey(seed, outid, 0)]);
    const { client } = makeRecoveryClient({ seed, rawTx });

    await expect(client.recoverBlindingKey({ txid: 'irrelevant', vout: 99 }))
      .rejects.toThrow(/out of range/);
  });
});

describe('NavioClient.signOutput', () => {
  const outid = 'de'.repeat(31) + '01';

  it('produces a signature that verifies against the public blinding key', async () => {
    const seed = Scalar.deserialize('07'.repeat(32));
    const ours = deriveBlindingKey(seed, outid, 1);
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
    const ours = deriveBlindingKey(seed, outid, 0);
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
    const ours = deriveBlindingKey(seed, outid, 0);
    const rawTx = buildTransaction(outid, [ours]);
    const { client } = makeRecoveryClient({ seed, rawTx });

    const { signature, blindingKey } = await client.signOutput({ txid: 'x', vout: 0, message: '' });
    expect(Signature.deserialize(signature).verify(PublicKey.deserialize(blindingKey), '')).toBe(true);
  });
});
