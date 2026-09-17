/**
 * P2P Protocol Implementation for Navio
 *
 * Implements the Navio P2P protocol for direct node communication.
 * Supports connection handshake, message framing, and core protocol messages.
 *
 * Network constants mirror navio-core `src/kernel/chainparams.cpp`
 * (`pchMessageStart` / `nDefaultPort`). `blsctregtest` shares the regtest
 * magic and port.
 */

import { sha256 } from '@noble/hashes/sha256';
import * as net from 'net';

/**
 * Network magic bytes for different chains
 */
export const NetworkMagic = {
  MAINNET: Buffer.from([0xbd, 0x5f, 0xc3, 0x00]),
  TESTNET: Buffer.from([0x24, 0x67, 0xd2, 0xc1]),
  REGTEST: Buffer.from([0xfd, 0xbf, 0x9f, 0xfb]),
} as const;

/**
 * Default ports for different chains
 */
export const DefaultPorts = {
  MAINNET: 48470,
  TESTNET: 33670,
  REGTEST: 18444,
} as const;

/**
 * P2P network name
 */
export type P2PNetwork = 'mainnet' | 'testnet' | 'regtest';

/**
 * P2P message types
 */
export const MessageType = {
  VERSION: 'version',
  VERACK: 'verack',
  PING: 'ping',
  PONG: 'pong',
  GETADDR: 'getaddr',
  ADDR: 'addr',
  ADDRV2: 'addrv2',
  SENDADDRV2: 'sendaddrv2',
  WTXIDRELAY: 'wtxidrelay',
  INV: 'inv',
  GETDATA: 'getdata',
  NOTFOUND: 'notfound',
  GETBLOCKS: 'getblocks',
  GETHEADERS: 'getheaders',
  HEADERS: 'headers',
  BLOCK: 'block',
  TX: 'tx',
  /** Dandelion++ stem transaction (same payload as `tx`) */
  DTX: 'dtx',
  /**
   * navio-core's output-hash request. Unusable on the wire: the name is 13
   * characters but the command field holds 12, so nodes see `getoutputdat`
   * and drop it as unknown. Use getdata(MSG_WITNESS_TX, outputHash) instead.
   */
  GETOUTPUTDATA: 'getoutputdata',
  MEMPOOL: 'mempool',
  REJECT: 'reject',
  SENDHEADERS: 'sendheaders',
  SENDCMPCT: 'sendcmpct',
  CMPCTBLOCK: 'cmpctblock',
  GETBLOCKTXN: 'getblocktxn',
  BLOCKTXN: 'blocktxn',
  FEEFILTER: 'feefilter',
} as const;

/**
 * Service flags
 */
export const ServiceFlags = {
  NODE_NONE: 0n,
  NODE_NETWORK: 1n << 0n,
  NODE_BLOOM: 1n << 2n,
  NODE_WITNESS: 1n << 3n,
  NODE_COMPACT_FILTERS: 1n << 6n,
  NODE_NETWORK_LIMITED: 1n << 10n,
  NODE_P2P_V2: 1n << 11n,
  NODE_P2PMSG: 1n << 24n,
  NODE_P2PMSG_LEAF: 1n << 25n,
} as const;

/**
 * Inventory types for getdata/inv messages (navio-core `protocol.h`)
 */
export const InvType = {
  ERROR: 0,
  MSG_TX: 1,
  MSG_BLOCK: 2,
  MSG_FILTERED_BLOCK: 3,
  MSG_CMPCT_BLOCK: 4,
  MSG_WTX: 5,
  MSG_DTX: 6,
  MSG_DWTX: 7,
  MSG_OUTPUT_HASH: 8,
  MSG_WITNESS_FLAG: 1 << 30,
  MSG_WITNESS_BLOCK: 2 | (1 << 30),
  MSG_WITNESS_TX: 1 | (1 << 30),
} as const;

/**
 * Protocol version
 */
export const PROTOCOL_VERSION = 70016;

