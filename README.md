# Navio SDK

TypeScript SDK for interacting with the Navio blockchain. Provides wallet management, transaction key synchronization, and blockchain interaction through Electrum servers.

## Features

- Wallet management with HD key derivation
- Transaction key synchronization from Electrum servers
- Automatic output detection and UTXO tracking
- Spending status tracking
- Blockchain reorganization handling
- SQLite-based persistence (browser, Node.js, mobile compatible)
- Hierarchical deterministic sub-address support

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
  electrum: {
    host: 'localhost',
    port: 50005,
    ssl: false,
  },
  createWalletIfNotExists: true,
});

// Initialize (loads wallet, connects to Electrum)
await client.initialize();

// Sync transaction keys
await client.sync({
  onProgress: (height, tip, blocks, txKeys) => {
    console.log(`Syncing: ${height}/${tip} (${blocks} blocks, ${txKeys} TX keys)`);
  },
});

// Access wallet operations
const keyManager = client.getKeyManager();
const subAddress = keyManager.getSubAddress({ account: 0, address: 0 });
console.log('Sub-address:', subAddress.toString());

// Cleanup
await client.disconnect();
```

## API Documentation

### NavioClient

Main client class for wallet operations and blockchain synchronization.

#### Constructor

```typescript
const client = new NavioClient({
  walletDbPath: string,              // Path to wallet database file
  electrum: {
    host?: string,                   // Electrum server host (default: 'localhost')
    port?: number,                   // Electrum server port (default: 50001)
    ssl?: boolean,                   // Use SSL/TLS (default: false)
    timeout?: number,                // Request timeout in ms (default: 30000)
    clientName?: string,             // Client name (default: 'navio-sdk')
    clientVersion?: string,          // Client version (default: '1.4')
  },
  createWalletIfNotExists?: boolean, // Create wallet if missing (default: false)
  restoreFromSeed?: string,          // Restore wallet from seed (hex string)
});
```

#### Methods

##### `initialize(): Promise<void>`

Initializes the client:
- Loads or creates wallet from database
- Connects to Electrum server
- Initializes sync manager
- Sets up KeyManager for output detection

##### `sync(options?: SyncOptions): Promise<number>`

Synchronizes transaction keys from Electrum server.

**Options:**
```typescript
{
  startHeight?: number,              // Start height (default: last synced + 1)
  endHeight?: number,                // End height (default: chain tip)
  onProgress?: (height, tip, blocks, txKeys, isReorg) => void,
  stopOnReorg?: boolean,             // Stop on reorganization (default: true)
  verifyHashes?: boolean,            // Verify block hashes (default: true)
  saveInterval?: number,             // Save DB every N blocks (default: 100)
  keepTxKeys?: boolean,             // Keep TX keys in DB (default: false)
  blockHashRetention?: number,       // Keep last N block hashes (default: 10000)
}
```

**Returns:** Number of transaction keys synced

##### `isSyncNeeded(): Promise<boolean>`

Checks if synchronization is needed.

##### `getLastSyncedHeight(): number`

Returns the last synced block height, or -1 if never synced.

##### `getSyncState()`

Returns current sync state with statistics.

##### `getKeyManager(): KeyManager`

Returns the KeyManager instance for wallet operations.

##### `getWalletDB(): WalletDB`

Returns the WalletDB instance for database operations.

##### `getElectrumClient(): ElectrumClient`

Returns the ElectrumClient instance for blockchain queries.

##### `getSyncManager(): TransactionKeysSync`

Returns the TransactionKeysSync instance for sync operations.

##### `disconnect(): Promise<void>`

Disconnects from Electrum server and closes database.

### KeyManager

Manages BLS CT keys, sub-addresses, and output detection.

#### Key Methods

```typescript
// Generate new seed
const seed = keyManager.generateNewSeed();

// Set HD seed
keyManager.setHDSeed(seed);

// Get sub-address
const subAddr = keyManager.getSubAddress({ account: 0, address: 0 });

// Generate new sub-address
const { subAddress, id } = keyManager.generateNewSubAddress(account);

// Check if output belongs to wallet
const isMine = keyManager.isMineByKeys(blindingKey, spendingKey, viewTag);

