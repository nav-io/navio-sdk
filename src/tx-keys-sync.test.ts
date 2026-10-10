import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CTx,
  CTxId,
  OutPoint,
  Point,
  PublicKey,
  Scalar,
  TokenId,
  TxIn,
  UnsignedInput,
  UnsignedOutput,
  UnsignedTransaction,
  calcCollectionTokenHashHex,
  deriveCollectionTokenKeyFromMaster,
  deriveCollectionTokenPublicKeyFromMaster,
  getCTxOutBlindingKey,
} from '@nav-io/navio-blsct';
import {
  TransactionKeysSync,
  SyncState,
  DeepReorgError,
  MAX_REORG_DEPTH,
  ReorgError,
} from './tx-keys-sync';
import { parseTransaction } from './p2p-block-parser';
import { isStakedCommitmentOutput } from './staking';
import { STAKED_TX_HEX } from './test-fixtures/staked-tx';
import { WalletDB } from './wallet-db';
import { SyncProvider, ChainTip, BlockHeadersResult } from './sync-provider';
import type { BlockTransactionKeys, TransactionKeys } from './electrum';
import type { StoreOutputParams } from './wallet-db.interface';
import { sha256 } from '@noble/hashes/sha256';

/** Block hash as the SDK computes it: double SHA-256 of the header, byte-reversed. */
function hashHeader(headerHex: string): string {
  return Buffer.from(sha256(sha256(Buffer.from(headerHex, 'hex'))))
    .reverse()
    .toString('hex');
}

/** The header the mock serves at a height nobody overrode (80 bytes = 160 hex chars). */
function defaultHeader(height: number): string {
  return height.toString(16).padStart(160, '0');
}

/** A header for `height` on a competing branch, distinct from defaultHeader(). */
function branchHeader(height: number, branch: number = 1): string {
  return branch.toString(16).padStart(2, '0').repeat(76) + height.toString(16).padStart(8, '0');
}

type MockSyncProvider = SyncProvider & { setChainTip(height: number): void };

// Mock sync provider for testing. `blockHeaders` and `blockTxKeys` are read on
// every call, so a test can rewrite them between syncs to simulate a reorg.
function createMockSyncProvider(options: {
  chainTipHeight?: number;
  blockHeaders?: Map<number, string>;
  blockTxKeys?: Map<number, TransactionKeys[]>;
}): MockSyncProvider {
  let chainTipHeight = options.chainTipHeight ?? 1000;
  const blockHeaders = options.blockHeaders ?? new Map();
  const blockTxKeys = options.blockTxKeys ?? new Map();
  const headerAt = (height: number): string => blockHeaders.get(height) ?? defaultHeader(height);

  return {
    type: 'custom' as const,
    setChainTip: (height: number) => {
      chainTipHeight = height;
    },
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    getChainTipHeight: vi.fn().mockImplementation(() => Promise.resolve(chainTipHeight)),
    getChainTip: vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve({
          height: chainTipHeight,
          hash: hashHeader(headerAt(chainTipHeight)),
        } as ChainTip)
      ),
    getBlockHeader: vi
      .fn()
      .mockImplementation((height: number) => Promise.resolve(headerAt(height))),
    getBlockHeaders: vi.fn().mockImplementation((startHeight: number, count: number) => {
      let hex = '';
      for (let i = 0; i < count; i++) {
        hex += headerAt(startHeight + i);
      }
      return Promise.resolve({ count, hex, max: 2016 } as BlockHeadersResult);
    }),
    getBlockTransactionKeysRange: vi.fn().mockImplementation((startHeight: number) => {
      const blocks: BlockTransactionKeys[] = [];
      for (let i = 0; i < 10 && startHeight + i <= chainTipHeight; i++) {
        blocks.push({
          height: startHeight + i,
          txKeys: blockTxKeys.get(startHeight + i) ?? [],
        });
      }
      return Promise.resolve({
        blocks,
        nextHeight: startHeight + blocks.length,
      });
    }),
    getBlockTransactionKeys: vi.fn().mockResolvedValue([]),
    getTransactionOutput: vi.fn().mockResolvedValue('00'.repeat(100)),
    broadcastTransaction: vi.fn().mockResolvedValue('mock-txhash'),
    getRawTransaction: vi.fn().mockResolvedValue('00'.repeat(200)),
  };
}

