# Navio SDK

TypeScript SDK for interacting with the Navio blockchain. Provides wallet management, transaction key synchronization, BLSCT confidential transaction support, and blockchain interaction through Electrum servers or P2P connections.

## Features

- **Wallet Management** - HD key derivation with BLS CT support
- **Wallet Encryption** - Password-based encryption with Argon2id + AES-256-GCM
- **Dual Sync Backends** - Electrum protocol or direct P2P node connections
- **Automatic Output Detection** - BLSCT output scanning with view tag optimization
- **Amount Recovery** - Decrypt confidential transaction amounts
- **Balance Tracking** - Query wallet balance and UTXOs
- **Spending Status Tracking** - Monitor spent/unspent outputs
- **Blockchain Reorganization Handling** - Automatic reorg detection and recovery
- **Cross-Platform Persistence** - Efficient SQLite storage (sql.js with IndexedDB for browser, better-sqlite3 for Node.js)
- **Hierarchical Deterministic Sub-addresses** - Multiple account support

## Installation

```bash
npm install navio-sdk
```

## Quick Start

```typescript
import { NavioClient } from 'navio-sdk';

// Create and initialize client
const client = new NavioClient({
  walletDbPath: './my-wallet.db',
  backend: 'electrum', // or 'p2p'
  electrum: {
    host: 'localhost',
    port: 50005,
    ssl: false,
  },
  network: 'mainnet', // 'mainnet' | 'testnet' | 'signet' | 'regtest'
  createWalletIfNotExists: true,
});

// Initialize (loads wallet, connects to backend)
await client.initialize();

// Sync transaction keys
await client.sync({
  onProgress: (height, tip, blocks, txKeys, isReorg) => {
    console.log(`Syncing: ${height}/${tip} (${blocks} blocks, ${txKeys} TX keys${isReorg ? ' [REORG]' : ''})`);
  },
});

// Check wallet balance
const balance = await client.getBalanceNav();
console.log(`Balance: ${balance} NAV`);

// Get unspent outputs
const utxos = await client.getUnspentOutputs();
console.log(`UTXOs: ${utxos.length}`);

// Access wallet operations
const keyManager = client.getKeyManager();
const subAddress = keyManager.getSubAddress({ account: 0, address: 0 });
console.log('Sub-address:', subAddress.toString());

// Cleanup
await client.disconnect();
```

## Configuration

### NavioClientConfig

```typescript
interface NavioClientConfig {
  // Required
  walletDbPath: string;              // Path to wallet database file

  // Database adapter (auto-detected if not specified)
  databaseAdapter?: 'indexeddb' | 'browser' | 'better-sqlite3';

  // Backend selection (default: 'electrum')
  backend?: 'electrum' | 'p2p';

  // Electrum backend options
  electrum?: {
    host?: string;                   // Server host (default: 'localhost')
    port?: number;                   // Server port (default: 50001)
    ssl?: boolean;                   // Use SSL/TLS (default: false)
    timeout?: number;                // Request timeout ms (default: 30000)
    clientName?: string;             // Client name (default: 'navio-sdk')
    clientVersion?: string;          // Protocol version (default: '1.4')
  };

  // P2P backend options
  p2p?: {
    host: string;                    // Node host
    port: number;                    // Node port (mainnet: 33670, testnet: 43670)
    network: 'mainnet' | 'testnet';  // Network type
    debug?: boolean;                 // Enable debug logging
  };

  // Network configuration (for navio-blsct)
  network?: 'mainnet' | 'testnet' | 'signet' | 'regtest';

  // Wallet options
  createWalletIfNotExists?: boolean; // Create wallet if missing (default: false)
  restoreFromSeed?: string;          // Restore from seed (hex string)
  restoreFromMnemonic?: string;      // Restore from BIP39 mnemonic (12-24 words)
  restoreFromHeight?: number;        // Block height when wallet was created (for restore)
  creationHeight?: number;           // Creation height for new wallets (default: chainTip - 100)
}
```

## API Reference

### NavioClient

Main client class for wallet operations and blockchain synchronization.

#### Constructor

```typescript
const client = new NavioClient(config: NavioClientConfig);
```

