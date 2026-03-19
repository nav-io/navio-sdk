import { afterEach, describe, expect, it } from 'vitest';
import { KeyManager } from './key-manager';
import { WalletDB } from './wallet-db';

describe('WalletDB audit-key restore', () => {
  let walletDB: WalletDB | null = null;

  afterEach(async () => {
    if (walletDB) {
      await walletDB.close();
      walletDB = null;
    }
  });

  it('should restore and reload a watch-only wallet from an audit key', async () => {
    const keyManager = new KeyManager();
    keyManager.setHDSeedFromMnemonic(
      'short exact vendor hand scale enroll around pudding genius party lesson basket cook crash sugar protect advance gentle humor bench farm weekend direct awkward'
    );
    const auditKeyHex = keyManager.getAuditKeyHex();

    walletDB = new WalletDB({ type: 'better-sqlite3' });
    await walletDB.open(':memory:');

    const restored = await walletDB.restoreWalletFromAuditKey(auditKeyHex, 0);
    expect(restored.getAuditKeyHex()).toBe(auditKeyHex);

    const reloaded = await walletDB.loadWallet();
    expect(reloaded.getAuditKeyHex()).toBe(auditKeyHex);
  });
});
