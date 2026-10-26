/**
 * Network-free tests for P2PSyncProvider's header chain and block request
 * bookkeeping. A simulated node answers getheaders the way navio-core does:
 * from the first locator hash on its active chain, up to 2000 headers.
 */

import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { P2PSyncProvider } from './p2p-sync';
import { MAX_HEADERS_RESULTS, P2PClient } from './p2p-protocol';

function displayHash(header: Buffer): string {
  return Buffer.from(sha256(sha256(header)))
    .reverse()
    .toString('hex');
}

/** An 80-byte header on `branch` at `height`, child of `prevDisplayHash`. */
function makeHeader(prevDisplayHash: string, height: number, branch: number): Buffer {
  const header = Buffer.alloc(80);
  header.writeInt32LE(0x20000000, 0);
  P2PClient.hashFromDisplay(prevDisplayHash).copy(header, 4);
  header.fill(branch, 36, 68); // merkle root stands in for the branch's contents
  header.writeUInt32LE(1_700_000_000 + height * 120, 68);
  header.writeUInt32LE(0x207fffff, 72);
  header.writeUInt32LE(height, 76);
  return header;
}

const GENESIS_HASH = 'ab'.repeat(32);

/**
 * Headers of a chain from height 1 to `tip`: `base`'s headers up to
 * `forkHeight`, then new ones on `branch`.
 */
function chain(base: Buffer[], forkHeight: number, tip: number, branch: number): Buffer[] {
  const headers = base.slice(0, forkHeight + 1);
  for (let h = forkHeight + 1; h <= tip; h++) {
    const prev = h === 1 ? GENESIS_HASH : displayHash(headers[h - 1]);
    headers[h] = makeHeader(prev, h, branch);
  }
  return headers;
}

/** A node whose active chain the test replaces to simulate reorgs. */
class SimulatedNode {
  active: Buffer[] = [];

  getHeaders(locator: Buffer[]): Buffer[] {
    const heightOf = new Map<string, number>([[GENESIS_HASH, 0]]);
    for (let h = 1; h < this.active.length; h++) heightOf.set(displayHash(this.active[h]), h);

    let from = 0;
    for (const hash of locator) {
      const height = heightOf.get(P2PClient.hashToDisplay(hash));
      if (height !== undefined) {
        from = height;
        break;
      }
    }
    return this.active.slice(from + 1, from + 1 + MAX_HEADERS_RESULTS);
  }
}

function providerOn(node: SimulatedNode): P2PSyncProvider {
  const provider = new P2PSyncProvider({ host: '127.0.0.1', network: 'regtest' });
  (provider as any).client = {
    getHeaders: async (locator: Buffer[]) => node.getHeaders(locator),
    isConnected: () => true,
    disconnect: () => undefined,
  };
  return provider;
}

async function syncHeaders(provider: P2PSyncProvider): Promise<void> {
  await (provider as any).syncHeaders();
}

/** Whether the provider's header cache holds exactly `headers` (heights 1..tip). */
function expectHeaderChain(provider: P2PSyncProvider, headers: Buffer[]): void {
  const tip = headers.length - 1;
  const byHeight: Map<number, { hash: string }> = (provider as any).headersByHeight;
  const byHash: Map<string, { height: number }> = (provider as any).headersByHash;

  expect((provider as any).chainTipHeight).toBe(tip);
  expect((provider as any).chainTipHash).toBe(displayHash(headers[tip]));
  for (let h = 1; h <= tip; h++) {
    expect(byHeight.get(h)?.hash, `height ${h}`).toBe(displayHash(headers[h]));
  }
  // Nothing beyond the tip, and no hash of an orphaned header
  expect([...byHeight.keys()].filter(h => h > tip)).toEqual([]);
  expect(byHash.size).toBe(tip);
  for (const [hash, header] of byHash) {
    expect(hash).toBe(displayHash(headers[header.height]));
  }
}

describe('P2PSyncProvider header reorgs', () => {
  const chainA = chain([], 0, 50, 0xa);

  it('follows a 20-block reorg to a shorter branch the node answers from below the fork', async () => {
    const node = new SimulatedNode();
    node.active = chainA;
    const provider = providerOn(node);
    await syncHeaders(provider);
    expectHeaderChain(provider, chainA);

    // The sparse part of our locator puts the node's common block at 27,
    // below the fork at 30: the reply opens with headers we already hold.
    const chainB = chain(chainA, 30, 45, 0xb);
    node.active = chainB;
    await syncHeaders(provider);

    expectHeaderChain(provider, chainB);
    const above = await provider.getBlockHeaders(46, 5);
    expect(above.count).toBe(0);
  });

  it('follows a reorg away from a branch and back to the original one', async () => {
    const node = new SimulatedNode();
    node.active = chainA;
    const provider = providerOn(node);
    await syncHeaders(provider);

    node.active = chain(chainA, 30, 60, 0xb);
    await syncHeaders(provider);
    expectHeaderChain(provider, node.active);

    // The original branch overtakes again. Its headers 31..50 were orphaned
    // above; treating them as still known would leave heights 31..50 on the
    // dead branch under a tip on the live one.
    const chainA2 = chain(chainA, 50, 70, 0xc);
    node.active = chainA2;
    await syncHeaders(provider);

    expectHeaderChain(provider, chainA2);
  });

  it('follows a reorg whose fork is more than a full reply above the common locator block', async () => {
    const longA = chain([], 0, 12_000, 0xa);
    const node = new SimulatedNode();
    node.active = longA;
    const provider = providerOn(node);
    await syncHeaders(provider);
    expectHeaderChain(provider, longA);

    // From tip 12000 the locator holds heights ..., 9945, 7897, ...: with
    // the fork at 9944 the node answers from 7897, and its first full reply
    // (7898..9897) holds only headers we already have.
    const longB = chain(longA, 9944, 12_100, 0xb);
    node.active = longB;
    await syncHeaders(provider);

    expectHeaderChain(provider, longB);
  });

  it('replaces the tip on a one-block reorg', async () => {
    const node = new SimulatedNode();
    node.active = chainA;
    const provider = providerOn(node);
    await syncHeaders(provider);

    const chainB = chain(chainA, 49, 50, 0xb);
    node.active = chainB;
    await syncHeaders(provider);

    expectHeaderChain(provider, chainB);
  });

  it('chains a reorg inside one batch of headers', () => {
    const provider = providerOn(new SimulatedNode());
    const chainB = chain(chainA, 30, 55, 0xb);
    (provider as any).processHeaders(chainA.slice(1));
    // One reply that repeats 25..30 (known), then the new branch
    (provider as any).processHeaders(chainB.slice(25));

    expectHeaderChain(provider, chainB);
  });
});

describe('P2PSyncProvider block requests', () => {
  function blockProvider(): {
    provider: P2PSyncProvider;
    rejectInFlight: (err: Error) => void;
    requested: string[];
  } {
    const provider = new P2PSyncProvider({
      host: '127.0.0.1',
      network: 'regtest',
      maxConcurrentBlockRequests: 1,
    });
    const requested: string[] = [];
    const inFlight: Array<(err: Error) => void> = [];
    (provider as any).client = {
      getBlock: (hash: Buffer) => {
        requested.push(P2PClient.hashToDisplay(hash));
        return new Promise((_resolve, reject) => inFlight.push(reject));
      },
      isConnected: () => true,
      disconnect: () => undefined,
    };
    return {
      provider,
      rejectInFlight: (err: Error) => inFlight.splice(0).forEach(reject => reject(err)),
      requested,
    };
  }

  const settledWithin = <T>(promise: Promise<T>, ms: number) =>
    Promise.race([
      promise.then(
        () => 'resolved',
        (e: Error) => e.message
      ),
      new Promise<string>(resolve => setTimeout(() => resolve('pending'), ms)),
    ]);

  it('rejects requests still queued for a slot on disconnect', async () => {
    const { provider, rejectInFlight } = blockProvider();
    const first = (provider as any).fetchBlock('01'.repeat(32)) as Promise<unknown>;
    const queued = (provider as any).fetchBlock('02'.repeat(32)) as Promise<unknown>;
    first.catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 0)); // first is on the wire

    provider.disconnect();
    // The real client fails its in-flight requests when it disconnects.
    rejectInFlight(new Error('Disconnected'));

    expect(await settledWithin(queued, 50)).toBe('Not connected');
    expect(await settledWithin(first, 50)).toBe('Disconnected');
  });

  it('keeps the slot count at zero after a disconnect, so later requests still run', async () => {
    const { provider, rejectInFlight, requested } = blockProvider();
    const first = (provider as any).fetchBlock('01'.repeat(32)) as Promise<unknown>;
    first.catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 0)); // first is on the wire

    provider.disconnect();
    rejectInFlight(new Error('Disconnected'));
    await settledWithin(first, 50);
    expect((provider as any).activeBlockRequests).toBe(0);

    // With the count at -1 the limit of 1 would admit two requests at once.
    const a = (provider as any).fetchBlock('03'.repeat(32)) as Promise<unknown>;
    const b = (provider as any).fetchBlock('04'.repeat(32)) as Promise<unknown>;
    a.catch(() => undefined);
    b.catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(requested).toEqual(['01'.repeat(32), '03'.repeat(32)]);
    expect((provider as any).activeBlockRequests).toBe(1);

    provider.disconnect();
    rejectInFlight(new Error('Disconnected'));
  });
});