#### Initialization

##### `initialize(): Promise<void>`

Initializes the client:
- Loads or creates wallet from database
- Connects to backend (Electrum/P2P)
- Initializes sync manager
- Sets up KeyManager for output detection

#### Synchronization

##### `sync(options?: SyncOptions): Promise<number>`

Synchronizes transaction keys from the blockchain.

```typescript
interface SyncOptions {
  startHeight?: number;              // Start height (default: last synced + 1)
  endHeight?: number;                // End height (default: chain tip)
  onProgress?: (
    currentHeight: number,
    chainTip: number,
    blocksProcessed: number,
    txKeysProcessed: number,
    isReorg: boolean
  ) => void;
  stopOnReorg?: boolean;             // Stop on reorg (default: true)
  verifyHashes?: boolean;            // Verify block hashes (default: true)
  saveInterval?: number;             // Save every N blocks (default: 100)
  keepTxKeys?: boolean;              // Keep TX keys in DB (default: false)
  blockHashRetention?: number;       // Keep last N hashes (default: 10000)
}
```

Returns: Number of transaction keys synced

##### `isSyncNeeded(): Promise<boolean>`

Checks if synchronization is needed.

##### `getLastSyncedHeight(): number`

Returns the last synced block height, or -1 if never synced.

##### `getSyncState(): SyncState`

Returns current sync state with statistics.

```typescript
interface SyncState {
  lastSyncedHeight: number;    // Last synced block height
  lastSyncedHash: string;      // Last synced block hash
  totalTxKeysSynced: number;   // Total transaction keys synced
  lastSyncTime: number;        // Last sync timestamp (ms)
  chainTipAtLastSync: number;  // Chain tip at last sync
}
```

#### Background Sync

##### `startBackgroundSync(options?: BackgroundSyncOptions): Promise<void>`

Start continuous background synchronization. The client will poll for new blocks
and automatically sync. Callbacks are invoked for new blocks, transactions, and balance changes.

```typescript
interface BackgroundSyncOptions extends SyncOptions {
  pollInterval?: number;           // Polling interval in ms (default: 10000)
  onNewBlock?: (height: number, hash: string) => void;
  onNewTransaction?: (txHash: string, outputHash: string, amount: bigint) => void;
  onBalanceChange?: (newBalance: bigint, oldBalance: bigint) => void;
  onError?: (error: Error) => void;
}
```

##### `stopBackgroundSync(): void`

Stop background synchronization.

##### `isBackgroundSyncActive(): boolean`

Check if background sync is running.

#### Balance & Outputs

##### `getBalance(tokenId?: string | null): Promise<bigint>`

Get wallet balance in satoshis.

```typescript
// NAV balance
const balanceSats = await client.getBalance();

// Token balance
const tokenBalance = await client.getBalance('token-id-hex');
```

##### `getBalanceNav(tokenId?: string | null): Promise<number>`

Get wallet balance in NAV (with 8 decimal places).

```typescript
const balance = await client.getBalanceNav();
console.log(`Balance: ${balance.toFixed(8)} NAV`);
```

##### `getUnspentOutputs(tokenId?: string | null): Promise<WalletOutput[]>`

Get unspent outputs (UTXOs).

```typescript
interface WalletOutput {
  outputHash: string;
  txHash: string;
  outputIndex: number;
  blockHeight: number;
  amount: bigint;
  memo: string | null;
  tokenId: string | null;
  blindingKey: string;
  spendingKey: string;
  isSpent: boolean;
  spentTxHash: string | null;
  spentBlockHeight: number | null;
}
```

##### `getAllOutputs(): Promise<WalletOutput[]>`

Get all wallet outputs (spent and unspent).

#### Accessors

##### `getKeyManager(): KeyManager`

Returns the KeyManager instance for wallet operations.

##### `getWalletDB(): WalletDB`

Returns the WalletDB instance for database operations.

##### `getSyncProvider(): SyncProvider`

Returns the current sync provider (Electrum or P2P).

##### `getSyncManager(): TransactionKeysSync`

Returns the TransactionKeysSync instance for sync operations.

##### `getBackendType(): 'electrum' | 'p2p'`

