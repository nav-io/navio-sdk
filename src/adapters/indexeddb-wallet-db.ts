/**
 * IndexedDB Wallet Database
 *
 * Full IWalletDB implementation backed by native IndexedDB.
 * Every write is immediately persisted at the record level — no
 * full-database export/import cycle, no WASM, no external dependencies.
 *
 * Object stores mirror the SQL tables but use IndexedDB key paths
 * and indexes for efficient queries.
 *
 * @module adapters/indexeddb-wallet-db
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { KeyManager } from '../key-manager';
import type { HDChain, SubAddressIdentifier } from '../key-manager.types';
import * as blsctModule from 'navio-blsct';
import type {
  IWalletDB,
  SyncState,
  WalletOutput,
  WalletMetadata,
  StoreOutputParams,
} from '../wallet-db.interface';

const IDB_VERSION = 1;
const DEFAULT_TOKEN_ID = '0000000000000000000000000000000000000000000000000000000000000000';

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbTx(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

/**
 * Browser wallet database using IndexedDB for per-record persistence.
 */
export class IndexedDBWalletDB implements IWalletDB {
  private db: IDBDatabase | null = null;
  private keyManager: KeyManager | null = null;
  private opened = false;

  // -- static helpers ---------------------------------------------------

  static getDatabaseName(path: string): string {
    return `navio-wallet-${path}`;
  }

  static async exists(path: string): Promise<boolean> {
    if (typeof indexedDB === 'undefined') return false;
    if (indexedDB.databases) {
      const dbs = await indexedDB.databases();
      return dbs.some((d) => d.name === IndexedDBWalletDB.getDatabaseName(path));
    }
    return false;
  }

  static deleteDatabase(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(IndexedDBWalletDB.getDatabaseName(path));
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  }

  // -- lifecycle --------------------------------------------------------

  async open(path: string, _data?: Uint8Array): Promise<void> {
    if (this.opened) throw new Error('Database already open');
    this.db = await this.openIDB(path);
    this.opened = true;
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.opened = false;
  }

  isOpen(): boolean {
    return this.opened && this.db !== null;
  }

