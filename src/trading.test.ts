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
    const res = await client.requestQuote({
      buyTokenId: TOKEN,
      sellTokenId: null,
      amount: 500n,
      expiry: 123,
    });
    expect(res).toEqual({ uuid: 'u1', replyKey: 'rk' });
    expect(calls[0]).toEqual([TOKEN, '', 500, 123]);
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
