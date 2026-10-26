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
import * as blsctModule from '@nav-io/navio-blsct';
import { isStakedCommitmentOutputHex } from '../staking';
import {
  WALLET_METADATA_KEY,
  encodeAmount,
  isNavTokenId,
  parseTxKeys,
  readStoredAmount,
  walletMetadataRecord,
} from '../storage-codec';
import type {
  IWalletDB,
  SyncState,
  WalletOutput,
  WalletMetadata,
  StoreOutputParams,
  TxType,
  CreatedCollectionRecord, SubAddressEntry, StandingOrderRow } from '../wallet-db.interface';

// v2: adds the createdCollections store
// v3: adds the standingOrders store
// v4: adds the outputBlindingKeys store
// v5: walletOutputs records carry isStakedCommitment (backfilled on upgrade)
// v8: amounts (walletOutputs.amount, createdCollections.totalSupply) are
//     decimal strings, and NAV outputs carry tokenId null (converted on upgrade)
const IDB_VERSION = 8;

/** How long open() and deleteDatabase() wait for other connections to close. */
const DEFAULT_BLOCKED_TIMEOUT_MS = 10_000;

/** Stores holding the wallet's keys, rewritten by saveWallet. */
const WALLET_KEY_STORES = [
  'config', 'keys', 'outKeys', 'cryptedKeys',
  'cryptedOutKeys', 'subAddresses', 'keyMetadata',
];

/**
 * Stores holding data detected with a wallet's keys, dropped when a different
 * wallet is written into the database.
 */
const FOREIGN_WALLET_DATA_STORES = [
  'walletOutputs', 'createdCollections', 'standingOrders',
  // Another seed's blinding scalars are not ours and can never verify.
  'outputBlindingKeys',
  // Sync progress
  'syncState', 'txKeys', 'blockHashes',
];

/**
 * walletOutputs fields that hold an output's spent state. storeWalletOutput
 * keeps them from the stored record once it is spent.
 */
const SPENT_STATE_FIELDS = ['isSpent', 'spentTxHash', 'spentBlockHeight'];

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Options for {@link IndexedDBWalletDB}. */
export interface IndexedDBWalletDBOptions {
  /**
   * How long open() waits when another connection (another tab running an
   * older version, say) blocks the version upgrade, before failing.
   * Default 10 000 ms.
   */
  blockedTimeoutMs?: number;
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
  private closedByVersionChange = false;
  private readonly blockedTimeoutMs: number;

  constructor(options: IndexedDBWalletDBOptions = {}) {
    this.blockedTimeoutMs = options.blockedTimeoutMs ?? DEFAULT_BLOCKED_TIMEOUT_MS;
  }

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

  /**
   * Delete a wallet database. Open connections are asked to close (an
   * IndexedDBWalletDB closes on request); if one stays open the deletion
   * waits, and this rejects after `blockedTimeoutMs`. The deletion itself
   * stays queued and completes once that connection closes.
   */
  static deleteDatabase(path: string, blockedTimeoutMs = DEFAULT_BLOCKED_TIMEOUT_MS): Promise<void> {
    return new Promise((resolve, reject) => {
      let blockedTimer: ReturnType<typeof setTimeout> | undefined;
      const req = indexedDB.deleteDatabase(IndexedDBWalletDB.getDatabaseName(path));
      req.onsuccess = () => {
        clearTimeout(blockedTimer);
        resolve();
      };
      req.onerror = () => {
        clearTimeout(blockedTimer);
        reject(req.error);
      };
      req.onblocked = () => {
        clearTimeout(blockedTimer);
        blockedTimer = setTimeout(() => reject(new Error(
          `Cannot delete wallet database "${path}": it is still open in another tab or window. ` +
          'Close it there; the deletion completes once it is closed.'
        )), blockedTimeoutMs);
      };
    });
  }

  // -- lifecycle --------------------------------------------------------

