import { describe, expect, test } from 'bun:test';
import vm from 'node:vm';
import {
  createAppEvaluator,
  evaluateAppScript,
  evaluateAppScriptCompletion,
} from './evaluate-app.js';

function cdpHarness(response: unknown) {
  const calls: Array<{
    method: string;
    params?: Record<string, unknown>;
    options?: Record<string, unknown>;
  }> = [];
  const cdp = {
    send: async (
      method: string,
      params?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => {
      calls.push({ method, params, options });
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
      options: { timeoutMs: 1234 },
    }]);
  });

  test('reports CDP exceptions without replaying the script', async () => {
    const { cdp, calls } = cdpHarness({
      exceptionDetails: { text: 'script failed' },
    });
    await expect(evaluateAppScript(cdp, 'mutateOnce();')).rejects.toThrow('script failed');
    expect(calls).toHaveLength(1);
  });

  test('keeps the engine timeout with a remote completion group', async () => {
    const { cdp, calls } = cdpHarness({
      result: { type: 'object', subtype: 'promise', objectId: 'promise-1' },
    });
    await expect(evaluateAppScriptCompletion(cdp, 'Promise.resolve(42)', {
      timeout: 321,
      objectGroup: 'group-1',
    })).resolves.toEqual({ objectId: 'promise-1' });
    expect(calls[0]).toEqual({
      method: 'Runtime.evaluate',
      params: {
        expression: 'Promise.resolve(42)',
        returnByValue: false,
        awaitPromise: false,
        timeout: 321,
        objectGroup: 'group-1',
      },
      options: { timeoutMs: 321 },
    });
  });

  test('propagates an ambiguous transport failure after one dispatch', async () => {
    const { cdp, calls } = cdpHarness(new Error('WebSocket closed'));
    await expect(evaluateAppScript(cdp, 'increment();')).rejects.toThrow('WebSocket closed');
    expect(calls).toHaveLength(1);
  });

  test('preserves CDP unserializable primitive completions', async () => {
    const values: Array<[string, unknown]> = [
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['-0', -0],
      ['123456789012345678901234567890n', 123456789012345678901234567890n],
    ];
    for (const [unserializableValue, expected] of values) {
      const { cdp } = cdpHarness({
        result: { type: 'number', unserializableValue },
      });
      const actual = await evaluateAppScript(cdp, 'completion');
      if (typeof expected === 'number' && Object.is(expected, -0)) {
        expect(Object.is(actual, -0)).toBe(true);
      } else if (typeof expected === 'number' && Number.isNaN(expected)) {
        expect(Number.isNaN(actual)).toBe(true);
      } else {
        expect(actual).toBe(expected);
      }
    }
  });
});

