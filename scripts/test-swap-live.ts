#!/usr/bin/env tsx
/**
 * Live end-to-end test of RFQ atomic-swap trading on blsctregtest.
 *
 * Spawns two naviod nodes (A: light-wallet node, B: core-wallet
 * counterparty), funds an SDK wallet over the P2P backend from node A, and
 * exercises both roles:
 *
 *   1. SDK as TAKER:  SDK requestQuote -> B (maker, core wallet) replyquote
 *                     -> SDK acceptQuote (SDK-built unbalanced taker half)
 *   2. SDK as MAKER:  B requestquote -> SDK replyQuote (SDK-built maker half
 *                     via sendquote) -> B acceptquotewallet
 *   3. SDK broadcastOrder smoke test (standing order cached network-wide)
 *
 * The daemon RPCs are driven through a thin adapter with the same method
 * surface as the ElectrumX RFQ bridge, so every SDK code path above the
 * transport is the real one.
 *
 * Requirements:
 *   NAVIOD=/path/to/naviod (built from navio-core branch `p2pmsg`)
 *
 * Run: NAVIOD=../navio-core/build/bin/naviod npx tsx scripts/test-swap-live.ts
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NavioClient } from '../src/client';
import { Address, AddressEncoding, DoublePublicKey } from 'navio-blsct';

const NAVIOD = process.env.NAVIOD ?? '../navio-core/build/bin/naviod';
const CHAIN = 'blsctregtest';
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'navio-swap-e2e-'));

interface Node {
  name: string;
  proc: ChildProcess;
  rpcPort: number;
  p2pPort: number;
  datadir: string;
}

async function rpc(node: Node, method: string, params: any[] | Record<string, any> = [], wallet?: string): Promise<any> {
  const url = `http://127.0.0.1:${node.rpcPort}/${wallet ? `wallet/${wallet}` : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from('test:test').toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'e2e', method, params }),
  });
  const body: any = await res.json();
  if (body.error) {
    throw new Error(`${node.name} ${method}: ${JSON.stringify(body.error)}`);
  }
  return body.result;
}

function startNode(name: string, p2pPort: number, rpcPort: number, connectTo?: number): Node {
  const datadir = path.join(BASE, name);
  fs.mkdirSync(datadir, { recursive: true });
  const args = [
    `-chain=${CHAIN}`,
    `-datadir=${datadir}`,
    `-port=${p2pPort}`,
    `-rpcport=${rpcPort}`,
    '-rpcuser=test',
    '-rpcpassword=test',
    '-p2pmsg=1',
    '-p2pmsgpowbits=1',
    '-fallbackfee=0.00001',
    '-listen=1',
    '-server=1',
    '-debug=net',
  ];
  if (connectTo) {
    args.push(`-connect=127.0.0.1:${connectTo}`);
  } else {
    args.push('-connect=0');
  }
  // Hardened runtimes strip DYLD_* from the environment on macOS, so a
  // homebrew-linked naviod loses its library path when spawned from node.
  // Re-inject it explicitly (override with NAVIOD_LIB_PATH).
  const proc = spawn(NAVIOD, args, {
    stdio: 'ignore',
    env: {
      ...process.env,
      DYLD_LIBRARY_PATH: process.env.NAVIOD_LIB_PATH ?? '/opt/homebrew/lib',
      LD_LIBRARY_PATH: process.env.NAVIOD_LIB_PATH ?? '/opt/homebrew/lib',
    },
  });
  return { name, proc, rpcPort, p2pPort, datadir };
}

async function waitForRpc(node: Node): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      await rpc(node, 'getblockcount');
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`${node.name}: RPC did not come up`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 30000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) {
      return value as T;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${what}`);
    }
    await sleep(500);
  }
}

function assert(cond: any, msg: string): void {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// bech32_mod re-encode (navio-core src/blsct/bech32_mod.cpp port).
//
// The published navio-blsct binding encodes regtest BLSCT addresses with the
// HRP "rnav" (a navio-core bug: blsct::bech32_hrp::Regtest disagreed with the
// chainparams' "rnv"; fixed on the p2pmsg branch). The daemon only decodes
// "rnv", so re-encode the payload under the correct HRP.
// ---------------------------------------------------------------------------
const B32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32M_MOD_CONST = 0x2bc830a3n;

function bech32ModPolyMod(values: number[]): bigint {
  let c = 1n;
  for (const v of values) {
    const c0 = Number(c >> 35n);
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(v);
    if (c0 & 1) c ^= 0xf0732dc147n;
    if (c0 & 2) c ^= 0xa8b6dfa68en;
    if (c0 & 4) c ^= 0x193fabc83cn;
    if (c0 & 8) c ^= 0x322fd3b451n;
    if (c0 & 16) c ^= 0x640f37688bn;
  }
  return c;
}

function bech32ModExpandHrp(hrp: string): number[] {
  const ret: number[] = [];
  for (const ch of hrp) ret.push(ch.charCodeAt(0) >> 5);
  ret.push(0);
  for (const ch of hrp) ret.push(ch.charCodeAt(0) & 0x1f);
  return ret;
}

function reencodeBlsctAddress(address: string, newHrp: string): string {
  const sep = address.lastIndexOf('1');
  const dataPart = address.slice(sep + 1);
  // Drop the 8-char checksum; keep the payload values.
  const values = [...dataPart.slice(0, -8)].map((ch) => B32_CHARSET.indexOf(ch));
  if (values.some((v) => v < 0)) {
    throw new Error(`invalid bech32 payload in ${address}`);
  }
  const enc = [...bech32ModExpandHrp(newHrp), ...values, 0, 0, 0, 0, 0, 0, 0, 0];
  const mod = bech32ModPolyMod(enc) ^ BECH32M_MOD_CONST;
  let out = `${newHrp}1${values.map((v) => B32_CHARSET[v]).join('')}`;
  for (let i = 0; i < 8; i++) {
    out += B32_CHARSET[Number((mod >> BigInt(5 * (7 - i))) & 31n)];
  }
  return out;
}

/**
 * Adapter with the ElectrumX RFQ-bridge method surface, backed directly by
 * node A's RPC. Lets the live test exercise every SDK trading code path
 * without deploying an ElectrumX instance.
 */
