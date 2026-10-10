import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTransaction } from './p2p-block-parser';
import { isStakedCommitmentOutput } from './staking';
import { STAKED_TX_HEX } from './test-fixtures/staked-tx';
import { WalletDB } from './wallet-db';
import type { StoreOutputParams } from './wallet-db.interface';

const TOKEN_A = 'aa'.repeat(32) + '00'.repeat(8);
const TOKEN_B = 'bb'.repeat(32) + '00'.repeat(8);

function output(outputHash: string, overrides: Partial<StoreOutputParams> = {}): StoreOutputParams {
  return {
    outputHash,
    txHash: 'cc'.repeat(32),
    outputIndex: 0,
    blockHeight: 10,
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
    ...overrides,
  };
}

describe('WalletDB output queries', () => {
  let walletDB: WalletDB;

  beforeEach(async () => {
    walletDB = new WalletDB({ type: 'better-sqlite3' });
    await walletDB.open(':memory:');
  });

  afterEach(async () => {
    await walletDB.close();
  });

  it('binds the token id instead of splicing it into the SQL', async () => {
    await walletDB.storeWalletOutput(output('01'.repeat(32), { tokenId: TOKEN_A, amount: 5 }));
    await walletDB.storeWalletOutput(output('02'.repeat(32), { tokenId: TOKEN_B, amount: 7 }));
    await walletDB.storeWalletOutput(
      output('03'.repeat(32), { tokenId: TOKEN_A, amount: 11, isSpent: true, spentBlockHeight: 0 })
    );

    expect(await walletDB.getBalance(TOKEN_A)).toBe(5n);
    expect((await walletDB.getUnspentOutputs(TOKEN_B)).map(o => o.amount)).toEqual([7n]);
    expect(await walletDB.getPendingSpentAmount(TOKEN_A)).toBe(11n);

    // A quote in the token id must not end the string literal.
    const injected = `x' OR '1'='1`;
    expect(await walletDB.getBalance(injected)).toBe(0n);
    expect(await walletDB.getUnspentOutputs(injected)).toEqual([]);
    expect(await walletDB.getPendingSpentAmount(injected)).toBe(0n);
  });

  it('keeps staked commitments out of the spendable balance and unspent outputs', async () => {
    await walletDB.storeWalletOutput(output('04'.repeat(32), { amount: 100 }));
    await walletDB.storeWalletOutput(
      output('05'.repeat(32), { amount: 1_000, isStakedCommitment: true })
    );

    expect(await walletDB.getBalance()).toBe(100n);
    expect((await walletDB.getUnspentOutputs()).map(o => o.amount)).toEqual([100n]);
    const all = await walletDB.getAllOutputs();
    expect(all.map(o => [o.amount, o.isStakedCommitment])).toEqual([
      [100n, false],
      [1_000n, true],
    ]);
  });
});

describe('WalletDB staked-commitment migration', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'navio-sdk-staked-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A wallet database as released before is_staked_commitment. */
  function writeOldDatabase(path: string) {
    const outputs = parseTransaction(Buffer.from(STAKED_TX_HEX, 'hex')).outputs;
    const staked = outputs.find(isStakedCommitmentOutput)!;
    const other = outputs.find(o => !isStakedCommitmentOutput(o))!;

    const old = new Database(path);
    old.exec(`CREATE TABLE wallet_outputs (
      output_hash TEXT PRIMARY KEY, tx_hash TEXT NOT NULL, output_index INTEGER NOT NULL,
      block_height INTEGER NOT NULL, output_data TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0,
      gamma TEXT NOT NULL DEFAULT '0', memo TEXT, token_id TEXT, blinding_key TEXT, ephemeral_key TEXT,
      spending_key TEXT, is_spent INTEGER NOT NULL DEFAULT 0, spent_tx_hash TEXT,
      spent_block_height INTEGER, created_at INTEGER NOT NULL,
      tx_type TEXT NOT NULL DEFAULT 'received', timestamp INTEGER NOT NULL DEFAULT 0)`);
    const insert = old.prepare(
      `INSERT INTO wallet_outputs (output_hash, tx_hash, output_index, block_height, output_data,
       amount, created_at) VALUES (?, ?, 0, 10, ?, ?, 0)`
    );
    insert.run(staked.outputHash, 'dd'.repeat(32), staked.serializedHex, 1_000);
    insert.run(other.outputHash, 'dd'.repeat(32), other.serializedHex, 100);
    insert.run('06'.repeat(32), 'dd'.repeat(32), '', 10);
    old.close();

    return { staked, other };
  }

  async function stakedFlags(walletDB: WalletDB): Promise<Record<string, boolean>> {
    return Object.fromEntries(
      (await walletDB.getAllOutputs()).map(o => [o.outputHash, o.isStakedCommitment])
    );
  }

  it('flags staked outputs stored before the column existed', async () => {
    const path = join(dir, 'wallet.db');
    const { staked, other } = writeOldDatabase(path);

    const walletDB = new WalletDB({ type: 'better-sqlite3' });
    await walletDB.open(path);
    try {
      expect(await stakedFlags(walletDB)).toEqual({
        [staked.outputHash]: true,
        [other.outputHash]: false,
        ['06'.repeat(32)]: false,
      });
      expect(await walletDB.getBalance()).toBe(110n);
    } finally {
      await walletDB.close();
    }
  });

  it('retries the backfill when the migration was interrupted', async () => {
    const path = join(dir, 'wallet.db');
    const { staked } = writeOldDatabase(path);

    const backfill = vi
      .spyOn(WalletDB.prototype as any, 'backfillStakedCommitments')
      .mockRejectedValueOnce(new Error('interrupted'));
    const interrupted = new WalletDB({ type: 'better-sqlite3' });
    await expect(interrupted.open(path)).rejects.toThrow('interrupted');
    await interrupted.close();
    backfill.mockRestore();

    const walletDB = new WalletDB({ type: 'better-sqlite3' });
    await walletDB.open(path);
    try {
      expect((await stakedFlags(walletDB))[staked.outputHash]).toBe(true);
    } finally {
      await walletDB.close();
    }
  });
});
