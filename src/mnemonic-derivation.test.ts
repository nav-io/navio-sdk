import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import * as blsctModule from '@nav-io/navio-blsct';
import { KeyManager } from './key-manager';
import { WalletDB } from './wallet-db';
import { IndexedDBWalletDB } from './adapters/indexeddb-wallet-db';
import { bip39SeedRaw, deriveMasterSK } from './crypto/eip2333';
import { encryptWithKey } from './crypto';
import { NavioClient, type NavioClientConfig } from './client';

const Scalar = blsctModule.Scalar;

const MNEMONIC =
  'short exact vendor hand scale enroll around pudding genius party lesson basket cook crash sugar protect advance gentle humor bench farm weekend direct awkward';
// MNEMONIC with the Navio birthday words for t=1783000000
const BIRTHDAY_MNEMONIC = `${MNEMONIC} addict basic`;
const MNEMONIC_ENTROPY = 'c6c9cbc8b46c0096430d6960f412018992fa64f6356503ec25bc0a8533f20fa0';
// The legacy master key: MNEMONIC_ENTROPY read as a scalar, i.e. reduced mod r
const LEGACY_MASTER = (
  BigInt('0x' + MNEMONIC_ENTROPY) % 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n
)
  .toString(16)
  .padStart(64, '0');
const MNEMONIC_12 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSPHRASE = 'navio-sdk test';
const PASSWORD = 'correct horse battery staple';

// Cross-implementation vectors for MNEMONIC.
// Audit keys (view key || spend public key): navio-core v0.2.1 regtest,
// `createwallet` with mnemonic=MNEMONIC (and mnemonic_passphrase), then
// `getblsctauditkey`. The birthday variant BIRTHDAY_MNEMONIC gives the same
// keys. Master keys: navio-electrum's derive_master_sk (navio_blsct.py, run
// standalone), which agrees with the audit keys through ChildKey.
const CORE = {
  master: '4abadbad8bba136ca7662a8762c1be0e792a7e1c2761318867567506cc45a90f',
  auditKey:
    '3a100b5e8e5de8585528476a4b769b2a76f8a604355ab54826457531c1015a488829e83022600a4fe171fd858d57c61c3017f76fb8f9400299a5dd44f9efe29e5fec2d614d19de691952ef9fd7fa2158',
};
const CORE_PASSPHRASE = {
  master: '581a85ecce873e21d2dcb7120d5dead99d6aa9089abd017ae825e524949a26f1',
  auditKey:
    '1a1d7c7f9147e5797663839e5f642c8a46aa3fde203147a3efb76ffc8a8deec78d68d2d48c157e4fcb0836bd32116c4603d233f2c6a0cefb745000e3239106f7d7a6ca9678dab8d32286f102369202ba',
};
// navio-core v0.2.1, mnemonic_passphrase "pässwörd" (precomposed, as UTF-8):
// used as raw bytes, without BIP39 NFKD normalization
const NON_ASCII_PASSPHRASE = 'pässwörd';
const CORE_NON_ASCII_AUDIT_KEY =
  '29c7008613c8276b0015cacd48b0eaf76dd1e8fed6f7ab2ce65a84412fb1030096e1dc6968a3ee25c9dc5fda49d61140cc61318b2942a6848738ce0991c096288d469ecfb59d14d7b6e18ebaad69c11a';

function wallet(mnemonic: string, options?: Parameters<KeyManager['setHDSeedFromMnemonic']>[1]) {
  const km = new KeyManager();
  km.setHDSeedFromMnemonic(mnemonic, options);
  km.newSubAddressPool(0);
  km.newSubAddressPool(-1);
  km.newSubAddressPool(-2);
  return km;
}

function toBigInt(bytes: Uint8Array): bigint {
  return BigInt('0x' + Buffer.from(bytes).toString('hex'));
}

