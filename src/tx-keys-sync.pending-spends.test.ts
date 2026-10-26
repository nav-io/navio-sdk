import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CTxId,
  OutPoint,
  PublicKey,
  Scalar,
  SubAddr,
  SubAddrId,
  TokenId,
  TxIn,
  TxOut,
  UnsignedInput,
  UnsignedOutput,
  UnsignedTransaction,
} from '@nav-io/navio-blsct';
import { ElectrumClient, ElectrumError, isTransactionNotFoundError } from './electrum';
import { parseTransaction } from './p2p-block-parser';
import { P2PSyncProvider } from './p2p-sync';
import type { SyncProvider } from './sync-provider';
import { DEFAULT_PENDING_SPEND_TIMEOUT_MS, TransactionKeysSync } from './tx-keys-sync';
import { WalletDB } from './wallet-db';
import type { StoreOutputParams } from './wallet-db.interface';

const MINUTE = 60 * 1000;

/** How ElectrumX relays naviod's getrawtransaction failure for an unknown txid. */
const ELECTRUMX_NOT_FOUND =
  "daemon error: DaemonError({'code': -5, 'message': 'No such mempool or blockchain transaction. " +
  "Use gettransaction for wallet transactions.'})";

function output(outputHash: string, txHash: string, blockHeight: number): StoreOutputParams {
  return {
    outputHash,
    txHash,
    outputIndex: 0,
    blockHeight,
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
  };
}

/** A provider at `tip` whose only interesting method is hasTransaction. */
function provider(
  tip: number,
  hasTransaction?: (txHash: string) => Promise<boolean | null>
): SyncProvider {
  return {
    type: 'custom',
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: () => true,
    getChainTipHeight: vi.fn().mockResolvedValue(tip),
    getChainTip: vi.fn(),
    getBlockHeader: vi.fn(),
    getBlockHeaders: vi.fn(),
    getBlockTransactionKeysRange: vi.fn().mockImplementation(async (start: number) => ({
      blocks: [{ height: start, txKeys: [] }],
      nextHeight: start + 1,
    })),
    getBlockTransactionKeys: vi.fn(),
    getTransactionKeys: vi.fn(),
    getTransactionOutput: vi.fn(),
    broadcastTransaction: vi.fn(),
    getRawTransaction: vi.fn(),
    ...(hasTransaction ? { hasTransaction: vi.fn(hasTransaction) } : {}),
  } as unknown as SyncProvider;
}

