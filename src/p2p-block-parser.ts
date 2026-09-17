/**
 * Navio block / transaction wire parser for the P2P sync path.
 *
 * Mirrors the navio-core serialization in `primitives/block.h`,
 * `primitives/transaction.h`, `blsct/pos/proof.h`,
 * `blsct/set_mem_proof/set_mem_proof.h` and
 * `blsct/range_proof/bulletproofs_plus/range_proof.h`:
 *
 * - CBlock: 80-byte header, then (PoS blocks only) `blsct::ProofOfStake`,
 *   then `vtx`.
 * - CTransaction: nVersion, [witness marker/flags], vin, vout, [witness],
 *   nLockTime, [96-byte BLSCT signature when nVersion has BLSCT_MARKER].
 * - COutPoint carries only a 32-byte hash (no index).
 * - CTxOut: nValue (INT64_MAX sentinel introduces a uint64 flags word),
 *   scriptPubKey, [CTxOutBLSCTData], [TokenId], [predicate].
 * - CTxOutBLSCTData: RangeProof, spendingKey, blindingKey, ephemeralKey,
 *   viewTag (keys and view tag are always present when the BLSCT flag is set).
 *
 * The txid is the double SHA256 of the witness-stripped serialization
 * (`CTransaction::ComputeHash`); the output hash is the double SHA256 of the
 * serialized `CTxOut` (`CTxOut::GetHash`).
 */

import { sha256 } from '@noble/hashes/sha256';

const G1_POINT_SIZE = 48;
const SCALAR_SIZE = 32;
const BLSCT_SIGNATURE_SIZE = 96;
const TOKEN_ID_SIZE = 40; // uint256 token + uint64 subid
const MAX_AMOUNT = 0x7fffffffffffffffn;

/** CTxOut flag bits */
const OUT_BLSCT_MARKER = 0x1n;
const OUT_TOKEN_MARKER = 0x2n;
const OUT_PREDICATE_MARKER = 0x4n;
const OUT_TRANSPARENT_VALUE_MARKER = 0x8n;

/** CTransaction::BLSCT_MARKER */
const TX_BLSCT_MARKER = 1 << 5;

/** CBlockHeader::VERSION_BIT_POS */
export const BLOCK_VERSION_BIT_POS = 0x01000000;

/**
 * BLSCT keys extracted from an output
 */
export interface ParsedOutputKeys {
  /** Output hash (display hex) */
  outputHash: string;
  /** Blinding key (G1 point, hex) */
  blindingKey: string;
  /** Spending key (G1 point, hex) */
  spendingKey: string;
  /** Ephemeral key (G1 point, hex) */
  ephemeralKey: string;
  /** View tag (16-bit) */
  viewTag: number;
  /** Whether the output carries a range proof (Vs non-empty) */
  hasRangeProof: boolean;
}

/**
 * A parsed transaction output
 */
export interface ParsedOutput {
  /** Output index */
  index: number;
  /** Output hash (display hex) */
  outputHash: string;
  /** Serialized output (hex) */
  serializedHex: string;
  /** BLSCT keys when the output carries BLSCT data */
  keys: ParsedOutputKeys | null;
}

/**
 * A parsed transaction
 */
export interface ParsedTransaction {
  /** Transaction id (display hex, witness-stripped hash) */
  txid: string;
  /** Witness transaction id (display hex; equals txid without witness) */
  wtxid: string;
  /** Transaction version */
  version: number;
  /** Whether the transaction carries a BLSCT signature */
  isBlsct: boolean;
  /** Whether witness data was present */
  hasWitness: boolean;
  /** Byte offset where the transaction starts in the source buffer */
  start: number;
  /** Byte offset just past the transaction in the source buffer */
  end: number;
  /** Serialized transaction as received (hex) */
  rawHex: string;
  /** Spent output hashes (display hex), in input order */
  inputHashes: string[];
  /** Outputs */
  outputs: ParsedOutput[];
}

/**
 * A parsed block
 */
export interface ParsedBlock {
  /** Block hash (display hex) */
  hash: string;
  /** 80-byte header (hex) */
  headerHex: string;
  /** Header version */
  version: number;
  /** Block timestamp */
  timestamp: number;
  /** Whether the block is a Proof-of-Stake block */
  isPoS: boolean;
  /** Transactions */
  txs: ParsedTransaction[];
}

function hash256(data: Uint8Array): Buffer {
  return Buffer.from(sha256(sha256(data)));
}

function toDisplay(hash: Buffer): string {
  return Buffer.from(hash).reverse().toString('hex');
}

