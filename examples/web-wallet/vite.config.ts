import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: [
      // More specific alias must come first to be matched before the general one
      { find: 'navio-blsct/wasm', replacement: resolve(__dirname, 'node_modules/navio-blsct/wasm') },
      // Point to the navio-blsct browser build
      { find: 'navio-blsct', replacement: resolve(__dirname, 'node_modules/navio-blsct/dist/browser/index.browser.js') },
    ]
  },
  optimizeDeps: {
    // Pre-bundle to ensure single module instances
    include: ['buffer', '@noble/hashes/sha256', '@noble/hashes/ripemd160'],
    // Exclude navio-sdk and navio-blsct from optimization to avoid WASM issues
    exclude: ['navio-sdk', 'navio-blsct'],
    esbuildOptions: {
      supported: {
        'dynamic-import': true,
      },
    },
  },
  build: {
    target: 'esnext',
  },
  define: {
    // Provide browser-compatible polyfills for Node.js globals
    'process.env': {},
  },
  server: {
    fs: {
      // Allow serving files from node_modules for WASM
      allow: [
        resolve(__dirname, '..'),
        resolve(__dirname, 'node_modules/navio-blsct'),
        // Allow local libblsct-bindings for development
        resolve(__dirname, '../../../libblsct-bindings'),
      ]
    }
  },
  // Don't pre-bundle ?url imports
  assetsInclude: ['**/*.wasm'],
});
