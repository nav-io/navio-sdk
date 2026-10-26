import { describe, it, expect, vi } from 'vitest';
import { NavioClient } from './client';

const TOKEN = 'ab'.repeat(32);
const NAV_HASH = '0'.repeat(64);
const NO_SUBID = 'f'.repeat(16);
const UUID = '12'.repeat(32);
const REPLY_KEY = 'a1'.repeat(48);

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
          uuid: UUID,
          buy_token: TOKEN,
          sell_token: NAV_HASH,
          fill: 500,
          sell_cost: 50,
          reply_key: REPLY_KEY,
        },
      ],
    });
    const pending = await client.getPendingQuoteRequests();
    expect(pending).toEqual([
      {
        uuid: UUID,
        buyTokenId: TOKEN,
        sellTokenId: null,
        fill: 500n,
        sellCost: 50n,
        replyKey: REPLY_KEY,
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

  describe('with a staked commitment in the wallet', () => {
    // Real buildSwapHalf over a wallet holding 100 spendable NAV and a large
    // staked commitment; selection must fail before any key material is used.
    function makeStakedClient() {
      const client = makeClient();
      (client as any).walletDB = {
        getStandingOrders: async () => [],
        deleteStandingOrder: async () => undefined,
        saveStandingOrder: async () => undefined,
      };
      (client as any).initialized = true;
      (client as any).ensureSpendReady = async () => ({
        keyManager: { getSubAddress: () => ({}) },
        walletDB: (client as any).walletDB,
      });
      (client as any).getChangeSubAddress = () => ({});
      const coin = (outputHash: string, amount: bigint, isStakedCommitment: boolean) => ({
        outputHash, txHash: 't', outputIndex: 0, blockHeight: 5, amount, gamma: '01', memo: null, tokenId: null,
        blindingKey: '02', spendingKey: '03', isSpent: false, spentTxHash: null, spentBlockHeight: null,
        isStakedCommitment,
      });
      (client as any).getAllOutputs = async () => [coin('coin-a', 100n, false), coin('staked', 1_000_000n, true)];
      stubElectrum(client, { swapBroadcastOrder: async () => 'q' });
      return client;
    }

    it('leaves it out of automatic selection', async () => {
      await expect(makeStakedClient().broadcastOrder(order())).rejects.toThrow(
        /Insufficient funds: need 500 of the pay token but only have 100/
      );
    });

    it('refuses it as a manual selection', async () => {
      await expect(
        makeStakedClient().broadcastOrder({ ...order(), selectedUtxos: ['staked'] })
      ).rejects.toThrow(/Selected UTXO not found or not spendable/);
    });
  });
});

describe('pending quote request validation', () => {
  const valid = { uuid: UUID, buy_token: TOKEN, sell_token: NAV_HASH, fill: 500, sell_cost: 50, reply_key: REPLY_KEY };

  it('drops malformed entries and keeps the rest', async () => {
    const client = makeClient();
    stubElectrum(client, {
      swapPendingRequests: async () => [
        { ...valid, uuid: 'u1' },
        { ...valid, buy_token: `${TOKEN}#0000000000000001` },
        { ...valid, sell_token: 'zz' },
        { ...valid, fill: 0 },
        { ...valid, sell_cost: -5 },
        { ...valid, fill: 1.5 },
        { ...valid, reply_key: 'rk' },
        { ...valid, reply_key: 'a1'.repeat(47) },
        { ...valid, buy_token: NAV_HASH },
        null,
        valid,
      ],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pending = await client.getPendingQuoteRequests();
    expect(warn).toHaveBeenCalledTimes(10);
    expect(warn.mock.calls[0][0]).toMatch(/Skipping malformed pending quote request: .*uuid/);
    warn.mockRestore();
    expect(pending).toEqual([
      { uuid: UUID, buyTokenId: TOKEN, sellTokenId: null, fill: 500n, sellCost: 50n, replyKey: REPLY_KEY },
    ]);
  });

  it('filters subscription notifications the same way', async () => {
    const client = makeClient();
    let notify: (pending: any[]) => void = () => undefined;
    stubElectrum(client, {
      subscribeSwapPendingRequests: async (cb: (pending: any[]) => void) => {
        notify = cb;
        return [{ ...valid, fill: 0 }];
      },
    });
    const seen: any[] = [];
    expect(await client.subscribePendingQuoteRequests((p) => seen.push(p))).toEqual([]);
    notify([{ ...valid, reply_key: 'rk' }, valid]);
    expect(seen).toEqual([[expect.objectContaining({ uuid: UUID, fill: 500n })]]);
  });
});

describe('replyQuote local intents', () => {
  const FUTURE = () => Math.floor(Date.now() / 1000) + 3600;
  const request = (over: Record<string, unknown> = {}) => ({
    uuid: UUID, buyTokenId: TOKEN, sellTokenId: null, fill: 500n, sellCost: 50n, replyKey: REPLY_KEY, ...over,
  }) as any;

  function makeMakerClient(standingOrders: any[] = []) {
    const client = makeClient();
    const intents = new Map<string, any>();
    const orders = new Map<string, any>(standingOrders.map((o) => [o.localId, o]));
    const walletDB = {
      saveSwapIntent: vi.fn(async (row: any) => { intents.set(row.localId, { ...row }); }),
      getSwapIntents: vi.fn(async () => [...intents.values()]),
      deleteSwapIntent: vi.fn(async (id: string) => { intents.delete(id); }),
      saveStandingOrder: vi.fn(async (row: any) => { orders.set(row.localId, { ...row }); }),
      getStandingOrders: vi.fn(async () => [...orders.values()]),
      deleteStandingOrder: vi.fn(async (id: string) => { orders.delete(id); }),
    };
    (client as any).walletDB = walletDB;
    (client as any).initialized = true;
    (client as any).getAllOutputs = async () => [];
    const buildSwapHalf = vi.fn(async () => ({ halfHex: 'aa', fee: 7n, spentInputs: ['coin-x'] }));
    (client as any).buildSwapHalf = buildSwapHalf;
    const sendQuote = vi.fn(async () => 'quote-1');
    let nextIntent = 0;
    stubElectrum(client, {
      swapSetIntent: vi.fn(async () => ++nextIntent),
      swapClearIntent: vi.fn(async () => true),
      swapSendQuote: sendQuote,
    });
    return { client, intents, walletDB, buildSwapHalf, sendQuote };
  }

  // Pay TOKEN, receive NAV, fills 100..1000 at >= 0.1 NAV per TOKEN.
  const intent = (over: Record<string, unknown> = {}) => ({
    tokenInId: TOKEN, tokenOutId: null, minSize: 100n, maxSize: 1000n, priceMin: 10_000_000n, expiry: FUTURE(), ...over,
  }) as any;

  it('refuses every request when the wallet set no intent', async () => {
    const { client, buildSwapHalf, sendQuote } = makeMakerClient();
    await expect(client.replyQuote({ request: request() })).rejects.toThrow(/no unexpired swap intent/);
    expect(buildSwapHalf).not.toHaveBeenCalled();
    expect(sendQuote).not.toHaveBeenCalled();
  });

  it('stores intents locally and answers a request within one', async () => {
    const { client, sendQuote } = makeMakerClient();
    const id = await client.setSwapIntent(intent());
    expect(await client.listLocalSwapIntents()).toEqual([
      expect.objectContaining({ intentId: id, tokenInId: TOKEN, tokenOutId: null, minSize: 100n, maxSize: 1000n, priceMin: 10_000_000n }),
    ]);
    const res = await client.replyQuote({ request: request() });
    expect(res.quoteId).toBe('quote-1');
    expect(sendQuote).toHaveBeenCalledTimes(1);
  });

  it('refuses the reverse direction of an intent', async () => {
    const { client, buildSwapHalf } = makeMakerClient();
    await client.setSwapIntent(intent());
    // The taker buys NAV and sells TOKEN: the maker would pay NAV, which no intent offers.
    await expect(
      client.replyQuote({ request: request({ buyTokenId: null, sellTokenId: TOKEN, fill: 500n, sellCost: 5000n }) }),
    ).rejects.toThrow(/token pair differs/);
    expect(buildSwapHalf).not.toHaveBeenCalled();
  });

  it('refuses fills outside the size band', async () => {
    const { client } = makeMakerClient();
    await client.setSwapIntent(intent());
    await expect(client.replyQuote({ request: request({ fill: 99n, sellCost: 10n }) })).rejects.toThrow(/outside \[100, 1000\]/);
    await expect(client.replyQuote({ request: request({ fill: 1001n, sellCost: 101n }) })).rejects.toThrow(/outside/);
  });

  it('checks the price floor exactly, like the daemon rounds it', async () => {
    const { client, sendQuote } = makeMakerClient();
    await client.setSwapIntent(intent());
    // 333 * 0.1 = 33.3: the daemon quotes ceil = 34; 33 is under the floor.
    await expect(client.replyQuote({ request: request({ fill: 333n, sellCost: 33n }) })).rejects.toThrow(/below priceMin/);
    await expect(client.replyQuote({ request: request({ fill: 333n, sellCost: 34n }) })).resolves.toMatchObject({ quoteId: 'quote-1' });
    // A server cutting the price to 1 sat is refused.
    await expect(client.replyQuote({ request: request({ sellCost: 1n }) })).rejects.toThrow(/below priceMin/);
    expect(sendQuote).toHaveBeenCalledTimes(1);
  });

  it('ignores expired intents', async () => {
    const { client, intents } = makeMakerClient();
    intents.set('old', {
      localId: 'old', intentId: 1, tokenInId: TOKEN, tokenOutId: null, minSize: '100', maxSize: '1000',
      priceMin: '10000000', expiry: Math.floor(Date.now() / 1000) - 1, createdAt: 1,
    });
    await expect(client.replyQuote({ request: request() })).rejects.toThrow(/no unexpired swap intent/);
    expect(intents.size).toBe(0);
  });

  it('stops answering once the intent is cleared', async () => {
    const { client } = makeMakerClient();
    const id = await client.setSwapIntent(intent());
    expect(await client.clearSwapIntent(id)).toBe(true);
    expect(await client.listLocalSwapIntents()).toEqual([]);
    await expect(client.replyQuote({ request: request() })).rejects.toThrow(/no unexpired swap intent/);
  });

  it('clears exactly the stored intent named by its localId', async () => {
    const { client, intents } = makeMakerClient();
    const id = await client.setSwapIntent(intent());
    // A row from another daemon (or before a daemon restart) under the same id.
    intents.set('other', { ...[...intents.values()][0], localId: 'other', createdAt: 0 });
    const mine = [...intents.values()].find((r) => r.localId !== 'other')!.localId;
    await client.clearSwapIntent(mine);
    expect([...intents.keys()]).toEqual(['other']);
    await expect(client.clearSwapIntent('nope')).rejects.toThrow(/not stored/);
    // By daemon id, only the newest stored intent under it is dropped.
    intents.set('newest', { ...intents.get('other'), localId: 'newest', intentId: id, createdAt: 9e9 });
    await client.clearSwapIntent(id);
    expect(intents.has('newest')).toBe(false);
    expect(intents.has('other')).toBe(true);
  });

  it('refuses a daemon result that is not an intent id', async () => {
    for (const bad of [Number.NaN, 'abc', '1.5', -1, null, { id: 1 }, 2 ** 60]) {
      const { client, intents } = makeMakerClient();
      (client as any).electrumClient.swapSetIntent = async () => bad;
      await expect(client.setSwapIntent(intent())).rejects.toThrow(/invalid swap intent id/);
      expect(intents.size).toBe(0);
    }
  });

  it('clears the daemon\'s copy when storing the intent fails', async () => {
    const { client, walletDB } = makeMakerClient();
    walletDB.saveSwapIntent.mockRejectedValueOnce(new Error('disk full'));
    await expect(client.setSwapIntent(intent())).rejects.toThrow(/disk full.*cleared it on the daemon/);
    expect((client as any).electrumClient.swapClearIntent).toHaveBeenCalledWith(1);
  });

  it('answers within explicit bounds without a local intent', async () => {
    const { client } = makeMakerClient();
    const bounds = { tokenInId: TOKEN, tokenOutId: null, minSize: 1n, maxSize: 500n, priceMin: 10_000_000n };
    await expect(client.replyQuote({ request: request(), bounds })).resolves.toMatchObject({ quoteId: 'quote-1' });
    await expect(client.replyQuote({ request: request({ sellCost: 49n }), bounds })).rejects.toThrow(/outside the given bounds/);
  });

  it('validates the request fields itself', async () => {
    const { client } = makeMakerClient();
    await client.setSwapIntent(intent());
    await expect(client.replyQuote({ request: request({ uuid: 'u1' }) })).rejects.toThrow(/uuid/);
    await expect(client.replyQuote({ request: request({ replyKey: 'rk' }) })).rejects.toThrow(/replyKey/);
    await expect(client.replyQuote({ request: request({ sellCost: 0n }) })).rejects.toThrow(/positive/);
  });

  it('skips coins reserved by live standing orders', async () => {
    const order = {
      localId: 'o1', quoteId: 'q', status: 'live', offerTokenId: null, offerAmount: '1', wantTokenId: TOKEN, wantAmount: '1',
      expiry: FUTURE(), inputs: ['coin-a'], halfTxHex: 'aa', fee: '1', createdAt: 1,
    };
    const { client, buildSwapHalf } = makeMakerClient([order]);
    await client.setSwapIntent(intent());
    await client.replyQuote({ request: request() });
    expect([...(buildSwapHalf.mock.calls[0] as any)[0].excludeUtxos]).toEqual(['coin-a']);
  });
});

describe('acceptQuote safety', () => {
  const now = () => Math.floor(Date.now() / 1000);
  const quote = (orderExpiry: number) => ({ quote_id: 'q1', fill: 500, sell_cost: 50, price: 0.1, order_expiry: orderExpiry });
  const accept = { uuid: 'u1', quoteId: 'q1', buyTokenId: TOKEN, sellTokenId: null, maxPay: 50n, minRecv: 500n };

  function makeTakerClient(orderExpiry: number, txId: unknown, standingInputs: string[] = []) {
    const client = makeClient();
    const markOutputSpent = vi.fn(async () => undefined);
    const walletDB = {
      markOutputSpent,
      getStandingOrders: async () => standingInputs.length === 0 ? [] : [{
        localId: 'o1', quoteId: 'q', status: 'live', offerTokenId: null, offerAmount: '1', wantTokenId: TOKEN,
        wantAmount: '1', expiry: now() + 3600, inputs: standingInputs, halfTxHex: 'aa', fee: '1', createdAt: 1,
      }],
      deleteStandingOrder: async () => undefined,
    };
    (client as any).walletDB = walletDB;
    (client as any).initialized = true;
    (client as any).getAllOutputs = async () => [];
    (client as any).ensureSpendReady = async () => ({ keyManager: {}, walletDB });
    const buildSwapHalf = vi.fn(async () => ({ halfHex: 'bb', fee: 0n, spentInputs: ['coin-t'] }));
    (client as any).buildSwapHalf = buildSwapHalf;
    const rfqAcceptQuote = vi.fn(async () => txId);
    stubElectrum(client, { rfqListQuotes: async () => [quote(orderExpiry)], rfqAcceptQuote });
    return { client, markOutputSpent, buildSwapHalf, rfqAcceptQuote };
  }

  it('refuses an expired quote before signing', async () => {
    const { client, buildSwapHalf, rfqAcceptQuote } = makeTakerClient(now() - 120, 'ab'.repeat(32));
    await expect(client.acceptQuote(accept)).rejects.toThrow(/expired/);
    expect(buildSwapHalf).not.toHaveBeenCalled();
    expect(rfqAcceptQuote).not.toHaveBeenCalled();
  });

  it('tolerates a few seconds of clock skew', async () => {
    const { client } = makeTakerClient(now() - 5, 'ab'.repeat(32));
    await expect(client.acceptQuote(accept)).resolves.toMatchObject({ txId: 'ab'.repeat(32) });
  });

  it('marks inputs spent under a valid txId', async () => {
    const { client, markOutputSpent } = makeTakerClient(now() + 600, 'AB'.repeat(32));
    const res = await client.acceptQuote(accept);
    expect(res.txId).toBe('ab'.repeat(32));
    expect(markOutputSpent).toHaveBeenCalledWith('coin-t', 'ab'.repeat(32), 0);
  });

  it('does not record a spend under a malformed txId', async () => {
    for (const bad of ['', 'not-a-txid', 'ab'.repeat(31), { txid: 'x' }, null]) {
      const { client, markOutputSpent } = makeTakerClient(now() + 600, bad);
      await expect(client.acceptQuote(accept)).rejects.toThrow(/invalid transaction id/);
      expect(markOutputSpent).not.toHaveBeenCalled();
    }
  });

  it('skips coins reserved by live standing orders', async () => {
    const { client, buildSwapHalf } = makeTakerClient(now() + 600, 'ab'.repeat(32), ['coin-a']);
    await client.acceptQuote(accept);
    expect([...(buildSwapHalf.mock.calls[0] as any)[0].excludeUtxos]).toEqual(['coin-a']);
  });
});

describe('broadcastOrder concurrent reservations', () => {
  it('never commits the same coin to two concurrent orders', async () => {
    const client = makeClient();
    const store = new Map<string, any>();
    (client as any).walletDB = {
      saveStandingOrder: async (row: any) => { store.set(row.localId, { ...row }); },
      getStandingOrders: async () => [...store.values()],
      deleteStandingOrder: async (id: string) => { store.delete(id); },
    };
    (client as any).initialized = true;
    (client as any).getAllOutputs = async () => [];
    const coins = ['coin-a', 'coin-b'];
    (client as any).buildSwapHalf = async (params: { excludeUtxos?: Set<string> }) => {
      // Selection takes a while (signing), leaving room for a racing call.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const pick = coins.find((c) => !params.excludeUtxos?.has(c));
      if (!pick) throw new Error('Insufficient funds');
      return { halfHex: 'aa', fee: 7n, spentInputs: [pick] };
    };
    let n = 0;
    stubElectrum(client, { swapBroadcastOrder: async () => `q${++n}` });
    const order = {
      offerTokenId: null, offerAmount: 500n, wantTokenId: TOKEN, wantAmount: 50n,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    };
    const [a, b] = await Promise.all([client.broadcastOrder(order), client.broadcastOrder(order)]);
    expect(new Set([...a.inputs, ...b.inputs])).toEqual(new Set(['coin-a', 'coin-b']));
  });
});

describe('acceptQuote input reservations', () => {
  const now = () => Math.floor(Date.now() / 1000);
  const accept = { uuid: 'u1', quoteId: 'q1', buyTokenId: TOKEN, sellTokenId: null, maxPay: 50n, minRecv: 500n };

  // Two coins; buildSwapHalf picks the first one neither excluded nor marked
  // spent, like real coin selection over the wallet DB.
  function makeRacingTakerClient(rfqAcceptQuote: (...args: any[]) => Promise<unknown>) {
    const client = makeClient();
    const spent = new Set<string>();
    const walletDB = {
      markOutputSpent: vi.fn(async (hash: string) => { spent.add(hash); }),
      getStandingOrders: async () => [],
      deleteStandingOrder: async () => undefined,
    };
    (client as any).walletDB = walletDB;
    (client as any).initialized = true;
    (client as any).getAllOutputs = async () => [];
    (client as any).ensureSpendReady = async () => ({ keyManager: {}, walletDB });
    const coins = ['coin-a', 'coin-b'];
    const buildSwapHalf = vi.fn(async (params: { excludeUtxos?: Set<string> }) => {
      const pick = coins.find((c) => !spent.has(c) && !params.excludeUtxos?.has(c));
      if (!pick) throw new Error('Insufficient funds');
      return { halfHex: pick, fee: 0n, spentInputs: [pick] };
    });
    (client as any).buildSwapHalf = buildSwapHalf;
    stubElectrum(client, {
      rfqListQuotes: async () => [{ quote_id: 'q1', fill: 500, sell_cost: 50, price: 0.1, order_expiry: now() + 600 }],
      rfqAcceptQuote,
    });
    return { client, walletDB };
  }

  it('never signs two concurrent accepts over the same coin', async () => {
    let n = 0;
    const rfqAcceptQuote = vi.fn(async () => {
      // The server takes a while to combine and broadcast.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return String(++n).repeat(64);
    });
    const { client } = makeRacingTakerClient(rfqAcceptQuote);
    const [a, b] = await Promise.all([client.acceptQuote(accept), client.acceptQuote(accept)]);
    expect(a.txId).not.toBe(b.txId);
    // halfHex is the coin the half spends.
    expect(new Set(rfqAcceptQuote.mock.calls.map((c: any[]) => c[2]))).toEqual(new Set(['coin-a', 'coin-b']));
    expect([...(client as any).reservedQuoteInputs()]).toEqual([]);
  });

  it('releases the reservation when the submission fails', async () => {
    const rfqAcceptQuote = vi.fn(async (..._args: any[]) => { throw new Error('quote no longer available'); });
    const { client } = makeRacingTakerClient(rfqAcceptQuote);
    await expect(client.acceptQuote(accept)).rejects.toThrow(/no longer available/);
    await expect(client.acceptQuote(accept)).rejects.toThrow(/no longer available/);
    // Both attempts signed over coin-a: the failed one did not keep it.
    expect(rfqAcceptQuote.mock.calls.map((c: any[]) => c[2])).toEqual(['coin-a', 'coin-a']);
  });
});

describe('replyQuote input reservations', () => {
  const now = () => Math.floor(Date.now() / 1000);
  const request = { uuid: UUID, buyTokenId: TOKEN, sellTokenId: null, fill: 500n, sellCost: 50n, replyKey: REPLY_KEY } as any;
  const bounds = { tokenInId: TOKEN, tokenOutId: null, minSize: 1n, maxSize: 1000n, priceMin: 10_000_000n };

  function makeReplyClient(swapSendQuote: (...args: any[]) => Promise<unknown>) {
    const client = makeClient();
    const store = new Map<string, any>();
    (client as any).walletDB = {
      saveStandingOrder: async (row: any) => { store.set(row.localId, { ...row }); },
      getStandingOrders: async () => [...store.values()],
      deleteStandingOrder: async (id: string) => { store.delete(id); },
    };
    (client as any).initialized = true;
    (client as any).getAllOutputs = async () => [];
    const coins = ['coin-a', 'coin-b'];
    const buildSwapHalf = vi.fn(async (params: { excludeUtxos?: Set<string> }) => {
      const pick = coins.find((c) => !params.excludeUtxos?.has(c));
      if (!pick) throw new Error('Insufficient funds');
      return { halfHex: 'aa', fee: 7n, spentInputs: [pick] };
    });
    (client as any).buildSwapHalf = buildSwapHalf;
    stubElectrum(client, { swapSendQuote, swapBroadcastOrder: async () => 'order-1' });
    return { client, buildSwapHalf };
  }

  const order = () => ({ offerTokenId: TOKEN, offerAmount: 500n, wantTokenId: null, wantAmount: 50n, expiry: now() + 3600 });

  it('keeps a sent quote\'s coins out of a later broadcastOrder until it expires', async () => {
    const { client } = makeReplyClient(async () => 'quote-1');
    const quote = await client.replyQuote({ request, bounds, orderExpiry: now() + 600 });
    expect(quote.inputs).toEqual(['coin-a']);
    const standing = await client.broadcastOrder(order());
    expect(standing.inputs).toEqual(['coin-b']);
    // Not even with reserveInputs: false, which only ignores other standing orders.
    await expect(client.broadcastOrder({ ...order(), reserveInputs: false })).resolves.toMatchObject({ inputs: ['coin-b'] });
    await expect(client.replyQuote({ request, bounds })).rejects.toThrow(/Insufficient funds/);
  });

  it('releases the coins once the quote (plus skew) has expired', async () => {
    const { client } = makeReplyClient(async () => 'quote-1');
    await client.replyQuote({ request, bounds, orderExpiry: now() - 31 });
    await expect(client.replyQuote({ request, bounds })).resolves.toMatchObject({ inputs: ['coin-a'] });
  });

  it('releases the coins when the quote was not sent, keeps them on a timeout', async () => {
    let fail: Error = new Error('daemon error: unknown request');
    const { client } = makeReplyClient(async () => { throw fail; });
    await expect(client.replyQuote({ request, bounds })).rejects.toThrow(/unknown request/);
    expect([...(client as any).reservedQuoteInputs()]).toEqual([]);
    fail = new Error('Request timeout for method: blockchain.swap.send_quote');
    await expect(client.replyQuote({ request, bounds })).rejects.toThrow(/timeout/);
    expect([...(client as any).reservedQuoteInputs()]).toEqual(['coin-a']);
  });

  it('refuses a manual selection of a sent quote\'s coin', async () => {
    const client = makeClient();
    (client as any).walletDB = { getStandingOrders: async () => [], deleteStandingOrder: async () => undefined };
    (client as any).initialized = true;
    (client as any).ensureSpendReady = async () => ({ keyManager: {}, walletDB: (client as any).walletDB });
    (client as any).getAllOutputs = async () => [];
    (client as any).reserveSwapInputs(['coin-a'], now() + 600);
    stubElectrum(client, { swapBroadcastOrder: async () => 'q' });
    await expect(client.broadcastOrder({ ...order(), selectedUtxos: ['coin-a'] })).rejects.toThrow(/sent quotes/);
  });
});

describe('sendTransactionExcluding', () => {
  it('never picks an excluded NAV coin to pay a token send\'s fee', async () => {
    const client = makeClient();
    const coin = (outputHash: string, tokenId: string | null, amount: bigint) => ({
      outputHash, txHash: 't', outputIndex: 0, blockHeight: 5, amount, gamma: '01', memo: null, tokenId,
      blindingKey: '02', spendingKey: '03', isSpent: false, spentTxHash: null, spentBlockHeight: null,
      isStakedCommitment: false,
    });
    (client as any).initialized = true;
    (client as any).ensureSpendReady = async () => ({ keyManager: {}, walletDB: {} });
    (client as any).decodeDestinationAddress = () => ({});
    (client as any).getAllOutputs = async () => [coin('tok-a', TOKEN, 500n), coin('nav-reserved', null, 300_000n)];
    await expect(
      (client as any).sendTransactionExcluding(
        { address: 'x', amount: 500n, tokenId: TOKEN, selectedUtxos: ['tok-a'] },
        new Set(['nav-reserved']),
      ),
    ).rejects.toThrow(/No unspent NAV outputs available to fund the transaction fee/);
  });
});

describe('cancelSwapHalf', () => {
  const FUTURE = () => Math.floor(Date.now() / 1000) + 3600;
  const coin = (outputHash: string, tokenId: string | null, amount: bigint, extra: Record<string, unknown> = {}) => ({
    outputHash, txHash: 't', outputIndex: 0, blockHeight: 5, amount, gamma: '01', memo: null, tokenId,
    blindingKey: '02', spendingKey: '03', isSpent: false, spentTxHash: null, spentBlockHeight: null, ...extra,
  });

  function makeCancelClient(outputs: any[], orders: any[] = []) {
    const client = makeClient();
    const store = new Map<string, any>(orders.map((o) => [o.localId, o]));
    const walletDB = {
      getStandingOrders: async () => [...store.values()],
      deleteStandingOrder: async (id: string) => { store.delete(id); },
      saveStandingOrder: async () => undefined,
    };
    (client as any).walletDB = walletDB;
    (client as any).initialized = true;
    (client as any).ensureSpendReady = async () => ({
      keyManager: { getSubAddressBech32m: () => 'tnv1self' },
      walletDB,
    });
    (client as any).getAllOutputs = async () => outputs;
    const sendTransaction = vi.fn(async (_options: any, _exclude: Set<string>) => ({ txId: 'cd'.repeat(32), rawTx: '00', fee: 9n, inputCount: 1, outputCount: 2 }));
    (client as any).sendTransactionExcluding = sendTransaction;
    return { client, store, sendTransaction };
  }

  const orderRow = (inputs: string[]) => ({
    localId: 'o1', quoteId: 'q1', status: 'live', offerTokenId: TOKEN, offerAmount: '500', wantTokenId: null,
    wantAmount: '50', expiry: FUTURE(), inputs, halfTxHex: 'aa', fee: '7', createdAt: 1,
  });

  it('sweeps a standing order\'s NAV inputs back to the wallet and drops the order', async () => {
    const { client, store, sendTransaction } = makeCancelClient(
      [coin('tok-a', TOKEN, 500n), coin('nav-a', null, 300_000n), coin('nav-b', null, 200_000n)],
      [orderRow(['tok-a', 'nav-a', 'nav-b'])],
    );
    const res = await client.cancelSwapHalf({ orderId: 'q1' });
    expect(res).toEqual({ txId: 'cd'.repeat(32), fee: 9n, spentInputs: ['nav-a', 'nav-b'] });
    expect(sendTransaction).toHaveBeenCalledWith({
      address: 'tnv1self', amount: 500_000n, subtractFeeFromAmount: true, tokenId: null, selectedUtxos: ['nav-a', 'nav-b'],
    }, new Set());
    expect(store.size).toBe(0);
  });

  it('spends token inputs when the half has no NAV input', async () => {
    const { client, sendTransaction } = makeCancelClient([coin('tok-a', TOKEN, 500n)]);
    await client.cancelSwapHalf({ inputs: ['tok-a'] });
    expect(sendTransaction).toHaveBeenCalledWith({
      address: 'tnv1self', amount: 500n, subtractFeeFromAmount: false, tokenId: TOKEN, selectedUtxos: ['tok-a'],
    }, new Set());
  });

  it('keeps other halves\' coins out of the NAV fee selection', async () => {
    const other = { ...orderRow(['nav-other']), localId: 'o2', quoteId: 'q2' };
    const { client, sendTransaction } = makeCancelClient(
      [coin('tok-a', TOKEN, 500n), coin('nav-other', null, 300_000n), coin('nav-quote', null, 300_000n), coin('nav-free', null, 300_000n)],
      [orderRow(['tok-a']), other],
    );
    (client as any).reserveSwapInputs(['nav-quote'], Math.floor(Date.now() / 1000) + 600);
    await client.cancelSwapHalf({ orderId: 'q1' });
    // The half's own input is spent explicitly; the other order's and the
    // open quote's coins must not pay the fee.
    expect(sendTransaction.mock.calls[0][1]).toEqual(new Set(['nav-other', 'nav-quote']));
  });

  it('runs under the trading lock', async () => {
    const { client, sendTransaction } = makeCancelClient([coin('nav-a', null, 300_000n)]);
    const order: string[] = [];
    let release!: () => void;
    const held = (client as any).withTradingLock(() => new Promise<void>((resolve) => {
      release = () => { order.push('lock released'); resolve(); };
    }));
    sendTransaction.mockImplementation(async () => {
      order.push('cancel sends');
      return { txId: 'cd'.repeat(32), rawTx: '00', fee: 9n, inputCount: 1, outputCount: 2 };
    });
    const cancel = client.cancelSwapHalf({ inputs: ['nav-a'] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await Promise.all([held, cancel]);
    expect(order).toEqual(['lock released', 'cancel sends']);
  });

  it('releases a sent quote\'s reserved coins', async () => {
    const { client } = makeCancelClient([coin('nav-a', null, 300_000n), coin('tok-b', TOKEN, 5n)]);
    (client as any).reserveSwapInputs(['nav-a', 'tok-b'], Math.floor(Date.now() / 1000) + 600);
    await client.cancelSwapHalf({ inputs: ['nav-a', 'tok-b'] });
    expect([...(client as any).reservedQuoteInputs()]).toEqual([]);
  });

  it('refuses inputs that are already spent or unknown', async () => {
    const { client, sendTransaction } = makeCancelClient([
      coin('nav-a', null, 300_000n, { isSpent: true, spentTxHash: 'ef'.repeat(32) }),
    ]);
    await expect(client.cancelSwapHalf({ inputs: ['nav-a'] })).rejects.toThrow(/already spent/);
    await expect(client.cancelSwapHalf({ inputs: ['nope'] })).rejects.toThrow(/not a confirmed coin/);
    await expect(client.cancelSwapHalf({ orderId: 'missing' })).rejects.toThrow(/not tracked/);
    await expect(client.cancelSwapHalf({ inputs: [] })).rejects.toThrow(/needs/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});
