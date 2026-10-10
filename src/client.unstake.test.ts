import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CTxId,
  OutPoint,
  Point,
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
import { NavioClient } from './client';
import type { KeyManager } from './key-manager';
import { parseTransaction, type ParsedOutput } from './p2p-block-parser';
import { isStakedCommitmentOutput, recoverStakeDelegation } from './staking';
import { TransactionKeysSync } from './tx-keys-sync';
import { WalletDB } from './wallet-db';

const NAV = 100_000_000n;
const MIN_STAKE = 100n * NAV;
const REWARD_ADDRESS = 'rnv1rewardaddress';

describe('NavioClient.unstake', () => {
  let walletDB: WalletDB;
  let keyManager: KeyManager;
  let syncManager: TransactionKeysSync;
  let client: NavioClient;
  let broadcast: ReturnType<typeof vi.fn>;
  let nextTx = 1;

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
    syncManager = new TransactionKeysSync(walletDB, {} as any);
    syncManager.setKeyManager(keyManager);
    Object.assign(client as any, {
      initialized: true,
      walletDB,
      keyManager,
      syncManager,
      syncProvider: { isConnected: () => true },
      broadcastRawTransaction: broadcast,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await walletDB.close();
  });

  /**
   * Put a confirmed staked commitment of `amount` on the wallet's staking
   * address, delegated to `delegateKey` unless that is null. The wallet's
   * own mempool scan recovers its amount and gamma, so the wallet can spend
   * it for real; the row is then stored as sync stores a confirmed output.
   */
  async function stake(
    amount: bigint,
    delegateKey: Point | null,
    storeOutputData = true
  ): Promise<string> {
    const destination = keyManager.getSubAddress({ account: -2, address: 0 });
    const output = UnsignedOutput.fromTxOut(
      TxOut.generate(
        destination,
        Number(amount),
        '',
        TokenId.default(),
        TxOutputType.StakedCommitment,
        Number(MIN_STAKE),
        false,
        Scalar.random()
      )
    );
    if (delegateKey !== null) {
      output.setStakeDelegation(destination, delegateKey, REWARD_ADDRESS);
    }
    const fee = 1_000n;
    const unsignedTx = UnsignedTransaction.create();
    const outPoint = OutPoint.generate(
      CTxId.deserialize((nextTx++).toString(16).padStart(64, '0'))
    );
    unsignedTx.addInput(
      UnsignedInput.fromTxIn(
        TxIn.generate(
          Number(amount + fee),
          new Scalar(5),
          new Scalar(6),
          TokenId.default(),
          outPoint
        )
      )
    );
    unsignedTx.addOutput(output);
    unsignedTx.setFee(Number(fee));
    const rawTx = unsignedTx.sign();
    const staked = parseTransaction(Buffer.from(rawTx, 'hex')).outputs.find(
      isStakedCommitmentOutput
    )!;

    const txHash = `stake-${nextTx}`;
    await syncManager.processMempoolTransaction(txHash, rawTx);
    const scanned = (await walletDB.getAllOutputs()).find(
      o => o.outputHash === `mempool:${txHash}:${staked.index}`
    )!;
    expect(scanned.amount).toBe(amount);
    await walletDB.deleteUnconfirmedOutputsByTxHash(txHash);
    await walletDB.storeWalletOutput({
      ...scanned,
      outputHash: staked.outputHash,
      txHash,
      blockHeight: 10,
      outputData: storeOutputData ? staked.serializedHex : '',
      amount: Number(scanned.amount),
    });
    return staked.outputHash;
  }

  /** The wallet's mempool rows for the broadcast unstake transaction. */
  async function unstakeOutputs() {
    return (await walletDB.getAllOutputs())
      .filter(o => o.blockHeight === 0)
      .map(o => ({ amount: o.amount, staked: o.isStakedCommitment }));
  }

  function restaked(rawTx: string): ParsedOutput {
    return parseTransaction(Buffer.from(rawTx, 'hex')).outputs.find(isStakedCommitmentOutput)!;
  }

  function delegationOf(output: ParsedOutput) {
    return recoverStakeDelegation(
      output,
      keyManager.calculateNonce(PublicKey.deserialize(output.keys!.blindingKey))
    );
  }

  it('unlocks a whole delegated stake, spending it as a staked input', async () => {
    const hash = await stake(2n * MIN_STAKE, Point.random());
    const generate = vi.spyOn(TxIn, 'generate');

    const result = await client.unstake();

    expect(broadcast).toHaveBeenCalledWith(result.rawTx);
    expect(generate.mock.calls.every(call => call[5] === true)).toBe(true);
    expect(generate).toHaveBeenCalled();
    // The unlocked output and the fee output; nothing staked again.
    expect(result.outputCount).toBe(2);
    expect(await unstakeOutputs()).toEqual([
      { amount: 2n * MIN_STAKE - result.fee, staked: false },
    ]);
    expect(await walletDB.isOutputUnspent(hash)).toBe(false);
    expect(await client.getStakedBalance()).toBe(0n);
  });

  it('stakes the rest again under the same delegation', async () => {
    const delegateKey = Point.random();
    await stake(3n * MIN_STAKE, delegateKey);

    const result = await client.unstake({ amount: MIN_STAKE });

    expect((await unstakeOutputs()).sort((a, b) => Number(a.amount - b.amount))).toEqual([
      { amount: MIN_STAKE - result.fee, staked: false },
      { amount: 2n * MIN_STAKE, staked: true },
    ]);
    expect(delegationOf(restaked(result.rawTx))).toEqual({
      delegateKey: delegateKey.serialize(),
      rewardAddress: REWARD_ADDRESS,
    });
  });

  it('leaves the rest undelegated when the spent stakes were', async () => {
    await stake(3n * MIN_STAKE, null);

    const result = await client.unstake({ amount: MIN_STAKE });

    expect(delegationOf(restaked(result.rawTx))).toBeNull();
  });

  it('spends only the chosen stakes', async () => {
    const chosen = await stake(MIN_STAKE, Point.random());
    const other = await stake(MIN_STAKE, Point.random());

    await client.unstake({ stakedOutputs: [chosen] });

    expect(await walletDB.isOutputUnspent(chosen)).toBe(false);
    expect(await walletDB.isOutputUnspent(other)).toBe(true);
  });

  it('refuses a partial unstake across differently delegated stakes', async () => {
    await stake(MIN_STAKE, Point.random());
    await stake(MIN_STAKE, null);

    await expect(client.unstake({ amount: MIN_STAKE / 2n })).rejects.toThrow(
      /delegated differently/
    );
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('refuses a partial unstake when a delegation cannot be read', async () => {
    await stake(3n * MIN_STAKE, Point.random(), false);

    await expect(client.unstake({ amount: MIN_STAKE })).rejects.toThrow(
      /Cannot read the delegation/
    );
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('refuses to leave less than the minimum stake behind', async () => {
    await stake(MIN_STAKE + NAV, Point.random());

    await expect(client.unstake({ amount: 2n * NAV })).rejects.toThrow(/below the minimum stake/);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('refuses unknown, repeated or excessive selections', async () => {
    const hash = await stake(MIN_STAKE, null);

    await expect(client.unstake({ stakedOutputs: ['ab'.repeat(32)] })).rejects.toThrow(
      /Not a confirmed, unspent staked output/
    );
    await expect(client.unstake({ stakedOutputs: [hash, hash] })).rejects.toThrow(/more than once/);
    await expect(client.unstake({ stakedOutputs: [] })).rejects.toThrow(/must not be empty/);
    await expect(client.unstake({ amount: MIN_STAKE + 1n })).rejects.toThrow(/at most/);
    await expect(client.unstake({ amount: 0n })).rejects.toThrow(/positive/);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('refuses when there is nothing staked', async () => {
    await expect(client.unstake()).rejects.toThrow(/No confirmed staked outputs/);
  });
});
