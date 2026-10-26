import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyManager } from './key-manager';
import { WalletDB } from './wallet-db';
import { IndexedDBWalletDB } from './adapters/indexeddb-wallet-db';
import { NavioClient, type NavioClientConfig } from './client';
import type { SyncState } from './wallet-db.interface';

const MNEMONIC =
  'short exact vendor hand scale enroll around pudding genius party lesson basket cook crash sugar protect advance gentle humor bench farm weekend direct awkward';
const OTHER_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
const PASSPHRASE = 'navio-sdk test';
const PASSWORD = 'correct horse battery staple';
const SYNC_STATE: SyncState = {
  lastSyncedHeight: 1234,
  lastSyncedHash: 'ab'.repeat(32),
  totalTxKeysSynced: 99,
  lastSyncTime: 1_700_000_000_000,
  chainTipAtLastSync: 1300,
};

function masterOf(mnemonic: string, options: Parameters<typeof KeyManager.mnemonicToScalar>[1]) {
  return KeyManager.mnemonicToScalar(mnemonic, options).serialize().padStart(64, '0');
}

interface Backend {
  name: string;
  open(): Promise<WalletDB | IndexedDBWalletDB>;
  /** Rewrite the stored seed record as navio-sdk 0.4.0 wrote it */
  writeLegacySeedRecord(db: WalletDB | IndexedDBWalletDB, mnemonic: string): Promise<void>;
  cleanup(): Promise<void>;
}

const IDB_PATH = 'mnemonic-restore';

const backends: Backend[] = [
  {
    name: 'WalletDB (SQLite)',
    async open() {
      const db = new WalletDB({ type: 'better-sqlite3' });
      await db.open(':memory:');
      return db;
    },
    async writeLegacySeedRecord(db, mnemonic) {
      await (db as any).adapter.run(
        'UPDATE master_seed SET mnemonic = ?, mnemonic_derivation = NULL, mnemonic_passphrase = NULL WHERE id = 0',
        [mnemonic]
      );
    },
    async cleanup() {},
  },
  {
    name: 'IndexedDBWalletDB',
    async open() {
      const db = new IndexedDBWalletDB();
      await db.open(IDB_PATH);
      return db;
    },
    async writeLegacySeedRecord(db, mnemonic) {
      await (db as any).put('config', { key: 'mnemonic', mnemonic });
    },
    async cleanup() {
      await IndexedDBWalletDB.deleteDatabase(IDB_PATH);
    },
  },
];

