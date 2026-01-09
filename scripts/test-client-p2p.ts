#!/usr/bin/env tsx
/**
 * Test NavioClient with P2P backend and background sync
 * Demonstrates continuous synchronization with the blockchain
 */

import { NavioClient, getChain, BlsctChain } from '../src/index';
import { Address, AddressEncoding, DoublePublicKey } from 'navio-blsct';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  NavioClient Test (P2P Backend)');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Parse command line arguments
  const args = process.argv.slice(2);
  let host = 'localhost';
  let port = 33670;
  let dbPath = path.join(__dirname, '../test-client-p2p-wallet.db');
  let createWallet = true;
  let restoreSeed: string | undefined;
  let restoreFromHeight: number | undefined;
  let creationHeight: number | undefined;
  let cleanDb = false;
  let debug = false;
  let pollInterval = 10000; // Default 10 seconds

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--host':
        host = args[++i];
        break;
      case '--port':
        port = parseInt(args[++i], 10);
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
      case '--restore-height':
        restoreFromHeight = parseInt(args[++i], 10);
        break;
      case '--from-height':
        creationHeight = parseInt(args[++i], 10);
        break;
      case '--clean':
        cleanDb = true;
        break;
      case '--debug':
        debug = true;
        break;
      case '--poll':
        pollInterval = parseInt(args[++i], 10) * 1000;
        break;
      case '--help':
      case '-h':
        console.log(`
Usage: tsx scripts/test-client-p2p.ts [options]

Options:
  --host <host>           P2P node host (default: localhost)
  --port <port>           P2P node port (default: 33670)
  --db <path>             Wallet database path (default: test-client-p2p-wallet.db)
  --create                Create new wallet if it doesn't exist
  --restore <seed>        Restore wallet from seed (hex string)
  --restore-height <n>    Block height when wallet was created (used with --restore)
  --from-height <n>       Start syncing from height n (for new wallets)
  --clean                 Delete existing wallet DB before starting
  --debug                 Enable debug logging
  --poll <seconds>        Background sync poll interval (default: 10)
  --help, -h              Show this help message

Examples:
  tsx scripts/test-client-p2p.ts --host localhost --port 33670 --create
  tsx scripts/test-client-p2p.ts --clean --from-height 0  # Full sync from genesis
  tsx scripts/test-client-p2p.ts --restore <seed> --restore-height 50000
        `);
        process.exit(0);
    }
  }

  // Clean up existing DB if requested
  if (cleanDb && fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    console.log(`Deleted existing wallet: ${dbPath}\n`);
  }

  let client: NavioClient | null = null;

  try {
    // Create client
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Creating NavioClient (P2P Backend)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    client = new NavioClient({
      walletDbPath: dbPath,
      backend: 'p2p',
      network: 'testnet',
      p2p: {
        host,
        port,
        network: 'testnet',
        debug,
      },
      createWalletIfNotExists: createWallet,
      restoreFromSeed: restoreSeed,
      creationHeight: restoreSeed ? undefined : creationHeight,
      restoreFromHeight: restoreSeed ? (restoreFromHeight ?? creationHeight) : undefined,
    });

    console.log(`Wallet DB: ${dbPath}`);
    console.log(`P2P Node: ${host}:${port}`);
    console.log(`Poll interval: ${pollInterval / 1000}s`);
    if (creationHeight !== undefined) {
      console.log(`Creation height: ${creationHeight}`);
    }
    if (restoreSeed) {
      console.log(`Restoring from seed: ${restoreSeed.substring(0, 16)}...`);
      if (restoreFromHeight !== undefined) {
        console.log(`Restore from height: ${restoreFromHeight}`);
      }
    }
    console.log('');

    // Initialize client
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Initializing Client');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await client.initialize();
    console.log('✓ Client initialized');
    console.log(`  Backend: ${client.getBackendType()}`);
    console.log(`  Network: ${client.getNetwork()}`);
    console.log(`  Connected: ${client.isConnected()}`);

    // Verify navio-blsct is configured for testnet
    const currentChain = getChain();
    if (currentChain !== BlsctChain.Testnet) {
      throw new Error(`Expected BlsctChain.Testnet, got ${currentChain}`);
    }
    console.log('  navio-blsct: testnet\n');

    // Get KeyManager and show wallet info
    const keyManager = client.getKeyManager();
    const subAddress = keyManager.getSubAddress({ account: 0, address: 0 });

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Wallet Information');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Show wallet seed
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

    // Get wallet metadata
    const metadata = await client.getWalletMetadata();
    if (metadata) {
      console.log(`Creation height: ${metadata.creationHeight}`);
      console.log(`Creation time: ${new Date(metadata.creationTime).toLocaleString()}`);
      console.log(`Restored from seed: ${metadata.restoredFromSeed}`);
    }

    // Get chain tip
    const tip = await client.getChainTip();
    console.log(`Chain tip: ${tip.height}\n`);

    // Show initial sync status
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Starting Background Sync');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const syncNeeded = await client.isSyncNeeded();
    const lastSynced = client.getLastSyncedHeight();
    const walletCreationHeight = metadata?.creationHeight ?? 0;

    console.log(`Last synced height: ${lastSynced}`);
    console.log(`Wallet creation height: ${walletCreationHeight}`);
    console.log(`Initial sync needed: ${syncNeeded}`);
    console.log(`Blocks to sync: ${tip.height - Math.max(lastSynced, walletCreationHeight - 1)}`);

    // Display initial balance
    let currentBalance = await client.getBalance();
    console.log(`Initial balance: ${(Number(currentBalance) / 1e8).toFixed(8)} NAV\n`);

    // Start background sync
    const startTime = Date.now();

    await client.startBackgroundSync({
      pollInterval,

      onProgress: (currentHeight, chainTip, blocks, txKeys) => {
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
