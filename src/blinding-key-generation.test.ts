import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scalar } from '@nav-io/navio-blsct';
import {
  BlindingKeyAllocator,
  MAX_GENERATION_SEARCH,
  blindingPublicKeyHex,
  deriveBlindingKey,
  searchBlindingKey,
} from './blinding-key';
import { NavioClient } from './client';
import { WalletDB } from './wallet-db';
import { IndexedDBWalletDB } from './adapters/indexeddb-wallet-db';
import type { IWalletDB, WalletOutput } from './wallet-db.interface';

const ANCHOR = 'de'.repeat(31) + '01';
const OTHER = 'ab'.repeat(32);

function makeClient(walletDB: Partial<IWalletDB>, seed = Scalar.deserialize('07'.repeat(32))) {
  const client = new NavioClient({
    network: 'testnet',
    backend: 'electrum',
    electrum: { host: 'testnet.nav.io', port: 50005 },
    walletDbPath: ':memory:',
  });
  (client as any).walletDB = walletDB;
  (client as any).keyManager = {
    isEncrypted: () => false,
    isUnlocked: () => true,
    getMasterSeedKey: () => seed,
  };
  return { client, seed };
}

function inputs(...outids: string[]): Array<{ output: WalletOutput }> {
  return outids.map((outputHash) => ({ output: { outputHash } as WalletOutput }));
}

function allocate(client: NavioClient, ...outids: string[]): Promise<BlindingKeyAllocator> {
  return (client as any).makeBlindingKeyAllocator(inputs(...outids));
}

describe('WalletDB.reserveBlindingGeneration', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('hands out increasing generations per anchor', async () => {
    const db = new WalletDB({ type: 'better-sqlite3' });
    await db.open(':memory:');

    expect(await db.reserveBlindingGeneration(ANCHOR)).toBe(0);
    expect(await db.reserveBlindingGeneration(ANCHOR)).toBe(1);
    expect(await db.reserveBlindingGeneration(OTHER)).toBe(0);
    // Case does not split one anchor into two counters.
    expect(await db.reserveBlindingGeneration(ANCHOR.toUpperCase())).toBe(2);
    await db.close();
  });

  it('never hands out one generation twice to concurrent claims', async () => {
    const db = new WalletDB({ type: 'better-sqlite3' });
    await db.open(':memory:');

    const claimed = await Promise.all(
      Array.from({ length: 10 }, () => db.reserveBlindingGeneration(ANCHOR))
    );
    expect([...claimed].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await db.close();
  });

  it('keeps the counter across a reopen', async () => {
    dir = await mkdtemp(join(tmpdir(), 'navio-blinding-gen-'));
    const path = join(dir, 'wallet.db');

    const first = new WalletDB({ type: 'better-sqlite3' });
    await first.open(path);
    expect(await first.reserveBlindingGeneration(ANCHOR)).toBe(0);
    await first.close();

    const second = new WalletDB({ type: 'better-sqlite3' });
    await second.open(path);
    expect(await second.reserveBlindingGeneration(ANCHOR)).toBe(1);
    await second.close();
  });
});

describe('IndexedDBWalletDB.reserveBlindingGeneration', () => {
  const PATH = 'blinding-generations';

  afterEach(async () => {
    await IndexedDBWalletDB.deleteDatabase(PATH);
  });

  it('hands out increasing generations, never one twice, and keeps them across a reopen', async () => {
    const db = new IndexedDBWalletDB();
    await db.open(PATH);

    expect(await db.reserveBlindingGeneration(ANCHOR)).toBe(0);
    const claimed = await Promise.all(
      Array.from({ length: 5 }, () => db.reserveBlindingGeneration(ANCHOR))
    );
    expect([...claimed].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(await db.reserveBlindingGeneration(OTHER)).toBe(0);
    await db.close();

    const reopened = new IndexedDBWalletDB();
    await reopened.open(PATH);
    expect(await reopened.reserveBlindingGeneration(ANCHOR)).toBe(6);
    await reopened.close();
  });

  it('adds the store when upgrading a version-5 database', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(IndexedDBWalletDB.getDatabaseName(PATH), 5);
      req.onerror = () => reject(req.error);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('outputBlindingKeys', { keyPath: 'outputHash' });
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
    });

    const db = new IndexedDBWalletDB();
    await db.open(PATH);
    expect(await db.reserveBlindingGeneration(ANCHOR)).toBe(0);
    expect(await db.reserveBlindingGeneration(ANCHOR)).toBe(1);
    await db.close();
  });
});

describe('NavioClient blinding-key generations', () => {
  it('gives two builds on the same inputs different keys, both recoverable', async () => {
    // The audit finding: rebuilding over the same inputs (a resend after an
    // abandoned or failed send) used to derive the same k for a different
    // amount, so two published range proofs shared their randomness.
    const db = new WalletDB({ type: 'better-sqlite3' });
    await db.open(':memory:');
    const { client, seed } = makeClient(db);

    const first = await allocate(client, OTHER, ANCHOR);
    const second = await allocate(client, ANCHOR, OTHER);

    expect(first.anchorOutid).toBe(second.anchorOutid);
    expect(first.generation).toBe(0);
    expect(second.generation).toBe(1);

    const firstKeys = [first.next(), first.next()];
    const secondKeys = [second.next(), second.next()];
    const firstHex = firstKeys.map((k) => k.serialize());
    expect(secondKeys.some((k) => firstHex.includes(k.serialize()))).toBe(false);

    // Each matches navio-core's derivation for its generation…
    expect(firstKeys[1].serialize()).toBe(deriveBlindingKey(seed, first.anchorOutid!, 1, 0).serialize());
    expect(secondKeys[1].serialize()).toBe(deriveBlindingKey(seed, first.anchorOutid!, 1, 1).serialize());

    // …and seed-only recovery finds both.
    for (const [generation, key] of [[0, firstKeys[1]], [1, secondKeys[1]]] as const) {
      const match = searchBlindingKey(seed, [ANCHOR, OTHER], blindingPublicKeyHex(key));
      expect(match!.generation).toBe(generation);
      expect(match!.counter).toBe(1);
    }
    await db.close();
  });

  it('claims the generation before any key is derived', async () => {
    const reserve = vi.fn(async () => 3);
    const { client, seed } = makeClient({ reserveBlindingGeneration: reserve });

    const allocator = await allocate(client, ANCHOR);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith(ANCHOR);
    expect(allocator.next().serialize()).toBe(deriveBlindingKey(seed, ANCHOR, 0, 3).serialize());
  });

  it('falls back to random keys when the generation cannot be persisted', async () => {
    const { client } = makeClient({
      reserveBlindingGeneration: vi.fn(async () => { throw new Error('disk full'); }),
    });
    expect((await allocate(client, ANCHOR)).isDeterministic).toBe(false);
  });

  it('falls back to random keys once an anchor has used every generation', async () => {
    const { client } = makeClient({
      reserveBlindingGeneration: vi.fn(async () => MAX_GENERATION_SEARCH),
    });
    expect((await allocate(client, ANCHOR)).isDeterministic).toBe(false);
  });

  it('claims nothing for random keys', async () => {
    const reserve = vi.fn(async () => 0);
    const { client } = makeClient({ reserveBlindingGeneration: reserve });

    const allocator = await (client as any).makeBlindingKeyAllocator(inputs(ANCHOR), true);
    expect(allocator.isDeterministic).toBe(false);
    expect(reserve).not.toHaveBeenCalled();
  });
});
