import 'fake-indexeddb/auto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Scalar } from '@nav-io/navio-blsct';
import { KeyManager } from './key-manager';
import { WalletDB } from './wallet-db';
import { IndexedDBWalletDB } from './adapters/indexeddb-wallet-db';
import { TransactionKeysSync } from './tx-keys-sync';
import { blindingPublicKeyHex, deriveBlindingKey } from './blinding-key';
import {
  SEALED_BLINDING_KEY_PREFIX,
  ensureOutputBlindingKeysSealed,
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

  async function checkBackend(
    db: IWalletDB,
    createdAt: (outputHash: string) => Promise<number>,
    backdate: (outputHash: string, at: number) => Promise<void>
  ): Promise<void> {
    // Rows written before the wallet was encrypted, or by navio-sdk 0.4.
    await db.saveOutputBlindingKey(OUTPUT_A, SCALAR);
    await db.saveOutputBlindingKey(OUTPUT_B, await sealOutputBlindingKey(km, '2e'.repeat(32)));
    await backdate(OUTPUT_A, 1_000);

    // Only the plaintext row is returned.
    expect(await db.getUnsealedOutputBlindingKeys()).toEqual([
      { outputHash: OUTPUT_A, blindingKey: SCALAR },
    ]);

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
    expect(await openOutputBlindingKey(km, (await db.getOutputBlindingKey(OUTPUT_B))!)).toBe(
      '2e'.repeat(32)
    );

    // Sealed in place: the row keeps its creation time.
    expect(await createdAt(OUTPUT_A)).toBe(1_000);

    // Nothing left in plaintext, and a second run changes nothing.
    expect(await db.getUnsealedOutputBlindingKeys()).toEqual([]);
    expect(await sealPlaintextOutputBlindingKeys(db, km)).toBe(0);

    // The in-place replace is a compare-and-set.
    expect(await db.replaceOutputBlindingKey(OUTPUT_A, SCALAR, 'ff'.repeat(32))).toBe(false);
    expect(await db.getOutputBlindingKey(OUTPUT_A)).toBe(sealedA);
    expect(await db.replaceOutputBlindingKey(OUTPUT_A, sealedA, sealedA)).toBe(true);
    expect(await db.replaceOutputBlindingKey('cc'.repeat(32), SCALAR, SCALAR)).toBe(false);
    expect(await db.getOutputBlindingKey('cc'.repeat(32))).toBeNull();

    // An unencrypted wallet's rows stay plaintext.
    expect(await sealPlaintextOutputBlindingKeys(db, wallet())).toBe(0);
  }

  it('encrypts the plaintext rows of an encrypted wallet (SQLite)', async () => {
    const db = new WalletDB({ type: 'better-sqlite3' });
    await db.open(':memory:');
    const adapter = (db as any).adapter;
    await checkBackend(
      db,
      async hash => {
        const rows = await adapter.exec(
          `SELECT created_at FROM output_blinding_keys WHERE output_hash = '${hash}'`
        );
        return Number(rows[0].values[0][0]);
      },
      async (hash, at) => {
        await adapter.run('UPDATE output_blinding_keys SET created_at = ? WHERE output_hash = ?', [
          at,
          hash,
        ]);
      }
    );
    await db.close();
  });

  it('encrypts the plaintext rows of an encrypted wallet (IndexedDB)', async () => {
    const db = new IndexedDBWalletDB();
    await db.open(PATH);
    const record = async (hash: string) => (db as any).get('outputBlindingKeys', hash);
    await checkBackend(
      db,
      async hash => (await record(hash)).createdAt,
      async (hash, at) => {
        await (db as any).put('outputBlindingKeys', { ...(await record(hash)), createdAt: at });
      }
    );
    await db.close();
  });
});

