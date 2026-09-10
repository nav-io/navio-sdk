import { describe, it, expect } from 'vitest';
import { NavioClient } from './client';

const TOKEN = 'ab'.repeat(32);
const NAV_HASH = '0'.repeat(64);
const NO_SUBID = 'f'.repeat(16);

function makeClient(): NavioClient {
  return new NavioClient({
    backend: 'electrum',
    electrum: { host: 'localhost', port: 40001, ssl: false },
    network: 'testnet',
  });
}

function stubElectrum(client: NavioClient, stubs: Record<string, any>): void {
  (client as any).electrumClient = stubs;
}

describe('trading token normalization', () => {
  const toDaemonToken = (NavioClient as any).toDaemonToken as (t: string | null) => string;
  const fromDaemonToken = (NavioClient as any).fromDaemonToken as (t: string) => string | null;

  it('maps null (NAV) to the empty string', () => {
    expect(toDaemonToken(null)).toBe('');
  });

  it('maps the all-zero hash to the empty string', () => {
    expect(toDaemonToken(NAV_HASH)).toBe('');
  });

  it('passes a 64-hex token hash through', () => {
    expect(toDaemonToken(TOKEN)).toBe(TOKEN);
  });

  it('accepts an 80-hex token id with the default sub-id', () => {
    expect(toDaemonToken(TOKEN + NO_SUBID)).toBe(TOKEN);
  });

  it('rejects NFT token ids with a non-default sub-id', () => {
    expect(() => toDaemonToken(TOKEN + '0000000000000001')).toThrow(/NFT/);
  });

  it('rejects malformed token ids', () => {
    expect(() => toDaemonToken('abcd')).toThrow(/Invalid tokenId length/);
  });

  it('maps daemon results back to public token ids', () => {
    expect(fromDaemonToken(NAV_HASH)).toBeNull();
    expect(fromDaemonToken('')).toBeNull();
    expect(fromDaemonToken(TOKEN)).toBe(TOKEN);
  });
});

describe('requestQuote', () => {
  it('rejects non-positive amounts', async () => {
    const client = makeClient();
    await expect(
      client.requestQuote({ buyTokenId: TOKEN, sellTokenId: null, amount: 0n, expiry: 1 }),
    ).rejects.toThrow(/positive/);
  });

  it('proxies to the electrum RFQ bridge and maps the result', async () => {
    const client = makeClient();
    const calls: any[] = [];
    stubElectrum(client, {
      rfqRequestQuote: async (...args: any[]) => {
        calls.push(args);
        return { uuid: 'u1', reply_key: 'rk' };
      },
    });
    const expiry = Math.floor(Date.now() / 1000) + 300;
    const res = await client.requestQuote({
      buyTokenId: TOKEN,
      sellTokenId: null,
      amount: 500n,
      expiry,
    });
    expect(res).toEqual({ uuid: 'u1', replyKey: 'rk' });
    expect(calls[0]).toEqual([TOKEN, '', 500, expiry]);
  });

  it('rejects expiries that are not a future unix time in seconds', async () => {
    const client = makeClient();
    const base = { buyTokenId: TOKEN, sellTokenId: null, amount: 500n };
    // A duration (e.g. the collection window in minutes) instead of a timestamp.
    await expect(client.requestQuote({ ...base, expiry: 5 })).rejects.toThrow(/not a duration/);
    // Milliseconds instead of seconds.
    await expect(client.requestQuote({ ...base, expiry: Date.now() + 300_000 })).rejects.toThrow(/not milliseconds/);
    // Already elapsed.
    await expect(client.requestQuote({ ...base, expiry: Math.floor(Date.now() / 1000) - 60 })).rejects.toThrow(/in the past/);
  });
});

describe('listQuotes', () => {
  it('maps daemon quote fields to QuoteSummary', async () => {
    const client = makeClient();
    stubElectrum(client, {
      rfqListQuotes: async () => [
        { quote_id: 'q1', fill: 500, sell_cost: 50, price: 0.1, order_expiry: 999 },
      ],
    });
    const quotes = await client.listQuotes('u1');
    expect(quotes).toEqual([
      { quoteId: 'q1', fill: 500n, sellCost: 50n, price: 0.1, orderExpiry: 999 },
    ]);
  });
});

