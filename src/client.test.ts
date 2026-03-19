import { describe, it, expect } from 'vitest';
import { NavioClient } from './client';

describe('NavioClient', () => {
  it('should create a client instance with electrum backend', () => {
    const client = new NavioClient({
      network: 'testnet',
      backend: 'electrum',
      electrum: {
        host: 'testnet.nav.io',
        port: 50005,
      },
      walletDbPath: 'test-client-wallet.db',
    });

    expect(client).toBeInstanceOf(NavioClient);
  });

  it('should return the configuration', () => {
    const config = {
      network: 'mainnet' as const,
      backend: 'electrum' as const,
      electrum: {
        host: 'testnet.nav.io',
        port: 50005,
      },
      walletDbPath: 'test-client-wallet.db',
    };

    const client = new NavioClient(config);
    const returnedConfig = client.getConfig();

    expect(returnedConfig.network).toBe(config.network);
    expect(returnedConfig.backend).toBe(config.backend);
    expect(returnedConfig.electrum).toEqual(config.electrum);
  });

  it('should throw error when electrum backend is used without options', () => {
    expect(() => {
      new NavioClient({
        network: 'testnet',
        backend: 'electrum',
        // Missing electrum options
      });
    }).toThrow('Electrum options required when backend is "electrum"');
  });

  it('should export the audit key from the key manager', () => {
    const client = new NavioClient({
      network: 'testnet',
      backend: 'electrum',
      electrum: {
        host: 'testnet.nav.io',
        port: 50005,
      },
      walletDbPath: 'test-client-wallet.db',
    });

    const getAuditKeyHex = 'ab'.repeat(80);
    (client as any).keyManager = {
      getAuditKeyHex: () => getAuditKeyHex,
    };

    expect(client.getAuditKeyHex()).toBe(getAuditKeyHex);
    expect(client.getWalletViewKeyHex()).toBe(getAuditKeyHex);
  });

  it('should accept audit-key restore config', () => {
    const auditKeyHex = 'ab'.repeat(80);
    const client = new NavioClient({
      network: 'testnet',
      backend: 'electrum',
      electrum: {
        host: 'testnet.nav.io',
        port: 50005,
      },
      walletDbPath: 'test-client-wallet.db',
      restoreFromAuditKey: auditKeyHex,
    });

    expect(client.getConfig().restoreFromAuditKey).toBe(auditKeyHex);
  });

  it('should reject multiple restore sources', () => {
    expect(() => {
      new NavioClient({
        network: 'testnet',
        backend: 'electrum',
        electrum: {
          host: 'testnet.nav.io',
          port: 50005,
        },
        walletDbPath: 'test-client-wallet.db',
        restoreFromMnemonic: 'word1 word2',
        restoreFromAuditKey: 'ab'.repeat(80),
      });
    }).toThrow('Specify only one of restoreFromSeed, restoreFromMnemonic, or restoreFromAuditKey');
  });
});
