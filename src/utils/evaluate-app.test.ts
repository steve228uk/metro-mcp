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
          const isPromise = Object.prototype.toString.call(result) === '[object Promise]';
          return {
            result: {
              type: 'object',
              subtype: isPromise ? 'promise' : undefined,
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
    expect(calls).toHaveLength(0); // no cleanup request remains within the deadline
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

  test('retries an exact pre-dispatch disconnect without replaying a raw script', async () => {
    const { transport, calls } = vmTransport();
    const originalSend = transport.send;
    let first = true;
    let sourceAttempts = 0;
    transport.send = async (method, params) => {
      if (first && method === 'Runtime.evaluate' &&
          String(params?.expression).includes('executionCount')) {
        first = false;
        sourceAttempts += 1;
        throw new Error('Not connected to CDP target');
      }
      if (method === 'Runtime.evaluate' &&
          String(params?.expression).includes('executionCount')) sourceAttempts += 1;
      return originalSend(method, params);
    };
    const state = lifecycle();
    const evalInApp = createAppEvaluator(transport, state);

    await expect(evalInApp(
      'globalThis.executionCount = (globalThis.executionCount || 0) + 1; executionCount;',
      { awaitPromise: false },
    )).resolves.toBe(1);
    expect(transport.context).toHaveProperty('executionCount', 1);
    expect(sourceAttempts).toBe(2);
    expect(calls.filter((call) => call.method === 'Runtime.evaluate' &&
      String(call.params.expression).includes('executionCount'))).toHaveLength(1);
    expect(state.state().reconnectCount).toBe(1);
  });

  test('retries the server-level disconnected error before raw source dispatch', async () => {
    const { transport, calls } = vmTransport();
    let ensureAttempts = 0;
    const state = lifecycle({
      ensureConnected: async () => {
        ensureAttempts += 1;
        if (ensureAttempts === 1) {
          throw new Error('Not connected to Metro. Use list_devices to check connection status.');
        }
      },
    });
    const evalInApp = createAppEvaluator(transport, state);

    await expect(evalInApp(
      'globalThis.serverLevelRetryCount = (globalThis.serverLevelRetryCount || 0) + 1; serverLevelRetryCount;',
      { awaitPromise: false, timeout: 1000 },
    )).resolves.toBe(1);
    expect(ensureAttempts).toBe(2);
    expect(calls.filter((call) => call.method === 'Runtime.evaluate' &&
      String(call.params.expression).includes('serverLevelRetryCount'))).toHaveLength(1);
  });

  test('does not retry a dispatched mutation that reports the server guidance string', async () => {
    const { transport, calls } = vmTransport();
    const originalSend = transport.send;
    const cdp = {
      send: async (method: string, params?: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> => {
        const result = await originalSend(method, params, options);
        if (method === 'Runtime.evaluate' && String(params?.expression).includes('__dispatchedServerError')) {
          return {
            exceptionDetails: {
              text: 'Not connected to Metro. Use list_devices to check connection status.',
            },
          };
        }
        return result;
      },
    };
    const state = lifecycle();
    const evalInApp = createAppEvaluator(cdp, state);

    await expect(evalInApp(
      'globalThis.__dispatchedServerError = (globalThis.__dispatchedServerError || 0) + 1; __dispatchedServerError;',
      { awaitPromise: false, timeout: 1000 },
    )).rejects.toThrow('Not connected to Metro. Use list_devices to check connection status.');
    expect(transport.context).toHaveProperty('__dispatchedServerError', 1);
    expect(state.state().reconnectCount).toBe(0);
    expect(calls.filter((call) => call.method === 'Runtime.evaluate' &&
      String(call.params.expression).includes('__dispatchedServerError'))).toHaveLength(1);
  });

  test('does not dispatch after server-level recovery reaches the deadline', async () => {
    const { transport, calls } = vmTransport();
    let ensureAttempts = 0;
    const evalInApp = createAppEvaluator(transport, lifecycle({
      ensureConnected: async () => {
        ensureAttempts += 1;
        throw new Error('Not connected to Metro. Use list_devices to check connection status.');
      },
      reconnect: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
      },
    }));

    await expect(evalInApp('globalThis.mustNotDispatch = true;', {
      awaitPromise: false,
      timeout: 10,
      deadline: Date.now() + 10,
    })).rejects.toThrow('timed out');
    expect(ensureAttempts).toBe(1);
    expect(calls).toHaveLength(0);
  });

  test('does not retry a duration-bearing evaluation timeout after dispatch', async () => {
    const { transport, calls } = vmTransport();
    const originalSend = transport.send;
    transport.send = async (method, params) => {
      const result = await originalSend(method, params);
      if (method === 'Runtime.evaluate' &&
          String(params?.expression).includes('executionCount')) {
        throw new Error('App evaluation timed out after 30ms');
      }
      return result;
    };
    const state = lifecycle();
    const evalInApp = createAppEvaluator(transport, state);

    await expect(evalInApp(
      'globalThis.executionCount = (globalThis.executionCount || 0) + 1; executionCount;',
      { awaitPromise: false },
    )).rejects.toThrow('App evaluation timed out after 30ms');
    expect(transport.context).toHaveProperty('executionCount', 1);
    expect(state.state().reconnectCount).toBe(0);
    expect(calls.filter((call) => call.method === 'Runtime.evaluate' &&
      String(call.params.expression).includes('executionCount'))).toHaveLength(1);
  });

  test('does not retry an app exception that uses the Bridge disconnect message', async () => {
    const { transport, calls } = vmTransport();
    const cdp = {
      send: async (method: string, params?: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> => {
        const result = await transport.send(method, params, options);
        if (method === 'Runtime.evaluate' &&
            String(params?.expression).includes('__appExceptionMarker')) {
          return { exceptionDetails: { text: 'Not connected to CDP target' } };
        }
        return result;
      },
    };
    const state = lifecycle();
    const evalInApp = createAppEvaluator(cdp, state);

    await expect(evalInApp(
      `globalThis.executionCount = (globalThis.executionCount || 0) + 1;
       globalThis.__appExceptionMarker = true;
       Promise.resolve(executionCount);`,
      { awaitPromise: true, timeout: 1000 },
    )).rejects.toThrow('Not connected to CDP target');
    expect(transport.context).toHaveProperty('executionCount', 1);
    expect(state.state().reconnectCount).toBe(0);
    expect(calls.filter((call) => call.method === 'Runtime.evaluate' &&
      String(call.params.expression).includes('__appExceptionMarker'))).toHaveLength(1);
  });

  test('observes an immediately rejected Promise during source evaluation', async () => {
    const { transport, calls } = vmTransport();
    const evalInApp = createAppEvaluator(transport, lifecycle());

    await expect(evalInApp(
      'Promise.reject(new Error("immediate rejection"));',
      { awaitPromise: true, timeout: 1000 },
    )).rejects.toThrow('immediate rejection');

    const sourceCall = calls.find((call) =>
      call.method === 'Runtime.evaluate' &&
      String(call.params.expression).includes('immediate rejection'));
    expect(sourceCall?.params.awaitPromise).toBe(false);
    expect(String(sourceCall?.params.expression)).toContain('state.observe(value)');
    expect(calls.filter((call) =>
      call.method === 'Runtime.evaluate' &&
      String(call.params.expression).includes('immediate rejection'))).toHaveLength(1);

    await expect(evalInApp(
      'Promise.reject(new Error("line comment rejection")); // trailing comment',
      { awaitPromise: true, timeout: 1000 },
    )).rejects.toThrow('line comment rejection');
    await expect(evalInApp(
      'Promise.reject(new Error("block comment rejection")); /* trailing comment */',
      { awaitPromise: true, timeout: 1000 },
    )).rejects.toThrow('block comment rejection');
    await expect(evalInApp(
      'Promise.reject(new Error("repeated terminator rejection"));; /* trailing comment */',
      { awaitPromise: true, timeout: 1000 },
    )).rejects.toThrow('repeated terminator rejection');
    await expect(evalInApp(
      'Promise.reject(new Error("mixed terminator rejection")); /* c */ ; // d',
      { awaitPromise: true, timeout: 1000 },
    )).rejects.toThrow('mixed terminator rejection');
  });

  test('observes a rejected Promise before a delayed Runtime.evaluate response', async () => {
    const { transport } = vmTransport();
    const originalSend = transport.send;
    transport.send = async (method, params, options) => {
      const result = await originalSend(method, params, options);
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('delayed rejection')) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return result;
    };
    const evalInApp = createAppEvaluator(transport, lifecycle());
    let unhandledRejections = 0;
    const onUnhandledRejection = () => { unhandledRejections += 1; };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      await expect(evalInApp(
        'const delayedPromise = Promise.reject(new Error("delayed rejection")); delayedPromise;',
        { awaitPromise: true, timeout: 1000 },
      )).rejects.toThrow('delayed rejection');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandledRejections).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  test('observes only the final loop completion without touching discarded values', async () => {
    const { transport } = vmTransport();
    const evalInApp = createAppEvaluator(transport, lifecycle());
    await expect(evalInApp(
      `globalThis.observedThenables = [];
       globalThis.markedThenable = function(value, marker) {
         return { then: function(resolve) {
           globalThis.observedThenables.push(marker);
           resolve(value);
         }};
       };
       for (let index = 0; index < 2; index += 1) {
         if (index === 0) markedThenable('discarded loop value', 'discarded-loop');
         else markedThenable('final loop completion', 'final');
       }`,
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('final loop completion');
    expect(transport.context.observedThenables).toEqual(['final']);
    await expect(evalInApp(
      `markedThenable('discarded branch value', 'discarded-branch');
       if (false) markedThenable('untaken', 'untaken');`,
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('discarded branch value');
    await expect(evalInApp(
      `while (true) {
         markedThenable('discarded break value', 'discarded-break');
         if (true) break;
       }`,
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('discarded break value');
    expect(transport.context.observedThenables).toEqual([
      'final', 'discarded-branch', 'discarded-break',
    ]);
    await expect(evalInApp(
      'let index = 0; while (index < 2) { index += 1; if (index === 1) Promise.resolve("first"); }',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe(2);
    await expect(evalInApp(
      "let switchIndex = 0; while (switchIndex++ < 2) { switch (switchIndex) { case 1: Promise.resolve('kept'); break; default: continue; } }",
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('kept');
    await expect(evalInApp(
      "let mixedIndex = 0; while (mixedIndex++ < 2) { if (mixedIndex === 1) Promise.resolve('first'); if (false) Promise.resolve('never'); continue; }",
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('first');
    await expect(evalInApp(
      "let continueIndex = 0; while (continueIndex++ < 2) { Promise.resolve('kept'); continue; }",
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('kept');
  });

  test('uses the intrinsic global when the source shadows globalThis', async () => {
    const { transport } = vmTransport();
    const evalInApp = createAppEvaluator(transport, lifecycle());
    await expect(evalInApp(
      'let globalThis = { shadowed: true }; Promise.resolve(7);',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe(7);

    const byValue = vmTransport();
    const evaluateByValue = createAppEvaluator(byValue.transport, lifecycle());
    await expect(evaluateByValue('let globalThis = null; 42;', {
      awaitPromise: true,
      timeout: 1000,
    })).resolves.toBe(42);
  });

  test('preserves directive prologues while observing the final completion', async () => {
    const { transport, calls } = vmTransport();
    const evalInApp = createAppEvaluator(transport, lifecycle());
    await expect(evalInApp('"use strict"; Promise.resolve(8);', {
      awaitPromise: true,
      timeout: 1000,
    })).resolves.toBe(8);
    const sourceCall = calls.find((call) =>
      call.method === 'Runtime.evaluate' &&
      String(call.params.expression).includes('"use strict"'));
    expect(String(sourceCall?.params.expression).startsWith('"use strict";')).toBe(true);
    await expect(evalInApp('"use strict"; if (false) Promise.resolve(9)', {
      awaitPromise: true,
      timeout: 1000,
    })).resolves.toBeUndefined();
    await expect(evalInApp('"use strict"; while (false) Promise.resolve(9)', {
      awaitPromise: true,
      timeout: 1000,
    })).resolves.toBeUndefined();
    await expect(evalInApp('Promise.resolve(9) // trailing line comment', {
      awaitPromise: true,
      timeout: 1000,
    })).resolves.toBe(9);
    await expect(evalInApp('#! /usr/bin/env node\nPromise.resolve(10)', {
      awaitPromise: true,
      timeout: 1000,
    })).resolves.toBe(10);
  });

  test('observes completion Promises through control-flow statements before a delayed response', async () => {
    const sources = [
      '{ Promise.reject(new Error("block completion rejection")); }',
      'if (true) Promise.reject(new Error("if completion rejection"));',
      'if (false) {} else Promise.reject(new Error("else completion rejection"));',
      'try { Promise.reject(new Error("try completion rejection")); } finally {}',
      'try { Promise.resolve(1); } finally { Promise.reject(new Error("try/finally completion rejection")); }',
      'switch (1) { case 1: Promise.resolve(1); case 2: Promise.reject(new Error("switch completion rejection")); break; }',
    ];
    let unhandledRejections = 0;
    const onUnhandledRejection = () => { unhandledRejections += 1; };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      for (const source of sources) {
        const { transport } = vmTransport();
        const originalSend = transport.send;
        transport.send = async (method, params, options) => {
          const result = await originalSend(method, params, options);
          if (method === 'Runtime.evaluate' && String(params?.expression).includes('completion rejection')) {
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
          return result;
        };
        const evalInApp = createAppEvaluator(transport, lifecycle());
        try {
          await expect(evalInApp(source, { awaitPromise: true, timeout: 1000 }))
            .rejects.toThrow('completion rejection');
        } catch (error) {
          throw new Error(`${source}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandledRejections).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  test('retains prior values through empty catch and finally statements', async () => {
    for (const source of [
      "Promise.resolve('discarded'); try {} finally {}",
      "Promise.resolve('discarded'); try {} catch {}",
      "Promise.resolve('discarded'); try {} catch (error) {} finally {}",
    ]) {
      const { cdp, calls } = cdpHarness({ result: { value: undefined } });
      await evaluateAppScriptCompletion(cdp, source, {
        observePromiseRejection: true,
        completionKey: 'empty-completion',
      });
      expect(calls[0]?.params?.expression).not.toBe(source);
      expect(String(calls[0]?.params?.expression)).toContain('Promise.resolve');
    }
  });

  test('retains labeled break paths through finalizers and nested switches', async () => {
    const sources = [
      'const flag = true; L: { try { throw 1; } finally { if (flag) break L; } } Promise.reject(new Error("outer labeled completion rejection"));',
    ];
    let unhandledRejections = 0;
    const onUnhandledRejection = () => { unhandledRejections += 1; };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const first = vmTransport();
      const firstSend = first.transport.send;
      first.transport.send = async (method, params, options) => {
        const result = await firstSend(method, params, options);
        if (method === 'Runtime.evaluate' && String(params?.expression).includes('outer labeled completion rejection')) {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        return result;
      };
      await expect(createAppEvaluator(first.transport, lifecycle())(sources[0]!, {
        awaitPromise: true,
        timeout: 1000,
      })).rejects.toThrow('outer labeled completion rejection');

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandledRejections).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  test('matches Hermes completion inheritance across control-flow paths', async () => {
    const evaluate = (source: string) => createAppEvaluator(vmTransport().transport, lifecycle())(
      source,
      { awaitPromise: true, timeout: 1000 },
    );

    await expect(evaluate('Promise.resolve("discarded"); if (false) 2')).resolves.toBe('discarded');
    await expect(evaluate('while (false) Promise.resolve("discarded")')).resolves.toBeUndefined();
    await expect(evaluate('for (let i = 0; i < 0; i += 1) Promise.resolve("discarded")'))
      .resolves.toBeUndefined();
    await expect(evaluate('while (true) { Promise.resolve("direct"); break; }'))
      .resolves.toBe('direct');
    await expect(evaluate('while (true) { Promise.resolve("conditional"); if (true) break; }'))
      .resolves.toBe('conditional');
    await expect(evaluate(
      'let i = 0; while (i < 2) { i += 1; if (i === 1) { Promise.resolve("discarded"); continue; } Promise.resolve("final"); }',
    )).resolves.toBe('final');
    await expect(evaluate('switch (1) { case 1: Promise.resolve("direct"); break; }'))
      .resolves.toBe('direct');
    await expect(evaluate('switch (1) { case 1: Promise.resolve("conditional"); if (true) break; }'))
      .resolves.toBe('conditional');
    await expect(evaluate(
      'let continueIndex = 0; while (continueIndex++ < 1) { Promise.resolve("conditional continue"); if (true) continue; }',
    )).resolves.toBe('conditional continue');
    await expect(evaluate(
      'let outerIndex = 0; outer: while (outerIndex++ < 2) { if (outerIndex === 1) Promise.resolve("nested value"); else for (let inner = 0; inner < 0; inner += 1) {} }',
    )).resolves.toBe('nested value');
    await expect(evaluate(
      'let emptyIndex = 0; while (emptyIndex++ < 2) { if (emptyIndex === 1) Promise.resolve("empty iteration"); else {} }',
    )).resolves.toBe('empty iteration');
    await expect(evaluate(
      'L: { Promise.resolve("label break"); if (true) break L; Promise.resolve("unreachable"); }',
    )).resolves.toBe('label break');
    await expect(evaluate(
      'L: { Promise.resolve("try break"); try {} finally { if (true) break L; } }',
    )).resolves.toBe('try break');
    await expect(evaluate(
      'L: { Promise.resolve("try catch break"); try { throw new Error("stop"); } catch { if (true) break L; } }',
    )).resolves.toBe('try catch break');
    await expect(evaluate(
      'L: switch (1) { case 1: Promise.resolve("switch label"); if (true) break L; }',
    )).resolves.toBe('switch label');
    await expect(evaluate(
      'L: switch (1) { case 1: try { Promise.resolve("switch finally"); } finally { if (true) break L; } }',
    )).resolves.toBe('switch finally');
    await expect(evaluate(
      'let loopIndex = 0; while (loopIndex++ < 1) { Promise.resolve("loop abrupt"); if (true) break; }',
    )).resolves.toBe('loop abrupt');
    await expect(evaluate(
      'while (true) { if (true) break; Promise.resolve("unreachable after break"); }',
    )).resolves.toBeUndefined();
    await expect(evaluate(
      'let i = 0; while (i < 1) { i += 1; if (true) continue; Promise.resolve("unreachable after continue"); }',
    )).resolves.toBe(1);
    await expect(evaluate('1; L: { 2; if (false) break L; {} }'))
      .resolves.toBe(2);
  });

  test('returns normal finally values as direct Hermes evaluation does', async () => {
    for (const source of [
      'try { 1; } finally { 2; }',
      'L: try { 1; } finally { 2; if (false) break L; }',
      'try { Promise.resolve(1); } finally { Promise.resolve(2); }',
      'L: try { Promise.resolve(1); } finally { Promise.resolve(2); if (false) break L; }',
      'L: { try { Promise.resolve(1); break L; } finally { Promise.resolve(2); } }',
    ]) {
      const evaluate = createAppEvaluator(vmTransport().transport, lifecycle());
      await expect(evaluate(source, { awaitPromise: true, timeout: 1000 })).resolves.toBe(2);
    }
  });

  test('does not observe a guarded thenable replaced by a normal finalizer', async () => {
    const evaluate = createAppEvaluator(vmTransport().transport, lifecycle());
    await expect(evaluate(
      'this.finallyThenCalls = 0; try { ({ then(resolve) { finallyThenCalls += 1; resolve(1); } }); } finally { Promise.resolve(2); }',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe(2);
    await expect(evaluate('finallyThenCalls', { awaitPromise: true, timeout: 1000 })).resolves.toBe(0);
  });

  test('preserves the last reached Hermes value through normal and abrupt finalizers', async () => {
    const taken = createAppEvaluator(vmTransport().transport, lifecycle());
    await expect(taken(
      'globalThis.flag = true; L: try { Promise.resolve("guarded"); } finally { if (flag) break L; }',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('guarded');

    const skipped = createAppEvaluator(vmTransport().transport, lifecycle());
    await expect(skipped(
      'globalThis.flag = false; L: try { Promise.resolve("guarded"); } finally { if (flag) break L; }',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('guarded');

    const continued = createAppEvaluator(vmTransport().transport, lifecycle());
    await expect(continued(
      'let i = 0; outer: while (i < 1) { i += 1; try { Promise.resolve("guarded"); } finally { if (i === 1) continue outer; } }',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('guarded');

    const skippedAfterValue = createAppEvaluator(vmTransport().transport, lifecycle());
    await expect(skippedAfterValue(
      'globalThis.flag = false; L: try { Promise.resolve("guarded"); } finally { Promise.resolve("discarded finalizer"); if (flag) break L; }',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('discarded finalizer');

    const takenAfterValue = createAppEvaluator(vmTransport().transport, lifecycle());
    await expect(takenAfterValue(
      'globalThis.flag = true; L: try { Promise.resolve("guarded"); } finally { Promise.resolve("finalizer exit"); if (flag) break L; }',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('finalizer exit');

    const skippedContinueAfterValue = createAppEvaluator(vmTransport().transport, lifecycle());
    await expect(skippedContinueAfterValue(
      'let i = 0; outer: while (i < 1) { i += 1; try { Promise.resolve("guarded"); } finally { Promise.resolve("discarded finalizer"); if (i > 1) continue outer; } }',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('discarded finalizer');

    const nested = createAppEvaluator(vmTransport().transport, lifecycle());
    await expect(nested(
      'L: try { Promise.resolve("guarded"); } finally { try { Promise.resolve("discarded outer finalizer"); } finally { Promise.resolve("discarded inner finalizer"); if (false) break L; } }',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('discarded inner finalizer');

    const directive = createAppEvaluator(vmTransport().transport, lifecycle());
    await expect(directive(
      'L: try { Promise.resolve("guarded"); } finally { "use strict"; Promise.resolve("discarded finalizer"); if (false) break L; }',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('discarded finalizer');

    const nestedFinallyExit = createAppEvaluator(vmTransport().transport, lifecycle());
    await expect(nestedFinallyExit(
      'L: try { Promise.resolve("outer"); } finally { try { Promise.resolve("inner"); } finally { break L; } }',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('inner');

    const nestedConditionalFinallyExit = createAppEvaluator(vmTransport().transport, lifecycle());
    await expect(nestedConditionalFinallyExit(
      'globalThis.flag = false; L: try { Promise.resolve("outer"); } finally { try { Promise.resolve("inner"); } finally { if (flag) break L; } }',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('inner');

    const nestedFinallyContinue = createAppEvaluator(vmTransport().transport, lifecycle());
    await expect(nestedFinallyContinue(
      'let i = 0; L: while (i < 1) { i += 1; try { Promise.resolve("outer"); } finally { try { Promise.resolve("inner"); } finally { continue L; } } }',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('inner');

    const conditionalGuardedBreak = createAppEvaluator(vmTransport().transport, lifecycle());
    await expect(conditionalGuardedBreak(
      'globalThis.flag = true; L: { Promise.resolve("before"); try { if (flag) Promise.resolve("guarded"); else {} } finally { break L; } }',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('guarded');

    const emptyGuardedBreak = createAppEvaluator(vmTransport().transport, lifecycle());
    await expect(emptyGuardedBreak(
      'globalThis.flag = false; L: { Promise.resolve("before"); try { if (flag) Promise.resolve("guarded"); else {} } finally { break L; } }',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('before');

    const conditionalGuardedContinue = createAppEvaluator(vmTransport().transport, lifecycle());
    await expect(conditionalGuardedContinue(
      'globalThis.flag = true; let i = 0; L: while (i < 1) { i += 1; Promise.resolve("before"); try { if (flag) Promise.resolve("guarded"); else {} } finally { continue L; } }',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('guarded');

    const emptyGuardedContinue = createAppEvaluator(vmTransport().transport, lifecycle());
    await expect(emptyGuardedContinue(
      'globalThis.flag = false; let i = 0; L: while (i < 1) { i += 1; Promise.resolve("before"); try { if (flag) Promise.resolve("guarded"); else {} } finally { continue L; } }',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('before');

    const retainsFinalizerCompletionWhenCaught = createAppEvaluator(vmTransport().transport, lifecycle());
    await expect(retainsFinalizerCompletionWhenCaught(
      'globalThis.flag = false; L: { Promise.resolve("before"); try { try {} finally { Promise.resolve("leak"); if (flag) break L; throw 0; } } catch {} }',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('leak');

    const inheritsGuardedCompletionThroughReplacedExit = createAppEvaluator(vmTransport().transport, lifecycle());
    await expect(inheritsGuardedCompletionThroughReplacedExit(
      'if (true) { A: { B: try { Promise.resolve("guarded"); break A; } finally { break B; } } } else Promise.resolve("other")',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('guarded');
  });

  test('observes a completion expression before trailing declarations', async () => {
    const { transport, calls } = vmTransport();
    const evalInApp = createAppEvaluator(transport, lifecycle());

    await expect(evalInApp(
      'const trailingPromise = Promise.reject(new Error("trailing declaration rejection")); trailingPromise; var afterCompletion = true;',
      { awaitPromise: true, timeout: 1000 },
    )).rejects.toThrow('trailing declaration rejection');
    const sourceCall = calls.find((call) =>
      call.method === 'Runtime.evaluate' &&
      String(call.params.expression).includes('trailing declaration rejection'));
    expect(String(sourceCall?.params.expression)).toContain('state.observe(value)');
  });

  test('does not invoke a native Promise subclass then override during observation', async () => {
    const { transport } = vmTransport();
    const evalInApp = createAppEvaluator(transport, lifecycle());

    await expect(evalInApp(
      `(() => {
        class TrackedPromise extends Promise {
          then(...args) {
            globalThis.thenOverrideCalls = (globalThis.thenOverrideCalls || 0) + 1;
            return super.then(...args);
          }
        }
        globalThis.thenOverrideCalls = 0;
        return new TrackedPromise(resolve => resolve(7));
      })()`,
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe(7);
    // The wrapper uses the intrinsic method; only SETTLE_REMOTE's single
    // assimilation invokes the subclass override.
    expect(transport.context).toHaveProperty('thenOverrideCalls', 1);
  });

  test('settles a Promise after the source clears the global Promise constructor', async () => {
    const { transport } = vmTransport();
    const evalInApp = createAppEvaluator(transport, lifecycle());
    await expect(evalInApp(
      `const value = Promise.resolve(11);
       globalThis.Promise = null;
       value;`,
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe(11);
  });

  test('settles a Promise after the source patches its Promise prototype', async () => {
    const { transport } = vmTransport();
    const evalInApp = createAppEvaluator(transport, lifecycle());
    await expect(evalInApp(
      `const value = Promise.resolve(12);
       Promise.prototype.then = function() { throw new Error('patched then'); };
       value;`,
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe(12);
  });

  test('settles through the realm after an earlier evaluation poisons Promise.then', async () => {
    const { transport } = vmTransport();
    const evalInApp = createAppEvaluator(transport, lifecycle());
    await expect(evalInApp(
      'Promise.prototype.then = function() { throw new Error("poisoned then"); }; 0;',
      { awaitPromise: false, timeout: 1000 },
    )).resolves.toBe(0);
    await expect(evalInApp(
      'Promise.resolve(42);',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe(42);
    await expect(evalInApp(
      'Promise.reject(new Error("poisoned rejection"));',
      { awaitPromise: true, timeout: 1000 },
    )).rejects.toThrow('poisoned rejection');
  });

  test('keeps the awaited mailbox hidden and read-only with normal intrinsics', async () => {
    const { transport } = vmTransport();
    const evalInApp = createAppEvaluator(transport, lifecycle());
    await expect(evalInApp(`(function() {
      var prefix = '__METRO_MCP_ASYNC_';
      var key = Object.getOwnPropertyNames(this).find(name => name.startsWith(prefix));
      var descriptor = Object.getOwnPropertyDescriptor(this, key);
      var iterated = [];
      for (var name in this) if (name.startsWith(prefix)) iterated.push(name);
      return {
        enumerable: descriptor.enumerable,
        writable: descriptor.writable,
        configurable: descriptor.configurable,
        keys: Object.keys(this).filter(name => name.startsWith(prefix)),
        iterated: iterated
      };
    })()`, { awaitPromise: true, timeout: 1000 })).resolves.toEqual({
      enumerable: false, writable: false, configurable: true, keys: [], iterated: [],
    });
  });

  test('creates a mailbox after an earlier evaluation mutates Object globals', async () => {
    for (const mutation of [
      'Object.defineProperty = null; 0;',
      'Object = null; 0;',
      'Object.defineProperty = function() {}; 0;',
    ]) {
      const { transport } = vmTransport();
      const evalInApp = createAppEvaluator(transport, lifecycle());
      await expect(evalInApp(mutation, { awaitPromise: true, timeout: 1000 }))
        .resolves.toBe(0);
      await expect(evalInApp(
        'Promise.resolve(13);',
        { awaitPromise: true, timeout: 1000 },
      )).resolves.toBe(13);
      await expect(evalInApp(`(function() {
        var root = this;
        var keys = Reflect.ownKeys(root).filter(name => typeof name === 'string' && name.startsWith('__METRO_MCP_ASYNC_'));
        return {
          found: keys.length > 0,
          hidden: keys.every(function(key) {
            var descriptor = Reflect.getOwnPropertyDescriptor(root, key);
            return descriptor.enumerable === false && descriptor.writable === false;
          })
        };
      })()`, { awaitPromise: true, timeout: 1000 })).resolves.toEqual({
        found: true, hidden: true,
      });
    }
  });

  test('keeps declaration-form scripts in the direct evaluation scope', async () => {
    const { transport } = vmTransport();
    const evalInApp = createAppEvaluator(transport, lifecycle());

    await expect(evalInApp('/* leading */ function /* interstitial */ persistedFunction() {}', {
      awaitPromise: true,
      timeout: 1000,
    })).resolves.toBeUndefined();
    await expect(evalInApp('/* leading */ class /* interstitial */ PersistedClass {}', {
      awaitPromise: true,
      timeout: 1000,
    })).resolves.toBeUndefined();
    await expect(evalInApp('typeof persistedFunction', {
      awaitPromise: false,
    })).resolves.toBe('function');
    await expect(evalInApp('typeof PersistedClass', {
      awaitPromise: false,
    })).resolves.toBe('function');
  });

  test('observes sequence and parenthesized Promise expressions', async () => {
    const { transport } = vmTransport();
    const evalInApp = createAppEvaluator(transport, lifecycle());

    await expect(evalInApp(
      '(Promise.resolve(1), Promise.resolve(2)); // sequence',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe(2);
    await expect(evalInApp(
      '((Promise.resolve(3))); /* parenthesized */',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe(3);
    await expect(evalInApp(
      'Promise.resolve("string // marker ;"); // trailing',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('string // marker ;');
    await expect(evalInApp(
      'Promise.resolve("no semicolon") // trailing without terminator',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('no semicolon');
    await expect(evalInApp(
      'Promise.resolve(`/template ; // marker`); /* trailing */',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe('/template ; // marker');
    await expect(evalInApp(
      'Promise.resolve(/[//;]/.test("//;")); /* trailing */',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe(true);
    await expect(evalInApp(
      'Promise.resolve(1); // first statement\n Promise.resolve(2)',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe(2);
  });

  test('preserves direct eval bindings when observing a Promise expression', async () => {
    const { transport } = vmTransport();
    const evalInApp = createAppEvaluator(transport, lifecycle());

    await expect(evalInApp(
      'eval("var persistedByDirectEval = 41"), Promise.resolve(1);',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe(1);
    await expect(evalInApp('persistedByDirectEval', {
      awaitPromise: false,
    })).resolves.toBe(41);
  });

  test('preserves top-level arguments errors while observing Promise expressions', async () => {
    const { transport } = vmTransport();
    const evalInApp = createAppEvaluator(transport, lifecycle());

    await expect(evalInApp(
      'Promise.resolve(arguments.length);',
      { awaitPromise: true, timeout: 1000 },
    )).rejects.toThrow('arguments is not defined');
  });

  test('preserves brace-leading direct script completion semantics', async () => {
    const { transport } = vmTransport();
    const evalInApp = createAppEvaluator(transport, lifecycle());

    await expect(evalInApp('{ foo: 1 }', {
      awaitPromise: true,
      timeout: 1000,
    })).resolves.toBe(1);
  });

  test('leaves Proxy thenables to the single later assimilation path', async () => {
    const { transport } = vmTransport();
    const evalInApp = createAppEvaluator(transport, lifecycle());

    await expect(evalInApp(
      `(() => {
        globalThis.proxyPrototypeChecks = 0;
        globalThis.proxyThenCalls = 0;
        return new Proxy({
        then(resolve) {
          globalThis.proxyThenCalls = (globalThis.proxyThenCalls || 0) + 1;
          resolve(9);
        }
      }, {
        getPrototypeOf() {
          globalThis.proxyPrototypeChecks = (globalThis.proxyPrototypeChecks || 0) + 1;
          throw new Error('proxy prototype trap');
        }
        });
      })()`,
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe(9);
    expect(transport.context).toMatchObject({
      proxyPrototypeChecks: 0,
      proxyThenCalls: 1,
    });
  });

  test('does not mistake a Unicode identifier prefix for a declaration', async () => {
    const { transport, calls } = vmTransport();
    const evalInApp = createAppEvaluator(transport, lifecycle());
    await expect(evalInApp('globalThis.functioné = Promise.resolve(6)', {
      awaitPromise: false,
    })).resolves.toBeDefined();
    await expect(evalInApp('functioné;', {
      awaitPromise: true,
      timeout: 1000,
    })).resolves.toBe(6);
    expect(calls.some((call) =>
      call.method === 'Runtime.evaluate' &&
      String(call.params.expression).includes('state.observe(value)'))).toBe(true);
  });

  test('keeps anonymous and async/generator declarations direct', async () => {
    const { transport, calls } = vmTransport();
    const evalInApp = createAppEvaluator(transport, lifecycle());
    const invalidDeclarations = [
      'function() {}',
      'class {}',
      'async function() {}',
      'function*() {}',
      'async function*() {}',
    ];

    for (const source of invalidDeclarations) {
      await expect(evalInApp(source, {
        awaitPromise: true,
        timeout: 1000,
      })).rejects.toThrow();
    }
    const sourceExpressions = calls
      .filter((call) => call.method === 'Runtime.evaluate')
      .map((call) => String(call.params.expression));
    for (const source of invalidDeclarations) {
      expect(sourceExpressions).toContain(source);
    }
  });

  test('does not retry a remote settlement app exception that uses the Bridge disconnect message', async () => {
    const { transport, calls } = vmTransport();
    const cdp = {
      send: async (method: string, params?: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> => {
        const result = await transport.send(method, params, options);
        if (method === 'Runtime.callFunctionOn') {
          return { exceptionDetails: { text: 'Not connected to CDP target' } };
        }
        return result;
      },
    };
    const state = lifecycle();
    const evalInApp = createAppEvaluator(cdp, state);

    await expect(evalInApp(
      'Promise.resolve(42)',
      { awaitPromise: true, timeout: 1000 },
    )).rejects.toThrow('Not connected to CDP target');
    expect(state.state().reconnectCount).toBe(0);
    expect(calls.filter((call) => call.method === 'Runtime.callFunctionOn')).toHaveLength(1);
  });

  test('honors an explicit absolute deadline across awaited stages', async () => {
    const { transport } = vmTransport();
    const evalInApp = createAppEvaluator(transport, lifecycle());
    const deadline = Date.now() + 40;
    const started = Date.now();

    await expect(evalInApp(
      'new Promise(() => {})',
      { awaitPromise: true, timeout: 1000, deadline },
    )).rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('keeps the requested timeout when an explicit deadline is later', async () => {
    const { transport } = vmTransport();
    const evalInApp = createAppEvaluator(transport, lifecycle());
    const deadline = Date.now() + 200;
    const started = Date.now();

    await expect(evalInApp(
      'new Promise(() => {})',
      { awaitPromise: true, timeout: 40, deadline },
    )).rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(150);
  });

  test('retries an exact pre-dispatch disconnect before awaited source execution', async () => {
    const { transport, calls } = vmTransport();
    const originalSend = transport.send;
    let sourceAttempts = 0;
    let setupAttempts = 0;
    let generation = 0;
    transport.send = async (method, params) => {
      if (method === 'Runtime.evaluate' &&
          String(params?.expression).includes("status: 'pending'")) {
        setupAttempts += 1;
      }
      if (method === 'Runtime.evaluate' &&
          String(params?.expression).includes('executionCount')) {
        sourceAttempts += 1;
        if (sourceAttempts === 1) throw new Error('Not connected to CDP target');
      }
      return originalSend(method, params);
    };
    const base = lifecycle({ reconnect: async () => { generation += 1; } });
    const state = { ...base, getGeneration: () => generation };
    const evalInApp = createAppEvaluator(transport, state);

    await expect(evalInApp(
      'globalThis.executionCount = (globalThis.executionCount || 0) + 1; Promise.resolve(executionCount);',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe(1);
    expect(sourceAttempts).toBe(2);
    expect(setupAttempts).toBe(2);
    expect(generation).toBe(1);
    expect(transport.context).toHaveProperty('executionCount', 1);
    expect(calls.filter((call) => call.method === 'Runtime.evaluate' &&
      String(call.params.expression).includes('executionCount'))).toHaveLength(1);
  });

  test('retries mailbox setup after transport loss before source dispatch', async () => {
    const { transport, calls } = vmTransport();
    const originalSend = transport.send;
    let setupAttempts = 0;
    transport.send = async (method, params) => {
      if (method === 'Runtime.evaluate' &&
          String(params?.expression).includes("status: 'pending'")) {
        setupAttempts += 1;
        if (setupAttempts === 1) throw new Error('WebSocket closed');
      }
      return originalSend(method, params);
    };
    const state = lifecycle();
    const evalInApp = createAppEvaluator(transport, state);

    await expect(evalInApp(
      'globalThis.executionCount = (globalThis.executionCount || 0) + 1; Promise.resolve(executionCount);',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe(1);
    expect(setupAttempts).toBe(2);
    expect(transport.context).toHaveProperty('executionCount', 1);
    expect(state.state().reconnectCount).toBe(1);
    expect(calls.filter((call) => call.method === 'Runtime.evaluate' &&
      String(call.params.expression).includes('executionCount'))).toHaveLength(1);
  });

  test('settles hostile Promise rejection reasons instead of timing out', async () => {
    const { transport } = vmTransport();
    const evalInApp = createAppEvaluator(transport, lifecycle());

    await expect(evalInApp(
      'Promise.reject(Object.create(null))',
      { awaitPromise: true, timeout: 1000 },
    )).rejects.toThrow('unstringifiable reason');
    await expect(evalInApp(
      'Promise.reject({ get message() { throw new Error("message unavailable"); } })',
      { awaitPromise: true, timeout: 1000 },
    )).rejects.toThrow('[object Object]');
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

  test('survives a lost redundant settlement response without replaying the source', async () => {
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
    )).resolves.toBe(1);
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

  test('polls the mailbox when the runtime generation changes after source dispatch', async () => {
    const { transport, calls } = vmTransport();
    let generation = 1;
    const originalSend = transport.send;
    transport.send = async (method, params, options) => {
      const result = await originalSend(method, params, options);
      if (method === 'Runtime.evaluate' &&
          String(params?.expression).includes('generationAfterSource')) {
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
      'globalThis.generationAfterSourceExecutions = (globalThis.generationAfterSourceExecutions || 0) + 1; globalThis.generationAfterSource = new Promise(resolve => setTimeout(() => resolve(7), 10)); generationAfterSource;',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe(7);
    expect(transport.context).toHaveProperty('generationAfterSourceExecutions', 1);
    expect(calls.filter((call) => call.method === 'Runtime.callFunctionOn')).toHaveLength(0);
    expect(calls.filter((call) => call.method === 'Runtime.evaluate' &&
      String(call.params.expression).includes('generationAfterSource'))).toHaveLength(1);
  });

  test('polls the mailbox after a stale completion handle error', async () => {
    const { transport, calls } = vmTransport();
    const originalSend = transport.send;
    let settlementAttempts = 0;
    transport.send = async (method, params, options) => {
      if (method === 'Runtime.callFunctionOn') {
        settlementAttempts += 1;
        await originalSend(method, params, options);
        throw new Error('Could not find object with given id');
      }
      return originalSend(method, params, options);
    };
    const evalInApp = createAppEvaluator(transport, lifecycle());

    await expect(evalInApp(
      'globalThis.staleSettlementExecutions = (globalThis.staleSettlementExecutions || 0) + 1; new Promise(resolve => setTimeout(() => resolve(8), 10));',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe(8);
    expect(transport.context).toHaveProperty('staleSettlementExecutions', 1);
    expect(settlementAttempts).toBe(1);
    expect(calls.filter((call) => call.method === 'Runtime.callFunctionOn')).toHaveLength(1);
  });

  test('recreates the mailbox when generation changes after mailbox setup', async () => {
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
    )).resolves.toBe(1);
    expect(transport.context).toHaveProperty('sourceMutation', true);
    expect(calls.filter((call) => call.method === 'Runtime.evaluate' &&
      String(call.params.expression).includes('sourceMutation'))).toHaveLength(1);
  });

  test('rejects a generation change immediately after mailbox setup response', async () => {
    const { transport, calls } = vmTransport();
    let generation = 0;
    const originalSend = transport.send;
    transport.send = async (method, params) => {
      const result = await originalSend(method, params);
      if (method === 'Runtime.evaluate' &&
          String(params?.expression).includes("status: 'pending'")) {
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

  test('recreates the mailbox after server-level recovery changes the runtime generation', async () => {
    const { transport, calls } = vmTransport();
    let generation = 1;
    let ensureAttempts = 0;
    let mailboxSetups = 0;
    const originalSend = transport.send;
    transport.send = async (method, params) => {
      if (method === 'Runtime.evaluate' &&
          String(params?.expression).includes("status: 'pending'")) {
        mailboxSetups += 1;
      }
      return originalSend(method, params);
    };
    const base = lifecycle({
      ensureConnected: async () => {
        ensureAttempts += 1;
        if (ensureAttempts === 2) {
          throw new Error('Not connected to Metro. Use list_devices to check connection status.');
        }
      },
      reconnect: async () => { generation = 2; },
    });
    const evalInApp = createAppEvaluator(transport, {
      ...base,
      getGeneration: () => generation,
    });

    await expect(evalInApp(
      'globalThis.generationRecoverySource = (globalThis.generationRecoverySource || 0) + 1; Promise.resolve(generationRecoverySource);',
      { awaitPromise: true, timeout: 1000 },
    )).resolves.toBe(1);
    expect(generation).toBe(2);
    expect(mailboxSetups).toBe(2);
    expect(calls.filter((call) => call.method === 'Runtime.evaluate' &&
      String(call.params.expression).includes('generationRecoverySource'))).toHaveLength(1);
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
    expect(calls).toHaveLength(1); // stalled setup; cleanup has no remaining budget
  });

  test('releases a late completion with a bounded post-deadline cleanup budget', async () => {
    let resolveSource: ((result: unknown) => void) | undefined;
    const calls: Array<{ method: string; options?: Record<string, unknown> }> = [];
    const transport = {
      send: async (method: string, params?: Record<string, unknown>, options?: Record<string, unknown>) => {
        calls.push({ method, options });
        if (method === 'Runtime.evaluate' &&
            String(params?.expression).includes("status: 'pending'")) {
          return { result: { value: true } };
        }
        if (method === 'Runtime.evaluate') {
          return new Promise((resolve) => { resolveSource = resolve; });
        }
        if (method === 'Runtime.releaseObjectGroup') return { result: { value: true } };
        return { result: { value: true } };
      },
    };
    const evalInApp = createAppEvaluator(transport, lifecycle());

    await expect(evalInApp('Promise.resolve(42)', { awaitPromise: true, timeout: 30 }))
      .rejects.toThrow('timed out');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const release = calls.find((call) => call.method === 'Runtime.releaseObjectGroup');
    expect(release?.options?.timeoutMs).toBe(250);

    // A late source result gets the same best-effort cleanup path and never
    // replays the source evaluation.
    resolveSource?.({ result: { type: 'object', objectId: 'late-promise' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.filter((call) => call.method === 'Runtime.evaluate')).toHaveLength(2);
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
    expect(calls).toHaveLength(4); // setup, source, stalled poll, and bounded group cleanup
  });

  test('does not reconnect after a mailbox poll rejects after the deadline', async () => {
    const { transport } = vmTransport();
    const originalSend = transport.send;
    let reconnects = 0;
    transport.send = async (method, params, options) => {
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('return { status:')) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        throw new Error('WebSocket closed');
      }
      return originalSend(method, params, options);
    };
    const evalInApp = createAppEvaluator(transport, lifecycle({
      reconnect: async () => { reconnects += 1; },
    }));

    await expect(evalInApp(
      'globalThis.executionCount = (globalThis.executionCount || 0) + 1; Promise.resolve(executionCount);',
      { awaitPromise: true, timeout: 30 },
    )).rejects.toThrow('timed out');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(transport.context).toHaveProperty('executionCount', 1);
    expect(reconnects).toBe(0);
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
    const deadline = Date.now() + 300;
    transport.send = async (method, params, options) => {
      if (method === 'Runtime.releaseObjectGroup') {
        groupReleaseStarted = true;
        const timeoutMs = Number(options?.timeoutMs);
        expect(timeoutMs).toBeLessThanOrEqual(100);
        expect(timeoutMs).toBeLessThanOrEqual(deadline - Date.now() + 2);
        return new Promise(() => {});
      }
      return originalSend(method, params, options);
    };
    const evalInApp = createAppEvaluator(transport, lifecycle());
    const started = Date.now();

    await expect(evalInApp(
      'new Promise(resolve => setTimeout(() => resolve(42), 70));',
      { awaitPromise: true, timeout: 1000, deadline },
    )).resolves.toBe(42);
    // Keep this separate from the cleanup budget: a stalled release must not
    // delay delivery of a result that already settled.
    expect(Date.now() - started).toBeLessThan(250);
    expect(groupReleaseStarted).toBe(true);
    expect(calls.some((call) => call.method === 'Runtime.releaseObject')).toBe(false);
  });
});
