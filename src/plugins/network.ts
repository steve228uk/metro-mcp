import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { CircularBuffer } from '../utils/buffer.js';
import { formatTimestamp, formatBytes } from '../utils/format.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('network');

/** Maximum *decoded* body size (bytes) to keep cached. */
const MAX_BODY_CACHE_SIZE = 1024 * 1024; // 1 MB
/** Maximum concurrent getResponseBody CDP calls to avoid flooding the pipeline. */
const MAX_CONCURRENT_BODY_FETCHES = 4;

function decodeResponseBody(raw: { body: string; base64Encoded: boolean }): string {
  return raw.base64Encoded ? Buffer.from(raw.body, 'base64').toString('utf8') : raw.body;
}

interface NetworkRequest {
  id: string;
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  startTime: number;
  endTime?: number;
  error?: string;
  size?: number;
  /** Connection session this request belongs to. Incremented on each reconnect. */
  session: number;
}

export const networkPlugin = definePlugin({
  name: 'network',

  description: 'Network request tracking via CDP Network domain',

  async setup(ctx) {
    const buffer = new CircularBuffer<NetworkRequest>(200);
    const pendingRequests = new Map<string, NetworkRequest>();

    /** Monotonically increasing session counter – bumped on every reconnect so we
     *  can tell which requests belong to the current CDP session vs a stale one. */
    let currentSession = 0;

    /** Simple concurrency limiter for eager body fetches to avoid flooding CDP. */
    let activeFetches = 0;

    function fetchAndCacheBody(req: NetworkRequest): void {
      if (activeFetches >= MAX_CONCURRENT_BODY_FETCHES) return;
      activeFetches++;
      ctx.cdp.send('Network.getResponseBody', { requestId: req.id })
        .then((result) => {
          const body = decodeResponseBody(result as { body: string; base64Encoded: boolean });
          if (body.length <= MAX_BODY_CACHE_SIZE) {
            req.responseBody = body;
          }
        })
        .catch((err) => {
          logger.debug(`Could not cache body for ${req.method} ${req.url}: ${err}`);
        })
        .finally(() => {
          activeFetches--;
        });
    }

    // ── CDP Network domain ─────────────────────────────────────────────────────

    ctx.cdp.on('Network.requestWillBeSent', (params) => {
      const request: NetworkRequest = {
        id: params.requestId as string,
        url: (params.request as Record<string, unknown>)?.url as string,
        method: (params.request as Record<string, unknown>)?.method as string || 'GET',
        requestHeaders: (params.request as Record<string, unknown>)?.headers as Record<string, string>,
        startTime: Date.now(),
        session: currentSession,
      };
      pendingRequests.set(request.id, request);
    });

    ctx.cdp.on('Network.responseReceived', (params) => {
      const req = pendingRequests.get(params.requestId as string);
      if (req) {
        const response = params.response as Record<string, unknown>;
        req.status = response.status as number;
        req.statusText = response.statusText as string;
        req.responseHeaders = response.headers as Record<string, string>;
      }
    });

    ctx.cdp.on('Network.loadingFinished', (params) => {
      const req = pendingRequests.get(params.requestId as string);
      if (req) {
        req.endTime = Date.now();
        req.size = params.encodedDataLength as number;
        pendingRequests.delete(req.id);
        buffer.push(req);
        fetchAndCacheBody(req);
      }
    });

    ctx.cdp.on('Network.loadingFailed', (params) => {
      const req = pendingRequests.get(params.requestId as string);
      if (req) {
        req.endTime = Date.now();
        req.error = params.errorText as string;
        pendingRequests.delete(req.id);
        buffer.push(req);
      }
    });

    ctx.cdp.on('disconnected', () => {
      const now = Date.now();
      for (const [, req] of pendingRequests) {
        req.endTime = now;
        req.error = 'Connection lost';
        buffer.push(req);
      }
      pendingRequests.clear();
    });

    ctx.cdp.on('reconnected', () => {
      currentSession++;
    });

    // ── Request tracking tools ─────────────────────────────────────────────────

    ctx.registerTool('get_network_requests', {
      description: 'Get recent network requests from the React Native app.',
      parameters: z.object({
        limit: z.number().default(50).describe('Maximum number of requests to return'),
        summary: z.boolean().default(false).describe('Return summary with counts'),
        compact: z.boolean().default(false).describe('Return compact single-line format'),
      }),
      handler: async ({ limit, summary, compact: isCompact }) => {
        const requests = buffer.getAll();

        if (summary) {
          const total = requests.length;
          const errors = requests.filter((r) => r.error || (r.status && r.status >= 400)).length;
          const avgTime = requests
            .filter((r) => r.endTime)
            .reduce((sum, r) => sum + (r.endTime! - r.startTime), 0) / (requests.length || 1);
          return `${total} requests, ${errors} errors, avg response time: ${Math.round(avgTime)}ms`;
        }

        const result = requests.slice(-limit);
        if (isCompact) {
          return result
            .map((r) => {
              const duration = r.endTime ? `${r.endTime - r.startTime}ms` : 'pending';
              const status = r.error ? `ERR: ${r.error}` : `${r.status || '???'}`;
              return `${r.method} ${r.url} → ${status} (${duration})`;
            })
            .join('\n');
        }

        return result.map((r) => ({
          method: r.method,
          url: r.url,
          status: r.status,
          duration: r.endTime ? `${r.endTime - r.startTime}ms` : 'pending',
          size: r.size ? formatBytes(r.size) : undefined,
          error: r.error,
          time: formatTimestamp(r.startTime),
        }));
      },
    });

    ctx.registerTool('get_request_details', {
      description: 'Get full details of a specific network request including headers and body.',
      parameters: z.object({
        url: z.string().describe('URL or partial URL to find the request'),
        index: z.number().default(-1).describe('Index of the request if multiple match (-1 for last)'),
      }),
      handler: async ({ url, index }) => {
        const matches = buffer.filter((r) => r.url.includes(url));
        if (matches.length === 0) return `No requests found matching "${url}"`;
        const req = index === -1 ? matches[matches.length - 1] : matches[index];
        if (!req) return `Request index ${index} out of range (${matches.length} matches)`;
        return req;
      },
    });

    ctx.registerTool('get_response_body', {
      description:
        'Get the response body for a specific network request. ' +
        'Bodies are eagerly cached when small enough, so they survive reconnections. ' +
        'Larger bodies are fetched on demand and only available in the current CDP session.',
      parameters: z.object({
        url: z.string().describe('URL or partial URL to find the request'),
        index: z.number().default(-1).describe('Index of the request if multiple match (-1 for last)'),
      }),
      handler: async ({ url, index }) => {
        const matches = buffer.filter((r) => r.url.includes(url));
        if (matches.length === 0) return `No requests found matching "${url}"`;
        const req = index === -1 ? matches[matches.length - 1] : matches[index];
        if (!req) return `Request index ${index} out of range (${matches.length} matches)`;

        // Use cached body if available (survives reconnections)
        if (req.responseBody !== undefined) {
          try {
            return { url: req.url, status: req.status, body: JSON.parse(req.responseBody) };
          } catch {
            return { url: req.url, status: req.status, body: req.responseBody };
          }
        }

        // Request is from a previous session and body wasn't cached — no way to fetch it
        if (req.session !== currentSession) {
          return `Response body unavailable for "${req.url}": this request was captured in a previous CDP session (session ${req.session}, current ${currentSession}). The debugger cache was lost on reconnect and the body was not cached (${req.size ? formatBytes(req.size) : 'unknown size'}, limit ${formatBytes(MAX_BODY_CACHE_SIZE)}).`;
        }

        // Try live fetch from current session
        try {
          const result = await ctx.cdp.send('Network.getResponseBody', { requestId: req.id }) as { body: string; base64Encoded: boolean };
          const body = decodeResponseBody(result);
          req.responseBody = body;
          try {
            return { url: req.url, status: req.status, body: JSON.parse(body) };
          } catch {
            return { url: req.url, status: req.status, body };
          }
        } catch (err) {
          return `Could not retrieve response body for "${req.url}": ${err instanceof Error ? err.message : String(err)}. The body may no longer be cached by the debugger.`;
        }
      },
    });

    ctx.registerTool('search_network', {
      description: 'Search network requests by URL pattern, method, or status code.',
      parameters: z.object({
        urlPattern: z.string().optional().describe('URL substring or regex pattern'),
        method: z.string().optional().describe('HTTP method filter'),
        statusCode: z.number().optional().describe('HTTP status code filter'),
        errorsOnly: z.boolean().default(false).describe('Show only failed requests'),
      }),
      handler: async ({ urlPattern, method, statusCode, errorsOnly }) => {
        let results = buffer.getAll();
        if (urlPattern) {
          const regex = new RegExp(urlPattern, 'i');
          results = results.filter((r) => regex.test(r.url));
        }
        if (method) results = results.filter((r) => r.method.toUpperCase() === method.toUpperCase());
        if (statusCode) results = results.filter((r) => r.status === statusCode);
        if (errorsOnly) results = results.filter((r) => r.error || (r.status && r.status >= 400));
        return results.map((r) => ({
          method: r.method,
          url: r.url,
          status: r.status,
          error: r.error,
          duration: r.endTime ? `${r.endTime - r.startTime}ms` : 'pending',
        }));
      },
    });

    ctx.registerTool('clear_network_requests', {
      description: 'Clear the network request buffer. Useful after a reload or when old requests are no longer relevant.',
      parameters: z.object({}),
      handler: async () => {
        const count = buffer.size;
        buffer.clear();
        pendingRequests.clear();
        return `Cleared ${count} network requests.`;
      },
    });

    // ── Resource ───────────────────────────────────────────────────────────────

    ctx.registerResource('metro://network', {
      name: 'Network Requests',
      description: 'Recent network requests from the React Native app',
      handler: async () => {
        const requests = buffer.getLast(20);
        return JSON.stringify(
          requests.map((r) => ({
            method: r.method,
            url: r.url,
            status: r.status,
            duration: r.endTime ? `${r.endTime - r.startTime}ms` : 'pending',
          })),
          null,
          2
        );
      },
    });
  },
});
