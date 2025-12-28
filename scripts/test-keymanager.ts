#!/usr/bin/env node
/**
 * Test script to create a KeyManager from a random seed
 * and print the subaddress of account 0, index 0
 */

import { randomBytes } from 'crypto';
import { KeyManager } from '../src/key-manager';
import type { SubAddress, SubAddressIdentifier } from '../src/key-manager.types';
const blsctModule = require('navio-blsct');
const DoublePublicKey = blsctModule.DoublePublicKey;
const Address = blsctModule.Address;
const AddressEncoding = blsctModule.AddressEncoding;
const Scalar = blsctModule.Scalar;
const SecretKey = blsctModule.SecretKey;
const PublicKey = blsctModule.PublicKey;

// Mock implementation of navio-blsct for testing
// In production, this would be: import * as blsct from 'navio-blsct';
const mockBlsct = {
  // Key generation
  genRandomSeed: (): typeof SecretKey => {
    // Generate 32 random bytes for seed
    const seed = randomBytes(32);
    return seed as unknown as typeof SecretKey;
  },

  deriveMasterSK: (seed: Uint8Array): typeof SecretKey => {
    // Simplified - in real implementation would use BLS12_381_KeyGen::derive_master_SK
    return seed as unknown as typeof SecretKey;
  },

  deriveChildSK: (parentSK: typeof SecretKey, index: number): typeof SecretKey => {
    // Simplified - in real implementation would use BLS12_381_KeyGen::derive_child_SK
    const parentBytes = parentSK as unknown as Uint8Array;
    const indexBytes = new Uint8Array(4);
    new DataView(indexBytes.buffer).setUint32(0, index, true);
    const combined = new Uint8Array(parentBytes.length + indexBytes.length);
    combined.set(parentBytes);
    combined.set(indexBytes, parentBytes.length);
    return combined as unknown as typeof SecretKey;
  },

  // Key conversion
  secretKeyToPublicKey: (secretKey: typeof SecretKey): typeof PublicKey => {
    // Simplified - in real implementation would compute public key from secret key
    const secretBytes = secretKey as unknown as Uint8Array;
    // For mock, just return a 48-byte array (BLS G1 public key size)
    return new Uint8Array(48).fill(0).map((_, i) => secretBytes[i % secretBytes.length]) as unknown as typeof PublicKey;
  },

  secretKeyToBytes: (secretKey: typeof SecretKey): Uint8Array => {
    return secretKey.serialize();
  },

  publicKeyToBytes: (publicKey: typeof PublicKey): Uint8Array => {
    return publicKey.serialize();
  },

  bytesToSecretKey: (bytes: Uint8Array): typeof SecretKey => {
    return Scalar.deserialize(bytes);
  },

  bytesToPublicKey: (bytes: Uint8Array): typeof PublicKey => {
    return PublicKey.deserialize(bytes);
  },

  // Key derivation helpers
  fromSeedToChildKey: (seed: typeof SecretKey): typeof SecretKey => {
    // Replicates FromSeedToChildKey: derive_child_SK(seed, 130)
    return mockBlsct.deriveChildSK(seed, 130);
  },

  fromChildToTransactionKey: (childKey: typeof SecretKey): typeof SecretKey => {
    // Replicates FromChildToTransactionKey: derive_child_SK(childKey, 0)
    return mockBlsct.deriveChildSK(childKey, 0);
  },

  fromChildToBlindingKey: (childKey: typeof SecretKey): typeof SecretKey => {
    // Replicates FromChildToBlindingKey: derive_child_SK(childKey, 1)
    return mockBlsct.deriveChildSK(childKey, 1);
  },

  fromChildToTokenKey: (childKey: typeof SecretKey): typeof SecretKey => {
    // Replicates FromChildToTokenKey: derive_child_SK(childKey, 2)
    return mockBlsct.deriveChildSK(childKey, 2);
  },

  fromTransactionToViewKey: (txKey: typeof SecretKey): typeof SecretKey => {
    // Replicates FromTransactionToViewKey: derive_child_SK(txKey, 0)
    return mockBlsct.deriveChildSK(txKey, 0);
  },

  fromTransactionToSpendKey: (txKey: typeof SecretKey): typeof SecretKey => {
    // Replicates FromTransactionToSpendKey: derive_child_SK(txKey, 1)
    return mockBlsct.deriveChildSK(txKey, 1);
  },

  // SubAddress operations
  deriveSubAddress: (
    viewKey: typeof SecretKey,
    spendPublicKey: typeof PublicKey,
    subAddressId: SubAddressIdentifier
  ): SubAddress => {
    // Simplified - in real implementation would use DeriveSubAddress
    // For mock, return an object with the sub-address data
    const viewBytes = mockBlsct.secretKeyToBytes(viewKey);
    const spendBytes = mockBlsct.publicKeyToBytes(spendPublicKey);
    const idBytes = new Uint8Array(12); // 8 bytes for account (int64) + 8 bytes for address (uint64)
    new DataView(idBytes.buffer).setBigInt64(0, BigInt(subAddressId.account), true);
    new DataView(idBytes.buffer).setBigUint64(8, BigInt(subAddressId.address), true);

    // Combine all data
    const combined = new Uint8Array(viewBytes.length + spendBytes.length + idBytes.length);
    combined.set(viewBytes, 0);
    combined.set(spendBytes, viewBytes.length);
    combined.set(idBytes, viewBytes.length + spendBytes.length);

    return combined as unknown as SubAddress;
  },

  // Hash and tag calculations
  calculateHashId: (
    blindingKey: typeof PublicKey,
    spendingKey: typeof PublicKey,
    viewKey: typeof SecretKey
  ): Uint8Array => {
    // Simplified hash160 calculation
    const blindingBytes = mockBlsct.publicKeyToBytes(blindingKey);
    const spendingBytes = mockBlsct.publicKeyToBytes(spendingKey);
    const viewBytes = mockBlsct.secretKeyToBytes(viewKey);
    const combined = new Uint8Array(blindingBytes.length + spendingBytes.length + viewBytes.length);
    combined.set(blindingBytes, 0);
    combined.set(spendingBytes, blindingBytes.length);
    combined.set(viewBytes, blindingBytes.length + spendingBytes.length);
    
    // Simple hash (in real implementation would use SHA256 + RIPEMD160)
    const hash = new Uint8Array(20);
    for (let i = 0; i < 20; i++) {
      hash[i] = combined[i % combined.length] ^ combined[(i + 1) % combined.length];
    }
    return hash;
  },

  calculateViewTag: (blindingKey: typeof PublicKey, viewKey: typeof SecretKey): number => {
    // Simplified - in real implementation would use CalculateViewTag
    const blindingBytes = mockBlsct.publicKeyToBytes(blindingKey);
    const viewBytes = mockBlsct.secretKeyToBytes(viewKey);
    const combined = new Uint8Array(blindingBytes.length + viewBytes.length);
    combined.set(blindingBytes, 0);
    combined.set(viewBytes, blindingBytes.length);
    // Return 16-bit value
    return (combined[0] << 8 | combined[1]) & 0xffff;
  },

  calculateNonce: (blindingKey: typeof PublicKey, viewKey: typeof SecretKey): typeof PublicKey => {
    // Simplified - in real implementation would compute blindingKey * viewKey
    const blindingBytes = mockBlsct.publicKeyToBytes(blindingKey);
    const viewBytes = mockBlsct.secretKeyToBytes(viewKey);
    const nonce = new Uint8Array(48);
    for (let i = 0; i < 48; i++) {
      nonce[i] = (blindingBytes[i % blindingBytes.length] + viewBytes[i % viewBytes.length]) % 256;
    }
    return nonce as unknown as typeof PublicKey;
  },

  calculatePrivateSpendingKey: (
    blindingKey: typeof PublicKey,
    viewKey: typeof SecretKey,
    spendingKey: typeof SecretKey,
    account: number,
    address: number
  ): typeof SecretKey => {
    // Simplified - in real implementation would use CalculatePrivateSpendingKey
    const blindingBytes = mockBlsct.publicKeyToBytes(blindingKey);
    const viewBytes = mockBlsct.secretKeyToBytes(viewKey);
    const spendingBytes = mockBlsct.secretKeyToBytes(spendingKey);
    const accountBytes = new Uint8Array(8);
    new DataView(accountBytes.buffer).setBigInt64(0, BigInt(account), true);
    const addressBytes = new Uint8Array(8);
    new DataView(addressBytes.buffer).setBigUint64(0, BigInt(address), true);

    const combined = new Uint8Array(
      blindingBytes.length + viewBytes.length + spendingBytes.length + accountBytes.length + addressBytes.length
    );
    let offset = 0;
    combined.set(blindingBytes, offset);
    offset += blindingBytes.length;
    combined.set(viewBytes, offset);
    offset += viewBytes.length;
    combined.set(spendingBytes, offset);
    offset += spendingBytes.length;
    combined.set(accountBytes, offset);
    offset += accountBytes.length;
    combined.set(addressBytes, offset);

    return combined.slice(0, 32) as unknown as typeof SecretKey;
  },
};

/**
 * Convert sub-address to a readable string representation
 */
function subAddressToString(subAddress: SubAddress): string {
  // In real implementation, this would use SubAddress.GetString()
  // For mock, convert to hex
  const bytes = subAddress as unknown as Uint8Array;
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Main test function
 */
function main() {
  console.log('Creating KeyManager from random seed...\n');

  // Note: KeyManager now imports navio-blsct directly, no initialization needed
  // Create a new KeyManager instance
  const keyManager = new KeyManager();

  // Generate a random seed
  console.log('Generating random seed...');
  const seed = keyManager.generateNewSeed();
  const seedBytes = mockBlsct.secretKeyToBytes(seed);
  console.log(`Seed (hex): ${seedBytes}\n`);

  // Set the HD seed (this derives all master keys)
  console.log('Setting HD seed and deriving master keys...');
  keyManager.setHDSeed(Scalar.deserialize("3772f190ba41e7486df45fc91915b342589908df962ab92f0a7992de8d55561d"));
  console.log('✓ HD seed set\n');

  // Check HD status
  console.log(`HD Enabled: ${keyManager.isHDEnabled()}`);
  console.log(`Can Generate Keys: ${keyManager.canGenerateKeys()}\n`);

  // Get the sub-address for account 0, index 0
  console.log('Getting sub-address for account 0, index 0...');
  const subAddressId: SubAddressIdentifier = { account: 0, address: 0 };
  const subAddress = keyManager.getSubAddress(subAddressId);
  let dpk = DoublePublicKey.deserialize(subAddress.serialize());
  let address = Address.encode(dpk, AddressEncoding.Bech32M);
  console.log('address', address);
  // Print the sub-address
  console.log(`\nSub-Address (account ${subAddressId.account}, index ${subAddressId.address}):`);

  // Also show some key information
  try {
    const viewKey = keyManager.getPrivateViewKey();
    const viewKeyBytes = mockBlsct.secretKeyToBytes(viewKey);
    console.log(`View Key (hex): ${Array.from(viewKeyBytes).map((b) => b.toString(16).padStart(2, '0')).join('')}`);
    const spendPublicKey = keyManager.getPublicSpendingKey();
    const spendKeyBytes = mockBlsct.publicKeyToBytes(spendPublicKey);
    console.log('spendpublickey', spendPublicKey.serialize());
    console.log(`Spend Public Key (hex): ${Array.from(spendKeyBytes).map((b) => b.toString(16).padStart(2, '0')).join('')}\n`);
  } catch (error) {
    console.error('Error getting keys:', error);
  }

  // Show HD chain info
  const hdChain = keyManager.getHDChain();
  if (hdChain) {
    console.log('HD Chain Info:');
    console.log(`  Version: ${hdChain.version}`);
    console.log(`  Seed ID: ${Array.from(hdChain.seedId).map((b) => b.toString(16).padStart(2, '0')).join('')}`);
    console.log(`  Spend ID: ${Array.from(hdChain.spendId).map((b) => b.toString(16).padStart(2, '0')).join('')}`);
    console.log(`  View ID: ${Array.from(hdChain.viewId).map((b) => b.toString(16).padStart(2, '0')).join('')}\n`);
  }

  console.log('✓ Test completed successfully!');
}

// Run the test
try {
  main();
} catch (error) {
  console.error('Error running test:', error);
  process.exit(1);
}