function vmTransport() {
  let appGlobal = vm.createContext({ setTimeout, clearTimeout });
  let nextObjectId = 0;
  let remoteObjects = new Map<string, unknown>();
  const calls: Array<{
    method: string;
    params: Record<string, unknown>;
    options?: Record<string, unknown>;
  }> = [];
  const transport = {
    send: async (
      method: string,
      params?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => {
      const actualParams = params ?? {};
      calls.push({ method, params: actualParams, options });
      if (method === 'Runtime.evaluate') {
        const result = new vm.Script(String(actualParams.expression)).runInContext(appGlobal);
        if (actualParams.returnByValue === false && result !== null &&
            (typeof result === 'object' || typeof result === 'function')) {
          const objectId = `remote-${++nextObjectId}`;
          remoteObjects.set(objectId, result);
          return {
            result: {
              type: 'object',
              subtype: result instanceof Promise ? 'promise' : undefined,
              objectId,
            },
          };
        }
        return {
          result: {
            value: result === undefined ? undefined : JSON.parse(JSON.stringify(result)),
          },
        };
      }
      if (method === 'Runtime.callFunctionOn') {
        const object = remoteObjects.get(String(actualParams.objectId));
        const fn = new vm.Script(`(${String(actualParams.functionDeclaration)})`).runInContext(appGlobal) as Function;
        fn.call(object, ...((actualParams.arguments as Array<{ value: unknown }> | undefined)?.map((arg) => arg.value) ?? []));
        return { result: { value: true } };
      }
      return { result: { value: undefined } };
    },
    replaceContext() {
      appGlobal = vm.createContext({ setTimeout, clearTimeout });
      remoteObjects = new Map();
    },
    invalidateHandles() {
      remoteObjects = new Map();
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
  test('passes only the remaining deadline to transport after connection setup', async () => {
    const { cdp, calls } = cdpHarness({ result: { value: 42 } });
    const evaluate = createAppEvaluator(cdp, lifecycle({
      ensureConnected: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); },
    }));
    const deadline = Date.now() + 200;
    expect(await evaluate('42', { timeout: 200, deadline })).toBe(42);
    expect(calls[0].options?.timeoutMs).toBeGreaterThan(0);
    expect(calls[0].options?.timeoutMs).toBeLessThanOrEqual(175);
  });

  test('does not dispatch after connection setup outlives the caller deadline', async () => {
    const { cdp, calls } = cdpHarness({ result: { value: 42 } });
    const evaluate = createAppEvaluator(cdp, lifecycle({
      ensureConnected: async () => { await new Promise((resolve) => setTimeout(resolve, 50)); },
    }));
    await expect(evaluate('mutate()', { awaitPromise: true, timeout: 10 })).rejects.toThrow('timed out');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.filter((call) => call.method === 'Runtime.evaluate')).toHaveLength(0);
    expect(calls).toHaveLength(1); // bounded late-completion group cleanup
  });

  test('does not replay a script after an ambiguous initial dispatch', async () => {
    const { transport, calls } = vmTransport();
    const initialContext = transport.context;
    let first = true;
    const originalSend = transport.send;
    transport.send = async (method, params) => {
      const result = await originalSend(method, params);
      if (first && method === 'Runtime.evaluate' &&
          String(params?.expression).includes('executionCount')) {
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
    expect(calls.filter((call) => call.method === 'Runtime.evaluate' &&
      String(call.params.expression).includes('executionCount'))).toHaveLength(1);
  });

  test('reconnects mailbox reads without replaying the original source', async () => {
    const { transport, calls } = vmTransport();
    let firstPoll = true;
    const originalSend = transport.send;
    transport.send = async (method, params) => {
      if (firstPoll && method === 'Runtime.evaluate' &&
          String(params?.expression).includes('return { status:')) {
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

  test('leaves a pre-dispatch settlement loss pending without replay', async () => {
    const { transport, calls } = vmTransport();
    const originalSend = transport.send;
    let settlementAttempts = 0;
    transport.send = async (method, params) => {
      if (method === 'Runtime.callFunctionOn') {
        settlementAttempts += 1;
        if (settlementAttempts === 1) throw new Error('WebSocket closed');
      }
      return originalSend(method, params);
    };
    const state = lifecycle();
    const evalInApp = createAppEvaluator(transport, state);

    await expect(evalInApp(
      'globalThis.executionCount = (globalThis.executionCount || 0) + 1; Promise.resolve(executionCount);',
      { awaitPromise: true, timeout: 40 },
    )).rejects.toThrow('timed out');
    expect(transport.context).toHaveProperty('executionCount', 1);
    expect(state.state().reconnectCount).toBe(1);
    expect(settlementAttempts).toBe(1);
  });

  test('recovers a lost settlement response without replaying a side-effecting thenable', async () => {
    const { transport } = vmTransport();
    const originalSend = transport.send;
    let settlementAttempts = 0;
    transport.send = async (method, params) => {
      if (method === 'Runtime.callFunctionOn') {
        settlementAttempts += 1;
        const result = await originalSend(method, params);
        if (settlementAttempts === 1) throw new Error('WebSocket closed');
        return result;
      }
      return originalSend(method, params);
    };
    let reconnects = 0;
    const state = lifecycle({ reconnect: async () => {
      reconnects += 1;
      transport.invalidateHandles();
    } });
    const evalInApp = createAppEvaluator(transport, state);

    await expect(evalInApp(
      `globalThis.thenCalls = 0;
       ({ then: function(resolve) { globalThis.thenCalls += 1; resolve(7); } });`,
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe(7);
    expect(transport.context).toHaveProperty('thenCalls', 1);
    expect(reconnects).toBe(1);
    expect(settlementAttempts).toBe(1);
  });

  test('does not dispatch source when runtime generation changes after mailbox setup', async () => {
    const { transport, calls } = vmTransport();
    let generation = 0;
    const base = lifecycle();
    const evalInApp = createAppEvaluator(transport, {
      ...base,
      getGeneration: () => generation,
      ensureConnected: async () => {
        if (calls.filter((call) => call.method === 'Runtime.evaluate').length === 1) {
          generation += 1;
        }
      },
    });

    await expect(evalInApp(
      'globalThis.sourceMutation = true; Promise.resolve(1);',
      { awaitPromise: true, timeout: 1000 },
    )).rejects.toThrow('context changed before source dispatch');
    expect(transport.context).not.toHaveProperty('sourceMutation');
    expect(calls.filter((call) => call.method === 'Runtime.evaluate' &&
      String(call.params.expression).includes('sourceMutation'))).toHaveLength(0);
  });

  test('rejects a generation change immediately after mailbox setup response', async () => {
    const { transport, calls } = vmTransport();
    let generation = 0;
    const originalSend = transport.send;
    transport.send = async (method, params) => {
      const result = await originalSend(method, params);
      if (method === 'Runtime.evaluate' &&
          String(params?.expression).includes('Object.defineProperty(globalThis')) {
        generation += 1;
      }
      return result;
    };
    const base = lifecycle();
    const evalInApp = createAppEvaluator(transport, {
      ...base,
      getGeneration: () => generation,
    });

    await expect(evalInApp(
      'globalThis.sourceMutation = true; Promise.resolve(1);',
      { awaitPromise: true, timeout: 1000 },
    )).rejects.toThrow('context changed during mailbox setup');
    expect(transport.context).not.toHaveProperty('sourceMutation');
    expect(calls.filter((call) => call.method === 'Runtime.evaluate' &&
      String(call.params.expression).includes('sourceMutation'))).toHaveLength(0);
  });

  test('does not retry remote settlement after a deadline-bounded reconnect', async () => {
    const { transport } = vmTransport();
    const originalSend = transport.send;
    let settlementAttempts = 0;
    transport.send = async (method, params) => {
      if (method === 'Runtime.callFunctionOn') {
        settlementAttempts += 1;
        if (settlementAttempts === 1) throw new Error('WebSocket closed');
      }
      return originalSend(method, params);
    };
    let reconnects = 0;
    const state = lifecycle({
      reconnect: async () => {
        reconnects += 1;
        await new Promise((resolve) => setTimeout(resolve, 60));
      },
    });
    const evalInApp = createAppEvaluator(transport, state);

    await expect(evalInApp(
      'globalThis.executionCount = (globalThis.executionCount || 0) + 1; new Promise(resolve => setTimeout(() => resolve(executionCount), 100));',
      { awaitPromise: true, timeout: 30 },
    )).rejects.toThrow('timed out');
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(transport.context).toHaveProperty('executionCount', 1);
    expect(settlementAttempts).toBe(1);
    expect(reconnects).toBe(1);
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
    expect(calls[0]?.params.awaitPromise).toBe(false);
  });

  test('reports a lost mailbox when reconnect lands in a new app context', async () => {
    const { transport, calls } = vmTransport();
    const originalSend = transport.send;
    transport.send = async (method, params) => {
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('return { status:')) {
        transport.replaceContext();
      }
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
    expect(calls).toHaveLength(2); // stalled setup plus bounded group cleanup
  });

  test('bounds a stalled mailbox poll and does not wait for cleanup', async () => {
    const { transport, calls } = vmTransport();
    const originalSend = transport.send;
    transport.send = async (method, params) => {
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('return { status:')) {
        return new Promise(() => {});
      }
      return originalSend(method, params);
    };
    const started = Date.now();
    const evalInApp = createAppEvaluator(transport, lifecycle());

    await expect(evalInApp('Promise.resolve(1)', { awaitPromise: true, timeout: 40 }))
      .rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(500);
    expect(calls).toHaveLength(4); // setup, source, stalled poll, and bounded cleanup
  });

  test('bounds reconnect recovery after a dropped mailbox read', async () => {
    const { transport, calls } = vmTransport();
    const originalSend = transport.send;
    transport.send = async (method, params) => {
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('return { status:')) {
        throw new Error('WebSocket closed');
      }
      return originalSend(method, params);
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
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('clearTimeout(state.timer)')) {
        return new Promise(() => {});
      }
      return originalSend(method, params);
    };
    const started = Date.now();
    const evalInApp = createAppEvaluator(transport, lifecycle());

    await expect(evalInApp('Promise.resolve(1)', { awaitPromise: true, timeout: 40 }))
      .resolves.toBe(1);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('does not delay a settled remote result for bounded group cleanup', async () => {
    const { transport, calls } = vmTransport();
    const originalSend = transport.send;
    let groupReleaseStarted = false;
    transport.send = async (method, params, options) => {
      if (method === 'Runtime.releaseObjectGroup') {
        groupReleaseStarted = true;
        return new Promise(() => {});
      }
      return originalSend(method, params, options);
    };
    const evalInApp = createAppEvaluator(transport, lifecycle());
    const started = Date.now();

    await expect(evalInApp(
      'new Promise(resolve => setTimeout(() => resolve(42), 10));',
      { awaitPromise: true, timeout: 40 },
    )).resolves.toBe(42);
    expect(Date.now() - started).toBeLessThan(100);
    expect(groupReleaseStarted).toBe(true);
    expect(calls.some((call) => call.method === 'Runtime.releaseObject')).toBe(false);
  });
});