describe('acceptQuote slippage bounds', () => {
  const quote = { quote_id: 'q1', fill: 500, sell_cost: 50, price: 0.1, order_expiry: 999 };

  function clientWithQuote(): NavioClient {
    const client = makeClient();
    stubElectrum(client, { rfqListQuotes: async () => [quote] });
    return client;
  }

  it('rejects when the quote charges more than maxPay', async () => {
    await expect(
      clientWithQuote().acceptQuote({
        uuid: 'u1',
        quoteId: 'q1',
        buyTokenId: TOKEN,
        sellTokenId: null,
        maxPay: 49n,
        minRecv: 0n,
      }),
    ).rejects.toThrow(/exceeds maxPay/);
  });

  it('rejects when the quote delivers less than minRecv', async () => {
    await expect(
      clientWithQuote().acceptQuote({
        uuid: 'u1',
        quoteId: 'q1',
        buyTokenId: TOKEN,
        sellTokenId: null,
        maxPay: 50n,
        minRecv: 501n,
      }),
    ).rejects.toThrow(/below minRecv/);
  });

  it('rejects an unknown quote id', async () => {
    await expect(
      clientWithQuote().acceptQuote({
        uuid: 'u1',
        quoteId: 'nope',
        buyTokenId: TOKEN,
        sellTokenId: null,
        maxPay: 50n,
        minRecv: 0n,
      }),
    ).rejects.toThrow(/not found/);
  });

  it('requires both slippage bounds', async () => {
    await expect(
      clientWithQuote().acceptQuote({
        uuid: 'u1',
        quoteId: 'q1',
        buyTokenId: TOKEN,
        sellTokenId: null,
      } as any),
    ).rejects.toThrow(/slippage bounds/);
  });
});

describe('maker request mapping', () => {
  it('maps pending quote requests from daemon fields', async () => {
    const client = makeClient();
    stubElectrum(client, {
      swapPendingRequests: async () => [
        {
          uuid: 'u1',
          buy_token: TOKEN,
          sell_token: NAV_HASH,
          fill: 500,
          sell_cost: 50,
          reply_key: 'rk',
        },
      ],
    });
    const pending = await client.getPendingQuoteRequests();
    expect(pending).toEqual([
      {
        uuid: 'u1',
        buyTokenId: TOKEN,
        sellTokenId: null,
        fill: 500n,
        sellCost: 50n,
        replyKey: 'rk',
      },
    ]);
  });

  it('maps swap intents from daemon fields', async () => {
    const client = makeClient();
    stubElectrum(client, {
      swapListIntents: async () => [
        {
          id: 3,
          token_in: TOKEN,
          token_out: NAV_HASH,
          min_size: 100,
          max_size: 1000,
          price_min: 10000000,
          expiry: 999,
        },
      ],
    });
    const intents = await client.listSwapIntents();
    expect(intents).toEqual([
      {
        id: 3,
        tokenIn: TOKEN,
        tokenOut: null,
        minSize: 100n,
        maxSize: 1000n,
        priceMin: 10000000n,
        expiry: 999,
      },
    ]);
  });
});

describe('setSwapIntent validation', () => {
  it('rejects an inverted size band', async () => {
    const client = makeClient();
    await expect(
      client.setSwapIntent({
        tokenInId: TOKEN,
        tokenOutId: null,
        minSize: 10n,
        maxSize: 5n,
        priceMin: 1n,
        expiry: 1,
      }),
    ).rejects.toThrow(/size band/);
  });

  it('rejects a negative priceMin', async () => {
    const client = makeClient();
    await expect(
      client.setSwapIntent({
        tokenInId: TOKEN,
        tokenOutId: null,
        minSize: 1n,
        maxSize: 5n,
        priceMin: -1n,
        expiry: 1,
      }),
    ).rejects.toThrow(/priceMin/);
  });
});

describe('trading backend requirement', () => {
  it('fails without the electrum backend', async () => {
    const client = new NavioClient({
      backend: 'p2p',
      p2p: { host: 'localhost', port: 1 },
      network: 'testnet',
    } as any);
    await expect(client.listQuotes('u1')).rejects.toThrow(/electrum backend/);
  });
});

