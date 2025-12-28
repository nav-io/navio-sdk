import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KeyManager } from './key-manager';
import type { SecretKey, PublicKey, SubAddress, SubAddressIdentifier } from './key-manager.types';

// Mock navio-blsct module
const mockBlsct = {
  genRandomSeed: vi.fn((): SecretKey => ({ type: 'secret', random: true }) as SecretKey),
  deriveMasterSK: vi.fn((_seed: Uint8Array): SecretKey => ({ type: 'secret' }) as SecretKey),
  deriveChildSK: vi.fn(
    (_parentSK: SecretKey, _index: number): SecretKey =>
      ({ type: 'secret', derived: true }) as SecretKey
  ),
  secretKeyToPublicKey: vi.fn(
    (secretKey: SecretKey): PublicKey => ({ type: 'public', from: secretKey }) as PublicKey
  ),
  secretKeyToBytes: vi.fn((_secretKey: SecretKey): Uint8Array => new Uint8Array(32)),
  publicKeyToBytes: vi.fn((_publicKey: PublicKey): Uint8Array => new Uint8Array(48)),
  bytesToSecretKey: vi.fn((_bytes: Uint8Array): SecretKey => ({ type: 'secret' }) as SecretKey),
  bytesToPublicKey: vi.fn((_bytes: Uint8Array): PublicKey => ({ type: 'public' }) as PublicKey),
  fromSeedToChildKey: vi.fn(
    (_seed: SecretKey): SecretKey => ({ type: 'secret', derived: 'child' }) as SecretKey
  ),
  fromChildToTransactionKey: vi.fn(
    (_childKey: SecretKey): SecretKey => ({ type: 'secret', derived: 'transaction' }) as SecretKey
  ),
  fromChildToBlindingKey: vi.fn(
    (_childKey: SecretKey): SecretKey => ({ type: 'secret', derived: 'blinding' }) as SecretKey
  ),
  fromChildToTokenKey: vi.fn(
    (_childKey: SecretKey): SecretKey => ({ type: 'secret', derived: 'token' }) as SecretKey
  ),
  fromTransactionToViewKey: vi.fn(
    (_txKey: SecretKey): SecretKey => ({ type: 'secret', derived: 'view' }) as SecretKey
  ),
  fromTransactionToSpendKey: vi.fn(
    (_txKey: SecretKey): SecretKey => ({ type: 'secret', derived: 'spend' }) as SecretKey
  ),
  deriveSubAddress: vi.fn(
    (_viewKey: SecretKey, _spendPublicKey: PublicKey, _id: SubAddressIdentifier): SubAddress =>
      ({ type: 'subAddress' }) as SubAddress
  ),
  calculateHashId: vi.fn(
    (_blindingKey: PublicKey, _spendingKey: PublicKey, _viewKey: SecretKey): Uint8Array =>
      new Uint8Array(20).fill(0)
  ),
  calculateViewTag: vi.fn((_blindingKey: PublicKey, _viewKey: SecretKey): number => 12345),
  calculateNonce: vi.fn(
    (_blindingKey: PublicKey, _viewKey: SecretKey): PublicKey =>
      ({ type: 'public', nonce: true }) as PublicKey
  ),
  calculatePrivateSpendingKey: vi.fn(
    (
      _blindingKey: PublicKey,
      _viewKey: SecretKey,
      _spendingKey: SecretKey,
      _account: number,
      _address: number
    ): SecretKey => ({ type: 'secret', spending: true }) as SecretKey
  ),
};

