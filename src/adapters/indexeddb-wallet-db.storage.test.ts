import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyManager } from '../key-manager';
import { MAX_STORED_AMOUNT } from '../storage-codec';
import type { StoreOutputParams } from '../wallet-db.interface';
import { IndexedDBWalletDB } from './indexeddb-wallet-db';

const MNEMONIC_A =
  'short exact vendor hand scale enroll around pudding genius party lesson basket cook crash sugar protect advance gentle humor bench farm weekend direct awkward';
const NAV_SERIALIZED = '0'.repeat(64) + 'ffffffffffffffff';
const TOKEN_A = 'aa'.repeat(32) + '00'.repeat(8);

let pathCounter = 0;
const paths: string[] = [];
function freshPath(): string {
  const path = `storage-${process.pid}-${pathCounter++}`;
  paths.push(path);
  return path;
}

function output(outputHash: string, overrides: Partial<StoreOutputParams> = {}): StoreOutputParams {
  return {
    outputHash,
    txHash: 'cc'.repeat(32),
    outputIndex: 0,
    blockHeight: 10,
    outputData: '',
    amount: 1_000n,
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
    ...overrides,
  };
}

/** Open the raw database without a versionchange handler, as a stale tab would. */
function openRaw(
  path: string,
  version?: number,
  setup?: (db: IDBDatabase) => void
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IndexedDBWalletDB.getDatabaseName(path), version);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => setup?.(req.result);
    req.onsuccess = () => resolve(req.result);
  });
}

function rawGet(db: IDBDatabase, store: string, key: IDBValidKey): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withDb<T>(path: string, body: (db: IndexedDBWalletDB) => Promise<T>): Promise<T> {
  const walletDB = new IndexedDBWalletDB();
  await walletDB.open(path);
  try {
    return await body(walletDB);
  } finally {
    await walletDB.close();
  }
}

