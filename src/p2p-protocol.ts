/**
 * P2P Protocol Implementation for Navio
 *
 * Implements the Navio P2P protocol for direct node communication.
 * Supports connection handshake, message framing, and core protocol messages.
 */

import { sha256 } from '@noble/hashes/sha256';
import * as net from 'net';

/**
 * Network magic bytes for different chains
 */
export const NetworkMagic = {
  MAINNET: Buffer.from([0xdb, 0xd2, 0xb1, 0xac]),
  TESTNET: Buffer.from([0x1c, 0x03, 0xbb, 0x83]),
  REGTEST: Buffer.from([0xfd, 0xbf, 0x9f, 0xfb]),
} as const;

/**
 * Default ports for different chains
 */
export const DefaultPorts = {
  MAINNET: 44440,
  TESTNET: 33670,
  REGTEST: 18444,
} as const;

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
  INV: 'inv',
  GETDATA: 'getdata',
  NOTFOUND: 'notfound',
  GETBLOCKS: 'getblocks',
  GETHEADERS: 'getheaders',
  HEADERS: 'headers',
  BLOCK: 'block',
  TX: 'tx',
  GETOUTPUTDATA: 'getoutputdata',
  MEMPOOL: 'mempool',
  REJECT: 'reject',
  SENDHEADERS: 'sendheaders',
  SENDCMPCT: 'sendcmpct',
  CMPCTBLOCK: 'cmpctblock',
  GETBLOCKTXN: 'getblocktxn',
  BLOCKTXN: 'blocktxn',
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
} as const;

/**
 * Inventory types for getdata/inv messages
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
 * P2P connection options
 */
export interface P2PConnectionOptions {
  /** Host to connect to */
  host: string;
  /** Port (default based on network) */
  port?: number;
  /** Network type */
  network?: 'mainnet' | 'testnet' | 'regtest';
  /** Connection timeout in ms */
  timeout?: number;
  /** User agent string */
  userAgent?: string;
  /** Enable debug logging */
  debug?: boolean;
  /** Services to advertise */
  services?: bigint;
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

/**
 * P2P Protocol Client
 *
 * Low-level P2P protocol implementation for connecting to Navio nodes.
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
  private pendingMessages: Map<
    string,
    { resolve: (msg: P2PMessage) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  > = new Map();
  private messageHandlers: Map<string, ((msg: P2PMessage) => void)[]> = new Map();
  private messageQueue: Map<string, P2PMessage[]> = new Map(); // Queue for early messages
  private nonce: bigint;
  private peerVersion: number = 0;
  private _peerServices: bigint = 0n;
  private peerStartHeight: number = 0;

  constructor(options: P2PConnectionOptions) {
    const network = options.network ?? 'testnet';
    this.options = {
      host: options.host,
      port: options.port ?? DefaultPorts[network.toUpperCase() as keyof typeof DefaultPorts],
      network,
      timeout: options.timeout ?? 30000,
      userAgent: options.userAgent ?? '/navio-sdk:0.1.0/',
      debug: options.debug ?? false,
      services: options.services ?? ServiceFlags.NODE_NETWORK | ServiceFlags.NODE_WITNESS,
    };
    this.magic = NetworkMagic[network.toUpperCase() as keyof typeof NetworkMagic];
    this.nonce = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
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
      this.socket = new net.Socket();

      const connectionTimeout = setTimeout(() => {
        this.socket?.destroy();
        reject(new Error('Connection timeout'));
      }, this.options.timeout);

      this.socket.on('connect', async () => {
        this.log(`Connected to ${this.options.host}:${this.options.port}`);
        this.connected = true;

        try {
          // Send version message
          await this.sendVersion();

          // Wait for version and verack
          await this.waitForHandshake();

          clearTimeout(connectionTimeout);
          this.handshakeComplete = true;
          this.log('Handshake complete');
          resolve();
        } catch (error) {
          clearTimeout(connectionTimeout);
          this.disconnect();
          reject(error);
        }
      });

      this.socket.on('data', (data: Buffer) => {
        this.handleData(data);
      });

      this.socket.on('error', (error: Error) => {
        this.log('Socket error:', error.message);
        clearTimeout(connectionTimeout);
        this.connected = false;
        reject(error);
      });

      this.socket.on('close', (hadError: boolean) => {
        this.log(`Connection closed (hadError=${hadError}, receiveBuffer=${this.receiveBuffer.length} bytes)`);
        this.connected = false;
        this.handshakeComplete = false;
        // Reject any pending requests
        for (const [, pending] of this.pendingMessages) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Connection closed'));
        }
        this.pendingMessages.clear();
      });

      this.socket.connect(this.options.port, this.options.host);
    });
  }

  /**
   * Disconnect from the peer
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.handshakeComplete = false;
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

      // Extract payload
      const payload = this.receiveBuffer.subarray(24, totalLength);

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
      command: buffer
        .subarray(4, 16)
        .toString('ascii')
        .replace(/\0+$/, ''),
      length: buffer.readUInt32LE(16),
      checksum: buffer.subarray(20, 24),
    };
  }

  /**
   * Calculate message checksum (first 4 bytes of double SHA256)
   */
  private calculateChecksum(payload: Buffer): Buffer {
    const hash = sha256(sha256(payload));
    return Buffer.from(hash.subarray(0, 4));
  }

