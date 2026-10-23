/**
 * TransactionKeysSync against servers that misbehave or race: data that does
 * not hash to what it claims, reorgs landing between a batch's keys and its
 * headers, prefetches failing after a batch already failed, and concurrent
 * sync() calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CTxId,
  OutPoint,
  PublicKey,
  Scalar,
  TokenId,
  TxIn,
  TxOut,
  TxOutputType,
  UnsignedInput,
  UnsignedOutput,
  UnsignedTransaction,
} from '@nav-io/navio-blsct';
import { sha256 } from '@noble/hashes/sha256';
import { TransactionKeysSync, SyncVerificationError } from './tx-keys-sync';
import { parseTransaction, type ParsedOutput } from './p2p-block-parser';
import { WalletDB } from './wallet-db';
import type { SyncProvider, BlockHeadersResult } from './sync-provider';
import type { BlockTransactionKeys, TransactionKeys } from './electrum';
import type { KeyManager } from './key-manager';

function hashHeader(headerHex: string): string {
  return Buffer.from(sha256(sha256(Buffer.from(headerHex, 'hex')))).reverse().toString('hex');
}

/** 80-byte header served at a height nobody overrode */
function defaultHeader(height: number): string {
  return height.toString(16).padStart(160, '0');
}

/** A header for `height` on a competing branch */
function branchHeader(height: number): string {
  return '01'.repeat(76) + height.toString(16).padStart(8, '0');
}

interface MockOptions {
  tip: number;
  /** Header at a height (default: defaultHeader) */
  headerAt?: (height: number) => string;
  /** Tx keys of a block (default: none) */
  keysAt?: (height: number) => TransactionKeys[];
  /** Block hash reported with the keys, as the P2P provider does (default: none) */
  hashAt?: (height: number) => string | undefined;
  /** Called after a batch of keys was served */
  afterRange?: (startHeight: number) => void;
}

/** Blocks per range page */
const PAGE = 10;

function mockProvider(options: MockOptions): SyncProvider {
  const headerAt = options.headerAt ?? defaultHeader;
  return {
    type: 'custom' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    getChainTipHeight: vi.fn(async () => options.tip),
    getChainTip: vi.fn(async () => ({ height: options.tip, hash: hashHeader(headerAt(options.tip)) })),
    getBlockHeader: vi.fn(async (height: number) => headerAt(height)),
    getBlockHeaders: vi.fn(async (start: number, count: number) => {
      let hex = '';
      for (let i = 0; i < count; i++) hex += headerAt(start + i);
      return { count, hex, max: 2016 } as BlockHeadersResult;
    }),
    getBlockTransactionKeysRange: vi.fn(async (start: number) => {
      const blocks: BlockTransactionKeys[] = [];
      for (let h = start; h < start + PAGE && h <= options.tip; h++) {
        const hash = options.hashAt?.(h);
        blocks.push({ height: h, txKeys: options.keysAt?.(h) ?? [], ...(hash ? { hash } : {}) });
      }
      options.afterRange?.(start);
      return { blocks, nextHeight: start + blocks.length };
    }),
    getBlockTransactionKeys: vi.fn().mockResolvedValue([]),
    getTransactionKeys: vi.fn().mockResolvedValue(null),
    getTransactionOutput: vi.fn().mockRejectedValue(new Error('not served')),
    broadcastTransaction: vi.fn().mockResolvedValue('txid'),
    getRawTransaction: vi.fn().mockRejectedValue(new Error('not served')),
  };
}

let walletDB: WalletDB;
let keyManager: KeyManager;

beforeEach(async () => {
  walletDB = new WalletDB();
  await walletDB.open(':memory:');
  keyManager = await walletDB.createWallet(0);
});

afterEach(async () => {
  await walletDB.close();
});

