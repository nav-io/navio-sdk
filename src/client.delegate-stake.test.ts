import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Address,
  AddressEncoding,
  CTxId,
  DoublePublicKey,
  OutPoint,
  Point,
  PublicKey,
  Scalar,
  TokenId,
  TxIn,
} from '@nav-io/navio-blsct';
import { NavioClient } from './client';
import type { KeyManager } from './key-manager';
import { parseTransaction } from './p2p-block-parser';
import { isStakedCommitmentOutput, recoverStakeDelegation } from './staking';
import { TransactionKeysSync } from './tx-keys-sync';
import { WalletDB } from './wallet-db';
import type { WalletOutput } from './wallet-db.interface';

const NAV = 100_000_000n;
const MIN_STAKE = 100n * NAV;
const FUNDING = 1_000n * NAV;

describe('NavioClient.delegateStake', () => {
  let walletDB: WalletDB;
  let keyManager: KeyManager;
  let client: NavioClient;
  let broadcast: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    walletDB = new WalletDB({ type: 'better-sqlite3' });
    await walletDB.open(':memory:');
    keyManager = await walletDB.createWallet(0);
    client = new NavioClient({
      network: 'regtest',
      backend: 'electrum',
      electrum: { host: 'localhost', port: 50005 },
      walletDbPath: ':memory:',
      minStakeAmount: MIN_STAKE,
    });
    broadcast = vi.fn().mockResolvedValue('broadcast-hash');
    const syncManager = new TransactionKeysSync(walletDB, {} as any);
    syncManager.setKeyManager(keyManager);
    Object.assign(client as any, {
      initialized: true,
      walletDB,
      keyManager,
      syncManager,
      syncProvider: { isConnected: () => true },
      broadcastRawTransaction: broadcast,
      // The funding output below is not a real chain output, so sign for it
      // with a known key instead of deriving one from the wallet.
      resolveOutputSubAddress: () => ({ account: 0, address: 0 }),
      buildTxInput: (utxo: WalletOutput) =>
        TxIn.generate(
          Number(utxo.amount),
          new Scalar(7),
          new Scalar(8),
          TokenId.default(),
          OutPoint.generate(CTxId.deserialize(utxo.outputHash))
        ),
    });
    await walletDB.storeWalletOutput({
      outputHash: '51'.repeat(32),
      txHash: 'cc'.repeat(32),
      outputIndex: 0,
      blockHeight: 10,
      outputData: '',
      amount: Number(FUNDING),
      gamma: '0',
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
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await walletDB.close();
  });

  it('stakes to the staking address, delegated, with NAV change', async () => {
    const delegateKey = Point.random();
    const result = await client.delegateStake({
      amount: 2n * MIN_STAKE,
      delegateKey: delegateKey.serialize(),
    });

    expect(broadcast).toHaveBeenCalledWith(result.rawTx);
    expect(result.inputCount).toBe(1);
    // The staked output, the change and the fee output.
    expect(result.outputCount).toBe(3);

    const staked = parseTransaction(Buffer.from(result.rawTx, 'hex')).outputs.find(
      isStakedCommitmentOutput
    )!;
    expect(
      recoverStakeDelegation(
        staked,
        keyManager.calculateNonce(PublicKey.deserialize(staked.keys!.blindingKey))
      )
    ).toEqual({
      delegateKey: delegateKey.serialize(),
      rewardAddress: keyManager.getSubAddressBech32m({ account: 0, address: 0 }, 'regtest'),
    });

    // The wallet's own scan of the broadcast: the stake is its own, on the
    // staking account, and the change is what is left after the fee.
    const received = (await walletDB.getAllOutputs()).filter(o => o.blockHeight === 0);
    expect(received.map(o => [o.amount, o.isStakedCommitment]).sort()).toEqual(
      [
        [2n * MIN_STAKE, true],
        [FUNDING - 2n * MIN_STAKE - result.fee, false],
      ].sort()
    );
    const stakedRow = received.find(o => o.isStakedCommitment)!;
    const hashId = keyManager.calculateHashId(
      PublicKey.deserialize(stakedRow.blindingKey),
      PublicKey.deserialize(stakedRow.spendingKey)
    );
    const subAddressId = { account: 0, address: 0 };
    expect(keyManager.getSubAddressId(hashId, subAddressId)).toBe(true);
    expect(subAddressId).toEqual({ account: -2, address: 0 });
  });

  it('pays rewards to a given address, in its canonical form', async () => {
    const reward = Address.encode(DoublePublicKey.random(), AddressEncoding.Bech32M);
    const result = await client.delegateStake({
      amount: MIN_STAKE,
      delegateKey: Point.random().serialize(),
      rewardAddress: reward.toUpperCase(),
    });

    const staked = parseTransaction(Buffer.from(result.rawTx, 'hex')).outputs.find(
      isStakedCommitmentOutput
    )!;
    const nonce = keyManager.calculateNonce(PublicKey.deserialize(staked.keys!.blindingKey));
    expect(recoverStakeDelegation(staked, nonce)?.rewardAddress).toBe(reward);
  });

  it('refuses a stake below the minimum', async () => {
    await expect(
      client.delegateStake({ amount: MIN_STAKE - 1n, delegateKey: Point.random().serialize() })
    ).rejects.toThrow(/minimum of 10000000000 sat/);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('refuses an identity or malformed delegate key', async () => {
    for (const delegateKey of ['c0' + '00'.repeat(47), 'ab'.repeat(48), 'zz']) {
      await expect(client.delegateStake({ amount: MIN_STAKE, delegateKey })).rejects.toThrow(
        /delegateKey/
      );
    }
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('refuses a reward address with null keys or from another network', async () => {
    const identity = 'c0' + '00'.repeat(47);
    const nullKeys = Address.encode(
      DoublePublicKey.deserialize(identity + Point.random().serialize()),
      AddressEncoding.Bech32M
    );
    await expect(
      client.delegateStake({
        amount: MIN_STAKE,
        delegateKey: Point.random().serialize(),
        rewardAddress: nullKeys,
      })
    ).rejects.toThrow(/null keys/);

    const mainnetAddress = keyManager.getSubAddressBech32m({ account: 0, address: 0 }, 'mainnet');
    await expect(
      client.delegateStake({
        amount: MIN_STAKE,
        delegateKey: Point.random().serialize(),
        rewardAddress: mainnetAddress,
      })
    ).rejects.toThrow(/mainnet/);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('refuses a stake the wallet cannot fund', async () => {
    await expect(
      client.delegateStake({ amount: FUNDING, delegateKey: Point.random().serialize() })
    ).rejects.toThrow(
      new RegExp(`Insufficient funds: need \\d+ sat \\(${FUNDING} \\+ \\d+ fee\\)`)
    );
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('NavioClient.getMinStakeAmount', () => {
  const make = (network: 'mainnet' | 'regtest', minStakeAmount?: bigint) =>
    new NavioClient({
      network,
      backend: 'electrum',
      electrum: { host: 'localhost', port: 50005 },
      walletDbPath: ':memory:',
      ...(minStakeAmount === undefined ? {} : { minStakeAmount }),
    });

  it("is the network's consensus minimum unless the config overrides it", () => {
    expect(make('mainnet').getMinStakeAmount()).toBe(10_000n * NAV);
    expect(make('regtest').getMinStakeAmount()).toBe(10_000n * NAV);
    expect(make('regtest', 100n * NAV).getMinStakeAmount()).toBe(100n * NAV);
  });
});
