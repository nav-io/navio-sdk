import { afterEach, describe, expect, it } from 'vitest';
import { WalletDB } from './wallet-db';
import type { StoreOutputParams } from './wallet-db.interface';

const MNEMONIC_A =
  'short exact vendor hand scale enroll around pudding genius party lesson basket cook crash sugar protect advance gentle humor bench farm weekend direct awkward';
const MNEMONIC_B =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

function sampleOutput(outputHash: string): StoreOutputParams {
  return {
    outputHash,
    txHash: 'aa'.repeat(32),
    outputIndex: 0,
    blockHeight: 10,
    outputData: '',
    amount: 1_000_000,
    gamma: '01',
    memo: null,
    tokenId: null,
    blindingKey: '02',
    spendingKey: '03',
    isSpent: false,
    spentTxHash: null,
    spentBlockHeight: null,
    txType: 'received',
    timestamp: 0,
  };
}

describe('WalletDB sub-address persistence', () => {
  let walletDB: WalletDB | null = null;

  afterEach(async () => {
    if (walletDB) {
      await walletDB.close();
      walletDB = null;
    }
  });

  it('keeps sub-addresses generated past the default pool across a reload', async () => {
    walletDB = new WalletDB({ type: 'better-sqlite3' });
    await walletDB.open(':memory:');
    const km = await walletDB.restoreWalletFromMnemonic(MNEMONIC_A, 0);

    let last: { account: number; address: number } | null = null;
    for (let i = 0; i < 5; i++) {
      last = km.generateNewSubAddress(0).id;
    }
    expect(last!.address).toBeGreaterThanOrEqual(100);
    const entry = km.getSubAddressEntries().find((e) => e.address === last!.address && e.account === 0)!;
    await walletDB.saveSubAddresses([entry]);

    const reloaded = await walletDB.loadWallet();
    const id = { account: 0, address: 0 };
    expect(reloaded.getSubAddressId(Uint8Array.from(Buffer.from(entry.hashId, 'hex')), id)).toBe(true);
    expect(id).toEqual(last);
    // Default pool entries are still there.
    expect(reloaded.getSubAddressEntries().length).toBeGreaterThanOrEqual(301);
    // And generation continues past the persisted index.
    expect(reloaded.generateNewSubAddress(0).id.address).toBe(last!.address + 1);
  });

  it('drops outputs and sync state when a different seed is restored into the database', async () => {
    walletDB = new WalletDB({ type: 'better-sqlite3' });
    await walletDB.open(':memory:');
    const walletA = await walletDB.restoreWalletFromMnemonic(MNEMONIC_A, 0);
    await walletDB.storeWalletOutput(sampleOutput('11'.repeat(32)));
    await walletDB.saveSyncState({
      lastSyncedHeight: 10,
      lastSyncedHash: 'bb'.repeat(32),
      totalTxKeysSynced: 1,
      lastSyncTime: 0,
      chainTipAtLastSync: 10,
    });
    expect(await walletDB.getAllOutputs()).toHaveLength(1);

    // Same seed again: nothing is lost (no forced re-sync).
    await walletDB.restoreWalletFromMnemonic(MNEMONIC_A, 0);
    expect(await walletDB.getAllOutputs()).toHaveLength(1);
    expect((await walletDB.loadSyncState())?.lastSyncedHeight).toBe(10);

    // Different seed: the previous wallet's outputs cannot be spent by the new
    // keys, so they and the sync progress go.
    const restored = await walletDB.restoreWalletFromMnemonic(MNEMONIC_B, 0);
    expect(restored.getAuditKeyHex()).not.toBe(walletA.getAuditKeyHex());
    expect(await walletDB.getAllOutputs()).toHaveLength(0);
    expect(await walletDB.loadSyncState()).toBeNull();
  });
});
