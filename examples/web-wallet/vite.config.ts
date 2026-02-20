import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: [
      { find: 'navio-blsct/wasm', replacement: resolve(__dirname, 'node_modules/navio-blsct/wasm') },
      { find: 'navio-blsct', replacement: resolve(__dirname, 'node_modules/navio-blsct/dist/browser/index.browser.js') },
      { find: /^navio-sdk$/, replacement: resolve(__dirname, '../../src/index.ts') },
    ],
  },
  optimizeDeps: {
    include: ['buffer'],
    exclude: ['navio-sdk', 'navio-blsct'],
  },
  build: {
    target: 'esnext',
  },
  define: {
    'process.env': {},
  },
  server: {
    fs: {
      allow: [
        resolve(__dirname, '../..'),
        resolve(__dirname, 'node_modules/navio-blsct'),
      ],
    },
  },
  assetsInclude: ['**/*.wasm'],
});
