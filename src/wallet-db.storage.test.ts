import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyManager } from './key-manager';
import { decodeAmount, encodeAmount, MAX_STORED_AMOUNT } from './storage-codec';
import { WalletDB } from './wallet-db';
import type { StoreOutputParams } from './wallet-db.interface';

const MNEMONIC_A =
  'short exact vendor hand scale enroll around pudding genius party lesson basket cook crash sugar protect advance gentle humor bench farm weekend direct awkward';
const NAV_ZERO = '0'.repeat(64);
const NAV_SERIALIZED = NAV_ZERO + 'ffffffffffffffff';
const TOKEN_A = 'aa'.repeat(32) + '00'.repeat(8);

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

describe('storage amount codec', () => {
  it('encodes u64 amounts exactly and rejects anything else', () => {
    expect(encodeAmount(0n)).toBe('0');
    expect(encodeAmount(MAX_STORED_AMOUNT)).toBe('18446744073709551615');
    expect(() => encodeAmount(MAX_STORED_AMOUNT + 1n)).toThrow(RangeError);
    expect(() => encodeAmount(-1n)).toThrow(RangeError);
    expect(() => encodeAmount(5 as unknown as bigint)).toThrow(TypeError);
  });

  it('decodes stored strings and legacy numbers', () => {
    expect(decodeAmount('18446744073709551615')).toBe(MAX_STORED_AMOUNT);
    expect(decodeAmount(42)).toBe(42n);
    expect(decodeAmount(null)).toBe(0n);
    // A legacy number above 2^53 already lost precision; it keeps what is left.
    expect(decodeAmount(2 ** 60)).toBe(2n ** 60n);
  });

  it('range-checks stored amounts like writes', () => {
    for (const bad of ['abc', '-1', '1.5', '0x10', ' 1', '1e3', 1.5, NaN, {}]) {
      expect(() => decodeAmount(bad), String(bad)).toThrow(TypeError);
    }
    expect(() => decodeAmount('18446744073709551616')).toThrow(RangeError);
    // Number(2^64 - 1) rounds to 2^64, past the u64 maximum.
    expect(() => decodeAmount(Number(MAX_STORED_AMOUNT))).toThrow(RangeError);
    expect(() => decodeAmount(-1)).toThrow(RangeError);
    expect(() => decodeAmount(-1n)).toThrow(RangeError);
  });
});

