# Navio Web Wallet Example

A basic web wallet example demonstrating how to use `navio-sdk` in a browser environment.

## Features

- Create new wallet with optional password protection
- Restore wallet from seed or mnemonic
- Wallet encryption with lock/unlock support
- Background sync with Electrum backend
- Display balance and UTXOs
- Bech32m encoded receiving addresses
- Real-time activity log

## Prerequisites

- Node.js 20+
- An Electrum server running (default: localhost:50001)

## Setup

1. First, build the main SDK:

```bash
cd ../..
npm install
npm run build
```

2. Install the example dependencies:

```bash
cd examples/web-wallet
npm install
```

3. Run the development server:

```bash
npm run dev
```

4. Open your browser to the URL shown (typically http://localhost:5173)

## Important Notes

### WebAssembly

The `navio-blsct` library uses WebAssembly, which is loaded asynchronously. The wallet may take a moment to initialize on first load.

The SDK loads `sql.js` (SQLite compiled to WebAssembly) from a CDN for database operations. The database is automatically persisted to IndexedDB.

### Persistent Storage

This example uses the SDK's browser adapter which automatically persists wallet data to IndexedDB using `sql.js`. Your wallet data (including the recovery phrase, keys, and sync state) survives page reloads and browser restarts.

### CORS

If connecting to an Electrum server on a different origin, you may need to configure CORS on the server.

## Building for Production

```bash
npm run build
```

The built files will be in the `dist` directory.

## Architecture

- `index.html` - Main HTML page with UI structure
- `src/main.ts` - Application logic and SDK integration
- `src/styles.css` - Styling with a dark theme

The example demonstrates:
- Dynamic import of navio-sdk (ESM)
- NavioClient initialization with Electrum backend
- Wallet creation and restoration
- Password-based wallet encryption (Argon2id + AES-256-GCM)
- Lock/unlock workflow for encrypted wallets
- Background sync with callbacks
- Balance and UTXO display
- Bech32m address encoding

## Wallet Encryption

The web wallet supports optional password-based encryption:

1. **Creating Encrypted Wallet**: Enter a password when creating a new wallet
2. **Locking**: Click "Lock Wallet" to secure the wallet when not in use
3. **Unlocking**: Enter your password to unlock and access the wallet

When a wallet is encrypted:
- Private keys are encrypted with AES-256-GCM
- The encryption key is derived from your password using Argon2id
- The wallet can be locked (password cleared from memory)
- Unlocking requires the correct password
