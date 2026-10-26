import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { NavioClient } from './client';
import { WalletDB } from './wallet-db';
import type { StoreOutputParams } from './wallet-db.interface';

const TOKEN_COLLECTION = 'aa'.repeat(32);
const NFT_COLLECTION = '22'.repeat(32);
const NFT_TOKEN_ID = NFT_COLLECTION + '0100000000000000';

type Reply = 'answer' | 'refuse' | 'ignore';

/**
 * A stand-in Electrum server for `blockchain.token.get_token`. Each request
 * is answered from `registry`, refused with an Electrum error, or ignored,
 * per the next entry queued in `replies` for that token (default: answer).
 */
class MockRegistry {
  readonly server: WebSocketServer;
  readonly requests: string[] = [];
  readonly replies = new Map<string, Reply[]>();
  readonly registry = new Map<string, object>();
  private closed: Promise<void> | null = null;

  constructor() {
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.server.on('connection', socket => {
      socket.on('message', raw => {
        const request = JSON.parse(String(raw));
        if (request.method === 'server.version') {
          socket.send(JSON.stringify({ id: request.id, result: ['mock', '1.4'] }));
          return;
        }
        const tokenId: string = request.params[0];
        this.requests.push(tokenId);
        const reply = this.replies.get(tokenId)?.shift() ?? 'answer';
        if (reply === 'ignore') {
          return;
        }
        const body =
          reply === 'refuse' || !this.registry.has(tokenId)
            ? { error: { code: 1, message: 'unknown token' } }
            : { result: this.registry.get(tokenId) };
        // Reply a little later, as a real server would.
        setTimeout(() => socket.send(JSON.stringify({ id: request.id, ...body })), 20);
      });
    });
  }

  async port(): Promise<number> {
    if (!this.server.address()) {
      await new Promise(resolve => this.server.once('listening', resolve));
    }
    return (this.server.address() as AddressInfo).port;
  }

  close(): Promise<void> {
    if (!this.closed) {
      for (const socket of this.server.clients) {
        socket.terminate();
      }
      this.closed = new Promise(resolve => this.server.close(() => resolve()));
    }
    return this.closed;
  }
}

function record(kind: 'token' | 'nft', name: string, minted: Record<number, string> = {}) {
  return {
    publicKey: '01',
    type: kind,
    metadata: [{ key: 'name', value: name }],
    maxSupply: 1_000,
    mintedNft: Object.entries(minted).map(([index, nftName]) => ({
      index: Number(index),
      metadata: { name: nftName },
    })),
  };
}

function output(outputHash: string, tokenId: string): StoreOutputParams {
  return {
    outputHash,
    txHash: 'cc'.repeat(32),
    outputIndex: 0,
    blockHeight: 10,
    outputData: '',
    amount: 1,
    gamma: '01',
    memo: null,
    tokenId,
    blindingKey: '02',
    ephemeralKey: null,
    spendingKey: '03',
    isSpent: false,
    spentTxHash: null,
    spentBlockHeight: null,
    txType: 'received',
    timestamp: 0,
  };
}

