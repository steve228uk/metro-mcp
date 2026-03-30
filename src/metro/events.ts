import WebSocket from 'ws';
import type { MetroEvent } from '../plugin.js';
import { createLogger } from '../utils/logger.js';
import { wsDataToString } from '../utils/ws.js';

const logger = createLogger('metro-events');

type MetroEventHandler = (event: MetroEvent) => void;

/**
 * Client for Metro's `/events` WebSocket endpoint.
 *
 * This endpoint broadcasts all Metro reporter events (build progress,
 * bundling errors, etc.) with no registration needed — just connect
 * and receive. Reconnection is driven by the server (via connectToMetro)
 * so the events client always uses the same discovered host/port as CDP.
 */
export class MetroEventsClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<MetroEventHandler>>();
  private _isConnected = false;

  connect(host: string, port: number): void {
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch {}
      this.ws = null;
    }

    const url = `ws://${host}:${port}/events`;

    try {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this._isConnected = true;
        logger.info('Connected to Metro events');
      });

      this.ws.on('message', (data) => {
        try {
          const text = wsDataToString(data);
          const event = JSON.parse(text) as MetroEvent;
          if (event.type) {
            this.emit(event.type, event);
          }
        } catch {
          logger.debug('Failed to parse Metro event');
        }
      });

      this.ws.on('close', () => {
        this._isConnected = false;
      });

      this.ws.on('error', () => {
        logger.debug('Metro events WebSocket error');
      });
    } catch {
      // Connection failed — server will retry via connectToMetro
    }
  }

  on(event: string, handler: MetroEventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: MetroEventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  isConnected(): boolean {
    return this._isConnected;
  }

  disconnect(): void {
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch {}
      this.ws = null;
    }
    this._isConnected = false;
  }

  private emit(type: string, event: MetroEvent): void {
    const handlers = this.handlers.get(type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          logger.error(`Error in event handler for ${type}:`, err);
        }
      }
    }
  }
}