Returns the current backend type.

##### `getNetwork(): string`

Returns the configured network.

##### `isConnected(): boolean`

Check if client is connected to the backend.

#### Transaction Creation

##### `sendTransaction(options: SendTransactionOptions): Promise<SendTransactionResult>`

Build and broadcast a confidential transaction. Selects UTXOs, constructs a BLSCT confidential transaction with change, and broadcasts via the connected backend.

```typescript
interface SendTransactionOptions {
  address: string;                   // Destination address (bech32m encoded)
  amount: bigint;                    // Amount to send in satoshis
  memo?: string;                     // Optional memo
  subtractFeeFromAmount?: boolean;   // Subtract fee from amount (default: false)
  tokenId?: string | null;           // Token ID (null for NAV)
}

interface SendTransactionResult {
  txId: string;                      // Transaction ID (hex)
  rawTx: string;                     // Serialized transaction (hex)
  fee: bigint;                       // Fee paid in satoshis
  inputCount: number;                // Inputs used
  outputCount: number;               // Outputs created (including change)
}
```

```typescript
const result = await client.sendTransaction({
  address: 'tnav1...',
  amount: 100_000_000n, // 1 NAV
  memo: 'Payment',
});
console.log('Sent tx:', result.txId);
console.log('Fee:', Number(result.fee) / 1e8, 'NAV');
```

##### `broadcastRawTransaction(rawTx: string): Promise<string>`

Broadcast a pre-built raw transaction hex via the connected backend. Returns the transaction hash.

#### Chain & Metadata

##### `getChainTip(): Promise<{ height: number; hash: string }>`

Get the current chain tip from the backend.

##### `getCreationHeight(): Promise<number>`

Get the wallet creation height (block height to start scanning from).

##### `setCreationHeight(height: number): Promise<void>`

Set the wallet creation height.

##### `getWalletMetadata(): Promise<WalletMetadata | null>`

Get wallet metadata including creation height, creation time, and version.

##### `getConfig(): NavioClientConfig`

Get the current client configuration.

##### `isUsingSubscriptions(): boolean`

Check if background sync is using real-time block header subscriptions (Electrum) vs polling (P2P).

#### Connection

##### `disconnect(): Promise<void>`

Disconnect from backend and close database.

---

### KeyManager

Manages BLS CT keys, sub-addresses, and output detection.

#### Key Generation

```typescript
// Generate new seed
const seed = keyManager.generateNewSeed();

// Set HD seed
keyManager.setHDSeed(seed);

// Get master seed (for backup)
const masterSeed = keyManager.getMasterSeedKey();
console.log('Seed:', masterSeed.serialize()); // hex string
```

#### Mnemonic Support (BIP39)

```typescript
// Generate a new 24-word mnemonic and set as seed
const mnemonic = keyManager.generateNewMnemonic();
console.log('Mnemonic:', mnemonic);
// "abandon ability able about above absent absorb abstract absurd abuse access accident..."

// Or generate mnemonic with different word counts
const mnemonic12 = KeyManager.generateMnemonic(128); // 12 words
const mnemonic24 = KeyManager.generateMnemonic(256); // 24 words (default)

// Validate a mnemonic
const isValid = KeyManager.validateMnemonic(mnemonic);
console.log('Valid:', isValid); // true

// Restore from mnemonic
keyManager.setHDSeedFromMnemonic(mnemonic);

// Get mnemonic from current seed (for backup)
const backupMnemonic = keyManager.getMnemonic();
console.log('Backup mnemonic:', backupMnemonic);

// Static conversion methods
const scalar = KeyManager.mnemonicToScalar(mnemonic); // Convert to Scalar
const recovered = KeyManager.seedToMnemonic(scalar);  // Convert back to mnemonic
```

#### Sub-addresses

