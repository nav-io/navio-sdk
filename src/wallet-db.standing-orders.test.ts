import { afterEach, describe, expect, it } from 'vitest';
import { WalletDB } from './wallet-db';

describe('WalletDB standing orders', () => {
  let walletDB: WalletDB | null = null;
  afterEach(async () => { if (walletDB) { await walletDB.close(); walletDB = null; } });

  it('round-trips, replaces by localId, and deletes', async () => {
    walletDB = new WalletDB({ type: 'better-sqlite3' });
    await walletDB.open(':memory:');
    const row = {
      localId: 'l1', quoteId: null, status: 'unconfirmed' as const,
      offerTokenId: null, offerAmount: '500', wantTokenId: 'ab'.repeat(32), wantAmount: '50',
      expiry: 2_000_000_000, inputs: ['11'.repeat(32), '22'.repeat(32)], halfTxHex: 'aa', fee: '7', createdAt: 1_700_000_000,
    };
    await walletDB.saveStandingOrder(row);
    expect(await walletDB.getStandingOrders()).toEqual([row]);
    await walletDB.saveStandingOrder({ ...row, quoteId: 'q1', status: 'live' });
    expect((await walletDB.getStandingOrders()).map((r) => [r.quoteId, r.status])).toEqual([['q1', 'live']]);
    await walletDB.deleteStandingOrder('l1');
    expect(await walletDB.getStandingOrders()).toEqual([]);
  });
});

describe('WalletDB swap intents', () => {
  let walletDB: WalletDB | null = null;
  afterEach(async () => { if (walletDB) { await walletDB.close(); walletDB = null; } });

  it('round-trips, replaces by localId, and deletes', async () => {
    walletDB = new WalletDB({ type: 'better-sqlite3' });
    await walletDB.open(':memory:');
    const row = {
      localId: 'i1', intentId: 3, tokenInId: 'ab'.repeat(32), tokenOutId: null,
      minSize: '100', maxSize: '9007199254740993', priceMin: '10000000', expiry: 2_000_000_000, createdAt: 1_700_000_000,
    };
    await walletDB.saveSwapIntent(row);
    await walletDB.saveSwapIntent({ ...row, localId: 'i2', intentId: 4, tokenInId: null, tokenOutId: 'cd'.repeat(32), createdAt: 1_700_000_001 });
    expect(await walletDB.getSwapIntents()).toEqual([
      row,
      { ...row, localId: 'i2', intentId: 4, tokenInId: null, tokenOutId: 'cd'.repeat(32), createdAt: 1_700_000_001 },
    ]);
    await walletDB.saveSwapIntent({ ...row, priceMin: '20000000' });
    expect((await walletDB.getSwapIntents()).map((r) => [r.localId, r.priceMin])).toEqual([['i1', '20000000'], ['i2', '10000000']]);
    await walletDB.deleteSwapIntent('i1');
    expect((await walletDB.getSwapIntents()).map((r) => r.localId)).toEqual(['i2']);
  });
});
