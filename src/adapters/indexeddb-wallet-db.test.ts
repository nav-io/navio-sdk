import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { parseTransaction } from '../p2p-block-parser';
import { isStakedCommitmentOutput } from '../staking';
import { STAKED_TX_HEX } from '../test-fixtures/staked-tx';
import { IndexedDBWalletDB } from './indexeddb-wallet-db';

const PATH = 'staked-upgrade';

/** Records as a version-4 database stored them, before isStakedCommitment. */
function oldRecord(outputHash: string, outputData: string, amount: number) {
  return {
    outputHash,
    txHash: 'dd'.repeat(32),
    outputIndex: 0,
    blockHeight: 10,
    outputData,
    amount,
    gamma: '01',
    memo: null,
    tokenId: null,
    blindingKey: '02',
    ephemeralKey: null,
    spendingKey: '03',
    isSpent: 0,
    spentTxHash: null,
    spentBlockHeight: null,
    txType: 'received',
    timestamp: 0,
    createdAt: 0,
  };
}

function writeVersion4Database(records: ReturnType<typeof oldRecord>[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IndexedDBWalletDB.getDatabaseName(PATH), 4);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore('walletOutputs', { keyPath: 'outputHash' });
      store.createIndex('blockHeight', 'blockHeight', { unique: false });
      store.createIndex('isSpent', 'isSpent', { unique: false });
      store.createIndex('spentBlockHeight', 'spentBlockHeight', { unique: false });
      for (const record of records) store.put(record);
    };
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
  });
}

describe('IndexedDBWalletDB staked-commitment upgrade', () => {
  afterEach(async () => {
    await IndexedDBWalletDB.deleteDatabase(PATH);
  });

  it('flags staked outputs stored by a version-4 database', async () => {
    const outputs = parseTransaction(Buffer.from(STAKED_TX_HEX, 'hex')).outputs;
    const staked = outputs.find(isStakedCommitmentOutput)!;
    const other = outputs.find(o => !isStakedCommitmentOutput(o))!;
    await writeVersion4Database([
      oldRecord(staked.outputHash, staked.serializedHex, 1_000),
      oldRecord(other.outputHash, other.serializedHex, 100),
      oldRecord('06'.repeat(32), '', 10),
    ]);

    const walletDB = new IndexedDBWalletDB();
    await walletDB.open(PATH);
    try {
      const flags = Object.fromEntries(
        (await walletDB.getAllOutputs()).map(o => [o.outputHash, o.isStakedCommitment])
      );
      expect(flags).toEqual({
        [staked.outputHash]: true,
        [other.outputHash]: false,
        ['06'.repeat(32)]: false,
      });
      expect(await walletDB.getBalance()).toBe(110n);
      expect((await walletDB.getUnspentOutputs()).map(o => o.outputHash).sort()).toEqual(
        [other.outputHash, '06'.repeat(32)].sort()
      );
    } finally {
      await walletDB.close();
    }
  });
});

describe('IndexedDBWalletDB.getOutputData', () => {
  afterEach(async () => {
    await IndexedDBWalletDB.deleteDatabase(PATH);
  });

  it('returns the stored serialized output, or null when there is none', async () => {
    const walletDB = new IndexedDBWalletDB();
    await walletDB.open(PATH);
    try {
      const store = (outputHash: string, outputData: string) =>
        walletDB.storeWalletOutput({
          ...oldRecord(outputHash, outputData, 1_000),
          amount: 1_000n,
          isSpent: false,
          txType: 'received',
        });
      await store('07'.repeat(32), 'abcd');
      await store('08'.repeat(32), '');

      expect(await walletDB.getOutputData('07'.repeat(32))).toBe('abcd');
      expect(await walletDB.getOutputData('08'.repeat(32))).toBeNull();
      expect(await walletDB.getOutputData('09'.repeat(32))).toBeNull();
    } finally {
      await walletDB.close();
    }
  });
});
