import WebSocket from 'ws';
import type { CDPConnection } from '../plugin.js';
import type { CDPRequest, CDPResponse, MetroTarget } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('cdp');

type CDPEventHandler = (params: Record<string, unknown>) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * CDP WebSocket client that connects to a Hermes debugger target.
 * Implements the CDPConnection interface used by plugins.
 *
 * Uses the `ws` library (same as Metro's InspectorProxy) for native
 * WebSocket ping/pong support. Metro sends pings every 5s and terminates
 * connections after 60s of no pong — `ws` auto-responds to pings.
 */
export class CDPClient implements CDPConnection {
  private ws: WebSocket | null = null;
  private messageId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private eventHandlers = new Map<string, Set<CDPEventHandler>>();
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private connectingPromise: Promise<void> | null = null;
  private suppressReconnect = false;
  private _isConnected = false;
  private target: MetroTarget | null = null;
  private pongReceived = false;

  private readonly requestTimeout = 10000;
  private readonly keepAliveInterval = 10000;

  /**
   * Connect to a CDP target.
   */
  async connect(target: MetroTarget): Promise<void> {
    this.stopKeepAlive();
    this.target = target;
    this.suppressReconnect = false;
    this.connectingPromise = this.doConnect(target.webSocketDebuggerUrl);
    await this.connectingPromise;
    this.connectingPromise = null;
    this.emit('reconnected', {});
  }

  async waitForConnection(): Promise<boolean> {
    if (this._isConnected) return true;
    if (this.connectingPromise) {
      try { await this.connectingPromise; } catch {}
    }
    return this._isConnected;
  }

  private doConnect(url: string): Promise<void> {
    // Close existing socket before opening a new one
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch {}
      this.ws = null;
    }
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);
        const socketForThisConnection = this.ws;

        this.ws.on('open', () => {
          this._isConnected = true;
          this.pongReceived = true;
          this.startKeepAlive();
          logger.info(`Connected to ${this.target?.title || 'unknown'}`);
          resolve();
        });

        this.ws.on('message', (data) => {
          const text = Array.isArray(data) ? Buffer.concat(data).toString()
            : Buffer.isBuffer(data) ? data.toString()
            : Buffer.from(data).toString();
          this.handleMessage(text);
        });

        this.ws.on('close', (code, reason) => {
          // Ignore close events from a replaced socket — a new connection is already in progress
          if (this.ws !== socketForThisConnection) return;

          logger.info(`WebSocket closed (code=${code}, reason="${reason.toString() || 'no reason'}", wasConnected=${this._isConnected})`);

          this._isConnected = false;
          this.stopKeepAlive();
          this.rejectAllPending('WebSocket closed');
          if (!this.suppressReconnect) {
            this.emit('disconnected', {});
          }
        });

        this.ws.on('error', () => {
          logger.error(`WebSocket error (connected=${this._isConnected})`);
          if (!this._isConnected) {
            reject(new Error('Failed to connect to CDP target'));
          }
        });

        // Metro's InspectorProxy sends pings every 5s — ws auto-responds with pong.
        // Log for diagnostics.
        this.ws.on('ping', () => {
          logger.debug('Received ping from Metro');
        });

        // Track pong responses to our own pings (sent by startKeepAlive).
        this.ws.on('pong', () => {
          this.pongReceived = true;
          logger.debug('Received pong from Metro');
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Send a CDP command and wait for the response.
   */
  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.ws || !this._isConnected) {
      throw new Error('Not connected to CDP target');
    }

    const id = ++this.messageId;
    const request: CDPRequest = { id, method };
    if (params) request.params = params;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`CDP request timed out: ${method}`));
      }, this.requestTimeout);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify(request));
    });
  }

  /**
   * Subscribe to a CDP event.
   */
  on(event: string, handler: CDPEventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  /**
   * Unsubscribe from a CDP event.
   */
  off(event: string, handler: CDPEventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Get the current target.
   */
  getTarget(): MetroTarget | null {
    return this.target;
  }

  /**
   * Disconnect and stop reconnecting.
   */
  disconnect(): void {
    this.suppressReconnect = true;
    this.stopKeepAlive();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._isConnected = false;
    this.rejectAllPending('Disconnected');
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    let missedKeepAlives = 0;
    this.keepAliveTimer = setInterval(() => {
      if (!this._isConnected || !this.ws) return;

      if (!this.pongReceived) {
        missedKeepAlives++;
        if (missedKeepAlives >= 3) {
          logger.warn(`${missedKeepAlives} consecutive pongs missed — closing connection`);
          try { this.ws.close(); } catch {}
          return;
        }
      } else {
        missedKeepAlives = 0;
      }

      this.pongReceived = false;
      this.ws.ping();
    }, this.keepAliveInterval);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private handleMessage(data: string): void {
    let message: CDPResponse;
    try {
      message = JSON.parse(data);
    } catch {
      logger.warn('Failed to parse CDP message');
      return;
    }

    // Response to a request
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    // Event
    if (message.method) {
      const handlers = this.eventHandlers.get(message.method);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(message.params || {});
          } catch (err) {
            logger.error(`Error in event handler for ${message.method}:`, err);
          }
        }
      }
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  private emit(event: string, params: Record<string, unknown>): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(params);
        } catch (err) {
          logger.error(`Error in event handler for ${event}:`, err);
        }
      }
    }
  }
}