```typescript
// Get sub-address by identifier
const subAddr = keyManager.getSubAddress({ account: 0, address: 0 });

// Get bech32m encoded address string (recommended)
const address = keyManager.getSubAddressBech32m({ account: 0, address: 0 }, 'testnet');
console.log('Address:', address); // tnav1... (Node.js) or hex fallback (browser)

// Get mainnet address
const mainnetAddress = keyManager.getSubAddressBech32m({ account: 0, address: 0 }, 'mainnet');
console.log('Address:', mainnetAddress); // nav1...

// Generate new sub-address
const { subAddress, id } = keyManager.generateNewSubAddress(0); // account 0

// Create sub-address pool
keyManager.newSubAddressPool(0);  // Main account
keyManager.newSubAddressPool(-1); // Change
keyManager.newSubAddressPool(-2); // Staking
```

> **Note:** In browser environments using navio-blsct WASM, bech32m encoding may fall back to hex
> representation due to a known issue. This will be addressed in a future navio-blsct release.

#### Output Detection

```typescript
// Check if output belongs to wallet
const isMine = keyManager.isMineByKeys(blindingKey, spendingKey, viewTag);

// Calculate view tag for output detection
const viewTag = keyManager.calculateViewTag(blindingKey);

// Calculate hash ID for sub-address lookup
const hashId = keyManager.calculateHashId(blindingKey, spendingKey);

// Calculate nonce for amount recovery
const nonce = keyManager.calculateNonce(blindingKey);
```

#### Wallet Encryption

The KeyManager supports password-based encryption using Argon2id for key derivation and AES-256-GCM for encryption.

```typescript
// Check encryption status
const isEncrypted = keyManager.isEncrypted();
const isUnlocked = keyManager.isUnlocked();

// Set a password (encrypts the wallet)
await keyManager.setPassword('my-secure-password');

// Lock the wallet (clears cached encryption key)
keyManager.lock();

// Unlock the wallet
const success = await keyManager.unlock('my-secure-password');
if (!success) {
  console.log('Wrong password');
}

// Change password
const changed = await keyManager.changePassword('old-password', 'new-password');

// Get encryption parameters (for database storage)
const params = keyManager.getEncryptionParams();
// { salt: 'hex...', verificationHash: 'hex...' }

// Restore encryption state from database
keyManager.setEncryptionParams(params.salt, params.verificationHash);
```

---

### WalletDB

Manages wallet database persistence.

#### Wallet Operations

```typescript
// Create new wallet
const keyManager = await walletDB.createWallet(creationHeight);

// Load existing wallet
const keyManager = await walletDB.loadWallet();

// Restore wallet from seed
const keyManager = await walletDB.restoreWallet(seedHex, creationHeight);

// Save wallet state
await walletDB.saveWallet(keyManager);

// Close database
await walletDB.close();
```

#### Metadata

```typescript
// Get wallet metadata
const metadata = await walletDB.getWalletMetadata();
// { creationHeight, creationTime, restoredFromSeed, version }

// Get/set creation height
const height = await walletDB.getCreationHeight();
await walletDB.setCreationHeight(height);
```

#### Balance Queries

```typescript
// Get balance
const balance = await walletDB.getBalance();

// Get unspent outputs
const utxos = await walletDB.getUnspentOutputs();

// Get all outputs
const outputs = await walletDB.getAllOutputs();
```

#### Database Encryption

The WalletDB supports full database encryption for secure backup and export.

```typescript
// Export database as encrypted blob
const encryptedData = await walletDB.exportEncrypted('backup-password');
// encryptedData is a Uint8Array that can be saved to file

// Load database from encrypted blob
const restoredDb = await WalletDB.loadEncrypted(encryptedData, 'backup-password');

// Check if a buffer is an encrypted database
import { isEncryptedDatabase } from 'navio-sdk';
const isEncrypted = isEncryptedDatabase(someBuffer);

// Export unencrypted database (for backup without password)
const rawData = walletDB.export();

// Load from raw bytes
const db = await WalletDB.loadFromBytes(rawData);
```

#### Cross-Platform Database Storage

The SDK provides efficient, cross-platform SQLite database storage with automatic adapter selection based on the runtime environment:

| Platform | Adapter | Storage | Performance |
|----------|---------|---------|-------------|
| Browser | sql.js + IndexedDB | IndexedDB | Good |
| Node.js | better-sqlite3 | File system | Excellent |
| Testing | In-memory | Memory | Fast |

