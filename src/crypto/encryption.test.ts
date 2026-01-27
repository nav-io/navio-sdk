import { describe, it, expect, beforeAll, vi } from 'vitest';
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
} from './encryption';

// Set longer timeout for Argon2 operations (they're intentionally slow)
vi.setConfig({ testTimeout: 30000 });

describe('Encryption Module', () => {
  describe('randomBytes', () => {
    it('should generate random bytes of specified length', () => {
      const bytes16 = randomBytes(16);
      const bytes32 = randomBytes(32);

      expect(bytes16).toBeInstanceOf(Uint8Array);
      expect(bytes16.length).toBe(16);
      expect(bytes32.length).toBe(32);
    });

    it('should generate different bytes each time', () => {
      const bytes1 = randomBytes(32);
      const bytes2 = randomBytes(32);

      // Compare as hex strings
      const hex1 = Array.from(bytes1).map(b => b.toString(16).padStart(2, '0')).join('');
      const hex2 = Array.from(bytes2).map(b => b.toString(16).padStart(2, '0')).join('');

      expect(hex1).not.toBe(hex2);
    });
  });

  describe('deriveKey', () => {
    it('should derive a CryptoKey from password and salt', async () => {
      const password = 'test-password-123';
      const salt = randomBytes(SALT_LENGTH);

      const key = await deriveKey(password, salt);

      expect(key).toBeDefined();
      // CryptoKey has algorithm property
      expect((key as any).algorithm.name).toBe('AES-GCM');
    });

    it('should derive same key for same password and salt', async () => {
      const password = 'test-password-123';
      const salt = randomBytes(SALT_LENGTH);

      const key1 = await deriveKey(password, salt);
      const key2 = await deriveKey(password, salt);

      // Keys are not directly comparable, but we can test encryption/decryption
      const testData = new TextEncoder().encode('test data');

      const encrypted = await encryptWithKey(testData, key1, salt);
      const decrypted = await decryptWithKey(encrypted, key2);

      expect(new TextDecoder().decode(decrypted)).toBe('test data');
    });

    it('should derive different keys for different passwords', async () => {
      const salt = randomBytes(SALT_LENGTH);

      const key1 = await deriveKey('password1', salt);
      const key2 = await deriveKey('password2', salt);

      const testData = new TextEncoder().encode('test data');
      const encrypted = await encryptWithKey(testData, key1, salt);

      // Should fail to decrypt with wrong key
      await expect(decryptWithKey(encrypted, key2)).rejects.toThrow();
    });
  });

  describe('deriveKeyBytes', () => {
    it('should derive 32 bytes from password and salt', async () => {
      const password = 'test-password';
      const salt = randomBytes(SALT_LENGTH);

      const keyBytes = await deriveKeyBytes(password, salt);

      expect(keyBytes).toBeInstanceOf(Uint8Array);
      expect(keyBytes.length).toBe(32);
    });

    it('should be deterministic', async () => {
      const password = 'test-password';
      const salt = randomBytes(SALT_LENGTH);

      const keyBytes1 = await deriveKeyBytes(password, salt);
      const keyBytes2 = await deriveKeyBytes(password, salt);

      expect(Array.from(keyBytes1)).toEqual(Array.from(keyBytes2));
    });
  });

  describe('encrypt/decrypt', () => {
    it('should encrypt and decrypt data', async () => {
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

    it('should fail with wrong password', async () => {
      const plaintext = new TextEncoder().encode('Secret data');

      const encrypted = await encrypt(plaintext, 'correct-password');

      await expect(decrypt(encrypted, 'wrong-password')).rejects.toThrow('Decryption failed');
    });

    it('should encrypt same data differently each time', async () => {
      const password = 'password';
      const plaintext = new TextEncoder().encode('Same data');

      const encrypted1 = await encrypt(plaintext, password);
      const encrypted2 = await encrypt(plaintext, password);

      // Ciphertexts should be different due to random IV and salt
      const hex1 = Array.from(encrypted1.ciphertext).map(b => b.toString(16).padStart(2, '0')).join('');
      const hex2 = Array.from(encrypted2.ciphertext).map(b => b.toString(16).padStart(2, '0')).join('');

      expect(hex1).not.toBe(hex2);

      // But both should decrypt to same plaintext
      const decrypted1 = await decrypt(encrypted1, password);
      const decrypted2 = await decrypt(encrypted2, password);

      expect(new TextDecoder().decode(decrypted1)).toBe('Same data');
      expect(new TextDecoder().decode(decrypted2)).toBe('Same data');
    });

    it('should handle empty data', async () => {
      const password = 'password';
      const plaintext = new Uint8Array(0);

      const encrypted = await encrypt(plaintext, password);
      const decrypted = await decrypt(encrypted, password);

      expect(decrypted.length).toBe(0);
    });

    it('should handle large data', async () => {
      const password = 'password';
      const plaintext = randomBytes(1024 * 100); // 100KB

      const encrypted = await encrypt(plaintext, password);
      const decrypted = await decrypt(encrypted, password);

      expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
    });
  });

  describe('serialization', () => {
    it('should serialize and deserialize encrypted data', async () => {
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

      // Should still decrypt
      const decrypted = await decrypt(deserialized, password);
      expect(new TextDecoder().decode(decrypted)).toBe('Test serialization');
    });

    it('should be JSON serializable', async () => {
      const password = 'password';
      const plaintext = new TextEncoder().encode('JSON test');

      const encrypted = await encrypt(plaintext, password);
      const serialized = serializeEncryptedData(encrypted);

      // Round-trip through JSON
      const json = JSON.stringify(serialized);
      const parsed = JSON.parse(json);
      const deserialized = deserializeEncryptedData(parsed);

      const decrypted = await decrypt(deserialized, password);
      expect(new TextDecoder().decode(decrypted)).toBe('JSON test');
    });
  });

  describe('database encryption', () => {
    it('should encrypt and decrypt database buffer', async () => {
      const password = 'db-password';
      // Simulate SQLite database header
      const dbBuffer = new TextEncoder().encode('SQLite format 3\0' + 'x'.repeat(100));

      const encrypted = await encryptDatabase(dbBuffer, password);

      expect(encrypted).toBeInstanceOf(Uint8Array);
      expect(encrypted.length).toBeGreaterThan(dbBuffer.length);
      expect(encrypted[0]).toBe(1); // Version byte

      const decrypted = await decryptDatabase(encrypted, password);

      expect(Array.from(decrypted)).toEqual(Array.from(dbBuffer));
    });

    it('should detect encrypted database', async () => {
      const password = 'password';
      const dbBuffer = new TextEncoder().encode('SQLite format 3\0test');

      const encrypted = await encryptDatabase(dbBuffer, password);

      expect(isEncryptedDatabase(encrypted)).toBe(true);
      expect(isEncryptedDatabase(dbBuffer)).toBe(false);
    });

    it('should reject too short encrypted data', async () => {
      const tooShort = new Uint8Array(10);
      tooShort[0] = 1; // Version

      await expect(decryptDatabase(tooShort, 'password')).rejects.toThrow('too short');
    });
  });

  describe('password verification', () => {
    it('should verify correct password', async () => {
      const password = 'correct-password';
      const salt = randomBytes(SALT_LENGTH);

      const hash = await createPasswordVerification(password, salt);

      expect(hash).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBe(32); // SHA-256 output

      const isValid = await verifyPassword(password, salt, hash);
      expect(isValid).toBe(true);
    });

    it('should reject incorrect password', async () => {
      const password = 'correct-password';
      const salt = randomBytes(SALT_LENGTH);

      const hash = await createPasswordVerification(password, salt);

      const isValid = await verifyPassword('wrong-password', salt, hash);
      expect(isValid).toBe(false);
    });

    it('should be timing-attack resistant', async () => {
      const password = 'password';
      const salt = randomBytes(SALT_LENGTH);
      const hash = await createPasswordVerification(password, salt);

      // This test just ensures the constant-time comparison runs without error
      // Actually testing timing resistance requires statistical analysis
      for (let i = 0; i < 10; i++) {
        await verifyPassword('wrong' + i, salt, hash);
      }
    });
  });

  describe('encryptWithKey/decryptWithKey', () => {
    it('should encrypt and decrypt with pre-derived key', async () => {
      const password = 'password';
      const salt = randomBytes(SALT_LENGTH);
      const key = await deriveKey(password, salt);

      const plaintext = new TextEncoder().encode('Pre-derived key test');

      const encrypted = await encryptWithKey(plaintext, key, salt);
      const decrypted = await decryptWithKey(encrypted, key);

      expect(new TextDecoder().decode(decrypted)).toBe('Pre-derived key test');
    });

    it('should allow encrypting multiple items with same key', async () => {
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
});
