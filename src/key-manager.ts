/**
 * KeyManager - Replicates blsct::keyman functionality from navio-core
 * Uses low-level functions from navio-blsct library
 *
 * Based on navio-blsct documentation: https://nav-io.github.io/libblsct-bindings/ts/
 */

import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
// Import runtime values using require (for CommonJS compatibility)
const blsctModule = require('navio-blsct');
const Scalar = blsctModule.Scalar;
const ChildKey = blsctModule.ChildKey;
const ViewKey = blsctModule.ViewKey;
const PublicKey = blsctModule.PublicKey;
const SubAddr = blsctModule.SubAddr;
const SubAddrId = blsctModule.SubAddrId;
const DoublePublicKey = blsctModule.DoublePublicKey;
// Helper functions and classes
const calcPrivSpendingKey = blsctModule.calcPrivSpendingKey;
const recoverAmount = blsctModule.recoverAmount;
const ViewTag = blsctModule.ViewTag;
const HashId = blsctModule.HashId;
const calcNonce = blsctModule.calcNonce;

// Derive types from runtime values using typeof
type ScalarType = InstanceType<typeof Scalar>;
type ViewKeyType = InstanceType<typeof ViewKey>;
type PublicKeyType = InstanceType<typeof PublicKey>;
type SubAddrType = InstanceType<typeof SubAddr>;