The browser adapter uses `sql.js` (SQLite compiled to WebAssembly) with IndexedDB for persistence. Changes are automatically saved to IndexedDB with debouncing for optimal performance.

```typescript
import { NavioClient, WalletDB, createDatabaseAdapter } from 'navio-sdk';

// Auto-detect best adapter for environment
const client = new NavioClient({
  walletDbPath: 'wallet.db',  // Adapter auto-selected based on environment
  // ... other config
});

// Available adapter types:
// - 'browser': sql.js with IndexedDB persistence
// - 'node': better-sqlite3 native bindings
// - 'memory': In-memory (testing)
```

**Using WalletDB Directly:**

```typescript
// Create with auto-detected adapter
const db = new WalletDB();
await db.open('wallet.db');

// Force specific adapter
const db = new WalletDB({ type: 'better-sqlite3' });
await db.open('./wallet.db');

// In-memory for testing
const db = new WalletDB({ type: 'memory' });
await db.open(':memory:');

// All operations are async
await db.createWallet();
const km = await db.loadWallet();
await db.close();
```

**Migrating Between Adapters:**

```typescript
// Start with in-memory database
const memDb = new WalletDB({ type: 'memory' });
await memDb.open(':memory:');
await memDb.createWallet();

// Migrate to persistent storage
const persistentDb = await memDb.migrate('wallet.db');
```

**Browser Storage:**

In browser environments, the SDK uses `sql.js` (SQLite compiled to WebAssembly) with IndexedDB for persistence. The database is automatically saved to IndexedDB when changes are made, ensuring data survives page reloads and browser restarts.

#### Encryption Metadata

```typescript
// Check if encryption is enabled
const isEncrypted = walletDB.isEncrypted();

// Save encryption metadata
walletDB.saveEncryptionMetadata(salt, verificationHash);

// Get encryption metadata
const metadata = walletDB.getEncryptionMetadata();
// { salt: 'hex...', verificationHash: 'hex...' } or null

// Get/save encrypted keys
walletDB.saveEncryptedKey(keyId, publicKey, encryptedSecret);
const key = walletDB.getEncryptedKey(keyId);

// Delete plaintext keys after encryption
walletDB.deletePlaintextKeys();
```

---

### SyncProvider Interface

Abstract interface for sync backends. Allows switching between Electrum and P2P.

```typescript
interface SyncProvider {
  type: 'electrum' | 'p2p' | 'custom';
  
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  
  getChainTipHeight(): Promise<number>;
  getChainTip(): Promise<{ height: number; hash: string }>;
  getBlockHeader(height: number): Promise<string>;
  getBlockHeaders(startHeight: number, count: number): Promise<HeadersResult>;
  getBlockTransactionKeysRange(startHeight: number): Promise<TransactionKeysRangeResult>;
  getBlockTransactionKeys(height: number): Promise<TransactionKeys[]>;
  getTransactionOutput(outputHash: string): Promise<string>;
  broadcastTransaction(rawTx: string): Promise<string>;
  getRawTransaction(txHash: string, verbose?: boolean): Promise<string | any>;

  // Optional subscription methods (Electrum only)
  subscribeBlockHeaders?(callback: BlockHeaderCallback): Promise<BlockHeaderNotification>;
  unsubscribeBlockHeaders?(callback: BlockHeaderCallback): boolean;
  unsubscribeAllBlockHeaders?(): void;
  hasBlockHeaderSubscriptions?(): boolean;
}
```

---

### ElectrumSyncProvider

Electrum protocol implementation of SyncProvider.

```typescript
import { ElectrumSyncProvider } from 'navio-sdk';

const provider = new ElectrumSyncProvider({
  host: 'localhost',
  port: 50005,
  ssl: false,
});

await provider.connect();
const height = await provider.getChainTipHeight();
```

---

### P2PSyncProvider

Direct P2P node connection implementation of SyncProvider.

```typescript
import { P2PSyncProvider } from 'navio-sdk';

const provider = new P2PSyncProvider({
  host: 'localhost',
  port: 43670,  // testnet port (mainnet: 33670)
  network: 'testnet',
  debug: true,
});

await provider.connect();
const height = await provider.getChainTipHeight();
```

