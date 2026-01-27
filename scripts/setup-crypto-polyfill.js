/**
 * Setup crypto polyfill for Node.js < 19
 * This must be loaded before vitest/vite to ensure crypto is available
 */

if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.getRandomValues !== 'function') {
  const nodeCrypto = require('crypto');
  if (nodeCrypto.webcrypto) {
    globalThis.crypto = nodeCrypto.webcrypto;
    console.log('[crypto-polyfill] Applied globalThis.crypto polyfill for Node.js < 19');
  }
}