describe('WalletDB storage', () => {
  let walletDB: WalletDB;

  beforeEach(async () => {
    walletDB = new WalletDB({ type: 'better-sqlite3' });
    await walletDB.open(':memory:');
  });

  afterEach(async () => {
    await walletDB.close();
  });

  it('keeps amounts above 2^53 exact, up to 2^64 - 1, and sums them without overflow', async () => {
    const big = 2n ** 53n + 1n;
    await walletDB.storeWalletOutput(output('01'.repeat(32), { amount: big }));
    await walletDB.storeWalletOutput(output('02'.repeat(32), { amount: MAX_STORED_AMOUNT }));
    await walletDB.storeWalletOutput(
      output('03'.repeat(32), { amount: MAX_STORED_AMOUNT, isSpent: true, spentBlockHeight: 0 })
    );
    await walletDB.storeWalletOutput(
      output('04'.repeat(32), { amount: MAX_STORED_AMOUNT, isSpent: true, spentBlockHeight: 0 })
    );

    const amounts = Object.fromEntries(
      (await walletDB.getAllOutputs()).map(o => [o.outputHash, o.amount])
    );
    expect(amounts['01'.repeat(32)]).toBe(big);
    expect(amounts['02'.repeat(32)]).toBe(MAX_STORED_AMOUNT);
    expect(await walletDB.getBalance()).toBe(big + MAX_STORED_AMOUNT);
    expect(await walletDB.getPendingSpentAmount()).toBe(2n * MAX_STORED_AMOUNT);
  });

  it('refuses a number amount instead of storing it imprecisely', async () => {
    await expect(
      walletDB.storeWalletOutput(output('05'.repeat(32), { amount: 1_000 as unknown as bigint }))
    ).rejects.toThrow(TypeError);
  });

  it('records a created collection supply above 2^53 exactly', async () => {
    const totalSupply = 2n ** 63n + 7n;
    await walletDB.saveCreatedCollection({
      collectionTokenId: 'ab'.repeat(32),
      kind: 'token',
      tokenPublicKey: 'cd'.repeat(48),
      metadata: { name: 'Big' },
      totalSupply,
      txId: 'ef'.repeat(32),
      createdAt: 1,
    });
    expect((await walletDB.getCreatedCollections())[0].totalSupply).toBe(totalSupply);
  });

  it('counts every spelling of the NAV token id as NAV in every query', async () => {
    await walletDB.storeWalletOutput(output('11'.repeat(32), { tokenId: null, amount: 1n }));
    await walletDB.storeWalletOutput(output('12'.repeat(32), { tokenId: NAV_ZERO, amount: 2n }));
    await walletDB.storeWalletOutput(
      output('13'.repeat(32), { tokenId: NAV_SERIALIZED, amount: 4n })
    );
    await walletDB.storeWalletOutput(output('14'.repeat(32), { tokenId: TOKEN_A, amount: 8n }));
    for (const [hash, tokenId] of [
      ['21', null],
      ['22', NAV_ZERO],
      ['23', NAV_SERIALIZED],
    ] as const) {
      await walletDB.storeWalletOutput(
        output(hash.repeat(32), {
          tokenId,
          amount: 16n,
          isSpent: true,
          spentTxHash: 'ff'.repeat(32),
          spentBlockHeight: 0,
        })
      );
    }

    expect(await walletDB.getBalance()).toBe(7n);
    expect(
      (await walletDB.getUnspentOutputs()).map(o => o.amount).sort((a, b) => (a < b ? -1 : 1))
    ).toEqual([1n, 2n, 4n]);
    expect(await walletDB.getPendingSpentAmount()).toBe(48n);
    expect(await walletDB.getBalance(TOKEN_A)).toBe(8n);

    // An explicit NAV token id, in either spelling, selects NAV too.
    for (const navId of [NAV_ZERO, NAV_SERIALIZED, NAV_ZERO.toUpperCase()]) {
      expect(await walletDB.getBalance(navId)).toBe(7n);
      expect((await walletDB.getUnspentOutputs(navId)).length).toBe(3);
      expect(await walletDB.getPendingSpentAmount(navId)).toBe(48n);
    }
  });

  it('leaves a row with a corrupt amount out of balances and listings, warning once', async () => {
    const good = '41'.repeat(32);
    const garbage = '42'.repeat(32);
    const tooBig = '43'.repeat(32);
    const pendingBad = '44'.repeat(32);
    await walletDB.storeWalletOutput(output(good, { amount: 5n }));
    await walletDB.storeWalletOutput(output(garbage));
    await walletDB.storeWalletOutput(output(tooBig));
    await walletDB.storeWalletOutput(
      output(pendingBad, { isSpent: true, spentTxHash: 'ff'.repeat(32), spentBlockHeight: 0 })
    );
    await walletDB
      .getAdapter()
      .run(`UPDATE wallet_outputs SET amount = 'garbage' WHERE output_hash IN (?, ?)`, [
        garbage,
        pendingBad,
      ]);
    await walletDB
      .getAdapter()
      .run(`UPDATE wallet_outputs SET amount = '18446744073709551616' WHERE output_hash = ?`, [
        tooBig,
      ]);
    await walletDB.saveCreatedCollection({
      collectionTokenId: 'c2'.repeat(32),
      kind: 'token',
      tokenPublicKey: 'cd',
      metadata: {},
      totalSupply: 1n,
      txId: 'ef',
      createdAt: 1,
    });
    await walletDB.getAdapter().run(`UPDATE created_collections SET total_supply = 'x'`);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await walletDB.getBalance()).toBe(5n);
      expect(await walletDB.getBalance()).toBe(5n);
      expect(await walletDB.getPendingSpentAmount()).toBe(0n);
      expect((await walletDB.getUnspentOutputs()).map(o => o.outputHash)).toEqual([good]);
      expect((await walletDB.getAllOutputs()).map(o => o.outputHash)).toEqual([good]);
      expect(await walletDB.getCreatedCollections()).toEqual([]);
      const warned = warn.mock.calls.map(c => String(c[0]));
      for (const hash of [garbage, tooBig, pendingBad]) {
        expect(warned.filter(m => m.includes(hash))).toHaveLength(1);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the spent state and creation time when an output is stored again', async () => {
    const hash = '31'.repeat(32);
    await walletDB.storeWalletOutput(output(hash));
    const createdAt = () =>
      walletDB
        .getAdapter()
        .exec(`SELECT created_at FROM wallet_outputs WHERE output_hash = '${hash}'`)
        .then(r => r[0].values[0][0]);
    const firstCreatedAt = await createdAt();
    await walletDB.markOutputSpent(hash, 'ee'.repeat(32), 12);

    const later = vi.spyOn(Date, 'now').mockReturnValue(Number(firstCreatedAt) + 60_000);
    try {
      // A block is processed again: sync stores the output as unspent.
      await walletDB.storeWalletOutput(output(hash, { timestamp: 99 }));
    } finally {
      later.mockRestore();
    }

    const [stored] = await walletDB.getAllOutputs();
    expect(stored.isSpent).toBe(true);
    expect(stored.spentTxHash).toBe('ee'.repeat(32));
    expect(stored.spentBlockHeight).toBe(12);
    expect(stored.timestamp).toBe(99);
    expect(await createdAt()).toBe(firstCreatedAt);
    expect(await walletDB.isOutputUnspent(hash)).toBe(false);
  });

  it('reads corrupt tx keys as missing, the same as IndexedDB, and frees the statement', async () => {
    await walletDB.saveTxKeys('aa'.repeat(32), 5, 'not json');
    await walletDB.saveTxKeys('bb'.repeat(32), 5, JSON.stringify({ k: 1 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await walletDB.getTxKeys('aa'.repeat(32))).toBeNull();
      expect(await walletDB.getTxKeysByHeight(5)).toEqual([
        { txHash: 'bb'.repeat(32), keys: { k: 1 } },
      ]);
    } finally {
      warn.mockRestore();
    }
    // A statement left mid-iteration would keep the connection busy.
    await walletDB.saveBlockHash(5, 'cd'.repeat(32));
    expect(await walletDB.getBlockHash(5)).toBe('cd'.repeat(32));
  });

  it('runs concurrent transactional writes one after the other', async () => {
    const keyManager = await walletDB.restoreWalletFromMnemonic(MNEMONIC_A);
    await walletDB.storeWalletOutput(output('41'.repeat(32), { blockHeight: 20 }));
    const state = {
      lastSyncedHeight: 9,
      lastSyncedHash: 'ab'.repeat(32),
      totalTxKeysSynced: 0,
      lastSyncTime: 0,
      chainTipAtLastSync: 9,
    };

    await Promise.all([
      walletDB.saveWallet(keyManager),
      walletDB.saveWallet(keyManager),
      walletDB.revertBlocksFrom(10, state),
      walletDB.saveWallet(keyManager),
    ]);

    expect(await walletDB.getAllOutputs()).toEqual([]);
    expect((await walletDB.loadWallet()).getAuditKeyHex()).toBe(keyManager.getAuditKeyHex());
  });

  it('keeps the previous wallet data when restoring a different wallet fails', async () => {
    const other = new KeyManager();
    other.generateNewMnemonic();
    await walletDB.restoreWalletFromMnemonic(other.getMnemonic());
    await walletDB.storeWalletOutput(output('51'.repeat(32)));
    await walletDB.saveSyncState({
      lastSyncedHeight: 10,
      lastSyncedHash: 'ab'.repeat(32),
      totalTxKeysSynced: 1,
      lastSyncTime: 0,
      chainTipAtLastSync: 10,
    });

    const failing = vi
      .spyOn(KeyManager.prototype, 'getSubAddressEntries')
      .mockImplementationOnce(() => {
        throw new Error('disk full');
      });
    try {
      await expect(walletDB.restoreWalletFromMnemonic(MNEMONIC_A)).rejects.toThrow('disk full');
    } finally {
      failing.mockRestore();
    }

    // Nothing of the failed restore landed: the old wallet, its outputs and
    // its sync progress are all still there.
    expect((await walletDB.getAllOutputs()).map(o => o.outputHash)).toEqual(['51'.repeat(32)]);
    expect((await walletDB.loadSyncState())?.lastSyncedHeight).toBe(10);
    expect((await walletDB.loadWallet()).getAuditKeyHex()).toBe(other.getAuditKeyHex());
  });
});

describe('WalletDB legacy INTEGER amounts', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'navio-sdk-amounts-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('migrates INTEGER amount columns to exact decimal TEXT', async () => {
    const path = join(dir, 'wallet.db');
    const old = new Database(path);
    old.exec(`CREATE TABLE wallet_outputs (
      output_hash TEXT PRIMARY KEY, tx_hash TEXT NOT NULL, output_index INTEGER NOT NULL,
      block_height INTEGER NOT NULL, output_data TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0,
      gamma TEXT NOT NULL DEFAULT '0', memo TEXT, token_id TEXT, blinding_key TEXT, ephemeral_key TEXT,
      spending_key TEXT, is_spent INTEGER NOT NULL DEFAULT 0, spent_tx_hash TEXT,
      spent_block_height INTEGER, created_at INTEGER NOT NULL,
      tx_type TEXT NOT NULL DEFAULT 'received', timestamp INTEGER NOT NULL DEFAULT 0,
      is_staked_commitment INTEGER NOT NULL DEFAULT 0)`);
    old.exec('CREATE INDEX idx_custom_token ON wallet_outputs(token_id)');
    old.exec(`CREATE TABLE created_collections (
      collection_token_id TEXT PRIMARY KEY, kind TEXT NOT NULL, token_public_key TEXT NOT NULL,
      metadata TEXT NOT NULL, total_supply INTEGER NOT NULL, tx_id TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    const insert = old.prepare(
      `INSERT INTO wallet_outputs (output_hash, tx_hash, output_index, block_height, output_data,
       amount, token_id, created_at) VALUES (?, 'dd', 0, 10, '', ?, ?, 7)`
    );
    insert.run('61'.repeat(32), 2n ** 62n + 1n, null);
    insert.run('62'.repeat(32), 5n, NAV_SERIALIZED);
    insert.run('63'.repeat(32), 9n, TOKEN_A);
    old
      .prepare(`INSERT INTO created_collections VALUES ('ab', 'token', 'cd', '{}', ?, 'ef', 1)`)
      .run(2n ** 60n);
    old.close();

    const walletDB = new WalletDB({ type: 'better-sqlite3' });
    await walletDB.open(path);
    try {
      expect(await walletDB.getBalance()).toBe(2n ** 62n + 6n);
      expect(await walletDB.getBalance(TOKEN_A)).toBe(9n);
      const tokenIds = Object.fromEntries(
        (await walletDB.getAllOutputs()).map(o => [o.outputHash, o.tokenId])
      );
      expect(tokenIds['62'.repeat(32)]).toBeNull();
      expect((await walletDB.getCreatedCollections())[0].totalSupply).toBe(2n ** 60n);

      const adapter = walletDB.getAdapter();
      const types = await adapter.exec(
        "SELECT name, type FROM pragma_table_info('wallet_outputs') WHERE name = 'amount'"
      );
      expect(types[0].values[0][1]).toBe('TEXT');
      const indexes = await adapter.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'wallet_outputs' AND sql IS NOT NULL"
      );
      expect(indexes[0].values.map(v => v[0])).toContain('idx_custom_token');
    } finally {
      await walletDB.close();
    }

    // Opening again leaves the migrated table alone.
    const again = new WalletDB({ type: 'better-sqlite3' });
    await again.open(path);
    try {
      expect(await again.getBalance()).toBe(2n ** 62n + 6n);
    } finally {
      await again.close();
    }
  });
});

describe('WalletDB import from bytes', () => {
  let dir: string;
  let savedTmpdir: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'navio-sdk-import-'));
    // A wallet image must never go through the shared temp directory: point
    // it somewhere that does not exist, so any write there fails.
    savedTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = join(dir, 'no-such-tmpdir');
  });

  afterEach(async () => {
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
    await rm(dir, { recursive: true, force: true });
  });

  it('migrate() writes the database to the new path and keeps later writes there', async () => {
    const memory = new WalletDB({ type: 'better-sqlite3' });
    await memory.open(':memory:');
    await memory.storeWalletOutput(output('71'.repeat(32), { amount: 3n }));

    const path = join(dir, 'migrated.db');
    const migrated = await memory.migrate(path);
    await memory.close();
    await migrated.storeWalletOutput(output('72'.repeat(32), { amount: 4n }));
    await migrated.close();

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const reopened = new WalletDB({ type: 'better-sqlite3' });
    await reopened.open(path);
    try {
      expect(await reopened.getBalance()).toBe(7n);
    } finally {
      await reopened.close();
    }
  });

  it('creates a new database file readable by the owner only', async () => {
    const path = join(dir, 'new.db');
    const walletDB = new WalletDB({ type: 'better-sqlite3' });
    await walletDB.open(path);
    try {
      await walletDB.storeWalletOutput(output('77'.repeat(32)));
      for (const file of [path, `${path}-wal`]) {
        expect((await stat(file)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await walletDB.close();
    }
  });

  it('refuses to import over an existing database file', async () => {
    const path = join(dir, 'existing.db');
    const existing = new WalletDB({ type: 'better-sqlite3' });
    await existing.open(path);
    await existing.storeWalletOutput(output('73'.repeat(32)));

    const source = new WalletDB({ type: 'better-sqlite3' });
    await source.open(':memory:');
    try {
      await expect(source.migrate(path)).rejects.toThrow('Refusing to import over existing file');
    } finally {
      await source.close();
      await existing.close();
    }
  });

  it('removes the target file when imported bytes do not open, so a retry works', async () => {
    const path = join(dir, 'retry.db');
    const failed = new WalletDB({ type: 'better-sqlite3' });
    await expect(
      failed.open(path, new TextEncoder().encode('not a sqlite database at all'))
    ).rejects.toThrow();
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      expect(existsSync(file), file).toBe(false);
    }

    const source = new WalletDB({ type: 'better-sqlite3' });
    await source.open(':memory:');
    await source.storeWalletOutput(output('75'.repeat(32), { amount: 6n }));
    try {
      const retried = await source.migrate(path);
      expect(await retried.getBalance()).toBe(6n);
      await retried.close();
    } finally {
      await source.close();
    }
  });

  it('loads bytes exported from a WAL-mode file database in memory', async () => {
    const path = join(dir, 'file.db');
    const fileDb = new WalletDB({ type: 'better-sqlite3' });
    await fileDb.open(path);
    await fileDb.storeWalletOutput(output('74'.repeat(32), { amount: 11n }));
    const bytes = await fileDb.export();
    await fileDb.close();

    const loaded = await WalletDB.loadFromBytes(bytes, { type: 'better-sqlite3' });
    try {
      expect(await loaded.getBalance()).toBe(11n);
      await loaded.storeWalletOutput(output('75'.repeat(32), { amount: 1n }));
      expect(await loaded.getBalance()).toBe(12n);
    } finally {
      await loaded.close();
    }
    expect(existsSync(join(dir, 'no-such-tmpdir'))).toBe(false);
  });

  it('decrypts an encrypted export in memory only', async () => {
    const source = new WalletDB({ type: 'better-sqlite3' });
    await source.open(':memory:');
    await source.storeWalletOutput(output('76'.repeat(32), { amount: 13n }));
    const encrypted = await source.exportEncrypted('pw');
    await source.close();

    const loaded = await WalletDB.loadEncrypted(encrypted, 'pw', { type: 'better-sqlite3' });
    try {
      expect(await loaded.getBalance()).toBe(13n);
    } finally {
      await loaded.close();
    }
  });
});
