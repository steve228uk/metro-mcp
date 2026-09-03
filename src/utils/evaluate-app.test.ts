import { describe, expect, test } from 'bun:test';
import vm from 'node:vm';
import { createAppEvaluator, evaluateAppScript } from './evaluate-app.js';

function cdpHarness(response: unknown) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const cdp = {
    send: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return { cdp, calls };
}

describe('raw app evaluation', () => {
  test('uses synchronous CDP completion semantics and forwards timeout', async () => {
    const { cdp, calls } = cdpHarness({ result: { value: 42 } });
    await expect(evaluateAppScript(cdp, 'var answer = 42; answer;', { timeout: 1234 }))
      .resolves.toBe(42);
    expect(calls).toEqual([{
      method: 'Runtime.evaluate',
      params: {
        expression: 'var answer = 42; answer;',
        returnByValue: true,
        awaitPromise: false,
        timeout: 1234,
      },
    }]);
  });

  test('reports CDP exceptions without replaying the script', async () => {
    const { cdp, calls } = cdpHarness({
      exceptionDetails: { text: 'script failed' },
    });
    await expect(evaluateAppScript(cdp, 'mutateOnce();')).rejects.toThrow('script failed');
    expect(calls).toHaveLength(1);
  });

  test('propagates an ambiguous transport failure after one dispatch', async () => {
    const { cdp, calls } = cdpHarness(new Error('WebSocket closed'));
    await expect(evaluateAppScript(cdp, 'increment();')).rejects.toThrow('WebSocket closed');
    expect(calls).toHaveLength(1);
  });
});

function vmTransport() {
  let appGlobal = vm.createContext({ setTimeout, clearTimeout });
  const calls: Array<Record<string, unknown>> = [];
  const transport = {
    send: async (_method: string, params?: Record<string, unknown>) => {
      calls.push(params ?? {});
      const result = new vm.Script(String(params?.expression)).runInContext(appGlobal);
      return {
        result: {
          value: result === undefined ? undefined : JSON.parse(JSON.stringify(result)),
        },
      };
    },
    replaceContext() {
      appGlobal = vm.createContext({ setTimeout, clearTimeout });
    },
    get context() {
      return appGlobal;
    },
  };
  return { transport, calls };
}

function lifecycle(overrides: Partial<{
  ensureConnected: () => Promise<void>;
  waitForReconnect: () => Promise<void>;
  reconnect: () => Promise<void>;
  isReconnecting: () => boolean;
}> = {}) {
  let reconnecting = false;
  let reconnectCount = 0;
  return {
    state: () => ({ reconnectCount }),
    ensureConnected: overrides.ensureConnected ?? (async () => {}),
    waitForReconnect: overrides.waitForReconnect ?? (async () => {}),
    reconnect: overrides.reconnect ?? (async () => { reconnectCount += 1; }),
    isReconnecting: overrides.isReconnecting ?? (() => reconnecting),
  };
}

