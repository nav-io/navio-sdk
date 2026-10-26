import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROBE_HASH = 'ab'.repeat(32);
const parsed = {
  txid: '11'.repeat(32),
  wtxid: '22'.repeat(32),
  end: 4,
  outputs: [{ outputHash: PROBE_HASH, serializedHex: '00', keys: null }],
};

vi.mock('./p2p-block-parser', async importOriginal => ({
  ...(await importOriginal<typeof import('./p2p-block-parser')>()),
  parseTransaction: vi.fn(() => parsed),
}));

import { P2PSyncProvider } from './p2p-sync';

const RAW_TX = '00000000';

function providerWith(getOutputData: (...args: any[]) => Promise<Buffer>): P2PSyncProvider {
  const provider = new P2PSyncProvider({ host: '127.0.0.1', network: 'testnet' });
  (provider as any).client = { sendTransaction: vi.fn(), getOutputData: vi.fn(getOutputData) };
  return provider;
}

function servedAfter(notFoundCount: number) {
  let calls = 0;
  return async (_hash: Buffer, matches: (payload: Buffer) => boolean) => {
    calls += 1;
    if (calls <= notFoundCount) throw new Error(`Output not found: ${PROBE_HASH}`);
    matches(Buffer.from(RAW_TX, 'hex'));
    return Buffer.from(RAW_TX, 'hex');
  };
}

describe('P2PSyncProvider.broadcastTransaction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps asking while the node has not served the transaction to this peer yet', async () => {
    const provider = providerWith(servedAfter(6));
    const result = provider.broadcastTransaction(RAW_TX);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBe(parsed.txid);
    expect((provider as any).client.getOutputData).toHaveBeenCalledTimes(7);
  });

  it('reports a rejection once the confirmation window has passed', async () => {
    const provider = providerWith(servedAfter(Number.POSITIVE_INFINITY));
    const result = provider.broadcastTransaction(RAW_TX);
    const assertion = expect(result).rejects.toThrow("was not accepted by the node's mempool");
    await vi.advanceTimersByTimeAsync(29_000);
    expect((provider as any).client.getOutputData.mock.calls.length).toBeGreaterThan(20);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
  });

  it('does not retry other errors', async () => {
    const provider = providerWith(async () => {
      throw new Error('Request timeout');
    });
    await expect(provider.broadcastTransaction(RAW_TX)).rejects.toThrow(
      'could not be confirmed: Request timeout'
    );
    expect((provider as any).client.getOutputData).toHaveBeenCalledTimes(1);
  });
});