/**
 * Maximum headers a node returns per `getheaders` (navio-core MAX_HEADERS_RESULTS)
 */
export const MAX_HEADERS_RESULTS = 2000;

/**
 * P2P connection options
 */
export interface P2PConnectionOptions {
  /** Host to connect to */
  host: string;
  /** Port (default based on network) */
  port?: number;
  /** Network type (default: mainnet) */
  network?: P2PNetwork;
  /** Request timeout in ms (also the TCP connect + handshake timeout) */
  timeout?: number;
  /** User agent string */
  userAgent?: string;
  /** Enable debug logging */
  debug?: boolean;
  /**
   * Services to advertise. Default NODE_NONE: a light client serves nothing,
   * and advertising NODE_NETWORK would make the node pick us as a
   * headers-sync peer and wait on requests we never answer.
   */
  services?: bigint;
  /** Start height to advertise in the version message (default 0) */
  startHeight?: number;
}

/**
 * Message header structure
 */
export interface MessageHeader {
  magic: Buffer;
  command: string;
  length: number;
  checksum: Buffer;
}

/**
 * Parsed P2P message
 */
export interface P2PMessage {
  command: string;
  payload: Buffer;
}

/**
 * Version message payload
 */
export interface VersionPayload {
  version: number;
  services: bigint;
  timestamp: bigint;
  addrRecv: {
    services: bigint;
    ip: Buffer;
    port: number;
  };
  addrFrom: {
    services: bigint;
    ip: Buffer;
    port: number;
  };
  nonce: bigint;
  userAgent: string;
  startHeight: number;
  relay: boolean;
}

/**
 * Inventory vector
 */
export interface InvVector {
  type: number;
  hash: Buffer;
}

/**
 * Block locator for getheaders/getblocks
 */
export interface BlockLocator {
  version: number;
  hashes: Buffer[];
  hashStop: Buffer;
}

interface Waiter {
  commands: Set<string>;
  predicate: (msg: P2PMessage) => boolean;
  resolve: (msg: P2PMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Double SHA256
 */
function hash256(data: Uint8Array): Buffer {
  return Buffer.from(sha256(sha256(data)));
}

/**
 * P2P Protocol Client
 *
 * Low-level P2P protocol implementation for connecting to Navio nodes.
 * Frames messages, runs the version/verack handshake, answers pings, and
 * offers request/response helpers whose responses are matched by content
 * (block hash, inventory hash) so concurrent requests do not collide.
 *
 * @category Protocol
 */
export class P2PClient {
  private socket: net.Socket | null = null;
  private options: Required<P2PConnectionOptions>;
  private magic: Buffer;
  private connected = false;
  private handshakeComplete = false;
  private receiveBuffer = Buffer.alloc(0);
  private waiters: Waiter[] = [];
  private messageHandlers: Map<string, ((msg: P2PMessage) => void)[]> = new Map();
  private closeHandlers: ((err?: Error) => void)[] = [];
  private nonce: bigint;
  private peerVersion: number = 0;
  private _peerServices: bigint = 0n;
  private peerStartHeight: number = 0;
  private peerUserAgent: string = '';
  private verackReceived = false;
  private versionReceived = false;
  private handshakeWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(options: P2PConnectionOptions) {
    const network = options.network ?? 'mainnet';
    const key = network.toUpperCase() as keyof typeof NetworkMagic;
    if (!NetworkMagic[key]) {
      throw new Error(`Unsupported P2P network: ${network}`);
    }
    this.options = {
      host: options.host,
      port: options.port ?? DefaultPorts[key],
      network,
      timeout: options.timeout ?? 30000,
      userAgent: options.userAgent ?? '/navio-sdk:0.1.0/',
      debug: options.debug ?? false,
      services: options.services ?? ServiceFlags.NODE_NONE,
      startHeight: options.startHeight ?? 0,
    };
    this.magic = NetworkMagic[key];
    const nonceBytes = Buffer.alloc(8);
    for (let i = 0; i < 8; i++) nonceBytes[i] = Math.floor(Math.random() * 256);
    this.nonce = nonceBytes.readBigUInt64LE(0);
  }

  private log(...args: unknown[]): void {
    if (this.options.debug) {
      console.log('[P2P]', ...args);
    }
  }

  /**
   * Connect to the peer and complete handshake
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      this.socket = socket;
      this.receiveBuffer = Buffer.alloc(0);
      this.versionReceived = false;
      this.verackReceived = false;
      this.handshakeComplete = false;

      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectionTimeout);
        this.handshakeWaiter = null;
        this.disconnect();
        reject(err);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectionTimeout);
        this.handshakeWaiter = null;
        this.handshakeComplete = true;
        this.log('Handshake complete');
        resolve();
      };

      const connectionTimeout = setTimeout(() => {
        fail(new Error(`Connection timeout (${this.options.host}:${this.options.port})`));
      }, this.options.timeout);

      this.handshakeWaiter = { resolve: succeed, reject: fail };

      socket.setNoDelay(true);

      socket.on('connect', () => {
        this.log(`Connected to ${this.options.host}:${this.options.port}`);
        this.connected = true;
        try {
          this.sendMessage(MessageType.VERSION, this.buildVersionPayload());
        } catch (error) {
          fail(error as Error);
        }
      });

      socket.on('data', (data: Buffer) => {
        if (this.socket !== socket) return;
        this.handleData(data);
      });

      socket.on('error', (error: Error) => {
        this.log('Socket error:', error.message);
        if (!settled) {
          fail(error);
        }
      });

      socket.on('close', (hadError: boolean) => {
        if (this.socket !== socket) return;
        this.log(`Connection closed (hadError=${hadError})`);
        this.onClosed(new Error('Connection closed'));
        if (!settled) {
          fail(new Error('Connection closed before handshake completed'));
        }
      });

      socket.connect(this.options.port, this.options.host);
    });
  }

  /**
   * Disconnect from the peer
   */
  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners('data');
      socket.destroy();
    }
    this.onClosed(new Error('Disconnected'));
  }

