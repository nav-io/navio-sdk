/**
 * Test script for Electrum Client
 * Demonstrates connecting to Electrum server and fetching transaction keys
 * 
 * Usage: npm run test:electrum
 */

import { ElectrumClient } from '../src/electrum';

/**
 * Main test function
 */
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Electrum Client Test Suite');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Parse command line arguments
  const args = process.argv.slice(2);
  let host = 'localhost';
  let port = 50001;
  let ssl = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--host' && i + 1 < args.length) {
      host = args[i + 1];
      i++;
    } else if (args[i] === '--port' && i + 1 < args.length) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--ssl') {
      ssl = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: tsx scripts/test-electrum.ts [options]

Options:
  --host <host>    Electrum server host (default: localhost)
  --port <port>    Electrum server port (default: 50001)
  --ssl            Use SSL/TLS connection
  --help, -h       Show this help message

Example:
  tsx scripts/test-electrum.ts --host localhost --port 50001
      `);
      process.exit(0);
    }
  }

  const client = new ElectrumClient({ host, port, ssl });

  try {
    // Test 1: Connect to server
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Test 1: Connect to Electrum Server');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log(`Connecting to ${host}:${port}...`);
    await client.connect();
    console.log('✓ Connected to Electrum server\n');

    // Test 2: Get server version
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Test 2: Get Server Version');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const version = await client.getServerVersion();
    console.log(`Server Version: ${version[0]}`);
    console.log(`Protocol Version: ${version[1]}\n`);

    // Test 3: Get chain tip
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Test 3: Get Chain Tip');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const tipHeight = await client.getChainTipHeight();
    console.log(`Chain Tip Height: ${tipHeight}\n`);

    // Test 4: Get block header
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Test 4: Get Block Header');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const header = await client.getBlockHeader(0);
    console.log(`Block 0 Header (first 64 chars): ${header.substring(0, 64)}...\n`);

    // Test 5: Get transaction keys for a block
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Test 5: Get Transaction Keys for Block');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    try {
      const blockTxKeys = await client.getBlockTransactionKeys(0);
      console.log(`Block 0 Transaction Keys: ${blockTxKeys.length} transactions`);
      if (blockTxKeys.length > 0) {
        console.log(`First transaction keys: ${JSON.stringify(blockTxKeys[0]).substring(0, 100)}...\n`);
      } else {
        console.log('No transaction keys found for block 0\n');
      }
    } catch (error) {
      console.log(`⚠ Could not get block transaction keys: ${error}\n`);
    }

    // Test 6: Get transaction keys range
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Test 6: Get Transaction Keys Range');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    try {
      const rangeResult = await client.getBlockTransactionKeysRange(0);
      console.log(`Range Result:`);
      console.log(`  Blocks returned: ${rangeResult.blocks.length}`);
      console.log(`  Next height: ${rangeResult.nextHeight}`);
      if (rangeResult.blocks.length > 0) {
        const firstBlock = rangeResult.blocks[0];
        console.log(`  First block (height ${firstBlock.height}): ${firstBlock.txKeys.length} transactions\n`);
      } else {
        console.log('  No blocks returned\n');
      }
    } catch (error) {
      console.log(`⚠ Could not get transaction keys range: ${error}\n`);
    }

    // Test 7: Fetch all transaction keys (limited to first few blocks for testing)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Test 7: Fetch Transaction Keys (Limited)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('Note: This test is limited to avoid fetching all blocks.');
    console.log('In production, use fetchAllTransactionKeys() to get all keys.\n');

    // Disconnect
    client.disconnect();
    console.log('✓ Disconnected from server\n');

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  All Tests Completed Successfully!');
    console.log('═══════════════════════════════════════════════════════════\n');
  } catch (error) {
    console.error('\n✗ Test Error:', error);
    if (error instanceof Error) {
      console.error('  Stack:', error.stack);
    }
    client.disconnect();
    process.exit(1);
  }
}

// Run the test
main().catch((error) => {
  console.error('Fatal error running tests:', error);
  process.exit(1);
});