  async open(path: string, _data?: Uint8Array): Promise<void> {
    if (this.opened) throw new Error('Database already open');
    this.db = await this.openIDB(path);
    this.opened = true;
    this.closedByVersionChange = false;
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
      let settled = false;
      let blockedTimer: ReturnType<typeof setTimeout> | undefined;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(blockedTimer);
        reject(error);
      };

      const req = indexedDB.open(IndexedDBWalletDB.getDatabaseName(path), IDB_VERSION);
      req.onerror = () => fail(new Error(`Failed to open IndexedDB: ${req.error?.message ?? 'unknown error'}`));
      req.onblocked = () => {
        // Another connection holds the database at an older version and did
        // not close when asked (one opened by an older SDK, for instance).
        // The upgrade proceeds if it closes in time.
        clearTimeout(blockedTimer);
        blockedTimer = setTimeout(() => fail(new Error(
          `Cannot open wallet database "${path}": it is open in another tab or window ` +
          'that blocks the upgrade to this version. Close it there and try again.'
        )), this.blockedTimeoutMs);
      };
      req.onupgradeneeded = (ev) => {
        const db = (ev.target as IDBOpenDBRequest).result;
        this.createStores(db);
        if (ev.oldVersion > 0 && ev.oldVersion < IDB_VERSION && req.transaction) {
          this.upgradeRecords(req.transaction, ev.oldVersion);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        if (settled) {
          // Gave up while blocked; do not keep a connection nobody holds.
          db.close();
          return;
        }
        settled = true;
        clearTimeout(blockedTimer);
        // Let other tabs upgrade or delete the database: close instead of
        // blocking them. Later calls fail with a clear error.
        db.onversionchange = () => {
          db.close();
          if (this.db === db) {
            this.db = null;
            this.opened = false;
            this.closedByVersionChange = true;
          }
        };
        resolve(db);
      };
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
      ['createdCollections', { keyPath: 'collectionTokenId' }],
      ['standingOrders', { keyPath: 'localId' }],
      ['outputBlindingKeys', { keyPath: 'outputHash' }],
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

  /**
   * Bring records stored by an older version up to date. Runs inside the
   * versionchange transaction, so the database opens only once it is done.
   * One cursor per store applies every step: two cursors updating the same
   * records would overwrite each other's changes.
   *
   * - v5: flag the staked commitments among outputs stored before records
   *   carried isStakedCommitment, from their serialized output
   * - v8: amounts become decimal strings (numbers above 2^53 had already
   *   lost precision; they keep what is left), and NAV outputs get tokenId
   *   null, as sync writes it now
   */
  private upgradeRecords(tx: IDBTransaction, oldVersion: number): void {
    const outputsCursor = tx.objectStore('walletOutputs').openCursor();
    outputsCursor.onsuccess = () => {
      const cursor = outputsCursor.result;
      if (!cursor) return;
      const rec = { ...cursor.value };
      let changed = false;
      if (rec.isStakedCommitment === undefined) {
        rec.isStakedCommitment = isStakedCommitmentOutputHex(rec.outputData ?? '') ? 1 : 0;
        changed = true;
      }
      if (oldVersion < 8) {
        if (typeof rec.amount !== 'string') {
          // A corrupt amount stays as it is (reads leave the row out with a
          // warning) rather than aborting the upgrade.
          const amount = readStoredAmount(rec.amount, `output ${rec.outputHash}`);
          if (amount !== null) {
            rec.amount = amount.toString();
            changed = true;
          }
        }
        if (rec.tokenId != null && isNavTokenId(rec.tokenId)) {
          rec.tokenId = null;
          changed = true;
        }
      }
      if (changed) cursor.update(rec);
      cursor.continue();
    };

    if (oldVersion < 8) {
      const collectionsCursor = tx.objectStore('createdCollections').openCursor();
      collectionsCursor.onsuccess = () => {
        const cursor = collectionsCursor.result;
        if (!cursor) return;
        if (typeof cursor.value.totalSupply !== 'string') {
          const supply = readStoredAmount(cursor.value.totalSupply, `collection ${cursor.value.collectionTokenId}`);
          if (supply !== null) cursor.update({ ...cursor.value, totalSupply: supply.toString() });
        }
        cursor.continue();
      };
    }
  }

  // -- low-level helpers ------------------------------------------------

  private ensureOpen(): IDBDatabase {
    if (!this.db) {
      throw new Error(this.closedByVersionChange
        ? 'Database closed: another tab or window upgraded or deleted it. Reopen it.'
        : 'Database not open');
    }
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
    const done = idbTx(tx);
    const index = tx.objectStore(store).index(idx);
    const cursorReq = index.openKeyCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        tx.objectStore(store).delete(cursor.primaryKey);
        cursor.continue();
      }
    };
    await done;
  }

  // -- wallet core ------------------------------------------------------

  async loadWallet(): Promise<KeyManager> {
    const km = new KeyManager();
    let walletFound = false;

    const hdRec = await this.get<any>('config', 'hdChain');
    if (hdRec) {
      const hdChain: HDChain = {
        version: hdRec.version,
        seedId: this.hexToBytes(hdRec.seedId),
        spendId: this.hexToBytes(hdRec.spendId),
        viewId: this.hexToBytes(hdRec.viewId),
        tokenId: this.hexToBytes(hdRec.tokenId),
        blindingId: this.hexToBytes(hdRec.blindingId),
      };
      km.loadHDChain(hdChain);
      walletFound = true;
    }

    const seedRec = await this.get<any>('config', 'mnemonic');
    if (seedRec) {
      if (seedRec.encryptedSeed) {
        // Decrypted on unlock()
        km.loadEncryptedSeed(seedRec.encryptedSeed);
        walletFound = true;
      } else if (seedRec.mnemonic) {
        km.setHDSeedFromMnemonic(seedRec.mnemonic);
        walletFound = true;
      } else if (seedRec.seedHex) {
        km.loadMasterSeed(seedRec.seedHex);
        walletFound = true;
      }
    }

    const viewRec = await this.get<any>('config', 'viewKey');
    if (viewRec) {
      const viewKey = this.deserializeViewKey(viewRec.secretKey);
      km.loadViewKey(viewKey);
      walletFound = true;
    }

    const spendRec = await this.get<any>('config', 'spendKey');
    if (spendRec) {
      const pk = this.deserializePublicKey(spendRec.publicKey);
      km.loadSpendKey(pk);
      walletFound = true;
    }

    if (!walletFound) {
      throw new Error('No wallet found in database');
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

    // Regenerate the deterministic default pools first, then load persisted
    // mappings on top (entries past the pools are only known through them;
    // loading also advances the per-account counters past them).
    km.newSubAddressPool(0);
    km.newSubAddressPool(-1);
    km.newSubAddressPool(-2);

    const subAddrs = await this.getAll<any>('subAddresses');
    for (const sa of subAddrs) {
      const id: SubAddressIdentifier = { account: Number(sa.account), address: Number(sa.address) };
      km.loadSubAddress(this.hexToBytes(sa.hashId), id);
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

    await this.replaceWallet(km, {
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

    await this.replaceWallet(km, {
      creationHeight: creationHeight ?? 0,
      creationTime: Date.now(),
      restoredFromSeed: true,
      version: 1,
    });

    this.keyManager = km;
    return km;
  }

  async restoreWalletFromAuditKey(auditKeyHex: string, creationHeight?: number): Promise<KeyManager> {
    if (!/^[0-9a-fA-F]{160}$/.test(auditKeyHex)) {
      throw new Error('Audit key must be 160 hex characters long');
    }

    const km = new KeyManager();
    const imported = km.setupGeneration(this.hexToBytes(auditKeyHex), 'IMPORT_VIEW_KEY');
    if (!imported) {
      throw new Error('Failed to import audit key');
    }

    await this.replaceWallet(km, {
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

    await this.replaceWallet(km, {
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
    const tx = db.transaction(WALLET_KEY_STORES, 'readwrite');
    await this.commitWrites(tx, () => this.writeWallet(tx, km));
  }

  /**
   * Queue writes on `tx` and wait for it to commit. If queueing throws, the
   * transaction is aborted: it would otherwise commit whatever was queued
   * before the throw.
   */
  private async commitWrites(tx: IDBTransaction, queue: () => void): Promise<void> {
    const done = idbTx(tx);
    try {
      queue();
    } catch (error) {
      tx.abort();
      await done.catch(() => undefined);
      throw error;
    }
    await done;
  }

  /**
   * Queue the writes that replace the stored keys with `km`'s on `tx`, which
   * must cover WALLET_KEY_STORES. Records `km` has no value for are deleted,
   * so a view-only wallet saved over a full one keeps none of its keys.
   */
  private writeWallet(tx: IDBTransaction, km: KeyManager): void {
    // Clear key-related stores
    for (const name of WALLET_KEY_STORES.filter((n) => n !== 'config')) {
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
    } else {
      tx.objectStore('config').delete('hdChain');
    }

    // Seed: encrypted for an encrypted wallet, otherwise the mnemonic.
    // put() replaces the whole record, so no plaintext field survives.
    const seed = km.getSeedForStorage();
    if (seed) {
      tx.objectStore('config').put({ key: 'mnemonic', ...seed });
    } else {
      tx.objectStore('config').delete('mnemonic');
    }

    // Encryption metadata, in the same transaction as the seed it unlocks
    const encryptionParams = km.getEncryptionParams();
    if (encryptionParams) {
      tx.objectStore('config').put({
        key: 'encryptionMetadata',
        isEncrypted: true,
        salt: encryptionParams.salt,
        verificationHash: encryptionParams.verificationHash,
        version: 1,
      });
    } else {
      tx.objectStore('config').delete('encryptionMetadata');
    }

    // View key
    try {
      const viewKey = km.getPrivateViewKey();
      const viewPub = this.getPublicKeyFromViewKey(viewKey);
      tx.objectStore('config').put({
        key: 'viewKey',
        publicKey: this.serializePublicKey(viewPub),
        secretKey: this.serializeViewKey(viewKey),
      });
    } catch {
      // Not available
      tx.objectStore('config').delete('viewKey');
    }

    // Spend key
    try {
      const spendPub = km.getPublicSpendingKey();
      tx.objectStore('config').put({
        key: 'spendKey',
        publicKey: this.serializePublicKey(spendPub),
      });
    } catch {
      // Not available
      tx.objectStore('config').delete('spendKey');
    }

    // Sub-address mappings (hashId -> account/address)
    for (const entry of km.getSubAddressEntries()) {
      tx.objectStore('subAddresses').put({ hashId: entry.hashId, account: entry.account, address: entry.address });
    }
  }

  async saveSubAddresses(entries: SubAddressEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const db = this.ensureOpen();
    const tx = db.transaction('subAddresses', 'readwrite');
    for (const entry of entries) {
      tx.objectStore('subAddresses').put({ hashId: entry.hashId, account: entry.account, address: entry.address });
    }
    await idbTx(tx);
  }

  /**
   * Write a newly created or restored wallet, with its metadata, in one
   * transaction. When a different wallet (different spending key) was stored
   * before, that transaction first drops its data: outputs, created
   * collections and sync progress are tied to the keys that detected them;
   * kept across a restore with another seed they are selected as inputs and
   * the spend fails with "does not map to a known sub-address in this
   * wallet". Restoring the same seed keeps everything. One transaction, so a
   * crash cannot leave the old outputs dropped but the new keys unsaved.
   */
  private async replaceWallet(km: KeyManager, meta: WalletMetadata): Promise<void> {
    const discard = await this.holdsDifferentWallet(km);
    const db = this.ensureOpen();
    const tx = db.transaction(
      discard ? [...WALLET_KEY_STORES, ...FOREIGN_WALLET_DATA_STORES] : WALLET_KEY_STORES,
      'readwrite',
    );
    await this.commitWrites(tx, () => {
      if (discard) {
        for (const name of FOREIGN_WALLET_DATA_STORES) {
          tx.objectStore(name).clear();
        }
      }
      this.writeWallet(tx, km);
      tx.objectStore('config').put(walletMetadataRecord(meta));
    });
  }

  private async holdsDifferentWallet(incoming: KeyManager): Promise<boolean> {
    const db = this.ensureOpen();
    const outputCount = await idbReq(db.transaction('walletOutputs', 'readonly').objectStore('walletOutputs').count());
    const syncState = await this.get<any>('syncState', 0);
    if (outputCount === 0 && !syncState) return false;

    const spendRec = await this.get<any>('config', 'spendKey');
    if (!spendRec?.publicKey) return true;
    try {
      return String(spendRec.publicKey) !== this.serializePublicKey(incoming.getPublicSpendingKey());
    } catch {
      return true;
    }
  }

  getKeyManager(): KeyManager | null {
    return this.keyManager;
  }

  // -- metadata ---------------------------------------------------------

  private async saveWalletMetadata(meta: WalletMetadata): Promise<void> {
    await this.put('config', walletMetadataRecord(meta));
  }

  async getWalletMetadata(): Promise<WalletMetadata | null> {
    const rec = await this.get<any>('config', WALLET_METADATA_KEY);
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
      await this.put('config', walletMetadataRecord({ ...existing, creationHeight: height }));
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
          // Spendable balance: staked commitments are locked for staking.
          if (rec.isStakedCommitment !== 1 && this.matchesTokenFilter(rec.tokenId, tokenId)) {
            total += readStoredAmount(rec.amount, `output ${rec.outputHash}`) ?? 0n;
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
      .filter((r) => r.isStakedCommitment !== 1 && this.matchesTokenFilter(r.tokenId, tokenId))
      .sort((a, b) => a.blockHeight - b.blockHeight)
      .map(this.recordToOutput)
      .filter((o): o is WalletOutput => o !== null);
  }

  async getAllOutputs(): Promise<WalletOutput[]> {
    const recs = await this.getAll<any>('walletOutputs');
    return recs
      .sort((a, b) => a.blockHeight - b.blockHeight)
      .map(this.recordToOutput)
      .filter((o): o is WalletOutput => o !== null);
  }

  private matchesTokenFilter(recTokenId: string | null, filterTokenId: string | null): boolean {
    // NAV is stored as null since v8, so an explicit NAV id selects NAV too.
    if (isNavTokenId(filterTokenId)) {
      // NAV: no token id, or the NAV token id in any stored spelling
      return isNavTokenId(recTokenId);
    }
    return recTokenId === filterTokenId;
  }

  /** Map a stored record to a WalletOutput, or null (with a warning) when its amount is corrupt. */
  private recordToOutput = (r: any): WalletOutput | null => {
    const amount = readStoredAmount(r.amount, `output ${r.outputHash}`);
    if (amount === null) return null;
    return {
    outputHash: r.outputHash,
    txHash: r.txHash,
    outputIndex: r.outputIndex,
    blockHeight: r.blockHeight,
    amount,
    gamma: r.gamma ?? '0',
    memo: r.memo ?? null,
    tokenId: r.tokenId ?? null,
    blindingKey: r.blindingKey,
    ephemeralKey: r.ephemeralKey ?? null,
    spendingKey: r.spendingKey,
    isSpent: r.isSpent === 1,
    spentTxHash: r.spentTxHash ?? null,
    spentBlockHeight: r.spentBlockHeight ?? null,
    txType: (r.txType ?? 'received') as TxType,
    timestamp: r.timestamp ?? 0,
    isStakedCommitment: r.isStakedCommitment === 1,
    };
  };

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
    const done = idbTx(tx);
    const store = tx.objectStore('blockHashes');
    const req = store.openKeyCursor(IDBKeyRange.upperBound(height, true));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        store.delete(cursor.key);
        cursor.continue();
      }
    };
    await done;
  }

  // -- transaction keys -------------------------------------------------

  async saveTxKeys(txHash: string, height: number, keysData: string): Promise<void> {
    await this.put('txKeys', { txHash, blockHeight: height, keysData });
  }

  async getTxKeys(txHash: string): Promise<any | null> {
    const rec = await this.get<any>('txKeys', txHash);
    if (!rec) return null;
    return parseTxKeys(txHash, rec.keysData);
  }

  async getTxKeysByHeight(height: number): Promise<{ txHash: string; keys: any }[]> {
    const recs = await this.getAllByIndex<any>('txKeys', 'blockHeight', height);
    const results: { txHash: string; keys: any }[] = [];
    for (const r of recs) {
      const keys = parseTxKeys(r.txHash, r.keysData);
      if (keys !== null) {
        results.push({ txHash: r.txHash, keys });
      }
    }
    return results;
  }

  async deleteTxKeysByHeight(height: number): Promise<void> {
    await this.deleteByIndexRange('txKeys', 'blockHeight', IDBKeyRange.only(height));
  }

  // -- wallet output mutations ------------------------------------------

  async storeWalletOutput(p: StoreOutputParams): Promise<void> {
    const record: Record<string, any> = {
      outputHash: p.outputHash,
      txHash: p.txHash,
      outputIndex: p.outputIndex,
      blockHeight: p.blockHeight,
      outputData: p.outputData,
      amount: encodeAmount(p.amount),
      gamma: p.gamma,
      memo: p.memo,
      tokenId: p.tokenId,
      blindingKey: p.blindingKey,
      ephemeralKey: p.ephemeralKey ?? null,
      spendingKey: p.spendingKey,
      isSpent: p.isSpent ? 1 : 0,
      spentTxHash: p.spentTxHash,
      spentBlockHeight: p.spentBlockHeight,
      txType: p.txType,
      timestamp: p.timestamp,
      isStakedCommitment: p.isStakedCommitment ? 1 : 0,
      createdAt: Date.now(),
    };

    // Upsert in one transaction: re-processing a block must not reset a
    // spent output to unspent, nor its creation time. Once a record is spent
    // its spent state is kept; unspending is revertBlocksFrom's job.
    const db = this.ensureOpen();
    const tx = db.transaction('walletOutputs', 'readwrite');
    const done = idbTx(tx);
    const store = tx.objectStore('walletOutputs');
    const existingReq = store.get(p.outputHash);
    existingReq.onsuccess = () => {
      const existing = existingReq.result;
      if (existing) {
        record.createdAt = existing.createdAt ?? record.createdAt;
        if (existing.isSpent === 1) {
          for (const field of SPENT_STATE_FIELDS) {
            record[field] = existing[field] ?? null;
          }
        }
      }
      store.put(record);
    };
    await done;
  }

  async isOutputUnspent(outputHash: string): Promise<boolean> {
    const rec = await this.get<any>('walletOutputs', outputHash);
    return rec != null && rec.isSpent === 0;
  }

  async getOutputData(outputHash: string): Promise<string | null> {
    const rec = await this.get<any>('walletOutputs', outputHash);
    return rec?.outputData || null;
  }

  async isOutputSpentInMempool(outputHash: string): Promise<boolean> {
    const rec = await this.get<any>('walletOutputs', outputHash);
    return rec != null && rec.isSpent === 1 && rec.spentBlockHeight === 0;
  }

  async getMempoolSpentTxHash(outputHash: string): Promise<string | null> {
    const rec = await this.get<any>('walletOutputs', outputHash);
    if (rec && rec.isSpent === 1 && rec.spentBlockHeight === 0) {
      return rec.spentTxHash ?? null;
    }
    return null;
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

  async revertBlocksFrom(fromHeight: number, state: SyncState): Promise<void> {
    // Height 0 marks mempool rows; a revert must never reach them.
    if (!Number.isInteger(fromHeight) || fromHeight < 1) {
      throw new Error(`Invalid revert height: ${fromHeight}`);
    }
    const db = this.ensureOpen();
    const tx = db.transaction(['syncState', 'txKeys', 'walletOutputs', 'blockHashes'], 'readwrite');
    const done = idbTx(tx);
    const range = IDBKeyRange.lowerBound(fromHeight);

    tx.objectStore('syncState').put({ id: 0, ...state });

    const deleteInRange = (store: IDBObjectStore, source: IDBObjectStore | IDBIndex): void => {
      const req = source.openKeyCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        }
      };
    };
    const txKeys = tx.objectStore('txKeys');
    const outputs = tx.objectStore('walletOutputs');
    const blockHashes = tx.objectStore('blockHashes');
    deleteInRange(txKeys, txKeys.index('blockHeight'));
    deleteInRange(outputs, outputs.index('blockHeight'));
    deleteInRange(blockHashes, blockHashes);

    const unspendReq = outputs.index('spentBlockHeight').openCursor(range);
    unspendReq.onsuccess = () => {
      const cursor = unspendReq.result;
      if (!cursor) return;
      // Skip outputs the delete above is removing: updating one after its
      // delete has been queued would write it back.
      if (cursor.value.blockHeight < fromHeight) {
        cursor.update({ ...cursor.value, isSpent: 0, spentTxHash: null, spentBlockHeight: null });
      }
      cursor.continue();
    };

    await done;
  }

  async saveCreatedCollection(record: CreatedCollectionRecord): Promise<void> {
    await this.put('createdCollections', {
      ...record,
      totalSupply: encodeAmount(record.totalSupply, 'totalSupply'),
    });
  }

  async saveOutputBlindingKey(outputHash: string, blindingKeyPrivate: string): Promise<void> {
    await this.put('outputBlindingKeys', { outputHash, blindingKey: blindingKeyPrivate, createdAt: Date.now() });
  }

  async getOutputBlindingKey(outputHash: string): Promise<string | null> {
    const rec = await this.get<{ outputHash: string; blindingKey: string }>('outputBlindingKeys', outputHash);
    return rec?.blindingKey ?? null;
  }

  async saveStandingOrder(row: StandingOrderRow): Promise<void> {
    await this.put('standingOrders', { ...row, inputs: [...row.inputs] });
  }

  async getStandingOrders(): Promise<StandingOrderRow[]> {
    const rows = await this.getAll<StandingOrderRow>('standingOrders');
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }

  async deleteStandingOrder(localId: string): Promise<void> {
    const db = this.ensureOpen();
    const tx = db.transaction('standingOrders', 'readwrite');
    tx.objectStore('standingOrders').delete(localId);
    await idbTx(tx);
  }

  async getCreatedCollections(): Promise<CreatedCollectionRecord[]> {
    const recs = await this.getAll<any>('createdCollections');
    return recs
      .sort((a, b) => a.createdAt - b.createdAt)
      .flatMap((rec): CreatedCollectionRecord[] => {
        // A corrupt supply leaves the record out, with a warning.
        const totalSupply = readStoredAmount(rec.totalSupply, `collection ${rec.collectionTokenId}`);
        return totalSupply === null ? [] : [{ ...rec, totalSupply }];
      });
  }

  async getPendingSpentAmount(tokenId: string | null = null): Promise<bigint> {
    const recs = await this.getAllByIndex<any>('walletOutputs', 'spentBlockHeight', 0);
    let total = 0n;
    for (const rec of recs) {
      if (rec.isSpent !== 1) continue;
      if (!this.matchesTokenFilter(rec.tokenId, tokenId)) continue;
      total += readStoredAmount(rec.amount, `output ${rec.outputHash}`) ?? 0n;
    }
    return total;
  }

  async deleteUnconfirmedOutputsByTxHash(txHash: string): Promise<void> {
    const recs = await this.getAllByIndex<any>('walletOutputs', 'blockHeight', 0);
    if (recs.length === 0) return;
    const db = this.ensureOpen();
    const tx = db.transaction('walletOutputs', 'readwrite');
    const store = tx.objectStore('walletOutputs');
    for (const rec of recs) {
      if (rec.txHash === txHash) {
        store.delete(rec.outputHash);
      }
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