describe('NavioClient asset metadata', () => {
  let registry: MockRegistry;
  let port: number;
  let walletDB: WalletDB;
  const clients: NavioClient[] = [];

  /** A freshly opened client over the shared wallet database. */
  async function openClient(timeout = 2_000): Promise<NavioClient> {
    const client = new NavioClient({
      network: 'testnet',
      backend: 'electrum',
      electrum: { host: '127.0.0.1', port, ssl: false, timeout },
      walletDbPath: ':memory:',
    });
    (client as any).walletDB = walletDB;
    clients.push(client);
    return client;
  }

  const names = (assets: { tokenId: string; metadata?: Record<string, string> }[]) =>
    Object.fromEntries(assets.map(asset => [asset.tokenId, asset.metadata?.name]));

  beforeEach(async () => {
    registry = new MockRegistry();
    registry.registry.set(TOKEN_COLLECTION, record('token', 'Token'));
    registry.registry.set(NFT_COLLECTION, record('nft', 'Collection', { 1: 'First' }));
    port = await registry.port();
    walletDB = new WalletDB({ type: 'better-sqlite3' });
    await walletDB.open(':memory:');
    await walletDB.storeWalletOutput(output('01'.repeat(32), TOKEN_COLLECTION));
    await walletDB.storeWalletOutput(output('02'.repeat(32), NFT_TOKEN_ID));
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const client of clients.splice(0)) {
      (client as any).electrumClient.disconnect();
    }
    await registry.close();
    await walletDB.close();
  });

  it('names every collection when tokens and NFTs load together', async () => {
    const client = await openClient();

    const [tokens, nfts] = await Promise.all([client.getTokenBalances(), client.getNftBalances()]);

    expect(names(tokens)).toEqual({ [TOKEN_COLLECTION]: 'Token' });
    expect(names(nfts)).toEqual({ [NFT_TOKEN_ID]: 'Collection' });
    expect(nfts[0].nftMetadata).toEqual({ name: 'First' });
    // Concurrent calls share each collection's lookup.
    expect(registry.requests.sort()).toEqual([NFT_COLLECTION, TOKEN_COLLECTION]);
  });

  it('shows stored names on the next open without asking the server', async () => {
    await (await openClient()).getAssetBalances();
    await registry.close();

    const reopened = await openClient();
    const assets = await reopened.getAssetBalances();

    expect(names(assets)).toEqual({ [TOKEN_COLLECTION]: 'Token', [NFT_TOKEN_ID]: 'Collection' });
    expect(registry.requests).toHaveLength(2);
  });

  it('serves stale NFT info at once and refreshes it behind the scenes', async () => {
    await walletDB.saveTokenRegistryEntry({
      publicTokenId: NFT_COLLECTION,
      kind: 'nft',
      metadata: { name: 'Collection' },
      totalSupply: '1000',
      mintedNft: {},
      fetchedAt: Date.now() - 60 * 60 * 1000,
    });
    const client = await openClient();

    const first = (await client.getNftBalances())[0];
    expect(first.metadata).toEqual({ name: 'Collection' });
    expect(first.nftMetadata).toBeUndefined();

    await vi.waitFor(async () => {
      const entry = await walletDB.getTokenRegistryEntry(NFT_COLLECTION);
      expect(entry?.mintedNft).toEqual({ '1': { name: 'First' } });
    });
    expect((await client.getNftBalances())[0].nftMetadata).toEqual({ name: 'First' });
  });

  it('keeps stale NFT info when the refresh gets a reply it cannot read', async () => {
    await walletDB.saveTokenRegistryEntry({
      publicTokenId: NFT_COLLECTION,
      kind: 'nft',
      metadata: { name: 'Collection' },
      totalSupply: '1000',
      mintedNft: {},
      fetchedAt: Date.now() - 60 * 60 * 1000,
    });
    registry.registry.set(NFT_COLLECTION, {
      ...record('nft', 'Collection'),
      metadata: { name: 1 },
    });
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const client = await openClient();

      expect(names(await client.getNftBalances())).toEqual({ [NFT_TOKEN_ID]: 'Collection' });
      const nftRequests = () => registry.requests.filter(id => id === NFT_COLLECTION);
      await vi.waitFor(() => expect(nftRequests()).toHaveLength(1));
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(rejections).toEqual([]);
      // The unreadable reply is remembered as a miss, not asked for again.
      expect(names(await client.getNftBalances())).toEqual({ [NFT_TOKEN_ID]: 'Collection' });
      expect(nftRequests()).toHaveLength(1);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('remembers a lookup whose reply cannot be read', async () => {
    registry.registry.set(TOKEN_COLLECTION, { ...record('token', 'Token'), maxSupply: 'lots' });
    const client = await openClient();

    expect(names(await client.getTokenBalances())).toEqual({ [TOKEN_COLLECTION]: undefined });
    expect(names(await client.getTokenBalances())).toEqual({ [TOKEN_COLLECTION]: undefined });
    expect(registry.requests.filter(id => id === TOKEN_COLLECTION)).toHaveLength(1);
  });

  it('asks again after a lookup that got no answer', async () => {
    registry.replies.set(TOKEN_COLLECTION, ['ignore']);
    const client = await openClient(200);

    expect(names(await client.getTokenBalances())).toEqual({ [TOKEN_COLLECTION]: undefined });
    expect(names(await client.getTokenBalances())).toEqual({ [TOKEN_COLLECTION]: 'Token' });
  });

  it('remembers a lookup the server refused', async () => {
    registry.replies.set(TOKEN_COLLECTION, ['refuse']);
    const client = await openClient();

    expect(names(await client.getTokenBalances())).toEqual({ [TOKEN_COLLECTION]: undefined });
    expect(names(await client.getTokenBalances())).toEqual({ [TOKEN_COLLECTION]: undefined });
    expect(registry.requests.filter(id => id === TOKEN_COLLECTION)).toHaveLength(1);
  });
});