describe('broadcastOrder standing-order tracking', () => {
  const FUTURE = () => Math.floor(Date.now() / 1000) + 3600;

  function makeOrderClient(outputs: Array<{ outputHash: string; isSpent?: boolean }>) {
    const client = makeClient();
    const store = new Map<string, any>();
    const walletDB = {
      saveStandingOrder: vi.fn(async (row: any) => { store.set(row.localId, { ...row }); }),
      getStandingOrders: vi.fn(async () => [...store.values()]),
      deleteStandingOrder: vi.fn(async (id: string) => { store.delete(id); }),
      getAllOutputs: vi.fn(async () => outputs.map((o) => ({
        outputHash: o.outputHash, txHash: 't', outputIndex: 0, blockHeight: 5, amount: 1_000_000n, gamma: '01',
        memo: null, tokenId: null, blindingKey: '02', spendingKey: '03', isSpent: o.isSpent ?? false,
        spentTxHash: null, spentBlockHeight: null,
      }))),
    };
    (client as any).walletDB = walletDB;
    (client as any).initialized = true;
    // Coin selection under test: pick the first non-excluded output.
    const buildSwapHalf = vi.fn(async (params: { excludeUtxos?: Set<string> }) => {
      const pick = outputs.find((o) => !params.excludeUtxos?.has(o.outputHash));
      if (!pick) throw new Error('Insufficient funds');
      return { halfHex: 'aa', fee: 7n, spentInputs: [pick.outputHash] };
    });
    (client as any).buildSwapHalf = buildSwapHalf;
    return { client, store, walletDB, buildSwapHalf };
  }

  const order = (expiry = FUTURE()) => ({
    offerTokenId: null, offerAmount: 500n, wantTokenId: TOKEN, wantAmount: 50n, expiry,
  });

  it('records a live order and keeps its inputs out of the next order', async () => {
    const { client, store, buildSwapHalf } = makeOrderClient([{ outputHash: 'coin-a' }, { outputHash: 'coin-b' }]);
    let n = 0;
    stubElectrum(client, { swapBroadcastOrder: async () => `q${++n}` });

    const first = await client.broadcastOrder(order());
    expect(first).toMatchObject({ quoteId: 'q1', inputs: ['coin-a'], fee: 7n });
    expect(store.get(first.localId!)).toMatchObject({ quoteId: 'q1', status: 'live', inputs: ['coin-a'] });

    const second = await client.broadcastOrder(order());
    expect(second.inputs).toEqual(['coin-b']);
    expect([...buildSwapHalf.mock.calls[1][0].excludeUtxos]).toEqual(['coin-a']);

    const listed = await client.listStandingOrders();
    expect(listed.map((o) => [o.quoteId, o.status, o.inputs[0]])).toEqual([['q1', 'live', 'coin-a'], ['q2', 'live', 'coin-b']]);

    // Both coins committed: a third order has nothing left to offer.
    await expect(client.broadcastOrder(order())).rejects.toThrow(/Insufficient funds/);
  });

  it('keeps the reservation when the broadcast times out, releases it on other failures', async () => {
    const { client, store } = makeOrderClient([{ outputHash: 'coin-a' }, { outputHash: 'coin-b' }]);
    stubElectrum(client, { swapBroadcastOrder: async () => { throw new Error('Request timeout for method: blockchain.swap.broadcast_order'); } });
    await expect(client.broadcastOrder(order())).rejects.toThrow(/may still have published the order.*forgetStandingOrder/);
    expect([...store.values()]).toMatchObject([{ status: 'unconfirmed', quoteId: null, inputs: ['coin-a'] }]);

    stubElectrum(client, { swapBroadcastOrder: async () => { throw new Error('daemon error: order rejected'); } });
    await expect(client.broadcastOrder(order())).rejects.toThrow(/order rejected/);
    // The unconfirmed order still holds coin-a; the rejected attempt (coin-b) left no record.
    expect([...store.values()].map((r) => r.inputs[0])).toEqual(['coin-a']);

    const unconfirmed = [...store.keys()][0];
    expect(await client.forgetStandingOrder(unconfirmed)).toBe(true);
    expect(await client.forgetStandingOrder(unconfirmed)).toBe(false);
    expect(store.size).toBe(0);
  });

  it('drops expired orders and orders whose inputs were spent', async () => {
    const { client, store } = makeOrderClient([{ outputHash: 'coin-a', isSpent: true }, { outputHash: 'coin-b' }]);
    const base = {
      offerTokenId: null, offerAmount: '1', wantTokenId: TOKEN, wantAmount: '1', halfTxHex: 'aa', fee: '1',
      createdAt: 1, quoteId: 'q', status: 'live' as const,
    };
    store.set('spent', { ...base, localId: 'spent', inputs: ['coin-a'], expiry: FUTURE() });
    store.set('expired', { ...base, localId: 'expired', inputs: ['coin-b'], expiry: Math.floor(Date.now() / 1000) - 1 });
    store.set('ok', { ...base, localId: 'ok', inputs: ['coin-b'], expiry: FUTURE() });

    const live = await client.listStandingOrders();
    expect(live.map((o) => o.localId)).toEqual(['ok']);
    expect([...store.keys()]).toEqual(['ok']);
    expect(live[0].offerAmount).toBe(1n);
  });

  it('refuses a manual coin selection that is reserved by a standing order', async () => {
    const client = makeClient();
    (client as any).walletDB = {
      getStandingOrders: async () => [{ localId: 'x', quoteId: 'q', status: 'live', offerTokenId: null, offerAmount: '1', wantTokenId: TOKEN, wantAmount: '1', expiry: FUTURE(), inputs: ['coin-a'], halfTxHex: 'aa', fee: '1', createdAt: 1 }],
      deleteStandingOrder: async () => undefined,
      saveStandingOrder: async () => undefined,
      getAllOutputs: async () => [],
    };
    (client as any).initialized = true;
    // Real buildSwapHalf, but it must reject before touching keys or coins.
    (client as any).ensureSpendReady = async () => ({ keyManager: {}, walletDB: (client as any).walletDB });
    (client as any).getAllOutputs = async () => [{ outputHash: 'coin-a', txHash: 't', outputIndex: 0, blockHeight: 5, amount: 10n, gamma: '01', memo: null, tokenId: null, blindingKey: '02', spendingKey: '03', isSpent: false, spentTxHash: null, spentBlockHeight: null }];
    stubElectrum(client, { swapBroadcastOrder: async () => 'q' });
    await expect(client.broadcastOrder({ ...order(), selectedUtxos: ['coin-a'] })).rejects.toThrow(/reserved by one of this wallet's standing orders/);
  });
});
