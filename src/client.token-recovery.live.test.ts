import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NavioClient } from './client';

const runLive = process.env.NAVIO_LIVE_TESTS === '1';
const describeLive = runLive ? describe : describe.skip;

const MNEMONIC =
  'short exact vendor hand scale enroll around pudding genius party lesson basket cook crash sugar protect advance gentle humor bench farm weekend direct awkward';
const TOKEN_HASH = 'b12a2ee7491ef649c0a6677fe2e996065f02210f84a934297cc8ba554f54e31c';
const HOST = process.env.NAVIO_ELECTRUM_HOST || 'testnet.nav.io';
const PORT = process.env.NAVIO_ELECTRUM_PORT ? Number(process.env.NAVIO_ELECTRUM_PORT) : 50005;
const SSL = process.env.NAVIO_ELECTRUM_SSL === '1';
const RESTORE_HEIGHT = process.env.NAVIO_TEST_RESTORE_HEIGHT
  ? Number(process.env.NAVIO_TEST_RESTORE_HEIGHT)
  : 150820;

describeLive('NavioClient token amount recovery live sync', () => {
  const cleanupPaths: string[] = [];

  afterAll(async () => {
    await Promise.allSettled(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })));
  });

  it(
    'should recover a positive amount for the known fungible token output',
    async () => {
      const baseDir = await mkdtemp(join(tmpdir(), 'navio-token-recovery-test-'));
      cleanupPaths.push(baseDir);

      const walletDbPath = join(baseDir, 'token-wallet.db');
      const client = new NavioClient({
        walletDbPath,
        network: 'testnet',
        backend: 'electrum',
        electrum: { host: HOST, port: PORT, ssl: SSL, timeout: 120000 },
        restoreFromMnemonic: MNEMONIC,
        restoreFromHeight: RESTORE_HEIGHT,
      });

      try {
        await client.initialize();
        const chainTip = await client.getChainTip();
        await client.sync({
          endHeight: chainTip.height,
          verifyHashes: true,
          saveInterval: 500,
        });

        const tokenOutputs = await client.getTokenOutputs(TOKEN_HASH);
        const recovered = tokenOutputs.map((output) => ({
          outputHash: output.outputHash,
          txHash: output.txHash,
          blockHeight: output.blockHeight,
          amount: output.amount.toString(),
          gamma: output.gamma,
          memo: output.memo,
          tokenId: output.tokenId,
          isSpent: output.isSpent,
        }));

        console.log('[token-recovery-live] recovered token outputs:', JSON.stringify(recovered, null, 2));

        expect(tokenOutputs.length).toBeGreaterThan(0);
        expect(tokenOutputs.some((output) => output.amount > 0n)).toBe(true);
      } finally {
        await client.disconnect();
      }
    },
    15 * 60 * 1000
  );
});
