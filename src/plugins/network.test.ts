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
    execFile: async () => Buffer.alloc(0),
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

test('network plugin captures stack-bearing requests when no native twin is emitted', async () => {
  // Modern fusebox inspector (RN 0.76+) emits a single requestWillBeSent that
  // carries a JS call stack; its requestId is referenced by the later events.
  const { emit, tools } = await createNetworkHarness('{"ok":true}');

  emit('Network.requestWillBeSent', {
    requestId: 'uuid-1',
    request: { url: 'https://example.test/graphql', method: 'POST', headers: {} },
    type: 'Fetch',
    initiator: { type: 'script', stack: { callFrames: [] } },
  });
  emit('Network.responseReceived', {
    requestId: 'uuid-1',
    response: { status: 200, statusText: 'OK', headers: {} },
  });
  emit('Network.loadingFinished', { requestId: 'uuid-1', encodedDataLength: 12 });

  const getResponseBody = tools.get('get_response_body');
  const result = await getResponseBody!.handler({ url: 'example.test/graphql', index: -1 });
  expect(result).toEqual({
    url: 'https://example.test/graphql',
    status: 200,
    body: { ok: true },
  });
});

test('network plugin keeps an unrelated stack-bearing request after a stackless request', async () => {
  const { emit, tools } = await createNetworkHarness('{"ok":true}');

  recordFinishedRequest(emit);
  emit('Network.requestWillBeSent', {
    requestId: 'uuid-2',
    request: { url: 'https://example.test/graphql', method: 'POST', headers: {} },
    type: 'Fetch',
    initiator: { type: 'script', stack: { callFrames: [] } },
  });
  emit('Network.responseReceived', {
    requestId: 'uuid-2',
    response: { status: 201, statusText: 'Created', headers: {} },
  });
  emit('Network.loadingFinished', { requestId: 'uuid-2', encodedDataLength: 12 });

  const getNetworkRequests = tools.get('get_network_requests');
  const result = await getNetworkRequests!.handler({
    limit: 50,
    summary: false,
    format: 'json',
  });
  expect(result).toEqual([
    expect.objectContaining({ id: 'request-1', status: 200 }),
    expect.objectContaining({ id: 'uuid-2', status: 201 }),
  ]);
});

async function expectLegacyDuplicateToBeCollapsed(stackBearingFirst: boolean): Promise<void> {
  const { emit, tools } = await createNetworkHarness('{"ok":true}');

  const nativeEvent = {
    requestId: 'native-1',
    request: { url: 'https://example.test/api', method: 'GET', headers: {} },
    type: 'Fetch',
  };
  const stackBearingEvent = {
    requestId: 'uuid-1',
    request: { url: 'https://example.test/api', method: 'GET', headers: {} },
    type: 'Fetch',
    initiator: { type: 'script', stack: { callFrames: [] } },
  };

  const requestEvents = stackBearingFirst
    ? [stackBearingEvent, nativeEvent]
    : [nativeEvent, stackBearingEvent];
  for (const event of requestEvents) {
    emit('Network.requestWillBeSent', event);
  }

  emit('Network.responseReceived', {
    requestId: 'native-1',
    response: { status: 200, statusText: 'OK', headers: {} },
  });
  emit('Network.loadingFinished', { requestId: 'native-1', encodedDataLength: 12 });
  // The JS-layer duplicate must never have been tracked, so its id resolves to nothing.
  emit('Network.loadingFinished', { requestId: 'uuid-1', encodedDataLength: 12 });

  const getNetworkRequests = tools.get('get_network_requests');
  const result = await getNetworkRequests!.handler({
    limit: 50,
    summary: false,
    format: 'json',
  });
  expect(result).toEqual([
    expect.objectContaining({
      id: 'native-1',
      url: 'https://example.test/api',
      status: 200,
    }),
  ]);
}

test('network plugin drops a stack-bearing duplicate emitted after its native twin', async () => {
  await expectLegacyDuplicateToBeCollapsed(false);
});

test('network plugin drops a stack-bearing duplicate emitted before its native twin', async () => {
  await expectLegacyDuplicateToBeCollapsed(true);
});

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