describe('served outputs and transactions are checked against their hashes', () => {
  /** A transaction paying this wallet 500 000 and 700 000. */
  function buildPayment(): { rawTx: string; txid: string; mine: ParsedOutput[] } {
    const destination = keyManager.getSubAddress({ account: 0, address: 0 });
    const tx = UnsignedTransaction.create();
    tx.addInput(UnsignedInput.fromTxIn(TxIn.generate(
      2_000_000, new Scalar(7), new Scalar(8), TokenId.default(),
      OutPoint.generate(CTxId.deserialize('33'.repeat(32))), false, false,
    )));
    for (const [i, amount] of [500_000, 700_000].entries()) {
      tx.addOutput(UnsignedOutput.fromTxOut(TxOut.generate(
        destination, amount, `memo-${i}`, TokenId.default(), TxOutputType.Normal, 0, false,
        new Scalar(100 + i),
      )));
    }
    tx.setFee(500_000);
    const rawTx = tx.sign();
    const parsed = parseTransaction(Buffer.from(rawTx, 'hex'));
    return { rawTx, txid: parsed.txid, mine: parsed.outputs.filter(o => o.keys !== null) };
  }

  /** The key-list entry the server sends for an output, optionally with another output's keys. */
  function listed(output: ParsedOutput, keysFrom: ParsedOutput = output) {
    return {
      outputHash: output.outputHash,
      blindingKey: keysFrom.keys!.blindingKey,
      spendingKey: keysFrom.keys!.spendingKey,
      viewTag: keysFrom.keys!.viewTag,
    };
  }

  function syncWith(
    txid: string,
    outputs: ReturnType<typeof listed>[],
    serve: Partial<Pick<SyncProvider, 'getTransactionOutput' | 'getRawTransaction'>>,
  ): { sync: TransactionKeysSync; provider: SyncProvider } {
    const provider = mockProvider({
      tip: 60,
      keysAt: h => (h === 60 ? [{ txHash: txid, keys: { inputs: [], outputs } }] : []),
    });
    Object.assign(provider, serve);
    const sync = new TransactionKeysSync(walletDB, provider);
    sync.setKeyManager(keyManager);
    return { sync, provider };
  }

  function amountOf(sync: TransactionKeysSync, output: ParsedOutput): number {
    const blindingKey = PublicKey.deserialize(output.keys!.blindingKey);
    return (sync as any).tryRecoverFromSerializedOutput(output.serializedHex, blindingKey).amount;
  }

  it('stores an output the server serves faithfully', async () => {
    const { txid, mine } = buildPayment();
    const { sync } = syncWith(txid, [listed(mine[0])], {
      getTransactionOutput: vi.fn(async () => mine[0].serializedHex),
    });

    await sync.sync({ startHeight: 55 });

    const stored = await walletDB.getAllOutputs();
    expect(stored.map(o => o.outputHash)).toEqual([mine[0].outputHash]);
    expect(Number(stored[0].amount)).toBe(amountOf(sync, mine[0]));
    expect([500_000, 700_000]).toContain(Number(stored[0].amount));
    expect(sync.getLastSyncedHeight()).toBe(60);
  });

  it('rejects another output served under an output hash, storing nothing', async () => {
    const { txid, mine } = buildPayment();
    const { sync } = syncWith(txid, [listed(mine[0])], {
      // Another output of ours, so its amount would recover fine
      getTransactionOutput: vi.fn(async () => mine[1].serializedHex),
    });

    const error = await sync.sync({ startHeight: 55 }).catch(e => e);

    expect(error).toBeInstanceOf(SyncVerificationError);
    expect(error.message).toContain(`output ${mine[0].outputHash} hashes to ${mine[1].outputHash}`);
    expect(await walletDB.getAllOutputs()).toEqual([]);
    expect(sync.getLastSyncedHeight()).toBe(-1); // the batch (55..60) is not committed
  });

  it('rejects an output whose keys differ from the keys listed for it', async () => {
    const { txid, mine } = buildPayment();
    const { sync } = syncWith(txid, [listed(mine[0], mine[1])], {
      getTransactionOutput: vi.fn(async () => mine[0].serializedHex),
    });

    const error = await sync.sync({ startHeight: 55 }).catch(e => e);

    expect(error).toBeInstanceOf(SyncVerificationError);
    expect(error.message).toContain('blinding key');
    expect(await walletDB.getAllOutputs()).toEqual([]);
  });

  it('recovers from the raw transaction by output hash, not by key-list position', async () => {
    const { rawTx, txid, mine } = buildPayment();
    // The key list skips outputs, so the second wallet output is entry 0.
    const { sync } = syncWith(txid, [listed(mine[1])], {
      getRawTransaction: vi.fn(async () => rawTx),
    });

    await sync.sync({ startHeight: 55 });

    const stored = await walletDB.getAllOutputs();
    expect(stored.map(o => o.outputHash)).toEqual([mine[1].outputHash]);
    expect(Number(stored[0].amount)).toBe(amountOf(sync, mine[1]));
    expect(amountOf(sync, mine[1])).not.toBe(amountOf(sync, mine[0]));
  });

  it('rejects a raw transaction that does not hash to the transaction id', async () => {
    const { txid, mine } = buildPayment();
    const other = buildPayment(); // same outputs' shape, different transaction
    const { sync } = syncWith(txid, [listed(mine[0])], {
      getRawTransaction: vi.fn(async () => other.rawTx),
    });

    const error = await sync.sync({ startHeight: 55 }).catch(e => e);

    expect(error).toBeInstanceOf(SyncVerificationError);
    expect(error.message).toContain(`transaction ${txid} hashes to ${other.txid}`);
    expect(await walletDB.getAllOutputs()).toEqual([]);
  });

  it('rejects a raw transaction that lacks the output', async () => {
    const { mine } = buildPayment();
    const other = buildPayment();
    // The server lists the output under the other transaction's id.
    const { sync } = syncWith(other.txid, [listed(mine[0])], {
      getRawTransaction: vi.fn(async () => other.rawTx),
    });

    const error = await sync.sync({ startHeight: 55 }).catch(e => e);

    expect(error).toBeInstanceOf(SyncVerificationError);
    expect(error.message).toContain(`does not contain output ${mine[0].outputHash}`);
  });
});

