import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NavioClient } from './client';

const runLive = process.env.NAVIO_LIVE_TESTS === '1';
const describeLive = runLive ? describe : describe.skip;

const MNEMONIC =
  'short exact vendor hand scale enroll around pudding genius party lesson basket cook crash sugar protect advance gentle humor bench farm weekend direct awkward';
const HOST = process.env.NAVIO_ELECTRUM_HOST || 'testnet.nav.io';
const PORT = process.env.NAVIO_ELECTRUM_PORT ? Number(process.env.NAVIO_ELECTRUM_PORT) : 50005;
const SSL = process.env.NAVIO_ELECTRUM_SSL === '1';
const RESTORE_HEIGHT = process.env.NAVIO_TEST_RESTORE_HEIGHT
  ? Number(process.env.NAVIO_TEST_RESTORE_HEIGHT)
  : 145900;

function normalizeOutputs(outputs: Awaited<ReturnType<NavioClient['getAllOutputs']>>) {
  return outputs
    .map((output) => ({
      outputHash: output.outputHash,
      txHash: output.txHash,
      outputIndex: output.outputIndex,
      blockHeight: output.blockHeight,
      amount: output.amount.toString(),
      gamma: output.gamma,
      memo: output.memo,
      tokenId: output.tokenId,
      blindingKey: output.blindingKey,
      spendingKey: output.spendingKey,
      isSpent: output.isSpent,
      spentTxHash: output.spentTxHash,
      spentBlockHeight: output.spentBlockHeight,
    }))
    .sort((a, b) => a.outputHash.localeCompare(b.outputHash));
}

describeLive('NavioClient audit-key live sync', () => {
  const cleanupPaths: string[] = [];

  afterAll(async () => {
    await Promise.allSettled(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })));
  });

  it(
    'should sync the same history from a mnemonic wallet and a watch-only audit-key wallet',
    async () => {
      const baseDir = await mkdtemp(join(tmpdir(), 'navio-audit-key-test-'));
      cleanupPaths.push(baseDir);

      const walletDbPath = join(baseDir, 'full-wallet.db');
      const auditWalletDbPath = join(baseDir, 'audit-wallet.db');

      const walletClient = new NavioClient({
        walletDbPath,
        network: 'testnet',
        backend: 'electrum',
        electrum: { host: HOST, port: PORT, ssl: SSL, timeout: 120000 },
        restoreFromMnemonic: MNEMONIC,
        restoreFromHeight: RESTORE_HEIGHT,
      });

      const auditClientCleanup: { client: NavioClient | null } = { client: null };

      try {
        await walletClient.initialize();
        const chainTip = await walletClient.getChainTip();
        const walletSyncCount = await walletClient.sync({
          endHeight: chainTip.height,
          verifyHashes: true,
          saveInterval: 500,
        });

        const auditKeyHex = walletClient.getAuditKeyHex();
        const walletOutputs = normalizeOutputs(await walletClient.getAllOutputs());
        const walletTxHashes = [...new Set(walletOutputs.map((output) => output.txHash))].sort();
        const walletBalance = (await walletClient.getBalance()).toString();

        expect(walletOutputs.length).toBeGreaterThan(0);
        expect(walletTxHashes.length).toBeGreaterThan(0);

        const auditClient = new NavioClient({
          walletDbPath: auditWalletDbPath,
          network: 'testnet',
          backend: 'electrum',
          electrum: { host: HOST, port: PORT, ssl: SSL, timeout: 120000 },
          restoreFromAuditKey: auditKeyHex,
          restoreFromHeight: RESTORE_HEIGHT,
        });
        auditClientCleanup.client = auditClient;

        await auditClient.initialize();
        const auditSyncCount = await auditClient.sync({
          endHeight: chainTip.height,
          verifyHashes: true,
          saveInterval: 500,
        });

        const auditOutputs = normalizeOutputs(await auditClient.getAllOutputs());
        const auditTxHashes = [...new Set(auditOutputs.map((output) => output.txHash))].sort();
        const auditBalance = (await auditClient.getBalance()).toString();

        expect(auditSyncCount).toBe(walletSyncCount);
        expect(auditOutputs.length).toBeGreaterThan(0);
        expect(auditTxHashes.length).toBeGreaterThan(0);
        expect(auditTxHashes).toEqual(walletTxHashes);
        expect(auditOutputs).toEqual(walletOutputs);
        expect(auditBalance).toBe(walletBalance);
      } finally {
        await Promise.allSettled([
          walletClient.disconnect(),
          auditClientCleanup.client ? auditClientCleanup.client.disconnect() : Promise.resolve(),
        ]);
      }
    },
    15 * 60 * 1000
  );
});