// Get spending key for output
const spendingKey = keyManager.getSpendingKeyForOutput(output, subAddressId);

// Recover output amounts
const amounts = keyManager.recoverOutputs(outputs);
```

### WalletDB

Manages wallet database persistence.

#### Key Methods

```typescript
// Create new wallet
const keyManager = await walletDB.createWallet();

// Load existing wallet
const keyManager = await walletDB.loadWallet();

// Restore wallet from seed
const keyManager = await walletDB.restoreWallet(seedHex);

// Save wallet state
await walletDB.saveWallet(keyManager);

// Close database
await walletDB.close();
```

### ElectrumClient

Connects to and queries Electrum servers.

#### Key Methods

```typescript
// Connect to server
await electrumClient.connect();

// Get chain tip height
const height = await electrumClient.getChainTipHeight();

// Get block header
const header = await electrumClient.getBlockHeader(height);

// Get block headers (batch)
const headers = await electrumClient.getBlockHeaders(startHeight, count);

// Get transaction keys for block range
const range = await electrumClient.getBlockTransactionKeysRange(startHeight);

// Get transaction output
const output = await electrumClient.getTransactionOutput(outputHash);

// Disconnect
await electrumClient.disconnect();
```

## Examples

### Create New Wallet

```typescript
import { NavioClient } from 'navio-sdk';

const client = new NavioClient({
  walletDbPath: './new-wallet.db',
  electrum: { host: 'localhost', port: 50005 },
  createWalletIfNotExists: true,
});

await client.initialize();
const keyManager = client.getKeyManager();
const subAddress = keyManager.getSubAddress({ account: 0, address: 0 });
console.log('New wallet sub-address:', subAddress.toString());
```

### Restore Wallet from Seed

```typescript
const client = new NavioClient({
  walletDbPath: './restored-wallet.db',
  electrum: { host: 'localhost', port: 50005 },
  restoreFromSeed: 'your-seed-hex-string',
});

await client.initialize();
```

### Sync with Progress

```typescript
await client.sync({
  onProgress: (currentHeight, chainTip, blocksProcessed, txKeysProcessed, isReorg) => {
    const progress = ((currentHeight / chainTip) * 100).toFixed(1);
    console.log(`Progress: ${progress}% (${blocksProcessed} blocks, ${txKeysProcessed} TX keys)`);
  },
  saveInterval: 100, // Save every 100 blocks
});
```

### Access Wallet Outputs

```typescript
const walletDB = client.getWalletDB();
const db = walletDB.getDatabase();

// Query unspent outputs
const result = db.exec(`
  SELECT output_hash, tx_hash, output_index, block_height, output_data
  FROM wallet_outputs
  WHERE is_spent = 0
  ORDER BY block_height DESC
`);

// Process outputs
for (const row of result[0].values) {
  const [outputHash, txHash, outputIndex, blockHeight, outputData] = row;
  console.log(`UTXO: ${outputHash} from tx ${txHash} at height ${blockHeight}`);
}
```

## Database Schema

The wallet database includes the following tables:

- **keys**: Key pairs for transactions
- **out_keys**: Output-specific keys
- **view_key**: View key for output detection
- **spend_key**: Spending public key
- **hd_chain**: HD chain information
- **sub_addresses**: Sub-address mappings
- **wallet_outputs**: Wallet UTXOs (spendable outputs)
- **tx_keys**: Transaction keys (optional, if `keepTxKeys: true`)
- **block_hashes**: Block hashes for reorganization detection
- **sync_state**: Synchronization state

## Optimization

The SDK includes several optimization options:

- **`keepTxKeys: false`** (default): Don't store transaction keys after processing (saves space)
- **`blockHashRetention: 10000`** (default): Only keep last 10k block hashes (saves ~2.4 MB)
- **`saveInterval: 100`** (default): Save database every 100 blocks (balances performance and safety)

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm run test:keymanager
npm run test:walletdb
npm run test:electrum
npm run test:client

# Analyze database size
npm run analyze:db

# Type checking
npm run typecheck

# Linting
npm run lint
```

## License

MIT
