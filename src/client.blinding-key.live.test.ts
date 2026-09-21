import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PublicKey, Signature } from '@nav-io/navio-blsct';
import { NavioClient } from './client';

/**
 * Live end-to-end proof of blinding-key recovery against testnet.
 *
 * Verifies the property the whole design exists for: a wallet holding nothing
 * but its mnemonic can recompute the blinding scalar of an output it created
 * earlier, and sign with it.
 *
 * Run with:
 *   NAVIO_LIVE_TESTS=1 NAVIO_BLINDING_MNEMONIC="<24 words>" npx vitest run \
 *     src/client.blinding-key.live.test.ts
 *
 * The mnemonic is not committed. By default the test checks the output listed
 * below, which was created by navio-sdk 0.2.0 on testnet; point
 * NAVIO_BLINDING_TXID / NAVIO_BLINDING_VOUT at any output created by the
 * wallet whose mnemonic you supply.
 */
const runLive = process.env.NAVIO_LIVE_TESTS === '1' && !!process.env.NAVIO_BLINDING_MNEMONIC;
const describeLive = runLive ? describe : describe.skip;

const MNEMONIC = process.env.NAVIO_BLINDING_MNEMONIC ?? '';
const HOST = process.env.NAVIO_ELECTRUM_HOST || 'testnet.nav.io';
const PORT = process.env.NAVIO_ELECTRUM_PORT ? Number(process.env.NAVIO_ELECTRUM_PORT) : 50005;
const SSL = process.env.NAVIO_ELECTRUM_SSL === '1';

/** An output created by navio-sdk 0.2.0, confirmed in testnet block 85527. */
const TXID = process.env.NAVIO_BLINDING_TXID
  || '83bb6300b6a270205d3fa96ad77024be668ba20a3fdddba4dce2c8bae724279d';
const VOUT = process.env.NAVIO_BLINDING_VOUT ? Number(process.env.NAVIO_BLINDING_VOUT) : 0;

describeLive('NavioClient blinding key recovery (live testnet)', () => {
  const cleanupPaths: string[] = [];

  afterAll(async () => {
    await Promise.allSettled(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })));
  });

  it(
    'recovers a blinding key from the mnemonic alone and signs a message with it',
    async () => {
      const baseDir = await mkdtemp(join(tmpdir(), 'navio-blinding-live-'));
      cleanupPaths.push(baseDir);

      // A wallet restored from the mnemonic and never synced: its database
      // holds no stored scalars, so only the seed derivation can succeed.
      const client = new NavioClient({
        walletDbPath: join(baseDir, 'restored.db'),
        network: 'testnet',
        backend: 'electrum',
        electrum: { host: HOST, port: PORT, ssl: SSL, timeout: 120000 },
        createWalletIfNotExists: true,
        restoreFromMnemonic: MNEMONIC,
        restoreFromHeight: 0,
      });

      try {
        await client.initialize();

        const recovered = await client.recoverBlindingKey({ txid: TXID, vout: VOUT });
        console.log('[blinding-live] recovered', {
          source: recovered.source,
          counter: recovered.counter,
          publicKey: recovered.publicKey,
        });

        // Nothing was stored in this wallet, so it must have been derived.
        expect(recovered.source).toBe('derived');
        expect(recovered.counter).toBeGreaterThanOrEqual(0);
        expect(recovered.blindingKey).toMatch(/^[0-9a-f]{64}$/);
        expect(recovered.publicKey).toMatch(/^[0-9a-f]{96}$/);

        const message = `navio-hl-refund/v1|${TXID}|${VOUT}|live round trip`;
        const { signature, blindingKey } = await client.signOutput({
          txid: TXID,
          vout: VOUT,
          message,
        });
        console.log('[blinding-live] signature', signature);

        expect(blindingKey).toBe(recovered.publicKey);

        const publicKey = PublicKey.deserialize(blindingKey);
        expect(Signature.deserialize(signature).verify(publicKey, message)).toBe(true);
        expect(Signature.deserialize(signature).verify(publicKey, `${message}!`)).toBe(false);
      } finally {
        await client.disconnect();
      }
    },
    10 * 60 * 1000
  );
});
