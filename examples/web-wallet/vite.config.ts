import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    exclude: ['navio-blsct'],
  },
  build: {
    target: 'esnext',
  },
});
