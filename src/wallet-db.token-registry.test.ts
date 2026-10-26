import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WalletDB } from './wallet-db';
import type { StoreOutputParams, TokenRegistryEntry } from './wallet-db.interface';

const ENTRY: TokenRegistryEntry = {
  publicTokenId: 'ab'.repeat(32),
  kind: 'nft',
  metadata: { name: 'Collection' },
  totalSupply: '18446744073709551615',
  mintedNft: { '1': { name: 'First' } },
  fetchedAt: 1_700_000_000_000,
};

describe('WalletDB token registry cache', () => {
  let walletDB: WalletDB;

  beforeEach(async () => {
    walletDB = new WalletDB({ type: 'better-sqlite3' });
    await walletDB.open(':memory:');
  });

  afterEach(async () => {
    await walletDB.close();
  });

  it('stores an entry and replaces it by public token id', async () => {
    expect(await walletDB.getTokenRegistryEntry(ENTRY.publicTokenId)).toBeNull();

    await walletDB.saveTokenRegistryEntry(ENTRY);
    expect(await walletDB.getTokenRegistryEntry(ENTRY.publicTokenId)).toEqual(ENTRY);

    const updated = { ...ENTRY, mintedNft: { ...ENTRY.mintedNft, '2': { name: 'Second' } } };
    await walletDB.saveTokenRegistryEntry(updated);
    expect(await walletDB.getTokenRegistryEntry(ENTRY.publicTokenId)).toEqual(updated);
    expect(await walletDB.getTokenRegistryEntry('cd'.repeat(32))).toBeNull();
  });

  it('keeps entries for the same wallet and drops them for another', async () => {
    const output: StoreOutputParams = {
      outputHash: '01'.repeat(32),
      txHash: 'cc'.repeat(32),
      outputIndex: 0,
      blockHeight: 10,
      outputData: '',
      amount: 1,
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
    const mnemonic = (await walletDB.createWallet()).getMnemonic();
    await walletDB.storeWalletOutput(output);
    await walletDB.saveTokenRegistryEntry(ENTRY);

    await walletDB.restoreWalletFromMnemonic(mnemonic);
    expect(await walletDB.getTokenRegistryEntry(ENTRY.publicTokenId)).toEqual(ENTRY);

    await walletDB.createWallet();
    expect(await walletDB.getTokenRegistryEntry(ENTRY.publicTokenId)).toBeNull();
  });
});
