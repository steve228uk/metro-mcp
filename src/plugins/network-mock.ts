import { z } from 'zod';
import { definePlugin } from '../plugin.js';

interface MockEntry {
  id: string;
  urlPattern: string;
  statusCode: number;
  responseBody: string;
  responseHeaders: Record<string, string>;
  delay: number;
  enabled: boolean;
  createdAt: number;
  hitCount: number;
}

// The interceptor script is injected once into the app. It wraps global fetch and XHR,
// reading from globalThis.__METRO_MCP_MOCKS__ at call time so mocks can be added/removed live.
const INTERCEPTOR_SCRIPT = `(function() {
  if (globalThis.__METRO_MCP_MOCKS_ACTIVE__) return 'already_active';
  globalThis.__METRO_MCP_MOCKS__ = globalThis.__METRO_MCP_MOCKS__ || {};
  globalThis.__METRO_MCP_MOCKS_ACTIVE__ = true;

  function findMock(url) {
    var mocks = globalThis.__METRO_MCP_MOCKS__;
    var keys = Object.keys(mocks);
    for (var i = 0; i < keys.length; i++) {
      var mock = mocks[keys[i]];
      if (!mock || !mock.enabled) continue;
      try {
        if (url.indexOf(mock.urlPattern) !== -1) return mock;
        if (new RegExp(mock.urlPattern).test(url)) return mock;
      } catch(e) {
        // invalid regex - fall back to substring match only
        if (url.indexOf(mock.urlPattern) !== -1) return mock;
      }
    }
    return null;
  }

  // ── fetch interception ──
  var _origFetch = globalThis.fetch;
  if (typeof _origFetch === 'function') {
    globalThis.fetch = function(input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var mock = findMock(url);
      if (mock) {
        mock.hitCount = (mock.hitCount || 0) + 1;
        var delay = mock.delay || 0;
        var respond = function() {
          return new Response(mock.responseBody || '', {
            status: mock.statusCode || 200,
            headers: mock.responseHeaders || {},
          });
        };
        if (delay > 0) {
          return new Promise(function(resolve) {
            setTimeout(function() { resolve(respond()); }, delay);
          });
        }
        return Promise.resolve(respond());
      }
      return _origFetch.apply(this, arguments);
    };
  }

  // ── XMLHttpRequest interception ──
  var OrigXHR = globalThis.XMLHttpRequest;
  if (typeof OrigXHR === 'function') {
    var MockXHR = function() {
      this._mockXhr = new OrigXHR();
      this.readyState = 0;
      this.status = 0;
      this.statusText = '';
      this.responseText = '';
      this.response = null;
      this._url = '';
      this._method = '';
      this._headers = {};
      this.onreadystatechange = null;
      this.onload = null;
      this.onerror = null;
    };
    MockXHR.prototype.open = function(method, url) {
      this._method = method;
      this._url = url;
      this._mockXhr.open.apply(this._mockXhr, arguments);
    };
    MockXHR.prototype.setRequestHeader = function(key, value) {
      this._headers[key] = value;
      this._mockXhr.setRequestHeader(key, value);
    };
    MockXHR.prototype.send = function(body) {
      var self = this;
      var mock = findMock(self._url);
      if (mock) {
        mock.hitCount = (mock.hitCount || 0) + 1;
        var deliver = function() {
          self.readyState = 4;
          self.status = mock.statusCode || 200;
          self.statusText = 'OK';
          self.responseText = mock.responseBody || '';
          self.response = mock.responseBody || '';
          if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
          if (typeof self.onload === 'function') self.onload();
        };
        var delay = mock.delay || 0;
        if (delay > 0) { setTimeout(deliver, delay); } else { deliver(); }
        return;
      }
      var origXhr = this._mockXhr;
      origXhr.onreadystatechange = function() {
        self.readyState = origXhr.readyState;
        self.status = origXhr.status;
        self.statusText = origXhr.statusText;
        self.responseText = origXhr.responseText;
        self.response = origXhr.response;
        if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
        if (origXhr.readyState === 4 && typeof self.onload === 'function') self.onload();
      };
      origXhr.onerror = function() {
        if (typeof self.onerror === 'function') self.onerror.apply(self, arguments);
      };
      origXhr.send(body);
    };
    MockXHR.prototype.abort = function() { this._mockXhr.abort(); };
    MockXHR.prototype.getResponseHeader = function(h) { return this._mockXhr.getResponseHeader(h); };
    MockXHR.prototype.getAllResponseHeaders = function() { return this._mockXhr.getAllResponseHeaders(); };
    MockXHR.UNSENT = 0; MockXHR.OPENED = 1; MockXHR.HEADERS_RECEIVED = 2;
    MockXHR.LOADING = 3; MockXHR.DONE = 4;
    globalThis.XMLHttpRequest = MockXHR;
  }

  return 'injected';
})()`;

