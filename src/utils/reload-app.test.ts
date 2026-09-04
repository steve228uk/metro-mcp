import { afterEach, describe, expect, test } from 'bun:test';
import vm from 'node:vm';
import { WebSocketServer } from 'ws';
import type { MetroTarget } from 'metro-bridge';
import type { PluginContext } from '../plugin.js';
import { createMetroMessageUrl, reloadApp, selectReloadPeer } from './reload-app.js';

const target: MetroTarget = {
  id: 'page-1', appId: 'com.example.app', deviceName: 'Test Device',
  title: 'React Native', description: 'Hermes', type: 'node',
  webSocketDebuggerUrl: 'ws://127.0.0.1:1/inspector/debug?page=1',
  reactNative: { logicalDeviceId: 'device-1' },
};

function harness(send: (options?: { timeoutMs?: number }) => Promise<unknown>, initial = target) {
  let current = initial;
  let app = vm.createContext({ setTimeout: () => 0 });
  let reloads = 0;
  const targetUrl = new URL(initial.webSocketDebuggerUrl!);
  const cdp = {
    isConnected: true,
    getTarget: () => current,
    send: async function(this: unknown, method: string, _params?: Record<string, unknown>, options?: { timeoutMs?: number }) {
        expect(this).toBe(cdp);
        expect(method).toBe('Page.reload');
        reloads++;
        return send(options);
      },
  };
  const ctx = {
    cdp,
    evalInApp: async (expression: string) => new vm.Script(expression).runInContext(app),
    metro: {
      host: targetUrl.hostname,
      port: Number(targetUrl.port),
      fetch: async () => { throw new Error('Never use the HTTP reload endpoint'); },
    },
  } as unknown as PluginContext;
  return {
    ctx,
    get reloads() { return reloads; },
    restart(appId = initial.appId) {
      app = vm.createContext({ setTimeout: () => 0 });
      current = { ...initial, id: 'page-2', appId };
    },
  };
}

const servers: WebSocketServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate();
    server.close();
  }
});