function makeBridgeAdapter(node: Node) {
  return {
    p2pmsgInfo: () => rpc(node, 'getp2pmsginfo'),
    rfqRequestQuote: (buy: string, sell: string, size: number, expiry: number) =>
      rpc(node, 'requestquote', [buy, sell, size, expiry]),
    rfqListQuotes: (uuid: string, minFillRatio: number) =>
      rpc(node, 'listquotes', [uuid, minFillRatio]),
    rfqAcceptQuote: (uuid: string, quoteId: string, halfHex: string) =>
      rpc(node, 'acceptquote', [uuid, quoteId, halfHex]),
    rfqCancel: (uuid: string) => rpc(node, 'cancelrfq', [uuid]),
    swapSetIntent: (tin: string, tout: string, mn: number, mx: number, pm: number, exp: number) =>
      rpc(node, 'setswapintent', [tin, tout, mn, mx, pm, exp]),
    swapClearIntent: (id: number) => rpc(node, 'clearswapintent', [id]),
    swapListIntents: () => rpc(node, 'listswapintents'),
    swapPendingRequests: () => rpc(node, 'listpendingquoterequests'),
    swapSendQuote: (
      uuid: string, replyKey: string, halfHex: string, buy: string, sell: string,
      fill: number, sellCost: number, orderExpiry: number,
    ) => rpc(node, 'sendquote', [uuid, replyKey, halfHex, buy, sell, fill, sellCost, orderExpiry]),
    swapBroadcastOrder: (
      halfHex: string, offerToken: string, offerAmount: number,
      wantToken: string, wantAmount: number, expiry: number,
    ) => rpc(node, 'sendorder', [halfHex, offerToken, offerAmount, wantToken, wantAmount, expiry]),
  };
}