describe.each(backends)('$name: restoring a mnemonic over a stored wallet', backend => {
  let db: WalletDB | IndexedDBWalletDB | null = null;

  afterEach(async () => {
    if (db) {
      await db.close();
      db = null;
    }
    await backend.cleanup();
  });

  /** A database holding a wallet with sync progress */
  async function storedWallet(
    options: Parameters<WalletDB['restoreWalletFromMnemonic']>[2],
    mnemonic = MNEMONIC
  ): Promise<WalletDB | IndexedDBWalletDB> {
    db = await backend.open();
    await db.restoreWalletFromMnemonic(mnemonic, 0, options);
    await db.saveSyncState(SYNC_STATE);
    return db;
  }

  it('keeps a wallet stored by 0.4.0 when restored without a derivation', async () => {
    const store = await storedWallet({ derivation: 'legacy' });
    await backend.writeLegacySeedRecord(store, MNEMONIC);

    const km = await store.restoreWalletFromMnemonic(MNEMONIC, 0);
    expect(km.getMnemonicDerivation()).toBe('legacy');
    expect(km.getMasterSeedHex()).toBe(masterOf(MNEMONIC, { derivation: 'legacy' }));
    expect(await store.loadSyncState()).toMatchObject({ lastSyncedHeight: 1234 });
    expect((await store.loadWallet()).getMnemonicDerivation()).toBe('legacy');
  });

  it('keeps an encrypted 0.4.0 wallet when restored without a derivation', async () => {
    const store = await storedWallet({ derivation: 'legacy' });
    const stored = await store.loadWallet();
    await stored.setPassword(PASSWORD);
    await store.saveWallet(stored);

    const km = await store.restoreWalletFromMnemonic(MNEMONIC, 0);
    expect(km.isEncrypted()).toBe(true);
    expect(await store.loadSyncState()).toMatchObject({ lastSyncedHeight: 1234 });
    expect(await km.unlock(PASSWORD)).toBe(true);
    expect(km.getMnemonicDerivation()).toBe('legacy');
  });

  it('uses the stored passphrase for the stored phrase', async () => {
    const store = await storedWallet({ passphrase: PASSPHRASE });

    const km = await store.restoreWalletFromMnemonic(MNEMONIC, 0);
    expect(km.getMasterSeedHex()).toBe(masterOf(MNEMONIC, { passphrase: PASSPHRASE }));
    expect(await store.loadSyncState()).toMatchObject({ lastSyncedHeight: 1234 });
  });

  it('refuses a restore that does not match the stored phrase, unless asked to replace', async () => {
    const store = await storedWallet({ passphrase: PASSPHRASE });

    await expect(
      store.restoreWalletFromMnemonic(MNEMONIC, 0, { passphrase: 'another passphrase' })
    ).rejects.toThrow('stores this mnemonic with another derivation or passphrase');
    await expect(
      store.restoreWalletFromMnemonic(MNEMONIC, 0, { derivation: 'legacy' })
    ).rejects.toThrow('stores this mnemonic with another derivation or passphrase');
    expect(await store.loadSyncState()).toMatchObject({ lastSyncedHeight: 1234 });
    expect((await store.loadWallet()).getMasterSeedHex()).toBe(
      masterOf(MNEMONIC, { passphrase: PASSPHRASE })
    );

    const km = await store.restoreWalletFromMnemonic(MNEMONIC, 0, {
      derivation: 'legacy',
      replaceExisting: true,
    });
    expect(km.getMnemonicDerivation()).toBe('legacy');
    expect(await store.loadSyncState()).toBeNull();
  });

  it('refuses to replace an encrypted wallet it cannot match', async () => {
    const store = await storedWallet({ passphrase: PASSPHRASE });
    const stored = await store.loadWallet();
    await stored.setPassword(PASSWORD);
    await store.saveWallet(stored);

    // Without the passphrase this may be the same phrase: refuse
    await expect(store.restoreWalletFromMnemonic(MNEMONIC, 0)).rejects.toThrow(
      'may be this mnemonic with another derivation or passphrase'
    );
    await expect(store.restoreWalletFromMnemonic(OTHER_MNEMONIC, 0)).rejects.toThrow(
      'may be this mnemonic with another derivation or passphrase'
    );
    expect(await store.loadSyncState()).toMatchObject({ lastSyncedHeight: 1234 });
    const reloaded = await store.loadWallet();
    expect(await reloaded.unlock(PASSWORD)).toBe(true);
    expect(reloaded.getMasterSeedHex()).toBe(masterOf(MNEMONIC, { passphrase: PASSPHRASE }));

    // With it, the stored wallet matches and keeps its data
    await store.restoreWalletFromMnemonic(MNEMONIC, 0, { passphrase: PASSPHRASE });
    expect(await store.loadSyncState()).toMatchObject({ lastSyncedHeight: 1234 });
  });

  it('keeps an encrypted stored wallet encrypted when its phrase is restored', async () => {
    const store = await storedWallet({ passphrase: PASSPHRASE });
    const stored = await store.loadWallet();
    await stored.setPassword(PASSWORD);
    await store.saveWallet(stored);
    const before = stored.getSeedForStorage() as { encryptedSeed: string };

    const km = await store.restoreWalletFromMnemonic(MNEMONIC, 0, { passphrase: PASSPHRASE });
    expect(km.isEncrypted()).toBe(true);
    expect(km.isUnlocked()).toBe(false);
    expect(() => km.getMnemonic()).toThrow('Wallet is locked');
    expect(await store.loadSyncState()).toMatchObject({ lastSyncedHeight: 1234 });

    // Storage still holds only the encrypted seed, with the encryption metadata
    const reloaded = await store.loadWallet();
    expect(reloaded.isEncrypted()).toBe(true);
    expect(reloaded.getSeedForStorage()).toEqual(before);
    expect(await reloaded.unlock(PASSWORD)).toBe(true);
    expect(reloaded.getMasterSeedHex()).toBe(masterOf(MNEMONIC, { passphrase: PASSPHRASE }));
    expect(await km.unlock(PASSWORD)).toBe(true);
    expect(km.getMnemonic()).toBe(MNEMONIC);
  });

  it('replaces a stored wallet with a different plaintext phrase', async () => {
    const store = await storedWallet({});

    const km = await store.restoreWalletFromMnemonic(OTHER_MNEMONIC, 0);
    expect(km.getMnemonic()).toBe(OTHER_MNEMONIC);
    expect(km.getMnemonicDerivation()).toBe('core');
    expect(await store.loadSyncState()).toBeNull();
  });
});

describe('NavioClient restoreFromMnemonic over a stored wallet', () => {
  let dir: string | null = null;
  const clients: NavioClient[] = [];

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map(client => client.disconnect()));
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  async function initialize(config: Partial<NavioClientConfig>): Promise<NavioClient> {
    const client = new NavioClient({
      network: 'testnet',
      backend: 'electrum',
      electrum: { host: 'localhost', port: 50005 },
      walletDbPath: join(dir!, 'wallet.db'),
      databaseAdapter: 'better-sqlite3',
      ...config,
    });
    (client as any).syncProvider = {
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
    };
    clients.push(client);
    await client.initialize();
    return client;
  }

  it('keeps a 0.4.0 wallet when the app passes its phrase on every start', async () => {
    dir = await mkdtemp(join(tmpdir(), 'navio-mnemonic-restore-'));
    const first = await initialize({ restoreFromMnemonic: MNEMONIC, mnemonicDerivation: 'legacy' });
    const walletDB = first.getWalletDB() as WalletDB;
    await walletDB.saveSyncState(SYNC_STATE);
    // As navio-sdk 0.4.0 stored it
    await (walletDB as any).adapter.run(
      'UPDATE master_seed SET mnemonic_derivation = NULL WHERE id = 0'
    );
    await first.disconnect();

    const second = await initialize({ restoreFromMnemonic: MNEMONIC });
    expect(second.getKeyManager().getMnemonicDerivation()).toBe('legacy');
    expect(await (second.getWalletDB() as WalletDB).loadSyncState()).toMatchObject({
      lastSyncedHeight: 1234,
    });
  });
});
