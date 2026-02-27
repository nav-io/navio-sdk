/**
 * Wallet encryption module using Argon2id for key derivation and AES-256-GCM for encryption.
 *
 * This module provides secure password-based encryption for wallet data.
 *
 * @module crypto/encryption
 */

/// <reference lib="dom" />

import { argon2id } from 'hash-wasm';

// Type aliases for Web Crypto API (works in both browser and Node.js)
type WebCrypto = typeof globalThis.crypto;
type WebCryptoKey = Awaited<ReturnType<SubtleCrypto['importKey']>>;

/**
 * Helper to convert Uint8Array to a format compatible with Web Crypto API
 * This handles TypeScript's strict ArrayBuffer typing
 */
function toBufferSource(data: Uint8Array): ArrayBuffer {
  // Create a copy to ensure we have a standard ArrayBuffer
  return new Uint8Array(data).buffer as ArrayBuffer;
}

/**
 * Encrypted data structure containing ciphertext and encryption parameters
 */
export interface EncryptedData {
  /** The encrypted ciphertext (includes auth tag for GCM) */
  ciphertext: Uint8Array;
  /** Initialization vector (12 bytes for AES-GCM) */
  iv: Uint8Array;
  /** Salt used for Argon2 key derivation (16 bytes) */
  salt: Uint8Array;
}

/**
 * Serialized format for encrypted data (for storage)
 */
export interface SerializedEncryptedData {
  /** Base64-encoded ciphertext */
  ciphertext: string;
  /** Base64-encoded IV */
  iv: string;
  /** Base64-encoded salt */
  salt: string;
  /** Encryption version for future compatibility */
  version: number;
}

/**
 * Argon2 parameters for key derivation
 * Using recommended settings for sensitive data protection
 */
const ARGON2_PARAMS = {
  memorySize: 65536, // 64 MB (hash-wasm uses memorySize instead of memory)
  iterations: 3,
  parallelism: 4,
  hashLength: 32, // 256 bits for AES-256 (hash-wasm uses hashLength instead of hashLen)
};

/**
 * Current encryption version for forward compatibility
 */
const ENCRYPTION_VERSION = 1;

/**
 * IV length for AES-GCM (96 bits / 12 bytes is recommended)
 */
const IV_LENGTH = 12;

/**
 * Salt length for Argon2 (16 bytes is recommended minimum)
 */
const SALT_LENGTH = 16;

/**
 * Get the crypto implementation (Web Crypto API)
 * Works in both browser and Node.js (>= 19) environments via globalThis.crypto
 */
function getCrypto(): WebCrypto {
  if (typeof globalThis.crypto !== 'undefined' && 
      typeof globalThis.crypto.subtle !== 'undefined' &&
      typeof globalThis.crypto.getRandomValues === 'function') {
    return globalThis.crypto;
  }
  throw new Error(
    'Web Crypto API not available. Requires Node.js 19+ or a modern browser.'
  );
}

/**
 * Generate cryptographically secure random bytes
 * @param length - Number of bytes to generate
 * @returns Random bytes
 */
export function randomBytes(length: number): Uint8Array {
  const crypto = getCrypto();
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Derive an AES-256 encryption key from a password using Argon2id
 *
 * @param password - The user's password
 * @param salt - Random salt (16 bytes recommended)
 * @returns CryptoKey suitable for AES-256-GCM encryption
 */
export async function deriveKey(password: string, salt: Uint8Array): Promise<WebCryptoKey> {
  // Use Argon2id to derive key material from password
  const hashHex = await argon2id({
    password: password,
    salt: salt,
    memorySize: ARGON2_PARAMS.memorySize,
    iterations: ARGON2_PARAMS.iterations,
    parallelism: ARGON2_PARAMS.parallelism,
    hashLength: ARGON2_PARAMS.hashLength,
    outputType: 'hex',
  });

  // Convert hex string to Uint8Array
  const hashBytes = hexToBytes(hashHex);

  // Import the derived key material as an AES-GCM key
  const crypto = getCrypto();
  const key = await crypto.subtle.importKey(
    'raw',
    toBufferSource(hashBytes),
    { name: 'AES-GCM', length: 256 },
    false, // not extractable
    ['encrypt', 'decrypt']
  );

  return key;
}

/**
 * Derive raw key bytes from a password using Argon2id
 * Useful for creating a password verification hash
 *
 * @param password - The user's password
 * @param salt - Random salt (16 bytes recommended)
 * @returns 32 bytes of derived key material
 */
export async function deriveKeyBytes(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const hashHex = await argon2id({
    password: password,
    salt: salt,
    memorySize: ARGON2_PARAMS.memorySize,
    iterations: ARGON2_PARAMS.iterations,
    parallelism: ARGON2_PARAMS.parallelism,
    hashLength: ARGON2_PARAMS.hashLength,
    outputType: 'hex',
  });

  return hexToBytes(hashHex);
}

/**
 * Encrypt data using AES-256-GCM with a password
 *
 * @param data - The plaintext data to encrypt
 * @param password - The user's password
 * @returns Encrypted data with IV and salt
 */
export async function encrypt(data: Uint8Array, password: string): Promise<EncryptedData> {
  const crypto = getCrypto();

  // Generate random salt and IV
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);

  // Derive encryption key from password
  const key = await deriveKey(password, salt);

  // Encrypt using AES-256-GCM
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBufferSource(iv) },
    key,
    toBufferSource(data)
  );

  return {
    ciphertext: new Uint8Array(ciphertext),
    iv,
    salt,
  };
}