  private openIDB(path: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IndexedDBWalletDB.getDatabaseName(path), IDB_VERSION);
      req.onerror = () => reject(new Error('Failed to open IndexedDB'));
      req.onupgradeneeded = (ev) => {
        const db = (ev.target as IDBOpenDBRequest).result;
        this.createStores(db);
      };
      req.onsuccess = () => resolve(req.result);
    });
  }

  private createStores(db: IDBDatabase): void {
    const stores: [string, IDBObjectStoreParameters, string[]?][] = [
      ['config', { keyPath: 'key' }],
      ['keys', { keyPath: 'keyId' }],
      ['outKeys', { keyPath: 'outId' }],
      ['cryptedKeys', { keyPath: 'keyId' }],
      ['cryptedOutKeys', { keyPath: 'outId' }],
      ['subAddresses', { keyPath: 'hashId' }],
      ['keyMetadata', { keyPath: 'keyId' }],
      ['syncState', { keyPath: 'id' }],
      ['blockHashes', { keyPath: 'height' }],
    ];
    for (const [name, opts] of stores) {
      if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, opts);
    }
    if (!db.objectStoreNames.contains('txKeys')) {
      const s = db.createObjectStore('txKeys', { keyPath: 'txHash' });
      s.createIndex('blockHeight', 'blockHeight', { unique: false });
    }
    if (!db.objectStoreNames.contains('walletOutputs')) {
      const s = db.createObjectStore('walletOutputs', { keyPath: 'outputHash' });
      s.createIndex('blockHeight', 'blockHeight', { unique: false });
      s.createIndex('isSpent', 'isSpent', { unique: false });
      s.createIndex('spentBlockHeight', 'spentBlockHeight', { unique: false });
    }
  }

  // -- low-level helpers ------------------------------------------------

  private ensureOpen(): IDBDatabase {
    if (!this.db) throw new Error('Database not open');
    return this.db;
  }

  private async get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
    const db = this.ensureOpen();
    return idbReq(db.transaction(store, 'readonly').objectStore(store).get(key)) as Promise<T | undefined>;
  }

  private async put(store: string, value: any): Promise<void> {
    const db = this.ensureOpen();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    await idbTx(tx);
  }

  private async del(store: string, key: IDBValidKey): Promise<void> {
    const db = this.ensureOpen();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    await idbTx(tx);
  }

  private async getAll<T>(store: string): Promise<T[]> {
    const db = this.ensureOpen();
    return idbReq(db.transaction(store, 'readonly').objectStore(store).getAll()) as Promise<T[]>;
  }

  private async getAllByIndex<T>(store: string, idx: string, key: IDBValidKey): Promise<T[]> {
    const db = this.ensureOpen();
    return idbReq(
      db.transaction(store, 'readonly').objectStore(store).index(idx).getAll(key),
    ) as Promise<T[]>;
  }

  private async deleteByIndexRange(store: string, idx: string, range: IDBKeyRange): Promise<void> {
    const db = this.ensureOpen();
    const tx = db.transaction(store, 'readwrite');
    const index = tx.objectStore(store).index(idx);
    const cursorReq = index.openKeyCursor(range);
    await new Promise<void>((resolve, reject) => {
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          tx.objectStore(store).delete(cursor.primaryKey);
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // -- wallet core ------------------------------------------------------

  async loadWallet(): Promise<KeyManager> {
    const km = new KeyManager();

    const hdRec = await this.get<any>('config', 'hdChain');
    if (!hdRec) throw new Error('No wallet found in database');

    const hdChain: HDChain = {
      version: hdRec.version,
      seedId: this.hexToBytes(hdRec.seedId),
      spendId: this.hexToBytes(hdRec.spendId),
      viewId: this.hexToBytes(hdRec.viewId),
      tokenId: this.hexToBytes(hdRec.tokenId),
      blindingId: this.hexToBytes(hdRec.blindingId),
    };
    km.loadHDChain(hdChain);

    const seedRec = await this.get<any>('config', 'mnemonic');
    if (seedRec) {
      if (seedRec.mnemonic) km.setHDSeedFromMnemonic(seedRec.mnemonic);
      else if (seedRec.seedHex) km.loadMasterSeed(seedRec.seedHex);
    }

    const viewRec = await this.get<any>('config', 'viewKey');
    if (viewRec) {
      const viewKey = this.deserializeViewKey(viewRec.secretKey);
      km.loadViewKey(viewKey);
    }

    const spendRec = await this.get<any>('config', 'spendKey');
    if (spendRec) {
      const pk = this.deserializePublicKey(spendRec.publicKey);
      km.loadSpendKey(pk);
    }

    const keys = await this.getAll<any>('keys');
    for (const k of keys) {
      const sk = this.deserializeScalar(k.secretKey);
      const pk = this.deserializePublicKey(k.publicKey);
      km.loadKey(sk, pk);
      const meta = await this.get<any>('keyMetadata', k.keyId);
      if (meta) {
        km.loadKeyMetadata(this.hexToBytes(k.keyId), { nCreateTime: meta.createTime });
      }
    }

    const outKeys = await this.getAll<any>('outKeys');
    for (const k of outKeys) {
      km.loadOutKey(this.deserializeScalar(k.secretKey), this.hexToBytes(k.outId));
    }

    const cryptedKeys = await this.getAll<any>('cryptedKeys');
    for (const k of cryptedKeys) {
      km.loadCryptedKey(
        this.deserializePublicKey(k.publicKey),
        this.hexToBytes(k.encryptedSecret),
        true,
      );
    }

    const cryptedOutKeys = await this.getAll<any>('cryptedOutKeys');
    for (const k of cryptedOutKeys) {
      km.loadCryptedOutKey(
        this.hexToBytes(k.outId),
        this.deserializePublicKey(k.publicKey),
        this.hexToBytes(k.encryptedSecret),
        true,
      );
    }

    const subAddrs = await this.getAll<any>('subAddresses');
    for (const sa of subAddrs) {
      const id: SubAddressIdentifier = { account: sa.account, address: sa.address };
      km.loadSubAddress(this.hexToBytes(sa.hashId), id);
    }

    if (subAddrs.length === 0) {
      km.newSubAddressPool(0);
      km.newSubAddressPool(-1);
      km.newSubAddressPool(-2);
    }

    const encMeta = await this.getEncryptionMetadata();
    if (encMeta) {
      km.setEncryptionParams(encMeta.salt, encMeta.verificationHash);
    }

    this.keyManager = km;
    return km;
  }

  async createWallet(creationHeight?: number): Promise<KeyManager> {
    const km = new KeyManager();
    km.generateNewMnemonic();
    km.newSubAddressPool(0);
    km.newSubAddressPool(-1);
    km.newSubAddressPool(-2);

    await this.saveWallet(km);
    await this.saveWalletMetadata({
      creationHeight: creationHeight ?? 0,
      creationTime: Date.now(),
      restoredFromSeed: false,
      version: 1,
    });

    this.keyManager = km;
    return km;
  }

  async restoreWallet(seedHex: string, creationHeight?: number): Promise<KeyManager> {
    const km = new KeyManager();
    const seed = this.deserializeScalar(seedHex);
    km.setHDSeed(seed);
    km.newSubAddressPool(0);
    km.newSubAddressPool(-1);
    km.newSubAddressPool(-2);

    await this.saveWallet(km);
    await this.saveWalletMetadata({
      creationHeight: creationHeight ?? 0,
      creationTime: Date.now(),
      restoredFromSeed: true,
      version: 1,
    });

    this.keyManager = km;
    return km;
  }

  async restoreWalletFromMnemonic(mnemonic: string, creationHeight?: number): Promise<KeyManager> {
    const km = new KeyManager();
    km.setHDSeedFromMnemonic(mnemonic);
    km.newSubAddressPool(0);
    km.newSubAddressPool(-1);
    km.newSubAddressPool(-2);

    await this.saveWallet(km);
    await this.saveWalletMetadata({
      creationHeight: creationHeight ?? 0,
      creationTime: Date.now(),
      restoredFromSeed: true,
      version: 1,
    });

    this.keyManager = km;
    return km;
  }

  async saveWallet(keyManager?: KeyManager): Promise<void> {
    const km = keyManager || this.keyManager;
    if (!km) throw new Error('No KeyManager instance to save');

    const db = this.ensureOpen();
    const storeNames = [
      'config', 'keys', 'outKeys', 'cryptedKeys',
      'cryptedOutKeys', 'subAddresses', 'keyMetadata',
    ];
    const tx = db.transaction(storeNames, 'readwrite');

    // Clear key-related stores
    for (const name of storeNames.filter((n) => n !== 'config')) {
      tx.objectStore(name).clear();
    }

    // HD chain
    const hdChain = km.getHDChain();
    if (hdChain) {
      tx.objectStore('config').put({
        key: 'hdChain',
        version: hdChain.version,
        seedId: this.bytesToHex(hdChain.seedId),
        spendId: this.bytesToHex(hdChain.spendId),
        viewId: this.bytesToHex(hdChain.viewId),
        tokenId: this.bytesToHex(hdChain.tokenId),
        blindingId: this.bytesToHex(hdChain.blindingId),
      });
    }

    // Mnemonic
    try {
      const mnemonic = km.getMnemonic();
      tx.objectStore('config').put({ key: 'mnemonic', mnemonic });
    } catch { /* not available */ }

    // View key
    try {
      const viewKey = km.getPrivateViewKey();
      const viewPub = this.getPublicKeyFromViewKey(viewKey);
      tx.objectStore('config').put({
        key: 'viewKey',
        publicKey: this.serializePublicKey(viewPub),
        secretKey: this.serializeViewKey(viewKey),
      });
    } catch { /* not available */ }

    // Spend key
    try {
      const spendPub = km.getPublicSpendingKey();
      tx.objectStore('config').put({
        key: 'spendKey',
        publicKey: this.serializePublicKey(spendPub),
      });
    } catch { /* not available */ }

    await idbTx(tx);

    if (km.isEncrypted()) {
      const params = km.getEncryptionParams();
      if (params) {
        await this.saveEncryptionMetadata(params.salt, params.verificationHash);
      }
    }
  }

  getKeyManager(): KeyManager | null {
    return this.keyManager;
  }

  // -- metadata ---------------------------------------------------------

  private async saveWalletMetadata(meta: WalletMetadata): Promise<void> {
    await this.put('config', { key: 'walletMetadata', ...meta });
  }

  async getWalletMetadata(): Promise<WalletMetadata | null> {
    const rec = await this.get<any>('config', 'walletMetadata');
    if (!rec) return null;
    return {
      creationHeight: rec.creationHeight,
      creationTime: rec.creationTime,
      restoredFromSeed: rec.restoredFromSeed,
      version: rec.version,
    };
  }

  async getCreationHeight(): Promise<number> {
    const m = await this.getWalletMetadata();
    return m?.creationHeight ?? 0;
  }

  async setCreationHeight(height: number): Promise<void> {
    const existing = await this.getWalletMetadata();
    if (existing) {
      await this.put('config', { key: 'walletMetadata', ...existing, creationHeight: height });
    } else {
      await this.saveWalletMetadata({
        creationHeight: height,
        creationTime: Date.now(),
        restoredFromSeed: false,
        version: 1,
      });
    }
  }

  // -- balance & outputs ------------------------------------------------

  async getBalance(tokenId: string | null = null): Promise<bigint> {
    const db = this.ensureOpen();
    const tx = db.transaction('walletOutputs', 'readonly');
    const idx = tx.objectStore('walletOutputs').index('isSpent');
    const req = idx.openCursor(IDBKeyRange.only(0));
    let total = 0n;
    return new Promise((resolve, reject) => {
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const rec = cursor.value;
          if (this.matchesTokenFilter(rec.tokenId, tokenId)) {
            total += BigInt(rec.amount);
          }
          cursor.continue();
        } else {
          resolve(total);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async getUnspentOutputs(tokenId: string | null = null): Promise<WalletOutput[]> {
    const recs = await this.getAllByIndex<any>('walletOutputs', 'isSpent', 0);
    return recs
      .filter((r) => this.matchesTokenFilter(r.tokenId, tokenId))
      .sort((a, b) => a.blockHeight - b.blockHeight)
      .map(this.recordToOutput);
  }

  async getAllOutputs(): Promise<WalletOutput[]> {
    const recs = await this.getAll<any>('walletOutputs');
    return recs.sort((a, b) => a.blockHeight - b.blockHeight).map(this.recordToOutput);
  }

  private matchesTokenFilter(recTokenId: string | null, filterTokenId: string | null): boolean {
    if (filterTokenId === null) {
      return !recTokenId || recTokenId === DEFAULT_TOKEN_ID;
    }
    return recTokenId === filterTokenId;
  }

  private recordToOutput = (r: any): WalletOutput => ({
    outputHash: r.outputHash,
    txHash: r.txHash,
    outputIndex: r.outputIndex,
    blockHeight: r.blockHeight,
    amount: BigInt(r.amount),
    memo: r.memo ?? null,
    tokenId: r.tokenId ?? null,
    blindingKey: r.blindingKey,
    spendingKey: r.spendingKey,
    isSpent: r.isSpent === 1,
    spentTxHash: r.spentTxHash ?? null,
    spentBlockHeight: r.spentBlockHeight ?? null,
  });

  // -- sync state -------------------------------------------------------

  async loadSyncState(): Promise<SyncState | null> {
    const rec = await this.get<any>('syncState', 0);
    if (!rec) return null;
    return {
      lastSyncedHeight: rec.lastSyncedHeight,
      lastSyncedHash: rec.lastSyncedHash,
      totalTxKeysSynced: rec.totalTxKeysSynced,
      lastSyncTime: rec.lastSyncTime,
      chainTipAtLastSync: rec.chainTipAtLastSync,
    };
  }

  async saveSyncState(state: SyncState): Promise<void> {
    await this.put('syncState', { id: 0, ...state });
  }

  async clearSyncData(): Promise<void> {
    const db = this.ensureOpen();
    const tx = db.transaction(['syncState', 'txKeys', 'blockHashes'], 'readwrite');
    tx.objectStore('syncState').clear();
    tx.objectStore('txKeys').clear();
    tx.objectStore('blockHashes').clear();
    await idbTx(tx);
  }

  // -- block hashes -----------------------------------------------------

  async getBlockHash(height: number): Promise<string | null> {
    const rec = await this.get<any>('blockHashes', height);
    return rec?.hash ?? null;
  }

  async saveBlockHash(height: number, hash: string): Promise<void> {
    await this.put('blockHashes', { height, hash });
  }

  async deleteBlockHash(height: number): Promise<void> {
    await this.del('blockHashes', height);
  }

  async deleteBlockHashesBefore(height: number): Promise<void> {
    const db = this.ensureOpen();
    const tx = db.transaction('blockHashes', 'readwrite');
    const store = tx.objectStore('blockHashes');
    const req = store.openKeyCursor(IDBKeyRange.upperBound(height, true));
    await new Promise<void>((resolve, reject) => {
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          store.delete(cursor.key);
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // -- transaction keys -------------------------------------------------

  async saveTxKeys(txHash: string, height: number, keysData: string): Promise<void> {
    await this.put('txKeys', { txHash, blockHeight: height, keysData });
  }

  async getTxKeys(txHash: string): Promise<any | null> {
    const rec = await this.get<any>('txKeys', txHash);
    if (!rec) return null;
    try { return JSON.parse(rec.keysData); } catch { return null; }
  }

  async getTxKeysByHeight(height: number): Promise<{ txHash: string; keys: any }[]> {
    const recs = await this.getAllByIndex<any>('txKeys', 'blockHeight', height);
    return recs.map((r) => ({
      txHash: r.txHash,
      keys: JSON.parse(r.keysData),
    }));
  }

  async deleteTxKeysByHeight(height: number): Promise<void> {
    await this.deleteByIndexRange('txKeys', 'blockHeight', IDBKeyRange.only(height));
  }

  // -- wallet output mutations ------------------------------------------

  async storeWalletOutput(p: StoreOutputParams): Promise<void> {
    await this.put('walletOutputs', {
      outputHash: p.outputHash,
      txHash: p.txHash,
      outputIndex: p.outputIndex,
      blockHeight: p.blockHeight,
      outputData: p.outputData,
      amount: p.amount,
      memo: p.memo,
      tokenId: p.tokenId,
      blindingKey: p.blindingKey,
      spendingKey: p.spendingKey,
      isSpent: p.isSpent ? 1 : 0,
      spentTxHash: p.spentTxHash,
      spentBlockHeight: p.spentBlockHeight,
      createdAt: Date.now(),
    });
  }

  async isOutputUnspent(outputHash: string): Promise<boolean> {
    const rec = await this.get<any>('walletOutputs', outputHash);
    return rec != null && rec.isSpent === 0;
  }

  async markOutputSpent(outputHash: string, spentTxHash: string, spentBlockHeight: number): Promise<void> {
    const rec = await this.get<any>('walletOutputs', outputHash);
    if (!rec) return;
    rec.isSpent = 1;
    rec.spentTxHash = spentTxHash;
    rec.spentBlockHeight = spentBlockHeight;
    await this.put('walletOutputs', rec);
  }

  async deleteOutputsByHeight(height: number): Promise<void> {
    await this.deleteByIndexRange('walletOutputs', 'blockHeight', IDBKeyRange.only(height));
  }

  async unspendOutputsBySpentHeight(height: number): Promise<void> {
    const recs = await this.getAllByIndex<any>('walletOutputs', 'spentBlockHeight', height);
    if (recs.length === 0) return;
    const db = this.ensureOpen();
    const tx = db.transaction('walletOutputs', 'readwrite');
    const store = tx.objectStore('walletOutputs');
    for (const rec of recs) {
      rec.isSpent = 0;
      rec.spentTxHash = null;
      rec.spentBlockHeight = null;
      store.put(rec);
    }
    await idbTx(tx);
  }

  // -- encryption -------------------------------------------------------

  async isEncrypted(): Promise<boolean> {
    const rec = await this.get<any>('config', 'encryptionMetadata');
    return rec?.isEncrypted === true;
  }

  async saveEncryptionMetadata(salt: string, verificationHash: string): Promise<void> {
    await this.put('config', {
      key: 'encryptionMetadata',
      isEncrypted: true,
      salt,
      verificationHash,
      version: 1,
    });
  }

  async getEncryptionMetadata(): Promise<{ salt: string; verificationHash: string } | null> {
    const rec = await this.get<any>('config', 'encryptionMetadata');
    if (!rec || !rec.isEncrypted) return null;
    return { salt: rec.salt, verificationHash: rec.verificationHash };
  }

  // -- persistence (no-op: IndexedDB persists immediately) --------------

  async saveDatabase(): Promise<void> { /* no-op */ }
  async save(): Promise<void> { /* no-op */ }

  // -- serialization helpers (same as WalletDB) -------------------------

  private deserializeScalar(hex: string): any {
    return blsctModule.Scalar.deserialize(hex);
  }

  private serializeViewKey(viewKey: any): string {
    return viewKey.serialize();
  }

  private deserializeViewKey(hex: string): any {
    return blsctModule.Scalar.deserialize(hex);
  }

  private serializePublicKey(publicKey: any): string {
    return publicKey.serialize();
  }

  private deserializePublicKey(hex: string): any {
    return blsctModule.PublicKey.deserialize(hex);
  }

  private getPublicKeyFromViewKey(viewKey: any): any {
    const scalar = blsctModule.Scalar.deserialize(viewKey.serialize());
    return blsctModule.PublicKey.fromScalar(scalar);
  }

  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  private hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }
}