  private onClosed(err: Error): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.handshakeComplete = false;
    this.receiveBuffer = Buffer.alloc(0);
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    if (wasConnected) {
      for (const h of this.closeHandlers) {
        try {
          h(err);
        } catch {
          // handler errors must not break teardown
        }
      }
    }
  }

  /**
   * Check if connected and handshake complete
   */
  isConnected(): boolean {
    return this.connected && this.handshakeComplete;
  }

  /**
   * Get peer's advertised start height
   */
  getPeerStartHeight(): number {
    return this.peerStartHeight;
  }

  /**
   * Get peer's protocol version
   */
  getPeerVersion(): number {
    return this.peerVersion;
  }

  /**
   * Get peer's advertised services
   */
  getPeerServices(): bigint {
    return this._peerServices;
  }

  /**
   * Get peer's user agent
   */
  getPeerUserAgent(): string {
    return this.peerUserAgent;
  }

  /**
   * Register a handler invoked when an established connection closes
   */
  onClose(handler: (err?: Error) => void): void {
    this.closeHandlers.push(handler);
  }

  /**
   * Handle incoming data
   */
  private handleData(data: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);

    // Try to parse complete messages
    while (this.receiveBuffer.length >= 24) {
      // Check magic bytes
      if (!this.receiveBuffer.subarray(0, 4).equals(this.magic)) {
        // Invalid magic, try to find valid header
        const magicIndex = this.receiveBuffer.indexOf(this.magic, 1);
        if (magicIndex === -1) {
          this.receiveBuffer = Buffer.alloc(0);
          return;
        }
        this.receiveBuffer = this.receiveBuffer.subarray(magicIndex);
        continue;
      }

      // Parse header
      const header = this.parseHeader(this.receiveBuffer);
      const totalLength = 24 + header.length;

      // Check if we have the full message
      if (this.receiveBuffer.length < totalLength) {
        return; // Wait for more data
      }

      // Extract payload (copy: the receive buffer is sliced and reused)
      const payload = Buffer.from(this.receiveBuffer.subarray(24, totalLength));

      // Verify checksum
      const expectedChecksum = this.calculateChecksum(payload);
      if (!header.checksum.equals(expectedChecksum)) {
        this.log('Checksum mismatch for', header.command);
        this.receiveBuffer = this.receiveBuffer.subarray(totalLength);
        continue;
      }

      // Remove processed message from buffer
      this.receiveBuffer = this.receiveBuffer.subarray(totalLength);

      // Handle message
      const message: P2PMessage = { command: header.command, payload };
      this.log('Received:', header.command, `(${header.length} bytes)`);
      this.dispatchMessage(message);
    }
  }

  /**
   * Parse message header
   */
  private parseHeader(buffer: Buffer): MessageHeader {
    return {
      magic: buffer.subarray(0, 4),
      command: buffer.subarray(4, 16).toString('ascii').replace(/\0+$/, ''),
      length: buffer.readUInt32LE(16),
      checksum: buffer.subarray(20, 24),
    };
  }

  /**
   * Calculate message checksum (first 4 bytes of double SHA256)
   */
  private calculateChecksum(payload: Buffer): Buffer {
    return hash256(payload).subarray(0, 4);
  }

  /**
   * Dispatch message to handlers
   */
  private dispatchMessage(message: P2PMessage): void {
    switch (message.command) {
      case MessageType.VERSION:
        this.handleVersion(message.payload);
        return;
      case MessageType.VERACK:
        this.verackReceived = true;
        this.maybeHandshakeDone();
        return;
      case MessageType.PING:
        this.handlePing(message.payload);
        return;
      default:
        break;
    }

    // Waiters: the first matching waiter consumes the message
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      if (!w.commands.has(message.command)) continue;
      let matched = false;
      try {
        matched = w.predicate(message);
      } catch (e) {
        this.log(`Waiter predicate threw for ${message.command}: ${e}`);
      }
      if (matched) {
        this.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(message);
        break;
      }
    }

    // Call registered handlers
    const handlers = this.messageHandlers.get(message.command);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(message);
        } catch (e) {
          this.log(`Handler for ${message.command} threw: ${e}`);
        }
      }
    }
  }

  /**
   * Register a message handler
   */
  onMessage(command: string, handler: (msg: P2PMessage) => void): void {
    const handlers = this.messageHandlers.get(command) ?? [];
    handlers.push(handler);
    this.messageHandlers.set(command, handlers);
  }

  /**
   * Remove a message handler
   */
  offMessage(command: string, handler: (msg: P2PMessage) => void): void {
    const handlers = this.messageHandlers.get(command);
    if (!handlers) return;
    const idx = handlers.indexOf(handler);
    if (idx >= 0) handlers.splice(idx, 1);
  }

  /**
   * Send a raw message
   */
  sendMessage(command: string, payload: Buffer = Buffer.alloc(0)): void {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected');
    }

    // Build header
    const header = Buffer.alloc(24);
    this.magic.copy(header, 0);

    // Command (12 bytes, null-padded)
    Buffer.from(command, 'ascii').copy(header, 4);

    // Payload length
    header.writeUInt32LE(payload.length, 16);

    // Checksum
    this.calculateChecksum(payload).copy(header, 20);

    // Send
    this.socket.write(Buffer.concat([header, payload]));
    this.log('Sent:', command, `(${payload.length} bytes)`);
  }

  /**
   * Wait for the next message of one of the given commands that satisfies
   * `predicate`. The waiter is registered synchronously, so it is safe to
   * send the request right after calling this.
   */
  waitFor(
    commands: string | string[],
    predicate: (msg: P2PMessage) => boolean = () => true,
    timeout?: number
  ): Promise<P2PMessage> {
    const cmdSet = new Set(Array.isArray(commands) ? commands : [commands]);
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('Not connected'));
        return;
      }
      const waiter: Waiter = {
        commands: cmdSet,
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new Error(`Timeout waiting for ${[...cmdSet].join('/')}`));
        }, timeout ?? this.options.timeout),
      };
      this.waiters.push(waiter);
    });
  }

  /**
   * Send a message and wait for a matching response
   */
  async request(
    command: string,
    payload: Buffer,
    responseCommands: string | string[],
    predicate: (msg: P2PMessage) => boolean = () => true,
    timeout?: number
  ): Promise<P2PMessage> {
    const promise = this.waitFor(responseCommands, predicate, timeout);
    // Attach a no-op catch so a synchronous send failure cannot leave an
    // unhandled rejection behind; the caller still observes the rejection.
    promise.catch(() => undefined);
    this.sendMessage(command, payload);
    return promise;
  }

  /**
   * Send a message and wait for a specific response (matches the first
   * message with `responseCommand`)
   */
  async sendAndWait(
    command: string,
    payload: Buffer,
    responseCommand: string,
    timeout?: number
  ): Promise<P2PMessage> {
    return this.request(command, payload, responseCommand, () => true, timeout);
  }

  /**
   * Wait for the next message with the given command
   */
  async waitForMessage(command: string, timeout?: number): Promise<P2PMessage> {
    return this.waitFor(command, () => true, timeout);
  }

  // ============================================================================
  // Protocol Messages
  // ============================================================================

  /**
   * Build version message payload
   */
  private buildVersionPayload(): Buffer {
    const now = BigInt(Math.floor(Date.now() / 1000));

    const userAgentBytes = Buffer.from(this.options.userAgent, 'utf8');
    const userAgentVarInt = this.encodeVarInt(userAgentBytes.length);

    const payloadSize =
      4 + // version
      8 + // services
      8 + // timestamp
      26 + // addr_recv
      26 + // addr_from
      8 + // nonce
      userAgentVarInt.length +
      userAgentBytes.length +
      4 + // start_height
      1; // relay

    const payload = Buffer.alloc(payloadSize);
    let offset = 0;

    payload.writeInt32LE(PROTOCOL_VERSION, offset);
    offset += 4;

    payload.writeBigUInt64LE(this.options.services, offset);
    offset += 8;

    payload.writeBigInt64LE(now, offset);
    offset += 8;

    // addr_recv: services + IPv6 (unspecified) + port
    payload.writeBigUInt64LE(0n, offset);
    offset += 8 + 16;
    payload.writeUInt16BE(this.options.port, offset);
    offset += 2;

    // addr_from
    payload.writeBigUInt64LE(this.options.services, offset);
    offset += 8 + 16;
    payload.writeUInt16BE(0, offset);
    offset += 2;

    payload.writeBigUInt64LE(this.nonce, offset);
    offset += 8;

    userAgentVarInt.copy(payload, offset);
    offset += userAgentVarInt.length;
    userAgentBytes.copy(payload, offset);
    offset += userAgentBytes.length;

    payload.writeInt32LE(this.options.startHeight, offset);
    offset += 4;

    // relay = true: a peer that opts out of tx relay gets no answers to
    // getdata(tx) / getoutputdata and its broadcasts are dropped.
    payload.writeUInt8(1, offset);

    return payload;
  }

  /**
   * Handle the peer's version message.
   *
   * BIP155/BIP339 feature negotiation (`sendaddrv2`, `wtxidrelay`) must
   * happen between version and verack — the node disconnects a peer that
   * sends them after verack. We need neither, so we send only verack.
   */
  private handleVersion(payload: Buffer): void {
    if (this.versionReceived) {
      this.log('Duplicate version message ignored');
      return;
    }
    this.versionReceived = true;
    try {
      this.parseVersionMessage(payload);
    } catch (e) {
      this.handshakeWaiter?.reject(new Error(`Malformed version message: ${e}`));
      return;
    }
    try {
      this.sendMessage(MessageType.VERACK);
    } catch (e) {
      this.handshakeWaiter?.reject(e as Error);
      return;
    }
    this.maybeHandshakeDone();
  }

  private maybeHandshakeDone(): void {
    if (this.versionReceived && this.verackReceived && this.handshakeWaiter) {
      this.handshakeWaiter.resolve();
    }
  }

  /**
   * Parse version message
   */
  private parseVersionMessage(payload: Buffer): void {
    let offset = 0;

    this.peerVersion = payload.readInt32LE(offset);
    offset += 4;

    this._peerServices = payload.readBigUInt64LE(offset);
    offset += 8;

    // Skip timestamp (8), addr_recv (26), addr_from (26), nonce (8)
    offset += 8 + 26 + 26 + 8;

    const { value: userAgentLen, bytesRead } = this.decodeVarInt(payload.subarray(offset));
    offset += bytesRead;
    this.peerUserAgent = payload.subarray(offset, offset + Number(userAgentLen)).toString('utf8');
    offset += Number(userAgentLen);

    this.peerStartHeight = payload.readInt32LE(offset);

    this.log(
      `Peer version: ${this.peerVersion}, user agent: ${this.peerUserAgent}, height: ${this.peerStartHeight}`
    );
  }

  /**
   * Handle ping message
   */
  private handlePing(payload: Buffer): void {
    try {
      this.sendMessage(MessageType.PONG, payload);
    } catch {
      // connection went away
    }
  }

  /**
   * Send getheaders and return the raw 80-byte headers.
   *
   * Responses carry no request id; callers must not issue concurrent
   * getheaders requests on one connection.
   */
  async getHeaders(
    locatorHashes: Buffer[],
    hashStop?: Buffer,
    timeout?: number
  ): Promise<Buffer[]> {
    const payload = this.buildBlockLocatorPayload(locatorHashes, hashStop);
    const response = await this.request(
      MessageType.GETHEADERS,
      payload,
      MessageType.HEADERS,
      () => true,
      timeout
    );
    return P2PClient.parseHeadersMessage(response.payload);
  }

  /**
   * Build block locator payload for getheaders/getblocks
   */
  private buildBlockLocatorPayload(hashes: Buffer[], hashStop?: Buffer): Buffer {
    const hashCount = this.encodeVarInt(hashes.length);
    const payloadSize = 4 + hashCount.length + hashes.length * 32 + 32;
    const payload = Buffer.alloc(payloadSize);
    let offset = 0;

    payload.writeUInt32LE(PROTOCOL_VERSION, offset);
    offset += 4;

    hashCount.copy(payload, offset);
    offset += hashCount.length;

    for (const hash of hashes) {
      hash.copy(payload, offset);
      offset += 32;
    }

    if (hashStop) {
      hashStop.copy(payload, offset);
    }

    return payload;
  }

  /**
   * Parse a headers message into raw 80-byte headers.
   *
   * navio-core serializes `std::vector<CBlockHeader>` (both for getheaders
   * responses and announcements): bare 80-byte headers with no trailing
   * tx-count varint. A Bitcoin-style layout (81 bytes per header, trailing
   * 0x00) is tolerated for robustness.
   */
  static parseHeadersMessage(payload: Buffer): Buffer[] {
    if (payload.length === 0) return [];
    const { value, bytesRead } = P2PClient.decodeVarIntStatic(payload, 0);
    const count = Number(value);
    const body = payload.length - bytesRead;
    let stride = 80;
    if (count > 0 && body === count * 81) {
      stride = 81;
    } else if (count > 0 && body !== count * 80) {
      throw new Error(`Malformed headers message: ${count} headers in ${body} bytes`);
    }
    const headers: Buffer[] = [];
    let offset = bytesRead;
    for (let i = 0; i < count; i++) {
      headers.push(Buffer.from(payload.subarray(offset, offset + 80)));
      offset += stride;
    }
    return headers;
  }

  /**
   * Parse an inv/notfound/getdata payload
   */
  static parseInvPayload(payload: Buffer): InvVector[] {
    if (payload.length === 0) return [];
    const { value, bytesRead } = P2PClient.decodeVarIntStatic(payload, 0);
    const count = Number(value);
    const out: InvVector[] = [];
    let offset = bytesRead;
    for (let i = 0; i < count && offset + 36 <= payload.length; i++) {
      out.push({
        type: payload.readUInt32LE(offset),
        hash: Buffer.from(payload.subarray(offset + 4, offset + 36)),
      });
      offset += 36;
    }
    return out;
  }

  /**
   * Send getdata message (fire and forget)
   */
  async getData(inventory: InvVector[]): Promise<void> {
    this.sendMessage(MessageType.GETDATA, this.buildInvPayload(inventory));
  }

  /**
   * Build inventory payload for inv/getdata
   */
  buildInvPayload(inventory: InvVector[]): Buffer {
    const countVarInt = this.encodeVarInt(inventory.length);
    const payload = Buffer.alloc(countVarInt.length + inventory.length * 36);
    let offset = 0;

    countVarInt.copy(payload, offset);
    offset += countVarInt.length;

    for (const inv of inventory) {
      payload.writeUInt32LE(inv.type, offset);
      offset += 4;
      inv.hash.copy(payload, offset);
      offset += 32;
    }

    return payload;
  }

  /**
   * Hash of a block message payload (double SHA256 of its 80-byte header),
   * internal byte order.
   */
  static blockPayloadHash(payload: Buffer): Buffer {
    return hash256(payload.subarray(0, 80));
  }

  /**
   * Request a block by hash (internal byte order). Resolves with the block
   * message whose header hashes to `blockHash`; rejects on `notfound`.
   */
  async getBlock(blockHash: Buffer, timeout?: number): Promise<P2PMessage> {
    const payload = this.buildInvPayload([{ type: InvType.MSG_WITNESS_BLOCK, hash: blockHash }]);
    const response = await this.request(
      MessageType.GETDATA,
      payload,
      [MessageType.BLOCK, MessageType.NOTFOUND],
      msg => {
        if (msg.command === MessageType.BLOCK) {
          return (
            msg.payload.length >= 80 && P2PClient.blockPayloadHash(msg.payload).equals(blockHash)
          );
        }
        return P2PClient.parseInvPayload(msg.payload).some(inv => inv.hash.equals(blockHash));
      },
      timeout
    );
    if (response.command === MessageType.NOTFOUND) {
      throw new Error(`Block not found: ${P2PClient.hashToDisplay(blockHash)}`);
    }
    return response;
  }

  /**
   * Request a transaction by txid (internal byte order). `matches` decides
   * whether a received `tx`/`dtx` payload is the requested transaction.
   * Resolves with the raw transaction bytes; rejects on `notfound`.
   */
  async getTransaction(
    txHash: Buffer,
    matches: (txPayload: Buffer) => boolean,
    timeout?: number
  ): Promise<Buffer> {
    const payload = this.buildInvPayload([{ type: InvType.MSG_WITNESS_TX, hash: txHash }]);
    const response = await this.request(
      MessageType.GETDATA,
      payload,
      [MessageType.TX, MessageType.DTX, MessageType.NOTFOUND],
      msg => {
        if (msg.command === MessageType.NOTFOUND) {
          return P2PClient.parseInvPayload(msg.payload).some(inv => inv.hash.equals(txHash));
        }
        return matches(msg.payload);
      },
      timeout
    );
    if (response.command === MessageType.NOTFOUND) {
      throw new Error(`Transaction not found: ${P2PClient.hashToDisplay(txHash)}`);
    }
    return response.payload;
  }

  /**
   * Request the transaction containing an output, by output hash (internal
   * byte order). `matches` decides whether a received `tx`/`dtx` payload
   * contains the output. Resolves with the raw transaction bytes; rejects on
   * `notfound`.
   *
   * Sent as `getdata` with `MSG_WITNESS_TX`: navio-core falls back to an
   * output-hash lookup for that inventory type (net_processing.cpp,
   * ProcessGetData -> FindTxByOutputHash). The dedicated `getoutputdata`
   * message cannot be used: its name is 13 characters, one more than the
   * 12-byte command field, so nodes receive `getoutputdat` and ignore it as
   * an unknown command.
   *
   * The node only answers for outputs in its mempool or most recent block.
   */
  async getOutputData(
    outputHash: Buffer,
    matches: (txPayload: Buffer) => boolean,
    timeout?: number
  ): Promise<Buffer> {
    const payload = this.buildInvPayload([{ type: InvType.MSG_WITNESS_TX, hash: outputHash }]);
    const response = await this.request(
      MessageType.GETDATA,
      payload,
      [MessageType.TX, MessageType.DTX, MessageType.NOTFOUND],
      msg => {
        if (msg.command === MessageType.NOTFOUND) {
          return P2PClient.parseInvPayload(msg.payload).some(inv => inv.hash.equals(outputHash));
        }
        return matches(msg.payload);
      },
      timeout
    );
    if (response.command === MessageType.NOTFOUND) {
      throw new Error(`Output not found: ${P2PClient.hashToDisplay(outputHash)}`);
    }
    return response.payload;
  }

  /**
   * Push a transaction to the peer (unsolicited `tx`, accepted by navio-core)
   */
  sendTransaction(rawTx: Buffer): void {
    this.sendMessage(MessageType.TX, rawTx);
  }

  /**
   * Send sendheaders message to prefer headers announcements
   */
  sendSendHeaders(): void {
    this.sendMessage(MessageType.SENDHEADERS);
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Encode a variable-length integer
   */
  encodeVarInt(value: number | bigint): Buffer {
    const n = typeof value === 'bigint' ? value : BigInt(value);

    if (n < 0xfd) {
      const buf = Buffer.alloc(1);
      buf.writeUInt8(Number(n));
      return buf;
    } else if (n <= 0xffff) {
      const buf = Buffer.alloc(3);
      buf.writeUInt8(0xfd);
      buf.writeUInt16LE(Number(n), 1);
      return buf;
    } else if (n <= 0xffffffff) {
      const buf = Buffer.alloc(5);
      buf.writeUInt8(0xfe);
      buf.writeUInt32LE(Number(n), 1);
      return buf;
    } else {
      const buf = Buffer.alloc(9);
      buf.writeUInt8(0xff);
      buf.writeBigUInt64LE(n, 1);
      return buf;
    }
  }

  /**
   * Decode a variable-length integer
   */
  decodeVarInt(buffer: Buffer): { value: bigint; bytesRead: number } {
    return P2PClient.decodeVarIntStatic(buffer, 0);
  }

  static decodeVarIntStatic(buffer: Buffer, offset: number): { value: bigint; bytesRead: number } {
    const first = buffer.readUInt8(offset);

    if (first < 0xfd) {
      return { value: BigInt(first), bytesRead: 1 };
    } else if (first === 0xfd) {
      return { value: BigInt(buffer.readUInt16LE(offset + 1)), bytesRead: 3 };
    } else if (first === 0xfe) {
      return { value: BigInt(buffer.readUInt32LE(offset + 1)), bytesRead: 5 };
    } else {
      return { value: buffer.readBigUInt64LE(offset + 1), bytesRead: 9 };
    }
  }

  /**
   * Reverse a hash for display (Bitcoin uses little-endian internally, big-endian for display)
   */
  static reverseHash(hash: Buffer): Buffer {
    return Buffer.from(hash).reverse();
  }

  /**
   * Convert display hash to internal format
   */
  static hashFromDisplay(hexHash: string): Buffer {
    return Buffer.from(hexHash, 'hex').reverse();
  }

  /**
   * Convert internal hash to display format
   */
  static hashToDisplay(hash: Buffer): string {
    return Buffer.from(hash).reverse().toString('hex');
  }
}