/**
 * Encrypt data using AES-256-GCM with a pre-derived CryptoKey
 * More efficient when encrypting multiple items with the same password
 *
 * @param data - The plaintext data to encrypt
 * @param key - Pre-derived CryptoKey
 * @param salt - Salt used to derive the key (for storage)
 * @returns Encrypted data with IV and salt
 */
export async function encryptWithKey(
  data: Uint8Array,
  key: WebCryptoKey,
  salt: Uint8Array
): Promise<EncryptedData> {
  const crypto = getCrypto();

  // Generate random IV
  const iv = randomBytes(IV_LENGTH);

  // Encrypt using AES-256-GCM
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBufferSource(iv) },
    key,
    toBufferSource(data)
  );

  return {
    ciphertext: new Uint8Array(ciphertext),
    iv,
    salt,
  };
}

/**
 * Decrypt data using AES-256-GCM with a password
 *
 * @param encrypted - The encrypted data with IV and salt
 * @param password - The user's password
 * @returns Decrypted plaintext data
 * @throws Error if decryption fails (wrong password or corrupted data)
 */
export async function decrypt(encrypted: EncryptedData, password: string): Promise<Uint8Array> {
  const crypto = getCrypto();

  // Derive encryption key from password
  const key = await deriveKey(password, encrypted.salt);

  try {
    // Decrypt using AES-256-GCM
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBufferSource(encrypted.iv) },
      key,
      toBufferSource(encrypted.ciphertext)
    );

    return new Uint8Array(plaintext);
  } catch {
    throw new Error('Decryption failed: wrong password or corrupted data');
  }
}

/**
 * Decrypt data using AES-256-GCM with a pre-derived CryptoKey
 * More efficient when decrypting multiple items with the same password
 *
 * @param encrypted - The encrypted data with IV and salt
 * @param key - Pre-derived CryptoKey
 * @returns Decrypted plaintext data
 * @throws Error if decryption fails (wrong key or corrupted data)
 */
export async function decryptWithKey(
  encrypted: EncryptedData,
  key: WebCryptoKey
): Promise<Uint8Array> {
  const crypto = getCrypto();

  try {
    // Decrypt using AES-256-GCM
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBufferSource(encrypted.iv) },
      key,
      toBufferSource(encrypted.ciphertext)
    );

    return new Uint8Array(plaintext);
  } catch {
    throw new Error('Decryption failed: wrong key or corrupted data');
  }
}

/**
 * Serialize encrypted data for storage (converts to base64 strings)
 *
 * @param encrypted - Encrypted data to serialize
 * @returns Serialized format suitable for JSON storage
 */
export function serializeEncryptedData(encrypted: EncryptedData): SerializedEncryptedData {
  return {
    ciphertext: bytesToBase64(encrypted.ciphertext),
    iv: bytesToBase64(encrypted.iv),
    salt: bytesToBase64(encrypted.salt),
    version: ENCRYPTION_VERSION,
  };
}

/**
 * Deserialize encrypted data from storage
 *
 * @param serialized - Serialized encrypted data
 * @returns Encrypted data ready for decryption
 * @throws Error if version is unsupported
 */
export function deserializeEncryptedData(serialized: SerializedEncryptedData): EncryptedData {
  if (serialized.version > ENCRYPTION_VERSION) {
    throw new Error(`Unsupported encryption version: ${serialized.version}`);
  }

  return {
    ciphertext: base64ToBytes(serialized.ciphertext),
    iv: base64ToBytes(serialized.iv),
    salt: base64ToBytes(serialized.salt),
  };
}