describe('TransactionKeysSync', () => {
  let walletDB: WalletDB;
  let syncProvider: SyncProvider;
  let syncManager: TransactionKeysSync;

  beforeEach(async () => {
    // Create in-memory database
    walletDB = new WalletDB();
    await walletDB.open(':memory:');
    await walletDB.createWallet(0);
  });

  afterEach(async () => {
    await walletDB.close();
  });

  function output(
    outputHash: string,
    blockHeight: number,
    spent?: { txHash: string; height: number }
  ): StoreOutputParams {
    return {
      outputHash,
      txHash: `tx-${outputHash}`,
      outputIndex: 0,
      blockHeight,
      outputData: '',
      amount: 1_000_000,
      gamma: '01',
      memo: null,
      tokenId: null,
      blindingKey: '02',
      ephemeralKey: null,
      spendingKey: '03',
      isSpent: spent !== undefined,
      spentTxHash: spent?.txHash ?? null,
      spentBlockHeight: spent?.height ?? null,
      txType: 'received',
      timestamp: 0,
    };
  }

  async function outputRow(
    outputHash: string
  ): Promise<{
    isSpent: number;
    spentTxHash: string | null;
    spentBlockHeight: number | null;
  } | null> {
    const stmt = await walletDB
      .getAdapter()
      .prepare(
        'SELECT is_spent, spent_tx_hash, spent_block_height FROM wallet_outputs WHERE output_hash = ?'
      );
    stmt.bind([outputHash]);
    const found = await stmt.step();
    const row = await stmt.getAsObject();
    await stmt.free();
    if (!found) return null;
    return {
      isSpent: row.is_spent as number,
      spentTxHash: row.spent_tx_hash as string | null,
      spentBlockHeight: row.spent_block_height as number | null,
    };
  }

  describe('spent output detection', () => {
    it('should mark outputs as spent when input references wallet output', async () => {
      syncProvider = createMockSyncProvider({ chainTipHeight: 100 });
      syncManager = new TransactionKeysSync(walletDB, syncProvider);
      await syncManager.initialize();

      // Insert a test output into the database
      const db = walletDB.getAdapter();
      await db.run(`
        INSERT INTO wallet_outputs 
        (output_hash, tx_hash, output_index, block_height, output_data, amount, is_spent, created_at)
        VALUES ('test-output-hash', 'test-tx-hash', 0, 50, 'test-data', 1000000, 0, ?)
      `, [Date.now()]);

      // Verify output exists and is unspent
      const beforeResult = await db.exec("SELECT is_spent FROM wallet_outputs WHERE output_hash = 'test-output-hash'");
      expect(beforeResult[0].values[0][0]).toBe(0);

      // Create a block with transaction that spends our output
      // The keys structure should have inputs at the top level
      const blockWithSpend: BlockTransactionKeys = {
        height: 60,
        txKeys: [{
          txHash: 'spending-tx-hash',
          keys: {
            inputs: [{ outputHash: 'test-output-hash' }],
            outputs: [],
          },
        }],
      };

      // Process the block - this should detect the spent output
      // We need to access the private method, so we'll call sync with a custom provider
      const customProvider = {
        ...syncProvider,
        getBlockTransactionKeysRange: vi.fn().mockResolvedValue({
          blocks: [blockWithSpend],
          nextHeight: 61,
        }),
      };

      const newSyncManager = new TransactionKeysSync(walletDB, customProvider);
      await newSyncManager.initialize();
      
      // Simulate processing the block
      await newSyncManager.sync({ startHeight: 60, endHeight: 60, verifyHashes: false });

      // Verify output is now spent
      const afterResult = await db.exec("SELECT is_spent, spent_tx_hash, spent_block_height FROM wallet_outputs WHERE output_hash = 'test-output-hash'");
      expect(afterResult[0].values[0][0]).toBe(1); // is_spent
      expect(afterResult[0].values[0][1]).toBe('spending-tx-hash'); // spent_tx_hash
      expect(afterResult[0].values[0][2]).toBe(60); // spent_block_height
    });

    it('should not affect outputs that are not spent by the block', async () => {
      syncProvider = createMockSyncProvider({ chainTipHeight: 100 });
      syncManager = new TransactionKeysSync(walletDB, syncProvider);
      await syncManager.initialize();

      // Insert a test output
      const db = walletDB.getAdapter();
      await db.run(`
        INSERT INTO wallet_outputs 
        (output_hash, tx_hash, output_index, block_height, output_data, amount, is_spent, created_at)
        VALUES ('unspent-output-hash', 'test-tx-hash', 0, 50, 'test-data', 1000000, 0, ?)
      `, [Date.now()]);

      // Create a block with transaction that spends a different output
      const blockWithSpend: BlockTransactionKeys = {
        height: 60,
        txKeys: [{
          txHash: 'spending-tx-hash',
          keys: {
            inputs: [{ outputHash: 'other-output-hash' }],
            outputs: [],
          },
        }],
      };

      const customProvider = {
        ...syncProvider,
        getBlockTransactionKeysRange: vi.fn().mockResolvedValue({
          blocks: [blockWithSpend],
          nextHeight: 61,
        }),
      };

      const newSyncManager = new TransactionKeysSync(walletDB, customProvider);
      await newSyncManager.initialize();
      await newSyncManager.sync({ startHeight: 60, endHeight: 60, verifyHashes: false });

      // Verify output is still unspent
      const result = await db.exec("SELECT is_spent FROM wallet_outputs WHERE output_hash = 'unspent-output-hash'");
      expect(result[0].values[0][0]).toBe(0);
    });
  });

  describe('token id extraction', () => {
    it('should extract 40-byte token ids from serialized outputs', async () => {
      syncProvider = createMockSyncProvider({ chainTipHeight: 100 });
      syncManager = new TransactionKeysSync(walletDB, syncProvider);

      const maxAmountHex = 'ffffffffffffff7f';
      const flagsHex = '0200000000000000'; // HAS_TOKENID
      const scriptLenHex = '00';
      const tokenIdHex = '11'.repeat(40);
      const outputHex = maxAmountHex + flagsHex + scriptLenHex + tokenIdHex;

      const result = (syncManager as any).extractRangeProofFromOutput(outputHex);

      expect(result.rangeProofHex).toBeNull();
      expect(result.tokenIdHex).toBe(tokenIdHex);
    });

    it('should recover token amounts from raw transactions when standalone output recovery is unavailable', async () => {
      const keyManager = walletDB.getKeyManager();
      if (!keyManager) {
        throw new Error('expected wallet key manager');
      }

      const destination = keyManager.getSubAddress({ account: 0, address: 0 });
      const masterTokenKey = keyManager.getMasterTokenKey();
      const collectionTokenHashHex = calcCollectionTokenHashHex({ name: 'Mintable', symbol: 'TOK' }, 1_000_000);
      const tokenKey = deriveCollectionTokenKeyFromMaster(masterTokenKey, collectionTokenHashHex);
      const tokenPublicKey = deriveCollectionTokenPublicKeyFromMaster(masterTokenKey, collectionTokenHashHex);

      const unsignedTx = UnsignedTransaction.create();
      const outPoint = OutPoint.generate(CTxId.deserialize('33'.repeat(32)));
      const fundingTxIn = TxIn.generate(
        1_000_000,
        new Scalar(444),
        new Scalar(555),
        TokenId.default(),
        outPoint,
        false,
        false,
      );
      unsignedTx.addInput(UnsignedInput.fromTxIn(fundingTxIn));
      unsignedTx.addOutput(UnsignedOutput.mintToken(destination, 123_456, new Scalar(777), tokenKey, tokenPublicKey));
      unsignedTx.setFee(1000);

      const rawTx = unsignedTx.sign();
      const ctx = CTx.deserialize(rawTx);
      const ctxOut = ctx.getCTxOuts().at(0);
      const blindingKeyObj = PublicKey.fromPoint(Point.fromObj(getCTxOutBlindingKey((ctxOut as any).obj)));

      syncProvider = createMockSyncProvider({ chainTipHeight: 100 });
      syncProvider.getRawTransaction = vi.fn().mockResolvedValue(rawTx);
      syncManager = new TransactionKeysSync(walletDB, syncProvider);
      syncManager.setKeyManager(keyManager);

      const recovered = await (syncManager as any).recoverConfirmedOutput(
        'minted-token-tx',
        0,
        blindingKeyObj,
        '',
      );

      expect(recovered.amount).toBe(123_456);
      expect(recovered.tokenIdHex).toBe(ctxOut.getTokenId().serialize());
    });
  });

  describe('reorganization detection', () => {
    it('throws ReorgError and reverts nothing with stopOnReorg: true', async () => {
      const blockHeaders = new Map<number, string>();
      const provider = createMockSyncProvider({ chainTipHeight: 60, blockHeaders });
      syncManager = new TransactionKeysSync(walletDB, provider);
      await syncManager.initialize();
      await syncManager.sync({ startHeight: 0 });
      for (let h = 58; h <= 60; h++) blockHeaders.set(h, branchHeader(h));

      const error = await syncManager.sync({ stopOnReorg: true }).catch(e => e);

      expect(error).toBeInstanceOf(ReorgError);
      expect(error.message).toMatch(/reorganization detected at height 58/i);
      expect(error.info).toEqual({
        height: 58,
        oldHash: hashHeader(defaultHeader(58)),
        newHash: hashHeader(branchHeader(58)),
        blocksToRevert: 3,
      });
      expect(syncManager.getLastSyncedHeight()).toBe(60);
      expect(await walletDB.getBlockHash(60)).toBe(hashHeader(defaultHeader(60)));
    });
  });

  describe('block reversion', () => {
    /**
     * Sync a wallet to height 60, give it outputs on both sides of a fork at
     * 58 plus mempool rows, then replace blocks 58..60 and grow the tip to 62.
     */
    async function syncThenReorg(): Promise<{
      blockHeaders: Map<number, string>;
      provider: MockSyncProvider;
    }> {
      const blockHeaders = new Map<number, string>();
      const provider = createMockSyncProvider({ chainTipHeight: 60, blockHeaders });
      syncManager = new TransactionKeysSync(walletDB, provider);
      await syncManager.initialize();
      await syncManager.sync({ startHeight: 0 });
      expect(syncManager.getLastSyncedHeight()).toBe(60);

      await walletDB.storeWalletOutput(output('kept-at-50', 50));
      await walletDB.storeWalletOutput(output('orphaned-at-58', 58));
      await walletDB.storeWalletOutput(
        output('spent-at-59', 40, { txHash: 'orphaned-spend', height: 59 })
      );
      await walletDB.storeWalletOutput(
        output('spent-at-57', 40, { txHash: 'kept-spend', height: 57 })
      );
      await walletDB.storeWalletOutput(output('mempool-output', 0));
      await walletDB.storeWalletOutput(
        output('spent-in-mempool', 45, { txHash: 'mempool-tx', height: 0 })
      );

      for (let h = 58; h <= 60; h++) blockHeaders.set(h, branchHeader(h));
      provider.setChainTip(62);
      return { blockHeaders, provider };
    }

    it('reverts outputs and spends from orphaned blocks and keeps mempool rows', async () => {
      await syncThenReorg();

      await syncManager.sync();

      expect(await outputRow('kept-at-50')).not.toBeNull();
      expect(await outputRow('orphaned-at-58')).toBeNull();
      expect(await outputRow('spent-at-59')).toEqual({
        isSpent: 0,
        spentTxHash: null,
        spentBlockHeight: null,
      });
      expect(await outputRow('spent-at-57')).toEqual({
        isSpent: 1,
        spentTxHash: 'kept-spend',
        spentBlockHeight: 57,
      });
      expect(await outputRow('mempool-output')).not.toBeNull();
      expect(await outputRow('spent-in-mempool')).toEqual({
        isSpent: 1,
        spentTxHash: 'mempool-tx',
        spentBlockHeight: 0,
      });
      expect(syncManager.getLastSyncedHeight()).toBe(62);
    });

    it('leaves the wallet untouched when the revert fails part-way', async () => {
      await syncThenReorg();
      const stateBefore = await walletDB.loadSyncState();

      // Fail the last write of the revert, after the outputs were deleted.
      const adapter = walletDB.getAdapter();
      const run = adapter.run.bind(adapter);
      adapter.run = async (sql: string, params?: any[]) => {
        if (sql.startsWith('DELETE FROM block_hashes WHERE height >=')) {
          throw new Error('simulated crash');
        }
        return run(sql, params);
      };

      await expect(syncManager.sync()).rejects.toThrow('simulated crash');
      adapter.run = run;

      expect(await walletDB.loadSyncState()).toEqual(stateBefore);
      expect(await outputRow('orphaned-at-58')).not.toBeNull();
      expect(await outputRow('spent-at-59')).toEqual({
        isSpent: 1,
        spentTxHash: 'orphaned-spend',
        spentBlockHeight: 59,
      });
      expect(await walletDB.getBlockHash(59)).toBe(hashHeader(defaultHeader(59)));
    });
  });

  describe('reorganization recovery', () => {
    /** Sync a fresh wallet from genesis to `tip` on the default chain. */
    async function syncedWallet(
      tip: number,
      blockTxKeys = new Map<number, TransactionKeys[]>(),
      blockHashRetention?: number
    ) {
      const blockHeaders = new Map<number, string>();
      const provider = createMockSyncProvider({ chainTipHeight: tip, blockHeaders, blockTxKeys });
      syncManager = new TransactionKeysSync(walletDB, provider);
      await syncManager.initialize();
      await syncManager.sync({ startHeight: 0, blockHashRetention });
      expect(syncManager.getLastSyncedHeight()).toBe(tip);
      return { provider, blockHeaders, blockTxKeys };
    }

    function rangeFetchHeights(provider: SyncProvider): number[] {
      return vi.mocked(provider.getBlockTransactionKeysRange).mock.calls.map(([height]) => height);
    }

    it('reverts and re-scans the replacement block after a 1-block reorg', async () => {
      const { provider, blockHeaders, blockTxKeys } = await syncedWallet(60);
      await walletDB.storeWalletOutput(output('orphaned-at-60', 60));
      await walletDB.storeWalletOutput(
        output('spent-at-60', 40, { txHash: 'orphaned-spend', height: 60 })
      );
      await walletDB.storeWalletOutput(output('spent-by-new-60', 40));

      // Block 60 is replaced by one that spends a different wallet output.
      blockHeaders.set(60, branchHeader(60));
      blockTxKeys.set(60, [
        {
          txHash: 'replacement-spend',
          keys: { inputs: [{ outputHash: 'spent-by-new-60' }], outputs: [] },
        },
      ]);
      provider.setChainTip(61);
      vi.mocked(provider.getBlockTransactionKeysRange).mockClear();
      const onProgress = vi.fn();

      await syncManager.sync({ onProgress });

      expect(await outputRow('orphaned-at-60')).toBeNull();
      expect(await outputRow('spent-at-60')).toEqual({
        isSpent: 0,
        spentTxHash: null,
        spentBlockHeight: null,
      });
      // Only a re-scan of height 60 can have recorded this spend.
      expect(rangeFetchHeights(provider)[0]).toBe(60);
      expect(await outputRow('spent-by-new-60')).toEqual({
        isSpent: 1,
        spentTxHash: 'replacement-spend',
        spentBlockHeight: 60,
      });
      expect(await walletDB.getBlockHash(60)).toBe(hashHeader(branchHeader(60)));
      expect(syncManager.getLastSyncedHeight()).toBe(61);
      expect(syncManager.getSyncState()!.lastSyncedHash).toBe(hashHeader(defaultHeader(61)));
      expect(onProgress).toHaveBeenCalledWith(59, 61, 0, 0, true);
    });

    it('detects a reorg that replaces the tip block at the same height', async () => {
      const { provider, blockHeaders } = await syncedWallet(60);
      expect(await syncManager.isSyncNeeded()).toBe(false);

      blockHeaders.set(60, branchHeader(60));
      expect(await syncManager.isSyncNeeded()).toBe(true);
      vi.mocked(provider.getBlockTransactionKeysRange).mockClear();

      await syncManager.sync();

      expect(rangeFetchHeights(provider)).toEqual([60]);
      expect(await walletDB.getBlockHash(60)).toBe(hashHeader(branchHeader(60)));
      expect(syncManager.getSyncState()!.lastSyncedHash).toBe(hashHeader(branchHeader(60)));
      expect(await syncManager.isSyncNeeded()).toBe(false);
    });

    it('re-scans from the fork even when an explicit startHeight is past it', async () => {
      const { provider, blockHeaders } = await syncedWallet(60);
      blockHeaders.set(60, branchHeader(60));
      provider.setChainTip(62);
      vi.mocked(provider.getBlockTransactionKeysRange).mockClear();

      await syncManager.sync({ startHeight: 61 });

      expect(rangeFetchHeights(provider)[0]).toBe(60);
      expect(await walletDB.getBlockHash(60)).toBe(hashHeader(branchHeader(60)));
    });

    it('finds the fork point of a 3-block reorg', async () => {
      const { provider, blockHeaders } = await syncedWallet(60);
      for (let h = 58; h <= 60; h++) blockHeaders.set(h, branchHeader(h));
      vi.mocked(provider.getBlockTransactionKeysRange).mockClear();
      const onProgress = vi.fn();

      await syncManager.sync({ onProgress });

      expect(onProgress).toHaveBeenCalledWith(57, 60, 0, 0, true);
      expect(rangeFetchHeights(provider)[0]).toBe(58);
      expect(await walletDB.getBlockHash(57)).toBe(hashHeader(defaultHeader(57)));
      for (let h = 58; h <= 60; h++) {
        expect(await walletDB.getBlockHash(h)).toBe(hashHeader(branchHeader(h)));
      }
    });

    it('gives up with DeepReorgError past MAX_REORG_DEPTH instead of walking to genesis', async () => {
      const tip = MAX_REORG_DEPTH + 50;
      const { provider, blockHeaders } = await syncedWallet(tip);
      for (let h = 0; h <= tip; h++) blockHeaders.set(h, branchHeader(h));
      vi.mocked(provider.getBlockHeader).mockClear();
      vi.mocked(provider.getBlockHeaders).mockClear();

      const error = await syncManager.sync().catch(e => e);

      expect(error).toBeInstanceOf(DeepReorgError);
      expect(error).toMatchObject({
        reason: 'too-deep',
        lastSyncedHeight: tip,
        searchedDownTo: tip - MAX_REORG_DEPTH,
      });
      expect(provider.getBlockHeader).toHaveBeenCalledTimes(1);
      expect(provider.getBlockHeaders).toHaveBeenCalledTimes(1);
      expect(syncManager.getLastSyncedHeight()).toBe(tip);
      expect(await walletDB.getBlockHash(tip)).toBe(hashHeader(defaultHeader(tip)));
    });

    it('gives up with DeepReorgError when the fork is below the stored hashes', async () => {
      const { provider, blockHeaders } = await syncedWallet(60);
      await walletDB.deleteBlockHash(57); // as blockHashRetention pruning would
      for (let h = 58; h <= 60; h++) blockHeaders.set(h, branchHeader(h));
      vi.mocked(provider.getBlockHeader).mockClear();
      vi.mocked(provider.getBlockHeaders).mockClear();

      const error = await syncManager.sync().catch(e => e);

      expect(error).toBeInstanceOf(DeepReorgError);
      expect(error).toMatchObject({
        reason: 'missing-history',
        lastSyncedHeight: 60,
        searchedDownTo: 57,
      });
      expect(provider.getBlockHeader).toHaveBeenCalledTimes(1);
      expect(provider.getBlockHeaders).toHaveBeenCalledTimes(1);
      expect(syncManager.getLastSyncedHeight()).toBe(60);
    });

    describe('at the blockHashRetention limit', () => {
      // Retention 20 at tip 60 keeps the hashes of heights 41..60.
      const retention = 20;

      it('recovers from a reorg as deep as the retained hashes allow', async () => {
        const { blockHeaders } = await syncedWallet(60, undefined, retention);
        for (let h = 42; h <= 60; h++) blockHeaders.set(h, branchHeader(h));

        await syncManager.sync({ blockHashRetention: retention });

        expect(await walletDB.getBlockHash(41)).toBe(hashHeader(defaultHeader(41)));
        expect(await walletDB.getBlockHash(42)).toBe(hashHeader(branchHeader(42)));
        expect(syncManager.getLastSyncedHeight()).toBe(60);
      });

      it('reports a reorg one block deeper as too-deep, not missing-history', async () => {
        const { blockHeaders } = await syncedWallet(60, undefined, retention);
        for (let h = 41; h <= 60; h++) blockHeaders.set(h, branchHeader(h));

        const error = await syncManager.sync({ blockHashRetention: retention }).catch(e => e);

        expect(error).toBeInstanceOf(DeepReorgError);
        expect(error).toMatchObject({
          reason: 'too-deep',
          lastSyncedHeight: 60,
          searchedDownTo: 41,
        });
      });
    });

    it('does not revert when the server is merely behind the wallet', async () => {
      const { provider } = await syncedWallet(60);
      provider.setChainTip(58);

      await syncManager.sync();

      expect(syncManager.getLastSyncedHeight()).toBe(60);
      expect(await walletDB.getBlockHash(60)).toBe(hashHeader(defaultHeader(60)));
      expect(await syncManager.isSyncNeeded()).toBe(false);
    });
  });

  describe('sync state management', () => {
    it('should track sync progress', async () => {
      syncProvider = createMockSyncProvider({ chainTipHeight: 20 });
      syncManager = new TransactionKeysSync(walletDB, syncProvider);
      await syncManager.initialize();

      // Initially no sync state
      expect(syncManager.getLastSyncedHeight()).toBe(-1);

      // Sync some blocks
      await syncManager.sync({ startHeight: 0, endHeight: 10, verifyHashes: false });

      // Verify sync state is updated
      const syncState = syncManager.getSyncState();
      expect(syncState).not.toBeNull();
      expect(syncState!.lastSyncedHeight).toBeGreaterThanOrEqual(10);
    });

    it('should resume sync from last synced height', async () => {
      syncProvider = createMockSyncProvider({ chainTipHeight: 50 });
      syncManager = new TransactionKeysSync(walletDB, syncProvider);
      await syncManager.initialize();

      // First sync to height 20
      await syncManager.sync({ startHeight: 0, endHeight: 20, verifyHashes: false });
      const firstSyncHeight = syncManager.getLastSyncedHeight();
      expect(firstSyncHeight).toBeGreaterThanOrEqual(20);

      // Sync again without specifying startHeight - should resume
      await syncManager.sync({ endHeight: 40, verifyHashes: false });
      const secondSyncHeight = syncManager.getLastSyncedHeight();
      expect(secondSyncHeight).toBeGreaterThanOrEqual(40);
    });

    it('should report sync needed when behind chain tip', async () => {
      syncProvider = createMockSyncProvider({ chainTipHeight: 100 });
      syncManager = new TransactionKeysSync(walletDB, syncProvider);
      await syncManager.initialize();

      // Initially needs sync
      let needsSync = await syncManager.isSyncNeeded();
      expect(needsSync).toBe(true);

      // Sync to tip
      await syncManager.sync({ verifyHashes: false });

      // No longer needs sync (if at tip)
      needsSync = await syncManager.isSyncNeeded();
      expect(needsSync).toBe(false);
    });
  });

  describe('staked commitment flag', () => {
    // Claims every output so the fixture's outputs are stored; amount recovery
    // fails for them and is not what these tests are about.
    function claimEverything(manager: TransactionKeysSync): void {
      manager.setKeyManager({
        isMineByKeys: () => true,
        calculateNonce: () => {
          throw new Error('not recovering amounts here');
        },
      } as any);
    }

    async function stakedFlags(): Promise<Record<string, boolean>> {
      return Object.fromEntries(
        (await walletDB.getAllOutputs()).map(o => [o.outputHash, o.isStakedCommitment])
      );
    }

    const fixtureOutputs = () => parseTransaction(Buffer.from(STAKED_TX_HEX, 'hex')).outputs;

    it('is set on staked outputs found by block sync', async () => {
      const [staked, fee] = fixtureOutputs();
      expect(isStakedCommitmentOutput(staked)).toBe(true);
      expect(isStakedCommitmentOutput(fee)).toBe(false);

      const keysOf = (outputHash: string) => ({
        outputHash,
        blindingKey: staked.keys!.blindingKey,
        spendingKey: staked.keys!.spendingKey,
        viewTag: staked.keys!.viewTag,
      });
      syncProvider = createMockSyncProvider({
        chainTipHeight: 60,
        blockTxKeys: new Map([
          [60, [{ txHash: 'staking-tx', keys: { inputs: [], outputs: [keysOf('staked'), keysOf('fee')] } }]],
        ]),
      });
      const serialized: Record<string, string> = { staked: staked.serializedHex, fee: fee.serializedHex };
      syncProvider.getTransactionOutput = vi.fn(async (hash: string) => serialized[hash]);
      syncManager = new TransactionKeysSync(walletDB, syncProvider);
      await syncManager.initialize();
      claimEverything(syncManager);

      await syncManager.sync({ startHeight: 60, endHeight: 60, verifyHashes: false });

      expect(await stakedFlags()).toEqual({ staked: true, fee: false });
    });

    it('is set on staked outputs found in the mempool', async () => {
      syncProvider = createMockSyncProvider({ chainTipHeight: 100 });
      syncManager = new TransactionKeysSync(walletDB, syncProvider);
      claimEverything(syncManager);

      await syncManager.processMempoolTransaction('staking-tx', STAKED_TX_HEX);

      expect(await stakedFlags()).toEqual({
        'mempool:staking-tx:0': true,
        'mempool:staking-tx:1': false,
      });
    });
  });

  describe('txType and timestamp fields', () => {
    it('getUnspentOutputs should include txType and timestamp fields', async () => {
      syncProvider = createMockSyncProvider({ chainTipHeight: 100 });
      syncManager = new TransactionKeysSync(walletDB, syncProvider);
      await syncManager.initialize();

      const db = walletDB.getAdapter();

      // Insert outputs with explicit txType and timestamp
      await db.run(`
        INSERT INTO wallet_outputs 
        (output_hash, tx_hash, output_index, block_height, output_data, amount, is_spent, created_at, tx_type, timestamp)
        VALUES 
        ('recv-output', 'recv-tx', 0, 50, 'data', 1000000, 0, ?, 'received', 1700000000),
        ('sent-output', 'sent-tx', 0, 55, 'data', 500000, 0, ?, 'sent', 1700100000),
        ('stake-output', 'stake-tx', 0, 60, 'data', 2000000, 0, ?, 'stake', 1700200000)
      `, [Date.now(), Date.now(), Date.now()]);

      const outputs = await walletDB.getUnspentOutputs();

      expect(outputs).toHaveLength(3);

      const received = outputs.find(o => o.outputHash === 'recv-output');
      expect(received).toBeDefined();
      expect(received!.txType).toBe('received');
      expect(received!.timestamp).toBe(1700000000);

      const sent = outputs.find(o => o.outputHash === 'sent-output');
      expect(sent).toBeDefined();
      expect(sent!.txType).toBe('sent');
      expect(sent!.timestamp).toBe(1700100000);

      const stake = outputs.find(o => o.outputHash === 'stake-output');
      expect(stake).toBeDefined();
      expect(stake!.txType).toBe('stake');
      expect(stake!.timestamp).toBe(1700200000);
    });

    it('getAllOutputs should include txType and timestamp fields', async () => {
      syncProvider = createMockSyncProvider({ chainTipHeight: 100 });
      syncManager = new TransactionKeysSync(walletDB, syncProvider);
      await syncManager.initialize();

      const db = walletDB.getAdapter();

      // Insert one spent and one unspent output with metadata
      await db.run(`
        INSERT INTO wallet_outputs 
        (output_hash, tx_hash, output_index, block_height, output_data, amount, is_spent, spent_tx_hash, spent_block_height, created_at, tx_type, timestamp)
        VALUES 
        ('unspent-out', 'tx-a', 0, 50, 'data', 1000000, 0, NULL, NULL, ?, 'received', 1700000000),
        ('spent-out', 'tx-b', 0, 60, 'data', 2000000, 1, 'spending-tx', 70, ?, 'stake', 1700200000)
      `, [Date.now(), Date.now()]);

      const outputs = await walletDB.getAllOutputs();

      expect(outputs).toHaveLength(2);

      const unspent = outputs.find(o => o.outputHash === 'unspent-out');
      expect(unspent!.txType).toBe('received');
      expect(unspent!.timestamp).toBe(1700000000);

      const spent = outputs.find(o => o.outputHash === 'spent-out');
      expect(spent!.txType).toBe('stake');
      expect(spent!.timestamp).toBe(1700200000);
    });

    it('outputs inserted without txType and timestamp should use defaults', async () => {
      syncProvider = createMockSyncProvider({ chainTipHeight: 100 });
      syncManager = new TransactionKeysSync(walletDB, syncProvider);
      await syncManager.initialize();

      const db = walletDB.getAdapter();

      // Insert output using the old schema (no tx_type or timestamp columns)
      await db.run(`
        INSERT INTO wallet_outputs 
        (output_hash, tx_hash, output_index, block_height, output_data, amount, is_spent, created_at)
        VALUES ('legacy-output', 'legacy-tx', 0, 50, 'data', 1000000, 0, ?)
      `, [Date.now()]);

      const outputs = await walletDB.getUnspentOutputs();
      expect(outputs).toHaveLength(1);
      expect(outputs[0].txType).toBe('received');
      expect(outputs[0].timestamp).toBe(0);
    });
  });
});