class Cursor {
  constructor(
    public readonly data: Buffer,
    public offset: number
  ) {}

  need(n: number): void {
    if (this.offset + n > this.data.length) {
      throw new Error(
        `Truncated data: need ${n} bytes at offset ${this.offset}, have ${this.data.length}`
      );
    }
  }

  varint(): number {
    this.need(1);
    const first = this.data[this.offset];
    if (first < 0xfd) {
      this.offset += 1;
      return first;
    } else if (first === 0xfd) {
      this.need(3);
      const v = this.data.readUInt16LE(this.offset + 1);
      this.offset += 3;
      return v;
    } else if (first === 0xfe) {
      this.need(5);
      const v = this.data.readUInt32LE(this.offset + 1);
      this.offset += 5;
      return v;
    } else {
      this.need(9);
      const v = this.data.readBigUInt64LE(this.offset + 1);
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`Varint too large: ${v}`);
      }
      this.offset += 9;
      return Number(v);
    }
  }

  skip(n: number): void {
    this.need(n);
    this.offset += n;
  }

  bytes(n: number): Buffer {
    this.need(n);
    const out = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  u16(): number {
    this.need(2);
    const v = this.data.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.data.readInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  i64(): bigint {
    this.need(8);
    const v = this.data.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  u64(): bigint {
    this.need(8);
    const v = this.data.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  /** Skip a vector of fixed-size elements (varint count + count * size) */
  skipVector(elementSize: number, maxCount = 1 << 20): number {
    const count = this.varint();
    if (count > maxCount) {
      throw new Error(`Vector too long: ${count}`);
    }
    this.skip(count * elementSize);
    return count;
  }
}

/**
 * Skip a bulletproofs+ RangeProof (`RangeProof<T>::Serialize`).
 * Returns true when the proof carries commitments (Vs non-empty).
 */
function skipRangeProof(c: Cursor): boolean {
  const numVs = c.skipVector(G1_POINT_SIZE);
  if (numVs === 0) {
    return false;
  }
  c.skipVector(G1_POINT_SIZE); // Ls
  c.skipVector(G1_POINT_SIZE); // Rs
  c.skip(3 * G1_POINT_SIZE); // A, A_wip, B
  c.skip(5 * SCALAR_SIZE); // r_prime, s_prime, delta_prime, alpha_hat, tau_x
  return true;
}

/**
 * Skip a `blsct::ProofOfStake` (SetMemProof + RangeProofWithoutVs)
 */
function skipProofOfStake(c: Cursor): void {
  // SetMemProof: phi, A1, A2, S1, S2, S3, T1, T2 (8 points);
  // tau_x, mu, z_alpha, z_tau, z_beta, t (6 scalars); Ls; Rs; a, b, omega
  c.skip(8 * G1_POINT_SIZE);
  c.skip(6 * SCALAR_SIZE);
  c.skipVector(G1_POINT_SIZE); // Ls
  c.skipVector(G1_POINT_SIZE); // Rs
  c.skip(3 * SCALAR_SIZE);

  // RangeProofWithoutVs: Ls, Rs, A, A_wip, B, r', s', delta', alpha_hat, tau_x
  c.skipVector(G1_POINT_SIZE);
  c.skipVector(G1_POINT_SIZE);
  c.skip(3 * G1_POINT_SIZE);
  c.skip(5 * SCALAR_SIZE);
}

/**
 * Parse one CTxOut at the cursor
 */
function parseOutput(c: Cursor, index: number): ParsedOutput {
  const start = c.offset;
  let flags = 0n;
  const rawValue = c.i64();
  if (rawValue === MAX_AMOUNT) {
    flags = c.u64();
    if (flags & OUT_TRANSPARENT_VALUE_MARKER) {
      c.skip(8);
    }
  }

  // scriptPubKey
  const scriptLen = c.varint();
  c.skip(scriptLen);

  let keys: ParsedOutputKeys | null = null;
  if (flags & OUT_BLSCT_MARKER) {
    const hasRangeProof = skipRangeProof(c);
    const spendingKey = c.bytes(G1_POINT_SIZE).toString('hex');
    const blindingKey = c.bytes(G1_POINT_SIZE).toString('hex');
    const ephemeralKey = c.bytes(G1_POINT_SIZE).toString('hex');
    const viewTag = c.u16();
    keys = { outputHash: '', blindingKey, spendingKey, ephemeralKey, viewTag, hasRangeProof };
  }

  if (flags & OUT_TOKEN_MARKER) {
    c.skip(TOKEN_ID_SIZE);
  }

  if (flags & OUT_PREDICATE_MARKER) {
    const predicateLen = c.varint();
    c.skip(predicateLen);
  }

  const serialized = c.data.subarray(start, c.offset);
  const outputHash = toDisplay(hash256(serialized));
  if (keys) {
    keys.outputHash = outputHash;
  }
  return { index, outputHash, serializedHex: serialized.toString('hex'), keys };
}

/**
 * Parse one transaction starting at `offset`
 */
export function parseTransaction(data: Buffer, offset = 0): ParsedTransaction {
  const c = new Cursor(data, offset);
  const start = offset;

  const version = c.i32();
  const isBlsct = (version & TX_BLSCT_MARKER) !== 0;

  // Witness marker: an empty vin (0x00) followed by a non-zero flags byte
  let hasWitness = false;
  c.need(1);
  if (data[c.offset] === 0x00 && c.offset + 1 < data.length && data[c.offset + 1] !== 0x00) {
    const flags = data[c.offset + 1];
    if (flags !== 0x01) {
      throw new Error(`Unknown transaction flags: 0x${flags.toString(16)}`);
    }
    hasWitness = true;
    c.skip(2);
  }

  const vinStart = c.offset;
  const inputCount = c.varint();
  if (inputCount > 100000) {
    throw new Error(`Implausible input count: ${inputCount}`);
  }
  const inputHashes: string[] = [];
  for (let i = 0; i < inputCount; i++) {
    inputHashes.push(toDisplay(c.bytes(32))); // COutPoint: hash only
    const scriptSigLen = c.varint();
    c.skip(scriptSigLen);
    c.skip(4); // nSequence
  }

  const outputCount = c.varint();
  if (outputCount > 100000) {
    throw new Error(`Implausible output count: ${outputCount}`);
  }
  const outputs: ParsedOutput[] = [];
  for (let i = 0; i < outputCount; i++) {
    outputs.push(parseOutput(c, i));
  }
  const voutEnd = c.offset;

  if (hasWitness) {
    for (let i = 0; i < inputCount; i++) {
      const items = c.varint();
      for (let j = 0; j < items; j++) {
        const len = c.varint();
        c.skip(len);
      }
    }
  }

  const tailStart = c.offset;
  c.skip(4); // nLockTime
  if (isBlsct) {
    c.skip(BLSCT_SIGNATURE_SIZE);
  }
  const end = c.offset;

  const full = data.subarray(start, end);
  let txidBytes: Buffer;
  if (hasWitness) {
    // Witness-stripped serialization: version | vin | vout | locktime [| sig]
    const stripped = Buffer.concat([
      data.subarray(start, start + 4),
      data.subarray(vinStart, voutEnd),
      data.subarray(tailStart, end),
    ]);
    txidBytes = hash256(stripped);
  } else {
    txidBytes = hash256(full);
  }
  const txid = toDisplay(txidBytes);
  const wtxid = hasWitness ? toDisplay(hash256(full)) : txid;

  return {
    txid,
    wtxid,
    version,
    isBlsct,
    hasWitness,
    start,
    end,
    rawHex: full.toString('hex'),
    inputHashes,
    outputs,
  };
}

/**
 * Compute the txid (display hex) of a serialized transaction
 */
export function computeTxid(rawTx: Buffer): string {
  return parseTransaction(rawTx, 0).txid;
}

/**
 * Parse a serialized block (as carried by a `block` message)
 */
export function parseBlock(data: Buffer): ParsedBlock {
  if (data.length < 80) {
    throw new Error(`Block too short: ${data.length} bytes`);
  }
  const header = data.subarray(0, 80);
  const version = header.readInt32LE(0);
  const timestamp = header.readUInt32LE(68);
  const isPoS = (version & BLOCK_VERSION_BIT_POS) !== 0;

  const c = new Cursor(data, 80);
  if (isPoS) {
    skipProofOfStake(c);
  }

  const txCount = c.varint();
  const txs: ParsedTransaction[] = [];
  for (let i = 0; i < txCount; i++) {
    const tx = parseTransaction(data, c.offset);
    txs.push(tx);
    c.offset = tx.end;
  }
  if (c.offset !== data.length) {
    throw new Error(`Block parse mismatch: consumed ${c.offset} of ${data.length} bytes`);
  }

  return {
    hash: toDisplay(hash256(header)),
    headerHex: header.toString('hex'),
    version,
    timestamp,
    isPoS,
    txs,
  };
}
