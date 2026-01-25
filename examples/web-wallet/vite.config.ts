import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: [
      // More specific alias must come first to be matched before the general one
      { find: 'navio-blsct/wasm', replacement: resolve(__dirname, 'node_modules/navio-blsct/wasm') },
      // Point to the local navio-blsct browser build
      { find: 'navio-blsct', replacement: resolve(__dirname, 'node_modules/navio-blsct/dist/browser/index.browser.js') },
    ]
  },
  optimizeDeps: {
    // Pre-bundle to ensure single module instances
    include: ['buffer', '@noble/hashes/sha256', '@noble/hashes/ripemd160'],
    // Exclude navio-sdk but include navio-blsct for single instance
    exclude: ['navio-sdk'],
    // Force navio-blsct to be pre-bundled even though it has issues
    // This ensures all imports resolve to the same module instance
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
      // Allow serving files from the navio-blsct package (for WASM files)
      // Since the package is linked from libblsct-bindings, we need to allow that path
      allow: [
        resolve(__dirname, '..'),
        resolve(__dirname, 'node_modules/navio-blsct'),
        '/Users/alex/dev/libblsct-bindings/ffi/ts',
      ]
    }
  }
});
