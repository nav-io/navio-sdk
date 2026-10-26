import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Address,
  AddressEncoding,
  BlsctChain,
  CTxId,
  DoublePublicKey,
  OutPoint,
  PublicKey,
  Scalar,
  SubAddr,
  SubAddrId,
  TokenId,
  TxIn,
  TxOut,
  UnsignedOutput,
  setChain,
} from '@nav-io/navio-blsct';
import { NavioClient } from './client';
import { WalletDB } from './wallet-db';
import type { WalletOutput } from './wallet-db.interface';

const NAV = 100_000_000n;
const OWN_KEY = PublicKey.fromScalar(new Scalar(501)).serialize();
const FOREIGN_KEY = PublicKey.fromScalar(new Scalar(502)).serialize();
const RPC_TOKEN_HASH = 'b12a2ee7491ef649c0a6677fe2e996065f02210f84a934297cc8ba554f54e31c';
const STORED_TOKEN_ID = RPC_TOKEN_HASH.match(/../g)!.reverse().join('') + 'ffffffffffffffff';

function testAddress(seed: number): string {
  setChain(BlsctChain.Testnet);
  const subAddr = SubAddr.generate(
    new Scalar(seed),
    PublicKey.fromScalar(new Scalar(seed + 1)),
    SubAddrId.generate(7, 9)
  );
  return Address.encode(DoublePublicKey.deserialize(subAddr.serialize()), AddressEncoding.Bech32M);
}

function fundingTxIn(seed: number, amount: number, tokenId: InstanceType<typeof TokenId>) {
  return TxIn.generate(
    amount,
    new Scalar(seed + 1),
    new Scalar(seed + 2),
    tokenId,
    OutPoint.generate(CTxId.deserialize(seed.toString(16).padStart(64, '0'))),
    false,
    false
  );
}

/**
 * A client over a real (in-memory) wallet database whose outputs are stored
 * directly. Signing uses stand-in inputs, and outputs keyed with FOREIGN_KEY
 * do not map to the wallet's keys.
 */