describe('prefetches', () => {
  it('do not leave an unhandled rejection when the batch before them fails', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const provider = mockProvider({ tip: 30 });
      // The next page fails a little later, as on a dropped connection...
      provider.getBlockTransactionKeysRange = vi.fn(async (start: number) => {
        if (start > 0) {
          await new Promise(resolve => setTimeout(resolve, 10));
          throw new Error('Connection closed');
        }
        return {
          blocks: Array.from({ length: PAGE }, (_, i) => ({ height: i, txKeys: [] })),
          nextHeight: PAGE,
        };
      });
      // ...after the current batch already failed on its headers.
      provider.getBlockHeaders = vi.fn().mockRejectedValue(new Error('header failure'));
      const sync = new TransactionKeysSync(walletDB, provider);
      sync.setKeyManager(keyManager);

      await expect(sync.sync({ verifyHashes: false })).rejects.toThrow('header failure');
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('a reorg between fetching keys and headers', () => {
  /** Tx keys that say which branch served them */
  const keysOn = (branch: string, height: number): TransactionKeys[] => [
    { txHash: `${branch}-tx-${height}`, keys: { inputs: [], outputs: [] } },
  ];

  it('is caught by the anchor check and the batch re-fetched (keys without block hashes)', async () => {
    let reorged = false;
    const onB = (h: number) => reorged && h >= 55;
    const provider = mockProvider({
      tip: 60,
      headerAt: h => (onB(h) ? branchHeader(h) : defaultHeader(h)),
      keysAt: h => keysOn(onB(h) ? 'B' : 'A', h),
      // The reorg lands right after the first page of keys was served
      afterRange: () => {
        reorged = true;
      },
    });
    const sync = new TransactionKeysSync(walletDB, provider);
    sync.setKeyManager(keyManager);

    await sync.sync({ startHeight: 50, keepTxKeys: true });

    for (let h = 55; h <= 60; h++) {
      expect(await walletDB.getBlockHash(h)).toBe(hashHeader(branchHeader(h)));
      expect((await walletDB.getTxKeysByHeight(h)).map(k => k.txHash)).toEqual([`B-tx-${h}`]);
    }
    expect(await walletDB.getBlockHash(54)).toBe(hashHeader(defaultHeader(54)));
    const starts = vi.mocked(provider.getBlockTransactionKeysRange).mock.calls.map(c => c[0]);
    expect(starts.filter(s => s === 50).length).toBe(2);
  });

  it('is caught by comparing the block hash the keys came with (P2P)', async () => {
    let reorged = false;
    // Heights 55..58 only, so the anchor at 60 does not see it
    const onB = (h: number) => reorged && h >= 55 && h <= 58;
    const header = (h: number) => (onB(h) ? branchHeader(h) : defaultHeader(h));
    const provider = mockProvider({
      tip: 60,
      headerAt: header,
      hashAt: h => hashHeader(header(h)),
      keysAt: h => keysOn(onB(h) ? 'B' : 'A', h),
      afterRange: () => {
        reorged = true;
      },
    });
    const sync = new TransactionKeysSync(walletDB, provider);
    sync.setKeyManager(keyManager);

    await sync.sync({ startHeight: 50, keepTxKeys: true });

    for (let h = 55; h <= 58; h++) {
      expect(await walletDB.getBlockHash(h)).toBe(hashHeader(branchHeader(h)));
      expect((await walletDB.getTxKeysByHeight(h)).map(k => k.txHash)).toEqual([`B-tx-${h}`]);
    }
  });

  it('gives up after a few attempts when the chain keeps changing, storing nothing', async () => {
    const provider = mockProvider({
      tip: 60,
      hashAt: () => 'ff'.repeat(32), // never the header's hash
    });
    const sync = new TransactionKeysSync(walletDB, provider);
    sync.setKeyManager(keyManager);

    await expect(sync.sync({ startHeight: 50 })).rejects.toThrow('kept changing');
    expect(sync.getLastSyncedHeight()).toBe(-1);
    expect(await walletDB.getBlockHash(50)).toBeNull();
    // The first attempt and three restarts (each also prefetching page 60)
    const starts = vi.mocked(provider.getBlockTransactionKeysRange).mock.calls.map(c => c[0]);
    expect(starts.filter(s => s === 50).length).toBe(4);
  });
});

describe('concurrent sync() calls', () => {
  it('run one after the other', async () => {
    const provider = mockProvider({ tip: 30 });
    let active = 0;
    let maxActive = 0;
    const range = provider.getBlockTransactionKeysRange;
    provider.getBlockTransactionKeysRange = vi.fn(async (start: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      return range(start);
    });
    const sync = new TransactionKeysSync(walletDB, provider);
    sync.setKeyManager(keyManager);

    const [first, second] = await Promise.all([sync.sync(), sync.sync()]);

    expect(maxActive).toBe(1);
    const starts = vi.mocked(provider.getBlockTransactionKeysRange).mock.calls.map(c => c[0]);
    expect(starts).toEqual([0, 10, 20, 30]);
    expect([first, second]).toEqual([0, 0]); // no tx keys in these blocks
    expect(sync.getLastSyncedHeight()).toBe(30);
  });

  it('runs the next call after one that failed', async () => {
    const provider = mockProvider({ tip: 30 });
    const tip = provider.getChainTipHeight;
    provider.getChainTipHeight = vi
      .fn()
      .mockRejectedValueOnce(new Error('first fails'))
      .mockImplementation(tip);
    const sync = new TransactionKeysSync(walletDB, provider);
    sync.setKeyManager(keyManager);

    const results = await Promise.allSettled([sync.sync(), sync.sync()]);

    expect(results[0]).toMatchObject({ status: 'rejected' });
    expect(results[1]).toMatchObject({ status: 'fulfilled' });
    expect(sync.getLastSyncedHeight()).toBe(30);
  });
});
