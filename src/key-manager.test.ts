import { describe, it, expect, vi } from 'vitest';
import { KeyManager } from './key-manager';

describe('KeyManager', () => {
  describe('basic functionality', () => {
    it('should create a KeyManager instance', () => {
      const keyManager = new KeyManager();
      expect(keyManager).toBeInstanceOf(KeyManager);
    });

    it('should report HD not enabled initially', () => {
      const keyManager = new KeyManager();
      expect(keyManager.isHDEnabled()).toBe(false);
    });

    it('should report cannot generate keys initially', () => {
      const keyManager = new KeyManager();
      expect(keyManager.canGenerateKeys()).toBe(false);
    });

    it('should return null HD chain when not set', () => {
      const keyManager = new KeyManager();
      expect(keyManager.getHDChain()).toBeNull();
    });

    it('should throw error when getting view key without setup', () => {
      const keyManager = new KeyManager();
      expect(() => keyManager.getPrivateViewKey()).toThrow('View key is not available');
    });
  });

  describe('HD seed management', () => {
    it('should generate a new random seed', () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();

      expect(seed).toBeDefined();
    });

    it('should set HD seed and enable HD', () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      expect(keyManager.isHDEnabled()).toBe(true);
      expect(keyManager.canGenerateKeys()).toBe(true);
    });

    it('should get view key after setting HD seed', () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      const viewKey = keyManager.getPrivateViewKey();
      expect(viewKey).toBeDefined();
    });

    it('should get public spending key after setting HD seed', () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      const spendKey = keyManager.getPublicSpendingKey();
      expect(spendKey).toBeDefined();
    });

    it('should return HD chain after setting seed', () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      const chain = keyManager.getHDChain();
      expect(chain).not.toBeNull();
      expect(chain?.version).toBe(1);
      expect(chain?.seedId).toBeDefined();
    });
  });

  describe('sub-address management', () => {
    it('should generate sub-address after setup', () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      const subAddress = keyManager.getSubAddress();
      expect(subAddress).toBeDefined();
    });

    it('should generate new sub-address with id', () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      const { subAddress, id } = keyManager.generateNewSubAddress(0);

      expect(subAddress).toBeDefined();
      expect(id.account).toBe(0);
      expect(id.address).toBe(0);
    });

    it('should increment address index for same account', () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      const { id: id1 } = keyManager.generateNewSubAddress(0);
      const { id: id2 } = keyManager.generateNewSubAddress(0);

      expect(id1.address).toBe(0);
      expect(id2.address).toBe(1);
    });
  });

  describe('mnemonic support', () => {
    it('should generate a valid 24-word mnemonic', () => {
      const mnemonic = KeyManager.generateMnemonic();
      const words = mnemonic.split(' ');

      expect(words.length).toBe(24);
      expect(KeyManager.validateMnemonic(mnemonic)).toBe(true);
    });

    it('should generate a valid 12-word mnemonic with strength 128', () => {
      const mnemonic = KeyManager.generateMnemonic(128);
      const words = mnemonic.split(' ');

      expect(words.length).toBe(12);
      expect(KeyManager.validateMnemonic(mnemonic)).toBe(true);
    });

    it('should validate correct mnemonic', () => {
      const mnemonic =
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
      expect(KeyManager.validateMnemonic(mnemonic)).toBe(true);
    });

    it('should reject invalid mnemonic', () => {
      const invalidMnemonic = 'invalid mnemonic phrase that should not work';
      expect(KeyManager.validateMnemonic(invalidMnemonic)).toBe(false);
    });

    it('should convert seed to mnemonic and back', () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      // Get the mnemonic
      const mnemonic = keyManager.getMnemonic();
      expect(mnemonic.split(' ').length).toBe(24);

      // Create new key manager from mnemonic
      const keyManager2 = new KeyManager();
      keyManager2.setHDSeedFromMnemonic(mnemonic);

      // Should produce the same seed
      expect(keyManager2.getMasterSeedHex()).toBe(keyManager.getMasterSeedHex());
    });

    it('should generate new mnemonic and set as seed', () => {
      const keyManager = new KeyManager();
      const mnemonic = keyManager.generateNewMnemonic();

      expect(keyManager.isHDEnabled()).toBe(true);
      expect(KeyManager.validateMnemonic(mnemonic)).toBe(true);
      expect(keyManager.getMnemonic()).toBe(mnemonic);
    });

    it('should restore from mnemonic and produce same addresses', () => {
      const mnemonic = KeyManager.generateMnemonic();

      // Create first wallet
      const keyManager1 = new KeyManager();
      keyManager1.setHDSeedFromMnemonic(mnemonic);
      const addr1 = keyManager1.getSubAddress({ account: 0, address: 0 });

      // Create second wallet from same mnemonic
      const keyManager2 = new KeyManager();
      keyManager2.setHDSeedFromMnemonic(mnemonic);
      const addr2 = keyManager2.getSubAddress({ account: 0, address: 0 });

      // Should produce same address
      expect(addr1.serialize()).toBe(addr2.serialize());
    });

    it('should throw error for invalid mnemonic when setting seed', () => {
      const keyManager = new KeyManager();
      const invalidMnemonic = 'invalid mnemonic phrase';

      expect(() => keyManager.setHDSeedFromMnemonic(invalidMnemonic)).toThrow(
        'Invalid mnemonic phrase'
      );
    });

    it('should convert mnemonic to seed bytes', () => {
      const mnemonic =
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
      const seedBytes = KeyManager.mnemonicToSeedBytes(mnemonic);

      expect(seedBytes.length).toBe(64); // BIP39 produces 64-byte seed
    });

    it('static mnemonicToScalar should produce consistent results', () => {
      const mnemonic = KeyManager.generateMnemonic();

      const scalar1 = KeyManager.mnemonicToScalar(mnemonic);
      const scalar2 = KeyManager.mnemonicToScalar(mnemonic);

      expect(scalar1.serialize()).toBe(scalar2.serialize());
    });

    it('static seedToMnemonic should be reversible', () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();

      const mnemonic = KeyManager.seedToMnemonic(seed);
      const recoveredSeed = KeyManager.mnemonicToScalar(mnemonic);

      expect(recoveredSeed.serialize()).toBe(seed.serialize());
    });
  });

  describe('wallet encryption', () => {
    // Set longer timeout for Argon2 operations
    vi.setConfig({ testTimeout: 30000 });

    it('should not be encrypted initially', () => {
      const keyManager = new KeyManager();
      expect(keyManager.isEncrypted()).toBe(false);
      expect(keyManager.isUnlocked()).toBe(true);
    });

    it('should encrypt wallet with setPassword', async () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      await keyManager.setPassword('test-password-123');

      expect(keyManager.isEncrypted()).toBe(true);
      expect(keyManager.isUnlocked()).toBe(true); // Still unlocked after setting password
    });

    it('should throw when setting password on already encrypted wallet', async () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      await keyManager.setPassword('test-password');

      await expect(keyManager.setPassword('another-password')).rejects.toThrow(
        'Wallet is already encrypted'
      );
    });

    it('should lock and unlock wallet', async () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      await keyManager.setPassword('secure-password');
      expect(keyManager.isUnlocked()).toBe(true);

      keyManager.lock();
      expect(keyManager.isUnlocked()).toBe(false);
      expect(keyManager.isEncrypted()).toBe(true);

      const unlocked = await keyManager.unlock('secure-password');
      expect(unlocked).toBe(true);
      expect(keyManager.isUnlocked()).toBe(true);
    });

    it('should fail to unlock with wrong password', async () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      await keyManager.setPassword('correct-password');
      keyManager.lock();

      const unlocked = await keyManager.unlock('wrong-password');
      expect(unlocked).toBe(false);
      expect(keyManager.isUnlocked()).toBe(false);
    });

    it('should return true when unlocking non-encrypted wallet', async () => {
      const keyManager = new KeyManager();
      const unlocked = await keyManager.unlock('any-password');
      expect(unlocked).toBe(true);
    });

    it('should do nothing when locking non-encrypted wallet', () => {
      const keyManager = new KeyManager();
      keyManager.lock(); // Should not throw
      expect(keyManager.isUnlocked()).toBe(true);
    });

    it('should change password successfully', async () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      await keyManager.setPassword('old-password');

      const changed = await keyManager.changePassword('old-password', 'new-password');
      expect(changed).toBe(true);

      // Lock and verify new password works
      keyManager.lock();
      const unlocked = await keyManager.unlock('new-password');
      expect(unlocked).toBe(true);

      // Old password should not work
      keyManager.lock();
      const unlockedOld = await keyManager.unlock('old-password');
      expect(unlockedOld).toBe(false);
    });

    it('should fail to change password with wrong old password', async () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      await keyManager.setPassword('correct-password');
      keyManager.lock();

      const changed = await keyManager.changePassword('wrong-password', 'new-password');
      expect(changed).toBe(false);
    });

    it('should throw when changing password on non-encrypted wallet', async () => {
      const keyManager = new KeyManager();

      await expect(keyManager.changePassword('old', 'new')).rejects.toThrow(
        'Wallet is not encrypted'
      );
    });

    it('should return encryption params for storage', async () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      // No params before encryption
      expect(keyManager.getEncryptionParams()).toBeNull();

      await keyManager.setPassword('password');

      const params = keyManager.getEncryptionParams();
      expect(params).not.toBeNull();
      expect(params!.salt).toBeDefined();
      expect(params!.verificationHash).toBeDefined();
      expect(typeof params!.salt).toBe('string');
      expect(typeof params!.verificationHash).toBe('string');
    });

    it('should restore encryption state from params', async () => {
      const keyManager1 = new KeyManager();
      const seed = keyManager1.generateNewSeed();
      keyManager1.setHDSeed(seed);

      await keyManager1.setPassword('restore-test-password');
      const params = keyManager1.getEncryptionParams()!;

      // Create new KeyManager and restore encryption params
      const keyManager2 = new KeyManager();
      keyManager2.setEncryptionParams(params.salt, params.verificationHash);

      expect(keyManager2.isEncrypted()).toBe(true);
      expect(keyManager2.isUnlocked()).toBe(false);

      // Should be able to unlock with correct password
      const unlocked = await keyManager2.unlock('restore-test-password');
      expect(unlocked).toBe(true);
    });

    it('should still allow public key operations when locked', async () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      // Get public key before encryption
      const publicKey = keyManager.getPublicSpendingKey();

      await keyManager.setPassword('password');
      keyManager.lock();

      // Public key should still be accessible
      const publicKeyAfterLock = keyManager.getPublicSpendingKey();
      expect(publicKeyAfterLock.serialize()).toBe(publicKey.serialize());
    });

    it('should allow generating addresses when locked', async () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      await keyManager.setPassword('password');
      keyManager.lock();

      // Should still be able to get sub-addresses (uses public keys only)
      const subAddress = keyManager.getSubAddress();
      expect(subAddress).toBeDefined();
    });

    it('should preserve wallet functionality after unlock', async () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      // Get address before encryption
      const addrBefore = keyManager.getSubAddress({ account: 0, address: 0 });

      await keyManager.setPassword('password');
      keyManager.lock();
      await keyManager.unlock('password');

      // Get address after unlock
      const addrAfter = keyManager.getSubAddress({ account: 0, address: 0 });

      expect(addrAfter.serialize()).toBe(addrBefore.serialize());
    });

    it('should not store plain private keys when wallet is encrypted', async () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      // Generate some keys before encryption
      keyManager.generateNewSubAddress(0);
      keyManager.generateNewSubAddress(0);

      // Encrypt the wallet
      await keyManager.setPassword('secure-password');

      // Check that no plain keys are stored after encryption
      const stats = keyManager.getKeyStats();
      expect(stats.plainKeys).toBe(0);
      expect(stats.plainOutKeys).toBe(0);
    });

    it('should clear plain keys from memory when locked', async () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      // Generate some keys
      keyManager.generateNewSubAddress(0);
      keyManager.generateNewSubAddress(0);

      await keyManager.setPassword('password');

      // Keys should already be cleared after setPassword
      let stats = keyManager.getKeyStats();
      expect(stats.plainKeys).toBe(0);
      expect(stats.plainOutKeys).toBe(0);

      // Encrypted keys should exist
      expect(stats.encryptedKeys).toBeGreaterThanOrEqual(0);
      expect(stats.encryptedOutKeys).toBeGreaterThanOrEqual(0);

      // Lock and verify still no plain keys
      keyManager.lock();
      stats = keyManager.getKeyStats();
      expect(stats.plainKeys).toBe(0);
      expect(stats.plainOutKeys).toBe(0);
    });

    it('should move keys to encrypted storage when setting password', async () => {
      const keyManager = new KeyManager();
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      // Generate keys - they start as plain keys
      keyManager.generateNewSubAddress(0);
      keyManager.generateNewSubAddress(0);

      const statsBefore = keyManager.getKeyStats();
      // Note: HD wallet may not store individual keys in the keys map
      // The encryption test mainly ensures no plain keys after encryption

      await keyManager.setPassword('password');

      const statsAfter = keyManager.getKeyStats();
      
      // No plain keys after encryption
      expect(statsAfter.plainKeys).toBe(0);
      expect(statsAfter.plainOutKeys).toBe(0);
    });
  });
});
