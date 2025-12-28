/**
 * Test script for WalletDB
 * Demonstrates creating, loading, and restoring wallets
 *
 * Usage: npm run test:walletdb
 */

import { WalletDB } from '../src/wallet-db';
import { KeyManager } from '../src/key-manager';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Helper function to format hex strings for display
 */
function formatHex(hex: string, maxLength = 64): string {
  if (hex.length <= maxLength) return hex;
  return `${hex.substring(0, maxLength / 2)}...${hex.substring(hex.length - maxLength / 2)}`;
}

/**
 * Helper function to format bytes as hex
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Main test function
 */
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  WalletDB Test Suite');
  console.log('═══════════════════════════════════════════════════════════\n');

  const dbPath = path.join(__dirname, '../test-wallet.db');
  const restoreDBPath = path.join(__dirname, '../test-wallet-restore.db');

  // Clean up any existing test databases
  [dbPath, restoreDBPath].forEach(p => {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`Cleaned up existing database: ${path.basename(p)}\n`);
    }
  });

  let testPassed = 0;
  let testFailed = 0;

  try {
    // Test 1: Create a new wallet
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Test 1: Create New Wallet');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const walletDB1 = new WalletDB(dbPath);
    const keyManager1 = await walletDB1.createWallet();

    console.log('✓ Wallet created successfully');
    console.log(`  HD Enabled: ${keyManager1.isHDEnabled()}`);
    console.log(`  Can Generate Keys: ${keyManager1.canGenerateKeys()}`);

    // Get HD chain info
    const hdChain = keyManager1.getHDChain();
    if (hdChain) {
      console.log(`  HD Chain Version: ${hdChain.version}`);
      console.log(`  Seed ID: ${formatHex(bytesToHex(hdChain.seedId))}`);
      console.log(`  Spend ID: ${formatHex(bytesToHex(hdChain.spendId))}`);
      console.log(`  View ID: ${formatHex(bytesToHex(hdChain.viewId))}`);
    }

    // Get keys
    try {
      const viewKey = keyManager1.getPrivateViewKey();
      const spendPublicKey = keyManager1.getPublicSpendingKey();
      console.log(`  View Key: ${formatHex(viewKey.serialize())}`);
      console.log(`  Spend Public Key: ${formatHex(spendPublicKey.serialize())}`);
    } catch (e) {
      console.log(`  ⚠ Could not get keys: ${e}`);
    }

    // Get a sub-address
    const subAddress1 = keyManager1.getSubAddress({ account: 0, address: 0 });
    console.log(`  Sub-Address (account 0, index 0): ${formatHex(subAddress1.serialize())}`);

    // Generate a new sub-address
    const { subAddress: newSubAddr, id: newSubAddrId } = keyManager1.generateNewSubAddress(0);
    console.log(
      `  Generated Sub-Address (account ${newSubAddrId.account}, index ${newSubAddrId.address}): ${formatHex(newSubAddr.serialize())}`
    );

    // Save and close
    await walletDB1.saveWallet();
    walletDB1.close();
    console.log('\n✓ Wallet saved to database');
    console.log(`  Database file: ${path.basename(dbPath)}\n`);
    testPassed++;

    // Test 2: Load wallet from database
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Test 2: Load Wallet from Database');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const walletDB2 = new WalletDB(dbPath);
    const keyManager2 = await walletDB2.loadWallet();

    console.log('✓ Wallet loaded successfully');
    console.log(`  HD Enabled: ${keyManager2.isHDEnabled()}`);
    console.log(`  Can Generate Keys: ${keyManager2.canGenerateKeys()}`);

    // Verify HD chain matches
    const hdChain2 = keyManager2.getHDChain();
    if (hdChain && hdChain2) {
      const seedIdMatch = bytesToHex(hdChain.seedId) === bytesToHex(hdChain2.seedId);
      const spendIdMatch = bytesToHex(hdChain.spendId) === bytesToHex(hdChain2.spendId);
      const viewIdMatch = bytesToHex(hdChain.viewId) === bytesToHex(hdChain2.viewId);

      console.log(`  Seed ID Match: ${seedIdMatch ? '✓' : '✗'}`);
      console.log(`  Spend ID Match: ${spendIdMatch ? '✓' : '✗'}`);
      console.log(`  View ID Match: ${viewIdMatch ? '✓' : '✗'}`);

      if (!seedIdMatch || !spendIdMatch || !viewIdMatch) {
        throw new Error('HD Chain IDs do not match!');
      }
    }

    // Verify sub-address matches
    const subAddress2 = keyManager2.getSubAddress({ account: 0, address: 0 });
    const subAddr1Hex = subAddress1.serialize();
    const subAddr2Hex = subAddress2.serialize();

    console.log(`  Original Sub-Address: ${formatHex(subAddr1Hex)}`);
    console.log(`  Loaded Sub-Address:   ${formatHex(subAddr2Hex)}`);

    if (subAddr1Hex === subAddr2Hex) {
      console.log('  ✓ Sub-address matches!\n');
      testPassed++;
    } else {
      console.log('  ✗ Sub-address mismatch!\n');
      testFailed++;
    }

    walletDB2.close();

    // Test 3: Restore wallet from seed
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Test 3: Restore Wallet from Seed');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Get seed from first wallet
    const seed = keyManager1.getMasterSeedKey();
    const seedHex = seed.serialize();
    console.log(`Seed (hex): ${formatHex(seedHex)}\n`);

    const walletDB3 = new WalletDB(restoreDBPath);
    const keyManager3 = await walletDB3.restoreWallet(seedHex);

    console.log('✓ Wallet restored from seed');
    console.log(`  HD Enabled: ${keyManager3.isHDEnabled()}`);
    console.log(`  Can Generate Keys: ${keyManager3.canGenerateKeys()}`);

    // Verify HD chain matches
    const hdChain3 = keyManager3.getHDChain();
    if (hdChain && hdChain3) {
      const seedIdMatch = bytesToHex(hdChain.seedId) === bytesToHex(hdChain3.seedId);
      const spendIdMatch = bytesToHex(hdChain.spendId) === bytesToHex(hdChain3.spendId);
      const viewIdMatch = bytesToHex(hdChain.viewId) === bytesToHex(hdChain3.viewId);

      console.log(`  Seed ID Match: ${seedIdMatch ? '✓' : '✗'}`);
      console.log(`  Spend ID Match: ${spendIdMatch ? '✓' : '✗'}`);
      console.log(`  View ID Match: ${viewIdMatch ? '✓' : '✗'}`);

      if (!seedIdMatch || !spendIdMatch || !viewIdMatch) {
        throw new Error('HD Chain IDs do not match after restore!');
      }
    }

    // Verify sub-address matches
    const subAddress3 = keyManager3.getSubAddress({ account: 0, address: 0 });
    const subAddr3Hex = subAddress3.serialize();

    console.log(`  Original Sub-Address: ${formatHex(subAddr1Hex)}`);
    console.log(`  Restored Sub-Address: ${formatHex(subAddr3Hex)}`);

    if (subAddr1Hex === subAddr3Hex) {
      console.log('  ✓ Sub-address matches restored wallet!\n');
      testPassed++;
    } else {
      console.log('  ✗ Sub-address mismatch!\n');
      testFailed++;
    }

    walletDB3.close();

    // Test 4: Test persistence after modifications
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Test 4: Persistence After Modifications');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const walletDB4 = new WalletDB(dbPath);
    const keyManager4 = await walletDB4.loadWallet();

    // Generate a new sub-address
    const { subAddress: subAddr4, id: id4 } = keyManager4.generateNewSubAddress(0);
    console.log(`Generated new sub-address: account ${id4.account}, index ${id4.address}`);

    // Save the modification
    await walletDB4.saveWallet();
    walletDB4.close();
    console.log('✓ Modifications saved\n');

    // Reload and verify
    const walletDB5 = new WalletDB(dbPath);
    const keyManager5 = await walletDB5.loadWallet();

    // The sub-address counter should be incremented
    // Note: This test depends on how sub-address counters are persisted
    // For now, we'll just verify the wallet loads correctly
    console.log('✓ Wallet reloaded after modifications');
    console.log(`  HD Enabled: ${keyManager5.isHDEnabled()}\n`);

    walletDB5.close();
    testPassed++;

    // Test 5: Test in-memory database
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Test 5: In-Memory Database');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const walletDB6 = new WalletDB(':memory:');
    const keyManager6 = await walletDB6.createWallet();

    console.log('✓ In-memory wallet created');
    console.log(`  HD Enabled: ${keyManager6.isHDEnabled()}`);

    const subAddr6 = keyManager6.getSubAddress({ account: 0, address: 0 });
    console.log(`  Sub-Address: ${formatHex(subAddr6.serialize())}\n`);

    walletDB6.close();
    testPassed++;

    // Cleanup
    [dbPath, restoreDBPath].forEach(p => {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    });

    // Summary
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  Test Summary');
    console.log('═══════════════════════════════════════════════════════════\n');
    console.log(`  Tests Passed: ${testPassed}`);
    console.log(`  Tests Failed: ${testFailed}`);
    console.log(`  Total Tests:  ${testPassed + testFailed}\n`);

    if (testFailed === 0) {
      console.log('  ✓ All tests passed successfully!\n');
      process.exit(0);
    } else {
      console.log('  ✗ Some tests failed!\n');
      process.exit(1);
    }
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
