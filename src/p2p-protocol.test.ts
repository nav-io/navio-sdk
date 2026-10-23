/**
 * Network-free tests for P2PClient's message framing: data is fed straight
 * into the receive path of a client marked connected.
 */

import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { MAX_P2P_MESSAGE_LENGTH, NetworkMagic, P2PClient } from './p2p-protocol';

function frame(command: string, payload: Buffer, declaredLength = payload.length): Buffer {
  const header = Buffer.alloc(24);
  NetworkMagic.REGTEST.copy(header, 0);
  header.write(command, 4, 'ascii');
  header.writeUInt32LE(declaredLength, 16);
  Buffer.from(sha256(sha256(payload))).copy(header, 20, 0, 4);
  return Buffer.concat([header, payload]);
}

function connectedClient(): P2PClient {
  const client = new P2PClient({ host: '127.0.0.1', network: 'regtest' });
  (client as any).connected = true;
  (client as any).handshakeComplete = true;
  return client;
}

const feed = (client: P2PClient, data: Buffer) => (client as any).handleData(data);

describe('P2PClient message framing', () => {
  it('caps messages at 32 MB', () => {
    expect(MAX_P2P_MESSAGE_LENGTH).toBe(32 * 1024 * 1024);
  });

  it('disconnects when a peer announces a message over the size limit', async () => {
    const client = connectedClient();
    const closed: Error[] = [];
    client.onClose(err => closed.push(err!));
    const waiting = client.waitFor('block');

    const header = frame('block', Buffer.alloc(0), 32 * 1024 * 1024 + 1).subarray(0, 24);
    feed(client, header);

    await expect(waiting).rejects.toThrow('oversized block message');
    expect(client.isConnected()).toBe(false);
    expect(closed).toHaveLength(1);
    expect((client as any).receiveBuffer.length).toBe(0);
  });

  it('reassembles a large message delivered in many chunks', async () => {
    const client = connectedClient();
    const payload = Buffer.alloc(1_000_000);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const data = Buffer.concat([frame('block', payload), frame('headers', Buffer.alloc(8, 7))]);

    const block = client.waitFor('block');
    const headers = client.waitFor('headers');
    for (let offset = 0; offset < data.length; offset += 1000) {
      feed(client, data.subarray(offset, offset + 1000));
    }

    expect((await block).payload.equals(payload)).toBe(true);
    expect((await headers).payload.equals(Buffer.alloc(8, 7))).toBe(true);
    expect((client as any).receiveBuffer.length).toBe(0);
  });
});
