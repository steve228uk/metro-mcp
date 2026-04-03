import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import type { CDPClient } from './connection.js';
import type { CDPResponse } from './types.js';
import { createLogger } from '../utils/logger.js';
import { wsDataToString } from '../utils/ws.js';

const logger = createLogger('cdp-proxy');

/** Timeout for pending proxy requests (ms). */
const PENDING_REQUEST_TIMEOUT = 30_000;

/** Domains that MCP itself needs — never disabled even if all external clients disconnect. */
const PROTECTED_DOMAINS = new Set(['Runtime', 'Network']);

interface ExternalClient {
  id: string;
  ws: WebSocket;
  enabledDomains: Set<string>;
}

interface PendingProxyRequest {
  clientId: string;
  originalId: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * CDP Proxy/Multiplexer.
 *
 * Sits between Hermes (single CDP connection via CDPClient) and multiple
 * downstream consumers: the MCP plugins (internal) and Chrome DevTools
 * or other external clients (via WebSocket).
 *
 * - Requests from external clients get ID-remapped before forwarding upstream.
 * - Responses are routed back to the originating client only.
 * - Events are broadcast to ALL connected clients.
 * - Domain enable/disable is reference-counted so clients don't interfere.
 */
export class CDPProxy {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, ExternalClient>();
  private pendingRequests = new Map<number, PendingProxyRequest>();
  private domainRefCounts = new Map<string, number>();
  private nextGlobalId = 1_000_000;
  private clientCounter = 0;
  private _port: number | null = null;

  constructor(private readonly cdpClient: CDPClient) {
    // Install the message interceptor on CDPClient to intercept responses
    // destined for external clients and broadcast events.
    cdpClient.messageInterceptor = (parsed: CDPResponse, raw: string) => this.handleUpstreamMessage(parsed, raw);

    // When the upstream reconnects, re-enable domains for connected external clients.
    cdpClient.on('reconnected', () => {
      this.reEnableDomains();
    });

    // When upstream disconnects, notify external clients.
    cdpClient.on('disconnected', () => {
      for (const client of this.clients.values()) {
        // Send a synthetic event so Chrome DevTools knows the target went away
        this.sendToClient(client, JSON.stringify({
          method: 'Inspector.detached',
          params: { reason: 'target_closed' },
        }));
      }
    });
  }

  get port(): number | null {
    return this._port;
  }

  /**
   * Start the proxy's HTTP + WebSocket server.
   */
  async start(port = 0): Promise<number> {
    const tryPort = (p: number): Promise<number> => new Promise((resolve, reject) => {
      const httpServer = http.createServer((req, res) => this.handleHttpRequest(req, res));
      httpServer.on('error', (err) => {
        httpServer.close();
        reject(err);
      });
      httpServer.listen(p, () => {
        const addr = httpServer.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : p;
        // Only attach WSS after successful bind — creating it before listen() would
        // cause it to emit an unhandled error event if the port is already in use.
        const wss = new WebSocketServer({ server: httpServer });
        wss.on('connection', (ws) => this.handleNewClient(ws));
        this.httpServer = httpServer;
        this.wss = wss;
        this._port = actualPort;
        logger.info(`CDP proxy listening on port ${actualPort}`);
        resolve(actualPort);
      });
    });

    if (port !== 0) {
      try {
        return await tryPort(port);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
        logger.debug(`Preferred proxy port ${port} in use, falling back to auto-assign`);
      }
    }
    return tryPort(0);
  }

  /**
   * Stop the proxy server.
   */
  async stop(): Promise<void> {
    // Disconnect all external clients
    for (const client of this.clients.values()) {
      try { client.ws.close(); } catch {}
    }
    this.clients.clear();
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingRequests.clear();
    this.domainRefCounts.clear();

    // Remove the interceptor
    this.cdpClient.messageInterceptor = null;

    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          if (this.httpServer) {
            this.httpServer.close(() => resolve());
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get the Chrome DevTools frontend URL for this proxy.
   */
  getDevToolsUrl(): string | null {
    if (!this._port) return null;
    return `chrome-devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=127.0.0.1:${this._port}`;
  }

  // ── HTTP handler (serves /json for Chrome auto-discovery) ─────────────────

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url === '/json' || req.url === '/json/list') {
      const target = this.cdpClient.getTarget();
      const targetList = target ? [{
        description: target.description || '',
        devtoolsFrontendUrl: this.getDevToolsUrl(),
        id: target.id,
        title: target.title,
        type: 'node',
        webSocketDebuggerUrl: `ws://localhost:${this._port}`,
        ...(target.vm ? { vm: target.vm } : {}),
      }] : [];

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(targetList));
      return;
    }

