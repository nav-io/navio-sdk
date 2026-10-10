import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CTxId,
  OutPoint,
  Point,
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
import { isStakedCommitmentOutput } from './staking';
import { WalletDB } from './wallet-db';

const STAKE = 10_000;
const FEE = 1_000;
const REWARD_ADDRESS = 'rnv1rewardaddress';

describe('NavioClient.getStakeDelegations', () => {
  let walletDB: WalletDB;
  let keyManager: KeyManager;
  let client: NavioClient;

  beforeEach(async () => {
    walletDB = new WalletDB({ type: 'better-sqlite3' });
    await walletDB.open(':memory:');
    keyManager = await walletDB.createWallet(0);
    client = new NavioClient({
      network: 'testnet',
      backend: 'electrum',
      electrum: { host: 'testnet.nav.io', port: 50005 },
      walletDbPath: ':memory:',
    });
    (client as any).walletDB = walletDB;
    (client as any).keyManager = keyManager;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await walletDB.close();
  });

  /**
   * Sign a transaction staking to `owner`'s staking sub-address and return its
   * staked output, delegated to `delegateKey` unless that is null.
   */
  function stakedOutput(owner: KeyManager, delegateKey: Point | null): ParsedOutput {
    const destination = owner.getSubAddress({ account: -2, address: 0 });
    const output = UnsignedOutput.fromTxOut(
      TxOut.generate(
        destination,
        STAKE,
        '',
        TokenId.default(),
        TxOutputType.StakedCommitment,
        0,
        false,
        Scalar.random()
      )
    );
    if (delegateKey !== null) {
      output.setStakeDelegation(destination, delegateKey, REWARD_ADDRESS);
    }
    const unsignedTx = UnsignedTransaction.create();
    const outPoint = OutPoint.generate(CTxId.deserialize('51'.repeat(32)));
    unsignedTx.addInput(
      UnsignedInput.fromTxIn(
        TxIn.generate(STAKE + FEE, new Scalar(100), new Scalar(101), TokenId.default(), outPoint)
      )
    );
    unsignedTx.addOutput(output);
    unsignedTx.setFee(FEE);
    return parseTransaction(Buffer.from(unsignedTx.sign(), 'hex')).outputs.find(
      isStakedCommitmentOutput
    )!;
  }

  async function store(output: ParsedOutput, outputData = output.serializedHex): Promise<void> {
    await walletDB.storeWalletOutput({
      outputHash: output.outputHash,
      txHash: 'cc'.repeat(32),
      outputIndex: output.index,
      blockHeight: 10,
      outputData,
      amount: STAKE,
      gamma: '0',
      memo: null,
      tokenId: null,
      blindingKey: output.keys!.blindingKey,
      ephemeralKey: output.keys!.ephemeralKey,
      spendingKey: output.keys!.spendingKey,
      isSpent: false,
      spentTxHash: null,
      spentBlockHeight: null,
      txType: 'sent',
      timestamp: 0,
      isStakedCommitment: true,
    });
  }

  it('reads the delegate key and reward address back from a delegated stake', async () => {
    const delegateKey = Point.random();
    const delegated = stakedOutput(keyManager, delegateKey);
    await store(delegated);

    expect(await client.getStakeDelegations()).toEqual([
      {
        outputHash: delegated.outputHash,
        amount: BigInt(STAKE),
        blockHeight: 10,
        delegateKey: delegateKey.serialize(),
        rewardAddress: REWARD_ADDRESS,
      },
    ]);
  });

  it('leaves out stakes with no delegation and stakes with no stored output', async () => {
    await store(stakedOutput(keyManager, null));
    await store(stakedOutput(keyManager, Point.random()), '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await client.getStakeDelegations()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips, with a warning, a delegation this wallet cannot open', async () => {
    const otherWallet = new WalletDB({ type: 'better-sqlite3' });
    await otherWallet.open(':memory:');
    const foreign = stakedOutput(await otherWallet.createWallet(0), Point.random());
    await otherWallet.close();
    await store(foreign);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await client.getStakeDelegations()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(foreign.outputHash.slice(0, 16));
  });
});
