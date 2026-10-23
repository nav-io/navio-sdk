import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { KeyManager } from './key-manager';
import { WalletDB } from './wallet-db';
import { IndexedDBWalletDB } from './adapters/indexeddb-wallet-db';

const MNEMONIC =
  'short exact vendor hand scale enroll around pudding genius party lesson basket cook crash sugar protect advance gentle humor bench farm weekend direct awkward';
const OTHER_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
const PASSWORD = 'correct horse battery staple';

function wallet(mnemonic = MNEMONIC): KeyManager {
  const km = new KeyManager();
  km.setHDSeedFromMnemonic(mnemonic);
  km.newSubAddressPool(0);
  km.newSubAddressPool(-1);
  km.newSubAddressPool(-2);
  return km;
}

function expectSeedLocked(km: KeyManager): void {
  expect(() => km.getMnemonic()).toThrow('Wallet is locked');
  expect(() => km.getMasterSeedHex()).toThrow('Wallet is locked');
  expect(() => km.getMasterSeedKey()).toThrow('Wallet is locked');
  expect(() => km.getSpendingKey()).toThrow();
  expect(() => km.getMasterTokenKey()).toThrow();
}

describe('KeyManager lock', () => {
  it('drops the seed on lock and restores it on unlock', async () => {
    const km = wallet();
    const seedHex = km.getMasterSeedHex();
    const spendKey = km.getSpendingKey().serialize();
    const viewKey = km.getPrivateViewKeyHex();
    const address = km.getSubAddress({ account: 0, address: 0 }).serialize();

    await km.setPassword(PASSWORD);
    km.lock();

    expectSeedLocked(km);
    expect(km.getKeyStats().plainKeys).toBe(0);
    expect((km as any).masterSeed).toBeNull();
    expect((km as any).storedMnemonic).toBeNull();
    // Scanning keeps working while locked
    expect(km.getPrivateViewKeyHex()).toBe(viewKey);
    expect(km.getSubAddress({ account: 0, address: 0 }).serialize()).toBe(address);

    expect(await km.unlock(PASSWORD)).toBe(true);
    expect(km.getMnemonic()).toBe(MNEMONIC);
    expect(km.getMasterSeedHex()).toBe(seedHex);
    expect(km.getSpendingKey().serialize()).toBe(spendKey);
  });

  it('does not restore the seed on a wrong password', async () => {
    const km = wallet();
    await km.setPassword(PASSWORD);
    km.lock();

    expect(await km.unlock('wrong')).toBe(false);
    expectSeedLocked(km);
    expect((km as any).masterSeed).toBeNull();
  });

  it('keeps the seed recoverable across a password change', async () => {
    const km = wallet();
    await km.setPassword(PASSWORD);
    km.lock();

    expect(await km.changePassword(PASSWORD, 'new password')).toBe(true);
    km.lock();
    expect(await km.unlock(PASSWORD)).toBe(false);
    expect(await km.unlock('new password')).toBe(true);
    expect(km.getMnemonic()).toBe(MNEMONIC);
  });

  it('stores only the encrypted seed for an encrypted wallet', async () => {
    const km = wallet();
    expect(km.getSeedForStorage()).toEqual({ mnemonic: MNEMONIC });

    await km.setPassword(PASSWORD);
    const stored = km.getSeedForStorage() as { encryptedSeed: string };
    expect(Object.keys(stored)).toEqual(['encryptedSeed']);
    expect(Buffer.from(stored.encryptedSeed, 'hex').toString()).not.toContain('vendor');

    km.lock();
    expect(km.getSeedForStorage()).toEqual(stored);
  });

  it('locks a wallet loaded from storage until unlock', async () => {
    const source = wallet();
    await source.setPassword(PASSWORD);
    const params = source.getEncryptionParams()!;

    const km = new KeyManager();
    km.loadHDChain(source.getHDChain()!);
    km.loadEncryptedSeed(source.getEncryptedSeed()!);
    km.loadViewKey(source.getPrivateViewKey());
    km.loadSpendKey(source.getPublicSpendingKey());
    km.setEncryptionParams(params.salt, params.verificationHash);

    expectSeedLocked(km);
    expect(await km.unlock(PASSWORD)).toBe(true);
    expect(km.getMnemonic()).toBe(MNEMONIC);
  });

  it('refuses an encrypted seed that belongs to another wallet', async () => {
    const other = wallet(OTHER_MNEMONIC);
    await other.setPassword(PASSWORD);
    const params = other.getEncryptionParams()!;

    const km = new KeyManager();
    km.loadHDChain(wallet().getHDChain()!);
    km.loadEncryptedSeed(other.getEncryptedSeed()!);
    km.setEncryptionParams(params.salt, params.verificationHash);

    await expect(km.unlock(PASSWORD)).rejects.toThrow('Encrypted seed does not match this wallet');
  });

  it('migrates a plaintext seed stored by an earlier version on unlock', async () => {
    const source = wallet();
    await source.setPassword(PASSWORD);
    const params = source.getEncryptionParams()!;

    // What loadWallet did for an encrypted wallet before the seed was encrypted
    const km = wallet();
    km.setEncryptionParams(params.salt, params.verificationHash);

    expectSeedLocked(km);
    expect(km.getKeyStats().plainKeys).toBe(0);
    // A save while locked must not lose the only copy of the seed
    expect(km.getSeedForStorage()).toEqual({ mnemonic: MNEMONIC });

    expect(await km.unlock(PASSWORD)).toBe(true);
    expect(km.getSeedForStorage()).toHaveProperty('encryptedSeed');
    km.lock();
    expect((km as any).masterSeed).toBeNull();
    expect(await km.unlock(PASSWORD)).toBe(true);
    expect(km.getMnemonic()).toBe(MNEMONIC);
  });
});