describe('TransactionKeysSync pending spends', () => {
  let walletDB: WalletDB;

  beforeEach(async () => {
    walletDB = new WalletDB({ type: 'better-sqlite3' });
    await walletDB.open(':memory:');
    for (const hash of ['a1', 'b1', 'c1']) {
      await walletDB.storeWalletOutput(output(hash, `funding-${hash}`, 10));
    }
    await walletDB.storeWalletOutput(output('mempool:dropped:0', 'dropped', 0));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await walletDB.close();
  });

  /** Mark `outputHash` spent by `txHash` in the mempool, `ageMs` ago. */
  async function spendAgo(outputHash: string, txHash: string, ageMs: number): Promise<void> {
    vi.useFakeTimers({ now: Date.now() - ageMs, toFake: ['Date'] });
    await walletDB.markOutputSpent(outputHash, txHash, 0);
    vi.useRealTimers();
  }

  it('releases a transaction the backend no longer has, keeps the others', async () => {
    await spendAgo('a1', 'dropped', 31 * MINUTE);
    await spendAgo('b1', 'live', 31 * MINUTE);
    await spendAgo('c1', 'silent', 31 * MINUTE);
    const known: Record<string, boolean | null> = { dropped: false, live: true, silent: null };
    const sync = new TransactionKeysSync(
      walletDB,
      provider(10, async tx => known[tx])
    );

    const result = await sync.checkPendingSpends();

    expect(result).toEqual({ released: ['dropped'], stillPending: ['live'], unknown: ['silent'] });
    expect(await walletDB.isOutputUnspent('a1')).toBe(true);
    expect(await walletDB.isOutputUnspent('b1')).toBe(false);
    expect(await walletDB.isOutputUnspent('c1')).toBe(false);
    expect((await walletDB.getAllOutputs()).map(o => o.outputHash)).not.toContain(
      'mempool:dropped:0'
    );
  });

  it('does not ask about spends younger than the threshold', async () => {
    await spendAgo('a1', 'dropped', 10 * MINUTE);
    const hasTransaction = vi.fn().mockResolvedValue(false);
    const sync = new TransactionKeysSync(walletDB, provider(10, hasTransaction));

    expect(await sync.checkPendingSpends()).toEqual({
      released: [],
      stillPending: [],
      unknown: [],
    });
    expect(hasTransaction).not.toHaveBeenCalled();

    expect((await sync.checkPendingSpends(5 * MINUTE)).released).toEqual(['dropped']);
  });

  it('treats a spend without a recorded start as old', async () => {
    await walletDB.getAdapter().run(
      `UPDATE wallet_outputs SET is_spent = 1, spent_tx_hash = 'dropped', spent_block_height = 0, spent_at = NULL
         WHERE output_hash = 'a1'`
    );
    const sync = new TransactionKeysSync(
      walletDB,
      provider(10, async () => false)
    );

    expect((await sync.checkPendingSpends()).released).toEqual(['dropped']);
  });

  it('changes nothing when the backend cannot answer', async () => {
    await spendAgo('a1', 'dropped', 31 * MINUTE);
    const throwing = new TransactionKeysSync(
      walletDB,
      provider(10, async () => {
        throw new Error('Request timeout');
      })
    );
    const unsupported = new TransactionKeysSync(walletDB, provider(10));

    expect((await throwing.checkPendingSpends()).unknown).toEqual(['dropped']);
    expect((await unsupported.checkPendingSpends()).unknown).toEqual(['dropped']);
    expect(await walletDB.isOutputUnspent('a1')).toBe(false);
  });

  describe('during sync', () => {
    async function syncedTo(height: number, hasTransaction: () => Promise<boolean | null>) {
      const sync = new TransactionKeysSync(walletDB, provider(height, hasTransaction));
      sync.setKeyManager({} as any);
      await walletDB.saveSyncState({
        lastSyncedHeight: height,
        lastSyncedHash: '',
        totalTxKeysSynced: 0,
        lastSyncTime: 0,
        chainTipAtLastSync: height,
      });
      await sync.initialize();
      return sync;
    }

    it('checks once the wallet is at the tip', async () => {
      await spendAgo('a1', 'dropped', 31 * MINUTE);
      const sync = await syncedTo(10, async () => false);

      await sync.sync({ verifyHashes: false });

      expect(await walletDB.isOutputUnspent('a1')).toBe(true);
    });

    it('checks after scanning new blocks up to the tip', async () => {
      await spendAgo('a1', 'dropped', 31 * MINUTE);
      const sync = await syncedTo(10, async () => false);
      vi.mocked(sync.getSyncProvider().getChainTipHeight).mockResolvedValue(12);
      sync.getSyncProvider().getBlockHeaders = vi
        .fn()
        .mockImplementation(async (_start: number, count: number) => ({
          count,
          hex: '00'.repeat(80 * count),
          max: 2016,
        }));

      await sync.sync({ verifyHashes: false });

      expect(sync.getLastSyncedHeight()).toBe(12);
      expect(await walletDB.isOutputUnspent('a1')).toBe(true);
    });

    it('does not check short of the tip, or when disabled', async () => {
      await spendAgo('a1', 'dropped', 31 * MINUTE);
      const hasTransaction = vi.fn().mockResolvedValue(false);
      const sync = await syncedTo(10, hasTransaction);
      vi.mocked(sync.getSyncProvider().getChainTipHeight).mockResolvedValue(12);

      await sync.sync({ verifyHashes: false, endHeight: 10 });
      vi.mocked(sync.getSyncProvider().getChainTipHeight).mockResolvedValue(10);
      await sync.sync({ verifyHashes: false, pendingSpendTimeoutMs: 0 });

      expect(hasTransaction).not.toHaveBeenCalled();
      expect(await walletDB.isOutputUnspent('a1')).toBe(false);
    });

    it('honours a custom threshold', async () => {
      await spendAgo('a1', 'dropped', 2 * MINUTE);
      const sync = await syncedTo(10, async () => false);

      await sync.sync({ verifyHashes: false });
      expect(await walletDB.isOutputUnspent('a1')).toBe(false);

      await sync.sync({ verifyHashes: false, pendingSpendTimeoutMs: MINUTE });
      expect(await walletDB.isOutputUnspent('a1')).toBe(true);
    });
  });

  it('defaults to 30 minutes', () => {
    expect(DEFAULT_PENDING_SPEND_TIMEOUT_MS).toBe(30 * MINUTE);
  });
});