describe('ensureOutputBlindingKeysSealed', () => {
  let km: KeyManager;

  beforeAll(async () => {
    km = await encryptedWallet();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('seals once per database, then stops scanning', async () => {
    const db = new WalletDB({ type: 'better-sqlite3' });
    await db.open(':memory:');
    await db.saveOutputBlindingKey(OUTPUT_A, SCALAR);
    const scan = vi.spyOn(db, 'getUnsealedOutputBlindingKeys');

    await ensureOutputBlindingKeysSealed(db, km);
    await ensureOutputBlindingKeysSealed(db, km);

    expect(scan).toHaveBeenCalledTimes(1);
    expect(isSealedBlindingKey((await db.getOutputBlindingKey(OUTPUT_A))!)).toBe(true);
    await db.close();
  });

  it('waits for an unlock rather than marking a locked wallet done', async () => {
    const db = new WalletDB({ type: 'better-sqlite3' });
    await db.open(':memory:');
    await db.saveOutputBlindingKey(OUTPUT_A, SCALAR);
    km.lock();
    try {
      await ensureOutputBlindingKeysSealed(db, km);
      expect(await db.getOutputBlindingKey(OUTPUT_A)).toBe(SCALAR);
    } finally {
      await km.unlock(PASSWORD);
    }
    await ensureOutputBlindingKeysSealed(db, km);
    expect(isSealedBlindingKey((await db.getOutputBlindingKey(OUTPUT_A))!)).toBe(true);
    await db.close();
  });

  it('warns on a persistent failure, keeps retrying, and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let failing = true;
    const rows = new Map([[OUTPUT_A, SCALAR]]);
    const db = {
      getUnsealedOutputBlindingKeys: vi.fn(async () => {
        if (failing) throw new Error('disk I/O error');
        return [...rows].map(([outputHash, blindingKey]) => ({ outputHash, blindingKey }));
      }),
      replaceOutputBlindingKey: vi.fn(async (hash: string, _expected: string, next: string) => {
        rows.set(hash, next);
        return true;
      }),
    };

    for (let i = 0; i < 5; i++) {
      await ensureOutputBlindingKeysSealed(db, km);
    }
    expect(db.getUnsealedOutputBlindingKeys).toHaveBeenCalledTimes(5);
    // Attempts 1, 2 and 4: visible, but not once per call.
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0][0])).toMatch(/plaintext/);

    failing = false;
    await ensureOutputBlindingKeysSealed(db, km);
    expect(isSealedBlindingKey(rows.get(OUTPUT_A)!)).toBe(true);
    await ensureOutputBlindingKeysSealed(db, km);
    expect(db.getUnsealedOutputBlindingKeys).toHaveBeenCalledTimes(6);
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
    await (sync as any).backfillBlindingKey(
      OUTPUT_A,
      anchor,
      [anchor],
      blindingPublicKeyHex(scalar)
    );

    const record = (await db.getOutputBlindingKey(OUTPUT_A))!;
    expect(isSealedBlindingKey(record)).toBe(true);
    expect(await openOutputBlindingKey(km, record)).toBe(scalar.serialize().padStart(64, '0'));

    // Skipped while locked: sync keeps running without the seed.
    km.lock();
    const other = deriveBlindingKey(Scalar.deserialize('07'.repeat(32)), anchor, 0, 0);
    await (sync as any).backfillBlindingKey(
      OUTPUT_B,
      anchor,
      [anchor],
      blindingPublicKeyHex(other)
    );
    expect(await db.getOutputBlindingKey(OUTPUT_B)).toBeNull();
    await db.close();
  });

  it('seals plaintext rows left by an earlier version', async () => {
    const km = await encryptedWallet();
    const db = new WalletDB({ type: 'better-sqlite3' });
    await db.open(':memory:');
    await db.saveOutputBlindingKey(OUTPUT_B, SCALAR);
    const sync = new TransactionKeysSync(db, {} as any);
    sync.setKeyManager(km);

    // Even a backfill that finds nothing seals the table. (One generation
    // reserved keeps the miss cheap.)
    const anchor = 'de'.repeat(31) + '01';
    await db.reserveBlindingGeneration(anchor);
    const stranger = blindingPublicKeyHex(Scalar.deserialize('3b'.repeat(32)));
    await (sync as any).backfillBlindingKey(OUTPUT_A, anchor, [anchor], stranger);

    const record = (await db.getOutputBlindingKey(OUTPUT_B))!;
    expect(isSealedBlindingKey(record)).toBe(true);
    expect(await openOutputBlindingKey(km, record)).toBe(SCALAR);
    expect(await db.getOutputBlindingKey(OUTPUT_A)).toBeNull();
    await db.close();
  });

  it("bounds the anchor's generations by this database's counter", async () => {
    const km = wallet();
    const db = new WalletDB({ type: 'better-sqlite3' });
    await db.open(':memory:');
    const sync = new TransactionKeysSync(db, {} as any);
    sync.setKeyManager(km);
    const seed = km.getMasterSeedKey();
    const anchor = 'de'.repeat(31) + '01';
    const fallback = 'ab'.repeat(32);
    const backfill = (outputHash: string, key: InstanceType<typeof Scalar>) =>
      (sync as any).backfillBlindingKey(
        outputHash,
        anchor,
        [anchor, fallback, anchor],
        blindingPublicKeyHex(key)
      );

    // No counter, as after a seed-only restore: every generation is searched.
    await backfill(OUTPUT_A, deriveBlindingKey(seed, anchor, 1, 5));
    expect(await db.getOutputBlindingKey(OUTPUT_A)).not.toBeNull();

    // Two generations handed out here: generation 5 is not looked for…
    await db.reserveBlindingGeneration(anchor);
    await db.reserveBlindingGeneration(anchor);
    await backfill(OUTPUT_B, deriveBlindingKey(seed, anchor, 1, 5));
    expect(await db.getOutputBlindingKey(OUTPUT_B)).toBeNull();
    // …generation 1 is.
    const gen1 = deriveBlindingKey(seed, anchor, 1, 1);
    await backfill(OUTPUT_B, gen1);
    expect(await db.getOutputBlindingKey(OUTPUT_B)).toBe(gen1.serialize().padStart(64, '0'));

    // A fallback input gets generation 0 and the legacy layout only.
    const OUTPUT_C = 'c3'.repeat(32);
    await backfill(OUTPUT_C, deriveBlindingKey(seed, fallback, 0, 1));
    expect(await db.getOutputBlindingKey(OUTPUT_C)).toBeNull();
    const fallbackGen0 = deriveBlindingKey(seed, fallback, 0, 0);
    await backfill(OUTPUT_C, fallbackGen0);
    expect(await db.getOutputBlindingKey(OUTPUT_C)).toBe(
      fallbackGen0.serialize().padStart(64, '0')
    );
    await db.close();
  });
});
