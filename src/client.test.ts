import { describe, it, expect } from 'vitest';
import { NavioClient } from './client';

describe('NavioClient', () => {
  it('should create a client instance', () => {
    const client = new NavioClient({
      rpcUrl: 'https://rpc.navio.io',
      network: 'testnet',
    });

    expect(client).toBeInstanceOf(NavioClient);
  });

  it('should return the configuration', () => {
    const config = {
      rpcUrl: 'https://rpc.navio.io',
      network: 'mainnet',
      apiKey: 'test-key',
    };

    const client = new NavioClient(config);
    const returnedConfig = client.getConfig();

    expect(returnedConfig).toEqual(config);
  });
});
