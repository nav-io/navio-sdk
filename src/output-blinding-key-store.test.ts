import 'fake-indexeddb/auto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Scalar } from '@nav-io/navio-blsct';
import { KeyManager } from './key-manager';
import { WalletDB } from './wallet-db';
import { IndexedDBWalletDB } from './adapters/indexeddb-wallet-db';
import { TransactionKeysSync } from './tx-keys-sync';
import { blindingPublicKeyHex, deriveBlindingKey } from './blinding-key';
import {
  SEALED_BLINDING_KEY_PREFIX,
  isSealedBlindingKey,
  openOutputBlindingKey,
  sealOutputBlindingKey,
  sealPlaintextOutputBlindingKeys,
} from './output-blinding-key-store';
import type { IWalletDB } from './wallet-db.interface';

const MNEMONIC =
  'short exact vendor hand scale enroll around pudding genius party lesson basket cook crash sugar protect advance gentle humor bench farm weekend direct awkward';
const PASSWORD = 'correct horse battery staple';
const SCALAR = '1f'.repeat(32);
const OUTPUT_A = 'a1'.repeat(32);
const OUTPUT_B = 'b2'.repeat(32);

function wallet(): KeyManager {
  const km = new KeyManager();
  km.setHDSeedFromMnemonic(MNEMONIC);
  return km;
}

async function encryptedWallet(): Promise<KeyManager> {
  const km = wallet();
  await km.setPassword(PASSWORD);
  return km;
}

describe('KeyManager.encryptSecret / decryptSecret', () => {
  let km: KeyManager;

  beforeAll(async () => {
    km = await encryptedWallet();
  });

  it('round-trips a secret, and the ciphertext does not contain it', async () => {
    const secret = new Uint8Array(32).fill(0x1f);
    const sealed = await km.encryptSecret(secret);

    expect(Buffer.from(sealed).toString('hex')).not.toContain(SCALAR);
    expect(await km.decryptSecret(sealed)).toEqual(secret);
    // Fresh IV per call.
    expect(await km.encryptSecret(secret)).not.toEqual(sealed);
  });

  it('refuses while locked and on an unencrypted wallet', async () => {
    const sealed = await km.encryptSecret(new Uint8Array([1, 2, 3]));
    km.lock();
    await expect(km.encryptSecret(new Uint8Array([1]))).rejects.toThrow(/locked/);
    await expect(km.decryptSecret(sealed)).rejects.toThrow(/locked/);
    expect(await km.unlock(PASSWORD)).toBe(true);
    expect(await km.decryptSecret(sealed)).toEqual(new Uint8Array([1, 2, 3]));

    const plain = wallet();
    await expect(plain.encryptSecret(new Uint8Array([1]))).rejects.toThrow(/not encrypted/);
  });

  it('does not decrypt a secret sealed under an earlier password', async () => {
    const other = await encryptedWallet();
    const sealed = await other.encryptSecret(new Uint8Array([9]));
    expect(await other.changePassword(PASSWORD, 'new password')).toBe(true);
    await expect(other.decryptSecret(sealed)).rejects.toThrow();
  });
});

describe('sealOutputBlindingKey / openOutputBlindingKey', () => {
  let km: KeyManager;

  beforeAll(async () => {
    km = await encryptedWallet();
  });

  it('keeps the scalar as-is for an unencrypted wallet', async () => {
    const plain = wallet();
    expect(await sealOutputBlindingKey(plain, SCALAR)).toBe(SCALAR);
    expect(await openOutputBlindingKey(plain, SCALAR)).toBe(SCALAR);
  });

  it('encrypts the scalar for an encrypted wallet, distinguishably from plaintext', async () => {
    const record = await sealOutputBlindingKey(km, SCALAR);

    expect(record.startsWith(SEALED_BLINDING_KEY_PREFIX)).toBe(true);
    expect(isSealedBlindingKey(record)).toBe(true);
    expect(isSealedBlindingKey(SCALAR)).toBe(false);
    expect(record).not.toContain(SCALAR);
    expect(await openOutputBlindingKey(km, record)).toBe(SCALAR);
  });

  it('opens to null while locked, and on a record it cannot decrypt', async () => {
    const record = await sealOutputBlindingKey(km, SCALAR);
    km.lock();
    try {
      await expect(sealOutputBlindingKey(km, SCALAR)).rejects.toThrow(/locked/);
      expect(await openOutputBlindingKey(km, record)).toBeNull();
    } finally {
      await km.unlock(PASSWORD);
    }
    expect(await openOutputBlindingKey(km, `${SEALED_BLINDING_KEY_PREFIX}00ff`)).toBeNull();
  });
});

