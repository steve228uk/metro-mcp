import { expect, test } from 'bun:test';
import { networkPlugin } from './network.js';
import type { ComponentNode, PluginContext } from '../plugin.js';

type Handler = (params: Record<string, unknown>) => void;

test('network plugin fetches response bodies only on explicit request', async () => {
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
        return { body: '{"ok":true}', base64Encoded: false };
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
