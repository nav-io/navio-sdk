import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ElectrumClient, setWebSocketClass } from './electrum';
import type { BlockHeaderNotification } from './sync-provider';

// Mock WebSocket for testing
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  
  private listeners = new Map<string, Function[]>();
  private messageQueue: string[] = [];
  readyState = 1; // OPEN
  
  constructor(_url: string) {
    MockWebSocket.instances.push(this);
    // Simulate async connection
    setTimeout(() => {
      this.emit('open');
    }, 0);
  }
  
  on(event: string, handler: Function): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(handler);
  }
  
  private emit(event: string, ...args: any[]): void {
    const handlers = this.listeners.get(event) || [];
    for (const handler of handlers) {
      handler(...args);
    }
  }
  
  send(data: string): void {
    this.messageQueue.push(data);
    // Parse and handle the request
    const request = JSON.parse(data);
    
    // Simulate server responses
    if (request.method === 'server.version') {
      this.simulateResponse(request.id, ['ElectrumX 1.16.0', '1.4']);
    } else if (request.method === 'blockchain.headers.subscribe') {
      this.simulateResponse(request.id, { height: 100000, hex: '00'.repeat(80) });
    } else if (request.method === 'blockchain.block.header') {
      this.simulateResponse(request.id, '00'.repeat(80));
    }
  }
  
  simulateResponse(id: number, result: any): void {
    setTimeout(() => {
      this.emit('message', JSON.stringify({ id, result }));
    }, 0);
  }
  
  simulateNotification(method: string, params: any): void {
    this.emit('message', JSON.stringify({ method, params }));
  }
  
  close(): void {
    this.emit('close');
  }
  
  getLastMessage(): any {
    if (this.messageQueue.length === 0) return null;
    return JSON.parse(this.messageQueue[this.messageQueue.length - 1]);
  }
  
  static reset(): void {
    MockWebSocket.instances = [];
  }
  
  static getLastInstance(): MockWebSocket | null {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1] || null;
  }
}

