#!/usr/bin/env tsx
/**
 * End-to-end check of cold staking against a real
 * `naviod -chain=blsctregtest` node: the node accepts what the SDK builds,
 * and the SDK reads the result back after syncing it.
 *
 *   npx tsx scripts/test-cold-staking-regtest.ts
 *   NAVIOD=/path/to/naviod npx tsx scripts/test-cold-staking-regtest.ts
 *
 * Or against a node already running (see attachedNode in regtest-node.ts):
 *   NAVIO_REGTEST_P2P_PORT=… NAVIO_REGTEST_RPC_PORT=… npx tsx scripts/test-cold-staking-regtest.ts
 *
 * Flow:
 *   1. node: mine 101 blocks to its wallet, pay the SDK wallet, mine
 *   2. SDK: delegateStake; node accepts it, mines; SDK lists the delegation
 *   3. SDK: partial unstake; the rest stays staked under the same delegation
 *   4. SDK: full unstake; nothing is left staked
 *
 * The SDK's transactions reach the node through `sendrawtransaction` rather
 * than the P2P provider's broadcast: since navio-core #482 a node no longer
 * serves a just-received transaction back to its sender, which the P2P
 * broadcast relies on to confirm acceptance, so it reports every broadcast as
 * rejected. RPC also returns the node's reason when it does reject one.
 *
 * Exits non-zero on the first failed assertion.
 */

import { Point } from '@nav-io/navio-blsct';
import { NavioClient, P2PSyncProvider, type SendTransactionResult } from '../src/index';
import {
  assert,
  assertEq,
  assertionsPassed,
  KEEP_DATADIR_ON_FAILURE,
  startRegtestNode,
  type RegtestNode,
} from './regtest-node';

const NAV = 100_000_000n;
/** blsctregtest's consensus minimum stake (`nPePoSMinStakeAmount`). */
const MIN_STAKE = 100n * NAV;
const NODE_WALLET = 'w1';

async function main(): Promise<void> {
  console.log('== 1. Node funds the SDK wallet');
  const node = await startRegtestNode();
  let client: NavioClient | null = null;
  let failed = false;
  try {
    assertEq((await node.rpc('getblockchaininfo')).chain, 'blsctregtest', 'node chain');
    await node.rpc('createwallet', [NODE_WALLET]);
    const nodeAddr: string = await node.rpc('getnewaddress', ['', 'blsct'], NODE_WALLET);
    await node.rpc('generatetoblsctaddress', [101, nodeAddr]);

    client = new NavioClient({
      walletDbPath: ':memory:',
      databaseAdapter: 'better-sqlite3',
      backend: 'p2p',
      network: 'regtest',
      p2p: { host: '127.0.0.1', port: node.port },
      createWalletIfNotExists: true,
      creationHeight: 0,
      minStakeAmount: MIN_STAKE,
    });
    await client.initialize();
    // See the header for why this goes through RPC.
    (client.getSyncProvider() as P2PSyncProvider).broadcastTransaction = rawTx =>
      node.rpc('sendrawtransaction', [rawTx]);
    const sdkAddr = client
      .getKeyManager()
      .getSubAddressBech32m({ account: 0, address: 0 }, 'regtest');
    await node.rpc('sendtoblsctaddress', [sdkAddr, 500], NODE_WALLET);
    await mine(node, nodeAddr, client);
    assertEq(await client.getBalance(), 500n * NAV, 'SDK balance after funding');

    console.log('== 2. Delegate a stake');
    const delegateKey = Point.random().serialize();
    const stakeAmount = 3n * MIN_STAKE;
    const delegated = await client.delegateStake({ amount: stakeAmount, delegateKey });
    await expectAccepted(node, delegated, 'delegateStake');
    await mine(node, nodeAddr, client);
    assertEq(await client.getStakedBalance(), stakeAmount, 'staked balance');
    assertEq(
      await client.getBalance(),
      500n * NAV - stakeAmount - delegated.fee,
      'spendable balance = funded - staked - fee'
    );
    const [delegation] = await client.getStakeDelegations();
    assertEq(delegation?.delegateKey, delegateKey, 'delegation lists the delegate key');
    assertEq(delegation?.rewardAddress, sdkAddr, 'delegation lists the default reward address');
    assertEq(delegation?.amount, stakeAmount, 'delegation lists the staked amount');

    console.log('== 3. Unstake part of it');
    const balanceBefore = await client.getBalance();
    const partial = await client.unstake({ amount: MIN_STAKE });
    await expectAccepted(node, partial, 'partial unstake');
    await mine(node, nodeAddr, client);
    assertEq(
      await client.getStakedBalance(),
      stakeAmount - MIN_STAKE,
      'staked balance after partial unstake'
    );
    assertEq(
      await client.getBalance(),
      balanceBefore + MIN_STAKE - partial.fee,
      'spendable balance gains the unlocked amount less the fee'
    );
    const delegations = await client.getStakeDelegations();
    assertEq(delegations.length, 1, 'one delegated stake left');
    assertEq(delegations[0].delegateKey, delegateKey, 'the rest keeps the delegation');

    console.log('== 4. Unstake the rest');
    const full = await client.unstake();
    await expectAccepted(node, full, 'full unstake');
    await mine(node, nodeAddr, client);
    assertEq(await client.getStakedBalance(), 0n, 'nothing left staked');
    assertEq((await client.getStakeDelegations()).length, 0, 'no delegations left');

    console.log(`\nALL ${assertionsPassed()} ASSERTIONS PASSED`);
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // ignore teardown errors
      }
    }
    await node.stop(failed && KEEP_DATADIR_ON_FAILURE);
  }
}

/** The node took the SDK's transaction into its mempool, byte for byte. */
async function expectAccepted(
  node: RegtestNode,
  result: SendTransactionResult,
  what: string
): Promise<void> {
  const mempool: string[] = await node.rpc('getrawmempool');
  assert(mempool.includes(result.txId), `${what}: node accepted ${result.txId.slice(0, 16)}...`);
  assert(
    (await node.rpc('getrawtransaction', [result.txId])) === result.rawTx,
    `${what}: node holds the SDK's bytes`
  );
}

/** Mine one block and sync the SDK to it. */
async function mine(node: RegtestNode, address: string, client: NavioClient): Promise<void> {
  await node.rpc('generatetoblsctaddress', [1, address]);
  await client.sync();
  assertEq(
    client.getLastSyncedHeight(),
    await node.rpc('getblockcount'),
    'SDK synced to the node tip'
  );
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('\nFAILED:', error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });
