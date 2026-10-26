/**
 * KeyManager - Replicates blsct::keyman functionality from navio-core
 * Uses low-level functions from navio-blsct library
 *
 * Based on navio-blsct documentation: https://nav-io.github.io/libblsct-bindings/ts/
 */

import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import * as bip39 from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { parseBirthdayMnemonic } from './crypto/birthday-mnemonic';
import { bip39SeedRaw, deriveMasterSK, isAsciiPassphrase } from './crypto/eip2333';
// Import from navio-blsct using ESM
import * as blsctModule from '@nav-io/navio-blsct';
const Scalar = blsctModule.Scalar;
const ChildKey = blsctModule.ChildKey;
const PublicKey = blsctModule.PublicKey;
const SubAddr = blsctModule.SubAddr;
const SubAddrId = blsctModule.SubAddrId;
const DoublePublicKey = blsctModule.DoublePublicKey;
// Address encoding
const Address = blsctModule.Address;
const AddressEncoding = blsctModule.AddressEncoding;
const setChain = blsctModule.setChain;
const BlsctChain = blsctModule.BlsctChain;
// Helper functions and classes
const PrivSpendingKey = blsctModule.PrivSpendingKey;
const RangeProof = blsctModule.RangeProof;
const AmountRecoveryReq = blsctModule.AmountRecoveryReq;
const TokenId = blsctModule.TokenId;
const ViewTag = blsctModule.ViewTag;
const HashId = blsctModule.HashId;

// Derive types from runtime values using typeof
type ScalarType = InstanceType<typeof Scalar>;
// ViewKey is just a Scalar (derived via txKey.toViewKey())
type ViewKeyType = ScalarType;
type PublicKeyType = InstanceType<typeof PublicKey>;
type SubAddrType = InstanceType<typeof SubAddr>;

import type {
  HDChain,
  SubAddressIdentifier,
  SeedType,
  MnemonicDerivation,
  MnemonicOptions,
  CTxOut,
  CTxDestination,
  AmountRecoveryResult,
} from './key-manager.types';

// Encryption support
import {
  deriveKey,
  encryptWithKey,
  decryptWithKey,
  serializeEncryptedData,
  deserializeEncryptedData,
  createPasswordVerification,
  verifyPassword,
  randomBytes,
  SALT_LENGTH,
} from './crypto';
import type { EncryptedData, SerializedEncryptedData } from './crypto';

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * KeyManager class for managing BLS CT keys.
 * Replicates functionality from navio-core's blsct::keyman.
 * 
 * Handles HD key derivation, sub-address generation, output detection,
 * and amount recovery for BLSCT confidential transactions.
 * 
 * @category Keys
 */
export class KeyManager {
  private hdChain: HDChain | null = null;
  private viewKey: ViewKeyType | null = null;
  private spendPublicKey: PublicKeyType | null = null;
  private masterSeed: ScalarType | null = null;
  private storedMnemonic: string | null = null; // Store original mnemonic (avoids Scalar roundtrip issues)
  // How storedMnemonic derives masterSeed, and its BIP39 passphrase if any
  private mnemonicDerivation: MnemonicDerivation | null = null;
  private mnemonicPassphrase: string | null = null;
  private spendKeyId: Uint8Array | null = null;
  private viewKeyId: Uint8Array | null = null;
  private tokenKeyId: Uint8Array | null = null;
  private blindingKeyId: Uint8Array | null = null;
  private seedId: Uint8Array | null = null;

  // In-memory key storage (replicates KeyRing functionality)
  private keys: Map<string, ScalarType> = new Map(); // keyId (hex) -> secret key
  private outKeys: Map<string, ScalarType> = new Map(); // outId (hex) -> secret key
  private cryptedKeys: Map<string, { publicKey: PublicKeyType; encryptedSecret: Uint8Array }> =
    new Map(); // keyId -> encrypted key
  private cryptedOutKeys: Map<string, { publicKey: PublicKeyType; encryptedSecret: Uint8Array }> =
    new Map(); // outId -> encrypted key
  private keyMetadata: Map<string, { nCreateTime: number }> = new Map(); // keyId -> metadata

  // SubAddress management
  private subAddressCounter: Map<number, number> = new Map();
  private subAddresses: Map<string, SubAddressIdentifier> = new Map(); // hashId (hex) -> SubAddressIdentifier
  private subAddressesStr: Map<string, string> = new Map(); // SubAddress (serialized) -> hashId (hex)
  private subAddressPool: Map<number, Set<number>> = new Map(); // account -> Set<address indices>
  private subAddressPoolTime: Map<string, number> = new Map(); // "${account}:${address}" -> timestamp
  private timeFirstKey: number | null = null; // Creation time of first key

  // Flags
  private fViewKeyDefined = false;
  private fSpendKeyDefined = false;

  // Encryption state
  private encrypted = false;
  private encryptionSalt: Uint8Array | null = null;
  private passwordVerificationHash: Uint8Array | null = null;
  private encryptionKey: Awaited<ReturnType<typeof deriveKey>> | null = null;
  // The master seed (mnemonic or seed hex) encrypted with the wallet password.
  // Set once an encrypted wallet has been unlocked; lets lock() drop the
  // plaintext seed, and is what storage persists in place of the mnemonic.
  private cryptedSeed: Uint8Array | null = null;
  // Bumped by lock(), so an unlock() or changePassword() still awaiting
  // Argon2 when lock() runs does not unlock the wallet again afterwards.
  private lockEpoch = 0;

  /**
   * Check if HD is enabled (has a seed)
   * @returns True if HD is enabled
   */
  isHDEnabled(): boolean {
    return this.seedId !== null;
  }

  /**
   * Check if the wallet can generate new keys
   * @returns True if HD is enabled
   */
  canGenerateKeys(): boolean {
    return this.isHDEnabled();
  }

  // ============================================================================
  // Encryption Methods
  // ============================================================================

  /**
   * Check if the wallet is encrypted
   * @returns True if the wallet has been encrypted with a password
   */
  isEncrypted(): boolean {
    return this.encrypted;
  }

  /**
   * Check if the wallet is unlocked (decryption key is cached)
   * @returns True if the wallet is unlocked and can access private keys
   */
  isUnlocked(): boolean {
    return !this.encrypted || this.encryptionKey !== null;
  }

  /**
   * Set a password to encrypt the wallet
   * This encrypts all private keys and stores them in encrypted form
   * 
   * @param password - The password to encrypt the wallet with
   * @throws Error if wallet is already encrypted
   */
  async setPassword(password: string): Promise<void> {
    if (this.encrypted) {
      throw new Error('Wallet is already encrypted. Use changePassword() to change the password.');
    }

    // Generate salt for key derivation
    this.encryptionSalt = randomBytes(SALT_LENGTH);

    // Derive encryption key
    this.encryptionKey = await deriveKey(password, this.encryptionSalt);

    // Create password verification hash
    this.passwordVerificationHash = await createPasswordVerification(password, this.encryptionSalt);

    // Encrypt all existing keys
    await this.encryptAllKeys();

    // Encrypt the seed so lock() can drop the plaintext
    await this.encryptSeed();

    // Mark as encrypted
    this.encrypted = true;
  }

  /**
   * Unlock an encrypted wallet with the password
   * This derives the encryption key and caches it for decrypting private keys
   * 
   * A `lock()` while this is still running wins: the wallet stays locked and
   * the call throws `Wallet was locked during unlock`. A `changePassword()`
   * that completes first makes it throw `Wallet password was changed during
   * unlock` (the wallet stays unlocked with the new password).
   *
   * @param password - The wallet password
   * @returns True if the password is correct and wallet is unlocked
   * @throws When `lock()` was called, or the password changed, before the
   *   unlock completed
   */
  async unlock(password: string): Promise<boolean> {
    return this.unlockFor(password, 'unlock');
  }

  /**
   * {@link unlock}, naming `operation` in the error when a `lock()` wins.
   */
  private async unlockFor(password: string, operation: string): Promise<boolean> {
    if (!this.encrypted) {
      return true; // Not encrypted, always unlocked
    }

    if (!this.encryptionSalt || !this.passwordVerificationHash) {
      throw new Error('Wallet encryption state is corrupted');
    }
    const salt = this.encryptionSalt;
    const epoch = this.lockEpoch;

    // Verify password
    const isValid = await verifyPassword(password, salt, this.passwordVerificationHash);
    if (!isValid) {
      return false;
    }
    this.assertNotLockedSince(epoch, operation);

    // Derive the encryption key, and decrypt the seed lock() dropped (or that
    // was loaded encrypted) and the private keys. Nothing is committed until
    // all of it is done, so a lock() in between leaves the wallet locked.
    const encryptionKey = await deriveKey(password, salt);
    const seed = this.cryptedSeed ? await this.decryptSeed(encryptionKey) : null;
    const keys = await this.decryptKeys(encryptionKey);
    this.assertNotLockedSince(epoch, operation);

    if (seed) {
      this.masterSeed = seed.seed;
      this.storedMnemonic = seed.mnemonic;
      this.mnemonicDerivation = seed.derivation;
      this.mnemonicPassphrase = seed.passphrase;
    }
    this.encryptionKey = encryptionKey;
    for (const [keyIdHex, secretKey] of keys) {
      this.keys.set(keyIdHex, secretKey);
    }
    this.addSeedKeys();

    if (!this.cryptedSeed) {
      // Wallets encrypted before the seed was: encrypt it now, so the next
      // save stops storing it in plaintext and lock() can drop it.
      this.cryptedSeed = await this.encryptSeedWith(encryptionKey, salt);
      if (this.lockEpoch !== epoch) {
        // lock() ran before there was an encrypted copy, so it kept the
        // seed: lock again now that it can be dropped
        this.lock();
        this.assertNotLockedSince(epoch, operation);
      }
    }

    return true;
  }

  /**
   * Lock the wallet, clearing the cached encryption key, the unencrypted keys
   * and the master seed / mnemonic. After locking, private keys and the seed
   * cannot be accessed without unlocking again: `getMnemonic()`,
   * `getMasterSeedHex()` and `getMasterSeedKey()` throw.
   *
   * The view key and public keys stay in memory, so scanning and sync keep
   * working while locked.
   *
   * JavaScript cannot overwrite memory: this drops the references, and the
   * garbage collector reclaims the values at some later point.
   */
  lock(): void {
    if (!this.encrypted) {
      return; // Not encrypted, nothing to lock
    }

    // Make an unlock() or changePassword() in flight fail instead of
    // unlocking the wallet again when it completes
    this.lockEpoch++;

    // Clear cached encryption key
    this.encryptionKey = null;

    // Clear unencrypted private keys from memory
    // These are stored encrypted in cryptedKeys/cryptedOutKeys
    this.keys.clear();
    this.outKeys.clear();

    // Drop the seed; unlock() restores it from cryptedSeed. Without an
    // encrypted copy (a wallet loaded from storage that predates seed
    // encryption and was never unlocked) the plaintext is the only copy, so
    // it stays, but the getters still refuse it while locked.
    if (this.cryptedSeed) {
      this.masterSeed = null;
      this.storedMnemonic = null;
      this.mnemonicPassphrase = null;
    }

    // Note: View key is kept in memory for scanning (read-only operations)
  }

  /**
   * Change the wallet password
   * 
   * @param oldPassword - The current password
   * @param newPassword - The new password
   * @returns True if password was changed successfully
   * @throws Error if wallet is not encrypted, or when `lock()` was called
   *   before the change completed (the old password then still applies)
   */
  async changePassword(oldPassword: string, newPassword: string): Promise<boolean> {
    if (!this.encrypted) {
      throw new Error('Wallet is not encrypted. Use setPassword() first.');
    }

    // Read before the first await, so a lock() at any point fails the change
    const epoch = this.lockEpoch;

    // Verify old password
    const unlocked = await this.unlockFor(oldPassword, 'changePassword');
    if (!unlocked) {
      return false;
    }
    this.assertNotLockedSince(epoch, 'changePassword');

    // Generate new salt
    const newSalt = randomBytes(SALT_LENGTH);

    // Derive new encryption key
    const newKey = await deriveKey(newPassword, newSalt);
    this.assertNotLockedSince(epoch, 'changePassword');

    // Re-encrypt all keys and the seed (unlock() above restored it) with the
    // new key. Nothing is committed until all of it is done, so a lock() in
    // between leaves the wallet locked under the old password.
    const { cryptedKeys, cryptedOutKeys } = await this.reEncryptAllKeys(newKey, newSalt);
    const cryptedSeed = await this.encryptSeedWith(newKey, newSalt);
    const verificationHash = await createPasswordVerification(newPassword, newSalt);
    this.assertNotLockedSince(epoch, 'changePassword');

    // Update encryption parameters
    this.cryptedKeys = cryptedKeys;
    this.cryptedOutKeys = cryptedOutKeys;
    if (cryptedSeed) {
      this.cryptedSeed = cryptedSeed;
    }
    this.encryptionSalt = newSalt;
    this.encryptionKey = newKey;
    this.passwordVerificationHash = verificationHash;
    // An unlock() still running with the old password would cache the old
    // key over the new one: make it fail instead.
    this.lockEpoch++;

    return true;
  }

  /**
   * Get encryption parameters for storage
   * @returns Encryption salt and verification hash, or null if not encrypted
   */
  getEncryptionParams(): { salt: string; verificationHash: string } | null {
    if (!this.encrypted || !this.encryptionSalt || !this.passwordVerificationHash) {
      return null;
    }

    return {
      salt: this.bytesToHex(this.encryptionSalt),
      verificationHash: this.bytesToHex(this.passwordVerificationHash),
    };
  }

  /**
   * Set encryption parameters from storage (for loading encrypted wallet)
   * @param salt - Hex-encoded salt
   * @param verificationHash - Hex-encoded verification hash
   */
  setEncryptionParams(salt: string, verificationHash: string): void {
    this.encryptionSalt = this.hexToBytes(salt);
    this.passwordVerificationHash = this.hexToBytes(verificationHash);
    this.encrypted = true;
    // A wallet loaded from storage starts locked: drop any private keys a
    // plaintext seed loaded earlier derived into memory.
    if (!this.encryptionKey) {
      this.keys.clear();
      this.outKeys.clear();
    }
  }

  /**
   * The master seed encrypted with the wallet password, for storage.
   * @returns Hex of the encrypted seed, or null when the wallet is not
   *   encrypted, has no seed, or predates seed encryption and has not been
   *   unlocked since
   */
  getEncryptedSeed(): string | null {
    return this.encrypted && this.cryptedSeed ? this.bytesToHex(this.cryptedSeed) : null;
  }

  /**
   * Load the encrypted master seed from storage. The seed itself is decrypted
   * on `unlock()`.
   * @param encryptedSeedHex - Hex from {@link getEncryptedSeed}
   */
  loadEncryptedSeed(encryptedSeedHex: string): void {
    this.cryptedSeed = this.hexToBytes(encryptedSeedHex);
    this.masterSeed = null;
    this.storedMnemonic = null;
    this.mnemonicDerivation = null;
    this.mnemonicPassphrase = null;
  }

  /**
   * The seed record storage adapters persist: the encrypted seed for an
   * encrypted wallet, the mnemonic (or, for legacy wallets, the seed hex)
   * otherwise. An encrypted wallet that predates seed encryption and has not
   * been unlocked since has only its plaintext seed, which is returned so a
   * save does not lose it; the next unlock encrypts it.
   *
   * A mnemonic record carries its derivation and BIP39 passphrase, without
   * which it does not restore the same wallet. Inside the encrypted seed they
   * are encrypted too.
   * @returns The record, or null when the wallet has no seed (view-only)
   */
  getSeedForStorage():
    | { encryptedSeed: string }
    | { mnemonic: string; derivation: MnemonicDerivation; passphrase?: string }
    | { seedHex: string }
    | null {
    const encryptedSeed = this.getEncryptedSeed();
    if (encryptedSeed) {
      return { encryptedSeed };
    }
    return this.plainSeedRecord();
  }

  /**
   * The in-memory seed as a storage record (see {@link getSeedForStorage}).
   */
  private plainSeedRecord():
    | { mnemonic: string; derivation: MnemonicDerivation; passphrase?: string }
    | { seedHex: string }
    | null {
    if (this.storedMnemonic) {
      return {
        mnemonic: this.storedMnemonic,
        derivation: this.mnemonicDerivation ?? 'legacy',
        ...(this.mnemonicPassphrase ? { passphrase: this.mnemonicPassphrase } : {}),
      };
    }
    if (this.masterSeed) {
      return { seedHex: this.masterSeed.serialize().padStart(64, '0') };
    }
    return null;
  }

  /**
   * Encrypt the in-memory seed into cryptedSeed. No-op without a seed or
   * encryption key.
   */
  private async encryptSeed(): Promise<void> {
    if (!this.encryptionKey || !this.encryptionSalt) {
      return;
    }
    const cryptedSeed = await this.encryptSeedWith(this.encryptionKey, this.encryptionSalt);
    if (cryptedSeed) {
      this.cryptedSeed = cryptedSeed;
    }
  }

  /**
   * Encrypt the in-memory seed record (mnemonic with its derivation and
   * passphrase, or seed hex) with the given key.
   * @returns The encrypted record, or null without a seed
   */
  private async encryptSeedWith(
    encryptionKey: Awaited<ReturnType<typeof deriveKey>>,
    salt: Uint8Array
  ): Promise<Uint8Array | null> {
    const record = this.plainSeedRecord();
    if (!record) {
      return null;
    }
    const plaintext = new TextEncoder().encode(JSON.stringify(record));
    const encrypted = await encryptWithKey(plaintext, encryptionKey, salt);
    return this.serializeEncryptedToBytes(encrypted);
  }

  /**
   * Decrypt cryptedSeed. Does not change the wallet: unlock() commits the
   * result.
   *
   * A record without a derivation was written before derivations were
   * versioned, and derives with `'legacy'`.
   * @throws When the seed does not decrypt or does not match the HD chain
   */
  private async decryptSeed(encryptionKey: Awaited<ReturnType<typeof deriveKey>>): Promise<{
    seed: ScalarType;
    mnemonic: string | null;
    derivation: MnemonicDerivation | null;
    passphrase: string | null;
  }> {
    const encrypted = this.deserializeEncryptedFromBytes(this.cryptedSeed!);
    const plaintext = await decryptWithKey(encrypted, encryptionKey);
    const record = JSON.parse(new TextDecoder().decode(plaintext)) as {
      mnemonic?: string;
      derivation?: MnemonicDerivation;
      passphrase?: string;
      seedHex?: string;
    };
    let seed: ScalarType;
    let derivation: MnemonicDerivation | null = null;
    if (record.mnemonic) {
      derivation = record.derivation ?? 'legacy';
      seed = KeyManager.mnemonicToScalar(record.mnemonic, {
        derivation,
        passphrase: record.passphrase,
      });
    } else if (record.seedHex) {
      seed = Scalar.deserialize(record.seedHex);
    } else {
      throw new Error('Encrypted seed is corrupted');
    }
    if (
      this.seedId &&
      this.bytesToHex(this.hash160(this.getPublicKeyFromScalar(seed))) !== this.bytesToHex(this.seedId)
    ) {
      throw new Error('Encrypted seed does not match this wallet');
    }
    return {
      seed,
      mnemonic: record.mnemonic ?? null,
      derivation,
      passphrase: record.passphrase || null,
    };
  }

  /**
   * The master seed, or null while the wallet is locked or has no seed.
   */
  private unlockedSeed(): ScalarType | null {
    return this.isUnlocked() ? this.masterSeed : null;
  }

  private assertUnlocked(): void {
    if (!this.isUnlocked()) {
      throw new Error('Wallet is locked');
    }
  }

  /**
   * Throw if lock() or a password change ran since `epoch` was read, so an
   * operation that awaited in between does not undo it.
   */
  private assertNotLockedSince(epoch: number, operation: string): void {
    if (this.lockEpoch !== epoch) {
      throw new Error(
        this.encryptionKey
          ? `Wallet password was changed during ${operation}`
          : `Wallet was locked during ${operation}`
      );
    }
  }

  /**
   * Get key storage statistics (for testing/debugging)
   * @returns Object with counts of plain and encrypted keys
   */
  getKeyStats(): {
    plainKeys: number;
    plainOutKeys: number;
    encryptedKeys: number;
    encryptedOutKeys: number;
  } {
    return {
      plainKeys: this.keys.size,
      plainOutKeys: this.outKeys.size,
      encryptedKeys: this.cryptedKeys.size,
      encryptedOutKeys: this.cryptedOutKeys.size,
    };
  }

  /**
   * Encrypt all private keys in the wallet
   * Internal method called when setting password
   */
  private async encryptAllKeys(): Promise<void> {
    if (!this.encryptionKey || !this.encryptionSalt) {
      throw new Error('Encryption key not available');
    }

    // Encrypt regular keys
    for (const [keyIdHex, secretKey] of this.keys) {
      const keyBytes = this.getScalarBytes(secretKey);
      const encrypted = await encryptWithKey(keyBytes, this.encryptionKey, this.encryptionSalt);
      const publicKey = PublicKey.fromScalar(secretKey);
      this.cryptedKeys.set(keyIdHex, {
        publicKey,
        encryptedSecret: this.serializeEncryptedToBytes(encrypted),
      });
    }

    // Encrypt output keys
    for (const [outIdHex, secretKey] of this.outKeys) {
      const keyBytes = this.getScalarBytes(secretKey);
      const encrypted = await encryptWithKey(keyBytes, this.encryptionKey, this.encryptionSalt);
      const publicKey = PublicKey.fromScalar(secretKey);
      this.cryptedOutKeys.set(outIdHex, {
        publicKey,
        encryptedSecret: this.serializeEncryptedToBytes(encrypted),
      });
    }

    // Clear unencrypted keys from memory - they are now stored encrypted
    this.keys.clear();
    this.outKeys.clear();

    // Note: We keep the view key in memory for scanning, even when encrypted.
    // The master seed is encrypted separately (encryptSeed).
  }

  /**
   * Decrypt the private keys in cryptedKeys that are not already in memory.
   * Does not change the wallet: unlock() commits the result.
   * @returns keyId (hex) -> secret key, without keys that fail to decrypt
   */
  private async decryptKeys(
    encryptionKey: Awaited<ReturnType<typeof deriveKey>>
  ): Promise<Map<string, ScalarType>> {
    const keys = new Map<string, ScalarType>();
    for (const [keyIdHex, cryptedData] of this.cryptedKeys) {
      if (this.keys.has(keyIdHex)) {
        continue;
      }
      try {
        const encrypted = this.deserializeEncryptedFromBytes(cryptedData.encryptedSecret);
        const decrypted = await decryptWithKey(encrypted, encryptionKey);
        keys.set(keyIdHex, Scalar.deserialize(this.bytesToHex(decrypted)));
      } catch {
        // Skip keys that fail to decrypt
      }
    }
    return keys;
  }

  /**
   * Re-derive the master keys from the seed, if available (handles wallets
   * where keys were never stored in cryptedKeys)
   */
  private addSeedKeys(): void {
    const masterSeed = this.unlockedSeed();
    if (masterSeed) {
      const childKey = new ChildKey(masterSeed);
      const txKey = childKey.toTxKey();
      const spendKey = Scalar.deserialize(txKey.toSpendingKey().serialize());
      const blindingKey = childKey.toBlindingKey();
      const tokenKey = childKey.toTokenKey();

      this.addKeyPubKeyInner(spendKey, PublicKey.fromScalar(spendKey));
      this.addKeyPubKeyInner(masterSeed, PublicKey.fromScalar(masterSeed));
      this.addKeyPubKeyInner(tokenKey, PublicKey.fromScalar(tokenKey));
      this.addKeyPubKeyInner(blindingKey, PublicKey.fromScalar(blindingKey));
    }
  }

  /**
   * Re-encrypt all keys with a new key (for password change). Does not
   * change the wallet: changePassword() commits the result.
   * @returns The re-encrypted cryptedKeys and cryptedOutKeys
   */
  private async reEncryptAllKeys(
    newKey: Awaited<ReturnType<typeof deriveKey>>,
    newSalt: Uint8Array
  ): Promise<{
    cryptedKeys: Map<string, { publicKey: PublicKeyType; encryptedSecret: Uint8Array }>;
    cryptedOutKeys: Map<string, { publicKey: PublicKeyType; encryptedSecret: Uint8Array }>;
  }> {
    const oldKey = this.encryptionKey;
    if (!oldKey) {
      throw new Error('Wallet must be unlocked to change password');
    }

    const reEncrypt = async (
      crypted: Map<string, { publicKey: PublicKeyType; encryptedSecret: Uint8Array }>
    ) => {
      const result = new Map<string, { publicKey: PublicKeyType; encryptedSecret: Uint8Array }>();
      for (const [idHex, cryptedData] of crypted) {
        // Decrypt with old key
        const encrypted = this.deserializeEncryptedFromBytes(cryptedData.encryptedSecret);
        const decrypted = await decryptWithKey(encrypted, oldKey);

        // Re-encrypt with new key
        const reEncrypted = await encryptWithKey(decrypted, newKey, newSalt);
        result.set(idHex, {
          publicKey: cryptedData.publicKey,
          encryptedSecret: this.serializeEncryptedToBytes(reEncrypted),
        });
      }
      return result;
    };

    return {
      cryptedKeys: await reEncrypt(this.cryptedKeys),
      cryptedOutKeys: await reEncrypt(this.cryptedOutKeys),
    };
  }

  /**
   * Serialize EncryptedData to bytes for storage
   */
  private serializeEncryptedToBytes(encrypted: EncryptedData): Uint8Array {
    const serialized = serializeEncryptedData(encrypted);
    return new TextEncoder().encode(JSON.stringify(serialized));
  }

  /**
   * Deserialize EncryptedData from bytes
   */
  private deserializeEncryptedFromBytes(bytes: Uint8Array): EncryptedData {
    const json = new TextDecoder().decode(bytes);
    const serialized = JSON.parse(json) as SerializedEncryptedData;
    return deserializeEncryptedData(serialized);
  }

  // ============================================================================
  // End Encryption Methods
  // ============================================================================

  /**
   * Generate a new random seed
   * @returns A new random Scalar (seed)
   */
  generateNewSeed(): ScalarType {
    // Scalar() constructor generates a random scalar
    return new Scalar();
  }

  /**
   * Set the HD seed and derive all master keys
   * This replicates SetHDSeed from keyman.cpp
   * Uses navio-blsct API: ChildKey(seed).toTxKey().toViewKey() etc.
   *
   * An encrypted wallet's seed cannot be replaced: its encrypted seed and
   * keys would still be the old wallet's. Set up the new wallet in a new
   * KeyManager instead.
   * @param seed - The master seed Scalar
   * @throws When the wallet is encrypted
   */
  setHDSeed(seed: ScalarType): void {
    if (this.encrypted) {
      throw new Error(
        'Cannot replace the seed of an encrypted wallet; set up the new wallet in a new KeyManager'
      );
    }
    // Store master seed. A seed set directly has no mnemonic;
    // setHDSeedFromMnemonic sets these after calling this.
    this.masterSeed = seed;
    this.storedMnemonic = null;
    this.mnemonicDerivation = null;
    this.mnemonicPassphrase = null;

    // Derive keys following the same path as navio-core using navio-blsct API
    // FromSeedToChildKey: ChildKey(seed) with index 130
    const childKey = new ChildKey(seed);

    // FromChildToTransactionKey: childKey.toTxKey() (index 0)
    const txKey = childKey.toTxKey();

    // FromChildToBlindingKey: childKey.toBlindingKey() (index 1)
    const blindingKey = childKey.toBlindingKey();

    // FromChildToTokenKey: childKey.toTokenKey() (index 2)
    const tokenKey = childKey.toTokenKey();

    // FromTransactionToViewKey: txKey.toViewKey() (index 0)
    const viewKey = Scalar.deserialize(txKey.toViewKey().serialize());

    // FromTransactionToSpendKey: txKey.toSpendingKey() (index 1)
    const spendKey = Scalar.deserialize(txKey.toSpendingKey().serialize());

    // Store the derived keys
    this.viewKey = viewKey;
    // spendKey stored for future use (signing transactions)

    // Get public key from spend key
    // In navio-core, spendKey is a PrivateKey (Scalar) and we call GetPublicKey() on it
    let spendPublicKey: PublicKeyType = PublicKey.fromScalar(spendKey);

    this.spendPublicKey = spendPublicKey;

    // Mark keys as defined so isMineByKeys and other checks work
    this.fViewKeyDefined = true;
    this.fSpendKeyDefined = true;

    // Calculate IDs using hash160
    // Get public key representations for hashing
    const seedPublicKey = this.getPublicKeyFromScalar(seed);
    const viewPublicKey = this.getPublicKeyFromViewKey(viewKey);
    const spendPublicKeyBytes = this.getPublicKeyBytes(this.spendPublicKey);
    const tokenPublicKey = this.getPublicKeyFromScalar(tokenKey);
    const blindingPublicKey = this.getPublicKeyFromScalar(blindingKey);

    this.seedId = this.hash160(seedPublicKey);
    this.spendKeyId = this.hash160(spendPublicKeyBytes);
    this.viewKeyId = this.hash160(viewPublicKey);
    this.tokenKeyId = this.hash160(tokenPublicKey);
    this.blindingKeyId = this.hash160(blindingPublicKey);

    // Store derived private keys in the keys map so they can be
    // retrieved by key ID (needed for getSpendingKey, getMasterTokenKey, etc.)
    this.addKeyPubKeyInner(spendKey, spendPublicKey);
    this.addKeyPubKeyInner(seed, PublicKey.fromScalar(seed));
    this.addKeyPubKeyInner(tokenKey, PublicKey.fromScalar(tokenKey));
    this.addKeyPubKeyInner(blindingKey, PublicKey.fromScalar(blindingKey));

    // Initialize HD chain
    this.hdChain = {
      version: 1, // HDChain::VERSION_HD_BASE
      seedId: this.seedId,
      spendId: this.spendKeyId,
      viewId: this.viewKeyId,
      tokenId: this.tokenKeyId,
      blindingId: this.blindingKeyId,
    };

    // Reset sub-address counters
    this.subAddressCounter.clear();
  }

  /**
   * Setup key generation from a seed
   * Replicates SetupGeneration from keyman.cpp
   * @param seedBytes - The seed bytes (32 bytes for master key, 80 bytes for view/spend keys)
   * @param type - The type of seed being imported
   * @param force - Force setup even if HD is already enabled
   * @returns True if setup was successful
   */
  setupGeneration(
    seedBytes: Uint8Array,
    type: SeedType = 'IMPORT_MASTER_KEY',
    force = false
  ): boolean {
    if (this.canGenerateKeys() && !force) {
      return false;
    }

    if (seedBytes.length === 32) {
      if (type === 'IMPORT_MASTER_KEY') {
        // Create Scalar from bytes
        const seed = this.createScalarFromBytes(seedBytes);
        this.setHDSeed(seed);
      }
    } else if (seedBytes.length === 80) {
      if (type === 'IMPORT_VIEW_KEY') {
        // First 32 bytes are view key, last 48 bytes are spending public key
        const viewKeyBytes = seedBytes.slice(0, 32);
        const spendingKeyBytes = seedBytes.slice(32, 80);

        // Create ViewKey from bytes
        const viewKey = this.createViewKeyFromBytes(viewKeyBytes);
        // Create PublicKey from bytes
        const spendingPublicKey = this.createPublicKeyFromBytes(spendingKeyBytes);

        this.viewKey = Scalar.deserialize(viewKey.serialize());
        this.spendPublicKey = spendingPublicKey;
        this.fViewKeyDefined = true;
        this.fSpendKeyDefined = true;
      }
    } else {
      // Generate new seed
      const seed = this.generateNewSeed();
      this.setHDSeed(seed);
    }

    // Initialize sub-address pools for default accounts
    this.newSubAddressPool(0);
    this.newSubAddressPool(-1); // Change account
    this.newSubAddressPool(-2); // Staking account

    return true;
  }

  /**
   * Get the master seed key
   * @returns The master seed Scalar
   * @throws When the wallet is locked
   */
  getMasterSeedKey(): ScalarType {
    if (!this.isHDEnabled()) {
      throw new Error('HD is not enabled');
    }
    this.assertUnlocked();
    if (!this.masterSeed) {
      throw new Error('Master seed key not available');
    }
    return this.masterSeed;
  }

  // ============================================================
  // Mnemonic Support (BIP39)
  // ============================================================

  /**
   * Generate a new random mnemonic phrase (24 words)
   * @param strength - Entropy strength in bits (128=12 words, 160=15 words, 192=18 words, 224=21 words, 256=24 words)
   * @returns A BIP39 mnemonic phrase
   */
  static generateMnemonic(strength: 128 | 160 | 192 | 224 | 256 = 256): string {
    return bip39.generateMnemonic(englishWordlist, strength);
  }

  /**
   * Validate a mnemonic phrase
   * @param mnemonic - The mnemonic phrase to validate
   * @returns True if the mnemonic is valid
   */
  static validateMnemonic(mnemonic: string): boolean {
    const words = mnemonic.trim().split(/\s+/);
    if (words.length === 26) {
      // Navio birthday mnemonic: 24 BIP39 words + birthday + check word
      try {
        parseBirthdayMnemonic(mnemonic);
        return true;
      } catch {
        return false;
      }
    }
    return bip39.validateMnemonic(mnemonic, englishWordlist);
  }

  /**
   * Convert a mnemonic phrase to seed bytes
   * Uses BIP39 standard derivation with optional passphrase
   * @param mnemonic - The mnemonic phrase
   * @param passphrase - Optional passphrase for additional security
   * @returns 64-byte seed derived from mnemonic
   */
  static mnemonicToSeedBytes(mnemonic: string, passphrase = ''): Uint8Array {
    if (!KeyManager.validateMnemonic(mnemonic)) {
      throw new Error('Invalid mnemonic phrase');
    }
    // BIP39 derives a 64-byte seed from mnemonic
    return bip39.mnemonicToSeedSync(mnemonic, passphrase);
  }

  /**
   * Convert a seed (Scalar) to a mnemonic phrase
   * Note: This converts the 32-byte scalar to mnemonic using it as entropy.
   * That is the inverse of the `'legacy'` derivation only: the phrase
   * restores this seed with `derivation: 'legacy'`. The `'core'` derivation
   * hashes the entropy, so a master key has no `'core'` mnemonic.
   * @param seed - The seed Scalar
   * @returns A 24-word mnemonic phrase
   */
  static seedToMnemonic(seed: ScalarType): string {
    // Get the 32-byte seed value as entropy
    const seedHex = seed.serialize().padStart(64, '0');
    const seedBytes = hexToUint8Array(seedHex);

    if (seedBytes.length !== 32) {
      throw new Error(`Invalid seed length: ${seedBytes.length}, expected 32 bytes`);
    }

    return bip39.entropyToMnemonic(seedBytes, englishWordlist);
  }

  /**
   * Convert a mnemonic phrase to the wallet's master seed (Scalar)
   *
   * With the default `'core'` derivation this is navio-core's
   * KeyMan::SetupMnemonicFromEntropy: EIP-2333 `derive_master_SK` of the
   * 32-byte entropy, or, with a passphrase, of the BIP39 seed of the 24-word
   * sentence. It needs a 24-word mnemonic. With `'legacy'` the entropy is
   * read directly as the scalar, as navio-sdk 0.4.0 and earlier did.
   *
   * A 26-word Navio birthday mnemonic derives from its 24-word base, so the
   * wallet is identical to a plain 24-word restore.
   *
   * @param mnemonic - The mnemonic phrase
   * @param options - Derivation (default `'core'`) and BIP39 passphrase
   * @returns A Scalar seed
   * @throws On an invalid phrase, a `'core'` phrase that is not 24 (or 26)
   *   words, or a passphrase with `'legacy'`
   */
  static mnemonicToScalar(mnemonic: string, options: MnemonicOptions = {}): ScalarType {
    const derivation = options.derivation ?? 'core';
    const passphrase = options.passphrase ?? '';
    if (derivation !== 'core' && derivation !== 'legacy') {
      throw new Error(`Unknown mnemonic derivation: ${derivation}`);
    }
    if (!KeyManager.validateMnemonic(mnemonic)) {
      throw new Error('Invalid mnemonic phrase');
    }

    // Convert mnemonic back to entropy (32 bytes for a 24-word mnemonic).
    // 26-word Navio birthday mnemonics derive from their 24-word base.
    const entropy = parseBirthdayMnemonic(mnemonic).entropy;

    if (derivation === 'legacy') {
      if (passphrase) {
        throw new Error("A mnemonic passphrase requires derivation 'core'");
      }
      return Scalar.deserialize(uint8ArrayToHex(entropy));
    }

    if (entropy.length !== 32) {
      throw new Error(
        "Derivation 'core' needs a 24-word mnemonic (or 26 with the birthday words); " +
          "use derivation 'legacy' for a shorter one created by navio-sdk 0.4.0 or earlier"
      );
    }
    // navio-core stretches the 24-word sentence (never the birthday words)
    const ikm = passphrase
      ? bip39SeedRaw(bip39.entropyToMnemonic(entropy, englishWordlist), passphrase)
      : entropy;
    return Scalar.deserialize(uint8ArrayToHex(deriveMasterSK(ikm)));
  }

