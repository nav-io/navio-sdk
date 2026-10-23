import { describe, expect, it } from 'vitest';
import {
  Address,
  AddressEncoding,
  BlsctChain,
  DoublePublicKey,
  PublicKey,
  Scalar,
  SubAddr,
  SubAddrId,
  setChain,
} from '@nav-io/navio-blsct';
import { NavioClient } from './client';

const KEYS = DoublePublicKey.deserialize(
  SubAddr.generate(new Scalar(7), PublicKey.fromScalar(new Scalar(8)), SubAddrId.generate(0, 0)).serialize()
);

/** The same keys encoded for `chain`. */
function addressOn(chain: BlsctChain): string {
  setChain(chain);
  return Address.encode(KEYS, AddressEncoding.Bech32M);
}

function client(network: 'mainnet' | 'signet'): NavioClient {
  // The constructor selects the network in navio-blsct.
  return new NavioClient({
    network,
    backend: 'electrum',
    electrum: { host: 'localhost', port: 50005 },
    walletDbPath: ':memory:',
  });
}

describe('destination address network check', () => {
  const mainnetAddress = addressOn(BlsctChain.Mainnet);
  const signetAddress = addressOn(BlsctChain.Signet);

  it('uses the prefix navio-blsct encodes signet addresses with', () => {
    expect(signetAddress.startsWith('snv1')).toBe(true);
    expect(mainnetAddress.startsWith('nav1')).toBe(true);
  });

  it('accepts signet addresses on signet and refuses mainnet ones', () => {
    const signet = client('signet');
    expect(() => (signet as any).decodeDestinationAddress(signetAddress)).not.toThrow();
    expect(() => (signet as any).decodeDestinationAddress(mainnetAddress)).toThrow(
      /is a mainnet address, but this client is configured for signet \(expected prefix "snv1/
    );
  });

  it('refuses signet addresses on mainnet', () => {
    const mainnet = client('mainnet');
    expect(() => (mainnet as any).decodeDestinationAddress(mainnetAddress)).not.toThrow();
    expect(() => (mainnet as any).decodeDestinationAddress(signetAddress)).toThrow(
      /is a signet address, but this client is configured for mainnet/
    );
  });
});
