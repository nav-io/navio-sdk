# Navio Web Wallet Example

A basic web wallet example demonstrating how to use `navio-sdk` in a browser environment.

## Features

- Create new wallet
- Restore wallet from seed
- Background sync with Electrum backend
- Display balance and UTXOs
- Real-time activity log

## Prerequisites

- Node.js 16+
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

### In-Memory Storage

This example uses `:memory:` for the database, meaning all wallet data is lost when you refresh the page. In a production app, you would use IndexedDB or another persistent storage mechanism.

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
- Background sync with callbacks
- Balance and UTXO display