describe('IndexedDBWalletDB storage', () => {
  afterEach(async () => {
    for (const path of paths.splice(0)) {
      await IndexedDBWalletDB.deleteDatabase(path, 1_000).catch(() => undefined);
    }
  });

  it('keeps amounts above 2^53 exact and stores them as decimal strings', async () => {
    const path = freshPath();
    await withDb(path, async walletDB => {
      const big = 2n ** 53n + 1n;
      await walletDB.storeWalletOutput(output('01'.repeat(32), { amount: big }));
      await walletDB.storeWalletOutput(output('02'.repeat(32), { amount: MAX_STORED_AMOUNT }));
      await walletDB.storeWalletOutput(
        output('03'.repeat(32), { amount: MAX_STORED_AMOUNT, isSpent: true, spentBlockHeight: 0 })
      );
      await walletDB.saveCreatedCollection({
        collectionTokenId: 'ab'.repeat(32),
        kind: 'token',
        tokenPublicKey: 'cd',
        metadata: {},
        totalSupply: MAX_STORED_AMOUNT,
        txId: 'ef',
        createdAt: 1,
      });

      expect(await walletDB.getBalance()).toBe(big + MAX_STORED_AMOUNT);
      expect(await walletDB.getPendingSpentAmount()).toBe(MAX_STORED_AMOUNT);
      expect(
        (await walletDB.getUnspentOutputs()).map(o => o.amount).sort((a, b) => (a < b ? -1 : 1))
      ).toEqual([big, MAX_STORED_AMOUNT]);
      expect((await walletDB.getCreatedCollections())[0].totalSupply).toBe(MAX_STORED_AMOUNT);
      await expect(
        walletDB.storeWalletOutput(output('04'.repeat(32), { amount: 5 as unknown as bigint }))
      ).rejects.toThrow(TypeError);
    });

    const raw = await openRaw(path);
    try {
      expect((await rawGet(raw, 'walletOutputs', '01'.repeat(32))).amount).toBe('9007199254740993');
    } finally {
      raw.close();
    }
  });

  it('converts number amounts and NAV token spellings stored by version 7', async () => {
    const path = freshPath();
    const raw = await openRaw(path, 7, db => {
      const outputs = db.createObjectStore('walletOutputs', { keyPath: 'outputHash' });
      outputs.createIndex('blockHeight', 'blockHeight', { unique: false });
      outputs.createIndex('isSpent', 'isSpent', { unique: false });
      outputs.createIndex('spentBlockHeight', 'spentBlockHeight', { unique: false });
      const base = {
        txHash: 'dd',
        outputIndex: 0,
        blockHeight: 10,
        outputData: '',
        gamma: '01',
        isSpent: 0,
        isStakedCommitment: 0,
      };
      outputs.put({ ...base, outputHash: 'a1', amount: 2 ** 40, tokenId: NAV_SERIALIZED });
      outputs.put({ ...base, outputHash: 'a2', amount: 3, tokenId: TOKEN_A });
      db.createObjectStore('createdCollections', { keyPath: 'collectionTokenId' }).put({
        collectionTokenId: 'c1',
        kind: 'token',
        metadata: {},
        totalSupply: 1_000,
        createdAt: 1,
      });
    });
    raw.close();

    await withDb(path, async walletDB => {
      expect(await walletDB.getBalance()).toBe(2n ** 40n);
      expect(await walletDB.getBalance(TOKEN_A)).toBe(3n);
      const [nav] = await walletDB.getUnspentOutputs();
      expect(nav.tokenId).toBeNull();
      expect((await walletDB.getCreatedCollections())[0].totalSupply).toBe(1_000n);
    });

    const upgraded = await openRaw(path);
    try {
      expect(await rawGet(upgraded, 'walletOutputs', 'a1')).toMatchObject({
        amount: '1099511627776',
        tokenId: null,
      });
      expect((await rawGet(upgraded, 'createdCollections', 'c1')).totalSupply).toBe('1000');
    } finally {
      upgraded.close();
    }
  });

  it('selects NAV for an explicit NAV token id now that NAV is stored as null', async () => {
    await withDb(freshPath(), async walletDB => {
      await walletDB.storeWalletOutput(output('51'.repeat(32), { amount: 1n }));
      await walletDB.storeWalletOutput(output('52'.repeat(32), { amount: 2n, tokenId: TOKEN_A }));
      await walletDB.storeWalletOutput(
        output('53'.repeat(32), {
          amount: 4n,
          isSpent: true,
          spentTxHash: 'ff'.repeat(32),
          spentBlockHeight: 0,
        })
      );
      for (const navId of ['0'.repeat(64), NAV_SERIALIZED]) {
        expect(await walletDB.getBalance(navId)).toBe(1n);
        expect((await walletDB.getUnspentOutputs(navId)).map(o => o.outputHash)).toEqual([
          '51'.repeat(32),
        ]);
        expect(await walletDB.getPendingSpentAmount(navId)).toBe(4n);
      }
      expect(await walletDB.getBalance(TOKEN_A)).toBe(2n);
    });
  });

  it('leaves a record with a corrupt amount out instead of failing the upgrade or the balance', async () => {
    const path = freshPath();
    const raw = await openRaw(path, 7, db => {
      const outputs = db.createObjectStore('walletOutputs', { keyPath: 'outputHash' });
      outputs.createIndex('blockHeight', 'blockHeight', { unique: false });
      outputs.createIndex('isSpent', 'isSpent', { unique: false });
      outputs.createIndex('spentBlockHeight', 'spentBlockHeight', { unique: false });
      const base = {
        txHash: 'dd',
        outputIndex: 0,
        blockHeight: 10,
        outputData: '',
        gamma: '01',
        isSpent: 0,
        isStakedCommitment: 0,
        tokenId: null,
      };
      outputs.put({ ...base, outputHash: 'b1', amount: 7 });
      // Number(2^64 - 1) rounds to 2^64: out of range.
      outputs.put({ ...base, outputHash: 'b2', amount: Number(MAX_STORED_AMOUNT) });
      outputs.put({ ...base, outputHash: 'b3', amount: 'garbage' });
      outputs.put({
        ...base,
        outputHash: 'b4',
        amount: 'garbage',
        isSpent: 1,
        spentBlockHeight: 0,
      });
      db.createObjectStore('createdCollections', { keyPath: 'collectionTokenId' }).put({
        collectionTokenId: 'c1',
        kind: 'token',
        metadata: {},
        totalSupply: 1.5,
        createdAt: 1,
      });
    });
    raw.close();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await withDb(path, async walletDB => {
        expect(await walletDB.getBalance()).toBe(7n);
        expect(await walletDB.getPendingSpentAmount()).toBe(0n);
        expect((await walletDB.getUnspentOutputs()).map(o => o.outputHash)).toEqual(['b1']);
        expect((await walletDB.getAllOutputs()).map(o => o.outputHash)).toEqual(['b1']);
        expect(await walletDB.getCreatedCollections()).toEqual([]);
      });
      expect(warn.mock.calls.filter(c => String(c[0]).includes('output b2'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the spent state and creation time when an output is stored again', async () => {
    await withDb(freshPath(), async walletDB => {
      const hash = '31'.repeat(32);
      await walletDB.storeWalletOutput(output(hash));
      await walletDB.markOutputSpent(hash, 'ee'.repeat(32), 12);
      const createdAt = (await rawGet((walletDB as any).db, 'walletOutputs', hash)).createdAt;

      const later = vi.spyOn(Date, 'now').mockReturnValue(createdAt + 60_000);
      try {
        await walletDB.storeWalletOutput(output(hash, { timestamp: 99 }));
      } finally {
        later.mockRestore();
      }

      const [stored] = await walletDB.getAllOutputs();
      expect(stored).toMatchObject({
        isSpent: true,
        spentTxHash: 'ee'.repeat(32),
        spentBlockHeight: 12,
        timestamp: 99,
      });
      expect((await rawGet((walletDB as any).db, 'walletOutputs', hash)).createdAt).toBe(createdAt);
    });
  });

  it('drops key records a view-only wallet does not have when it is saved', async () => {
    await withDb(freshPath(), async walletDB => {
      const full = await walletDB.restoreWalletFromMnemonic(MNEMONIC_A);
      expect(await rawGet((walletDB as any).db, 'config', 'hdChain')).toBeDefined();

      const viewOnly = new KeyManager();
      viewOnly.setupGeneration(Buffer.from(full.getAuditKeyHex(), 'hex'), 'IMPORT_VIEW_KEY');
      await walletDB.saveWallet(viewOnly);

      expect(await rawGet((walletDB as any).db, 'config', 'hdChain')).toBeUndefined();
      expect(await rawGet((walletDB as any).db, 'config', 'mnemonic')).toBeUndefined();
      expect((await walletDB.loadWallet()).getAuditKeyHex()).toBe(full.getAuditKeyHex());
    });
  });

  it('keeps the previous wallet data when restoring a different wallet fails', async () => {
    await withDb(freshPath(), async walletDB => {
      const other = new KeyManager();
      other.generateNewMnemonic();
      await walletDB.restoreWalletFromMnemonic(other.getMnemonic());
      await walletDB.storeWalletOutput(output('51'.repeat(32)));
      await walletDB.saveSyncState({
        lastSyncedHeight: 10,
        lastSyncedHash: 'ab',
        totalTxKeysSynced: 1,
        lastSyncTime: 0,
        chainTipAtLastSync: 10,
      });

      const failing = vi
        .spyOn(KeyManager.prototype, 'getSubAddressEntries')
        .mockImplementationOnce(() => {
          throw new Error('quota exceeded');
        });
      try {
        await expect(walletDB.restoreWalletFromMnemonic(MNEMONIC_A)).rejects.toThrow(
          'quota exceeded'
        );
      } finally {
        failing.mockRestore();
      }

      expect((await walletDB.getAllOutputs()).map(o => o.outputHash)).toEqual(['51'.repeat(32)]);
      expect((await walletDB.loadSyncState())?.lastSyncedHeight).toBe(10);
      expect((await walletDB.loadWallet()).getAuditKeyHex()).toBe(other.getAuditKeyHex());
    });
  });

  it('reads corrupt tx keys as missing in both lookups', async () => {
    await withDb(freshPath(), async walletDB => {
      await walletDB.saveTxKeys('aa', 5, 'not json');
      await walletDB.saveTxKeys('bb', 5, JSON.stringify({ k: 1 }));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        expect(await walletDB.getTxKeys('aa')).toBeNull();
        expect(await walletDB.getTxKeysByHeight(5)).toEqual([{ txHash: 'bb', keys: { k: 1 } }]);
      } finally {
        warn.mockRestore();
      }
    });
  });

  it('rejects instead of hanging when a range delete aborts', async () => {
    await withDb(freshPath(), async walletDB => {
      await walletDB.saveTxKeys('aa', 5, '{}');
      await walletDB.saveBlockHash(1, 'h1');
      const originalDelete = IDBObjectStore.prototype.delete;
      const failing = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (
        this: IDBObjectStore
      ) {
        this.transaction.abort();
        return originalDelete.apply(this, [] as unknown as [IDBValidKey]);
      });
      try {
        await expect(walletDB.deleteTxKeysByHeight(5)).rejects.toBeDefined();
        await expect(walletDB.deleteBlockHashesBefore(5)).rejects.toBeDefined();
      } finally {
        failing.mockRestore();
      }
      expect(await walletDB.getTxKeys('aa')).toEqual({});
      expect(await walletDB.getBlockHash(1)).toBe('h1');
    });
  }, 5_000);
});

describe('IndexedDBWalletDB connections', () => {
  afterEach(async () => {
    for (const path of paths.splice(0)) {
      await IndexedDBWalletDB.deleteDatabase(path, 1_000).catch(() => undefined);
    }
  });

  it('closes when another connection deletes the database', async () => {
    const path = freshPath();
    const walletDB = new IndexedDBWalletDB();
    await walletDB.open(path);
    await walletDB.saveBlockHash(1, 'h1');

    await IndexedDBWalletDB.deleteDatabase(path, 1_000);

    expect(walletDB.isOpen()).toBe(false);
    await expect(walletDB.getBlockHash(1)).rejects.toThrow(
      'another tab or window upgraded or deleted it'
    );
    expect(await IndexedDBWalletDB.exists(path)).toBe(false);
  });

  it('does not report a deletion as done while another connection blocks it', async () => {
    const path = freshPath();
    const stale = await openRaw(path, 1);

    await expect(IndexedDBWalletDB.deleteDatabase(path, 50)).rejects.toThrow(
      'still open in another tab'
    );

    stale.close();
  });

  it('fails to open with a clear error when an old connection blocks the upgrade', async () => {
    const path = freshPath();
    const stale = await openRaw(path, 1);

    const walletDB = new IndexedDBWalletDB({ blockedTimeoutMs: 50 });
    await expect(walletDB.open(path)).rejects.toThrow('blocks the upgrade');
    expect(walletDB.isOpen()).toBe(false);

    stale.close();
  }, 5_000);
});