describe('sealPlaintextOutputBlindingKeys', () => {
  const PATH = 'blinding-key-sealing';
  let km: KeyManager;

  beforeAll(async () => {
    km = await encryptedWallet();
  });

  afterEach(async () => {
    await IndexedDBWalletDB.deleteDatabase(PATH);
  });

  async function checkBackend(db: IWalletDB): Promise<void> {
    // Rows written before the wallet was encrypted, or by navio-sdk 0.4.
    await db.saveOutputBlindingKey(OUTPUT_A, SCALAR);
    await db.saveOutputBlindingKey(OUTPUT_B, await sealOutputBlindingKey(km, '2e'.repeat(32)));

    // Locked: nothing to do with, so nothing done.
    km.lock();
    expect(await sealPlaintextOutputBlindingKeys(db, km)).toBe(0);
    expect(await db.getOutputBlindingKey(OUTPUT_A)).toBe(SCALAR);
    await km.unlock(PASSWORD);

    expect(await sealPlaintextOutputBlindingKeys(db, km)).toBe(1);
    const sealedA = (await db.getOutputBlindingKey(OUTPUT_A))!;
    expect(isSealedBlindingKey(sealedA)).toBe(true);
    expect(sealedA).not.toContain(SCALAR);
    expect(await openOutputBlindingKey(km, sealedA)).toBe(SCALAR);
    expect(await openOutputBlindingKey(km, (await db.getOutputBlindingKey(OUTPUT_B))!))
      .toBe('2e'.repeat(32));

    // Nothing left in plaintext, and a second run changes nothing.
    for (const { blindingKey } of await db.getAllOutputBlindingKeys()) {
      expect(isSealedBlindingKey(blindingKey)).toBe(true);
    }
    expect(await sealPlaintextOutputBlindingKeys(db, km)).toBe(0);

    // An unencrypted wallet's rows stay plaintext.
    expect(await sealPlaintextOutputBlindingKeys(db, wallet())).toBe(0);
  }

  it('encrypts the plaintext rows of an encrypted wallet (SQLite)', async () => {
    const db = new WalletDB({ type: 'better-sqlite3' });
    await db.open(':memory:');
    await checkBackend(db);
    await db.close();
  });

  it('encrypts the plaintext rows of an encrypted wallet (IndexedDB)', async () => {
    const db = new IndexedDBWalletDB();
    await db.open(PATH);
    await checkBackend(db);
    await db.close();
  });
});

describe('TransactionKeysSync blinding-key backfill', () => {
  it('stores the recovered scalar encrypted for an encrypted wallet', async () => {
    const km = await encryptedWallet();
    const db = new WalletDB({ type: 'better-sqlite3' });
    await db.open(':memory:');
    const sync = new TransactionKeysSync(db, {} as any);
    sync.setKeyManager(km);

    const anchor = 'de'.repeat(31) + '01';
    const scalar = deriveBlindingKey(km.getMasterSeedKey(), anchor, 0, 2);
    await (sync as any).backfillBlindingKey(OUTPUT_A, [anchor], blindingPublicKeyHex(scalar));

    const record = (await db.getOutputBlindingKey(OUTPUT_A))!;
    expect(isSealedBlindingKey(record)).toBe(true);
    expect(await openOutputBlindingKey(km, record)).toBe(scalar.serialize().padStart(64, '0'));

    // Skipped while locked: sync keeps running without the seed.
    km.lock();
    const other = deriveBlindingKey(Scalar.deserialize('07'.repeat(32)), anchor, 0, 0);
    await (sync as any).backfillBlindingKey(OUTPUT_B, [anchor], blindingPublicKeyHex(other));
    expect(await db.getOutputBlindingKey(OUTPUT_B)).toBeNull();
    await db.close();
  });
});
