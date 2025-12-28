/**
 * Test script for Transaction Keys Sync
 * Demonstrates syncing transaction keys from Electrum server
 *
 * Usage: npm run test:tx-keys-sync
 */

import { WalletDB } from '../src/wallet-db';
import { ElectrumClient } from '../src/electrum';
import { TransactionKeysSync } from '../src/tx-keys-sync';
import * as path from 'path';
import * as fs from 'fs';
const blsctModule = require('navio-blsct');
const Address = blsctModule.Address;
const AddressEncoding = blsctModule.AddressEncoding;
const DoublePublicKey = blsctModule.DoublePublicKey;
import { SubAddressIdentifier } from '../src/key-manager.types';

/**
 * Main test function
 */
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Transaction Keys Sync Test Suite');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Parse command line arguments
  const args = process.argv.slice(2);
  let host = 'testnet.nav.io';
  let port = 50005;
  let ssl = false;
  let reset = false;
  let limit = 0; // 0 = no limit

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--host' && i + 1 < args.length) {
      host = args[i + 1];
      i++;
    } else if (args[i] === '--port' && i + 1 < args.length) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--ssl') {
      ssl = true;
    } else if (args[i] === '--reset') {
      reset = true;
    } else if (args[i] === '--limit' && i + 1 < args.length) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: tsx scripts/test-tx-keys-sync.ts [options]

Options:
  --host <host>    Electrum server host (default: localhost)
  --port <port>    Electrum server port (default: 50001)
  --ssl            Use SSL/TLS connection
  --reset          Reset sync state before syncing
  --limit <n>      Limit sync to first N blocks (default: no limit)
  --help, -h       Show this help message

Example:
  tsx scripts/test-tx-keys-sync.ts --host localhost --port 50001 --limit 10
      `);
      process.exit(0);
    }
  }

  const dbPath = path.join(__dirname, '../test-wallet-sync.db');

  // Clean up test database if reset requested
  if (reset && fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    console.log('Cleaned up existing test database\n');
  }

  try {
    // Initialize wallet DB
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Initializing Wallet DB and Electrum Client');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const walletDB = new WalletDB(dbPath);

    // Create or load wallet
    let keyManager;
    if (!fs.existsSync(dbPath)) {
      keyManager = await walletDB.createWallet();
      console.log('✓ Created new wallet');
    } else {
      keyManager = await walletDB.loadWallet();
      console.log('✓ Loaded existing wallet');
    }

    const subAddressId: SubAddressIdentifier = { account: 0, address: 0 };
    const subAddress = keyManager?.getSubAddress(subAddressId);
    let dpk = DoublePublicKey.deserialize(subAddress.serialize());
    let address = Address.encode(dpk, AddressEncoding.Bech32M);
    console.log('address', address);

    // Initialize Electrum client
    const electrumClient = new ElectrumClient({ host, port, ssl });
    await electrumClient.connect();
    console.log(`✓ Connected to Electrum server at ${host}:${port}\n`);

    // Initialize sync manager
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Initializing Sync Manager');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const syncManager = new TransactionKeysSync(walletDB, electrumClient);

    // Set KeyManager for output detection
    if (keyManager) {
      syncManager.setKeyManager(keyManager);
    }

    await syncManager.initialize();

    const syncState = syncManager.getSyncState();
    if (syncState) {
      console.log('Current Sync State:');
      console.log(`  Last Synced Height: ${syncState.lastSyncedHeight}`);
      console.log(`  Last Synced Hash: ${syncState.lastSyncedHash.substring(0, 16)}...`);
      console.log(`  Total TX Keys Synced: ${syncState.totalTxKeysSynced}`);
      console.log(`  Last Sync Time: ${new Date(syncState.lastSyncTime).toISOString()}\n`);
    } else {
      console.log('No sync state found - will start from genesis\n');
    }

    // Reset if requested
    if (reset) {
      console.log('Resetting sync state...');
      await syncManager.resetSyncState();
      console.log('✓ Sync state reset\n');
    }

    // Check if sync is needed
    const syncNeeded = await syncManager.isSyncNeeded();
    if (!syncNeeded) {
      console.log('✓ Wallet is already synced to chain tip\n');
    } else {
      // Get chain tip
      const chainTip = await electrumClient.getChainTipHeight();
      console.log(`Chain Tip: ${chainTip}`);
      console.log(`Last Synced: ${syncManager.getLastSyncedHeight()}\n`);

      // Start syncing
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('Starting Sync');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      const startTime = Date.now();
      let lastProgressTime = startTime;

      const txKeysSynced = await syncManager.sync({
        endHeight: limit > 0 ? Math.min(limit - 1, chainTip) : chainTip,
        saveInterval: 10, // Save every 10 blocks for testing
        onProgress: (currentHeight, chainTip, blocksProcessed, txKeysProcessed, isReorg) => {
          const now = Date.now();
          const elapsed = (now - lastProgressTime) / 1000;

          if (elapsed >= 1 || currentHeight % 10 === 0) {
            const progress = ((currentHeight / chainTip) * 100).toFixed(1);
            console.log(
              `Progress: ${currentHeight}/${chainTip} (${progress}%) | ` +
                `Blocks: ${blocksProcessed} | TX Keys: ${txKeysProcessed}${isReorg ? ' [REORG]' : ''}`
            );
            lastProgressTime = now;
          }
        },
        stopOnReorg: true,
        verifyHashes: true,
      });

      const totalTime = (Date.now() - startTime) / 1000;
      console.log(`\n✓ Sync completed!`);
      console.log(`  Transaction Keys Synced: ${txKeysSynced}`);
      console.log(`  Time Elapsed: ${totalTime.toFixed(1)}s`);
      console.log(`  Rate: ${(txKeysSynced / totalTime).toFixed(1)} keys/sec\n`);

      // Show final sync state
      const finalState = syncManager.getSyncState();
      if (finalState) {
        console.log('Final Sync State:');
        console.log(`  Last Synced Height: ${finalState.lastSyncedHeight}`);
        console.log(`  Total TX Keys Synced: ${finalState.totalTxKeysSynced}\n`);
      }

      // Test retrieving transaction keys
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('Testing Transaction Key Retrieval');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      const blockKeys = await syncManager.getBlockTransactionKeys(0);
      console.log(`Block 0 Transaction Keys: ${blockKeys.length}`);
      if (blockKeys.length > 0) {
        console.log(`First TX Hash: ${blockKeys[0].txHash.substring(0, 16)}...`);
        console.log(`Keys Data: ${JSON.stringify(blockKeys[0].keys).substring(0, 100)}...\n`);
      }
    }

    // Cleanup
    electrumClient.disconnect();
    walletDB.close();

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  All Tests Completed Successfully!');
    console.log('═══════════════════════════════════════════════════════════\n');
  } catch (error) {
    console.error('\n✗ Test Error:', error);
    if (error instanceof Error) {
      console.error('  Stack:', error.stack);
    }
    process.exit(1);
  }
}

// Run the test
main().catch(error => {
  console.error('Fatal error running tests:', error);
  process.exit(1);
});
