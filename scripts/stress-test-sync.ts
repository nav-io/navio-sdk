#!/usr/bin/env tsx
/**
 * Stress Test Script for Transaction Keys Sync
 * 
 * Tests the sync functionality by feeding large amounts of random transaction keys
 * with outputs to verify:
 * - Output detection performance
 * - Database write performance
 * - Memory usage
 * - Error handling
 */

import { WalletDB } from '../src/wallet-db';
import { TransactionKeysSync } from '../src/tx-keys-sync';
import { ElectrumClient } from '../src/electrum';
import { KeyManager } from '../src/key-manager';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

const blsctModule = require('navio-blsct');
const { PublicKey, Scalar } = blsctModule;

/**
 * Generate random bytes
 */
function randomBytes(length: number): Uint8Array {
  return crypto.randomBytes(length);
}

/**
 * Generate random hex string
 */
function randomHex(length: number): string {
  return crypto.randomBytes(length / 2).toString('hex');
}

/**
 * Generate a random transaction key structure with outputs
 */
function generateRandomTxKeys(txHash: string, numOutputs: number): any {
  const outputs: any[] = [];
  
  for (let i = 0; i < numOutputs; i++) {
    // Generate random keys (these won't match the wallet, but test the processing)
    // BLS public keys are 48 bytes, serialize to hex strings
    const viewTag = Math.floor(Math.random() * 65536); // 16-bit
    const outputHash = randomHex(64);
    
    // Convert to hex strings (PublicKey.deserialize expects hex strings or Uint8Array)
    const blindingKey = PublicKey.random().serialize();
    const spendingKey = PublicKey.random().serialize();
    
    outputs.push({
      blindingKey,
      spendingKey,
      viewTag,
      outputHash,
      outputIndex: i,
    });
  }
  
  return {
    outputs,
    inputs: [], // Empty inputs for this test
  };
}

/**
 * Generate transaction keys that might match the wallet
 */
function generateMatchingTxKeys(
  txHash: string,
  numOutputs: number,
  keyManager: KeyManager,
  matchProbability: number = 0.1
): any {
  const outputs: any[] = [];
  
  for (let i = 0; i < numOutputs; i++) {
    const shouldMatch = Math.random() < matchProbability;
    
    if (shouldMatch) {
      // Generate a sub-address that belongs to the wallet
      const account = Math.floor(Math.random() * 3); // 0-2
      const address = Math.floor(Math.random() * 10); // 0-9
      
      try {
        const subAddress = keyManager.getSubAddress({ account, address });
        
        // Extract keys from sub-address
        // SubAddr has methods to get blinding and spending keys
        const subAddrBytes = subAddress.serialize();
        const { DoublePublicKey } = blsctModule;
        const dpk = DoublePublicKey.deserialize(subAddrBytes);
        
        // Get view key to calculate view tag
        const viewKey = keyManager.getPrivateViewKey();
        const blindingKey = dpk.getBlindingKey();
        const spendingKey = dpk.getSpendingKey();
        
        // Calculate view tag
        const viewTag = keyManager.calculateViewTag(blindingKey);
        const outputHash = randomHex(64);
        
        outputs.push({
          blindingKey,
          spendingKey,
          viewTag,
          outputHash,
          outputIndex: i,
        });
      } catch (error) {
        // If we can't generate a matching output, generate a random one
        outputs.push(...generateRandomTxKeys(txHash, 1).outputs);
      }
    } else {
      // Generate random output
      outputs.push(...generateRandomTxKeys(txHash, 1).outputs);
    }
  }
  
  return {
    outputs,
    inputs: [],
  };
}

/**
 * Mock ElectrumClient for stress testing
 */
class MockElectrumClient extends ElectrumClient {
  private mockOutputs: Map<string, string> = new Map();
  
  constructor() {
    super({ host: 'localhost', port: 50001 });
  }
  
  async connect(): Promise<void> {
    // Mock connection - always succeeds
    (this as any).connected = true;
  }
  
  async disconnect(): Promise<void> {
    (this as any).connected = false;
  }
  
  async getChainTipHeight(): Promise<number> {
    return 1000000; // Mock chain tip
  }
  
  async getBlockHeader(height: number): Promise<string> {
    // Return mock block header (80 bytes = 160 hex chars)
    return randomHex(160);
  }
  
  async getBlockHeaders(startHeight: number, count: number): Promise<{ count: number; hex: string; max: number }> {
    // Return mock headers
    const hex = randomHex(160 * count);
    return { count, hex, max: 1000 };
  }
  