async function messageServer(peers: Record<string, string>, onReload: (message: Record<string, unknown>) => void) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  server.on('connection', (socket) => socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.method === 'getpeers') socket.send(JSON.stringify({ version: 2, id: message.id, result: peers }));
    if (message.method === 'reload') onReload(message);
  }));
  const address = server.address() as { port: number };
  return { ...target, webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/inspector/debug?page=1` };
}

describe('verified app reload', () => {
  test('does not dispatch or claim verification when the runtime changes before dispatch', async () => {
    const app = harness(async () => ({}));
    const evaluate = app.ctx.evalInApp;
    app.ctx.evalInApp = async (expression, options) => {
      const value = await evaluate(expression, options);
      if (expression.includes('setTimeout')) app.restart();
      return value;
    };
    expect(await reloadApp(app.ctx, 100)).toMatchObject({ status: 'failed', dispatch: 'not-sent', verified: false });
    expect(app.reloads).toBe(0);
  });

  test('does not send a fallback if the runtime changes after an unsupported CDP response', async () => {
    const messages: Record<string, unknown>[] = [];
    const socketTarget = await messageServer({ selected: 'app=com.example.app&device=Test+Device' }, (message) => messages.push(message));
    const app = harness(async () => { app.restart(); throw new Error('Unsupported method: Page.reload'); }, socketTarget);
    expect(await reloadApp(app.ctx, 500)).toMatchObject({ status: 'failed', dispatch: 'not-sent', verified: false });
    expect(messages).toEqual([]);
    expect(app.reloads).toBe(1);
  });

  test('uses Page.reload and requires the marker to disappear on the same app', async () => {
    const app = harness(async () => { app.restart(); });
    expect(await reloadApp(app.ctx, 100)).toMatchObject({ status: 'reloaded', method: 'Page.reload', dispatch: 'submitted', verified: true });
    expect(app.reloads).toBe(1);
  });

  test('uses the intrinsic global when evaluated source shadows globalThis', async () => {
    const app = harness(async () => { app.restart(); });
    expect(await app.ctx.evalInApp('let globalThis = null; 42')).toBe(42);
    expect(await reloadApp(app.ctx, 100)).toMatchObject({
      status: 'reloaded', method: 'Page.reload', dispatch: 'submitted', verified: true,
    });
    expect(app.reloads).toBe(1);
  });

  test('a successful command response alone is unverified', async () => {
    const app = harness(async () => ({}));
    expect(await reloadApp(app.ctx, 100)).toMatchObject({ status: 'unverified', verified: false });
    expect(app.reloads).toBe(1);
  });

  test('verifies after a lost response without resending the mutation', async () => {
    const app = harness(async () => { app.restart(); throw new Error('WebSocket closed'); });
    expect(await reloadApp(app.ctx, 100)).toMatchObject({ status: 'reloaded', dispatch: 'unknown', verified: true });
    expect(app.reloads).toBe(1);
  });

  test('allows the evaluator to reconnect after Page.reload drops the target', async () => {
    const app = harness(async () => {
      app.restart();
      app.ctx.cdp.isConnected = false;
    });
    const evaluate = app.ctx.evalInApp;
    app.ctx.evalInApp = async (expression, options) => {
      if (!app.ctx.cdp.isConnected) app.ctx.cdp.isConnected = true;
      return evaluate(expression, options);
    };
    expect(await reloadApp(app.ctx, 100)).toMatchObject({ status: 'reloaded', verified: true });
    expect(app.reloads).toBe(1);
  });

  test('rejects a reconnect that lands on a different app', async () => {
    const app = harness(async () => {
      app.restart('com.other.app');
      app.ctx.cdp.isConnected = false;
    });
    const evaluate = app.ctx.evalInApp;
    app.ctx.evalInApp = async (expression, options) => {
      if (!app.ctx.cdp.isConnected) app.ctx.cdp.isConnected = true;
      return evaluate(expression, options);
    };
    expect(await reloadApp(app.ctx, 100)).toMatchObject({ status: 'unverified', verified: false });
    expect(app.reloads).toBe(1);
  });

  test('never falls back after an ambiguous dispatch or claims a different app restarted', async () => {
    const uncertain = harness(async () => { throw new Error('WebSocket closed'); });
    expect(await reloadApp(uncertain.ctx, 100)).toMatchObject({ status: 'unverified', method: 'Page.reload', dispatch: 'unknown' });
    expect(uncertain.reloads).toBe(1);
    const otherApp = harness(async () => { otherApp.restart('com.other.app'); });
    expect(await reloadApp(otherApp.ctx, 100)).toMatchObject({ status: 'unverified', verified: false });
  });

  test('passes the remaining deadline to a stalled CDP transport', async () => {
    let requestedTimeout = 0;
    const app = harness((options) => new Promise<never>((_, reject) => {
      requestedTimeout = options?.timeoutMs ?? 0;
      setTimeout(() => reject(new Error('CDP request timed out')), requestedTimeout);
    }));
    const start = Date.now();
    expect(await reloadApp(app.ctx, 100)).toMatchObject({ status: 'unverified', dispatch: 'unknown' });
    expect(requestedTimeout).toBeGreaterThan(0);
    expect(requestedTimeout).toBeLessThanOrEqual(100);
    expect(Date.now() - start).toBeLessThan(500);
    expect(app.reloads).toBe(1);
  });

  test('directs fallback to a verified peer even when unrelated apps are connected', async () => {
    const messages: Record<string, unknown>[] = [];
    const socketTarget = await messageServer({
      selected: 'app=com.example.app&device=Test+Device',
      unrelated: 'app=com.other.app&device=Test+Device',
    }, (message) => { messages.push(message); app.restart(); });
    const app = harness(async () => { throw new Error('Unsupported method: Page.reload'); }, socketTarget);
    expect(await reloadApp(app.ctx, 500)).toMatchObject({ status: 'reloaded', method: 'metro-message', verified: true });
    expect(messages).toEqual([{ version: 2, method: 'reload', target: 'selected' }]);
    expect(app.reloads).toBe(1);
  });

  test('uses the Metro message endpoint when the target URL belongs to a CDP proxy', async () => {
    const messages: Record<string, unknown>[] = [];
    const metroTarget = await messageServer({ selected: 'app=com.example.app&device=Test+Device' }, (message) => {
      messages.push(message);
    });
    const metroPort = Number(new URL(metroTarget.webSocketDebuggerUrl!).port);
    const proxyTarget = {
      ...metroTarget,
      webSocketDebuggerUrl: 'wss://proxy.example:1/inspector/debug?page=proxy',
    };
    const app = harness(async () => { throw new Error("'Page.reload' wasn't found"); }, proxyTarget);
    app.ctx.metro.host = '127.0.0.1';
    app.ctx.metro.port = metroPort;
    expect(await reloadApp(app.ctx, 500)).toMatchObject({ status: 'unverified', method: 'metro-message' });
    expect(messages).toEqual([{ version: 2, method: 'reload', target: 'selected' }]);
    expect(app.reloads).toBe(1);
  });

  test('does not send fallback to an unidentifiable sole peer', async () => {
    const messages: Record<string, unknown>[] = [];
    const socketTarget = await messageServer({ unknown: 'role=ios' }, (message) => messages.push(message));
    const app = harness(async () => { throw new Error("'Page.reload' wasn't found"); }, socketTarget);
    expect(await reloadApp(app.ctx, 500)).toMatchObject({ status: 'failed', dispatch: 'not-sent', verified: false });
    expect(messages).toEqual([]);
  });

  test('treats Metro Bridge disconnected-target errors as unsent', async () => {
    const messages: Record<string, unknown>[] = [];
    const socketTarget = await messageServer({ selected: 'app=com.example.app&device=Test+Device' }, (message) => messages.push(message));
    const app = harness(async () => { throw new Error('Not connected to CDP target'); }, socketTarget);
    expect(await reloadApp(app.ctx, 500)).toMatchObject({
      status: 'failed', method: 'Page.reload', dispatch: 'not-sent', verified: false,
    });
    expect(messages).toEqual([]);
    expect(app.reloads).toBe(1);
  });
});

test('message peer selection requires a unique app and device match', () => {
  expect(selectReloadPeer({ a: 'app=com.example.app&device=Test+Device' }, target)).toBe('a');
  expect(selectReloadPeer({ a: 'app=com.example.app&device=Test+Device', b: 'app=com.example.app&device=Test+Device' }, target)).toBeNull();
  expect(selectReloadPeer({ a: 'app=com.other.app&device=Test+Device' }, target)).toBeNull();
  expect(selectReloadPeer({ a: {} }, target)).toBeNull();
});

test('builds a ws Metro message URL with bracketed IPv6 hosts', () => {
  expect(createMetroMessageUrl('::1', 8081).toString()).toBe('ws://[::1]:8081/message');
  expect(createMetroMessageUrl('[::1]', 8081).toString()).toBe('ws://[::1]:8081/message');
});