interface Backend {
  name: string;
  open(): Promise<WalletDB | IndexedDBWalletDB>;
  /** The stored seed record, as raw storage holds it */
  rawSeed(db: WalletDB | IndexedDBWalletDB): Promise<Record<string, unknown> | null>;
  /** Overwrite the stored seed with a plaintext mnemonic, as earlier versions stored it */
  writePlaintextSeed(db: WalletDB | IndexedDBWalletDB, mnemonic: string): Promise<void>;
  cleanup(): Promise<void>;
}

const IDB_PATH = 'wallet-lock';

const backends: Backend[] = [
  {
    name: 'WalletDB (SQLite)',
    async open() {
      const db = new WalletDB({ type: 'better-sqlite3' });
      await db.open(':memory:');
      return db;
    },
    async rawSeed(db) {
      const result = await (db as any).adapter.exec(
        'SELECT mnemonic, seed_hex, encrypted_seed FROM master_seed WHERE id = 0'
      );
      if (result.length === 0 || result[0].values.length === 0) return null;
      const [mnemonic, seedHex, encryptedSeed] = result[0].values[0];
      return { mnemonic, seedHex, encryptedSeed };
    },
    async writePlaintextSeed(db, mnemonic) {
      await (db as any).adapter.run(
        'UPDATE master_seed SET mnemonic = ?, encrypted_seed = NULL WHERE id = 0',
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
    async rawSeed(db) {
      const rec = await (db as any).get('config', 'mnemonic');
      if (!rec) return null;
      return { mnemonic: rec.mnemonic ?? null, seedHex: rec.seedHex ?? null, encryptedSeed: rec.encryptedSeed ?? null };
    },
    async writePlaintextSeed(db, mnemonic) {
      await (db as any).put('config', { key: 'mnemonic', mnemonic });
    },
    async cleanup() {
      await IndexedDBWalletDB.deleteDatabase(IDB_PATH);
    },
  },
];

describe.each(backends)('$name encrypted seed', (backend) => {
  let db: WalletDB | IndexedDBWalletDB | null = null;

  afterEach(async () => {
    if (db) {
      await db.close();
      db = null;
    }
    await backend.cleanup();
  });

  it('stores the seed encrypted and reloads the wallet locked', async () => {
    db = await backend.open();
    const km = await db.restoreWalletFromMnemonic(MNEMONIC, 0);
    const spendKey = km.getSpendingKey().serialize();
    const address = km.getSubAddress({ account: 0, address: 0 }).serialize();
    expect(await backend.rawSeed(db)).toMatchObject({ mnemonic: MNEMONIC });

    await km.setPassword(PASSWORD);
    await db.saveWallet(km);

    const raw = await backend.rawSeed(db);
    expect(raw).toMatchObject({ mnemonic: null, seedHex: null });
    expect(typeof raw!.encryptedSeed).toBe('string');
    expect(JSON.stringify(raw)).not.toContain('vendor');

    const reloaded = await db.loadWallet();
    expect(reloaded.isEncrypted()).toBe(true);
    expect(reloaded.isUnlocked()).toBe(false);
    expectSeedLocked(reloaded);
    expect(reloaded.getSubAddress({ account: 0, address: 0 }).serialize()).toBe(address);

    expect(await reloaded.unlock(PASSWORD)).toBe(true);
    expect(reloaded.getMnemonic()).toBe(MNEMONIC);
    expect(reloaded.getSpendingKey().serialize()).toBe(spendKey);
  });

  it('migrates a plaintext seed stored by an earlier version once unlocked', async () => {
    db = await backend.open();
    const km = await db.restoreWalletFromMnemonic(MNEMONIC, 0);
    await km.setPassword(PASSWORD);
    await db.saveWallet(km);
    await backend.writePlaintextSeed(db, MNEMONIC);

    const reloaded = await db.loadWallet();
    expectSeedLocked(reloaded);

    // Saving while locked keeps the plaintext: it is the only copy
    await db.saveWallet(reloaded);
    expect(await backend.rawSeed(db)).toMatchObject({ mnemonic: MNEMONIC });

    expect(await reloaded.unlock(PASSWORD)).toBe(true);
    await db.saveWallet(reloaded);
    const raw = await backend.rawSeed(db);
    expect(raw).toMatchObject({ mnemonic: null });
    expect(typeof raw!.encryptedSeed).toBe('string');

    const again = await db.loadWallet();
    expect(await again.unlock(PASSWORD)).toBe(true);
    expect(again.getMnemonic()).toBe(MNEMONIC);
  });

  it('drops the encryption metadata when an unencrypted wallet replaces it', async () => {
    db = await backend.open();
    const km = await db.restoreWalletFromMnemonic(MNEMONIC, 0);
    await km.setPassword(PASSWORD);
    await db.saveWallet(km);

    await db.restoreWalletFromMnemonic(OTHER_MNEMONIC, 0);
    const reloaded = await db.loadWallet();
    expect(reloaded.isEncrypted()).toBe(false);
    expect(reloaded.getMnemonic()).toBe(OTHER_MNEMONIC);
  });
});