describe('shared app evaluation policy', () => {
  test('does not replay a script after an ambiguous initial dispatch', async () => {
    const { transport, calls } = vmTransport();
    const initialContext = transport.context;
    let first = true;
    const originalSend = transport.send;
    transport.send = async (method, params) => {
      const result = await originalSend(method, params);
      if (first) {
        first = false;
        throw new Error('WebSocket closed');
      }
      return result;
    };
    const evalInApp = createAppEvaluator(transport, lifecycle());

    await expect(evalInApp(
      'globalThis.executionCount = (globalThis.executionCount || 0) + 1; Promise.resolve(executionCount);',
      { awaitPromise: true, timeout: 1000 },
    )).rejects.toThrow('WebSocket closed');
    expect(initialContext).toHaveProperty('executionCount', 1);
    expect(calls).toHaveLength(2); // initial dispatch plus mailbox cleanup
  });

  test('reconnects mailbox reads without replaying the original source', async () => {
    const { transport, calls } = vmTransport();
    let firstPoll = true;
    const originalSend = transport.send;
    transport.send = async (method, params) => {
      if (firstPoll && calls.length === 1) {
        firstPoll = false;
        throw new Error('WebSocket closed');
      }
      return originalSend(method, params);
    };
    const state = lifecycle();
    const evalInApp = createAppEvaluator(transport, state);

    await expect(evalInApp(
      'globalThis.executionCount = (globalThis.executionCount || 0) + 1; new Promise(resolve => setTimeout(() => resolve(executionCount), 10));',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe(1);
    expect(state.state().reconnectCount).toBe(1);
    expect(calls.length).toBeGreaterThan(2);
  });

  test('keeps unawaited evaluation one-shot after an ambiguous dispatch', async () => {
    const { transport, calls } = vmTransport();
    const initialContext = transport.context;
    let first = true;
    const originalSend = transport.send;
    transport.send = async (method, params) => {
      if (first) {
        first = false;
        await originalSend(method, params);
        throw new Error('WebSocket closed');
      }
      return originalSend(method, params);
    };
    const state = lifecycle();
    const evalInApp = createAppEvaluator(transport, state);

    await expect(evalInApp(
      'globalThis.executionCount = (globalThis.executionCount || 0) + 1; executionCount;',
      { awaitPromise: false },
    )).rejects.toThrow('WebSocket closed');
    expect(initialContext).toHaveProperty('executionCount', 1);
    expect(state.state().reconnectCount).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.awaitPromise).toBe(false);
  });

  test('reports a lost mailbox when reconnect lands in a new app context', async () => {
    const { transport, calls } = vmTransport();
    const originalSend = transport.send;
    transport.send = async (method, params) => {
      if (calls.length === 1) transport.replaceContext();
      return originalSend(method, params);
    };
    const evalInApp = createAppEvaluator(transport, lifecycle());

    await expect(evalInApp(
      'new Promise(resolve => setTimeout(() => resolve(1), 20));',
      { awaitPromise: true, timeout: 1000 },
    )).rejects.toThrow('context was lost');
  });

  test('bounds a stalled initial CDP request by the caller deadline', async () => {
    const calls: Record<string, unknown>[] = [];
    const transport = {
      send: async (_method: string, params?: Record<string, unknown>) => {
        calls.push(params ?? {});
        return new Promise(() => {});
      },
    };
    const started = Date.now();
    const evalInApp = createAppEvaluator(transport, lifecycle());

    await expect(evalInApp('new Promise(() => {})', { awaitPromise: true, timeout: 40 }))
      .rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(500);
    expect(calls).toHaveLength(1);
  });

  test('bounds a stalled mailbox poll and does not wait for cleanup', async () => {
    const { transport, calls } = vmTransport();
    const originalSend = transport.send;
    transport.send = async (method, params) => {
      if (calls.length === 1) return new Promise(() => {});
      return originalSend(method, params);
    };
    const started = Date.now();
    const evalInApp = createAppEvaluator(transport, lifecycle());

    await expect(evalInApp('Promise.resolve(1)', { awaitPromise: true, timeout: 40 }))
      .rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(500);
    expect(calls).toHaveLength(1);
  });

  test('bounds reconnect recovery after a dropped mailbox read', async () => {
    const { transport, calls } = vmTransport();
    const originalSend = transport.send;
    transport.send = async (method, params) => {
      if (calls.length === 0) return originalSend(method, params);
      throw new Error('WebSocket closed');
    };
    const state = lifecycle({ reconnect: async () => new Promise(() => {}) });
    const started = Date.now();
    const evalInApp = createAppEvaluator(transport, state);

    await expect(evalInApp('new Promise(() => {})', { awaitPromise: true, timeout: 40 }))
      .rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('keeps stalled cleanup best effort within the absolute deadline', async () => {
    const { transport, calls } = vmTransport();
    const originalSend = transport.send;
    transport.send = async (method, params) => {
      if (calls.length === 2) return new Promise(() => {});
      return originalSend(method, params);
    };
    const started = Date.now();
    const evalInApp = createAppEvaluator(transport, lifecycle());

    await expect(evalInApp('Promise.resolve(1)', { awaitPromise: true, timeout: 40 }))
      .resolves.toBe(1);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