async function main() {
  console.log(`work dir: ${BASE}`);
  const nodeA = startNode('nodeA', 18544, 18545);
  const nodeB = startNode('nodeB', 18554, 18555, 18544);
  const nodes = [nodeA, nodeB];
  const expiry = () => Math.floor(Date.now() / 1000) + 600;

  try {
    await Promise.all(nodes.map(waitForRpc));
    console.log('✓ nodes up');
    await waitFor('peer connection', async () =>
      (await rpc(nodeA, 'getconnectioncount')) >= 1);

    // ---- B: core wallet (counterparty), funded, with a token ----
    await rpc(nodeB, 'createwallet', { wallet_name: 'w1', blsct: true });
    const addrB = await rpc(nodeB, 'getnewaddress', ['', 'blsct'], 'w1');
    await rpc(nodeB, 'generatetoblsctaddress', [110, addrB]);
    console.log('✓ nodeB wallet funded');

    const token = await rpc(nodeB, 'createtoken', [{ name: 'TOK' }, 1000], 'w1');
    const tokenId: string = token.tokenId;
    await rpc(nodeB, 'generatetoblsctaddress', [1, addrB]);
    await rpc(nodeB, 'minttoken', [tokenId, addrB, 100], 'w1');
    await rpc(nodeB, 'generatetoblsctaddress', [2, addrB]);
    console.log(`✓ nodeB minted token ${tokenId.slice(0, 16)}…`);

    // ---- SDK wallet on node A over the P2P backend ----
    const dbPath = path.join(BASE, 'sdk-wallet.db');
    const client = new NavioClient({
      walletDbPath: dbPath,
      backend: 'p2p',
      p2p: { host: '127.0.0.1', port: nodeA.p2pPort, network: 'regtest', debug: !!process.env.SWAP_E2E_DEBUG },
      createWalletIfNotExists: true,
      network: 'regtest',
    } as any);
    await client.initialize();
    const km = client.getKeyManager();
    const subAddr = km.getSubAddress({ account: 0, address: 0 });
    let sdkAddress = Address.encode(
      DoublePublicKey.deserialize(subAddr.serialize()), AddressEncoding.Bech32M);
    if (sdkAddress.startsWith('rnav1')) {
      sdkAddress = reencodeBlsctAddress(sdkAddress, 'rnv');
    }
    console.log(`✓ SDK wallet up (${sdkAddress.slice(0, 24)}…)`);

    // Fund the SDK wallet with a regular send from B's wallet (coinbase
    // outputs to a light wallet are not scanned the same way), then mine.
    await rpc(nodeB, 'sendtoblsctaddress', [sdkAddress, 1000], 'w1');
    await rpc(nodeB, 'generatetoblsctaddress', [2, addrB]);

    const syncAndCheck = async (what: string, check: () => Promise<boolean>) => {
      await waitFor(what, async () => {
        // The P2P provider caches the header tip from the initial handshake;
        // pass the daemon's current height explicitly so each sync round
        // scans blocks mined after the SDK connected.
        const tip = await rpc(nodeA, 'getblockcount');
        const synced = await client.sync({ endHeight: tip });
        if (process.env.SWAP_E2E_DEBUG) console.log(`  sync(${what}) to ${tip}: ${synced}`);
        return check();
      }, 120000);
    };
    await syncAndCheck('SDK NAV balance', async () => (await client.getBalanceNav()) > 0n);
    const navBalance = await client.getBalanceNav();
    console.log(`✓ SDK synced, balance ${Number(navBalance) / 1e8} NAV`);

    (client as any).electrumClient = makeBridgeAdapter(nodeA);

    // =====================================================================
    // 1) SDK as TAKER: buy 500 TOK paying NAV; maker = core wallet on B
    // =====================================================================
    await rpc(nodeB, 'setswapintent', [tokenId, '', 100, 10_000, 10_000_000, expiry()]);

    const req = await client.requestQuote({
      buyTokenId: tokenId,
      sellTokenId: null,
      amount: 500n,
      expiry: expiry(),
    });
    console.log(`✓ taker RFQ open ${req.uuid.slice(0, 16)}…`);

    const pendingB = await waitFor('maker match on B', async () => {
      const pending = await rpc(nodeB, 'listpendingquoterequests');
      return pending.length > 0 ? pending : null;
    });
    assert(pendingB[0].uuid === req.uuid, 'pending uuid matches request');

    await rpc(nodeB, 'replyquote', [req.uuid], 'w1');
    console.log('✓ maker (core wallet) replied');

    const quotes = await waitFor('quote collected on A', async () => {
      const collected = await client.listQuotes(req.uuid);
      return collected.length > 0 ? collected : null;
    });
    assert(quotes[0].fill === 500n, `quote fill is 500 (got ${quotes[0].fill})`);
    assert(quotes[0].sellCost === 50n, `quote sell_cost is 50 (got ${quotes[0].sellCost})`);

    const accept = await client.acceptQuote({
      uuid: req.uuid,
      quoteId: quotes[0].quoteId,
      buyTokenId: tokenId,
      sellTokenId: null,
      maxPay: 100n,
      minRecv: 500n,
    });
    console.log(`✓ SDK taker half combined + broadcast: ${accept.txId.slice(0, 16)}…`);

    // Wait for the swap tx to relay to the mining node before mining.
    await waitFor('swap tx in nodeB mempool', async () =>
      ((await rpc(nodeB, 'getrawmempool')) as string[]).includes(accept.txId));
    await rpc(nodeB, 'generatetoblsctaddress', [2, addrB]);
    await syncAndCheck('SDK token balance', async () =>
      (await client.getTokenBalance(tokenId)) >= 500n);
    console.log(`✓ swap confirmed on-chain: SDK holds ${await client.getTokenBalance(tokenId)} TOK`);

    // =====================================================================
    // 2) SDK as MAKER: sell 200 TOK for NAV; taker = core wallet on B
    // =====================================================================
    const intentId = await client.setSwapIntent({
      tokenInId: tokenId,
      tokenOutId: null,
      minSize: 1n,
      maxSize: 1_000n,
      priceMin: 10_000_000n, // 0.1 NAV per TOK
      expiry: expiry(),
    });
    console.log(`✓ SDK maker intent ${intentId} set on node A`);

    const reqB = await rpc(nodeB, 'requestquote', [tokenId, '', 200, expiry()]);

    const pendingSdk = await waitFor('maker match on A (SDK)', async () => {
      const pending = await client.getPendingQuoteRequests();
      return pending.length > 0 ? pending : null;
    });
    assert(pendingSdk[0].uuid === reqB.uuid, 'pending uuid matches B request');
    assert(pendingSdk[0].fill === 200n, `pending fill is 200 (got ${pendingSdk[0].fill})`);
    assert(pendingSdk[0].sellCost === 20n, `pending sell_cost is 20 (got ${pendingSdk[0].sellCost})`);

    const reply = await client.replyQuote({ request: pendingSdk[0] });
    console.log(`✓ SDK maker half sent as quote ${reply.quoteId.slice(0, 16)}… (fee ${reply.fee})`);

    await waitFor('quote collected on B', async () => {
      const collected = await rpc(nodeB, 'listquotes', [reqB.uuid]);
      return collected.length > 0 ? collected : null;
    });
    const swapTx = await rpc(
      nodeB, 'acceptquotewallet', [reqB.uuid, reply.quoteId, 1_000_000, 200], 'w1');
    console.log(`✓ core taker accepted SDK maker half: ${String(swapTx).slice(0, 16)}…`);

    await waitFor('maker-leg swap tx in nodeB mempool', async () =>
      ((await rpc(nodeB, 'getrawmempool')) as string[]).includes(String(swapTx)));
    await rpc(nodeB, 'generatetoblsctaddress', [2, addrB]);
    const tokenBalanceB = await rpc(nodeB, 'gettokenbalance', [tokenId], 'w1');
    assert(Number(tokenBalanceB) > 0, 'nodeB wallet received the tokens');

    await syncAndCheck('SDK maker leg confirmed', async () =>
      (await client.getTokenBalance(tokenId)) <= 300n);
    console.log('✓ SDK maker leg confirmed on-chain');

    // =====================================================================
    // 3) SDK standing order smoke test
    // =====================================================================
    const order = await client.broadcastOrder({
      offerTokenId: tokenId,
      offerAmount: 100n,
      wantTokenId: null,
      wantAmount: 10n,
      expiry: expiry(),
    });
    console.log(`✓ SDK standing order ${order.quoteId.slice(0, 16)}… broadcast`);

    const ordersA = await rpc(nodeA, 'listorders');
    assert(ordersA.count >= 1, 'node A cached the standing order');
    await waitFor('order cached on B', async () => {
      const orders = await rpc(nodeB, 'listorders');
      return orders.count >= 1;
    });
    console.log('✓ standing order cached network-wide');

    console.log('\nALL SWAP E2E CHECKS PASSED');
    await client.disconnect();
  } finally {
    for (const node of nodes) {
      try {
        node.proc.kill('SIGTERM');
      } catch { /* ignore */ }
    }
    await sleep(1500);
    for (const node of nodes) {
      try {
        node.proc.kill('SIGKILL');
      } catch { /* ignore */ }
    }
  }
}

main().catch((err) => {
  console.error('\nE2E FAILED:', err);
  process.exit(1);
});
