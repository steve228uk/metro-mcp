import { z } from 'zod';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { definePlugin } from '../plugin.js';
import { CircularBuffer } from '../utils/buffer.js';
import { formatTimestamp, formatBytes } from '../utils/format.js';

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
}

// ── Override types ────────────────────────────────────────────────────────────

// In-memory representation — fully resolved, no file paths
interface OverrideEntry {
  name?: string;
  urlPattern: string;
  block?: boolean;
  response?: {
    statusCode?: number;
    headers?: Record<string, string>;
    body?: string;
  };
  request?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };
}

// File format — response/request can be an inline object or a path string to a .json file
interface OverrideFileResponseConfig {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: unknown; // string or JSON object/array — serialised to string on load
}
interface OverrideFileRequestConfig {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
interface OverrideFileEntry {
  name?: string;
  urlPattern: string;
  block?: boolean;
  response?: string | OverrideFileResponseConfig;
  request?: string | OverrideFileRequestConfig;
}
interface OverrideFile {
  version: 1;
  overrides: OverrideFileEntry[];
}

export const networkPlugin = definePlugin({
  name: 'network',
  version: '0.1.0',
  description: 'Network request tracking and override system via CDP Network/Fetch domains',

  async setup(ctx) {
    const buffer = new CircularBuffer<NetworkRequest>(200);
    const pendingRequests = new Map<string, NetworkRequest>();

    // ── CDP Network domain ─────────────────────────────────────────────────────

    ctx.cdp.on('Network.requestWillBeSent', (params) => {
      const request: NetworkRequest = {
        id: params.requestId as string,
        url: (params.request as Record<string, unknown>)?.url as string,
        method: (params.request as Record<string, unknown>)?.method as string || 'GET',
        requestHeaders: (params.request as Record<string, unknown>)?.headers as Record<string, string>,
        startTime: Date.now(),
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

    // When the CDP connection drops, flush any in-flight requests to the buffer so they
    // are visible rather than silently lost.
    ctx.cdp.on('disconnected', () => {
      const now = Date.now();
      for (const [, req] of pendingRequests) {
        req.endTime = now;
        req.error = 'Connection lost';
        buffer.push(req);
      }
      pendingRequests.clear();
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
        'Bodies are fetched on demand via CDP and are not included in get_network_requests or search_network output.',
      parameters: z.object({
        url: z.string().describe('URL or partial URL to find the request'),
        index: z.number().default(-1).describe('Index of the request if multiple match (-1 for last)'),
      }),
      handler: async ({ url, index }) => {
        const matches = buffer.filter((r) => r.url.includes(url));
        if (matches.length === 0) return `No requests found matching "${url}"`;
        const req = index === -1 ? matches[matches.length - 1] : matches[index];
        if (!req) return `Request index ${index} out of range (${matches.length} matches)`;

        try {
          const result = await ctx.cdp.send('Network.getResponseBody', { requestId: req.id }) as { body: string; base64Encoded: boolean };
          const body = result.base64Encoded
            ? Buffer.from(result.body, 'base64').toString('utf8')
            : result.body;
          // Try to pretty-print JSON bodies
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

    // ── Network overrides via CDP Fetch domain ────────────────────────────────
    // Overrides persist in memory until removed/cleared. Interception can be paused
    // and resumed without losing definitions. Overrides can be saved to / loaded from
    // a JSON file in the project so they survive MCP server restarts.

    const overrides: OverrideEntry[] = [];
    let fetchInterceptActive = false;
    let overridesPaused = false;

    function urlMatchesPattern(url: string, pattern: string): boolean {
      if (pattern.includes('*')) {
        const regexStr = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        return new RegExp(regexStr, 'i').test(url);
      }
      return url.includes(pattern);
    }

    async function enableFetchIntercept(): Promise<void> {
      if (fetchInterceptActive) return;
      await ctx.cdp.send('Fetch.enable', {
        patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      });
      fetchInterceptActive = true;
    }

    async function disableFetchIntercept(): Promise<void> {
      if (!fetchInterceptActive) return;
      await ctx.cdp.send('Fetch.disable').catch(() => {});
      fetchInterceptActive = false;
    }

    // Resolve a response/request value from a file-format entry.
    // If it's a string, treat it as a path to a JSON file and read it.
    // `baseDir` is the directory of the override file being loaded.
    async function resolveFileRef<T>(
      value: string | T,
      baseDir: string,
    ): Promise<T> {
      if (typeof value === 'string') {
        const absPath = resolve(baseDir, value);
        const raw = await readFile(absPath, 'utf8');
        return JSON.parse(raw) as T;
      }
      return value;
    }

    // Convert a OverrideFileEntry (from disk) to an in-memory OverrideEntry.
    async function resolveFileEntry(
      entry: OverrideFileEntry,
      baseDir: string,
    ): Promise<OverrideEntry> {
      const resolved: OverrideEntry = {
        name: entry.name,
        urlPattern: entry.urlPattern,
        block: entry.block,
      };

      if (entry.response !== undefined) {
        const cfg = await resolveFileRef<OverrideFileResponseConfig>(entry.response, baseDir);
        resolved.response = {
          statusCode: cfg.statusCode,
          headers: cfg.headers,
          // body can be inline object/array or string — always serialise to string
          body: cfg.body !== undefined
            ? (typeof cfg.body === 'string' ? cfg.body : JSON.stringify(cfg.body))
            : undefined,
        };
      }

      if (entry.request !== undefined) {
        resolved.request = await resolveFileRef<OverrideFileRequestConfig>(entry.request, baseDir);
      }

      return resolved;
    }

    // Load entries from a single .json file. Returns resolved OverrideEntry[].
    async function loadFromFile(filePath: string): Promise<OverrideEntry[]> {
      const absPath = resolve(filePath);
      const raw = await readFile(absPath, 'utf8');
      const baseDir = dirname(absPath);
      const parsed = JSON.parse(raw);

      // File can be:
      //   { version: 1, overrides: [...] }  — standard override file
      //   [{ urlPattern, ... }, ...]         — bare array of entries
      //   { urlPattern, ... }                — single entry object
      let fileEntries: OverrideFileEntry[];
      if (Array.isArray(parsed)) {
        fileEntries = parsed as OverrideFileEntry[];
      } else if (parsed.overrides && Array.isArray(parsed.overrides)) {
        fileEntries = parsed.overrides as OverrideFileEntry[];
      } else if (parsed.urlPattern) {
        fileEntries = [parsed as OverrideFileEntry];
      } else {
        throw new Error(`Unrecognised format in ${absPath}. Expected { overrides: [...] }, an array, or a single override object.`);
      }

      return Promise.all(fileEntries.map((e) => resolveFileEntry(e, baseDir)));
    }

    // Load entries from a directory — reads all *.json files.
    async function loadFromFolder(folderPath: string): Promise<OverrideEntry[]> {
      const absPath = resolve(folderPath);
      const files = await readdir(absPath);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));
      const results: OverrideEntry[] = [];
      for (const file of jsonFiles) {
        const entries = await loadFromFile(join(absPath, file));
        results.push(...entries);
      }
      return results;
    }

    // Shared logic for loading overrides (used by tool + auto-load).
    async function loadOverridesFromPath(
      filePath: string,
      nameFilter: string | undefined,
      replace: boolean,
      activate: boolean,
    ): Promise<{ loaded: string; added: number; total: number }> {
      const absPath = resolve(filePath);
      const pathStat = await stat(absPath);
      const entries = pathStat.isDirectory()
        ? await loadFromFolder(absPath)
        : await loadFromFile(absPath);

      const filtered = nameFilter
        ? entries.filter((e) => e.name === nameFilter)
        : entries;

      if (replace) overrides.length = 0;

      let added = 0;
      for (const entry of filtered) {
        const idx = overrides.findIndex((o) => o.urlPattern === entry.urlPattern);
        if (idx !== -1) overrides.splice(idx, 1);
        overrides.push(entry);
        added++;
      }

      overridesPaused = !activate;
      if (activate && overrides.length > 0) await enableFetchIntercept();

      return { loaded: absPath, added, total: overrides.length };
    }

    // ── CDP Fetch domain handler ───────────────────────────────────────────────

    ctx.cdp.on('Fetch.requestPaused', async (params: Record<string, unknown>) => {
      const requestId = params.requestId as string;
      const request = params.request as Record<string, unknown>;
      const url = request?.url as string ?? '';

      const match = overrides.find((o) => urlMatchesPattern(url, o.urlPattern));
      if (!match) {
        ctx.cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
        return;
      }

      // block takes priority
      if (match.block) {
        ctx.cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
        return;
      }

      // response override — return fake response, real server never reached
      if (match.response) {
        const headers = Object.entries(match.response.headers ?? { 'Content-Type': 'application/json' })
          .map(([name, value]) => ({ name, value }));
        ctx.cdp.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: match.response.statusCode ?? 200,
          responseHeaders: headers,
          body: Buffer.from(match.response.body ?? '').toString('base64'),
        }).catch(() => {});
        return;
      }

      // request override — modify request then forward to real server
      if (match.request) {
        // Merge override headers on top of original headers so cookies etc. are preserved
        const originalHeaders = (request?.headers ?? {}) as Record<string, string>;
        const mergedHeaders = match.request.headers
          ? { ...originalHeaders, ...match.request.headers }
          : undefined;

        ctx.cdp.send('Fetch.continueRequest', {
          requestId,
          ...(match.request.url     ? { url: match.request.url }                                                                    : {}),
          ...(match.request.method  ? { method: match.request.method }                                                              : {}),
          ...(mergedHeaders         ? { headers: Object.entries(mergedHeaders).map(([name, value]) => ({ name, value })) }          : {}),
          ...(match.request.body !== undefined ? { postData: Buffer.from(match.request.body).toString('base64') }                   : {}),
        }).catch(() => {});
        return;
      }

      // No actionable fields — pass through
      ctx.cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
    });

    // ── Override tools ─────────────────────────────────────────────────────────

    ctx.registerTool('override_network_response', {
      description:
        'Intercept ALL requests matching a URL pattern and return a fake response — every call, not just once. ' +
        'Uses the CDP Fetch domain: no app changes required, works for fetch and XHR. ' +
        'Override stays active until removed with remove_network_override or cleared with clear_network_overrides. ' +
        'Use save_network_overrides to persist to a file so overrides survive server restarts.',
      parameters: z.object({
        urlPattern: z.string()
          .describe('URL substring or glob pattern (e.g. "/api/users", "*.example.com/auth*")'),
        statusCode: z.number().int().min(100).max(599).default(200)
          .describe('HTTP status code (default 200)'),
        body: z.string().default('')
          .describe('Response body string (e.g. a JSON payload)'),
        headers: z.record(z.string()).optional()
          .describe('Response headers (default: {"Content-Type": "application/json"})'),
        name: z.string().optional()
          .describe('Human-readable name for this override (used for single-item loading)'),
      }),
      handler: async ({ urlPattern, statusCode, body, headers, name }) => {
        const idx = overrides.findIndex((o) => o.urlPattern === urlPattern);
        if (idx !== -1) overrides.splice(idx, 1);
        overrides.push({ name, urlPattern, response: { statusCode, body, headers } });
        if (!overridesPaused) await enableFetchIntercept();
        return { overriding: urlPattern, type: 'response', statusCode, activeCount: overrides.length, interceptActive: fetchInterceptActive };
      },
    });

    ctx.registerTool('override_network_request', {
      description:
        'Intercept matching requests, modify them, then forward to the real server. ' +
        'Use this to inject auth headers, redirect to a staging URL, change the HTTP method, or replace the body. ' +
        'Original request headers are preserved and merged with your overrides (not replaced entirely).',
      parameters: z.object({
        urlPattern: z.string()
          .describe('URL substring or glob pattern to intercept (e.g. "/api/*", "prod.example.com")'),
        headers: z.record(z.string()).optional()
          .describe('Headers to add or override (merged with original headers). E.g. {"Authorization": "Bearer test-token"}'),
        url: z.string().optional()
          .describe('Redirect matched requests to this URL instead'),
        method: z.string().optional()
          .describe('Replace the HTTP method (e.g. "POST" → "GET")'),
        body: z.string().optional()
          .describe('Replace the request body (POST data)'),
        name: z.string().optional()
          .describe('Human-readable name for this override'),
      }),
      handler: async ({ urlPattern, headers, url, method, body, name }) => {
        const idx = overrides.findIndex((o) => o.urlPattern === urlPattern);
        if (idx !== -1) overrides.splice(idx, 1);
        overrides.push({ name, urlPattern, request: { headers, url, method, body } });
        if (!overridesPaused) await enableFetchIntercept();
        return { overriding: urlPattern, type: 'request', changes: { headers: !!headers, url: !!url, method: !!method, body: body !== undefined }, activeCount: overrides.length };
      },
    });

    ctx.registerTool('block_network_request', {
      description:
        'Block ALL requests matching a URL pattern, making them fail with a network error — every call. ' +
        'Useful for testing offline behaviour, error handling, or simulating unavailable services.',
      parameters: z.object({
        urlPattern: z.string()
          .describe('URL substring or glob pattern to block (e.g. "/api/upload", "analytics.*")'),
        name: z.string().optional()
          .describe('Human-readable name for this override'),
      }),
      handler: async ({ urlPattern, name }) => {
        const idx = overrides.findIndex((o) => o.urlPattern === urlPattern);
        if (idx !== -1) overrides.splice(idx, 1);
        overrides.push({ name, urlPattern, block: true });
        if (!overridesPaused) await enableFetchIntercept();
        return { blocked: urlPattern, activeCount: overrides.length, interceptActive: fetchInterceptActive };
      },
    });

    ctx.registerTool('remove_network_override', {
      description: 'Remove a single network override by URL pattern, leaving all other overrides intact.',
      parameters: z.object({
        urlPattern: z.string().describe('Exact URL pattern of the override to remove'),
      }),
      handler: async ({ urlPattern }) => {
        const idx = overrides.findIndex((o) => o.urlPattern === urlPattern);
        if (idx === -1) return `No override found for pattern "${urlPattern}". Call get_network_overrides to see active overrides.`;
        overrides.splice(idx, 1);
        if (overrides.length === 0 && !overridesPaused) await disableFetchIntercept();
        return { removed: urlPattern, remaining: overrides.length };
      },
    });

    ctx.registerTool('pause_network_overrides', {
      description:
        'Disable network request interception without removing override definitions. ' +
        'All requests will pass through to the real server. ' +
        'Call resume_network_overrides to re-enable. Useful for quickly comparing real vs overridden responses.',
      parameters: z.object({}),
      handler: async () => {
        if (overridesPaused) return 'Network overrides are already paused.';
        overridesPaused = true;
        await disableFetchIntercept();
        return { paused: true, overridesPreserved: overrides.length };
      },
    });

    ctx.registerTool('resume_network_overrides', {
      description:
        'Re-enable network request interception after pause_network_overrides. ' +
        'All previously defined overrides become active again immediately.',
      parameters: z.object({}),
      handler: async () => {
        if (!overridesPaused && fetchInterceptActive) return 'Network overrides are already active.';
        overridesPaused = false;
        if (overrides.length === 0) return 'Network overrides resumed but no overrides are defined. Use override_network_response or load_network_overrides to add some.';
        await enableFetchIntercept();
        return { resumed: true, activeOverrides: overrides.length };
      },
    });

    ctx.registerTool('clear_network_overrides', {
      description:
        'Remove ALL network overrides and disable interception. ' +
        'Use remove_network_override to remove a single override, or pause_network_overrides to temporarily disable without clearing.',
      parameters: z.object({}),
      handler: async () => {
        const count = overrides.length;
        overrides.length = 0;
        overridesPaused = false;
        await disableFetchIntercept();
        return { cleared: count };
      },
    });

    ctx.registerTool('get_network_overrides', {
      description: 'List all currently defined network overrides and whether interception is active.',
      parameters: z.object({}),
      handler: async () => {
        if (overrides.length === 0) return { interceptActive: false, paused: overridesPaused, overrides: [] };
        return {
          interceptActive: fetchInterceptActive,
          paused: overridesPaused,
          overrides: overrides.map((o) => ({
            name: o.name,
            urlPattern: o.urlPattern,
            type: o.block ? 'block' : o.response ? 'response' : 'request',
            ...(o.response ? {
              statusCode: o.response.statusCode,
              bodyPreview: o.response.body
                ? o.response.body.slice(0, 120) + (o.response.body.length > 120 ? '…' : '')
                : '',
              headers: o.response.headers,
            } : {}),
            ...(o.request ? {
              requestUrl: o.request.url,
              requestMethod: o.request.method,
              requestHeaders: o.request.headers,
              requestBodyPreview: o.request.body
                ? o.request.body.slice(0, 120) + (o.request.body.length > 120 ? '…' : '')
                : undefined,
            } : {}),
          })),
        };
      },
    });

    ctx.registerTool('save_network_overrides', {
      description:
        'Save the current in-memory overrides to a JSON file so they can be committed to your codebase. ' +
        'Load them back with load_network_overrides. Defaults to ./network-overrides.json.',
      parameters: z.object({
        filepath: z.string().default('./network-overrides.json')
          .describe('Destination path (default: ./network-overrides.json)'),
      }),
      handler: async ({ filepath }) => {
        if (overrides.length === 0) return 'No overrides to save. Add some with override_network_response first.';
        const absPath = resolve(filepath);
        await mkdir(dirname(absPath), { recursive: true });

        // Serialise to file format (response body stored as string inline)
        const fileEntries: OverrideFileEntry[] = overrides.map((o) => ({
          name: o.name,
          urlPattern: o.urlPattern,
          block: o.block,
          response: o.response ? {
            statusCode: o.response.statusCode,
            headers: o.response.headers,
            body: o.response.body !== undefined
              ? (() => { try { return JSON.parse(o.response!.body!); } catch { return o.response!.body; } })()
              : undefined,
          } : undefined,
          request: o.request,
        }));

        const file: OverrideFile = { version: 1, overrides: fileEntries };
        await writeFile(absPath, JSON.stringify(file, null, 2), 'utf8');
        return { saved: absPath, count: overrides.length };
      },
    });

    ctx.registerTool('load_network_overrides', {
      description:
        'Load overrides from a JSON file or folder and activate them. ' +
        'Each file can be a single override object, an array of overrides, or { version, overrides: [...] }. ' +
        'The response and request fields can be inline config objects or file path strings pointing to separate .json files. ' +
        'Omit filepath to use the path configured via METRO_NETWORK_OVERRIDES or network.overridesFile.',
      parameters: z.object({
        filepath: z.string().optional()
          .describe('Path to a .json file or folder of .json files. Omit to use the configured overridesFile.'),
        name: z.string().optional()
          .describe('Load only the override with this exact name. Omit to load all.'),
        replace: z.boolean().default(false)
          .describe('Replace all in-memory overrides instead of merging (default false)'),
        activate: z.boolean().default(true)
          .describe('Start intercepting immediately after loading (default true)'),
      }),
      handler: async ({ filepath, name, replace, activate }) => {
        const networkConfig = (ctx.config as Record<string, unknown>).network as { overridesFile?: string } | undefined;
        const targetPath = filepath ?? networkConfig?.overridesFile;
        if (!targetPath) {
          return 'No filepath provided and no overridesFile configured. Pass filepath or set network.overridesFile in metro-mcp.config.ts or METRO_NETWORK_OVERRIDES env var.';
        }

        try {
          const result = await loadOverridesFromPath(targetPath, name, replace, activate);
          return result;
        } catch (err) {
          return `Failed to load overrides from "${targetPath}": ${err instanceof Error ? err.message : String(err)}`;
        }
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

    // ── Auto-load overrides on startup ────────────────────────────────────────
    // Explicit config (env/CLI/config file) → warn on failure.
    // Default fallback (./network-overrides.json) → silently skip if missing.

    const networkConfig = (ctx.config as Record<string, unknown>).network as { overridesFile?: string } | undefined;
    const DEFAULT_OVERRIDES_FILE = './network-overrides.json';
    const overridesFilePath = networkConfig?.overridesFile ?? DEFAULT_OVERRIDES_FILE;
    const isExplicit = !!networkConfig?.overridesFile;

    try {
      await stat(resolve(overridesFilePath)); // throws if missing
      const result = await loadOverridesFromPath(overridesFilePath, undefined, false, true);
      ctx.logger.info(`Auto-loaded ${result.added} network override(s) from ${result.loaded}`);
    } catch (err) {
      if (isExplicit) {
        ctx.logger.warn(`Failed to auto-load network overrides from "${overridesFilePath}": ${err instanceof Error ? err.message : String(err)}`);
      }
      // else: default path not found — silent skip
    }
  },
});
