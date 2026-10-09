import { describe, expect, it } from 'vitest';
import { parseTransaction } from './p2p-block-parser';
import { isStakedCommitmentOutput, isStakedCommitmentOutputHex } from './staking';
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
