/**
 * Cryptographic utilities for wallet encryption
 * @module crypto
 */

// Types
export type { EncryptedData, SerializedEncryptedData } from './encryption';

// Functions and constants
export {
  // Key derivation
  deriveKey,
  deriveKeyBytes,
  // Encryption/Decryption
  encrypt,
  encryptWithKey,
  decrypt,
  decryptWithKey,
  // Serialization
  serializeEncryptedData,
  deserializeEncryptedData,
  // Database encryption
  encryptDatabase,
  decryptDatabase,
  isEncryptedDatabase,
  // Password verification
  createPasswordVerification,
  verifyPassword,
  // Utilities
  randomBytes,
  // Constants
  ENCRYPTION_VERSION,
  SALT_LENGTH,
  IV_LENGTH,
} from './encryption';
