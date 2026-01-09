# Contributing to Navio SDK

## Development Setup

```bash
# Clone the repository
git clone https://github.com/navio/navio-sdk.git
cd navio-sdk

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test
```

## Documentation

### Generating Documentation

The SDK uses [TypeDoc](https://typedoc.org/) for automatic API documentation generation from TypeScript source code and JSDoc comments.

```bash
# Generate Markdown documentation (recommended for GitHub)
npm run docs

# Generate HTML documentation (for local browsing)
npm run docs:html

# Watch mode for development
npm run docs:watch
```

Generated documentation:
- **Markdown**: `./docs/` - Used for GitHub wiki or static site generators
- **HTML**: `./docs-html/` - Browse locally by opening `index.html`

### Writing Documentation

#### JSDoc Comments

All public classes, methods, and interfaces should have JSDoc comments:

```typescript
/**
 * Brief description of the class.
 * 
 * @remarks
 * Additional details about usage or implementation.
 * 
 * @example
 * ```typescript
 * const instance = new MyClass();
 * instance.doSomething();
 * ```
 * 
 * @category Client
 */
export class MyClass {
  /**
   * Brief description of the method.
   * 
   * @param paramName - Description of the parameter
   * @returns Description of return value
   * @throws {ErrorType} When the error occurs
   * 
   * @example
   * ```typescript
   * const result = instance.myMethod('value');
   * ```
   */
  myMethod(paramName: string): ReturnType {
    // ...
  }
}
```

#### Categories

Use `@category` tags to organize documentation:

- `Client` - Main client classes
- `Sync` - Synchronization providers and managers
- `Wallet` - Wallet and database classes
- `Keys` - Key management
- `Protocol` - P2P protocol implementation
- `Types` - Interfaces and type definitions

#### Interface Documentation

```typescript
/**
 * Configuration options for the client.
 * 
 * @category Types
 */
export interface ClientConfig {
  /**
   * Path to the wallet database file.
   * @example './my-wallet.db'
   */
  walletDbPath: string;
  
  /**
   * Optional timeout in milliseconds.
   * @default 30000
   */
  timeout?: number;
}
```

### Updating README

The README.md is the primary user-facing documentation. When making changes:

1. Update the "Quick Start" section if the basic usage changes
2. Update the "API Reference" section for new public methods
3. Update the "Examples" section with practical use cases
4. Update the "Known Limitations" section for any issues

### Documentation Checklist

Before submitting a PR:

- [ ] All new public APIs have JSDoc comments
- [ ] Examples compile and work correctly
- [ ] README is updated if needed
- [ ] `npm run docs` generates without errors
- [ ] Type definitions are exported in `src/index.ts`

## Code Style

### TypeScript

- Use strict TypeScript (`strict: true`)
- Prefer `interface` over `type` for object shapes
- Export types alongside implementations
- Use descriptive variable and function names

### Linting

```bash
# Check for linting errors
npm run lint

# Auto-fix linting errors
npm run lint:fix

# Format code
npm run format
```

### Testing

```bash
# Run all tests
npm test

# Run specific test suites
npm run test:keymanager
npm run test:walletdb
npm run test:electrum
npm run test:client
npm run test:p2p
npm run test:client:p2p
```

## Project Structure

```
navio-sdk/
├── src/
│   ├── index.ts           # Main exports
│   ├── client.ts          # NavioClient class
│   ├── key-manager.ts     # KeyManager class
│   ├── wallet-db.ts       # WalletDB class
│   ├── tx-keys-sync.ts    # TransactionKeysSync class
│   ├── sync-provider.ts   # SyncProvider interface
│   ├── electrum.ts        # ElectrumClient class
│   ├── electrum-sync.ts   # ElectrumSyncProvider class
│   ├── p2p-protocol.ts    # P2PClient class
│   ├── p2p-sync.ts        # P2PSyncProvider class
│   ├── types.ts           # Shared types
│   └── *.types.ts         # Type definitions
├── scripts/               # Test and utility scripts
├── docs/                  # Generated Markdown docs
├── docs-html/             # Generated HTML docs
├── typedoc.json          # TypeDoc config (Markdown)
├── typedoc.html.json     # TypeDoc config (HTML)
└── README.md             # User documentation
```

## Submitting Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run tests: `npm test`
5. Run linting: `npm run lint`
6. Generate docs: `npm run docs`
7. Commit your changes: `git commit -m 'Add my feature'`
8. Push to the branch: `git push origin feature/my-feature`
9. Open a Pull Request

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

