import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { ElectrumClient } from './electrum';

describe('ElectrumClient connection', () => {
  let server: WebSocketServer;
  let port: number;
  let connections: number;

  beforeEach(async () => {
    connections = 0;
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    server.on('connection', socket => {
      connections++;
      socket.on('message', raw => {
        const request = JSON.parse(String(raw));
        const result =
          request.method === 'server.version' ? ['mock', '1.4'] : { tokenId: request.params[0] };
        // Reply a little later, as a real server would.
        setTimeout(() => socket.send(JSON.stringify({ id: request.id, result })), 20);
      });
    });
    await new Promise(resolve => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('serves concurrent first calls over one connection', async () => {
    const client = new ElectrumClient({ host: '127.0.0.1', port, ssl: false, timeout: 3_000 });
    try {
      const tokens = await Promise.all(
        ['aa', 'bb', 'cc'].map(byte => client.getToken(byte.repeat(32)))
      );

      expect(tokens.map(token => token.tokenId)).toEqual(
        ['aa', 'bb', 'cc'].map(byte => byte.repeat(32))
      );
      expect(connections).toBe(1);
    } finally {
      client.disconnect();
    }
  });
});
