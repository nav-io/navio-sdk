/**
 * Staking helpers that need no chain access.
 */

import { parseOutputHex, type ParsedOutput } from './p2p-block-parser';

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