describe('NavioClient spend safety', () => {
  let walletDB: WalletDB;
  let client: NavioClient;
  let broadcast: ReturnType<typeof vi.fn>;
  let nextSeed = 1000;

  beforeEach(async () => {
    walletDB = new WalletDB({ type: 'better-sqlite3' });
    await walletDB.open(':memory:');
    client = new NavioClient({
      network: 'testnet',
      backend: 'electrum',
      electrum: { host: 'localhost', port: 50005 },
      walletDbPath: ':memory:',
    });
    // Slow enough that two sends overlap unless something serializes them.
    broadcast = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return 'broadcast-hash';
    });
    Object.assign(client as any, {
      initialized: true,
      walletDB,
      keyManager: {
        isUnlocked: () => true,
        getMasterTokenKey: () => new Scalar(31337),
        getSubAddress: () =>
          SubAddr.generate(
            new Scalar(401),
            PublicKey.fromScalar(new Scalar(402)),
            SubAddrId.generate(-1, 0)
          ),
        calculateHashId: (_blinding: unknown, spending: { serialize(): string }) =>
          Uint8Array.from(Buffer.from(spending.serialize().slice(0, 40), 'hex')),
        getSubAddressId: (hashId: Uint8Array, id: { account: number; address: number }) => {
          if (Buffer.from(hashId).toString('hex') !== OWN_KEY.slice(0, 40)) return false;
          id.account = 0;
          id.address = 0;
          return true;
        },
        findSubAddressIdByHashId: () => null,
      },
      syncProvider: { isConnected: () => true },
      syncManager: { processMempoolTransaction: vi.fn(), getLastSyncedHeight: () => -1 },
      buildTxInput: vi.fn((output: WalletOutput, tokenId: InstanceType<typeof TokenId>) =>
        fundingTxIn(nextSeed++, Number(output.amount), tokenId)
      ),
      broadcastRawTransaction: broadcast,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await walletDB.close();
  });

  async function fund(
    outputHash: string,
    amount: bigint,
    {
      tokenId = null,
      spendingKey = OWN_KEY,
    }: { tokenId?: string | null; spendingKey?: string } = {}
  ): Promise<string> {
    await walletDB.storeWalletOutput({
      outputHash,
      txHash: `funding-${outputHash}`,
      outputIndex: 0,
      blockHeight: 10,
      outputData: '',
      amount: Number(amount),
      gamma: '01',
      memo: null,
      tokenId,
      blindingKey: OWN_KEY,
      ephemeralKey: null,
      spendingKey,
      isSpent: false,
      spentTxHash: null,
      spentBlockHeight: null,
      txType: 'received',
      timestamp: 0,
    });
    return outputHash;
  }

  async function spentBy(outputHash: string): Promise<string | null> {
    const row = (await walletDB.getAllOutputs()).find(o => o.outputHash === outputHash)!;
    return row.isSpent ? row.spentTxHash : null;
  }

  function spentHashes(): string[] {
    return ((client as any).buildTxInput as ReturnType<typeof vi.fn>).mock.calls.map(
      ([output]) => (output as WalletOutput).outputHash
    );
  }

  describe('serializes spends', () => {
    it('overlapping sends never select the same output', async () => {
      const big = await fund('a1'.repeat(32), 10n * NAV);
      const small = await fund('a2'.repeat(32), 9n * NAV);

      const [first, second] = await Promise.all([
        client.sendTransaction({ address: testAddress(11), amount: NAV }),
        client.sendTransaction({ address: testAddress(13), amount: NAV }),
      ]);

      expect(first.txId).not.toBe(second.txId);
      expect(await spentBy(big)).toBe(first.txId);
      expect(await spentBy(small)).toBe(second.txId);
    });

    it('across send kinds', async () => {
      const big = await fund('b1'.repeat(32), 10n * NAV);
      const small = await fund('b2'.repeat(32), 9n * NAV);

      const [many, created] = await Promise.all([
        client.sendToMany({ recipients: [{ address: testAddress(21), amount: NAV }] }),
        client.createTokenCollection({
          metadata: { name: 'Lock', symbol: 'LCK' },
          totalSupply: 10,
        }),
      ]);

      expect(await spentBy(big)).toBe(many.txId);
      expect(await spentBy(small)).toBe(created.txId);
    });

    it('a failed send does not block the next one', async () => {
      await fund('c1'.repeat(32), 10n * NAV);
      broadcast.mockRejectedValueOnce(new Error('rejected'));

      await expect(
        client.sendTransaction({ address: testAddress(31), amount: NAV })
      ).rejects.toThrow('rejected');
      await expect(
        client.sendTransaction({ address: testAddress(31), amount: NAV })
      ).resolves.toMatchObject({ inputCount: 1 });
    });
  });

  describe('releasePendingSpend', () => {
    it("unmarks the inputs and drops the transaction's mempool rows", async () => {
      const input = await fund('d1'.repeat(32), 10n * NAV);
      const result = await client.sendTransaction({ address: testAddress(41), amount: NAV });
      await walletDB.storeWalletOutput({
        outputHash: `mempool:${result.txId}:1`,
        txHash: result.txId,
        outputIndex: 1,
        blockHeight: 0,
        outputData: '',
        amount: Number(9n * NAV),
        gamma: '0',
        memo: null,
        tokenId: null,
        blindingKey: OWN_KEY,
        ephemeralKey: null,
        spendingKey: OWN_KEY,
        isSpent: false,
        spentTxHash: null,
        spentBlockHeight: null,
        txType: 'sent',
        timestamp: 0,
      });
      expect((await client.getPendingSpends()).map(s => s.spentTxHash)).toEqual([result.txId]);

      expect(await client.releasePendingSpend(result.txId)).toEqual([input]);

      expect(await spentBy(input)).toBeNull();
      expect((await walletDB.getAllOutputs()).map(o => o.outputHash)).toEqual([input]);
      expect(await client.getPendingSpends()).toEqual([]);
    });
  });

  describe('subtractFeeFromAmount', () => {
    it('refuses an amount larger than the selected inputs', async () => {
      const input = await fund('e1'.repeat(32), NAV);

      await expect(
        client.sendTransaction({
          address: testAddress(51),
          amount: 5n * NAV,
          subtractFeeFromAmount: true,
        })
      ).rejects.toThrow(`Insufficient funds: need ${5n * NAV} sat but only have ${NAV} sat`);
      await expect(
        client.sendTransaction({
          address: testAddress(51),
          amount: 5n * NAV,
          subtractFeeFromAmount: true,
          selectedUtxos: [input],
        })
      ).rejects.toThrow(/Insufficient funds/);
      expect(broadcast).not.toHaveBeenCalled();
    });
  });

  describe('manual input selection', () => {
    it('refuses an output listed twice on every spend path', async () => {
      const input = await fund('f1'.repeat(32), 10n * NAV);
      const twice = [input, input];

      await expect(
        client.sendTransaction({ address: testAddress(61), amount: NAV, selectedUtxos: twice })
      ).rejects.toThrow('selectedUtxos lists an output more than once');
      await expect(
        client.sendToken({
          address: testAddress(61),
          amount: 1n,
          tokenId: RPC_TOKEN_HASH,
          selectedUtxos: twice,
        })
      ).rejects.toThrow('more than once');
      await expect(
        client.sendToMany({
          recipients: [{ address: testAddress(61), amount: NAV }],
          selectedUtxos: twice,
        })
      ).rejects.toThrow('more than once');
      await expect(
        client.createTokenCollection({
          metadata: { name: 'Dup', symbol: 'DUP' },
          totalSupply: 1,
          selectedUtxos: twice,
        })
      ).rejects.toThrow('more than once');
      expect(broadcast).not.toHaveBeenCalled();
    });
  });

  describe('amount type', () => {
    it('refuses a number amount with a clear error', async () => {
      await fund('0a'.repeat(32), 10n * NAV);
      const amount = 1000 as unknown as bigint;

      await expect(client.sendTransaction({ address: testAddress(71), amount })).rejects.toThrow(
        'amount must be a bigint in satoshis'
      );
      await expect(
        client.sendToken({ address: testAddress(71), amount, tokenId: RPC_TOKEN_HASH })
      ).rejects.toThrow('amount must be a bigint');
      await expect(client.delegateStake({ amount, delegateKey: '00'.repeat(48) })).rejects.toThrow(
        'amount must be a bigint'
      );
      await expect(client.unstake({ amount })).rejects.toThrow('amount must be a bigint');
      expect(broadcast).not.toHaveBeenCalled();
    });
  });

  describe('outputs the wallet cannot sign for', () => {
    it('are skipped by sendToMany', async () => {
      const foreign = await fund('1a'.repeat(32), 50n * NAV, { spendingKey: FOREIGN_KEY });
      const own = await fund('1b'.repeat(32), 10n * NAV);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await client.sendToMany({ recipients: [{ address: testAddress(81), amount: NAV }] });

      expect(spentHashes()).toContain(own);
      expect(spentHashes()).not.toContain(foreign);
    });

    it('are skipped by token sends, for the token and for the fee', async () => {
      const foreignToken = await fund('2a'.repeat(32), 500n, {
        tokenId: STORED_TOKEN_ID,
        spendingKey: FOREIGN_KEY,
      });
      const ownToken = await fund('2b'.repeat(32), 100n, { tokenId: STORED_TOKEN_ID });
      const foreignNav = await fund('2c'.repeat(32), 50n * NAV, { spendingKey: FOREIGN_KEY });
      const ownNav = await fund('2d'.repeat(32), 10n * NAV);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await client.sendToken({ address: testAddress(91), amount: 25n, tokenId: RPC_TOKEN_HASH });

      expect(new Set(spentHashes())).toEqual(new Set([ownToken, ownNav]));
      expect(spentHashes()).not.toContain(foreignToken);
      expect(spentHashes()).not.toContain(foreignNav);
    });
  });

  describe('final fee check', () => {
    it('refuses to broadcast a transaction whose fee is below the requirement', async () => {
      const input = await fund('3a'.repeat(32), 10n * NAV);
      const output = UnsignedOutput.fromTxOut(
        TxOut.generate(
          SubAddr.generate(
            new Scalar(3),
            PublicKey.fromScalar(new Scalar(4)),
            SubAddrId.generate(0, 0)
          ),
          Number(9n * NAV),
          '',
          TokenId.default()
        )
      );
      const [row] = await walletDB.getUnspentOutputs(null);

      await expect(
        (client as any).signAndBroadcastUnsignedTransaction(
          walletDB,
          [{ output: row, tokenId: TokenId.default() }],
          [output],
          1n
        )
      ).rejects.toThrow(/Fee did not converge/);
      expect(broadcast).not.toHaveBeenCalled();
      expect(await spentBy(input)).toBeNull();
    });
  });
});
