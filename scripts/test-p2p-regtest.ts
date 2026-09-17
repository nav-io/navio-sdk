#!/usr/bin/env tsx
/**
 * End-to-end acceptance test for the P2P sync backend against a real
 * `naviod -chain=blsctregtest` node (no Electrum server involved).
 *
 *   npx tsx scripts/test-p2p-regtest.ts
 *   NAVIOD=/path/to/naviod npx tsx scripts/test-p2p-regtest.ts
 *
 * Flow:
 *   1. spawn naviod (blsctregtest, temp datadir), create a BLSCT wallet,
 *      mine 101 blocks to it (coinbase maturity)
 *   2. create an SDK wallet with `backend: 'p2p'`, `network: 'regtest'`
 *   3. node pays the SDK address, mines 1 block
 *   4. SDK syncs over P2P and reports the received balance
 *   5. SDK sends back to the node over P2P; node mempool shows the txid;
 *      node mines; SDK balance reflects the spend
 *   6. getRawTransaction round-trips (recent + older tx); background polling
 *      picks up a newly mined block
 *
 * Exits non-zero on the first failed assertion.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NavioClient, P2PSyncProvider } from '../src/index';

// ---------------------------------------------------------------------------
// Regtest node helper
// ---------------------------------------------------------------------------

const DEFAULT_NAVIOD = process.env.NAVIOD ?? '/Users/alex/dev/navio-p2pmsg-int/build/bin/naviod';
const RPC_USER = 'user';
const RPC_PASS = 'pass';

const BASE_ARGS = [
  '-chain=blsctregtest',
  '-daemon=0',
  '-server=1',
  '-listen=1',
  '-txindex=1',
  '-printtoconsole=0',
  '-dnsseed=0',
  '-fixedseeds=0',
  '-listenonion=0',
  '-upnp=0',
  '-natpmp=0',
  '-discover=0',
  '-rpcallowip=127.0.0.1',
  '-rpcbind=127.0.0.1',
  '-debug=net',
  '-debug=mempool',
  '-debug=dandelion',
];

/** Keep the node datadir (and print its debug.log tail) when the test fails. */
const KEEP_DATADIR_ON_FAILURE = process.env.KEEP_DATADIR === '1' || process.argv.includes('--keep');

interface RegtestNode {
  port: number;
  rpcPort: number;
  datadir: string;
  rpc<T = any>(method: string, params?: unknown[], wallet?: string): Promise<T>;
  stop(keep?: boolean): Promise<void>;
}