  /**
   * Generate a new mnemonic and set it as the HD seed
   *
   * The wallet uses navio-core's derivation, so navio-core and
   * navio-electrum restore the same wallet from the phrase.
   *
   * @param strength - Entropy strength in bits (default: 256 for 24 words).
   *   Only 256 works with the `'core'` derivation.
   * @param options - Derivation (default `'core'`) and BIP39 passphrase. A
   *   new wallet's passphrase must be ASCII, as navio-core requires.
   * @returns The mnemonic phrase that can be used to recover this wallet
   * @throws When the wallet is encrypted (see {@link setHDSeed})
   */
  generateNewMnemonic(
    strength: 128 | 160 | 192 | 224 | 256 = 256,
    options: MnemonicOptions = {}
  ): string {
    if (options.passphrase && !isAsciiPassphrase(options.passphrase)) {
      throw new Error('The mnemonic passphrase must be ASCII when creating a new wallet');
    }
    const mnemonic = KeyManager.generateMnemonic(strength);
    this.setHDSeedFromMnemonic(mnemonic, options);
    return this.getMnemonic();
  }

  /**
   * Set the HD seed from a mnemonic phrase
   *
   * Restores the wallet navio-core and navio-electrum restore from the same
   * phrase (and passphrase). A wallet created by navio-sdk 0.4.0 or earlier
   * needs `derivation: 'legacy'`. See {@link mnemonicToScalar}.
   *
   * @param mnemonic - The mnemonic phrase
   * @param options - Derivation (default `'core'`) and BIP39 passphrase
   * @throws When the wallet is encrypted (see {@link setHDSeed})
   */
  setHDSeedFromMnemonic(mnemonic: string, options: MnemonicOptions = {}): void {
    const seed = KeyManager.mnemonicToScalar(mnemonic, options);
    this.setHDSeed(seed);
    // Store the original mnemonic to avoid Scalar serialization roundtrip issues
    this.storedMnemonic = mnemonic;
    this.mnemonicDerivation = options.derivation ?? 'core';
    this.mnemonicPassphrase = options.passphrase || null;
  }

  /**
   * How the wallet's mnemonic derives its keys.
   * @returns The derivation, or null for a wallet without a mnemonic (one
   *   imported from a seed or audit key) and for an encrypted wallet loaded
   *   from storage that has not been unlocked yet
   */
  getMnemonicDerivation(): MnemonicDerivation | null {
    return this.mnemonicDerivation;
  }

  /**
   * Get the mnemonic phrase for the current seed
   *
   * A wallet imported from a raw seed has no mnemonic; for it this returns
   * {@link seedToMnemonic} of the seed, which restores the wallet only with
   * `derivation: 'legacy'`.
   *
   * @returns The mnemonic phrase for the current master seed
   * @throws When the wallet is locked
   */
  getMnemonic(): string {
    this.assertUnlocked();
    // Return stored mnemonic if available (avoids Scalar serialization roundtrip issues)
    if (this.storedMnemonic) {
      return this.storedMnemonic;
    }
    if (!this.masterSeed) {
      throw new Error('No master seed available');
    }
    // Fallback: the seed's entropy encoding, valid only for the legacy derivation
    console.warn(
      "[KeyManager] getMnemonic - no stored mnemonic; the phrase derived from the seed restores it only with derivation 'legacy'"
    );
    return KeyManager.seedToMnemonic(this.masterSeed);
  }

  /**
   * Get the master seed as a hex string
   * @returns The master seed as a 64-character hex string (32 bytes)
   * @throws When the wallet is locked
   */
  getMasterSeedHex(): string {
    this.assertUnlocked();
    if (!this.masterSeed) {
      throw new Error('No master seed available');
    }
    // Pad to 64 hex chars (32 bytes) in case leading zeros are stripped
    return this.masterSeed.serialize().padStart(64, '0');
  }

  /**
   * Get the private view key
   * @returns The view key
   */
  getPrivateViewKey(): ViewKeyType {
    if (!this.viewKey) {
      throw new Error('View key is not available');
    }
    return this.viewKey;
  }

  /**
   * Get the private view key as a fixed-width hex string.
   * Matches navio-core's 32-byte private view key encoding.
   */
  getPrivateViewKeyHex(): string {
    return this.getPrivateViewKey().serialize().padStart(64, '0');
  }

  /**
   * Get the public spending key
   * @returns The public spending key
   */
  getPublicSpendingKey(): PublicKeyType {
    if (!this.spendPublicKey) {
      throw new Error('Spending key is not available');
    }
    return this.spendPublicKey;
  }

  /**
   * Export the BLSCT audit key as fixed-width hex.
   * Matches navio-core getblsctauditkey / IMPORT_VIEW_KEY format:
   *   32-byte private view key || 48-byte public spending key
   */
  getAuditKeyHex(): string {
    const viewKeyHex = this.getPrivateViewKeyHex();
    const spendingKeyHex = this.getPublicSpendingKey().serialize().padStart(96, '0');

    return viewKeyHex + spendingKeyHex;
  }

  /**
   * Backward-compatible alias for the audit key export.
   * @deprecated Use getAuditKeyHex()
   */
  getWalletViewKeyHex(): string {
    return this.getAuditKeyHex();
  }

  /**
   * Get a sub-address for the given identifier
   * Uses navio-blsct SubAddr.generate() method
   * @param id - The sub-address identifier (defaults to account 0, address 0)
   * @returns The sub-address (SubAddr)
   */
  getSubAddress(id: SubAddressIdentifier = { account: 0, address: 0 }): SubAddrType {
    if (!this.viewKey || !this.spendPublicKey) {
      throw new Error('View key or spending key not available');
    }

    // Create SubAddrId from identifier
    // SubAddrId constructor may take a single object parameter
    // Using type assertion to work around API differences
    const subAddrId = SubAddrId.generate(id.account, id.address);

    // Generate sub-address using navio-blsct API
    // Based on docs: SubAddr.generate(viewKey, spendingPubKey, subAddrId)
    return SubAddr.generate(this.viewKey, this.spendPublicKey, subAddrId);
  }

  /**
   * Get a bech32m encoded address string for the given sub-address identifier
   * @param id - The sub-address identifier (defaults to account 0, address 0)
   * @param network - The network type ('mainnet' or 'testnet', defaults to 'mainnet')
   * @returns The bech32m encoded address string
   * @example
   * ```typescript
   * const keyManager = new KeyManager();
   * keyManager.setHDSeed(seed);
   * 
   * // Get mainnet address
   * const mainnetAddress = keyManager.getSubAddressBech32m({ account: 0, address: 0 }, 'mainnet');
   * 
   * // Get testnet address  
   * const testnetAddress = keyManager.getSubAddressBech32m({ account: 0, address: 0 }, 'testnet');
   * ```
   */
  getSubAddressBech32m(
    id: SubAddressIdentifier = { account: 0, address: 0 },
    network: 'mainnet' | 'testnet' | 'signet' | 'regtest' = 'mainnet'
  ): string {
    // Set the chain/network for proper HRP (Human Readable Part) encoding
    const chainMap = {
      mainnet: BlsctChain.Mainnet,
      testnet: BlsctChain.Testnet,
      signet: BlsctChain.Signet,
      regtest: BlsctChain.Regtest,
    } as const;
    setChain(chainMap[network] ?? BlsctChain.Mainnet);

    // Get the sub-address
    const subAddress = this.getSubAddress(id);

    // Get DoublePublicKey by deserializing the sub-address serialization
    // This is the pattern used in navio-blsct test scripts
    const serialized = subAddress.serialize();
    const dpk = DoublePublicKey.deserialize(serialized);

    // Encode as bech32m using navio-blsct Address.encode
    const address = Address.encode(dpk, AddressEncoding.Bech32M);

    // If address encoding failed (empty string), throw an error with context
    if (!address || address.length === 0) {
      throw new Error(
        `Address encoding returned empty. This may indicate a navio-blsct WASM issue. ` +
        `Serialized subAddress (${serialized.length} chars): ${serialized.substring(0, 32)}...`
      );
    }

    return address;
  }

  /**
   * Generate a new sub-address for the given account
   * @param account - The account number (0 for main, -1 for change, -2 for staking)
   * @returns The generated sub-address and its identifier
   */
  generateNewSubAddress(account: number): { subAddress: SubAddrType; id: SubAddressIdentifier } {
    if (!this.viewKey || !this.spendPublicKey) {
      throw new Error('View key or spending public key not available');
    }

    // Initialize counter if needed
    if (!this.subAddressCounter.has(account)) {
      this.subAddressCounter.set(account, 0);
    }

    const addressIndex = this.subAddressCounter.get(account)!;
    const id: SubAddressIdentifier = { account, address: addressIndex };

    // Increment counter
    this.subAddressCounter.set(account, addressIndex + 1);

    const subAddress = this.getSubAddress(id);

    // Register the hashId so the sub-address can be looked up during output scanning.
    this.subAddresses.set(this.computeSubAddressHashIdHex(account, addressIndex), id);

    return { subAddress, id };
  }

  /**
   * Compute the hash ID of the sub-address (account, addressIndex) without
   * registering it.
   *
   * The hashId is Hash160 of the sub-address spending key D (the second G1
   * point of the DoublePublicKey). In navio-core, DoublePublicKey::GetID()
   * returns sk.GetID() = Hash160(sk.GetVch()). During output detection,
   * CalculateHashId recovers D' from the output keys, and Hash160(D') ==
   * Hash160(D) for outputs belonging to this sub-address.
   */
  private computeSubAddressHashIdHex(account: number, addressIndex: number): string {
    if (!this.viewKey || !this.spendPublicKey) {
      throw new Error('View key or spending public key not available');
    }
    const dpk = DoublePublicKey.fromKeysAcctAddr(this.viewKey, this.spendPublicKey, account, addressIndex);
    const serialized = dpk.serialize();
    // DoublePublicKey serializes as 192 hex chars (96 bytes = 2 x 48-byte G1 points):
    // first 96 chars = blinding key, second 96 chars = spending key.
    const spendingKeyHex = serialized.substring(96);
    return this.bytesToHex(this.hash160(hexToUint8Array(spendingKeyHex)));
  }

  /**
   * Accounts whose sub-addresses this wallet tracks: the default receive (0),
   * change (-1) and staking (-2) accounts plus any account that has had a
   * sub-address generated or loaded.
   */
  private knownSubAddressAccounts(): number[] {
    const accounts = new Set<number>([0, -1, -2]);
    for (const account of this.subAddressCounter.keys()) accounts.add(account);
    for (const account of this.subAddressPool.keys()) accounts.add(account);
    return [...accounts];
  }

  /**
   * Default number of sub-address indices scanned past each account's
   * counter by {@link findSubAddressIdByHashId}.
   */
  static readonly SUB_ADDRESS_RECOVERY_LOOKAHEAD = 500;

  /**
   * Hard ceiling on sub-address derivations in one {@link findSubAddressIdByHashId} call.
   *
   * Recovery is a rare fallback, so it must be cheap to give up on. Each derivation is a scalar
   * multiplication on the main thread; at roughly 0.4 ms apiece this caps a miss at a couple of
   * seconds instead of the unbounded spin a large sub-address counter used to cause.
   */
  static readonly SUB_ADDRESS_RECOVERY_MAX_DERIVATIONS = 5000;

