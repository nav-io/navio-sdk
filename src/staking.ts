/**
 * Staking helpers that need no chain access.
 */

import {
  BlsctPredicateType,
  getPredicateType,
  isStakeDelegationDataHex,
  parseDataPredicateData,
  parseStakeDelegationOwnerInfo,
  type Point,
} from '@nav-io/navio-blsct';
import { parseOutputHex, type ParsedOutput } from './p2p-block-parser';

/** A staked commitment of this wallet delegated to a third-party staker. */
export interface StakeDelegation {
  /** The delegated staked output */
  outputHash: string;
  /** The staked amount in satoshis */
  amount: bigint;
  /** Height of the block that confirmed the output */
  blockHeight: number;
  /** The staker's delegation public key (G1 point, hex) */
  delegateKey: string;
  /** Where the staker is asked to pay block rewards */
  rewardAddress: string;
}

const OP_STAKED_COMMITMENT = 0xb9;
const OP_PUSHDATA2 = 0x4d;
const OP_TRUE = 0x51;

/**
 * Whether an output is a staked commitment: NAV locked for staking, which
 * only a staking transaction (or an unstake) can spend.
 *
 * Mirrors navio-core's `CTxOut::IsStakedCommitment` on the parts a wallet can
 * check from the serialized output: a range proof with commitments, the
 * default token, and a scriptPubKey of `OP_STAKED_COMMITMENT`, an
 * `OP_PUSHDATA2` push, and `OP_TRUE` last. Core additionally decodes the
 * pushed range proof; this does not.
 */
export function isStakedCommitmentOutput(output: ParsedOutput): boolean {
  const script = Buffer.from(output.scriptPubKeyHex, 'hex');
  return (
    output.keys?.hasRangeProof === true &&
    output.tokenIdHex === null &&
    script.length > 7 &&
    script[0] === OP_STAKED_COMMITMENT &&
    script[1] === OP_PUSHDATA2 &&
    script[script.length - 1] === OP_TRUE
  );
}

/**
 * {@link isStakedCommitmentOutput} for a serialized output. False when the
 * hex is empty or does not parse as one output.
 */
export function isStakedCommitmentOutputHex(outputHex: string): boolean {
  if (!outputHex) {
    return false;
  }
  try {
    return isStakedCommitmentOutput(parseOutputHex(outputHex));
  } catch {
    return false;
  }
}

/**
 * The delegation a staked output carries, as its owner reads it, or null when
 * the output carries no delegation payload. Mirrors navio-core's
 * `GetWalletDelegations`: the payload is the output's DATA predicate, and its
 * owner section opens with the output's BLSCT nonce.
 *
 * @param output - The staked output
 * @param nonce - The output's nonce: its blinding key times the owner's view
 *   key (`KeyManager.calculateNonce`)
 * @throws When the output carries a delegation payload that the nonce does not
 *   open
 */
export function recoverStakeDelegation(
  output: ParsedOutput,
  nonce: Point
): { delegateKey: string; rewardAddress: string } | null {
  const predicateHex = output.predicateHex;
  if (
    predicateHex === null ||
    getPredicateType(predicateHex) !== BlsctPredicateType.BlsctDataPredicateType
  ) {
    return null;
  }
  const dataHex = parseDataPredicateData(predicateHex);
  if (!isStakeDelegationDataHex(dataHex)) {
    return null;
  }
  const { delegateKey, rewardAddress } = parseStakeDelegationOwnerInfo(dataHex, nonce);
  return { delegateKey: delegateKey.serialize(), rewardAddress };
}