function supportedFlags(binary: string): Set<string> {
  const help = execFileSync(binary, ['-help', '-help-debug'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const set = new Set<string>();
  for (const m of help.matchAll(/^\s{2}(-[a-zA-Z0-9]+)/gm)) set.add(m[1]);
  return set;
}

function filterArgs(binary: string, args: string[]): string[] {
  const ok = supportedFlags(binary);
  const out: string[] = [];
  for (const a of args) {
    const name = a.split('=')[0];
    if (ok.has(name)) out.push(a);
    else console.log(`[regtest-node] dropping unsupported flag ${a}`);
  }
  return out;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function canConnect(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    const s = createConnection({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      s.removeAllListeners();
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function startRegtestNode(binary = DEFAULT_NAVIOD): Promise<RegtestNode> {
  const port = await getFreePort();
  const rpcPort = await getFreePort();
  const datadir = mkdtempSync(join(tmpdir(), 'navio-sdk-regtest-'));
  const args = filterArgs(binary, [
    ...BASE_ARGS,
    `-datadir=${datadir}`,
    `-bind=127.0.0.1:${port}`,
    `-port=${port}`,
    `-rpcport=${rpcPort}`,
    `-rpcuser=${RPC_USER}`,
    `-rpcpassword=${RPC_PASS}`,
  ]);

  const child: ChildProcess = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const onOut = (b: Buffer) => {
    output = (output + b.toString()).slice(-8192);
  };
  child.stdout?.on('data', onOut);
  child.stderr?.on('data', onOut);
  let exited = false;
  const exitPromise = new Promise<void>(resolve => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
    child.once('error', () => {
      exited = true;
      resolve();
    });
  });

  const auth = 'Basic ' + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64');
  let rpcId = 0;
  const rpc = async <T>(method: string, params: unknown[] = [], wallet?: string): Promise<T> => {
    const url = `http://127.0.0.1:${rpcPort}/${wallet ? `wallet/${wallet}` : ''}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({ jsonrpc: '1.0', id: ++rpcId, method, params }),
    });
    const text = await res.text();
    let body: { result?: T; error?: { code: number; message: string } | null };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`rpc ${method}: HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    if (body.error) {
      throw Object.assign(new Error(`rpc ${method}: ${body.error.message}`), {
        code: body.error.code,
      });
    }
    return body.result as T;
  };

  let stopped = false;
  const stop = async (keep = false) => {
    if (stopped) return;
    stopped = true;
    if (!exited) {
      child.kill('SIGTERM');
      const killer = setTimeout(() => {
        if (!exited) child.kill('SIGKILL');
      }, 15_000);
      await exitPromise;
      clearTimeout(killer);
    }
    if (keep) {
      console.log(`[regtest-node] datadir kept at ${datadir}`);
    } else {
      rmSync(datadir, { recursive: true, force: true });
    }
  };

  const deadline = Date.now() + 60_000;
  try {
    while (!(await canConnect(port))) {
      if (exited)
        throw new Error(`naviod exited during startup\nargs: ${args.join(' ')}\n${output}`);
      if (Date.now() > deadline)
        throw new Error(`timeout waiting for naviod P2P port ${port}\n${output}`);
      await sleep(100);
    }
    for (;;) {
      if (exited) throw new Error(`naviod exited during startup\n${output}`);
      if (Date.now() > deadline)
        throw new Error(`timeout waiting for naviod RPC on ${rpcPort}\n${output}`);
      try {
        await rpc('getblockchaininfo');
        break;
      } catch (e) {
        const code = (e as { code?: number }).code;
        if (code !== undefined && code !== -28) throw e;
        await sleep(100);
      }
    }
  } catch (e) {
    await stop();
    throw e;
  }

  return { port, rpcPort, datadir, rpc, stop };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let passed = 0;
function assert(cond: unknown, message: string): void {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  passed++;
  console.log(`  ok - ${message}`);
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `ASSERTION FAILED: ${message}\n    expected: ${String(expected)}\n    actual:   ${String(actual)}`
    );
  }
  passed++;
  console.log(`  ok - ${message} (${String(actual)})`);
}

async function waitFor(
  cond: () => Promise<boolean> | boolean,
  timeoutMs: number,
  what: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(200);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const debug = process.argv.includes('--debug');
  const NODE_WALLET = 'w1';
  const FUND_NAV = 10;
  const FUND_SATS = BigInt(FUND_NAV) * 100_000_000n;
  const SEND_BACK_SATS = 400_000_000n;

  console.log('== 1. Starting blsctregtest node');
  const node = await startRegtestNode();
  let client: NavioClient | null = null;
  let failed = false;
  try {
    const info = await node.rpc('getblockchaininfo');
    assertEq(info.chain, 'blsctregtest', 'node chain');
    console.log(`  p2p port ${node.port}, rpc port ${node.rpcPort}`);

    await node.rpc('createwallet', [NODE_WALLET]);
    const nodeAddr: string = await node.rpc('getnewaddress', ['', 'blsct'], NODE_WALLET);
    assert(
      nodeAddr.startsWith('rnv1'),
      `node BLSCT address has regtest prefix (${nodeAddr.slice(0, 12)}...)`
    );

    console.log('  mining 101 blocks to the node wallet (coinbase maturity)...');
    const t0 = Date.now();
    const mined: string[] = await node.rpc('generatetoblsctaddress', [101, nodeAddr]);
    assertEq(mined.length, 101, `mined 101 blocks in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    assertEq(await node.rpc('getblockcount'), 101, 'node height');

    console.log('== 2. Creating SDK wallet with backend: p2p');
    client = new NavioClient({
      walletDbPath: ':memory:',
      databaseAdapter: 'better-sqlite3',
      backend: 'p2p',
      network: 'regtest',
      p2p: { host: '127.0.0.1', port: node.port, debug },
      createWalletIfNotExists: true,
      creationHeight: 0,
    });
    await client.initialize();
    assert(client.isConnected(), 'SDK connected to node over P2P');
    assertEq(client.getBackendType(), 'p2p', 'backend type');

    const provider = client.getSyncProvider() as P2PSyncProvider;
    assertEq(await provider.getChainTipHeight(), 101, 'provider chain tip after header sync');
    const tip = await client.getChainTip();
    assertEq(tip.hash, await node.rpc('getbestblockhash'), 'provider tip hash matches node');
    const genesisHeader = await provider.getBlockHeader(0);
    assertEq(
      provider['extractBlockHash'](genesisHeader),
      await node.rpc('getblockhash', [0]),
      'genesis header hash matches node'
    );

    const sdkAddr = client
      .getKeyManager()
      .getSubAddressBech32m({ account: 0, address: 0 }, 'regtest');
    assert(
      sdkAddr.startsWith('rnv1'),
      `SDK address has regtest prefix (${sdkAddr.slice(0, 12)}...)`
    );
    const peers = await node.rpc('getpeerinfo');
    assertEq(peers.length, 1, 'node sees one peer');
    assert(
      String(peers[0].subver).includes('navio-sdk'),
      `peer user agent is the SDK (${peers[0].subver})`
    );

    console.log('== 3. Node pays the SDK wallet, mines 1 block');
    // sendtoblsctaddress returns the recipient OUTPUT hash (BLSCT wallets
    // store outputs, not transactions); the txid comes from the mempool.
    const fundOutputHash: string = await node.rpc(
      'sendtoblsctaddress',
      [sdkAddr, FUND_NAV],
      NODE_WALLET
    );
    assert(
      /^[0-9a-f]{64}$/.test(fundOutputHash),
      `funding output hash ${fundOutputHash.slice(0, 16)}...`
    );
    const mempool: string[] = await node.rpc('getrawmempool');
    assertEq(mempool.length, 1, 'funding tx is the only tx in the node mempool');
    const fundTxid = mempool[0];
    await node.rpc('generatetoblsctaddress', [1, nodeAddr]);
    assertEq(await node.rpc('getblockcount'), 102, 'node height after funding block');

    console.log('== 4. SDK syncs over P2P and scans BLSCT outputs');
    let progressCalls = 0;
    await client.sync({ onProgress: () => progressCalls++ });
    assertEq(client.getLastSyncedHeight(), 102, 'SDK synced to tip');
    assert(progressCalls > 0, `sync reported progress (${progressCalls} callbacks)`);
    const balance = await client.getBalance();
    assertEq(balance, FUND_SATS, 'SDK balance equals the funded amount (sats)');
    const utxos = await client.getUnspentOutputs();
    assertEq(utxos.length, 1, 'SDK has one unspent output');
    assertEq(utxos[0].txHash, fundTxid, 'unspent output belongs to the funding tx');
    assertEq(
      utxos[0].outputHash,
      fundOutputHash,
      'unspent output hash matches what the node reported'
    );
    assertEq(utxos[0].blockHeight, 102, 'unspent output confirmed at height 102');
    const fundRawNode: string = await node.rpc('getrawtransaction', [fundTxid]);
    assertEq(
      await provider.getRawTransaction(fundTxid),
      fundRawNode,
      'getRawTransaction (most recent block) matches node'
    );

    console.log('== 5. SDK sends back to the node over P2P');
    const nodeBalanceBefore: number = await node.rpc('getbalance', [], NODE_WALLET);
    const send = await client.sendTransaction({ address: nodeAddr, amount: SEND_BACK_SATS });
    assert(
      /^[0-9a-f]{64}$/.test(send.txId),
      `SDK txid ${send.txId.slice(0, 16)}... (fee ${send.fee} sats)`
    );
    const mempool2: string[] = await node.rpc('getrawmempool');
    assert(mempool2.includes(send.txId), 'SDK tx is in the node mempool');
    const sendRawNode: string = await node.rpc('getrawtransaction', [send.txId]);
    assertEq(sendRawNode, send.rawTx, 'node holds the exact bytes the SDK broadcast');
    assertEq(
      await client.getPendingSpentAmount(),
      FUND_SATS,
      'funding output is pending-spent before confirmation'
    );

    // Re-broadcasting the same tx must not error (node already has it)
    assertEq(
      await provider.broadcastTransaction(send.rawTx),
      send.txId,
      're-broadcast of a mempool tx is idempotent'
    );

    // A garbage transaction must be reported as rejected
    let rejected = false;
    try {
      const bad = Buffer.from(send.rawTx, 'hex');
      bad[bad.length - 1] ^= 0xff; // corrupt the BLSCT signature
      await provider.broadcastTransaction(bad.toString('hex'));
    } catch (e: any) {
      rejected = /not accepted/.test(String(e?.message));
    }
    assert(rejected, 'broadcast of an invalid tx reports mempool rejection');

    await node.rpc('generatetoblsctaddress', [1, nodeAddr]);
    assertEq(await node.rpc('getblockcount'), 103, 'node height after spend block');
    await client.sync();
    assertEq(client.getLastSyncedHeight(), 103, 'SDK synced past the spend block');
    const expectedBalance = FUND_SATS - SEND_BACK_SATS - send.fee;
    assertEq(await client.getBalance(), expectedBalance, 'SDK balance = funded - sent - fee');
    assertEq(await client.getPendingSpentAmount(), 0n, 'no pending spends after confirmation');
    const all = await client.getAllOutputs();
    const spent = all.find(o => o.txHash === fundTxid);
    assert(
      spent && spent.isSpent && spent.spentTxHash === send.txId,
      'funding output marked spent by the SDK tx'
    );
    const change = (await client.getUnspentOutputs()).find(o => o.txHash === send.txId);
    assert(
      change && change.blockHeight === 103 && change.amount === expectedBalance,
      'change output confirmed at 103'
    );
    const nodeBalanceAfter: number = await node.rpc('getbalance', [], NODE_WALLET);
    assert(
      Math.round((nodeBalanceAfter - nodeBalanceBefore) * 1e8) >= Number(SEND_BACK_SATS),
      `node wallet received the payment (+${(nodeBalanceAfter - nodeBalanceBefore).toFixed(8)} NAV incl. block reward)`
    );

    console.log('== 6. getRawTransaction and polling');
    assertEq(
      await provider.getRawTransaction(send.txId),
      sendRawNode,
      'getRawTransaction (recent) matches node'
    );
    // Block 102 is no longer the node's most recent block: served via the scanned-block index
    assertEq(
      await provider.getRawTransaction(fundTxid),
      fundRawNode,
      'getRawTransaction (older block) matches node'
    );
    const verbose = (await provider.getRawTransaction(fundTxid, true)) as any;
    assertEq(verbose.height, 102, 'verbose getRawTransaction reports height');
    assertEq(
      verbose.blockhash,
      await node.rpc('getblockhash', [102]),
      'verbose getRawTransaction reports block hash'
    );
    let notFound = false;
    try {
      await provider.getRawTransaction('11'.repeat(32));
    } catch (e: any) {
      notFound = /not found/.test(String(e?.message));
    }
    assert(notFound, 'unknown txid rejects with not found');

    const newBlocks: number[] = [];
    let balanceChanges = 0;
    await client.startBackgroundSync({
      pollInterval: 500,
      onNewBlock: height => newBlocks.push(height),
      onBalanceChange: () => balanceChanges++,
      onError: e => console.error('  background sync error:', e.message),
    });
    assert(client.isBackgroundSyncActive(), 'background sync running');
    await node.rpc('generatetoblsctaddress', [1, nodeAddr]);
    await waitFor(() => newBlocks.includes(104), 15_000, 'onNewBlock(104)');
    assert(newBlocks.includes(104), 'polling cycle picked up block 104 without restart');
    await waitFor(() => client!.getLastSyncedHeight() === 104, 15_000, 'lastSyncedHeight 104');
    assertEq(client.getLastSyncedHeight(), 104, 'SDK synced to 104 in the background');
    assertEq(await node.rpc('getblockcount'), 104, 'node height 104');
    client.stopBackgroundSync();
    assertEq(await client.getBalance(), expectedBalance, 'balance unchanged by empty block');

    console.log(`\nALL ${passed} ASSERTIONS PASSED`);
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    if (client) {
      try {
        client.stopBackgroundSync();
        await client.disconnect();
      } catch {
        // ignore teardown errors
      }
    }
    await node.stop(failed && KEEP_DATADIR_ON_FAILURE);
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('\nFAILED:', error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });
