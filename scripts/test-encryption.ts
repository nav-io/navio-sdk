/**
 * Standalone encryption module tests
 * Run with: npm run test:encryption (or: tsx scripts/test-encryption.ts)
 */

// Polyfill crypto for Node.js < 19
if (typeof globalThis.crypto === 'undefined' || typeof (globalThis.crypto as any).getRandomValues !== 'function') {
  const nodeCrypto = require('crypto');
  if (nodeCrypto.webcrypto) {
    (globalThis as any).crypto = nodeCrypto.webcrypto;
    console.log('[setup] Applied crypto polyfill for Node.js < 19');
  }
}

import {
  deriveKey,
  deriveKeyBytes,
  encrypt,
  decrypt,
  encryptWithKey,
  decryptWithKey,
  serializeEncryptedData,
  deserializeEncryptedData,
  encryptDatabase,
  decryptDatabase,
  isEncryptedDatabase,
  createPasswordVerification,
  verifyPassword,
  randomBytes,
  SALT_LENGTH,
  IV_LENGTH,
} from '../src/crypto/encryption';

// Simple test framework
let passed = 0;
let failed = 0;

function describe(name: string, fn: () => Promise<void> | void) {
  console.log(`\n  ${name}`);
  return fn();
}

async function it(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`    ✓ ${name}`);
    passed++;
  } catch (error: any) {
    console.log(`    ✗ ${name}`);
    console.log(`      Error: ${error.message}`);
    failed++;
  }
}

function expect(value: any) {
  return {
    toBe(expected: any) {
      if (value !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(value)}`);
      }
    },
    toBeInstanceOf(expected: any) {
      if (!(value instanceof expected)) {
        throw new Error(`Expected instance of ${expected.name}`);
      }
    },
    toBeDefined() {
      if (value === undefined) {
        throw new Error('Expected value to be defined');
      }
    },
    toEqual(expected: any) {
      const valueStr = JSON.stringify(value);
      const expectedStr = JSON.stringify(expected);
      if (valueStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${valueStr}`);
      }
    },
    not: {
      toBe(expected: any) {
        if (value === expected) {
          throw new Error(`Expected value to not be ${JSON.stringify(expected)}`);
        }
      }
    },
    toThrow(message?: string) {
      // This is used differently - value should be a function
      throw new Error('Use expectAsync for async throw tests');
    },
    rejects: {
      async toThrow(message?: string) {
        try {
          await value;
          throw new Error('Expected promise to reject');
        } catch (error: any) {
          if (message && !error.message.includes(message)) {
            throw new Error(`Expected error containing "${message}" but got "${error.message}"`);
          }
        }
      }
    }
  };
}

async function runTests() {
  console.log('\n🔐 Encryption Module Tests\n');

  await describe('randomBytes', async () => {
    await it('should generate random bytes of specified length', async () => {
      const bytes16 = randomBytes(16);
      const bytes32 = randomBytes(32);

      expect(bytes16).toBeInstanceOf(Uint8Array);
      expect(bytes16.length).toBe(16);
      expect(bytes32.length).toBe(32);
    });

    await it('should generate different bytes each time', async () => {
      const bytes1 = randomBytes(32);
      const bytes2 = randomBytes(32);

      const hex1 = Array.from(bytes1).map(b => b.toString(16).padStart(2, '0')).join('');
      const hex2 = Array.from(bytes2).map(b => b.toString(16).padStart(2, '0')).join('');

      expect(hex1).not.toBe(hex2);
    });
  });

  await describe('deriveKey', async () => {
    await it('should derive a CryptoKey from password and salt', async () => {
      const password = 'test-password-123';
      const salt = randomBytes(SALT_LENGTH);

      const key = await deriveKey(password, salt);

      expect(key).toBeDefined();
      expect((key as any).algorithm.name).toBe('AES-GCM');
    });

    await it('should derive same key for same password and salt', async () => {
      const password = 'test-password-123';
      const salt = randomBytes(SALT_LENGTH);

      const key1 = await deriveKey(password, salt);
      const key2 = await deriveKey(password, salt);

      const testData = new TextEncoder().encode('test data');

      const encrypted = await encryptWithKey(testData, key1, salt);
      const decrypted = await decryptWithKey(encrypted, key2);

      expect(new TextDecoder().decode(decrypted)).toBe('test data');
    });
  });

  await describe('deriveKeyBytes', async () => {
    await it('should derive 32 bytes from password and salt', async () => {
      const password = 'test-password';
      const salt = randomBytes(SALT_LENGTH);

      const keyBytes = await deriveKeyBytes(password, salt);

      expect(keyBytes).toBeInstanceOf(Uint8Array);
      expect(keyBytes.length).toBe(32);
    });

    await it('should be deterministic', async () => {
      const password = 'test-password';
      const salt = randomBytes(SALT_LENGTH);

      const keyBytes1 = await deriveKeyBytes(password, salt);
      const keyBytes2 = await deriveKeyBytes(password, salt);

      expect(Array.from(keyBytes1)).toEqual(Array.from(keyBytes2));
    });
  });

  await describe('encrypt/decrypt', async () => {
    await it('should encrypt and decrypt data', async () => {
      const password = 'secure-password-123';
      const plaintext = new TextEncoder().encode('Hello, World!');

      const encrypted = await encrypt(plaintext, password);

      expect(encrypted.ciphertext).toBeInstanceOf(Uint8Array);
      expect(encrypted.iv).toBeInstanceOf(Uint8Array);
      expect(encrypted.iv.length).toBe(IV_LENGTH);
      expect(encrypted.salt).toBeInstanceOf(Uint8Array);
      expect(encrypted.salt.length).toBe(SALT_LENGTH);

      const decrypted = await decrypt(encrypted, password);

      expect(new TextDecoder().decode(decrypted)).toBe('Hello, World!');
    });

    await it('should fail with wrong password', async () => {
      const plaintext = new TextEncoder().encode('Secret data');
      const encrypted = await encrypt(plaintext, 'correct-password');

      await expect(decrypt(encrypted, 'wrong-password')).rejects.toThrow('Decryption failed');
    });

    await it('should encrypt same data differently each time', async () => {
      const password = 'password';
      const plaintext = new TextEncoder().encode('Same data');

      const encrypted1 = await encrypt(plaintext, password);
      const encrypted2 = await encrypt(plaintext, password);

      const hex1 = Array.from(encrypted1.ciphertext).map(b => b.toString(16).padStart(2, '0')).join('');
      const hex2 = Array.from(encrypted2.ciphertext).map(b => b.toString(16).padStart(2, '0')).join('');

      expect(hex1).not.toBe(hex2);

      const decrypted1 = await decrypt(encrypted1, password);
      const decrypted2 = await decrypt(encrypted2, password);

      expect(new TextDecoder().decode(decrypted1)).toBe('Same data');
      expect(new TextDecoder().decode(decrypted2)).toBe('Same data');
    });

    await it('should handle empty data', async () => {
      const password = 'password';
      const plaintext = new Uint8Array(0);

      const encrypted = await encrypt(plaintext, password);
      const decrypted = await decrypt(encrypted, password);

      expect(decrypted.length).toBe(0);
    });
  });

  await describe('serialization', async () => {
    await it('should serialize and deserialize encrypted data', async () => {
      const password = 'password';
      const plaintext = new TextEncoder().encode('Test serialization');

      const encrypted = await encrypt(plaintext, password);
      const serialized = serializeEncryptedData(encrypted);

      expect(typeof serialized.ciphertext).toBe('string');
      expect(typeof serialized.iv).toBe('string');
      expect(typeof serialized.salt).toBe('string');
      expect(serialized.version).toBe(1);

      const deserialized = deserializeEncryptedData(serialized);

      expect(Array.from(deserialized.ciphertext)).toEqual(Array.from(encrypted.ciphertext));
      expect(Array.from(deserialized.iv)).toEqual(Array.from(encrypted.iv));
      expect(Array.from(deserialized.salt)).toEqual(Array.from(encrypted.salt));

      const decrypted = await decrypt(deserialized, password);
      expect(new TextDecoder().decode(decrypted)).toBe('Test serialization');
    });

    await it('should be JSON serializable', async () => {
      const password = 'password';
      const plaintext = new TextEncoder().encode('JSON test');

      const encrypted = await encrypt(plaintext, password);
      const serialized = serializeEncryptedData(encrypted);

      const json = JSON.stringify(serialized);
      const parsed = JSON.parse(json);
      const deserialized = deserializeEncryptedData(parsed);

      const decrypted = await decrypt(deserialized, password);
      expect(new TextDecoder().decode(decrypted)).toBe('JSON test');
    });
  });

  await describe('database encryption', async () => {
    await it('should encrypt and decrypt database buffer', async () => {
      const password = 'db-password';
      const dbBuffer = new TextEncoder().encode('SQLite format 3\0' + 'x'.repeat(100));

      const encrypted = await encryptDatabase(dbBuffer, password);

      expect(encrypted).toBeInstanceOf(Uint8Array);
      expect(encrypted[0]).toBe(1); // Version byte

      const decrypted = await decryptDatabase(encrypted, password);

      expect(Array.from(decrypted)).toEqual(Array.from(dbBuffer));
    });

    await it('should detect encrypted database', async () => {
      const password = 'password';
      const dbBuffer = new TextEncoder().encode('SQLite format 3\0test');

      const encrypted = await encryptDatabase(dbBuffer, password);

      expect(isEncryptedDatabase(encrypted)).toBe(true);
      expect(isEncryptedDatabase(dbBuffer)).toBe(false);
    });
  });

  await describe('password verification', async () => {
    await it('should verify correct password', async () => {
      const password = 'correct-password';
      const salt = randomBytes(SALT_LENGTH);

      const hash = await createPasswordVerification(password, salt);

      expect(hash).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBe(32);

      const isValid = await verifyPassword(password, salt, hash);
      expect(isValid).toBe(true);
    });

    await it('should reject incorrect password', async () => {
      const password = 'correct-password';
      const salt = randomBytes(SALT_LENGTH);

      const hash = await createPasswordVerification(password, salt);

      const isValid = await verifyPassword('wrong-password', salt, hash);
      expect(isValid).toBe(false);
    });
  });

  await describe('encryptWithKey/decryptWithKey', async () => {
    await it('should encrypt and decrypt with pre-derived key', async () => {
      const password = 'password';
      const salt = randomBytes(SALT_LENGTH);
      const key = await deriveKey(password, salt);

      const plaintext = new TextEncoder().encode('Pre-derived key test');

      const encrypted = await encryptWithKey(plaintext, key, salt);
      const decrypted = await decryptWithKey(encrypted, key);

      expect(new TextDecoder().decode(decrypted)).toBe('Pre-derived key test');
    });

    await it('should allow encrypting multiple items with same key', async () => {
      const password = 'password';
      const salt = randomBytes(SALT_LENGTH);
      const key = await deriveKey(password, salt);

      const items = ['Item 1', 'Item 2', 'Item 3'];
      const encrypted = await Promise.all(
        items.map(item => encryptWithKey(new TextEncoder().encode(item), key, salt))
      );

      const decrypted = await Promise.all(
        encrypted.map(enc => decryptWithKey(enc, key))
      );

      const results = decrypted.map(d => new TextDecoder().decode(d));
      expect(results).toEqual(items);
    });
  });

  // Summary
  console.log('\n' + '─'.repeat(50));
  console.log(`  Tests: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(50) + '\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(error => {
  console.error('Test runner error:', error);
  process.exit(1);
});
