import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexedDBWalletDB } from './adapters/indexeddb-wallet-db';
import { WalletDB } from './wallet-db';
import type { IWalletDB, StoreOutputParams } from './wallet-db.interface';

const IDB_PATH = 'pending-spends';

function output(outputHash: string, txHash: string, blockHeight: number): StoreOutputParams {
  return {
    outputHash,
    txHash,
    outputIndex: 0,
    blockHeight,
    outputData: '',
    amount: 1_000,
    gamma: '01',
    memo: null,
    tokenId: null,
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

const backends: Array<[string, () => Promise<IWalletDB>, () => Promise<void>]> = [
  [
    'WalletDB',
    async () => {
      const db = new WalletDB({ type: 'better-sqlite3' });
      await db.open(':memory:');
      return db as unknown as IWalletDB;
    },
    async () => undefined,
  ],
  [
    'IndexedDBWalletDB',
    async () => {
      const db = new IndexedDBWalletDB();
      await db.open(IDB_PATH);
      return db;
    },
    () => IndexedDBWalletDB.deleteDatabase(IDB_PATH),
  ],
];

describe.each(backends)('%s pending spends', (_name, openDb, cleanup) => {
  let db: IWalletDB;

  beforeEach(async () => {
    db = await openDb();
    // Two confirmed outputs spent by the stuck tx, one by another pending tx,
    // one spent in a block; plus the stuck tx's and the other tx's mempool rows.
    for (const hash of ['a1', 'a2', 'b1', 'c1']) {
      await db.storeWalletOutput(output(hash, `funding-${hash}`, 10));
    }
    await db.storeWalletOutput(output('mempool:stuck:0', 'stuck', 0));
    await db.storeWalletOutput(output('mempool:other:0', 'other', 0));
  });

  afterEach(async () => {
    await db.close();
    await cleanup();
  });

  it('records when an output was spent by an unconfirmed transaction', async () => {
    const before = Date.now();
    await db.markOutputSpent('a1', 'stuck', 0);
    await db.markOutputSpent('c1', 'mined', 12);

    const spends = await db.getPendingSpends();
    expect(spends.map(s => [s.outputHash, s.spentTxHash])).toEqual([['a1', 'stuck']]);
    expect(spends[0].pendingSince).toBeGreaterThanOrEqual(before);
    expect(spends[0].pendingSince).toBeLessThanOrEqual(Date.now());
  });

  it('stops reporting a spend once a block confirms it', async () => {
    await db.markOutputSpent('a1', 'stuck', 0);
    await db.markOutputSpent('a1', 'aggregated', 15);

    expect(await db.getPendingSpends()).toEqual([]);
  });

  it('releases one transaction: inputs unspent, its mempool rows gone, the rest untouched', async () => {
    await db.markOutputSpent('a1', 'stuck', 0);
    await db.markOutputSpent('a2', 'stuck', 0);
    await db.markOutputSpent('b1', 'other', 0);
    await db.markOutputSpent('c1', 'stuck', 12); // spent in a block: never released

    const released = await db.releasePendingSpend('stuck');

    expect(released.sort()).toEqual(['a1', 'a2']);
    expect(await db.isOutputUnspent('a1')).toBe(true);
    expect(await db.isOutputUnspent('a2')).toBe(true);
    expect(await db.isOutputUnspent('b1')).toBe(false);
    expect(await db.isOutputUnspent('c1')).toBe(false);
    const hashes = (await db.getAllOutputs()).map(o => o.outputHash).sort();
    expect(hashes).toEqual(['a1', 'a2', 'b1', 'c1', 'mempool:other:0']);
    expect((await db.getPendingSpends()).map(s => s.spentTxHash)).toEqual(['other']);
    expect(await db.getPendingSpentAmount(null)).toBe(1_000n);
  });

  it('releases nothing for an unknown transaction', async () => {
    await db.markOutputSpent('a1', 'stuck', 0);

    expect(await db.releasePendingSpend('nope')).toEqual([]);
    expect(await db.isOutputUnspent('a1')).toBe(false);
  });
});

describe('WalletDB pending spends recorded before spent_at existed', () => {
  it('reports them with an unknown start', async () => {
    const db = new WalletDB({ type: 'better-sqlite3' });
    await db.open(':memory:');
    try {
      await db.storeWalletOutput(output('old', 'funding', 10));
      await db
        .getAdapter()
        .run(
          `UPDATE wallet_outputs SET is_spent = 1, spent_tx_hash = 'legacy', spent_block_height = 0, spent_at = NULL
           WHERE output_hash = 'old'`
        );

      expect(await db.getPendingSpends()).toEqual([
        { outputHash: 'old', spentTxHash: 'legacy', pendingSince: null },
      ]);
    } finally {
      await db.close();
    }
  });
});
