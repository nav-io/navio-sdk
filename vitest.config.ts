import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Use forks instead of threads to avoid native module issues with V8 handle scopes
    pool: 'forks',
    // BLSCT signing/fee-estimation tests do several native signs each; they
    // run in well under a second locally but can exceed the 5s default on
    // slow shared CI runners.
    testTimeout: 30000,
    // Exclude encryption tests from vitest (they use standalone runner due to Node.js < 19 crypto issues)
    exclude: ['**/node_modules/**', '**/dist/**', '**/crypto/encryption.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});