describe('ElectrumClient', () => {
  beforeEach(() => {
    MockWebSocket.reset();
    // Inject mock WebSocket class
    setWebSocketClass(MockWebSocket);
  });

  afterEach(() => {
    MockWebSocket.reset();
    // Restore default WebSocket class
    setWebSocketClass(null);
  });

  describe('subscription handling', () => {
    it('should register block header subscription callback', async () => {
      const client = new ElectrumClient({ host: 'localhost', port: 50001 });
      await client.connect();

      const callback = vi.fn();
      const initialHeader = await client.subscribeBlockHeaders(callback);

      expect(initialHeader).toBeDefined();
      expect(initialHeader.height).toBe(100000);
      expect(client.hasBlockHeaderSubscriptions()).toBe(true);
    });

    it('should invoke callback on block header notification', async () => {
      const client = new ElectrumClient({ host: 'localhost', port: 50001 });
      await client.connect();

      const callback = vi.fn();
      await client.subscribeBlockHeaders(callback);

      // Simulate a block notification from server
      const ws = MockWebSocket.getLastInstance()!;
      const notification: BlockHeaderNotification = { height: 100001, hex: 'ff'.repeat(80) };
      ws.simulateNotification('blockchain.headers.subscribe', notification);

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(callback).toHaveBeenCalledWith(notification);
    });

    it('should support multiple callbacks for same subscription', async () => {
      const client = new ElectrumClient({ host: 'localhost', port: 50001 });
      await client.connect();

      const callback1 = vi.fn();
      const callback2 = vi.fn();
      
      await client.subscribeBlockHeaders(callback1);
      await client.subscribeBlockHeaders(callback2);

      expect(client.hasBlockHeaderSubscriptions()).toBe(true);

      // Simulate notification
      const ws = MockWebSocket.getLastInstance()!;
      const notification = { height: 100002, hex: 'aa'.repeat(80) };
      ws.simulateNotification('blockchain.headers.subscribe', notification);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(callback1).toHaveBeenCalledWith(notification);
      expect(callback2).toHaveBeenCalledWith(notification);
    });

    it('should unsubscribe specific callback', async () => {
      const client = new ElectrumClient({ host: 'localhost', port: 50001 });
      await client.connect();

      const callback1 = vi.fn();
      const callback2 = vi.fn();
      
      await client.subscribeBlockHeaders(callback1);
      await client.subscribeBlockHeaders(callback2);

      // Unsubscribe first callback
      const removed = client.unsubscribeBlockHeaders(callback1);
      expect(removed).toBe(true);

      // Simulate notification
      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateNotification('blockchain.headers.subscribe', { height: 100003, hex: 'bb'.repeat(80) });

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });

    it('should unsubscribe all callbacks', async () => {
      const client = new ElectrumClient({ host: 'localhost', port: 50001 });
      await client.connect();

      const callback1 = vi.fn();
      const callback2 = vi.fn();
      
      await client.subscribeBlockHeaders(callback1);
      await client.subscribeBlockHeaders(callback2);

      client.unsubscribeAllBlockHeaders();

      expect(client.hasBlockHeaderSubscriptions()).toBe(false);

      // Simulate notification - should not invoke callbacks
      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateNotification('blockchain.headers.subscribe', { height: 100004, hex: 'cc'.repeat(80) });

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).not.toHaveBeenCalled();
    });

    it('should clear subscriptions on disconnect', async () => {
      const client = new ElectrumClient({ host: 'localhost', port: 50001 });
      await client.connect();

      const callback = vi.fn();
      await client.subscribeBlockHeaders(callback);
      expect(client.hasBlockHeaderSubscriptions()).toBe(true);

      client.disconnect();

      expect(client.hasBlockHeaderSubscriptions()).toBe(false);
    });

    it('should handle errors in subscription callbacks gracefully', async () => {
      const client = new ElectrumClient({ host: 'localhost', port: 50001 });
      await client.connect();

      const errorCallback = vi.fn(() => {
        throw new Error('Callback error');
      });
      const successCallback = vi.fn();

      await client.subscribeBlockHeaders(errorCallback);
      await client.subscribeBlockHeaders(successCallback);

      // Simulate notification
      const ws = MockWebSocket.getLastInstance()!;
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      ws.simulateNotification('blockchain.headers.subscribe', { height: 100005, hex: 'dd'.repeat(80) });

      await new Promise(resolve => setTimeout(resolve, 10));

      // Error callback should have been called but error should be caught
      expect(errorCallback).toHaveBeenCalled();
      // Success callback should still be called
      expect(successCallback).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should return false when unsubscribing non-existent callback', async () => {
      const client = new ElectrumClient({ host: 'localhost', port: 50001 });
      await client.connect();

      const callback = vi.fn();
      const otherCallback = vi.fn();
      
      await client.subscribeBlockHeaders(callback);

      const removed = client.unsubscribeBlockHeaders(otherCallback);
      expect(removed).toBe(false);
    });

    it('should not invoke callbacks for unrelated notifications', async () => {
      const client = new ElectrumClient({ host: 'localhost', port: 50001 });
      await client.connect();

      const callback = vi.fn();
      await client.subscribeBlockHeaders(callback);

      // Simulate unrelated notification
      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateNotification('blockchain.scripthash.subscribe', 'some-status-hash');

      await new Promise(resolve => setTimeout(resolve, 10));

      // Block header callback should not be invoked
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('notification message handling', () => {
    it('should distinguish notifications from responses', async () => {
      const client = new ElectrumClient({ host: 'localhost', port: 50001 });
      await client.connect();

      const callback = vi.fn();
      await client.subscribeBlockHeaders(callback);

      const ws = MockWebSocket.getLastInstance()!;

      // Send a response (has id)
      ws.simulateResponse(999, { height: 100006, hex: 'ee'.repeat(80) });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(callback).not.toHaveBeenCalled();

      // Send a notification (has method, no id)
      ws.simulateNotification('blockchain.headers.subscribe', { height: 100007, hex: 'ff'.repeat(80) });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });
});