  /**
   * Locate the sub-address a hash ID belongs to when it is not in the tracked
   * set, by deriving candidate sub-addresses for every known account up to
   * `lookahead` indices past the account's counter. On a match the sub-address
   * is registered so subsequent lookups (and output scanning) find it directly.
   *
   * Sub-addresses generated past the persisted pool (e.g. fresh receive
   * addresses handed out in an earlier session) are otherwise unknown after a
   * reload, which leaves outputs already recorded in the wallet database
   * unspendable ("does not map to a known sub-address").
   *
   * @returns The sub-address identifier, or null if no candidate matches.
   */
  findSubAddressIdByHashId(
    hashId: Uint8Array,
    lookahead: number = KeyManager.SUB_ADDRESS_RECOVERY_LOOKAHEAD,
  ): SubAddressIdentifier | null {
    const hashIdHex = this.bytesToHex(hashId);
    const known = this.subAddresses.get(hashIdHex);
    if (known) {
      return { account: known.account, address: known.address };
    }
    if (!this.viewKey || !this.spendPublicKey) {
      return null;
    }

    // The scan is bounded by a derivation budget, not by the counter. `registerSubAddress`
    // advances a counter to `address + 1`, so a wallet that uses sparse or hashed sub-address
    // indices — as a bridge deriving one per user does — ends up with counters in the
    // quadrillions. Deriving from 0 up to such a counter never finishes: each step is a scalar
    // multiplication, the loop is synchronous, and the process pins a core forever with no error.
    // Observed in the wild: an automatic coin selection that never returned, taking every other
    // timer and I/O callback in the host process down with it.
    let budget = KeyManager.SUB_ADDRESS_RECOVERY_MAX_DERIVATIONS;
    for (const account of this.knownSubAddressAccounts()) {
      const limit = (this.subAddressCounter.get(account) ?? 0) + Math.max(0, lookahead);
      for (let index = 0; index < limit; index++) {
        if (budget-- <= 0) {
          // Give up rather than hang. The caller treats null as "not this wallet's output",
          // which is the same answer an exhausted scan would have produced.
          return null;
        }
        if (this.computeSubAddressHashIdHex(account, index) !== hashIdHex) {
          continue;
        }
        const id: SubAddressIdentifier = { account, address: index };
        this.registerSubAddress(hashIdHex, id);
        return { ...id };
      }
    }
    return null;
  }

  /**
   * Register a (hashId -> sub-address) mapping and keep the account's counter
   * and pool consistent with it, so later generation never reuses the index.
   */
  private registerSubAddress(hashIdHex: string, id: SubAddressIdentifier): void {
    this.subAddresses.set(hashIdHex, id);
    const counter = this.subAddressCounter.get(id.account) ?? 0;
    if (id.address >= counter) {
      this.subAddressCounter.set(id.account, id.address + 1);
    }
    if (!this.subAddressPool.has(id.account)) {
      this.subAddressPool.set(id.account, new Set());
    }
    this.subAddressPool.get(id.account)!.add(id.address);
  }

  /**
   * All tracked (hashId -> sub-address) mappings, for persistence.
   */
  getSubAddressEntries(): Array<{ hashId: string; account: number; address: number }> {
    return [...this.subAddresses.entries()].map(([hashId, id]) => ({
      hashId,
      account: id.account,
      address: id.address,
    }));
  }

  /**
   * Get a new destination (sub-address) from the pool or generate one
   * @param account - The account number
   * @returns The sub-address destination (SubAddr)
   */
  getNewDestination(account = 0): SubAddrType {
    // Top up pool if needed
    this.topUp();

    // Try to get from pool first
    const poolSize = this.getSubAddressPoolSize(account);
    if (poolSize > 0) {
      // In full implementation, would reserve from pool
      // For now, generate new one
    }

    const { subAddress } = this.generateNewSubAddress(account);
    return subAddress;
  }

  /**
   * Create a new sub-address pool for an account
   * @param account - The account number
   * @returns True if successful
   */
  newSubAddressPool(account: number): boolean {
    // Clear existing pool
    this.subAddressPool.set(account, new Set());

    // Top up the pool
    return this.topUpAccount(account);
  }

