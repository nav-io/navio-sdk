import { describe, it, expect, vi } from 'vitest';
import {
  Address,
  AddressEncoding,
  BlsctChain,
  BlsctPredicateType,
  CTx,
  CTxId,
  DoublePublicKey,
  OutPoint,
  PublicKey,
  Scalar,
  SubAddr,
  SubAddrId,
  TokenId,
  TokenType,
  TxIn,
  getPredicateType,
  parseCreateTokenPredicateTokenInfo,
  parseMintNftPredicateMetadata,
  parseMintNftPredicateNftId,
  parseMintTokenPredicateAmount,
  setChain,
} from 'navio-blsct';
import { NavioClient } from './client';
import type { WalletOutput } from './wallet-db.interface';

function reverseHexBytes(hex: string): string {
  const bytes = hex.match(/../g);
  if (!bytes) {
    return '';
  }
  return bytes.reverse().join('');
}

function makeTestAddress(): string {
  setChain(BlsctChain.Testnet);
  const subAddr = SubAddr.generate(
    new Scalar(91),
    PublicKey.fromScalar(new Scalar(92)),
    SubAddrId.generate(7, 9),
  );
  return Address.encode(DoublePublicKey.deserialize(subAddr.serialize()), AddressEncoding.Bech32M);
}

function makeFundingTxIn(
  seed: number,
  amount = 1_000_000,
  tokenId: InstanceType<typeof TokenId> = TokenId.default(),
): InstanceType<typeof TxIn> {
  const outPoint = OutPoint.generate(CTxId.deserialize(seed.toString(16).padStart(64, '0')));
  return TxIn.generate(
    amount,
    new Scalar(seed + 1),
    new Scalar(seed + 2),
    tokenId,
    outPoint,
    false,
    false,
  );
}

function makeWalletOutput(overrides: Partial<WalletOutput> & Pick<WalletOutput, 'outputHash' | 'txHash' | 'outputIndex'>): WalletOutput {
  return {
    outputHash: overrides.outputHash,
    txHash: overrides.txHash,
    outputIndex: overrides.outputIndex,
    blockHeight: overrides.blockHeight ?? 1,
    amount: overrides.amount ?? 1_000_000n,
    gamma: overrides.gamma ?? '01',
    memo: overrides.memo ?? null,
    tokenId: overrides.tokenId ?? null,
    blindingKey: overrides.blindingKey ?? '02',
    spendingKey: overrides.spendingKey ?? '03',
    isSpent: overrides.isSpent ?? false,
    spentTxHash: overrides.spentTxHash ?? null,
    spentBlockHeight: overrides.spentBlockHeight ?? null,
  };
}

function createMintClientHarness() {
  const client = new NavioClient({
    network: 'testnet',
    backend: 'electrum',
    electrum: {
      host: 'testnet.nav.io',
      port: 50005,
    },
    walletDbPath: 'test-client-wallet.db',
  });

  const walletDB = {
    getAllOutputs: vi.fn().mockResolvedValue([
      {
        outputHash: 'funding-output-hash',
        txHash: 'funding-tx-hash',
        outputIndex: 0,
        blockHeight: 10,
        amount: 1_000_000n,
        gamma: '01',
        memo: null,
        tokenId: null,
        blindingKey: '02',
        spendingKey: '03',
        isSpent: false,
        spentTxHash: null,
        spentBlockHeight: null,
      },
    ]),
    getUnspentOutputs: vi.fn().mockResolvedValue([
      {
        outputHash: 'funding-output-hash',
        txHash: 'funding-tx-hash',
        outputIndex: 0,
        blockHeight: 10,
        amount: 1_000_000n,
        gamma: '01',
        memo: null,
        tokenId: null,
        blindingKey: '02',
        spendingKey: '03',
        isSpent: false,
        spentTxHash: null,
        spentBlockHeight: null,
      },
    ]),
    markOutputSpent: vi.fn().mockResolvedValue(undefined),
  };

  const processMempoolTransaction = vi.fn().mockResolvedValue(undefined);

  (client as any).initialized = true;
  (client as any).walletDB = walletDB;
  (client as any).keyManager = {
    isUnlocked: () => true,
    getMasterTokenKey: () => new Scalar(31337),
    getSubAddress: () => SubAddr.generate(
      new Scalar(401),
      PublicKey.fromScalar(new Scalar(402)),
      SubAddrId.generate(-1, 0),
    ),
  };
  (client as any).syncProvider = {
    isConnected: () => true,
  };
  (client as any).syncManager = {
    processMempoolTransaction,
  };
  (client as any).buildTxInput = vi
    .fn()
    .mockImplementation((output: WalletOutput, tokenId: InstanceType<typeof TokenId>) =>
      makeFundingTxIn(11, Number(output.amount), tokenId)
    );
  (client as any).broadcastRawTransaction = vi.fn().mockResolvedValue('broadcast-hash');

  return {
    client,
    walletDB,
    processMempoolTransaction,
    broadcastRawTransaction: (client as any).broadcastRawTransaction as ReturnType<typeof vi.fn>,
  };
}

describe('NavioClient', () => {
  const TOKEN_HASH = '11'.repeat(32);
  const FUNGIBLE_TOKEN_ID = TOKEN_HASH;
  const NFT_TOKEN_ID = '22'.repeat(32) + '0100000000000000';
  const NFT_COLLECTION_TOKEN_ID = '22'.repeat(32);
  const DEFAULT_NAV_STORED_TOKEN_ID = '00'.repeat(32) + 'ffffffffffffffff';
  const RPC_TOKEN_HASH = 'b12a2ee7491ef649c0a6677fe2e996065f02210f84a934297cc8ba554f54e31c';
  const RPC_TOKEN_ID = RPC_TOKEN_HASH;
  const STORED_TOKEN_ID = reverseHexBytes(RPC_TOKEN_HASH) + 'ffffffffffffffff';
  const LEGACY_STORED_TOKEN_ID = STORED_TOKEN_ID + '12'.repeat(24);

  it('should create a client instance with electrum backend', () => {
    const client = new NavioClient({
      network: 'testnet',
      backend: 'electrum',
      electrum: {
        host: 'testnet.nav.io',
        port: 50005,
      },
      walletDbPath: 'test-client-wallet.db',
    });

    expect(client).toBeInstanceOf(NavioClient);
  });

  it('should return the configuration', () => {
    const config = {
      network: 'mainnet' as const,
      backend: 'electrum' as const,
      electrum: {
        host: 'testnet.nav.io',
        port: 50005,
      },
      walletDbPath: 'test-client-wallet.db',
    };

    const client = new NavioClient(config);
    const returnedConfig = client.getConfig();

    expect(returnedConfig.network).toBe(config.network);
    expect(returnedConfig.backend).toBe(config.backend);
    expect(returnedConfig.electrum).toEqual(config.electrum);
  });

  it('should throw error when electrum backend is used without options', () => {
    expect(() => {
      new NavioClient({
        network: 'testnet',
        backend: 'electrum',
        // Missing electrum options
      });
    }).toThrow('Electrum options required when backend is "electrum"');
  });

  it('should export the audit key from the key manager', () => {
    const client = new NavioClient({
      network: 'testnet',
      backend: 'electrum',
      electrum: {
        host: 'testnet.nav.io',
        port: 50005,
      },
      walletDbPath: 'test-client-wallet.db',
    });

    const getAuditKeyHex = 'ab'.repeat(80);
    (client as any).keyManager = {
      getAuditKeyHex: () => getAuditKeyHex,
    };

    expect(client.getAuditKeyHex()).toBe(getAuditKeyHex);
    expect(client.getWalletViewKeyHex()).toBe(getAuditKeyHex);
  });

  it('should accept audit-key restore config', () => {
    const auditKeyHex = 'ab'.repeat(80);
    const client = new NavioClient({
      network: 'testnet',
      backend: 'electrum',
      electrum: {
        host: 'testnet.nav.io',
        port: 50005,
      },
      walletDbPath: 'test-client-wallet.db',
      restoreFromAuditKey: auditKeyHex,
    });

    expect(client.getConfig().restoreFromAuditKey).toBe(auditKeyHex);
  });

  it('should reject multiple restore sources', () => {
    expect(() => {
      new NavioClient({
        network: 'testnet',
        backend: 'electrum',
        electrum: {
          host: 'testnet.nav.io',
          port: 50005,
        },
        walletDbPath: 'test-client-wallet.db',
        restoreFromMnemonic: 'word1 word2',
        restoreFromAuditKey: 'ab'.repeat(80),
      });
    }).toThrow('Specify only one of restoreFromSeed, restoreFromMnemonic, or restoreFromAuditKey');
  });

  it('should delegate fungible token sends to sendTransaction', async () => {
    const client = new NavioClient({
      network: 'testnet',
      backend: 'electrum',
      electrum: {
        host: 'testnet.nav.io',
        port: 50005,
      },
      walletDbPath: 'test-client-wallet.db',
    });

    const sendTransaction = vi.fn().mockResolvedValue({
      txId: 'txid',
      rawTx: 'rawtx',
      fee: 200000n,
      inputCount: 1,
      outputCount: 2,
    });
    (client as any).sendTransaction = sendTransaction;

    const result = await client.sendToken({
      address: 'tnv1example',
      amount: 25n,
      tokenId: TOKEN_HASH,
      memo: 'fungible',
    });

    expect(sendTransaction).toHaveBeenCalledWith({
      address: 'tnv1example',
      amount: 25n,
      tokenId: FUNGIBLE_TOKEN_ID,
      memo: 'fungible',
    });
    expect(result.txId).toBe('txid');
  });

  it('should enforce NFT token IDs for sendNft and support collection token id + nft id', async () => {
    const client = new NavioClient({
      network: 'testnet',
      backend: 'electrum',
      electrum: {
        host: 'testnet.nav.io',
        port: 50005,
      },
      walletDbPath: 'test-client-wallet.db',
    });

    const sendTransaction = vi.fn().mockResolvedValue({
      txId: 'nfttx',
      rawTx: 'rawtx',
      fee: 200000n,
      inputCount: 1,
      outputCount: 2,
    });
    (client as any).sendTransaction = sendTransaction;

    await expect(client.sendNft({
      address: 'tnv1example',
      tokenId: FUNGIBLE_TOKEN_ID,
    })).rejects.toThrow('sendNft requires an NFT token ID.');

    await client.sendNft({
      address: 'tnv1example',
      tokenId: NFT_TOKEN_ID,
      memo: 'collectible',
    });

    expect(sendTransaction).toHaveBeenCalledWith({
      address: 'tnv1example',
      amount: 1n,
      tokenId: NFT_TOKEN_ID,
      memo: 'collectible',
    });

    sendTransaction.mockClear();

    await client.sendNft({
      address: 'tnv1example',
      collectionTokenId: NFT_COLLECTION_TOKEN_ID,
      nftId: 7n,
    });

    expect(sendTransaction).toHaveBeenCalledWith({
      address: 'tnv1example',
      amount: 1n,
      tokenId: '22'.repeat(32) + '0700000000000000',
    });
  });

  it('should expose stored token ids in core RPC byte order', async () => {
    const client = new NavioClient({
      network: 'testnet',
      backend: 'electrum',
      electrum: {
        host: 'testnet.nav.io',
        port: 50005,
      },
      walletDbPath: 'test-client-wallet.db',
    });

    (client as any).walletDB = {
      getAllOutputs: vi.fn().mockResolvedValue([
        {
          outputHash: 'token-live',
          txHash: 'tokentx1',
          outputIndex: 0,
          blockHeight: 10,
          amount: 3n,
          gamma: '01',
          memo: null,
          tokenId: STORED_TOKEN_ID,
          blindingKey: '02',
          spendingKey: '03',
          isSpent: false,
          spentTxHash: null,
          spentBlockHeight: null,
        },
        {
          outputHash: 'token-legacy',
          txHash: 'tokentx2',
          outputIndex: 1,
          blockHeight: 11,
          amount: 4n,
          gamma: '01',
          memo: null,
          tokenId: LEGACY_STORED_TOKEN_ID,
          blindingKey: '02',
          spendingKey: '03',
          isSpent: false,
          spentTxHash: null,
          spentBlockHeight: null,
        },
      ]),
      getBalance: vi.fn().mockResolvedValue(0n),
      getUnspentOutputs: vi.fn().mockResolvedValue([]),
      getPendingSpentAmount: vi.fn().mockResolvedValue(0n),
    };

    const outputs = await client.getAllOutputs();
    const assets = await client.getAssetBalances();

    expect(outputs.map((output) => output.tokenId)).toEqual([RPC_TOKEN_ID, RPC_TOKEN_ID]);
    expect(assets).toEqual([
      {
        tokenId: RPC_TOKEN_ID,
        kind: 'token',
        balance: 7n,
        outputCount: 2,
        collectionTokenId: RPC_TOKEN_ID,
        nftId: null,
      },
    ]);
  });

  it('should normalize stored default NAV token ids back to null', async () => {
    const client = new NavioClient({
      network: 'testnet',
      backend: 'electrum',
      electrum: {
        host: 'testnet.nav.io',
        port: 50005,
      },
      walletDbPath: 'test-client-wallet.db',
    });

    (client as any).walletDB = {
      getAllOutputs: vi.fn().mockResolvedValue([
        {
          outputHash: 'nav-stored-default',
          txHash: 'navtx',
          outputIndex: 0,
          blockHeight: 1,
          amount: 10n,
          gamma: '01',
          memo: null,
          tokenId: DEFAULT_NAV_STORED_TOKEN_ID,
          blindingKey: '02',
          spendingKey: '03',
          isSpent: false,
          spentTxHash: null,
          spentBlockHeight: null,
        },
      ]),
      getBalance: vi.fn().mockResolvedValue(10n),
      getUnspentOutputs: vi.fn().mockResolvedValue([]),
      getPendingSpentAmount: vi.fn().mockResolvedValue(0n),
    };

    await expect(client.getAllOutputs()).resolves.toEqual([
      expect.objectContaining({
        outputHash: 'nav-stored-default',
        tokenId: null,
      }),
    ]);
  });

  it('should match token queries against core RPC token ids and legacy serialized ids', async () => {
    const client = new NavioClient({
      network: 'testnet',
      backend: 'electrum',
      electrum: {
        host: 'testnet.nav.io',
        port: 50005,
      },
      walletDbPath: 'test-client-wallet.db',
    });

    (client as any).walletDB = {
      getAllOutputs: vi.fn().mockResolvedValue([
        {
          outputHash: 'nav',
          txHash: 'navtx',
          outputIndex: 0,
          blockHeight: 1,
          amount: 10n,
          gamma: '01',
          memo: null,
          tokenId: null,
          blindingKey: '02',
          spendingKey: '03',
          isSpent: false,
          spentTxHash: null,
          spentBlockHeight: null,
        },
        {
          outputHash: 'token-live',
          txHash: 'tokentx1',
          outputIndex: 0,
          blockHeight: 10,
          amount: 3n,
          gamma: '01',
          memo: null,
          tokenId: STORED_TOKEN_ID,
          blindingKey: '02',
          spendingKey: '03',
          isSpent: false,
          spentTxHash: null,
          spentBlockHeight: null,
        },
        {
          outputHash: 'token-spent',
          txHash: 'tokentx2',
          outputIndex: 1,
          blockHeight: 11,
          amount: 9n,
          gamma: '01',
          memo: null,
          tokenId: STORED_TOKEN_ID,
          blindingKey: '02',
          spendingKey: '03',
          isSpent: true,
          spentTxHash: 'spent',
          spentBlockHeight: 12,
        },
      ]),
      getBalance: vi.fn().mockResolvedValue(0n),
      getUnspentOutputs: vi.fn().mockResolvedValue([]),
      getPendingSpentAmount: vi.fn().mockResolvedValue(0n),
    };

    await expect(client.getTokenBalance(RPC_TOKEN_HASH)).resolves.toBe(3n);
    await expect(client.getTokenBalance(STORED_TOKEN_ID)).resolves.toBe(3n);
    await expect(client.getTokenOutputs(RPC_TOKEN_HASH)).resolves.toEqual([
      expect.objectContaining({
        outputHash: 'token-live',
        tokenId: RPC_TOKEN_ID,
      }),
    ]);
  });

  it('should aggregate current asset balances from wallet outputs', async () => {
    const client = new NavioClient({
      network: 'testnet',
      backend: 'electrum',
      electrum: {
        host: 'testnet.nav.io',
        port: 50005,
      },
      walletDbPath: 'test-client-wallet.db',
    });

    (client as any).walletDB = {
      getAllOutputs: vi.fn().mockResolvedValue([
        {
          outputHash: 'nav',
          txHash: 'navtx',
          outputIndex: 0,
          blockHeight: 1,
          amount: 10n,
          gamma: '01',
          memo: null,
          tokenId: null,
          blindingKey: '02',
          spendingKey: '03',
          isSpent: false,
          spentTxHash: null,
          spentBlockHeight: null,
        },
        {
          outputHash: 'token-a',
          txHash: 'tokentx1',
          outputIndex: 0,
          blockHeight: 2,
          amount: 5n,
          gamma: '01',
          memo: null,
          tokenId: FUNGIBLE_TOKEN_ID,
          blindingKey: '02',
          spendingKey: '03',
          isSpent: false,
          spentTxHash: null,
          spentBlockHeight: null,
        },
        {
          outputHash: 'token-b',
          txHash: 'tokentx2',
          outputIndex: 1,
          blockHeight: 3,
          amount: 7n,
          gamma: '01',
          memo: null,
          tokenId: FUNGIBLE_TOKEN_ID,
          blindingKey: '02',
          spendingKey: '03',
          isSpent: false,
          spentTxHash: null,
          spentBlockHeight: null,
        },
        {
          outputHash: 'nft-live',
          txHash: 'nfttx1',
          outputIndex: 0,
          blockHeight: 4,
          amount: 1n,
          gamma: '01',
          memo: null,
          tokenId: NFT_TOKEN_ID,
          blindingKey: '02',
          spendingKey: '03',
          isSpent: false,
          spentTxHash: null,
          spentBlockHeight: null,
        },
        {
          outputHash: 'nft-spent',
          txHash: 'nfttx2',
          outputIndex: 1,
          blockHeight: 5,
          amount: 1n,
          gamma: '01',
          memo: null,
          tokenId: NFT_TOKEN_ID,
          blindingKey: '02',
          spendingKey: '03',
          isSpent: true,
          spentTxHash: 'spent',
          spentBlockHeight: 6,
        },
        {
          outputHash: 'bad-token',
          txHash: 'badtx',
          outputIndex: 0,
          blockHeight: 7,
          amount: 9n,
          gamma: '01',
          memo: null,
          tokenId: 'not-a-token-id',
          blindingKey: '02',
          spendingKey: '03',
          isSpent: false,
          spentTxHash: null,
          spentBlockHeight: null,
        },
      ]),
      getBalance: vi.fn().mockResolvedValue(12n),
      getUnspentOutputs: vi.fn().mockResolvedValue([]),
    };

    const assets = await client.getAssetBalances();
    const tokens = await client.getTokenBalances();
    const nfts = await client.getNftBalances();

    expect(assets).toEqual([
      {
        tokenId: FUNGIBLE_TOKEN_ID,
        kind: 'token',
        balance: 12n,
        outputCount: 2,
        collectionTokenId: FUNGIBLE_TOKEN_ID,
        nftId: null,
      },
      {
        tokenId: NFT_TOKEN_ID,
        kind: 'nft',
        balance: 1n,
        outputCount: 1,
        collectionTokenId: '22'.repeat(32),
        nftId: 1n,
      },
    ]);
    expect(tokens).toEqual([assets[0]]);
    expect(nfts).toEqual([assets[1]]);
  });

  it('should fund fungible token sends with NAV inputs for the fee', async () => {
    const client = new NavioClient({
      network: 'testnet',
      backend: 'electrum',
      electrum: {
        host: 'testnet.nav.io',
        port: 50005,
      },
      walletDbPath: 'test-client-wallet.db',
    });

    const walletOutputs: WalletOutput[] = [
      makeWalletOutput({
        outputHash: '10'.repeat(32),
        txHash: '20'.repeat(32),
        outputIndex: 0,
        blockHeight: 150826,
        amount: 100n,
        tokenId: STORED_TOKEN_ID,
      }),
      makeWalletOutput({
        outputHash: '30'.repeat(32),
        txHash: '40'.repeat(32),
        outputIndex: 1,
        blockHeight: 150826,
        amount: 1_000_000n,
        tokenId: null,
      }),
    ];

    const walletDB = {
      getAllOutputs: vi.fn().mockResolvedValue(walletOutputs),
      markOutputSpent: vi.fn().mockResolvedValue(undefined),
    };
    const processMempoolTransaction = vi.fn().mockResolvedValue(undefined);
    const broadcastRawTransaction = vi.fn().mockResolvedValue('broadcast-hash');
    let nextSeed = 21;
    const buildTxInput = vi.fn().mockImplementation((output: WalletOutput, tokenId: InstanceType<typeof TokenId>) =>
      makeFundingTxIn(nextSeed++, Number(output.amount), tokenId)
    );

    (client as any).initialized = true;
    (client as any).walletDB = walletDB;
    (client as any).keyManager = {
      isUnlocked: () => true,
      getSubAddress: () => SubAddr.generate(
        new Scalar(15),
        PublicKey.fromScalar(new Scalar(16)),
        SubAddrId.generate(1, 0),
      ),
    };
    (client as any).syncProvider = {
      isConnected: () => true,
    };
    (client as any).syncManager = {
      processMempoolTransaction,
    };
    (client as any).buildTxInput = buildTxInput;
    (client as any).broadcastRawTransaction = broadcastRawTransaction;

    const result = await client.sendToken({
      address: makeTestAddress(),
      amount: 25n,
      tokenId: RPC_TOKEN_HASH,
    });

    expect(result.inputCount).toBe(2);
    expect(result.fee).toBeGreaterThan(0n);
    const finalSignedInputTokenIds = buildTxInput.mock.calls
      .slice(-2)
      .map(([, tokenId]) => (tokenId as InstanceType<typeof TokenId>).serialize());
    expect(finalSignedInputTokenIds).toEqual([
      STORED_TOKEN_ID,
      DEFAULT_NAV_STORED_TOKEN_ID,
    ]);
    expect(walletDB.markOutputSpent).toHaveBeenCalledWith('10'.repeat(32), result.txId, 0);
    expect(walletDB.markOutputSpent).toHaveBeenCalledWith('30'.repeat(32), result.txId, 0);
    expect(processMempoolTransaction).toHaveBeenCalledWith(result.txId, result.rawTx);
    expect(broadcastRawTransaction).toHaveBeenCalledWith(result.rawTx);
  });

  it('should create a fungible token collection transaction with a create-token predicate', async () => {
    const { client, walletDB, processMempoolTransaction, broadcastRawTransaction } = createMintClientHarness();

    const result = await client.createTokenCollection({
      metadata: { name: 'Token Collection', symbol: 'TOK' },
      totalSupply: 5_000_000,
    });

    const ctx = CTx.deserialize(result.rawTx);
    const predicateHex = ctx.getCTxOuts().at(0).getVectorPredicate();
    const tokenInfo = parseCreateTokenPredicateTokenInfo(predicateHex);

    expect(getPredicateType(predicateHex)).toBe(BlsctPredicateType.BlsctCreateTokenPredicateType);
    expect(tokenInfo.getType()).toBe(TokenType.Token);
    expect(tokenInfo.getMetadata()).toEqual({ name: 'Token Collection', symbol: 'TOK' });
    expect(tokenInfo.getTotalSupply()).toBe(5_000_000n);
    expect(result.kind).toBe('token');
    expect(result.collectionTokenId).toHaveLength(64);
    expect(result.outputCount).toBe(3);
    expect(walletDB.markOutputSpent).toHaveBeenCalledWith('funding-output-hash', result.txId, 0);
    expect(processMempoolTransaction).toHaveBeenCalledWith(result.txId, result.rawTx);
    expect(broadcastRawTransaction).toHaveBeenCalledWith(result.rawTx);
  });

  it('should create an NFT collection transaction with an NFT token-info payload', async () => {
    const { client } = createMintClientHarness();

    const result = await client.createNftCollection({
      metadata: { collection: 'Genesis', creator: 'navio' },
      totalSupply: 250,
    });

    const ctx = CTx.deserialize(result.rawTx);
    const predicateHex = ctx.getCTxOuts().at(0).getVectorPredicate();
    const tokenInfo = parseCreateTokenPredicateTokenInfo(predicateHex);

    expect(getPredicateType(predicateHex)).toBe(BlsctPredicateType.BlsctCreateTokenPredicateType);
    expect(tokenInfo.getType()).toBe(TokenType.Nft);
    expect(tokenInfo.getMetadata()).toEqual({ collection: 'Genesis', creator: 'navio' });
    expect(tokenInfo.getTotalSupply()).toBe(250n);
    expect(result.kind).toBe('nft');
    expect(result.collectionTokenId).toHaveLength(64);
  });

  it('should default NFT collection total supply to zero when omitted', async () => {
    const { client } = createMintClientHarness();

    const result = await client.createNftCollection({
      metadata: { collection: 'Open Edition' },
    });

    const ctx = CTx.deserialize(result.rawTx);
    const predicateHex = ctx.getCTxOuts().at(0).getVectorPredicate();
    const tokenInfo = parseCreateTokenPredicateTokenInfo(predicateHex);

    expect(tokenInfo.getType()).toBe(TokenType.Nft);
    expect(tokenInfo.getTotalSupply()).toBe(0n);
  });

  it('should mint fungible tokens with a mint-token predicate', async () => {
    const { client } = createMintClientHarness();
    const address = makeTestAddress();
    const collection = await client.createTokenCollection({
      metadata: { name: 'Mintable', symbol: 'MINT' },
      totalSupply: 1_000_000,
    });

    const result = await client.mintToken({
      address,
      collectionTokenId: collection.collectionTokenId,
      amount: 123_456,
    });

    const ctx = CTx.deserialize(result.rawTx);
    const predicateHex = ctx.getCTxOuts().at(0).getVectorPredicate();

    expect(getPredicateType(predicateHex)).toBe(BlsctPredicateType.BlsctMintTokenPredicateType);
    expect(parseMintTokenPredicateAmount(predicateHex)).toBe(123_456n);
    expect(result.kind).toBe('token');
    expect(result.collectionTokenId).toBe(collection.collectionTokenId);
    expect(result.tokenId).toBe(collection.collectionTokenId);
  });

  it('should mint NFTs with a mint-nft predicate and derived NFT token id', async () => {
    const { client } = createMintClientHarness();
    const address = makeTestAddress();
    const collection = await client.createNftCollection({
      metadata: { collection: 'Artifacts' },
    });

    const result = await client.mintNft({
      address,
      collectionTokenId: collection.collectionTokenId,
      nftId: 42n,
      metadata: { name: 'Artifact', rarity: 'legendary' },
    });

    const ctx = CTx.deserialize(result.rawTx);
    const predicateHex = ctx.getCTxOuts().at(0).getVectorPredicate();

    expect(getPredicateType(predicateHex)).toBe(BlsctPredicateType.BlsctMintNftPredicateType);
    expect(parseMintNftPredicateNftId(predicateHex)).toBe(42n);
    expect(parseMintNftPredicateMetadata(predicateHex)).toEqual({ name: 'Artifact', rarity: 'legendary' });
    expect(result.kind).toBe('nft');
    expect(result.collectionTokenId).toBe(collection.collectionTokenId);
    expect(result.tokenId).toBe(collection.collectionTokenId + '2a00000000000000');
  });
});
