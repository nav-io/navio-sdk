#!/usr/bin/env tsx
/**
 * Test script for NavioClient with background sync
 * Demonstrates continuous synchronization with the blockchain
 */

import { Address, AddressEncoding, DoublePublicKey } from 'navio-blsct';
import { NavioClient } from '../src/client';
import * as path from 'path';

/**
 * Main test function
 */
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  NavioClient Test (Electrum Backend)');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Parse command line arguments
  const args = process.argv.slice(2);
  let host = 'testnet.nav.io';
  let port = 50005;
  let ssl = false;
  let dbPath = path.join(__dirname, '../test-client-wallet.db');
  let createWallet = true;
  let restoreValue: string | undefined;
  let restoreIsMnemonic = false;
  let creationHeight: number | undefined;
  let cleanDb = false;
  let pollInterval = 10000; // Default 10 seconds

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
      case '--restore': {
        // Collect all words until the next flag (supports both hex seeds and mnemonic phrases)
        const words: string[] = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('--')) {
          words.push(args[++i]);
        }
        restoreValue = words.join(' ');
        // Detect mnemonic vs hex seed: hex seeds are a single word of hex chars
        restoreIsMnemonic = words.length > 1 || !/^[0-9a-fA-F]+$/.test(restoreValue);
        break;
      }
      case '--from-height':
        creationHeight = parseInt(args[++i], 10);
        break;
      case '--clean':
        cleanDb = true;
        break;
      case '--poll':
        pollInterval = parseInt(args[++i], 10) * 1000;
        break;
      case '--help':
      case '-h':
        console.log(`
Usage: tsx scripts/test-client.ts [options]

Options:
  --host <host>        Electrum server host (default: localhost)
  --port <port>        Electrum server port (default: 50005)
  --ssl                Use SSL/TLS connection
  --db <path>          Wallet database path (default: test-client-wallet.db)
  --create             Create new wallet if it doesn't exist
  --restore <seed>     Restore wallet from seed (hex) or mnemonic phrase
  --from-height <n>    Start syncing from height n (for new or restored wallets)
  --clean              Delete existing wallet DB before starting
  --poll <seconds>     Background sync poll interval (default: 10)
  --help, -h           Show this help message

Example:
  tsx scripts/test-client.ts --host localhost --port 50005 --create
  tsx scripts/test-client.ts --clean --from-height 0  # Full sync from genesis
  tsx scripts/test-client.ts --clean --restore <seed-hex> --from-height 50000
  tsx scripts/test-client.ts --clean --restore word1 word2 ... word24 --from-height 50000
    `);
        process.exit(0);
    }
  }

  // Clean up existing DB if requested (including WAL/SHM journal files)
  if (cleanDb) {
    const fs = await import('fs');
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
    console.log(`Deleted existing wallet: ${dbPath}\n`);
  }

  let client: NavioClient | null = null;

  try {
    // Create client
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Creating NavioClient');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    client = new NavioClient({
      walletDbPath: dbPath,
      electrum: {
        host,
        port,
        ssl,
      },
      createWalletIfNotExists: createWallet,
      network: 'testnet',
      restoreFromSeed: restoreIsMnemonic ? undefined : restoreValue,
      restoreFromMnemonic: restoreIsMnemonic ? restoreValue : undefined,
      creationHeight: restoreValue ? undefined : creationHeight,
      restoreFromHeight: restoreValue ? creationHeight : undefined,
    });

    console.log(`Wallet DB: ${dbPath}`);
    console.log(`Electrum: ${host}:${port} (${ssl ? 'SSL' : 'no SSL'})`);
    console.log(`Poll interval: ${pollInterval / 1000}s\n`);

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

    // Show wallet seed (important for recreation)
    try {
      const seedScalar = keyManager.getMasterSeedKey();
      const seedHex = seedScalar.serialize();
      console.log(`Seed (save this to restore wallet):`);
      console.log(`  ${seedHex}\n`);
    } catch {
      console.log('Seed: not available\n');
    }

    console.log(`Sub-address (account 0, address 0):`);
    console.log(`  ${subAddress.toString()}`);

    const dpk = DoublePublicKey.deserialize(subAddress.serialize());
    const address = Address.encode(dpk, AddressEncoding.Bech32M);
    console.log(`  ${address}\n`);

    // Show initial sync status
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Starting Background Sync');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const syncNeeded = await client.isSyncNeeded();
    const lastSynced = client.getLastSyncedHeight();
    console.log(`Last synced height: ${lastSynced}`);
    console.log(`Initial sync needed: ${syncNeeded}`);

    // Display initial balance
    let currentBalance = await client.getBalance();
    console.log(`Initial balance: ${(Number(currentBalance) / 1e8).toFixed(8)} NAV\n`);

    // Start background sync
    const startTime = Date.now();
    let blocksProcessed = 0;

    await client.startBackgroundSync({
      pollInterval,

      onProgress: (currentHeight, chainTip, blocks, txKeys) => {
        blocksProcessed = blocks;
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = blocks / elapsed;
        const progress = ((currentHeight / chainTip) * 100).toFixed(1);
        process.stdout.write(
          `\rSync: ${currentHeight}/${chainTip} (${progress}%) | ${txKeys} tx keys | ${rate.toFixed(1)} blk/s`
        );
      },

      onNewBlock: (height, hash) => {
        const shortHash = hash ? hash.substring(0, 16) + '...' : 'unknown';
        console.log(`\n📦 New block ${height}: ${shortHash}`);
      },

      onBalanceChange: (newBalance, oldBalance) => {
        const diff = Number(newBalance - oldBalance) / 1e8;
        const sign = diff > 0 ? '+' : '';
        console.log(`\n💰 Balance change: ${sign}${diff.toFixed(8)} NAV`);
        console.log(`   New balance: ${(Number(newBalance) / 1e8).toFixed(8)} NAV`);
        currentBalance = newBalance;
      },

      onError: (error) => {
        console.error(`\n❌ Sync error: ${error.message}`);
      },
    });

    console.log('✓ Background sync started');
    console.log(`  Polling every ${pollInterval / 1000} seconds`);
    console.log('  Press Ctrl+C to stop\n');

    // Display current state periodically
    const displayInterval = setInterval(async () => {
      if (!client?.isBackgroundSyncActive()) return;
      
      const balance = await client.getBalanceNav();
      const utxos = await client.getUnspentOutputs();
      const height = client.getLastSyncedHeight();
      
      console.log(`\n━━━ Status Update ━━━`);
      console.log(`  Height: ${height}`);
      console.log(`  Balance: ${balance.toFixed(8)} NAV`);
      console.log(`  UTXOs: ${utxos.length}`);
    }, 30000); // Every 30 seconds

    // Handle graceful shutdown
    const shutdown = async () => {
      console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('Shutting Down');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      clearInterval(displayInterval);

      if (client) {
        // Display final state
        const finalBalance = await client.getBalanceNav();
        const utxos = await client.getUnspentOutputs();
        console.log(`Final balance: ${finalBalance.toFixed(8)} NAV`);
        console.log(`Unspent outputs: ${utxos.length}`);
        
        for (const utxo of utxos.slice(0, 5)) {
          const amount = Number(utxo.amount) / 1e8;
          console.log(`  - ${utxo.outputHash.substring(0, 16)}...: ${amount.toFixed(8)} NAV`);
        }
        if (utxos.length > 5) {
          console.log(`  ... and ${utxos.length - 5} more`);
        }

        console.log('\nStopping background sync...');
        client.stopBackgroundSync();
        
        console.log('Disconnecting...');
        await client.disconnect();
        console.log('✓ Disconnected\n');
      }

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('Test completed successfully!');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep the process running
    await new Promise(() => {}); // Never resolves - wait for Ctrl+C

  } catch (error) {
    console.error('\n✗ Test Error:', error);
    if (error instanceof Error) {
      console.error('Stack:', error.stack);
    }
    if (client) {
      await client.disconnect();
    }
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
