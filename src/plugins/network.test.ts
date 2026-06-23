import { expect, test } from 'bun:test';
import { networkPlugin } from './network.js';
import type { ComponentNode, PluginContext } from '../plugin.js';

type Handler = (params: Record<string, unknown>) => void;

async function createNetworkHarness(responseBody: string) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>();
  const cdpSends: Array<{ method: string; params?: Record<string, unknown> }> = [];

  const emit = (event: string, params: Record<string, unknown>) => {
    for (const handler of handlers.get(event) ?? []) {
      handler(params);
    }
  };

  const registerTool: PluginContext['registerTool'] = (name, config) => {
    tools.set(name, {
      handler: config.handler as (args: Record<string, unknown>) => Promise<unknown>,
    });
  };

  const ctx: PluginContext = {
    cdp: {
      on: (event: string, handler: Handler) => {
        const existing = handlers.get(event) ?? [];
        existing.push(handler);
        handlers.set(event, existing);
      },
      off: () => {},
      get isConnected() {
        return true;
      },
      getTarget: () => null,
      send: async (method: string, params?: Record<string, unknown>) => {
        cdpSends.push({ method, params });
        return { body: responseBody, base64Encoded: false };
      },
    },
    events: {
      on: () => {},
      off: () => {},
      isConnected: () => true,
    },
    registerTool,
    registerResource: () => {},
    registerAppResource: () => {},
    registerPrompt: () => {},
    config: {},
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    metro: {
      host: 'localhost',
      port: 8081,
      fetch: async () => new Response(),
    },
    exec: async () => '',
    format: {
      summarize: () => '',
      compact: (value: unknown) => JSON.stringify(value),
      truncate: (value: string) => value,
      structureOnly: (value: ComponentNode) => value,
    },
    evalInApp: async () => null,
    getActiveDeviceKey: () => '8081-device',
    getActiveDeviceName: () => 'device',
    notifyResourceUpdated: () => {},
  };

  await networkPlugin.setup(ctx);

  return { cdpSends, emit, tools };
}

function recordFinishedRequest(emit: (event: string, params: Record<string, unknown>) => void): void {
  emit('Network.requestWillBeSent', {
    requestId: 'request-1',
    request: { url: 'https://example.test/api', method: 'GET', headers: {} },
    type: 'Fetch',
  });
  emit('Network.responseReceived', {
    requestId: 'request-1',
    response: { status: 200, statusText: 'OK', headers: {} },
  });
  emit('Network.loadingFinished', {
    requestId: 'request-1',
    encodedDataLength: 12,
  });
}

test('network plugin fetches response bodies only on explicit request', async () => {
  const { cdpSends, emit, tools } = await createNetworkHarness('{"ok":true}');

  recordFinishedRequest(emit);

  expect(cdpSends).toEqual([]);

  const getResponseBody = tools.get('get_response_body');
  expect(getResponseBody).toBeDefined();
  const result = await getResponseBody!.handler({ url: 'example.test', index: -1 });

  expect(cdpSends).toEqual([
    { method: 'Network.getResponseBody', params: { requestId: 'request-1' } },
  ]);
  expect(result).toEqual({
    url: 'https://example.test/api',
    status: 200,
    body: { ok: true },
  });
});

test('network plugin does not cache response bodies over the byte limit', async () => {
  const largeMultibyteBody = String.fromCodePoint(0x1f600).repeat(300_000);
  expect(largeMultibyteBody.length).toBeLessThan(1024 * 1024);
  expect(Buffer.byteLength(largeMultibyteBody, 'utf8')).toBeGreaterThan(1024 * 1024);

  const { emit, tools } = await createNetworkHarness(largeMultibyteBody);
  recordFinishedRequest(emit);

  const getResponseBody = tools.get('get_response_body');
  expect(getResponseBody).toBeDefined();

  const result = await getResponseBody!.handler({ url: 'example.test', index: -1 });
  expect(result).toEqual({
    url: 'https://example.test/api',
    status: 200,
    body: largeMultibyteBody,
  });

  emit('reconnected', {});

  const unavailable = await getResponseBody!.handler({ url: 'example.test', index: -1 });
  expect(unavailable).toContain('Response body unavailable');
});