describe('EIP-2333 derive_master_SK', () => {
  // Official EIP-2333 test vectors, as in navio-core's bls12_381_keygen_tests
  const vectors = [
    [
      'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',
      '6083874454709270928345386274498605044986640685124978867557563392430687146096',
    ],
    [
      '3141592653589793238462643383279502884197169399375105820974944592',
      '29757020647961307431480504535336562678282505419141012933316116377660817309383',
    ],
    [
      '0099FF991111002299DD7744EE3355BBDD8844115566CC55663355668888CC00',
      '27580842291869792442942448775674722299803720648445448686099262467207037398656',
    ],
    [
      'd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3',
      '19022158461524446591288038168518313374041767046816487870552872741050760015818',
    ],
  ];

  it.each(vectors)('matches the EIP-2333 vector for seed %s', (seedHex, masterSK) => {
    const sk = deriveMasterSK(Uint8Array.from(Buffer.from(seedHex, 'hex')));
    expect(sk).toHaveLength(32);
    expect(toBigInt(sk)).toBe(BigInt(masterSK));
  });

  it('rejects a seed shorter than 32 bytes', () => {
    expect(() => deriveMasterSK(new Uint8Array(31))).toThrow('256-bit');
  });

  it('derives the EIP-2333 vector 0 seed from its BIP39 mnemonic', () => {
    // EIP-2333 test case 0 is the BIP39 seed of MNEMONIC_12 with "TREZOR"
    expect(Buffer.from(bip39SeedRaw(MNEMONIC_12, 'TREZOR')).toString('hex')).toBe(vectors[0][0]);
  });
});

describe('mnemonic derivation', () => {
  it('defaults to navio-core derivation', () => {
    const km = wallet(MNEMONIC);
    expect(km.getMnemonicDerivation()).toBe('core');
    expect(km.getMasterSeedHex()).toBe(CORE.master);
    expect(km.getAuditKeyHex()).toBe(CORE.auditKey);
    expect(km.getMnemonic()).toBe(MNEMONIC);
  });

  it('derives with a passphrase as navio-core does', () => {
    const km = wallet(MNEMONIC, { passphrase: PASSPHRASE });
    expect(km.getMasterSeedHex()).toBe(CORE_PASSPHRASE.master);
    expect(km.getAuditKeyHex()).toBe(CORE_PASSPHRASE.auditKey);
  });

  it('uses a non-ASCII passphrase as raw UTF-8, as navio-core does', () => {
    expect(wallet(MNEMONIC, { passphrase: NON_ASCII_PASSPHRASE }).getAuditKeyHex()).toBe(
      CORE_NON_ASCII_AUDIT_KEY
    );
    // No NFKD: the decomposed spelling is a different wallet
    const decomposed = NON_ASCII_PASSPHRASE.normalize('NFD');
    expect(decomposed).not.toBe(NON_ASCII_PASSPHRASE);
    expect(wallet(MNEMONIC, { passphrase: decomposed }).getAuditKeyHex()).not.toBe(
      CORE_NON_ASCII_AUDIT_KEY
    );
  });

  it('derives a birthday mnemonic from its 24 base words', () => {
    const km = wallet(BIRTHDAY_MNEMONIC);
    expect(km.getAuditKeyHex()).toBe(CORE.auditKey);
    expect(km.getMnemonic()).toBe(BIRTHDAY_MNEMONIC);
    expect(wallet(BIRTHDAY_MNEMONIC, { passphrase: PASSPHRASE }).getAuditKeyHex()).toBe(
      CORE_PASSPHRASE.auditKey
    );
  });

  it('keeps the legacy derivation on request', () => {
    const km = wallet(MNEMONIC, { derivation: 'legacy' });
    expect(km.getMnemonicDerivation()).toBe('legacy');
    expect(km.getMasterSeedHex()).toBe(LEGACY_MASTER);
    expect(km.getAuditKeyHex()).not.toBe(CORE.auditKey);
  });

  it('accepts 12 words only with the legacy derivation', () => {
    expect(() => wallet(MNEMONIC_12)).toThrow("Derivation 'core' needs a 24-word mnemonic");
    expect(() => wallet(MNEMONIC_12, { derivation: 'legacy' })).not.toThrow();
  });

  it('refuses a passphrase with the legacy derivation', () => {
    expect(() => wallet(MNEMONIC, { derivation: 'legacy', passphrase: 'x' })).toThrow(
      "requires derivation 'core'"
    );
  });

  it('creates new wallets with the core derivation', () => {
    const km = new KeyManager();
    const mnemonic = km.generateNewMnemonic();
    expect(mnemonic.split(' ')).toHaveLength(24);
    expect(km.getMnemonicDerivation()).toBe('core');
    expect(km.getMasterSeedHex()).toBe(
      KeyManager.mnemonicToScalar(mnemonic).serialize().padStart(64, '0')
    );
    expect(() => new KeyManager().generateNewMnemonic(128)).toThrow('24-word');
  });

  it('refuses a non-ASCII passphrase for a new wallet', () => {
    expect(() => new KeyManager().generateNewMnemonic(256, { passphrase: NON_ASCII_PASSPHRASE })).toThrow(
      'must be ASCII'
    );
  });

  it('has no derivation for a wallet imported from a seed', () => {
    const km = wallet(MNEMONIC);
    km.setHDSeed(Scalar.deserialize(CORE.master));
    expect(km.getMnemonicDerivation()).toBeNull();
    // The seed's entropy encoding, which restores it only with 'legacy'
    const phrase = km.getMnemonic();
    expect(phrase).not.toBe(MNEMONIC);
    expect(wallet(phrase, { derivation: 'legacy' }).getMasterSeedHex()).toBe(CORE.master);
    expect(wallet(phrase).getMasterSeedHex()).not.toBe(CORE.master);
  });
});