---

## Examples

### Create New Wallet

```typescript
import { NavioClient } from 'navio-sdk';

const client = new NavioClient({
  walletDbPath: './new-wallet.db',
  electrum: { host: 'localhost', port: 50005 },
  createWalletIfNotExists: true,
  network: 'testnet',
});

await client.initialize();

// Get and save the seed for backup
const keyManager = client.getKeyManager();
const seed = keyManager.getMasterSeedKey();
console.log('SAVE THIS SEED:', seed.serialize());

// Get receiving address (bech32m encoded)
const address = keyManager.getSubAddressBech32m({ account: 0, address: 0 }, 'testnet');
console.log('Address:', address); // tnav1...
```

### Restore Wallet from Seed

```typescript
const client = new NavioClient({
  walletDbPath: './restored-wallet.db',
  electrum: { host: 'localhost', port: 50005 },
  restoreFromSeed: 'your-seed-hex-string',
  restoreFromHeight: 50000, // Block height when wallet was created
  network: 'testnet',
});

await client.initialize();

// Full sync from restoration height
await client.sync({
  onProgress: (height, tip) => {
    console.log(`Syncing: ${height}/${tip}`);
  },
});
```

### Restore Wallet from Mnemonic

```typescript
const client = new NavioClient({
  walletDbPath: './restored-wallet.db',
  electrum: { host: 'localhost', port: 50005 },
  restoreFromMnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art',
  restoreFromHeight: 50000, // Block height when wallet was created
  network: 'testnet',
});

await client.initialize();

// Full sync from restoration height
await client.sync({
  onProgress: (height, tip) => {
    console.log(`Syncing: ${height}/${tip}`);
  },
});
```

### Using P2P Backend

```typescript
const client = new NavioClient({
  walletDbPath: './p2p-wallet.db',
  backend: 'p2p',
  p2p: {
    host: 'localhost',
    port: 33670,
    network: 'testnet',
    debug: false,
  },
  network: 'testnet',
  createWalletIfNotExists: true,
});

await client.initialize();
await client.sync();

const balance = await client.getBalanceNav();
console.log(`Balance: ${balance} NAV`);
```

### Sync with Progress

```typescript
const startTime = Date.now();

await client.sync({
  onProgress: (currentHeight, chainTip, blocksProcessed, txKeysProcessed, isReorg) => {
    const progress = ((currentHeight / chainTip) * 100).toFixed(1);
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = blocksProcessed / elapsed;
    
    console.log(
      `Progress: ${progress}% | ${blocksProcessed} blocks | ` +
      `${txKeysProcessed} TX keys | ${rate.toFixed(1)} blocks/s`
    );
  },
  saveInterval: 100, // Save every 100 blocks
});
```

### Background Sync (Stay Synced)

Keep the wallet synchronized automatically:

```typescript
import { NavioClient } from 'navio-sdk';

const client = new NavioClient({
  walletDbPath: './wallet.db',
  electrum: { host: 'localhost', port: 50005 },
  createWalletIfNotExists: true,
});

await client.initialize();

// Start background sync - polls every 10 seconds
await client.startBackgroundSync({
  pollInterval: 10000,
  
  onNewBlock: (height, hash) => {
    console.log(`New block ${height}: ${hash.substring(0, 16)}...`);
  },
  
  onBalanceChange: (newBalance, oldBalance) => {
    const diff = Number(newBalance - oldBalance) / 1e8;
    console.log(`Balance changed: ${diff > 0 ? '+' : ''}${diff.toFixed(8)} NAV`);
    console.log(`New balance: ${Number(newBalance) / 1e8} NAV`);
  },
  
  onError: (error) => {
    console.error('Sync error:', error.message);
  },
});

console.log('Wallet running. Press Ctrl+C to stop.');

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  client.stopBackgroundSync();
  await client.disconnect();
  process.exit(0);
});
```

### Send a Transaction

