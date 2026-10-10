import { describe, expect, it } from 'vitest';
import { Point } from '@nav-io/navio-blsct';
import { parseTransaction } from './p2p-block-parser';
import {
  isStakedCommitmentOutput,
  isStakedCommitmentOutputHex,
  recoverStakeDelegation,
} from './staking';
import { STAKED_TX_HEX } from './test-fixtures/staked-tx';

describe('isStakedCommitmentOutput', () => {
  const outputs = parseTransaction(Buffer.from(STAKED_TX_HEX, 'hex')).outputs;

  it('recognises the staked commitment and nothing else', () => {
    expect(outputs.map(isStakedCommitmentOutput)).toEqual(
      outputs.map(o => o.scriptPubKeyHex.startsWith('b94d'))
    );
    expect(outputs.filter(isStakedCommitmentOutput)).toHaveLength(1);
  });

  it('refuses a staked script on a token output', () => {
    const staked = outputs.find(isStakedCommitmentOutput)!;
    expect(isStakedCommitmentOutput({ ...staked, tokenIdHex: 'aa'.repeat(40) })).toBe(false);
  });

  it('reads serialized outputs, and calls unreadable ones not staked', () => {
    expect(outputs.map(o => isStakedCommitmentOutputHex(o.serializedHex))).toEqual(
      outputs.map(isStakedCommitmentOutput)
    );
    expect(isStakedCommitmentOutputHex('')).toBe(false);
    expect(isStakedCommitmentOutputHex('zz')).toBe(false);
    expect(isStakedCommitmentOutputHex(outputs[0].serializedHex.slice(0, 40))).toBe(false);
  });
});

describe('recoverStakeDelegation', () => {
  const outputs = parseTransaction(Buffer.from(STAKED_TX_HEX, 'hex')).outputs;

  it('finds no delegation on an output without a DATA predicate', () => {
    const fee = outputs.find(o => o.predicateHex !== null && !isStakedCommitmentOutput(o))!;
    expect(recoverStakeDelegation(fee, Point.random())).toBeNull();
    expect(recoverStakeDelegation({ ...fee, predicateHex: null }, Point.random())).toBeNull();
  });

  it('refuses a nonce that does not open the payload', () => {
    const staked = outputs.find(isStakedCommitmentOutput)!;
    expect(() => recoverStakeDelegation(staked, Point.random())).toThrow();
  });
});
