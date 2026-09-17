/**
 * Bench: full mainnet sync from genesis, Electrum vs P2P backend.
 *   npx tsx scripts/bench-sync.ts [electrum|p2p|both] [--from <height>]
 */
import { NavioClient } from '../src/index';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const which = process.argv[2] ?? 'both';
const fromIdx = process.argv.indexOf('--from');
const fromHeight = fromIdx > 0 ? Number(process.argv[fromIdx + 1]) : 0;
const ELECTRUM = { host: 'electrum.nav.io', port: 50004, ssl: true }; // 50004 = wss (50002 is raw TLS Electrum)
const P2P = { host: process.env.P2P_HOST ?? '168.119.249.67', port: 48470 };

async function bench(backend: 'electrum' | 'p2p') {
  const dir = mkdtempSync(join(tmpdir(), `bench-${backend}-`));
  const client = new NavioClient({
    walletDbPath: join(dir, 'wallet.db'),
    network: 'mainnet',
    backend,
    electrum: ELECTRUM,
    p2p: { ...P2P, network: 'mainnet' },
    createWalletIfNotExists: true,
    creationHeight: fromHeight,
  } as any);
  const t0 = Date.now();
  await client.initialize();
  const tInit = Date.now();
  let last = { h: 0, tip: 0, blocks: 0, keys: 0 };
  let firstProgress = 0;
  let peakRss = 0;
  const mem = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 500);
  const finalHeight = await client.sync({
    onProgress: (h: number, tip: number, blocks: number, keys: number) => {
      if (!firstProgress) firstProgress = Date.now();
      last = { h, tip, blocks, keys };
      if (blocks % 2000 < 50) process.stderr.write(`[${backend}] ${h}/${tip} ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
    },
  } as any);
  const tEnd = Date.now();
  clearInterval(mem);
  const balance = await client.getBalance();
  await client.disconnect();
  rmSync(dir, { recursive: true, force: true });
  const total = (tEnd - t0) / 1000;
  const scan = (tEnd - tInit) / 1000;
  return { backend, finalHeight, tip: last.tip, blocks: last.blocks, txKeys: last.keys, init_s: +((tInit - t0) / 1000).toFixed(1), sync_s: +scan.toFixed(1), total_s: +total.toFixed(1), blocks_per_s: +(last.blocks / scan).toFixed(1), peakRssMB: Math.round(peakRss / 1048576), balance: balance.toString() };
}

async function main() {
  const results: unknown[] = [];
  const list: Array<'electrum' | 'p2p'> = which === 'both' ? ['electrum', 'p2p'] : [which as 'electrum' | 'p2p'];
  for (const b of list) {
    try { results.push(await bench(b)); } catch (e) { results.push({ backend: b, error: String((e as Error).message ?? e) }); }
  }
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}
main();