describe('mnemonic derivation storage', () => {
  const IDB_PATH = 'mnemonic-derivation';
  let db: WalletDB | IndexedDBWalletDB | null = null;

  afterEach(async () => {
    if (db) {
      await db.close();
      db = null;
    }
    await IndexedDBWalletDB.deleteDatabase(IDB_PATH);
  });

  async function sqlite(): Promise<WalletDB> {
    const opened = new WalletDB({ type: 'better-sqlite3' });
    await opened.open(':memory:');
    db = opened;
    return opened;
  }

  async function idb(): Promise<IndexedDBWalletDB> {
    const opened = new IndexedDBWalletDB();
    await opened.open(IDB_PATH);
    db = opened;
    return opened;
  }

  it('SQLite: stores the derivation and passphrase with the mnemonic', async () => {
    const sql = await sqlite();
    await sql.restoreWalletFromMnemonic(MNEMONIC, 0, { passphrase: PASSPHRASE });
    const row = await (sql as any).adapter.exec(
      'SELECT mnemonic, mnemonic_derivation, mnemonic_passphrase FROM master_seed WHERE id = 0'
    );
    expect(row[0].values[0]).toEqual([MNEMONIC, 'core', PASSPHRASE]);

    const loaded = await sql.loadWallet();
    expect(loaded.getMnemonicDerivation()).toBe('core');
    expect(loaded.getAuditKeyHex()).toBe(CORE_PASSPHRASE.auditKey);
    expect(loaded.getMnemonic()).toBe(MNEMONIC);
  });

  it('SQLite: restores and reloads a legacy wallet', async () => {
    const sql = await sqlite();
    await sql.restoreWalletFromMnemonic(MNEMONIC, 0, { derivation: 'legacy' });
    const loaded = await sql.loadWallet();
    expect(loaded.getMnemonicDerivation()).toBe('legacy');
    expect(loaded.getMasterSeedHex()).toBe(LEGACY_MASTER);
  });

  it('SQLite: loads a seed row without a derivation as legacy', async () => {
    const sql = await sqlite();
    await sql.restoreWalletFromMnemonic(MNEMONIC, 0, { derivation: 'legacy' });
    // As navio-sdk 0.4.0 wrote it
    await (sql as any).adapter.run('UPDATE master_seed SET mnemonic_derivation = NULL');
    const loaded = await sql.loadWallet();
    expect(loaded.getMnemonicDerivation()).toBe('legacy');
    expect(loaded.getMasterSeedHex()).toBe(LEGACY_MASTER);
  });

  it('SQLite: keeps the derivation and passphrase inside the encrypted seed', async () => {
    const sql = await sqlite();
    const km = await sql.restoreWalletFromMnemonic(MNEMONIC, 0, { passphrase: PASSPHRASE });
    await km.setPassword(PASSWORD);
    await sql.saveWallet(km);

    const row = await (sql as any).adapter.exec(
      'SELECT mnemonic, mnemonic_derivation, mnemonic_passphrase, encrypted_seed FROM master_seed'
    );
    expect(row[0].values[0].slice(0, 3)).toEqual([null, null, null]);
    expect(typeof row[0].values[0][3]).toBe('string');

    const loaded = await sql.loadWallet();
    expect(await loaded.unlock(PASSWORD)).toBe(true);
    expect(loaded.getMnemonicDerivation()).toBe('core');
    expect(loaded.getMasterSeedHex()).toBe(CORE_PASSPHRASE.master);
    expect(loaded.getMnemonic()).toBe(MNEMONIC);
  });

  it('IndexedDB: stores the derivation and passphrase with the mnemonic', async () => {
    const store = await idb();
    await store.restoreWalletFromMnemonic(MNEMONIC, 0, { passphrase: PASSPHRASE });
    expect(await (store as any).get('config', 'mnemonic')).toEqual({
      key: 'mnemonic',
      mnemonic: MNEMONIC,
      derivation: 'core',
      passphrase: PASSPHRASE,
    });

    const loaded = await store.loadWallet();
    expect(loaded.getMnemonicDerivation()).toBe('core');
    expect(loaded.getAuditKeyHex()).toBe(CORE_PASSPHRASE.auditKey);
  });

  it('IndexedDB: loads a seed record without a derivation as legacy', async () => {
    const store = await idb();
    await store.restoreWalletFromMnemonic(MNEMONIC, 0, { derivation: 'legacy' });
    // As navio-sdk 0.4.0 wrote it
    await (store as any).put('config', { key: 'mnemonic', mnemonic: MNEMONIC });
    const loaded = await store.loadWallet();
    expect(loaded.getMnemonicDerivation()).toBe('legacy');
    expect(loaded.getMasterSeedHex()).toBe(LEGACY_MASTER);
  });

  it('IndexedDB: keeps the derivation and passphrase inside the encrypted seed', async () => {
    const store = await idb();
    const km = await store.restoreWalletFromMnemonic(MNEMONIC, 0, { passphrase: PASSPHRASE });
    await km.setPassword(PASSWORD);
    await store.saveWallet(km);
    const record = await (store as any).get('config', 'mnemonic');
    expect(Object.keys(record).sort()).toEqual(['encryptedSeed', 'key']);

    const loaded = await store.loadWallet();
    expect(await loaded.unlock(PASSWORD)).toBe(true);
    expect(loaded.getMnemonicDerivation()).toBe('core');
    expect(loaded.getMasterSeedHex()).toBe(CORE_PASSPHRASE.master);
  });

  it('decrypts an encrypted seed without a derivation as legacy', async () => {
    const km = wallet(MNEMONIC, { derivation: 'legacy' });
    await km.setPassword(PASSWORD);
    // Re-encrypt the seed as navio-sdk before versioned derivations did
    const legacyRecord = new TextEncoder().encode(JSON.stringify({ mnemonic: MNEMONIC }));
    const encrypted = await encryptWithKey(
      legacyRecord,
      (km as any).encryptionKey,
      (km as any).encryptionSalt
    );
    (km as any).cryptedSeed = (km as any).serializeEncryptedToBytes(encrypted);
    km.lock();

    expect(await km.unlock(PASSWORD)).toBe(true);
    expect(km.getMnemonicDerivation()).toBe('legacy');
    expect(km.getMasterSeedHex()).toBe(LEGACY_MASTER);
  });
});