  /**
   * Top up all sub-address pools
   * @param size - Target size for pools (0 = use default)
   * @returns True if successful
   */
  topUp(size = 0): boolean {
    if (!this.canGenerateKeys()) {
      return false;
    }

    const targetSize = size > 0 ? size : 100; // DEFAULT_KEYPOOL_SIZE

    for (const account of Array.from(this.subAddressPool.keys())) {
      if (!this.topUpAccount(account, targetSize)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Top up a specific account's sub-address pool
   * @param account - The account number
   * @param size - Target size (0 = use default)
   * @returns True if successful
   */
  topUpAccount(account: number, size = 0): boolean {
    const targetSize = size > 0 ? size : 100; // DEFAULT_KEYPOOL_SIZE

    if (!this.subAddressPool.has(account)) {
      this.subAddressPool.set(account, new Set());
    }

    const pool = this.subAddressPool.get(account)!;
    const missing = Math.max(targetSize - pool.size, 0);

    for (let i = 0; i < missing; i++) {
      const { id } = this.generateNewSubAddress(account);
      pool.add(id.address);
    }

    return true;
  }

  /**
   * Get the size of the sub-address pool for an account
   * @param account - The account number
   * @returns The pool size
   */
  getSubAddressPoolSize(account: number): number {
    return this.subAddressPool.get(account)?.size ?? 0;
  }

  /**
   * Calculate hash ID from blinding and spending keys
   * Uses HashId.generate() from navio-blsct
   * @param blindingKey - The blinding public key
   * @param spendingKey - The spending public key
   * @returns The hash ID (20 bytes)
   */
  calculateHashId(blindingKey: PublicKeyType, spendingKey: PublicKeyType): Uint8Array {
    if (!this.viewKey) {
      throw new Error('View key not available');
    }

    // Use HashId.generate() from navio-blsct
    // The view key needs to be a Scalar, which is what we have
    const hashId = HashId.generate(blindingKey, spendingKey, this.viewKey);

    // HashId.serialize() returns a hex string, convert to bytes
    const hashIdHex = hashId.serialize();
    return hexToUint8Array(hashIdHex);
  }

  /**
   * Calculate view tag for output detection
   * Uses ViewTag from navio-blsct
   * @param blindingKey - The blinding public key
   * @returns The view tag (16-bit number)
   */
  calculateViewTag(blindingKey: PublicKeyType): number {
    if (!this.viewKey) {
      throw new Error('View key not available');
    }

    // ViewTag constructor computes the view tag from blinding key and view key
    // The .value property contains the numeric view tag
    const viewTagObj = new ViewTag(blindingKey, this.viewKey);
    return viewTagObj.value;
  }

  /**
   * Calculate nonce for range proof recovery
   * @param blindingKey - The blinding public key
   * @returns The nonce (suitable for AmountRecoveryReq)
   */
  calculateNonce(blindingKey: PublicKeyType): any {
    if (!this.viewKey) {
      throw new Error('View key not available');
    }

    // calcNonce returns a raw PublicKey/Point pointer from the C++ layer.
    // Wrap it via Point.fromObj to properly handle WASM pointers.
    // The C++ recovery function accepts this pointer type directly.
    const calcNonce = blsctModule.calcNonce;
    const Point = blsctModule.Point;
    const result = calcNonce(blindingKey.value(), this.viewKey.value());
    return Point.fromObj(result);
  }

  /**
   * Get the HD chain information
   * @returns The HD chain or null if not set
   */
  getHDChain(): HDChain | null {
    return this.hdChain;
  }

  // ============================================================================
  // Key Loading Methods (from database - don't persist, just load into memory)
  // ============================================================================

  /**
   * Load a key pair from storage into memory (used by LoadWallet)
   * Replicates LoadKey from keyman.cpp
   * @param secretKey - The secret key
   * @param publicKey - The public key
   * @returns True if successful
   */
  loadKey(secretKey: ScalarType, publicKey: PublicKeyType): boolean {
    return this.addKeyPubKeyInner(secretKey, publicKey);
  }

  /**
   * Load a view key from storage into memory
   * Replicates LoadViewKey from keyman.cpp
   * @param viewKey - The view key
   * @returns True if successful
   */
  loadViewKey(viewKey: ViewKeyType): boolean {
    if (!this.fViewKeyDefined) {
      this.viewKey = Scalar.deserialize(viewKey.serialize());
      this.fViewKeyDefined = true;
      return true;
    }
    return true;
  }

  /**
   * Load a spend key from storage into memory
   * Replicates LoadSpendKey from keyman.cpp
   * @param publicKey - The spending public key
   * @returns True if successful
   */
  loadSpendKey(publicKey: PublicKeyType): boolean {
    if (!this.fSpendKeyDefined) {
      this.spendPublicKey = publicKey;
      this.fSpendKeyDefined = true;
      return true;
    }
    return true;
  }

  /**
   * Load an output key from storage into memory
   * Replicates LoadOutKey from keyman.cpp
   * @param secretKey - The secret key for the output
   * @param outId - The output ID (uint256)
   * @returns True if successful
   */
  loadOutKey(secretKey: ScalarType, outId: Uint8Array): boolean {
    return this.addKeyOutKeyInner(secretKey, outId);
  }

  /**
   * Load an encrypted key from storage into memory
   * Replicates LoadCryptedKey from keyman.cpp
   * @param publicKey - The public key
   * @param encryptedSecret - The encrypted secret key
   * @param checksumValid - Whether the checksum is valid
   * @returns True if successful
   */
  loadCryptedKey(
    publicKey: PublicKeyType,
    encryptedSecret: Uint8Array,
    checksumValid: boolean
  ): boolean {
    if (!checksumValid) {
      // Note: checksum invalid - decryption may not be thorough
    }
    return this.addCryptedKeyInner(publicKey, encryptedSecret);
  }

  /**
   * Load an encrypted output key from storage into memory
   * Replicates LoadCryptedOutKey from keyman.cpp
   * @param outId - The output ID
   * @param publicKey - The public key
   * @param encryptedSecret - The encrypted secret key
   * @param checksumValid - Whether the checksum is valid
   * @returns True if successful
   */
  loadCryptedOutKey(
    outId: Uint8Array,
    publicKey: PublicKeyType,
    encryptedSecret: Uint8Array,
    checksumValid: boolean
  ): boolean {
    if (!checksumValid) {
      // Note: checksum invalid - decryption may not be thorough
    }
    return this.addCryptedOutKeyInner(outId, publicKey, encryptedSecret);
  }

  /**
   * Load HD chain from storage
   * Replicates LoadHDChain from keyman.cpp
   * @param chain - The HD chain to load
   */
  loadHDChain(chain: HDChain): void {
    this.hdChain = chain;
    this.seedId = chain.seedId;
    this.spendKeyId = chain.spendId;
    this.viewKeyId = chain.viewId;
    this.tokenKeyId = chain.tokenId;
    this.blindingKeyId = chain.blindingId;
  }

  /**
   * Load master seed from storage (legacy method)
   * @deprecated Use setHDSeedFromMnemonic instead - this method has issues with Scalar roundtripping
   * @param seedHex - The master seed as hex string
   */
  loadMasterSeed(seedHex: string): void {
    this.masterSeed = Scalar.deserialize(seedHex);
    // Note: Due to BLS Scalar modular reduction, the mnemonic derived from this seed
    // may not match the original mnemonic. Use setHDSeedFromMnemonic for correct behavior.
  }

  /**
   * Load key metadata from storage
   * Replicates LoadKeyMetadata from keyman.cpp
   * @param keyId - The key ID
   * @param metadata - The key metadata
   */
  loadKeyMetadata(keyId: Uint8Array, metadata: { nCreateTime: number }): void {
    const keyIdHex = this.bytesToHex(keyId);
    this.keyMetadata.set(keyIdHex, metadata);
    this.updateTimeFirstKey(metadata.nCreateTime);
  }

  // ============================================================================
  // Key Adding Methods (add and persist to database)
  // ============================================================================

  /**
   * Add a key pair and save to database
   * Replicates AddKeyPubKey from keyman.cpp
   * @param secretKey - The secret key
   * @param publicKey - The public key
   * @returns True if successful
   */
  addKeyPubKey(secretKey: ScalarType, publicKey: PublicKeyType): boolean {
    // Add to memory
    if (!this.addKeyPubKeyInner(secretKey, publicKey)) {
      return false;
    }
    // In a database wallet, this would also save to database
    // For in-memory KeyManager, we just store in memory
    return true;
  }

  /**
   * Add an output key and save to database
   * Replicates AddKeyOutKey from keyman.cpp
   * @param secretKey - The secret key
   * @param outId - The output ID
   * @returns True if successful
   */
  addKeyOutKey(secretKey: ScalarType, outId: Uint8Array): boolean {
    // Add to memory
    if (!this.addKeyOutKeyInner(secretKey, outId)) {
      return false;
    }
    // In a database wallet, this would also save to database
    return true;
  }

  /**
   * Add a view key and save to database
   * Replicates AddViewKey from keyman.cpp
   * @param viewKey - The view key
   * @param _publicKey - The view key's public key (unused)
   * @returns True if successful
   */
  addViewKey(viewKey: ViewKeyType, _publicKey: PublicKeyType): boolean {
    if (!this.fViewKeyDefined) {
      this.viewKey = Scalar.deserialize(viewKey.serialize());
      this.fViewKeyDefined = true;
      // In a database wallet, this would also save to database
      return true;
    }
    return true;
  }

  /**
   * Add a spend key and save to database
   * Replicates AddSpendKey from keyman.cpp
   * @param publicKey - The spending public key
   * @returns True if successful
   */
  addSpendKey(publicKey: PublicKeyType): boolean {
    if (!this.fSpendKeyDefined) {
      this.spendPublicKey = publicKey;
      this.fSpendKeyDefined = true;
      // In a database wallet, this would also save to database
      return true;
    }
    return true;
  }

  /**
   * Add an encrypted key and save to database
   * Replicates AddCryptedKey from keyman.cpp
   * @param publicKey - The public key
   * @param encryptedSecret - The encrypted secret key
   * @returns True if successful
   */
  addCryptedKey(publicKey: PublicKeyType, encryptedSecret: Uint8Array): boolean {
    if (!this.addCryptedKeyInner(publicKey, encryptedSecret)) {
      return false;
    }
    // In a database wallet, this would also save to database
    return true;
  }

  /**
   * Add an encrypted output key and save to database
   * Replicates AddCryptedOutKey from keyman.cpp
   * @param outId - The output ID
   * @param publicKey - The public key
   * @param encryptedSecret - The encrypted secret key
   * @returns True if successful
   */
  addCryptedOutKey(
    outId: Uint8Array,
    publicKey: PublicKeyType,
    encryptedSecret: Uint8Array
  ): boolean {
    if (!this.addCryptedOutKeyInner(outId, publicKey, encryptedSecret)) {
      return false;
    }
    // In a database wallet, this would also save to database
    return true;
  }

  /**
   * Add HD chain and save to database
   * Replicates AddHDChain from keyman.cpp
   * @param chain - The HD chain to add
   */
  addHDChain(chain: HDChain): void {
    this.hdChain = chain;
    this.seedId = chain.seedId;
    this.spendKeyId = chain.spendId;
    this.viewKeyId = chain.viewId;
    this.tokenKeyId = chain.tokenId;
    this.blindingKeyId = chain.blindingId;
    // In a database wallet, this would also save to database
  }

  // ============================================================================
  // Key Retrieval Methods (get keys from memory)
  // ============================================================================

  /**
   * Check if a key exists
   * Replicates HaveKey from keyman.cpp
   * @param keyId - The key ID (hash160 of public key)
   * @returns True if the key exists
   */
  haveKey(keyId: Uint8Array): boolean {
    const keyIdHex = this.bytesToHex(keyId);
    // Check unencrypted keys
    if (this.keys.has(keyIdHex)) {
      return true;
    }
    // Check encrypted keys
    if (this.cryptedKeys.has(keyIdHex)) {
      return true;
    }
    return false;
  }

  /**
   * Get a key by key ID
   * Replicates GetKey from keyman.cpp
   * @param keyId - The key ID
   * @returns The secret key or null if not found
   */
  getKey(keyId: Uint8Array): ScalarType | null {
    const keyIdHex = this.bytesToHex(keyId);
    // Try unencrypted keys first
    if (this.keys.has(keyIdHex)) {
      return this.keys.get(keyIdHex)!;
    }
    // Encrypted keys would need decryption (not implemented in in-memory version)
    return null;
  }

  /**
   * Get an output key by output ID
   * Replicates GetOutKey from keyman.cpp
   * @param outId - The output ID
   * @returns The secret key or null if not found
   */
  getOutKey(outId: Uint8Array): ScalarType | null {
    const outIdHex = this.bytesToHex(outId);
    // Try unencrypted keys first
    if (this.outKeys.has(outIdHex)) {
      return this.outKeys.get(outIdHex)!;
    }
    // Encrypted keys would need decryption (not implemented in in-memory version)
    return null;
  }

  // ============================================================================
  // Internal helper methods for key management
  // ============================================================================

  /**
   * Internal method to add a key pair (used by both Load and Add methods)
   */
  private addKeyPubKeyInner(secretKey: ScalarType, publicKey: PublicKeyType): boolean {
    const keyId = this.hash160(this.getPublicKeyBytes(publicKey));
    const keyIdHex = this.bytesToHex(keyId);
    this.keys.set(keyIdHex, secretKey);
    return true;
  }

  /**
   * Internal method to add an output key (used by both Load and Add methods)
   */
  private addKeyOutKeyInner(secretKey: ScalarType, outId: Uint8Array): boolean {
    const outIdHex = this.bytesToHex(outId);
    this.outKeys.set(outIdHex, secretKey);
    return true;
  }

  /**
   * Internal method to add an encrypted key (used by both Load and Add methods)
   */
  private addCryptedKeyInner(publicKey: PublicKeyType, encryptedSecret: Uint8Array): boolean {
    const keyId = this.hash160(this.getPublicKeyBytes(publicKey));
    const keyIdHex = this.bytesToHex(keyId);
    this.cryptedKeys.set(keyIdHex, { publicKey: publicKey, encryptedSecret });
    return true;
  }

  /**
   * Internal method to add an encrypted output key (used by both Load and Add methods)
   */
  private addCryptedOutKeyInner(
    outId: Uint8Array,
    publicKey: PublicKeyType,
    encryptedSecret: Uint8Array
  ): boolean {
    const outIdHex = this.bytesToHex(outId);
    this.cryptedOutKeys.set(outIdHex, { publicKey: publicKey, encryptedSecret });
    return true;
  }

  /**
   * Update the time of the first key
   * Replicates UpdateTimeFirstKey from keyman.cpp
   */
  private updateTimeFirstKey(_nCreateTime: number): void {
    // This would track the oldest key creation time
    // For in-memory version, we can store this if needed
    // Currently not implemented as it's mainly for database wallet tracking
  }

  // Helper methods for key conversion
  // These methods help convert between navio-blsct types and bytes
  // The actual implementation depends on navio-blsct API

  private getPublicKeyFromScalar(scalar: ScalarType): Uint8Array {
    return hexToUint8Array(PublicKey.fromScalar(scalar).serialize());
  }

  private getPublicKeyFromViewKey(viewKey: ViewKeyType): Uint8Array {
    // Convert ViewKey to public key bytes
    return this.getPublicKeyFromScalar(Scalar.deserialize(viewKey.serialize()));
  }

  private getPublicKeyBytes(publicKey: PublicKeyType): Uint8Array {
    return hexToUint8Array(publicKey.serialize());
  }


  private createScalarFromBytes(_bytes: Uint8Array): ScalarType {
    // Create Scalar from bytes
    // This would use Scalar.fromBytes() or similar based on navio-blsct API
    return Scalar.deserialize(this.bytesToHex(_bytes)); // Placeholder - needs actual API
  }

  private createViewKeyFromBytes(_bytes: Uint8Array): ViewKeyType {
    // ViewKey is just a Scalar - deserialize from hex
    return Scalar.deserialize(this.bytesToHex(_bytes));
  }

  private createPublicKeyFromBytes(_bytes: Uint8Array): PublicKeyType {
    // Create PublicKey from bytes
    // This would use PublicKey.fromBytes() or similar
    return PublicKey.deserialize(this.bytesToHex(_bytes)); // Placeholder - needs actual API
  }

  /**
   * Compute hash160 (SHA256 followed by RIPEMD160)
   * This is the standard hash function used in Bitcoin-like systems
   * @param data - The data to hash
   * @returns The hash160 result (20 bytes)
   */
  private hash160(data: Uint8Array): Uint8Array {
    // Step 1: SHA256
    const sha256Hash = sha256(data);
    // Step 2: RIPEMD160 of the SHA256 hash
    const hash160Result = ripemd160(sha256Hash);
    return hash160Result;
  }

  private bytesToHex(bytes: Uint8Array): string {
    return uint8ArrayToHex(bytes);
  }

  private hexToBytes(hex: string): Uint8Array {
    return hexToUint8Array(hex);
  }

  /**
   * Get the private spending key
   * Replicates GetSpendingKey from keyman.cpp
   * @returns The private spending key (Scalar)
   */
  getSpendingKey(): ScalarType {
    if (!this.fSpendKeyDefined) {
      throw new Error('KeyManager: the wallet has no spend key available');
    }

    if (!this.spendKeyId) {
      throw new Error('KeyManager: spend key ID not available');
    }

    const key = this.getKey(this.spendKeyId);
    if (key) {
      return key;
    }

    // Fallback: re-derive from master seed (handles encrypted wallets where
    // the key was never stored in cryptedKeys due to earlier bug)
    const masterSeed = this.unlockedSeed();
    if (masterSeed) {
      const childKey = new ChildKey(masterSeed);
      const txKey = childKey.toTxKey();
      const spendKey = Scalar.deserialize(txKey.toSpendingKey().serialize());
      const spendPublicKey = PublicKey.fromScalar(spendKey);
      this.addKeyPubKeyInner(spendKey, spendPublicKey);
      return spendKey;
    }

    throw new Error('KeyManager: could not access the spend key');
  }

  /**
   * Get spending key for a transaction output
   * Replicates GetSpendingKeyForOutput from keyman.cpp
   * @param out - The transaction output
   * @param key - Output parameter for the spending key
   * @returns True if successful
   */
  getSpendingKeyForOutput(out: CTxOut, key: { value: ScalarType | null }): boolean {
    const hashId = this.getHashIdFromTxOut(out);
    return this.getSpendingKeyForOutputById(out, hashId, key);
  }

  /**
   * Get spending key for a transaction output by hash ID
   * @param out - The transaction output
   * @param hashId - The hash ID
   * @param key - Output parameter for the spending key
   * @returns True if successful
   */
  getSpendingKeyForOutputById(
    out: CTxOut,
    hashId: Uint8Array,
    key: { value: ScalarType | null }
  ): boolean {
    const id: SubAddressIdentifier = { account: 0, address: 0 };
    if (!this.getSubAddressId(hashId, id)) {
      return false;
    }
    return this.getSpendingKeyForOutputBySubAddress(out, id, key);
  }

  /**
   * Get spending key for a transaction output by sub-address identifier
   * @param out - The transaction output
   * @param id - The sub-address identifier
   * @param key - Output parameter for the spending key
   * @returns True if successful
   */
  getSpendingKeyForOutputBySubAddress(
    out: CTxOut,
    id: SubAddressIdentifier,
    key: { value: ScalarType | null }
  ): boolean {
    if (!this.fViewKeyDefined || !this.viewKey) {
      throw new Error('KeyManager: the wallet has no view key available');
    }

    const sk = this.getSpendingKey();

    const blindingKey = out.blsctData.blindingKey as PublicKeyType;
    const viewKeyScalar = this.getScalarFromViewKey(this.viewKey);
    const spendingKeyScalar = this.getScalarFromScalar(sk);

    key.value = new PrivSpendingKey(
      blindingKey,
      viewKeyScalar,
      spendingKeyScalar,
      id.account,
      id.address
    );
    return true;
  }

  /**
   * Get spending key for output with caching
   * Replicates GetSpendingKeyForOutputWithCache from keyman.cpp
   * @param out - The transaction output
   * @param key - Output parameter for the spending key
   * @returns True if successful
   */
  getSpendingKeyForOutputWithCache(out: CTxOut, key: { value: ScalarType | null }): boolean {
    const hashId = this.getHashIdFromTxOut(out);
    return this.getSpendingKeyForOutputWithCacheById(out, hashId, key);
  }

  /**
   * Get spending key for output with caching by hash ID
   * @param out - The transaction output
   * @param hashId - The hash ID
   * @param key - Output parameter for the spending key
   * @returns True if successful
   */
  getSpendingKeyForOutputWithCacheById(
    out: CTxOut,
    hashId: Uint8Array,
    key: { value: ScalarType | null }
  ): boolean {
    const id: SubAddressIdentifier = { account: 0, address: 0 };
    if (!this.getSubAddressId(hashId, id)) {
      return false;
    }
    return this.getSpendingKeyForOutputWithCacheBySubAddress(out, id, key);
  }

  /**
   * Get spending key for output with caching by sub-address
   * @param out - The transaction output
   * @param id - The sub-address identifier
   * @param key - Output parameter for the spending key
   * @returns True if successful
   */
  getSpendingKeyForOutputWithCacheBySubAddress(
    out: CTxOut,
    id: SubAddressIdentifier,
    key: { value: ScalarType | null }
  ): boolean {
    if (!this.fViewKeyDefined || !this.viewKey) {
      throw new Error('KeyManager: the wallet has no view key available');
    }

    const sk = this.getSpendingKey();

    // Calculate outId for caching: Hash(blindingKey || viewKey || spendingKey || account || address)
    const blindingKey = out.blsctData.blindingKey as PublicKeyType;
    const viewKeyScalar = this.getScalarFromViewKey(this.viewKey);
    const spendingKeyScalar = this.getScalarFromScalar(sk);

    const outIdData = new Uint8Array(
      this.getPublicKeyBytes(blindingKey).length +
        this.getScalarBytes(viewKeyScalar).length +
        this.getScalarBytes(spendingKeyScalar).length +
        8 +
        8 // account (int64) + address (uint64)
    );
    let offset = 0;
    outIdData.set(this.getPublicKeyBytes(blindingKey), offset);
    offset += this.getPublicKeyBytes(blindingKey).length;
    outIdData.set(this.getScalarBytes(viewKeyScalar), offset);
    offset += this.getScalarBytes(viewKeyScalar).length;
    outIdData.set(this.getScalarBytes(spendingKeyScalar), offset);
    offset += this.getScalarBytes(spendingKeyScalar).length;

    // Write account and address as little-endian
    const accountView = new DataView(outIdData.buffer, offset, 8);
    accountView.setBigInt64(0, BigInt(id.account), true);
    offset += 8;
    const addressView = new DataView(outIdData.buffer, offset, 8);
    addressView.setBigUint64(0, BigInt(id.address), true);

    const outId = sha256(outIdData);

    // Check cache first
    const cachedKey = this.getOutKey(outId);
    if (cachedKey) {
      key.value = cachedKey;
      return true;
    }

    const calculatedKey = new PrivSpendingKey(
      blindingKey,
      viewKeyScalar,
      spendingKeyScalar,
      id.account,
      id.address
    );

    // Cache it
    this.addKeyOutKey(calculatedKey, outId);
    key.value = calculatedKey;
    return true;
  }

  // ============================================================================
  // High Priority: Output Detection
  // ============================================================================

  /**
   * Check if a transaction output belongs to this wallet
   * Replicates IsMine(txout) from keyman.cpp
   * @param txout - The transaction output
   * @returns True if the output belongs to this wallet
   */
  isMine(txout: CTxOut): boolean {
    // Check if spendingKey is zero (extract from script)
    const spendingKey = txout.blsctData.spendingKey as PublicKeyType;
    const isZero = this.isPublicKeyZero(spendingKey);

    if (isZero) {
      // Try to extract spending key from script
      const extractedSpendingKey: { value: PublicKeyType | null } = { value: null };
      if (this.extractSpendingKeyFromScript(txout.scriptPubKey, extractedSpendingKey)) {
        return this.isMineByKeys(
          txout.blsctData.blindingKey as PublicKeyType,
          extractedSpendingKey.value!,
          txout.blsctData.viewTag
        );
      }
      return false;
    }

    return this.isMineByKeys(
      txout.blsctData.blindingKey as PublicKeyType,
      spendingKey,
      txout.blsctData.viewTag
    );
  }

  /**
   * Check if output belongs to wallet by keys
   * Replicates IsMine(blindingKey, spendingKey, viewTag) from keyman.cpp
   * @param blindingKey - The blinding public key
   * @param spendingKey - The spending public key
   * @param viewTag - The view tag
   * @returns True if the output belongs to this wallet
   */
  isMineByKeys(blindingKey: PublicKeyType, spendingKey: PublicKeyType, viewTag: number): boolean {
    if (!this.fViewKeyDefined || !this.viewKey) {
      console.log(`[isMineByKeys] viewKey not defined, returning false`);
      return false;
    }

    // Check view tag - fast filter for outputs not intended for us
    const calculatedViewTag = this.calculateViewTag(blindingKey);
    if (viewTag !== calculatedViewTag) {
      return false;
    }

    // ViewTag matched! Log this rare event.
    const hashId = this.getHashId(blindingKey, spendingKey);
    const hashIdHex = this.bytesToHex(hashId);
    const result = this.haveSubAddress(hashId);
    console.log(`[isMineByKeys] ViewTag MATCH! expected=${viewTag}, calculated=${calculatedViewTag}, hashId=${hashIdHex}, haveSubAddr=${result}, subAddressPoolSize=${this.subAddresses.size}`);
    return result;
  }

  /**
   * Check if a script belongs to this wallet
   * Replicates IsMine(script) from keyman.cpp
   * @param _script - The script (unused)
   * @returns True if the script belongs to this wallet
   */
  isMineByScript(_script: Uint8Array): boolean {
    // This checks watch-only scripts
    // For in-memory KeyManager, we don't have watch-only support yet
    // Return false for now
    return false;
  }

  /**
   * Get hash ID from transaction output
   * Replicates GetHashId(txout) from keyman.cpp
   * @param txout - The transaction output
   * @returns The hash ID (20 bytes) or empty if not valid
   */
  getHashIdFromTxOut(txout: CTxOut): Uint8Array {
    // Check if script is spendable or is staked commitment
    // For now, we'll assume it's spendable if it has BLS CT data
    if (!txout.blsctData || txout.blsctData.viewTag === 0) {
      return new Uint8Array(20); // Return empty hash ID
    }

    const spendingKey = txout.blsctData.spendingKey as PublicKeyType;
    const isZero = this.isPublicKeyZero(spendingKey);

    if (isZero) {
      // Try to extract from script
      const extractedSpendingKey: { value: PublicKeyType | null } = { value: null };
      if (this.extractSpendingKeyFromScript(txout.scriptPubKey, extractedSpendingKey)) {
        return this.getHashId(
          txout.blsctData.blindingKey as PublicKeyType,
          extractedSpendingKey.value!
        );
      }
      return new Uint8Array(20); // Return empty hash ID
    }

    return this.getHashId(txout.blsctData.blindingKey as PublicKeyType, spendingKey);
  }

  /**
   * Get hash ID from keys (public API)
   * Replicates GetHashId(blindingKey, spendingKey) from keyman.cpp
   * @param blindingKey - The blinding public key
   * @param spendingKey - The spending public key
   * @returns The hash ID (20 bytes)
   */
  getHashId(blindingKey: PublicKeyType, spendingKey: PublicKeyType): Uint8Array {
    if (!this.fViewKeyDefined || !this.viewKey) {
      throw new Error('KeyManager: the wallet has no view key available');
    }

    // Use the existing calculateHashId method
    return this.calculateHashId(blindingKey, spendingKey);
  }

  /**
   * Get destination from transaction output
   * Replicates GetDestination from keyman.cpp
   * @param txout - The transaction output
   * @returns The destination (SubAddress keys) or null
   */
  getDestination(txout: CTxOut): CTxDestination | null {
    const hashId = this.getHashIdFromTxOut(txout);
    const subAddress: { value: SubAddrType | null } = { value: null };

    if (!this.getSubAddressByHashId(hashId, subAddress)) {
      return null;
    }

    // Return the sub-address keys as destination
    return subAddress.value as unknown as CTxDestination;
  }

  /**
   * Check if output is a change output
   * Replicates OutputIsChange from keyman.cpp
   * @param out - The transaction output
   * @returns True if it's a change output (account -1)
   */
  outputIsChange(out: CTxOut): boolean {
    const hashId = this.getHashIdFromTxOut(out);
    const id: SubAddressIdentifier = { account: 0, address: 0 };

    if (!this.getSubAddressId(hashId, id)) {
      return false;
    }

    return id.account === -1; // Change account
  }

  // ============================================================================
  // Medium Priority: Token Keys
  // ============================================================================

  /**
   * Get master token key
   * Replicates GetMasterTokenKey from keyman.cpp
   * @returns The master token key (Scalar)
   */
  getMasterTokenKey(): ScalarType {
    if (!this.isHDEnabled()) {
      throw new Error('KeyManager: the wallet has no HD enabled');
    }

    if (!this.tokenKeyId) {
      throw new Error('KeyManager: token key ID not available');
    }

    const key = this.getKey(this.tokenKeyId);
    if (key) {
      return key;
    }

    const masterSeed = this.unlockedSeed();
    if (masterSeed) {
      const childKey = new ChildKey(masterSeed);
      const tokenKey = childKey.toTokenKey();
      this.addKeyPubKeyInner(tokenKey, PublicKey.fromScalar(tokenKey));
      return tokenKey;
    }

    throw new Error('KeyManager: could not access the master token key');
  }

  /**
   * Recover amounts from transaction outputs
   * Replicates RecoverOutputs from keyman.cpp
   * Uses navio-blsct recoverAmount function
   * Reference: https://nav-io.github.io/libblsct-bindings/ts/functions/recoverAmount.html
   * @param outs - Array of transaction outputs
   * @returns Recovery result with amounts and indices
   */
  recoverOutputs(outs: CTxOut[]): AmountRecoveryResult {
    if (!this.fViewKeyDefined || !this.viewKey) {
      return { success: false, amounts: [], indices: [] };
    }

    const reqs: InstanceType<typeof AmountRecoveryReq>[] = [];
    const outputIndices: number[] = [];

    for (let i = 0; i < outs.length; i++) {
      const out = outs[i];

      if (!out.blsctData || !out.blsctData.rangeProof) {
        continue;
      }

      const calculatedViewTag = this.calculateViewTag(out.blsctData.blindingKey as PublicKeyType);
      if (out.blsctData.viewTag !== calculatedViewTag) {
        continue;
      }

      const nonce = this.calculateNonce(out.blsctData.blindingKey as PublicKeyType);
      const tokenIdHex = out.tokenId ? uint8ArrayToHex(new Uint8Array(out.tokenId)) : null;
      const tokenId = tokenIdHex ? TokenId.deserialize(tokenIdHex) : TokenId.default();

      reqs.push(new AmountRecoveryReq(out.blsctData.rangeProof as any, nonce, tokenId));
      outputIndices.push(i);
    }

    if (reqs.length === 0) {
      return { success: false, amounts: [], indices: [] };
    }

    const results = RangeProof.recoverAmounts(reqs);
    const amounts: bigint[] = [];
    const indices: number[] = [];
    let allSuccess = true;

    for (let j = 0; j < results.length; j++) {
      if (results[j].isSucc) {
        amounts.push(results[j].amount);
        indices.push(outputIndices[j]);
      } else {
        allSuccess = false;
      }
    }

    return {
      success: allSuccess && amounts.length > 0,
      amounts,
      indices,
    };
  }

  /**
   * Recover amounts from transaction outputs with nonce
   * Replicates RecoverOutputsWithNonce from keyman.cpp
   * @param outs - Array of transaction outputs
   * @param nonce - The nonce (PublicKey)
   * @returns Recovery result with amounts and indices
   */
  recoverOutputsWithNonce(outs: CTxOut[], nonce: PublicKeyType): AmountRecoveryResult {
    if (!this.fViewKeyDefined || !this.viewKey) {
      return { success: false, amounts: [], indices: [] };
    }

    const noncePoint = nonce.getPoint();
    const reqs: InstanceType<typeof AmountRecoveryReq>[] = [];
    const outputIndices: number[] = [];

    for (let i = 0; i < outs.length; i++) {
      const out = outs[i];

      if (!out.blsctData || !out.blsctData.rangeProof) {
        continue;
      }

      const tokenIdHex = out.tokenId ? uint8ArrayToHex(new Uint8Array(out.tokenId)) : null;
      const tokenId = tokenIdHex ? TokenId.deserialize(tokenIdHex) : TokenId.default();

      reqs.push(new AmountRecoveryReq(out.blsctData.rangeProof as any, noncePoint, tokenId));
      outputIndices.push(i);
    }

    if (reqs.length === 0) {
      return { success: false, amounts: [], indices: [] };
    }

    const results = RangeProof.recoverAmounts(reqs);
    const amounts: bigint[] = [];
    const indices: number[] = [];
    let allSuccess = true;

    for (let j = 0; j < results.length; j++) {
      if (results[j].isSucc) {
        amounts.push(results[j].amount);
        indices.push(outputIndices[j]);
      } else {
        allSuccess = false;
      }
    }

    return {
      success: allSuccess && amounts.length > 0,
      amounts,
      indices,
    };
  }

  // ============================================================================
  // Medium Priority: SubAddress by Hash ID
  // ============================================================================

  /**
   * Load sub-address mapping from storage
   * Replicates LoadSubAddress from keyman.cpp
   * @param hashId - The hash ID
   * @param index - The sub-address identifier
   */
  loadSubAddress(hashId: Uint8Array, index: SubAddressIdentifier): void {
    this.registerSubAddress(this.bytesToHex(hashId), { account: index.account, address: index.address });
  }

  /**
   * Add sub-address mapping and save to database
   * Replicates AddSubAddress from keyman.cpp
   * @param hashId - The hash ID
   * @param index - The sub-address identifier
   * @returns True if successful
   */
  addSubAddress(hashId: Uint8Array, index: SubAddressIdentifier): boolean {
    this.registerSubAddress(this.bytesToHex(hashId), { account: index.account, address: index.address });
    // Persistence is the wallet database's job (IWalletDB.saveSubAddresses)
    return true;
  }

  /**
   * Check if sub-address exists by hash ID
   * Replicates HaveSubAddress from keyman.cpp
   * @param hashId - The hash ID
   * @returns True if the sub-address exists
   */
  haveSubAddress(hashId: Uint8Array): boolean {
    const hashIdHex = this.bytesToHex(hashId);
    return this.subAddresses.has(hashIdHex);
  }

  /**
   * Get sub-address by hash ID
   * Replicates GetSubAddress(hashId) from keyman.cpp
   * @param hashId - The hash ID
   * @param address - Output parameter for the sub-address
   * @returns True if successful
   */
  getSubAddressByHashId(hashId: Uint8Array, address: { value: SubAddrType | null }): boolean {
    if (!this.haveSubAddress(hashId)) {
      return false;
    }

    const hashIdHex = this.bytesToHex(hashId);
    const id = this.subAddresses.get(hashIdHex)!;
    address.value = this.getSubAddress(id);
    return true;
  }

  /**
   * Get sub-address identifier from hash ID
   * Replicates GetSubAddressId from keyman.cpp
   * @param hashId - The hash ID
   * @param id - Output parameter for the sub-address identifier
   * @returns True if successful
   */
  getSubAddressId(hashId: Uint8Array, id: SubAddressIdentifier): boolean {
    if (!this.haveSubAddress(hashId)) {
      return false;
    }

    const hashIdHex = this.bytesToHex(hashId);
    const storedId = this.subAddresses.get(hashIdHex)!;
    id.account = storedId.account;
    id.address = storedId.address;
    return true;
  }

  /**
   * Load sub-address string mapping from storage
   * Replicates LoadSubAddressStr from keyman.cpp
   * @param subAddress - The sub-address
   * @param hashId - The hash ID
   */
  loadSubAddressStr(subAddress: SubAddrType, hashId: Uint8Array): void {
    const subAddressStr = this.serializeSubAddress(subAddress);
    const hashIdHex = this.bytesToHex(hashId);
    this.subAddressesStr.set(subAddressStr, hashIdHex);
  }

  /**
   * Add sub-address string mapping and save to database
   * Replicates AddSubAddressStr from keyman.cpp
   * @param subAddress - The sub-address
   * @param hashId - The hash ID
   * @returns True if successful
   */
  addSubAddressStr(subAddress: SubAddrType, hashId: Uint8Array): boolean {
    const subAddressStr = this.serializeSubAddress(subAddress);
    const hashIdHex = this.bytesToHex(hashId);
    this.subAddressesStr.set(subAddressStr, hashIdHex);
    // In a database wallet, this would also save to database
    return true;
  }

  /**
   * Check if sub-address string exists
   * Replicates HaveSubAddressStr from keyman.cpp
   * @param subAddress - The sub-address
   * @returns True if the sub-address string exists
   */
  haveSubAddressStr(subAddress: SubAddrType): boolean {
    const subAddressStr = this.serializeSubAddress(subAddress);
    return this.subAddressesStr.has(subAddressStr);
  }

  // ============================================================================
  // Medium Priority: SubAddress Pool Management
  // ============================================================================

  /**
   * Reserve sub-address from pool
   * Replicates ReserveSubAddressFromPool from keyman.cpp
   * @param account - The account number
   * @param nIndex - Output parameter for the address index
   * @param keypool - Output parameter for the keypool entry
   */
  reserveSubAddressFromPool(
    account: number,
    nIndex: { value: number },
    keypool: { value: { id: SubAddressIdentifier; subAddress: SubAddrType } | null }
  ): void {
    const pool = this.subAddressPool.get(account);
    if (!pool || pool.size === 0) {
      throw new Error('KeyManager: Sub-address pool is empty');
    }

    // Get first available index
    const index = Array.from(pool)[0];
    pool.delete(index);

    const id: SubAddressIdentifier = { account, address: index };
    const subAddress = this.getSubAddress(id);

    nIndex.value = index;
    keypool.value = { id, subAddress };
  }

  /**
   * Keep a sub-address (mark as used)
   * Replicates KeepSubAddress from keyman.cpp
   * @param id - The sub-address identifier
   */
  keepSubAddress(id: SubAddressIdentifier): void {
    const pool = this.subAddressPool.get(id.account);
    if (pool) {
      pool.delete(id.address);
    }
    // Update time if needed
    const key = `${id.account}:${id.address}`;
    this.subAddressPoolTime.delete(key);
  }

  /**
   * Return sub-address to pool
   * Replicates ReturnSubAddress from keyman.cpp
   * @param id - The sub-address identifier
   */
  returnSubAddress(id: SubAddressIdentifier): void {
    const pool = this.subAddressPool.get(id.account);
    if (pool) {
      pool.add(id.address);
      // Update time
      const key = `${id.account}:${id.address}`;
      this.subAddressPoolTime.set(key, Date.now());
    }
  }

  /**
   * Get sub-address from pool
   * Replicates GetSubAddressFromPool from keyman.cpp
   * @param account - The account number
   * @param result - Output parameter for the hash ID
   * @param id - Output parameter for the sub-address identifier
   * @returns True if successful
   */
  getSubAddressFromPool(
    account: number,
    result: { value: Uint8Array | null },
    id: { value: SubAddressIdentifier | null }
  ): boolean {
    const pool = this.subAddressPool.get(account);
    if (!pool || pool.size === 0) {
      return false;
    }

    const index = Array.from(pool)[0];
    const subAddressId: SubAddressIdentifier = { account, address: index };
    const subAddress = this.getSubAddress(subAddressId);

    // Get hash ID from sub-address
    // This requires getting the keys from SubAddress and calculating hash ID
    // For now, we'll need to extract keys from SubAddress
    const hashId = this.getHashIdFromSubAddress(subAddress);

    result.value = hashId;
    id.value = subAddressId;
    return true;
  }

  /**
   * Get oldest sub-address pool time
   * Replicates GetOldestSubAddressPoolTime from keyman.cpp
   * @param account - The account number
   * @returns The oldest time or 0 if pool is empty
   */
  getOldestSubAddressPoolTime(account: number): number {
    const pool = this.subAddressPool.get(account);
    if (!pool || pool.size === 0) {
      return 0;
    }

    let oldestTime = Number.MAX_SAFE_INTEGER;
    for (const index of Array.from(pool)) {
      const key = `${account}:${index}`;
      const time = this.subAddressPoolTime.get(key) || 0;
      if (time < oldestTime && time > 0) {
        oldestTime = time;
      }
    }

    return oldestTime === Number.MAX_SAFE_INTEGER ? 0 : oldestTime;
  }

  // ============================================================================
  // Low Priority: Utilities
  // ============================================================================

  /**
   * Add inactive HD chain
   * Replicates AddInactiveHDChain from keyman.cpp
   * @param _chain - The HD chain to add (unused)
   */
  addInactiveHDChain(_chain: HDChain): void {
    // For in-memory KeyManager, we only support one active chain
    // This would be used in database wallet for tracking inactive chains
    // Not implemented for in-memory version
  }

  /**
   * Get time of first key
   * Replicates GetTimeFirstKey from keyman.cpp
   * @returns The creation time of the first key
   */
  getTimeFirstKey(): number {
    return this.timeFirstKey || 0;
  }

  /**
   * Extract spending key from script
   * Replicates ExtractSpendingKeyFromScript from keyman.cpp
   * @param _script - The script (unused)
   * @param _spendingKey - Output parameter for the spending key (unused)
   * @returns True if successful
   */
  extractSpendingKeyFromScript(
    _script: Uint8Array,
    _spendingKey: { value: PublicKeyType | null }
  ): boolean {
    // This extracts spending key from OP_BLSCHECKSIG script
    // For now, return false - needs script parsing implementation
    // TODO: Implement script parsing for OP_BLSCHECKSIG
    return false;
  }

  // ============================================================================
  // Helper methods for new functionality
  // ============================================================================

  /**
   * Check if public key is zero
   */
  private isPublicKeyZero(_publicKey: PublicKeyType): boolean {
    // Check if public key is zero/identity
    // This needs navio-blsct API - for now, return false
    // TODO: Implement when navio-blsct provides IsZero() method
    return false;
  }

  /**
   * Get scalar from ViewKey
   */
  private getScalarFromViewKey(viewKey: ViewKeyType): ScalarType {
    return Scalar.deserialize(viewKey.serialize());
  }

  /**
   * Get scalar from Scalar (identity function, but ensures type)
   */
  private getScalarFromScalar(scalar: ScalarType): ScalarType {
    return scalar;
  }

  /**
   * Get bytes from Scalar
   */
  private getScalarBytes(scalar: ScalarType): Uint8Array {
    // serialize() drops leading zero nibbles; pad back to 32 bytes
    return hexToUint8Array(scalar.serialize().padStart(64, '0'));
  }

  /**
   * Serialize SubAddress to string for map key
   */
  private serializeSubAddress(subAddress: SubAddrType): string {
    // Serialize SubAddress to a string for use as map key
    // This needs navio-blsct API
    return subAddress.serialize();
  }

  /**
   * Get hash ID from SubAddress
   * Uses DoublePublicKey.deserialize(subaddress.serialize()) to extract keys
   */
  private getHashIdFromSubAddress(subAddress: SubAddrType): Uint8Array {
    // Extract keys from SubAddress using DoublePublicKey
    // Method: DoublePublicKey.deserialize(subaddress.serialize())
    const serialized = (subAddress as any).serialize();
    const doublePublicKey = DoublePublicKey.deserialize(serialized);

    // Get keys from DoublePublicKey
    // Need to check navio-blsct API for getting individual keys
    // For now, try common method names
    const keys = (doublePublicKey as any).getKeys
      ? (doublePublicKey as any).getKeys()
      : doublePublicKey;

    // Extract spending and blinding keys
    // DoublePublicKey typically contains two public keys
    const spendingKey = (keys as any).spendingKey || (keys as any).key1 || keys;
    const blindingKey = (keys as any).blindingKey || (keys as any).key2 || keys;

    // Calculate hash ID
    return this.getHashId(blindingKey as PublicKeyType, spendingKey as PublicKeyType);
  }
}