import type {
  HDChain,
  SubAddressIdentifier,
  SeedType,
  CTxOut,
  CTxDestination,
  AmountRecoveryResult,
} from './key-manager.types';

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
   * @param seed - The master seed Scalar
   */
  setHDSeed(seed: ScalarType): void {
    // Store master seed
    this.masterSeed = seed;

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

        // Note: This is a simplified import - full implementation would need more setup
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
   */
  getMasterSeedKey(): ScalarType {
    if (!this.isHDEnabled()) {
      throw new Error('HD is not enabled');
    }
    if (!this.masterSeed) {
      throw new Error('Master seed key not available');
    }
    return this.masterSeed;
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
   * Generate a new sub-address for the given account
   * @param account - The account number (0 for main, -1 for change, -2 for staking)
   * @returns The generated sub-address and its identifier
   */
  generateNewSubAddress(account: number): { subAddress: SubAddrType; id: SubAddressIdentifier } {
    if (!this.canGenerateKeys()) {
      throw new Error('Cannot generate keys - HD not enabled');
    }

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

    // Calculate hashId for this sub-address so we can look it up during output scanning
    // Generate DoublePublicKey which contains (blindingKey, spendingKey) for this sub-address
    const dpk = DoublePublicKey.fromKeysAcctAddr(this.viewKey, this.spendPublicKey, account, addressIndex);
    const serialized = dpk.serialize();

    // DoublePublicKey serializes as 192 hex chars (96 bytes = 2 x 48-byte G1 points)
    // First 96 chars = blinding key, second 96 chars = spending key
    const spendingKeyHex = serialized.substring(96);

    // The hashId is Hash160(spendingKey) - this is what calcKeyId computes for tx outputs
    // When a sender creates an output for us, the D_prime derivation results in our spendingKey
    const spendingKeyBytes = Buffer.from(spendingKeyHex, 'hex');
    const hashIdBytes = this.hash160(spendingKeyBytes);
    const hashIdHex = this.bytesToHex(hashIdBytes);
    this.subAddresses.set(hashIdHex, id);

    return { subAddress, id };
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
    return Uint8Array.from(Buffer.from(hashIdHex, 'hex'));
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
   * Uses calcNonce from navio-blsct
   * @param blindingKey - The blinding public key
   * @returns The nonce (Point)
   */
  calculateNonce(blindingKey: PublicKeyType): any {
    if (!this.viewKey) {
      throw new Error('View key not available');
    }

    // Use calcNonce from navio-blsct
    // Need to pass .value() for the underlying SWIG objects
    const result = calcNonce(blindingKey.value(), this.viewKey.value());
    
    // Wrap result in Point object
    const { Point } = require('navio-blsct');
    return new Point(result);
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
   * @param publicKey - The view key's public key
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
   * @param publicKey - The view key's public key
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
    // Convert Scalar to public key bytes
    // This would use scalar.toPublicKey() or similar based on navio-blsct API
    return Uint8Array.from(Buffer.from(PublicKey.fromScalar(scalar).serialize(), 'hex'));
  }

  private getPublicKeyFromViewKey(viewKey: ViewKeyType): Uint8Array {
    // Convert ViewKey to public key bytes
    return this.getPublicKeyFromScalar(Scalar.deserialize(viewKey.serialize()));
  }

  private getPublicKeyBytes(publicKey: PublicKeyType): Uint8Array {
    // Get bytes from PublicKey
    return Uint8Array.from(Buffer.from(publicKey.serialize(), 'hex'));
  }


  private createScalarFromBytes(_bytes: Uint8Array): ScalarType {
    // Create Scalar from bytes
    // This would use Scalar.fromBytes() or similar based on navio-blsct API
    return Scalar.deserialize(this.bytesToHex(_bytes)); // Placeholder - needs actual API
  }

  private createViewKeyFromBytes(_bytes: Uint8Array): ViewKeyType {
    // Create ViewKey from bytes
    // This would use ViewKey.fromBytes() or similar
    return ViewKey.deserialize(this.bytesToHex(_bytes)); // Placeholder - needs actual API
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
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
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
    if (!key) {
      throw new Error('KeyManager: could not access the spend key');
    }

    return key;
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

    // Calculate private spending key using navio-blsct
    // Uses calcPrivSpendingKey(blindingKey, viewKey, spendingKey, account, address)
    // Reference: https://nav-io.github.io/libblsct-bindings/ts/functions/calcPrivSpendingKey.html
    const blindingKey = out.blsctData.blindingKey as PublicKeyType;
    const viewKeyScalar = this.getScalarFromViewKey(this.viewKey);
    const spendingKeyScalar = this.getScalarFromScalar(sk);

    key.value = calcPrivSpendingKey(
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

    // Calculate and cache using navio-blsct API
    // Reference: https://nav-io.github.io/libblsct-bindings/ts/functions/calcPrivSpendingKey.html
    const calculatedKey = calcPrivSpendingKey(
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
      return false;
    }

    // Check view tag - fast filter for outputs not intended for us
    const calculatedViewTag = this.calculateViewTag(blindingKey);
    if (viewTag !== calculatedViewTag) {
      return false;
    }

    // Get hash ID and check if we have this sub-address
    const hashId = this.getHashId(blindingKey, spendingKey);
    return this.haveSubAddress(hashId);
  }

  /**
   * Check if a script belongs to this wallet
   * Replicates IsMine(script) from keyman.cpp
   * @param script - The script
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
    if (!key) {
      throw new Error('KeyManager: could not access the master token key');
    }

    return key;
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

    // Build recovery requests for outputs that match our view tag
    const recoveryRequests: any[] = [];

    for (let i = 0; i < outs.length; i++) {
      const out = outs[i];

      // Check if output has BLS CT data and range proof
      if (!out.blsctData || !out.blsctData.rangeProof) {
        continue;
      }

      // Check view tag matches
      const calculatedViewTag = this.calculateViewTag(out.blsctData.blindingKey as PublicKeyType);
      if (out.blsctData.viewTag !== calculatedViewTag) {
        continue;
      }

      // Calculate nonce
      const nonce = this.calculateNonce(out.blsctData.blindingKey as PublicKeyType);

      // Build recovery request
      // Format depends on navio-blsct API - need to check exact structure
      recoveryRequests.push({
        rangeProof: out.blsctData.rangeProof,
        tokenId: out.tokenId,
        nonce: nonce,
        index: i,
      });
    }

    if (recoveryRequests.length === 0) {
      return { success: false, amounts: [], indices: [] };
    }

    // Call navio-blsct recoverAmount
    // Reference: https://nav-io.github.io/libblsct-bindings/ts/functions/recoverAmount.html
    const result = recoverAmount(recoveryRequests);

    // Convert result to our format
    // Need to check the actual return type from navio-blsct
    if (result && result.success !== undefined) {
      return {
        success: result.success,
        amounts: result.amounts || [],
        indices: result.indices || [],
      };
    }

    // Fallback if result format is different
    return { success: false, amounts: [], indices: [] };
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

    // Build recovery requests using provided nonce
    const recoveryRequests: any[] = [];

    for (let i = 0; i < outs.length; i++) {
      const out = outs[i];

      // Check if output has BLS CT data and range proof
      if (!out.blsctData || !out.blsctData.rangeProof) {
        continue;
      }

      // Use the provided nonce instead of calculating it
      recoveryRequests.push({
        rangeProof: out.blsctData.rangeProof,
        tokenId: out.tokenId,
        nonce: nonce,
        index: i,
      });
    }

    if (recoveryRequests.length === 0) {
      return { success: false, amounts: [], indices: [] };
    }

    // Call navio-blsct recoverAmount with provided nonce
    const result = recoverAmount(recoveryRequests);

    // Convert result to our format
    if (result && result.success !== undefined) {
      return {
        success: result.success,
        amounts: result.amounts || [],
        indices: result.indices || [],
      };
    }

    return { success: false, amounts: [], indices: [] };
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
    const hashIdHex = this.bytesToHex(hashId);
    this.subAddresses.set(hashIdHex, index);
  }

  /**
   * Add sub-address mapping and save to database
   * Replicates AddSubAddress from keyman.cpp
   * @param hashId - The hash ID
   * @param index - The sub-address identifier
   * @returns True if successful
   */
  addSubAddress(hashId: Uint8Array, index: SubAddressIdentifier): boolean {
    const hashIdHex = this.bytesToHex(hashId);
    this.subAddresses.set(hashIdHex, index);
    // In a database wallet, this would also save to database
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
   * @param chain - The HD chain to add
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
   * @param script - The script
   * @param spendingKey - Output parameter for the spending key
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
    // Serialize scalar to bytes
    // This needs navio-blsct API
    return Uint8Array.from(Buffer.from(scalar.serialize(), 'hex'));
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