describe('KeyManager', () => {
  let keyManager: KeyManager;

  beforeEach(() => {
    keyManager = new KeyManager();
    KeyManager.initialize(mockBlsct);
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should throw error if used before initialization', () => {
      const uninitialized = new KeyManager();
      expect(() => uninitialized.generateNewSeed()).toThrow('KeyManager not initialized');
    });

    it('should work after initialization', () => {
      expect(() => keyManager.generateNewSeed()).not.toThrow();
    });
  });

  describe('HD seed management', () => {
    it('should check if HD is enabled', () => {
      expect(keyManager.isHDEnabled()).toBe(false);

      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      expect(keyManager.isHDEnabled()).toBe(true);
    });

    it('should generate a new random seed', () => {
      const seed = keyManager.generateNewSeed();

      expect(seed).toBeDefined();
      expect(mockBlsct.genRandomSeed).toHaveBeenCalledTimes(1);
    });

    it('should set HD seed and derive keys', () => {
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      expect(keyManager.isHDEnabled()).toBe(true);
      expect(keyManager.canGenerateKeys()).toBe(true);
      expect(mockBlsct.fromSeedToChildKey).toHaveBeenCalled();
      expect(mockBlsct.fromChildToTransactionKey).toHaveBeenCalled();
      expect(mockBlsct.fromTransactionToViewKey).toHaveBeenCalled();
      expect(mockBlsct.fromTransactionToSpendKey).toHaveBeenCalled();
    });

    it('should get view key after setting HD seed', () => {
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      const viewKey = keyManager.getPrivateViewKey();
      expect(viewKey).toBeDefined();
    });

    it('should get public spending key after setting HD seed', () => {
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      const spendKey = keyManager.getPublicSpendingKey();
      expect(spendKey).toBeDefined();
    });

    it('should throw error when getting view key without setup', () => {
      expect(() => keyManager.getPrivateViewKey()).toThrow('View key is not available');
    });
  });

  describe('setupGeneration', () => {
    it('should setup generation with 32-byte seed (master key)', () => {
      const seedBytes = new Uint8Array(32).fill(1);
      const result = keyManager.setupGeneration(seedBytes, 'IMPORT_MASTER_KEY');

      expect(result).toBe(true);
      expect(keyManager.isHDEnabled()).toBe(true);
    });

    it('should setup generation with 80-byte seed (view/spend keys)', () => {
      const seedBytes = new Uint8Array(80).fill(1);
      const result = keyManager.setupGeneration(seedBytes, 'IMPORT_VIEW_KEY');

      expect(result).toBe(true);
    });

    it('should generate new seed if seed length is invalid', () => {
      const seedBytes = new Uint8Array(16); // Invalid length
      const result = keyManager.setupGeneration(seedBytes);

      expect(result).toBe(true);
      expect(mockBlsct.genRandomSeed).toHaveBeenCalled();
    });

    it('should not setup if already enabled and force is false', () => {
      const seed1 = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed1);

      const seedBytes = new Uint8Array(32).fill(2);
      const result = keyManager.setupGeneration(seedBytes, 'IMPORT_MASTER_KEY', false);

      expect(result).toBe(false);
    });

    it('should setup if force is true even when already enabled', () => {
      const seed1 = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed1);

      const seedBytes = new Uint8Array(32).fill(2);
      const result = keyManager.setupGeneration(seedBytes, 'IMPORT_MASTER_KEY', true);

      expect(result).toBe(true);
    });
  });

  describe('sub-address management', () => {
    beforeEach(() => {
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);
    });

    it('should get default sub-address', () => {
      const subAddress = keyManager.getSubAddress();

      expect(subAddress).toBeDefined();
      expect(mockBlsct.deriveSubAddress).toHaveBeenCalled();
    });

    it('should generate new sub-address', () => {
      const { subAddress, id } = keyManager.generateNewSubAddress(0);

      expect(subAddress).toBeDefined();
      expect(id.account).toBe(0);
      expect(id.address).toBe(0);
    });

    it('should increment address index for same account', () => {
      const { id: id1 } = keyManager.generateNewSubAddress(0);
      const { id: id2 } = keyManager.generateNewSubAddress(0);

      expect(id1.address).toBe(0);
      expect(id2.address).toBe(1);
    });

    it('should get new destination', () => {
      const destination = keyManager.getNewDestination(0);

      expect(destination).toBeDefined();
    });

    it('should create new sub-address pool', () => {
      const result = keyManager.newSubAddressPool(0);

      expect(result).toBe(true);
      expect(keyManager.getSubAddressPoolSize(0)).toBeGreaterThan(0);
    });

    it('should top up sub-address pools', () => {
      keyManager.newSubAddressPool(0);
      const initialSize = keyManager.getSubAddressPoolSize(0);

      const result = keyManager.topUp(50);

      expect(result).toBe(true);
      expect(keyManager.getSubAddressPoolSize(0)).toBeGreaterThanOrEqual(initialSize);
    });
  });

  describe('key calculations', () => {
    beforeEach(() => {
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);
    });

    it('should calculate hash ID', () => {
      const blindingKey = mockBlsct.bytesToPublicKey(new Uint8Array(48));
      const spendingKey = mockBlsct.bytesToPublicKey(new Uint8Array(48));

      const hashId = keyManager.calculateHashId(blindingKey, spendingKey);

      expect(hashId).toBeInstanceOf(Uint8Array);
      expect(hashId.length).toBe(20);
      expect(mockBlsct.calculateHashId).toHaveBeenCalled();
    });

    it('should calculate view tag', () => {
      const blindingKey = mockBlsct.bytesToPublicKey(new Uint8Array(48));
      const viewTag = keyManager.calculateViewTag(blindingKey);

      expect(typeof viewTag).toBe('number');
      expect(mockBlsct.calculateViewTag).toHaveBeenCalled();
    });

    it('should calculate nonce', () => {
      const blindingKey = mockBlsct.bytesToPublicKey(new Uint8Array(48));
      const nonce = keyManager.calculateNonce(blindingKey);

      expect(nonce).toBeDefined();
      expect(mockBlsct.calculateNonce).toHaveBeenCalled();
    });
  });

  describe('HD chain', () => {
    it('should return null HD chain when not set', () => {
      expect(keyManager.getHDChain()).toBeNull();
    });

    it('should return HD chain after setting seed', () => {
      const seed = keyManager.generateNewSeed();
      keyManager.setHDSeed(seed);

      const chain = keyManager.getHDChain();
      expect(chain).not.toBeNull();
      expect(chain?.version).toBe(1);
      expect(chain?.seedId).toBeDefined();
    });
  });
});