describe('hasTransaction', () => {
  it('Electrum: found, not found, unknown', async () => {
    const client = new ElectrumClient({ host: 'localhost', port: 1 });
    const call = vi.spyOn(client, 'call');

    call.mockResolvedValueOnce('00'.repeat(60));
    expect(await client.hasTransaction('ab'.repeat(32))).toBe(true);

    call.mockRejectedValueOnce(new ElectrumError(ELECTRUMX_NOT_FOUND, 2));
    expect(await client.hasTransaction('ab'.repeat(32))).toBe(false);

    call.mockRejectedValueOnce(
      new ElectrumError(
        "daemon error: DaemonError({'code': -5, 'message': 'No such mempool transaction. Use -txindex or provide a block hash to enable blockchain transaction queries.'})",
        2
      )
    );
    expect(await client.hasTransaction('ab'.repeat(32))).toBe(false);

    call.mockRejectedValueOnce(new Error('Request timeout for method: blockchain.transaction.get'));
    expect(await client.hasTransaction('ab'.repeat(32))).toBeNull();

    call.mockRejectedValueOnce(new ElectrumError('excessive resource usage', -101));
    expect(await client.hasTransaction('ab'.repeat(32))).toBeNull();
  });

  it('recognises only "not found" errors', () => {
    expect(isTransactionNotFoundError(new Error(ELECTRUMX_NOT_FOUND))).toBe(true);
    expect(isTransactionNotFoundError(new Error('Connection closed'))).toBe(false);
    expect(
      isTransactionNotFoundError(
        new Error(
          'No such mempool transaction. Blockchain transactions are still in the process of being indexed'
        )
      )
    ).toBe(false);
    expect(isTransactionNotFoundError(undefined)).toBe(false);
  });

  it('P2P: found, not found, unknown', async () => {
    const p2p = new P2PSyncProvider({ host: 'localhost', network: 'regtest' });
    const fetch = vi.spyOn(p2p as any, 'fetchTransaction');

    fetch.mockResolvedValueOnce({});
    expect(await p2p.hasTransaction('ab'.repeat(32))).toBe(true);

    fetch.mockRejectedValueOnce(
      new Error(
        `Transaction ${'ab'.repeat(32)} not found: not in the node's mempool or most recent block, ` +
          'and not in a block scanned by this provider'
      )
    );
    expect(await p2p.hasTransaction('ab'.repeat(32))).toBe(false);

    fetch.mockRejectedValueOnce(new Error('Request timeout: getdata'));
    expect(await p2p.hasTransaction('ab'.repeat(32))).toBeNull();
  });
});

describe('own spends recorded as sent', () => {
  let walletDB: WalletDB;
  let sync: TransactionKeysSync;

  beforeEach(async () => {
    walletDB = new WalletDB({ type: 'better-sqlite3' });
    await walletDB.open(':memory:');
    sync = new TransactionKeysSync(walletDB, provider(100));
    // Claims every output; amount recovery is not what these tests are about.
    sync.setKeyManager({
      isMineByKeys: () => true,
      calculateNonce: () => {
        throw new Error('not recovering amounts here');
      },
    } as any);
  });

  afterEach(async () => {
    await walletDB.close();
  });

  /** A signed transaction spending one input; returns it and its input's output hash. */
  function spendingTx(): { rawTx: string; inputHash: string } {
    const unsigned = UnsignedTransaction.create();
    unsigned.addInput(
      UnsignedInput.fromTxIn(
        TxIn.generate(
          2_000_000,
          new Scalar(5),
          new Scalar(6),
          TokenId.default(),
          OutPoint.generate(CTxId.deserialize('7a'.repeat(32)))
        )
      )
    );
    const destination = SubAddr.generate(
      new Scalar(11),
      PublicKey.fromScalar(new Scalar(12)),
      SubAddrId.generate(0, 0)
    );
    unsigned.addOutput(
      UnsignedOutput.fromTxOut(TxOut.generate(destination, 1_000_000, '', TokenId.default()))
    );
    unsigned.setFee(1_000_000);
    const rawTx = unsigned.sign();
    return { rawTx, inputHash: parseTransaction(Buffer.from(rawTx, 'hex')).inputHashes[0] };
  }

  it('in the mempool, when the wallet already marked the inputs spent by this tx', async () => {
    const { rawTx, inputHash } = spendingTx();
    await walletDB.storeWalletOutput(output(inputHash, 'funding', 10));
    await walletDB.markOutputSpent(inputHash, 'own-tx', 0);

    await sync.processMempoolTransaction('own-tx', rawTx);

    const rows = (await walletDB.getAllOutputs()).filter(o => o.txHash === 'own-tx');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(o => o.txType === 'sent')).toBe(true);
  });

  it('in the mempool, still received when the input was spent by another tx', async () => {
    const { rawTx, inputHash } = spendingTx();
    await walletDB.storeWalletOutput(output(inputHash, 'funding', 10));
    await walletDB.markOutputSpent(inputHash, 'someone-else', 0);

    await sync.processMempoolTransaction('own-tx', rawTx);

    const rows = (await walletDB.getAllOutputs()).filter(o => o.txHash === 'own-tx');
    expect(rows.every(o => o.txType === 'received')).toBe(true);
  });

  it('in a block, when the confirmed tx spends inputs already spent in the mempool', async () => {
    const { rawTx, inputHash } = spendingTx();
    await walletDB.storeWalletOutput(output(inputHash, 'funding', 10));
    await walletDB.markOutputSpent(inputHash, 'own-tx', 0);
    const parsed = parseTransaction(Buffer.from(rawTx, 'hex'));
    const keys = {
      inputs: [{ outputHash: inputHash }],
      outputs: parsed.outputs.filter(o => o.keys).map(o => o.keys),
    };
    const serialized = new Map(parsed.outputs.map(o => [o.outputHash, o.serializedHex]));
    sync.getSyncProvider().getTransactionOutput = vi.fn(
      async (hash: string) => serialized.get(hash)!
    );
    sync.getSyncProvider().getRawTransaction = vi.fn(async () => rawTx);

    await (sync as any).processTransactionKeys('aggregated-tx', keys, 20, 'hash', 0, false);

    const rows = (await walletDB.getAllOutputs()).filter(o => o.txHash === 'aggregated-tx');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(o => o.txType === 'sent')).toBe(true);
  });
});