```typescript
import { NavioClient } from 'navio-sdk';

const client = new NavioClient({
  walletDbPath: './wallet.db',
  electrum: { host: 'localhost', port: 50005 },
  network: 'testnet',
});

await client.initialize();

// Send 1 NAV
const result = await client.sendTransaction({
  address: 'tnav1...',
  amount: 100_000_000n, // 1 NAV in satoshis
  memo: 'Coffee payment',
});

console.log('Transaction ID:', result.txId);
console.log('Fee:', Number(result.fee) / 1e8, 'NAV');
console.log('Inputs:', result.inputCount, 'Outputs:', result.outputCount);

// Send with fee subtracted from amount
const result2 = await client.sendTransaction({
  address: 'tnav1...',
  amount: 50_000_000n,
  subtractFeeFromAmount: true,
});
```

### Query Wallet Outputs

```typescript
// Get balance
const balanceNav = await client.getBalanceNav();
console.log(`Balance: ${balanceNav.toFixed(8)} NAV`);

// Get unspent outputs
const utxos = await client.getUnspentOutputs();
console.log(`\nUnspent Outputs (${utxos.length}):`);

for (const utxo of utxos) {
  const amount = Number(utxo.amount) / 1e8;
  console.log(`  ${utxo.outputHash.substring(0, 16)}...`);
  console.log(`    Amount: ${amount.toFixed(8)} NAV`);
  console.log(`    Block: ${utxo.blockHeight}`);
  if (utxo.memo) {
    console.log(`    Memo: ${utxo.memo}`);
  }
}
```

### Encrypt Wallet with Password

```typescript
import { NavioClient } from 'navio-sdk';

const client = new NavioClient({
  walletDbPath: './secure-wallet.db',
  electrum: { host: 'localhost', port: 50005 },
  createWalletIfNotExists: true,
  network: 'testnet',
});

await client.initialize();

// Set a password to encrypt the wallet
const keyManager = client.getKeyManager();
await keyManager.setPassword('my-secure-password');
console.log('Wallet encrypted:', keyManager.isEncrypted()); // true

// The wallet is now encrypted but unlocked
console.log('Wallet unlocked:', keyManager.isUnlocked()); // true

// Lock the wallet (recommended when not in use)
keyManager.lock();
console.log('Wallet unlocked:', keyManager.isUnlocked()); // false

// Unlock to use
const success = await keyManager.unlock('my-secure-password');
console.log('Unlock successful:', success); // true
```

### Export Encrypted Backup

```typescript
// Export encrypted database for backup
const walletDb = client.getWalletDB();
const encryptedBackup = await walletDb.exportEncrypted('backup-password');

// Save to file (Node.js)
const fs = require('fs');
fs.writeFileSync('wallet-backup.enc', encryptedBackup);

// Or download in browser
const blob = new Blob([encryptedBackup], { type: 'application/octet-stream' });
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = 'wallet-backup.enc';
a.click();
```

### Restore from Encrypted Backup

```typescript
import { WalletDB } from 'navio-sdk';

// Load encrypted backup
const fs = require('fs');
const encryptedData = fs.readFileSync('wallet-backup.enc');

// Decrypt and load
const walletDb = await WalletDB.loadEncrypted(
  new Uint8Array(encryptedData),
  'backup-password'
);

// Load the wallet
const keyManager = await walletDb.loadWallet();
console.log('Wallet restored');
```

---

## Database Schema

The wallet database includes the following tables:

| Table | Description |
|-------|-------------|
| `keys` | Key pairs for transactions |
| `out_keys` | Output-specific keys |
| `crypted_keys` | Encrypted key pairs (when password set) |
| `crypted_out_keys` | Encrypted output keys (when password set) |
| `view_key` | View key for output detection |
| `spend_key` | Spending public key |
| `hd_chain` | HD chain information |
| `master_seed` | Mnemonic phrase for wallet recovery |
| `sub_addresses` | Sub-address mappings |
| `wallet_outputs` | Wallet UTXOs with amounts |
| `wallet_metadata` | Wallet creation info |
| `encryption_metadata` | Encryption parameters (salt, verification hash) |
| `tx_keys` | Transaction keys (optional) |
| `block_hashes` | Block hashes for reorg detection |
| `sync_state` | Synchronization state |

### wallet_outputs Schema

