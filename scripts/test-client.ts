#!/usr/bin/env tsx
/**
 * Test script for NavioClient
 * Demonstrates the main client API for wallet operations and syncing
 */

import { NavioClient } from '../src/client';
import * as path from 'path';

/**
 * Main test function
 */
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  NavioClient Test');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Parse command line arguments
  const args = process.argv.slice(2);
  let host = 'localhost';
  let port = 50005;
  let ssl = false;
  let dbPath = path.join(__dirname, '../test-client-wallet.db');
  let createWallet = false;
  let restoreSeed: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--host':
        host = args[++i];
        break;
      case '--port':
        port = parseInt(args[++i], 10);
        break;
      case '--ssl':
        ssl = true;
        break;
      case '--db':
        dbPath = args[++i];
        break;
      case '--create':
        createWallet = true;
        break;
      case '--restore':
        restoreSeed = args[++i];
        break;
      case '--help':
      case '-h':
        console.log(`
Usage: tsx scripts/test-client.ts [options]

Options:
  --host <host>    Electrum server host (default: localhost)
  --port <port>    Electrum server port (default: 50005)
  --ssl            Use SSL/TLS connection
  --db <path>      Wallet database path (default: test-client-wallet.db)
  --create         Create new wallet if it doesn't exist
  --restore <seed> Restore wallet from seed (hex string)
  --help, -h       Show this help message

Example:
  tsx scripts/test-client.ts --host localhost --port 50005 --create
      `);
        process.exit(0);
    }
  }

  try {
    // Create client
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Creating NavioClient');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const client = new NavioClient({
      walletDbPath: dbPath,
      electrum: {
        host,
        port,
        ssl,
      },
      createWalletIfNotExists: createWallet,
      restoreFromSeed: restoreSeed,
    });

    console.log(`Wallet DB: ${dbPath}`);
    console.log(`Electrum: ${host}:${port} (${ssl ? 'SSL' : 'no SSL'})\n`);

    // Initialize client (loads wallet, connects to Electrum, initializes sync)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Initializing Client');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await client.initialize();
    console.log('✓ Client initialized\n');

    // Get KeyManager and show wallet info
    const keyManager = client.getKeyManager();
    const subAddress = keyManager.getSubAddress({ account: 0, address: 0 });
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Wallet Information');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`Sub-address (account 0, address 0):`);
    console.log(`  ${subAddress.toString()}\n`);

    // Check sync status
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Sync Status');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const syncNeeded = await client.isSyncNeeded();
    const lastSynced = client.getLastSyncedHeight();
    const syncState = client.getSyncState();

    console.log(`Sync needed: ${syncNeeded}`);
    console.log(`Last synced height: ${lastSynced}`);
    if (syncState) {
      console.log(`Total TX keys synced: ${syncState.totalTxKeysSynced.toLocaleString()}`);
      console.log(`Last sync time: ${new Date(syncState.lastSyncTime).toLocaleString()}`);
    }
    console.log('');

    // Sync if needed
    if (syncNeeded) {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('Starting Sync');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      const startTime = Date.now();
      let lastProgressTime = startTime;

      const txKeysSynced = await client.sync({
        saveInterval: 100,
        onProgress: (currentHeight, chainTip, blocksProcessed, txKeysProcessed, isReorg) => {
          const now = Date.now();
          const elapsed = (now - lastProgressTime) / 1000;

          if (elapsed >= 1 || currentHeight === chainTip) {
            const progress = ((currentHeight / chainTip) * 100).toFixed(1);
            const rate = blocksProcessed / ((now - startTime) / 1000);
            console.log(
              `Progress: ${currentHeight}/${chainTip} (${progress}%) | ` +
                `Blocks: ${blocksProcessed} | TX Keys: ${txKeysProcessed} | ` +
                `Rate: ${rate.toFixed(1)} blocks/s`
            );
            lastProgressTime = now;
          }
        },
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(
        `\n✓ Sync completed: ${txKeysSynced.toLocaleString()} transaction keys synced in ${elapsed}s\n`
      );
    } else {
      console.log('✓ Wallet is up to date\n');
    }

    // Disconnect
    await client.disconnect();
    console.log('✓ Disconnected\n');

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Test completed successfully!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  } catch (error) {
    console.error('\n✗ Test Error:', error);
    if (error instanceof Error) {
      console.error('Stack:', error.stack);
    }
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
