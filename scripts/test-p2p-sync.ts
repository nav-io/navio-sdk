/**
 * Test script for P2P sync provider
 *
 * Tests direct P2P connection to a Navio full node.
 * Run with: npx tsx scripts/test-p2p-sync.ts [host] [port]
 */

import { P2PClient, NetworkMagic, DefaultPorts } from '../src/p2p-protocol';
import { P2PSyncProvider } from '../src/p2p-sync';

const host = process.argv[2] || 'localhost';
const port = parseInt(process.argv[3] || String(DefaultPorts.TESTNET), 10);

async function testP2PClient() {
  console.log('='.repeat(60));
  console.log('Testing P2P Protocol Client');
  console.log('='.repeat(60));
  console.log(`Connecting to ${host}:${port}...`);

  const client = new P2PClient({
    host,
    port,
    network: 'testnet',
    debug: true,
    timeout: 30000,
  });

  try {
    await client.connect();
    console.log('\n✓ Connected successfully!');
    console.log(`  Peer version: ${client.getPeerVersion()}`);
    console.log(`  Peer start height: ${client.getPeerStartHeight()}`);

    // Test getting headers
    console.log('\n--- Testing getHeaders ---');
    const genesisLocator = [Buffer.alloc(32)]; // Start from genesis
    const headers = await client.getHeaders(genesisLocator);
    console.log(`✓ Received ${headers.length} headers`);

    if (headers.length > 0) {
      const firstHeader = headers[0];
      const hash = P2PClient.hashToDisplay(
        Buffer.from(require('@noble/hashes/sha256').sha256(require('@noble/hashes/sha256').sha256(firstHeader))).reverse()
      );
      console.log(`  First header hash: ${hash.substring(0, 16)}...`);
    }

    // Disconnect
    client.disconnect();
    console.log('\n✓ Disconnected');

  } catch (error) {
    console.error('\n✗ Error:', error);
    client.disconnect();
    process.exit(1);
  }
}

async function testP2PSyncProvider() {
  console.log('\n' + '='.repeat(60));
  console.log('Testing P2P Sync Provider');
  console.log('='.repeat(60));
  console.log(`Connecting to ${host}:${port}...`);

  const provider = new P2PSyncProvider({
    host,
    port,
    network: 'testnet',
    debug: true,
    timeout: 30000,
  });

  try {
    await provider.connect();
    console.log('\n✓ Connected successfully!');

    // Get chain tip
    console.log('\n--- Chain Tip ---');
    const tipHeight = await provider.getChainTipHeight();
    console.log(`✓ Chain tip height: ${tipHeight}`);

    const tip = await provider.getChainTip();
    console.log(`  Hash: ${tip.hash.substring(0, 16)}...`);

    // Get a block header
    if (tipHeight > 0) {
      console.log('\n--- Block Header ---');
      const headerHex = await provider.getBlockHeader(0);
      console.log(`✓ Genesis header: ${headerHex.substring(0, 32)}...`);
    }

    // Try getting transaction keys for first few blocks
    console.log('\n--- Transaction Keys ---');
    try {
      const result = await provider.getBlockTransactionKeysRange(0);
      console.log(`✓ Got transaction keys for ${result.blocks.length} blocks`);
      console.log(`  Next height: ${result.nextHeight}`);

      for (const block of result.blocks.slice(0, 3)) {
        console.log(`  Block ${block.height}: ${block.txKeys.length} transactions`);
        // Show first tx key details if present
        for (const txKey of block.txKeys.slice(0, 1)) {
          console.log(`    Tx ${txKey.txHash.substring(0, 16)}...`);
          const outputs = (txKey.keys as any)?.outputs || [];
          console.log(`    ${outputs.length} outputs with BLSCT keys`);
          for (const out of outputs.slice(0, 2)) {
            console.log(`      - viewTag: ${out.viewTag}, spendingKey: ${out.spendingKey?.substring(0, 16)}...`);
          }
        }
      }
    } catch (e) {
      console.log(`⚠ Transaction key parsing not fully implemented yet: ${e}`);
    }

    // Disconnect
    provider.disconnect();
    console.log('\n✓ Disconnected');

  } catch (error) {
    console.error('\n✗ Error:', error);
    provider.disconnect();
    process.exit(1);
  }
}

async function main() {
  console.log('P2P Sync Test');
  console.log('='.repeat(60));
  console.log(`Target: ${host}:${port}`);
  console.log(`Network: testnet`);
  console.log(`Magic bytes: ${NetworkMagic.TESTNET.toString('hex')}`);
  console.log('');

  await testP2PClient();
  await testP2PSyncProvider();

  console.log('\n' + '='.repeat(60));
  console.log('All tests completed!');
  console.log('='.repeat(60));
}

main().catch(console.error);