```sql
CREATE TABLE wallet_outputs (
  output_hash TEXT PRIMARY KEY,
  tx_hash TEXT NOT NULL,
  output_index INTEGER NOT NULL,
  block_height INTEGER NOT NULL,
  output_data TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  memo TEXT,
  token_id TEXT,
  blinding_key TEXT,
  spending_key TEXT,
  is_spent INTEGER NOT NULL DEFAULT 0,
  spent_tx_hash TEXT,
  spent_block_height INTEGER,
  created_at INTEGER NOT NULL
);
```

---

## Optimization

The SDK includes several optimization options:

| Option | Default | Description |
|--------|---------|-------------|
| `keepTxKeys` | `false` | Don't store TX keys after processing (saves space) |
| `blockHashRetention` | `10000` | Only keep last 10k block hashes (~2.4 MB savings) |
| `saveInterval` | `100` | Save database every 100 blocks |
| `creationHeight` | `chainTip - 100` | Skip blocks before wallet creation |

---

## Network Configuration

The SDK uses `navio-blsct` for BLS CT operations. Network configuration is automatic based on the `network` option:

```typescript
import { setChain, BlsctChain, getChain } from 'navio-sdk';

// Manual configuration (usually automatic)
setChain(BlsctChain.Testnet);
console.log('Current chain:', getChain());
```

---

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm run test              # Run all unit tests (vitest)
npm run test:keymanager   # KeyManager tests
npm run test:walletdb     # WalletDB tests
npm run test:electrum     # Electrum client tests
npm run test:client       # Full client tests (Electrum)
npm run test:p2p          # P2P protocol tests
npm run test:client:p2p   # Full client tests (P2P)
npm run test:encryption   # Encryption module tests
npm run test:tx-keys-sync # Transaction keys sync tests

# Generate documentation
npm run docs              # Markdown docs (default, via typedoc)
npm run docs:html         # HTML docs

# Type checking
npm run typecheck

# Formatting
npm run format

# Linting
npm run lint
npm run lint:fix

# Analyze database size
npm run analyze:db
```

---

### Encryption Module

The SDK includes a low-level encryption module for password-based encryption.

```typescript
import {
  encrypt,
  decrypt,
  deriveKey,
  serializeEncryptedData,
  deserializeEncryptedData,
  createPasswordVerification,
  verifyPassword,
  randomBytes,
} from 'navio-sdk';

// Encrypt arbitrary data
const plaintext = new TextEncoder().encode('secret data');
const encrypted = await encrypt(plaintext, 'password');

// Decrypt data
const decrypted = await decrypt(encrypted, 'password');
console.log(new TextDecoder().decode(decrypted)); // 'secret data'

// Serialize for storage (converts to base64 strings)
const serialized = serializeEncryptedData(encrypted);
const json = JSON.stringify(serialized);

// Deserialize from storage
const parsed = JSON.parse(json);
const deserialized = deserializeEncryptedData(parsed);

// Password verification (for UI feedback)
const salt = randomBytes(16);
const hash = await createPasswordVerification('password', salt);
const isValid = await verifyPassword('password', salt, hash);
```

**Security Properties:**
- **Key Derivation**: Argon2id with 64MB memory, 3 iterations, 4 parallelism
- **Encryption**: AES-256-GCM (authenticated encryption)
- **Random IV**: 12 bytes per encryption (never reused)
- **Random Salt**: 16 bytes per password derivation

---

## Known Limitations

1. **Token Support**: Token transfers are tracked but not fully implemented for spending.

2. **Browser bech32m**: In browser environments using navio-blsct WASM, bech32m address encoding may fall back to hex representation.

---

## API Documentation

Full API documentation is auto-generated using TypeDoc:

```bash
npm run docs
```

View the generated documentation in the `./docs` directory.

---

## Examples

### Web Wallet

A basic browser-based wallet example is available in `examples/web-wallet/`:

```bash
cd examples/web-wallet
npm install
npm run dev
```

Features:
- Create/restore HD wallet
- Connect to Electrum server
- Background synchronization
- Balance and UTXO display

See [examples/web-wallet/README.md](examples/web-wallet/README.md) for details.

---

## License

MIT
