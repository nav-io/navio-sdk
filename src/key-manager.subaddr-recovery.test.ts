import { describe, expect, it } from 'vitest';
import { KeyManager } from './key-manager.js';

/**
 * A sparse sub-address index used to make recovery run for ever.
 *
 * `registerSubAddress` advances the account counter to `address + 1`, and the recovery scan
 * derived every index from 0 up to that counter. A wallet that derives one sub-address per user
 * from a hash — a bridge, for instance — ends up with counters in the quadrillions, so a single
 * cache miss pinned a core indefinitely and blocked the host's event loop.
 */
describe('findSubAddressIdByHashId: bounded recovery scan', () => {
  it('gives up instead of scanning up to an astronomically large counter', () => {
    const km = new KeyManager();
    km.setHDSeedFromMnemonic(KeyManager.generateMnemonic(256));

    // Mirror what a bridge does: register a sub-address with a 52-bit index.
    const sparse = { account: 308027668398481, address: 3224958062004733 };
    km.getSubAddress(sparse);

    const missing = new Uint8Array(20).fill(0xab);
    const t0 = Date.now();
    const found = km.findSubAddressIdByHashId(missing);
    const elapsedMs = Date.now() - t0;

    expect(found).toBeNull();
    // Before the fix this never returned. The budget caps it at a few thousand derivations.
    expect(elapsedMs).toBeLessThan(30_000);
  }, 60_000);

});
