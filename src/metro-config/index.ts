/**
 * Optional Metro middleware for metro-mcp.
 *
 * Rewrites CDP target discovery responses (`/json`, `/json/list`) so that
 * `webSocketDebuggerUrl` and `devtoolsFrontendUrl` point at the MCP's CDP
 * proxy instead of directly at Hermes. This means pressing "j" in Metro,
 * tapping "Open Debugger" in the dev menu, or any tool that uses standard
 * CDP discovery will automatically connect through the proxy — allowing
 * Chrome DevTools and the MCP to coexist.
 *
 * Usage in metro.config.js:
 *
 *   const { withMetroMcp } = require('metro-mcp/metro');
 *   module.exports = withMetroMcp(getDefaultConfig(__dirname));
 *
 * This is entirely optional. The MCP works without it — the only difference
 * is that "j" and "Open Debugger" will steal the CDP connection if the
 * middleware is not installed.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync } from 'fs';

const PROXY_PORT_ENV = 'METRO_MCP_PROXY_PORT';
const PROXY_PORT_FILE = '.metro-mcp-proxy-port';

interface MetroConfig {
  server?: {
    enhanceMiddleware?: (
      middleware: MiddlewareFn,
      metroServer?: unknown,
    ) => MiddlewareFn;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

type MiddlewareFn = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void;

/**
 * Discover and cache the proxy port. The port is invariant for the lifetime
 * of the Metro process, so we read it once and cache the result.
 */
let cachedProxyPort: number | null | undefined;

function discoverProxyPort(): number | null {
  if (cachedProxyPort !== undefined) return cachedProxyPort;

  const envPort = process.env[PROXY_PORT_ENV];
  if (envPort) {
    const port = parseInt(envPort, 10);
    if (!isNaN(port) && port > 0) {
      cachedProxyPort = port;
      return port;
    }
  }

  try {
    const content = readFileSync(PROXY_PORT_FILE, 'utf8').trim();
    const port = parseInt(content, 10);
    if (!isNaN(port) && port > 0) {
      cachedProxyPort = port;
      return port;
    }
  } catch {
    // File doesn't exist yet — MCP server may not be running.
    // Return null but don't cache so we retry on next request.
    return null;
  }

  cachedProxyPort = null;
  return null;
}

/**
 * Rewrite a `/json` or `/json/list` response body to point WebSocket URLs
 * at the MCP proxy.
 */
function rewriteTargetList(body: string, proxyPort: number): string {
  try {
    const targets = JSON.parse(body);
    if (!Array.isArray(targets)) return body;

    for (const target of targets) {
      if (target.webSocketDebuggerUrl) {
        // Replace the host:port in the WS URL with the proxy
        // e.g. ws://localhost:8081/inspector/debug?device=1&page=-1
        //   -> ws://127.0.0.1:<proxyPort>
        target.webSocketDebuggerUrl = `ws://127.0.0.1:${proxyPort}`;
      }
      if (target.devtoolsFrontendUrl) {
        // Rewrite the devtools frontend URL's ws= param to point at the proxy.
        // The frontend URL is like:
        //   http://localhost:8081/debugger-frontend/rn_fusebox.html?ws=...
        // We replace the ws= value with our proxy address.
        target.devtoolsFrontendUrl = target.devtoolsFrontendUrl.replace(
          /([?&]wss?=)[^&]+/,
          `$1127.0.0.1:${proxyPort}`,
        );
      }
    }

    return JSON.stringify(targets);
  } catch {
    return body;
  }
}

/**
 * Create the middleware that intercepts `/json` responses.
 */
function createMcpMiddleware(existingMiddleware: MiddlewareFn): MiddlewareFn {
  return (req, res, next) => {
    const url = req.url || '';

    // Only intercept GET /json and /json/list
    if (req.method === 'GET' && (url === '/json' || url === '/json/list' || url === '/json/')) {
      const proxyPort = discoverProxyPort();

      if (proxyPort) {
        // Intercept the response by wrapping write/end
        const originalWrite = res.write.bind(res);
        const originalEnd = res.end.bind(res);
        const chunks: Buffer[] = [];

        // Buffer the response so we can rewrite it before sending.
        // Safe because /json responses are tiny (<10KB).
        res.write = function (chunk: unknown): boolean {
          if (chunk) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
          }
          return true;
        } as typeof res.write;

        res.end = function (chunk?: unknown): ServerResponse {
          if (chunk) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
          }

          const body = Buffer.concat(chunks).toString('utf8');
          const rewritten = rewriteTargetList(body, proxyPort);

          res.setHeader('Content-Length', Buffer.byteLength(rewritten));
          originalWrite(rewritten);
          return originalEnd();
        } as typeof res.end;
      }
    }

    // Pass through to Metro's middleware (which handles the actual /json response)
    return existingMiddleware(req, res, next);
  };
}

/**
 * Wrap a Metro config to install the metro-mcp middleware.
 *
 * This rewrites CDP target discovery (`/json/list`) so that external tools
 * — including pressing "j" in Metro and the "Open Debugger" dev menu item —
 * connect through the MCP's CDP proxy instead of directly to Hermes.
 *
 * @example
 * ```js
 * // metro.config.js
 * const { getDefaultConfig } = require('expo/metro-config');
 * const { withMetroMcp } = require('metro-mcp/metro');
 *
 * module.exports = withMetroMcp(getDefaultConfig(__dirname));
 * ```
 */
export function withMetroMcp(config: MetroConfig): MetroConfig {
  const existingEnhance = config.server?.enhanceMiddleware;

  return {
    ...config,
    server: {
      ...config.server,
      enhanceMiddleware: (middleware: MiddlewareFn, metroServer?: unknown) => {
        // Apply any existing enhanceMiddleware first
        const enhanced = existingEnhance
          ? existingEnhance(middleware, metroServer)
          : middleware;

        // Then wrap with our interceptor
        return createMcpMiddleware(enhanced);
      },
    },
  };
}