  async getTransactionOutput(outputHash: string): Promise<string> {
    // Return cached mock output or generate new one
    if (!this.mockOutputs.has(outputHash)) {
      // Generate mock serialized output (simplified)
      const mockOutput = randomHex(200); // Mock output data
      this.mockOutputs.set(outputHash, mockOutput);
    }
    return this.mockOutputs.get(outputHash)!;
  }
  
  setMockOutput(outputHash: string, outputData: string): void {
    this.mockOutputs.set(outputHash, outputData);
  }
}

/**
 * Main stress test function
 */
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Transaction Keys Sync Stress Test');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Parse arguments
  const args = process.argv.slice(2);
  let numTransactions = 1000;
  let numOutputsPerTx = 5;
  let matchProbability = 0.1;
  let batchSize = 100;
  let dbPath = path.join(__dirname, '../test-stress-sync.db');

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--transactions':
      case '-t':
        numTransactions = parseInt(args[++i], 10);
        break;
      case '--outputs':
      case '-o':
        numOutputsPerTx = parseInt(args[++i], 10);
        break;
      case '--match-prob':
      case '-m':
        matchProbability = parseFloat(args[++i]);
        break;
      case '--batch':
      case '-b':
        batchSize = parseInt(args[++i], 10);
        break;
      case '--db':
        dbPath = args[++i];
        break;
      case '--help':
      case '-h':
        console.log(`
Usage: tsx scripts/stress-test-sync.ts [options]

Options:
  -t, --transactions <n>   Number of transactions to generate (default: 1000)
  -o, --outputs <n>        Outputs per transaction (default: 5)
  -m, --match-prob <p>     Probability of matching outputs (0-1, default: 0.1)
  -b, --batch <n>          Batch size for processing (default: 100)
  --db <path>              Database path (default: test-stress-sync.db)
  -h, --help               Show this help

Example:
  tsx scripts/stress-test-sync.ts -t 5000 -o 10 -m 0.2 -b 200
        `);
        process.exit(0);
    }
  }

  // Clean up old database
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    console.log('Cleaned up existing test database\n');
  }

  try {
    // Initialize wallet
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Initializing Wallet');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const walletDB = new WalletDB(dbPath);
    const keyManager = await walletDB.createWallet();
    console.log('✓ Wallet created\n');

    // Initialize mock Electrum client
    const mockElectrum = new MockElectrumClient();
    await mockElectrum.connect();
    console.log('✓ Mock Electrum client connected\n');

    // Initialize sync manager
    const syncManager = new TransactionKeysSync(walletDB, mockElectrum);
    syncManager.setKeyManager(keyManager);
    await syncManager.initialize();
    console.log('✓ Sync manager initialized\n');

    // Generate test data
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Generating Test Data');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`Transactions: ${numTransactions.toLocaleString()}`);
    console.log(`Outputs per transaction: ${numOutputsPerTx}`);
    console.log(`Match probability: ${(matchProbability * 100).toFixed(1)}%`);
    console.log(`Total outputs: ${(numTransactions * numOutputsPerTx).toLocaleString()}\n`);

    const testBlocks: Array<{ height: number; txKeys: Array<{ txHash: string; keys: any }> }> = [];
    let totalOutputs = 0;

    for (let blockHeight = 0; blockHeight < numTransactions; blockHeight++) {
      const txKeys: Array<{ txHash: string; keys: any }> = [];
      
      // Generate 1-3 transactions per block
      const txsPerBlock = Math.floor(Math.random() * 3) + 1;
      
      for (let txIdx = 0; txIdx < txsPerBlock; txIdx++) {
        const txHash = randomHex(64);
        const keys = generateMatchingTxKeys(txHash, numOutputsPerTx, keyManager, matchProbability);
        txKeys.push({ txHash, keys });
        totalOutputs += numOutputsPerTx;
      }
      
      testBlocks.push({
        height: blockHeight,
        txKeys,
      });
    }

    console.log(`Generated ${testBlocks.length} blocks with ${totalOutputs.toLocaleString()} total outputs\n`);

    // Stress test processing
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Running Stress Test');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const startTime = Date.now();
    const startMemory = process.memoryUsage();
    let processedBlocks = 0;
    let processedOutputs = 0;
    let matchedOutputs = 0;
    let errors = 0;

    // Process in batches
    for (let i = 0; i < testBlocks.length; i += batchSize) {
      const batch = testBlocks.slice(i, i + batchSize);
      
      for (const block of batch) {
        try {
          // Process each transaction in the block
            for (const txKey of block.txKeys) {
              // Access private method through type assertion (for testing only)
                // The keys structure should be: [txHash, { outputs: [...] }]
              const processTxKeys = (syncManager as any).processTransactionKeys.bind(syncManager);
              await processTxKeys(
                txKey.txHash,
                [txKey.txHash, txKey.keys], // Match expected structure: keys[1]?.outputs
                block.height,
                randomHex(64) // blockHash
              );
              
              processedOutputs += txKey.keys.outputs?.length || 0;
              
              // Count matching outputs (would be stored in wallet_outputs)
              for (const output of txKey.keys.outputs || []) {
                try {
                  const { PublicKey } = require('navio-blsct');
                  // Keys are hex strings, deserialize them
                  const blindingKeyObj = PublicKey.deserialize(Buffer.from(output.blindingKey, 'hex'));
                  const spendingKeyObj = PublicKey.deserialize(Buffer.from(output.spendingKey, 'hex'));
                  const isMine = keyManager.isMineByKeys(blindingKeyObj, spendingKeyObj, output.viewTag);
                  if (isMine) {
                    matchedOutputs++;
                  }
                } catch (error) {
                  // Skip invalid keys
                }
              }
            }
          
          processedBlocks++;
        } catch (error) {
          errors++;
          console.error(`Error processing block ${block.height}:`, error);
        }
      }

      // Progress update
      if ((i + batchSize) % (batchSize * 10) === 0 || i + batchSize >= testBlocks.length) {
        const progress = ((i + batchSize) / testBlocks.length * 100).toFixed(1);
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = processedBlocks / elapsed;
        console.log(
          `Progress: ${progress}% | Blocks: ${processedBlocks.toLocaleString()} | ` +
          `Outputs: ${processedOutputs.toLocaleString()} | Rate: ${rate.toFixed(1)} blocks/s`
        );
      }
    }

    const endTime = Date.now();
    const endMemory = process.memoryUsage();
    const elapsed = (endTime - startTime) / 1000;

    // Check database state
    const db = walletDB.getDatabase();
    const walletOutputsResult = db.exec('SELECT COUNT(*) FROM wallet_outputs');
    const walletOutputsCount = walletOutputsResult.length > 0 && walletOutputsResult[0].values.length > 0
      ? walletOutputsResult[0].values[0][0] as number
      : 0;

    // Results
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Stress Test Results');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log(`Total blocks processed: ${processedBlocks.toLocaleString()}`);
    console.log(`Total outputs processed: ${processedOutputs.toLocaleString()}`);
    console.log(`Matched outputs: ${matchedOutputs.toLocaleString()}`);
    console.log(`Wallet outputs stored: ${walletOutputsCount.toLocaleString()}`);
    console.log(`Errors: ${errors}`);
    console.log(`\nPerformance:`);
    console.log(`  Total time: ${elapsed.toFixed(2)}s`);
    console.log(`  Blocks per second: ${(processedBlocks / elapsed).toFixed(2)}`);
    console.log(`  Outputs per second: ${(processedOutputs / elapsed).toFixed(2)}`);
    console.log(`  Time per block: ${(elapsed / processedBlocks * 1000).toFixed(2)}ms`);
    console.log(`  Time per output: ${(elapsed / processedOutputs * 1000).toFixed(3)}ms`);

    console.log(`\nMemory usage:`);
    const memoryDelta = {
      heapUsed: (endMemory.heapUsed - startMemory.heapUsed) / 1024 / 1024,
      heapTotal: (endMemory.heapTotal - startMemory.heapTotal) / 1024 / 1024,
      external: (endMemory.external - startMemory.external) / 1024 / 1024,
    };
    console.log(`  Heap used: ${memoryDelta.heapUsed.toFixed(2)} MB`);
    console.log(`  Heap total: ${memoryDelta.heapTotal.toFixed(2)} MB`);
    console.log(`  External: ${memoryDelta.external.toFixed(2)} MB`);
    console.log(`  Current heap used: ${(endMemory.heapUsed / 1024 / 1024).toFixed(2)} MB`);

    // Database size
    if (fs.existsSync(dbPath)) {
      const dbStats = fs.statSync(dbPath);
      console.log(`\nDatabase size: ${(dbStats.size / 1024 / 1024).toFixed(2)} MB`);
    }

    // Cleanup
    await walletDB.close();
    await mockElectrum.disconnect();

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Stress test completed');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (errors > 0) {
      console.warn(`⚠️  ${errors} errors occurred during processing`);
      process.exit(1);
    }
  } catch (error) {
    console.error('\n✗ Stress test error:', error);
    if (error instanceof Error) {
      console.error('Stack:', error.stack);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

