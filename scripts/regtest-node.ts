/**
 * Shared helpers for the regtest end-to-end scripts: a throwaway
 * `naviod -chain=blsctregtest` node and plain assertions.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
export const KEEP_DATADIR_ON_FAILURE =
  process.env.KEEP_DATADIR === '1' || process.argv.includes('--keep');

export interface RegtestNode {
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

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A JSON-RPC client for the node listening on `rpcPort`. */
function rpcClient(rpcPort: number): RegtestNode['rpc'] {
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
  return rpc;
}

/**
 * Attach to a blsctregtest node that is already running, rather than spawn
 * one, when NAVIO_REGTEST_P2P_PORT and NAVIO_REGTEST_RPC_PORT are set: for a
 * node the script cannot start itself, such as one in WSL or a container. It
 * must be a fresh chain with RPC credentials user/pass, listening on
 * 127.0.0.1. stop() leaves it running.
 */
function attachedNode(): RegtestNode | null {
  const p2p = process.env.NAVIO_REGTEST_P2P_PORT;
  const rpcPort = process.env.NAVIO_REGTEST_RPC_PORT;
  if (p2p === undefined && rpcPort === undefined) return null;
  if (p2p === undefined || rpcPort === undefined) {
    throw new Error(
      'Set both NAVIO_REGTEST_P2P_PORT and NAVIO_REGTEST_RPC_PORT to attach to a node'
    );
  }
  return {
    port: Number(p2p),
    rpcPort: Number(rpcPort),
    datadir: '',
    rpc: rpcClient(Number(rpcPort)),
    stop: async () => undefined,
  };
}

export async function startRegtestNode(binary = DEFAULT_NAVIOD): Promise<RegtestNode> {
  const attached = attachedNode();
  if (attached) return attached;

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

  const rpc = rpcClient(rpcPort);

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

/** How many assertions have passed so far. */
export function assertionsPassed(): number {
  return passed;
}
export function assert(cond: unknown, message: string): void {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  passed++;
  console.log(`  ok - ${message}`);
}

export function assertEq<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `ASSERTION FAILED: ${message}\n    expected: ${String(expected)}\n    actual:   ${String(actual)}`
    );
  }
  passed++;
  console.log(`  ok - ${message} (${String(actual)})`);
}

export async function waitFor(
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