/**
 * Encrypt an entire database buffer
 *
 * @param dbBuffer - Raw database file bytes
 * @param password - The user's password
 * @returns Encrypted database buffer with header
 */
export async function encryptDatabase(dbBuffer: Uint8Array, password: string): Promise<Uint8Array> {
  const encrypted = await encrypt(dbBuffer, password);

  // Create a combined buffer with header
  // Format: [version:1][salt:16][iv:12][ciphertext:*]
  const combined = new Uint8Array(1 + SALT_LENGTH + IV_LENGTH + encrypted.ciphertext.length);
  combined[0] = ENCRYPTION_VERSION;
  combined.set(encrypted.salt, 1);
  combined.set(encrypted.iv, 1 + SALT_LENGTH);
  combined.set(encrypted.ciphertext, 1 + SALT_LENGTH + IV_LENGTH);

  return combined;
}

/**
 * Decrypt an entire database buffer
 *
 * @param encryptedBuffer - Encrypted database buffer with header
 * @param password - The user's password
 * @returns Decrypted database file bytes
 * @throws Error if decryption fails
 */
export async function decryptDatabase(
  encryptedBuffer: Uint8Array,
  password: string
): Promise<Uint8Array> {
  if (encryptedBuffer.length < 1 + SALT_LENGTH + IV_LENGTH) {
    throw new Error('Invalid encrypted database: too short');
  }

  const version = encryptedBuffer[0];
  if (version > ENCRYPTION_VERSION) {
    throw new Error(`Unsupported encryption version: ${version}`);
  }

  const salt = encryptedBuffer.slice(1, 1 + SALT_LENGTH);
  const iv = encryptedBuffer.slice(1 + SALT_LENGTH, 1 + SALT_LENGTH + IV_LENGTH);
  const ciphertext = encryptedBuffer.slice(1 + SALT_LENGTH + IV_LENGTH);

  return decrypt({ ciphertext, iv, salt }, password);
}

/**
 * Check if a buffer appears to be an encrypted database
 *
 * @param buffer - Buffer to check
 * @returns True if buffer starts with valid encryption header
 */
export function isEncryptedDatabase(buffer: Uint8Array): boolean {
  if (buffer.length < 1 + SALT_LENGTH + IV_LENGTH) {
    return false;
  }
  const version = buffer[0];
  // Version 0 would be SQLite (starts with "SQLite")
  return version >= 1 && version <= ENCRYPTION_VERSION;
}

/**
 * Create a password verification hash
 * This is stored to verify the password is correct before attempting decryption
 *
 * @param password - The user's password
 * @param salt - Salt to use (same as encryption salt)
 * @returns Verification hash (32 bytes)
 */
export async function createPasswordVerification(
  password: string,
  salt: Uint8Array
): Promise<Uint8Array> {
  // Derive key bytes and hash them again for verification
  // This ensures we don't store anything that could be used to decrypt
  const keyBytes = await deriveKeyBytes(password, salt);

  // Use a simple hash of the key bytes as verification
  const crypto = getCrypto();
  // Convert to ArrayBuffer for Web Crypto API compatibility
  const keyBuffer = new Uint8Array(keyBytes).buffer as ArrayBuffer;
  const verificationHash = await crypto.subtle.digest('SHA-256', keyBuffer);

  return new Uint8Array(verificationHash);
}

/**
 * Verify a password against a stored verification hash
 *
 * @param password - Password to verify
 * @param salt - Salt used for key derivation
 * @param storedHash - Previously stored verification hash
 * @returns True if password is correct
 */
export async function verifyPassword(
  password: string,
  salt: Uint8Array,
  storedHash: Uint8Array
): Promise<boolean> {
  const computedHash = await createPasswordVerification(password, salt);

  // Constant-time comparison to prevent timing attacks
  if (computedHash.length !== storedHash.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < computedHash.length; i++) {
    result |= computedHash[i] ^ storedHash[i];
  }

  return result === 0;
}

// Utility functions for encoding/decoding

/**
 * Convert hex string to bytes
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Convert bytes to base64 string
 */
function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    // Node.js
    return Buffer.from(bytes).toString('base64');
  } else {
    // Browser
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}

/**
 * Convert base64 string to bytes
 */
function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    // Node.js
    return new Uint8Array(Buffer.from(base64, 'base64'));
  } else {
    // Browser
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
}

// Re-export constants for external use
export { ENCRYPTION_VERSION, SALT_LENGTH, IV_LENGTH };
