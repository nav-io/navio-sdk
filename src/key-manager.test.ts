import { describe, it, expect } from 'vitest';
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
});