function buildSyncExpr(id: string, entry: MockEntry | null): string {
  if (entry === null) {
    return `(function() { delete globalThis.__METRO_MCP_MOCKS__[${JSON.stringify(id)}]; return true; })()`;
  }
  return `(function() {
    if (!globalThis.__METRO_MCP_MOCKS__) globalThis.__METRO_MCP_MOCKS__ = {};
    globalThis.__METRO_MCP_MOCKS__[${JSON.stringify(id)}] = ${JSON.stringify(entry)};
    return true;
  })()`;
}

const CLEAR_MOCKS_EXPR = `(function() {
  globalThis.__METRO_MCP_MOCKS__ = {};
  return true;
})()`;

const GET_HIT_COUNTS_EXPR = `(function() {
  var mocks = globalThis.__METRO_MCP_MOCKS__ || {};
  var result = {};
  Object.keys(mocks).forEach(function(id) {
    result[id] = mocks[id] ? mocks[id].hitCount || 0 : 0;
  });
  return result;
})()`;

export const networkMockPlugin = definePlugin({
  name: 'network-mock',
  description:
    'Intercept fetch and XMLHttpRequest calls in the app and return configured mock responses. ' +
    'Useful for testing error states and edge cases without modifying the server.',

  async setup(ctx) {
    const registry = new Map<string, MockEntry>();
    let interceptorInjected = false;

    async function ensureInterceptorInjected(): Promise<void> {
      if (interceptorInjected) return;
      await ctx.evalInApp(INTERCEPTOR_SCRIPT);
      interceptorInjected = true;
    }

    // Re-inject on reconnect (new JS context loses the interceptor)
    ctx.cdp.on('Runtime.executionContextCreated', () => {
      interceptorInjected = false;
      // Re-inject and restore all active mocks if any exist
      if (registry.size > 0) {
        ensureInterceptorInjected()
          .then(async () => {
            for (const [id, entry] of registry) {
              await ctx.evalInApp(buildSyncExpr(id, entry));
            }
          })
          .catch(() => {
            // Silently ignore — app may not be ready yet
          });
      }
    });

    ctx.registerTool('add_mock', {
      description:
        'Add a network mock that intercepts requests matching urlPattern and returns a configured response. ' +
        'urlPattern can be a substring (e.g. "/api/user") or a regex string (e.g. "/api/user/\\\\d+"). ' +
        'Mocks are matched in insertion order; first match wins.',
      annotations: { destructiveHint: true },
      parameters: z.object({
        urlPattern: z
          .string()
          .describe('URL substring or regex pattern to match against request URLs'),
        statusCode: z
          .number()
          .int()
          .min(100)
          .max(599)
          .default(200)
          .describe('HTTP status code to return (default 200)'),
        responseBody: z
          .string()
          .default('')
          .describe('Response body string (use JSON.stringify for JSON responses)'),
        responseHeaders: z
          .record(z.string())
          .default({})
          .describe("Response headers (e.g. { 'Content-Type': 'application/json' })"),
        delay: z
          .number()
          .int()
          .min(0)
          .max(30000)
          .default(0)
          .describe('Delay in milliseconds before responding (default 0)'),
        id: z
          .string()
          .optional()
          .describe('Optional custom ID for the mock. Auto-generated if omitted.'),
      }),
      handler: async ({ urlPattern, statusCode, responseBody, responseHeaders, delay, id }) => {
        const mockId = id ?? `mock_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const entry: MockEntry = {
          id: mockId,
          urlPattern,
          statusCode,
          responseBody,
          responseHeaders,
          delay,
          enabled: true,
          createdAt: Date.now(),
          hitCount: 0,
        };

        await ensureInterceptorInjected();
        registry.set(mockId, entry);
        await ctx.evalInApp(buildSyncExpr(mockId, entry));

        return {
          id: mockId,
          urlPattern,
          statusCode,
          delay,
          message: `Mock added. Requests matching "${urlPattern}" will return ${statusCode}.`,
        };
      },
    });

    ctx.registerTool('list_mocks', {
      description:
        'List all active network mocks, including their URL patterns, status codes, enabled state, and hit counts.',
      annotations: { readOnlyHint: true },
      parameters: z.object({}),
      handler: async () => {
        if (registry.size === 0) return { count: 0, mocks: [] };

        // Sync hit counts from app runtime
        let hitCounts: Record<string, number> = {};
        try {
          hitCounts = (await ctx.evalInApp(GET_HIT_COUNTS_EXPR)) as Record<string, number>;
        } catch {
          // ignore — hit counts may be stale
        }

        const mocks = [...registry.values()].map((m) => ({
          id: m.id,
          urlPattern: m.urlPattern,
          statusCode: m.statusCode,
          delay: m.delay,
          enabled: m.enabled,
          hitCount: hitCounts[m.id] ?? m.hitCount,
          responseBodyLength: m.responseBody.length,
        }));

        return { count: mocks.length, mocks };
      },
    });

    ctx.registerTool('remove_mock', {
      description: 'Remove a network mock by ID. Use list_mocks to find mock IDs.',
      annotations: { destructiveHint: true },
      parameters: z.object({
        id: z.string().describe('Mock ID to remove'),
      }),
      handler: async ({ id }) => {
        if (!registry.has(id)) {
          return `Mock "${id}" not found. Use list_mocks to see active mocks.`;
        }
        registry.delete(id);
        try {
          await ctx.evalInApp(buildSyncExpr(id, null));
        } catch {
          // App may have reloaded; registry is already updated
        }
        return { id, removed: true };
      },
    });

    ctx.registerTool('clear_mocks', {
      description: 'Remove all network mocks.',
      annotations: { destructiveHint: true },
      parameters: z.object({}),
      handler: async () => {
        const count = registry.size;
        registry.clear();
        try {
          await ctx.evalInApp(CLEAR_MOCKS_EXPR);
        } catch {
          // App may have reloaded
        }
        return { cleared: count };
      },
    });

    ctx.registerTool('toggle_mock', {
      description: 'Enable or disable a network mock without removing it.',
      annotations: { destructiveHint: true },
      parameters: z.object({
        id: z.string().describe('Mock ID to toggle'),
        enabled: z.boolean().describe('true to enable, false to disable'),
      }),
      handler: async ({ id, enabled }) => {
        const entry = registry.get(id);
        if (!entry) {
          return `Mock "${id}" not found. Use list_mocks to see active mocks.`;
        }
        entry.enabled = enabled;
        registry.set(id, entry);
        try {
          await ctx.evalInApp(buildSyncExpr(id, entry));
        } catch {
          // App may have reloaded
        }
        return { id, enabled, urlPattern: entry.urlPattern };
      },
    });
  },
});