    if (req.url === '/json/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        Browser: 'metro-mcp/CDP-Proxy',
        'Protocol-Version': '1.3',
      }));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }

  // ── WebSocket client handling ─────────────────────────────────────────────

  private handleNewClient(ws: WebSocket): void {
    const clientId = `client-${++this.clientCounter}`;
    const client: ExternalClient = { id: clientId, ws, enabledDomains: new Set() };
    this.clients.set(clientId, client);
    logger.info(`External client connected: ${clientId}`);

    ws.on('message', (data) => {
      this.handleClientMessage(client, wsDataToString(data));
    });

    ws.on('close', () => {
      logger.info(`External client disconnected: ${clientId}`);
      this.cleanupClient(client);
    });

    ws.on('error', (err) => {
      logger.error(`Client ${clientId} error: ${err.message}`);
    });
  }

  private handleClientMessage(client: ExternalClient, data: string): void {
    let message: { id?: number; method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(data);
    } catch {
      logger.warn(`Invalid JSON from client ${client.id}`);
      return;
    }

    if (message.id === undefined || !message.method) {
      // No ID or no method — just forward as-is
      try { this.cdpClient.sendRaw(data); } catch {}
      return;
    }

    const method = message.method;

    // Handle domain enable/disable with reference counting
    if (method.endsWith('.enable')) {
      const domain = method.replace('.enable', '');
      const refCount = this.domainRefCounts.get(domain) || 0;
      client.enabledDomains.add(domain);

      if (refCount > 0) {
        // Domain already enabled upstream — return synthetic success
        this.domainRefCounts.set(domain, refCount + 1);
        this.sendToClient(client, JSON.stringify({ id: message.id, result: {} }));
        return;
      }

      // First enable — forward to Hermes and track the mapping
      this.domainRefCounts.set(domain, 1);
    } else if (method.endsWith('.disable')) {
      const domain = method.replace('.disable', '');
      const refCount = this.domainRefCounts.get(domain) || 0;
      client.enabledDomains.delete(domain);

      if (refCount > 1) {
        // Other clients still need this domain
        this.domainRefCounts.set(domain, refCount - 1);
        this.sendToClient(client, JSON.stringify({ id: message.id, result: {} }));
        return;
      }

      // Last disable — forward to Hermes
      if (refCount === 1) this.domainRefCounts.set(domain, 0);
    }

    // Remap the ID and forward upstream
    const globalId = this.nextGlobalId++;
    const timer = setTimeout(() => {
      this.pendingRequests.delete(globalId);
      this.sendToClient(client, JSON.stringify({
        id: message.id,
        error: { code: -32000, message: 'CDP request timed out' },
      }));
    }, PENDING_REQUEST_TIMEOUT);
    this.pendingRequests.set(globalId, { clientId: client.id, originalId: message.id, timer });

    const remapped = { ...message, id: globalId };
    try {
      this.cdpClient.sendRaw(JSON.stringify(remapped));
    } catch (err) {
      // Upstream not connected — send error back
      clearTimeout(timer);
      this.pendingRequests.delete(globalId);
      this.sendToClient(client, JSON.stringify({
        id: message.id,
        error: { code: -32000, message: 'Upstream CDP connection not available' },
      }));
    }
  }

  // ── Upstream message handling ──────────────────────────────────────────────

  /**
   * Intercept messages from Hermes before CDPClient processes them.
   * Returns true if the message was consumed (should not be processed by CDPClient).
   */
  private handleUpstreamMessage(message: CDPResponse, raw: string): boolean {
    // Response to a request
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        // This response belongs to an external client — route it back
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.id);
        const client = this.clients.get(pending.clientId);
        if (client) {
          const remapped = { ...message, id: pending.originalId };
          this.sendToClient(client, JSON.stringify(remapped));
        }
        return true; // consumed — don't let CDPClient handle it
      }
      // Not for an external client — let CDPClient handle it normally
      return false;
    }

    // Event — broadcast to ALL external clients (CDPClient also handles it via its own handlers)
    if (message.method) {
      for (const client of this.clients.values()) {
        this.sendToClient(client, raw);
      }
    }

    return false; // let CDPClient also process the event
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private sendToClient(client: ExternalClient, data: string): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  }

  private cleanupClient(client: ExternalClient): void {
    // Decrement domain ref counts for domains this client had enabled
    for (const domain of client.enabledDomains) {
      const refCount = this.domainRefCounts.get(domain) || 0;
      if (refCount > 0) {
        this.domainRefCounts.set(domain, refCount - 1);
        // If this was the last external client using this domain, disable it upstream
        // — but never disable protected domains that MCP itself needs
        if (refCount === 1 && !PROTECTED_DOMAINS.has(domain)) {
          try {
            this.cdpClient.sendRaw(JSON.stringify({
              id: this.nextGlobalId++,
              method: `${domain}.disable`,
            }));
          } catch {}
        }
      }
    }
    this.clients.delete(client.id);

    // Clean up any pending requests for this client
    for (const [globalId, pending] of this.pendingRequests) {
      if (pending.clientId === client.id) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(globalId);
      }
    }
  }

  /**
   * Re-enable all domains that external clients need after a reconnection.
   */
  private reEnableDomains(): void {
    const domainsToEnable = new Set<string>();
    for (const client of this.clients.values()) {
      for (const domain of client.enabledDomains) {
        domainsToEnable.add(domain);
      }
    }
    for (const domain of domainsToEnable) {
      try {
        this.cdpClient.sendRaw(JSON.stringify({
          id: this.nextGlobalId++,
          method: `${domain}.enable`,
        }));
      } catch {}
    }
  }
}
