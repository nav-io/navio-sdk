import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey, Scalar, TokenId, TxIn } from '@nav-io/navio-blsct';
import { NavioClient } from './client';
import { WalletDB } from './wallet-db';
import type { StoreOutputParams, WalletOutput } from './wallet-db.interface';

function output(outputHash: string, overrides: Partial<StoreOutputParams> = {}): StoreOutputParams {
  return {
    outputHash,
    txHash: 'cc'.repeat(32),
    outputIndex: 0,
    blockHeight: 10,
    outputData: '',
    amount: 1_000,
    gamma: '0',
    memo: null,
    tokenId: null,
    blindingKey: PublicKey.random().serialize(),
    ephemeralKey: null,
    spendingKey: PublicKey.random().serialize(),
    isSpent: false,
    spentTxHash: null,
    spentBlockHeight: null,
    txType: 'received',
    timestamp: 0,
    ...overrides,
  };
}

describe('NavioClient staked outputs', () => {
  let walletDB: WalletDB;
  let client: NavioClient;

  beforeEach(async () => {
    walletDB = new WalletDB({ type: 'better-sqlite3' });
    await walletDB.open(':memory:');
    client = new NavioClient({
      network: 'testnet',
      backend: 'electrum',
      electrum: { host: 'testnet.nav.io', port: 50005 },
      walletDbPath: ':memory:',
    });
    (client as any).walletDB = walletDB;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await walletDB.close();
  });

  it('reports staked NAV apart from the spendable balance', async () => {
    await walletDB.storeWalletOutput(output('01'.repeat(32), { amount: 100 }));
    await walletDB.storeWalletOutput(
      output('02'.repeat(32), { amount: 5_000, isStakedCommitment: true })
    );
    await walletDB.storeWalletOutput(
      output('03'.repeat(32), {
        amount: 7_000,
        isStakedCommitment: true,
        isSpent: true,
        spentBlockHeight: 20,
      })
    );

    expect(await client.getBalance()).toBe(100n);
    expect((await client.getUnspentOutputs()).map(o => o.outputHash)).toEqual(['01'.repeat(32)]);
    expect((await client.getStakedOutputs()).map(o => o.outputHash)).toEqual(['02'.repeat(32)]);
    expect(await client.getStakedBalance()).toBe(5_000n);
  });

  it('marks the input staked when it spends a staked commitment', () => {
    (client as any).keyManager = {
      getPrivateViewKey: () => new Scalar(11),
      getSpendingKey: () => new Scalar(12),
    };
    vi.spyOn(client as any, 'resolveOutputSubAddress').mockReturnValue({ account: 0, address: 0 });
    const generate = vi.spyOn(TxIn, 'generate');

    const toWalletOutput = (p: StoreOutputParams): WalletOutput => ({
      ...p,
      amount: BigInt(p.amount),
      ephemeralKey: p.ephemeralKey ?? null,
      isStakedCommitment: p.isStakedCommitment ?? false,
    });
    (client as any).buildTxInput(toWalletOutput(output('04'.repeat(32))), TokenId.default());
    (client as any).buildTxInput(
      toWalletOutput(output('05'.repeat(32), { isStakedCommitment: true })),
      TokenId.default()
    );

    expect(generate.mock.calls.map(call => call[5])).toEqual([false, true]);
  });
});