  /**
   * Dispatch message to handlers
   */
  private dispatchMessage(message: P2PMessage): void {
    // Check for pending requests
    const pending = this.pendingMessages.get(message.command);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingMessages.delete(message.command);
      pending.resolve(message);
      return;
    }

    // Call registered handlers
    const handlers = this.messageHandlers.get(message.command);
    if (handlers) {
      for (const handler of handlers) {
        handler(message);
      }
    }

    // Handle specific protocol messages
    switch (message.command) {
      case MessageType.PING:
        this.handlePing(message.payload);
        break;
      default:
        // Queue message for later if no handler is waiting
        // This handles race conditions during handshake
        const queue = this.messageQueue.get(message.command) ?? [];
        queue.push(message);
        this.messageQueue.set(message.command, queue);
        break;
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
   * Send a raw message
   */
  private sendMessage(command: string, payload: Buffer = Buffer.alloc(0)): void {
    if (!this.socket) {
      throw new Error('Not connected');
    }

    // Build header
    const header = Buffer.alloc(24);
    this.magic.copy(header, 0);

    // Command (12 bytes, null-padded)
    const cmdBuffer = Buffer.alloc(12);
    Buffer.from(command, 'ascii').copy(cmdBuffer);
    cmdBuffer.copy(header, 4);


    // Payload length
    header.writeUInt32LE(payload.length, 16);

    // Checksum
    const checksum = this.calculateChecksum(payload);
    checksum.copy(header, 20);

    // Send
    const message = Buffer.concat([header, payload]);
    this.socket.write(message);
    this.log('Sent:', command, `(${payload.length} bytes)`);
  }

  /**
   * Send a message and wait for a specific response
   */
  async sendAndWait(
    command: string,
    payload: Buffer,
    responseCommand: string,
    timeout?: number
  ): Promise<P2PMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMessages.delete(responseCommand);
        reject(new Error(`Timeout waiting for ${responseCommand}`));
      }, timeout ?? this.options.timeout);

      this.pendingMessages.set(responseCommand, { resolve, reject, timer });
      this.sendMessage(command, payload);
    });
  }

  /**
   * Wait for a specific message
   */
  async waitForMessage(command: string, timeout?: number): Promise<P2PMessage> {
    // First check if message is already in the queue
    const queue = this.messageQueue.get(command);
    if (queue && queue.length > 0) {
      const message = queue.shift()!;
      if (queue.length === 0) {
        this.messageQueue.delete(command);
      }
      return message;
    }

    // Otherwise wait for it
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMessages.delete(command);
        reject(new Error(`Timeout waiting for ${command}`));
      }, timeout ?? this.options.timeout);

      this.pendingMessages.set(command, { resolve, reject, timer });
    });
  }

  // ============================================================================
  // Protocol Messages
  // ============================================================================

  /**
   * Send version message
   */
  private async sendVersion(): Promise<void> {
    const payload = this.buildVersionPayload();
    this.sendMessage(MessageType.VERSION, payload);
  }

  /**
   * Build version message payload
   */
  private buildVersionPayload(): Buffer {
    const now = BigInt(Math.floor(Date.now() / 1000));

    // Calculate payload size
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

    // Version
    payload.writeInt32LE(PROTOCOL_VERSION, offset);
    offset += 4;

    // Services
    payload.writeBigUInt64LE(this.options.services, offset);
    offset += 8;

    // Timestamp
    payload.writeBigInt64LE(now, offset);
    offset += 8;

    // Addr recv (services + IPv6 + port)
    payload.writeBigUInt64LE(ServiceFlags.NODE_NETWORK, offset);
    offset += 8;
    // IPv4-mapped IPv6 address for localhost
    Buffer.from('00000000000000000000ffff7f000001', 'hex').copy(payload, offset);
    offset += 16;
    payload.writeUInt16BE(this.options.port, offset);
    offset += 2;

    // Addr from
    payload.writeBigUInt64LE(this.options.services, offset);
    offset += 8;
    Buffer.from('00000000000000000000ffff7f000001', 'hex').copy(payload, offset);
    offset += 16;
    payload.writeUInt16BE(0, offset);
    offset += 2;

    // Nonce
    payload.writeBigUInt64LE(this.nonce, offset);
    offset += 8;

    // User agent
    userAgentVarInt.copy(payload, offset);
    offset += userAgentVarInt.length;
    userAgentBytes.copy(payload, offset);
    offset += userAgentBytes.length;

    // Start height (0 for now, we don't have any blocks)
    payload.writeInt32LE(0, offset);
    offset += 4;

    // Relay
    payload.writeUInt8(1, offset);

    return payload;
  }

  /**
   * Wait for handshake completion
   */
  private async waitForHandshake(): Promise<void> {
    // Create promises for both messages we need before any data arrives
    const versionPromise = this.waitForMessage(MessageType.VERSION, 10000);
    const verackPromise = this.waitForMessage(MessageType.VERACK, 10000);

    // Wait for version
    const versionMsg = await versionPromise;
    this.parseVersionMessage(versionMsg.payload);

    // Send verack
    this.sendMessage(MessageType.VERACK);

    // Wait for verack (may have already arrived)
    await verackPromise;
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

    // Parse user agent
    const { value: userAgentLen, bytesRead } = this.decodeVarInt(payload.subarray(offset));
    offset += bytesRead;
    const userAgent = payload.subarray(offset, offset + Number(userAgentLen)).toString('utf8');
    offset += Number(userAgentLen);

    this.peerStartHeight = payload.readInt32LE(offset);

    this.log(`Peer version: ${this.peerVersion}, user agent: ${userAgent}, height: ${this.peerStartHeight}`);
  }

  /**
   * Handle ping message
   */
  private handlePing(payload: Buffer): void {
    // Respond with pong using the same nonce
    this.sendMessage(MessageType.PONG, payload);
  }

  /**
   * Send getheaders message
   */
  async getHeaders(locatorHashes: Buffer[], hashStop?: Buffer): Promise<Buffer[]> {
    const payload = this.buildBlockLocatorPayload(locatorHashes, hashStop);
    const response = await this.sendAndWait(MessageType.GETHEADERS, payload, MessageType.HEADERS);
    return this.parseHeadersMessage(response.payload);
  }

  /**
   * Build block locator payload for getheaders/getblocks
   */
  private buildBlockLocatorPayload(hashes: Buffer[], hashStop?: Buffer): Buffer {
    const hashCount = this.encodeVarInt(hashes.length);
    const payloadSize = 4 + hashCount.length + hashes.length * 32 + 32;
    const payload = Buffer.alloc(payloadSize);
    let offset = 0;

    // Version
    payload.writeUInt32LE(PROTOCOL_VERSION, offset);
    offset += 4;

    // Hash count
    hashCount.copy(payload, offset);
    offset += hashCount.length;

    // Hashes
    for (const hash of hashes) {
      hash.copy(payload, offset);
      offset += 32;
    }

    // Hash stop
    if (hashStop) {
      hashStop.copy(payload, offset);
    }
    // else: already zeroed

    return payload;
  }

  /**
   * Parse headers message
   *
   * Note: Navio's headers message format differs from Bitcoin's.
   * Bitcoin includes a varint tx_count (always 0) after each 80-byte header.
   * Navio sends just the raw 80-byte headers with no tx_count.
   */
  private parseHeadersMessage(payload: Buffer): Buffer[] {
    let offset = 0;
    const { value: count, bytesRead } = this.decodeVarInt(payload);
    offset += bytesRead;

    this.log(`Parsing ${count} headers from ${payload.length} bytes`);

    const headers: Buffer[] = [];
    for (let i = 0; i < Number(count); i++) {
      // Check bounds before reading header
      if (offset + 80 > payload.length) {
        this.log(`Headers parse: reached end of payload at header ${i}`);
        break;
      }

      // Each header is exactly 80 bytes (no tx count in Navio's format)
      const header = payload.subarray(offset, offset + 80);
      headers.push(Buffer.from(header));
      offset += 80;
    }

    this.log(`Parsed ${headers.length} headers`);
    return headers;
  }

  /**
   * Send getdata message
   */
  async getData(inventory: InvVector[]): Promise<void> {
    const payload = this.buildInvPayload(inventory);
    this.sendMessage(MessageType.GETDATA, payload);
  }

  /**
   * Build inventory payload for inv/getdata
   */
  private buildInvPayload(inventory: InvVector[]): Buffer {
    const countVarInt = this.encodeVarInt(inventory.length);
    const payloadSize = countVarInt.length + inventory.length * 36;
    const payload = Buffer.alloc(payloadSize);
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
   * Request a block by hash
   */
  async getBlock(blockHash: Buffer): Promise<P2PMessage> {
    const inventory: InvVector[] = [{ type: InvType.MSG_WITNESS_BLOCK, hash: blockHash }];
    const getDataPayload = this.buildInvPayload(inventory);

    // Send getdata and wait for block
    return this.sendAndWait(MessageType.GETDATA, getDataPayload, MessageType.BLOCK);
  }

  /**
   * Request transaction outputs by output hash (Navio-specific)
   */
  async getOutputData(outputHashes: Buffer[]): Promise<P2PMessage> {
    const countVarInt = this.encodeVarInt(outputHashes.length);
    const payloadSize = countVarInt.length + outputHashes.length * 32;
    const payload = Buffer.alloc(payloadSize);
    let offset = 0;

    countVarInt.copy(payload, offset);
    offset += countVarInt.length;

    for (const hash of outputHashes) {
      hash.copy(payload, offset);
      offset += 32;
    }

    return this.sendAndWait(MessageType.GETOUTPUTDATA, payload, MessageType.TX);
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
    const first = buffer.readUInt8(0);

    if (first < 0xfd) {
      return { value: BigInt(first), bytesRead: 1 };
    } else if (first === 0xfd) {
      return { value: BigInt(buffer.readUInt16LE(1)), bytesRead: 3 };
    } else if (first === 0xfe) {
      return { value: BigInt(buffer.readUInt32LE(1)), bytesRead: 5 };
    } else {
      return { value: buffer.readBigUInt64LE(1), bytesRead: 9 };
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