describe('NavioClient mnemonic derivation', () => {
  const clients: NavioClient[] = [];
  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.disconnect()));
  });

  async function initialize(config: Partial<NavioClientConfig>): Promise<NavioClient> {
    const client = new NavioClient({
      network: 'testnet',
      backend: 'electrum',
      electrum: { host: 'localhost', port: 50005 },
      walletDbPath: ':memory:',
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

  it('restores with navio-core derivation and the passphrase', async () => {
    const client = await initialize({
      restoreFromMnemonic: MNEMONIC,
      mnemonicPassphrase: PASSPHRASE,
    });
    expect(client.getKeyManager().getAuditKeyHex()).toBe(CORE_PASSPHRASE.auditKey);
  });

  it('restores with the legacy derivation on request', async () => {
    const client = await initialize({
      restoreFromMnemonic: MNEMONIC,
      mnemonicDerivation: 'legacy',
    });
    expect(client.getKeyManager().getMnemonicDerivation()).toBe('legacy');
    expect(client.getKeyManager().getMasterSeedHex()).toBe(LEGACY_MASTER);
  });

  it('creates a new wallet with navio-core derivation and the passphrase', async () => {
    const client = await initialize({
      createWalletIfNotExists: true,
      creationHeight: 0,
      mnemonicPassphrase: PASSPHRASE,
    });
    const km = client.getKeyManager();
    expect(km.getMnemonicDerivation()).toBe('core');
    expect(km.getMasterSeedHex()).toBe(
      KeyManager.mnemonicToScalar(km.getMnemonic(), { passphrase: PASSPHRASE })
        .serialize()
        .padStart(64, '0')
    );
  });
});
