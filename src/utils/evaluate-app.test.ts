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
    expect(String(sourceCall?.params.expression)).toContain('PromiseCtor.prototype.then.call');
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

  test('observes completion Promises through control-flow statements before a delayed response', async () => {
    const sources = [
      '{ Promise.reject(new Error("block completion rejection")); }',
      'if (true) Promise.reject(new Error("if completion rejection"));',
      'if (false) {} else Promise.reject(new Error("else completion rejection"));',
      'try { Promise.reject(new Error("try completion rejection")); } finally {}',
      'try { Promise.reject(new Error("try/finally completion rejection")); } finally { Promise.resolve(1); }',
      'switch (1) { case 1: Promise.resolve(1); case 2: Promise.reject(new Error("switch completion rejection")); break; }',
      'switch (1) { case 1: Promise.reject(new Error("conditional break completion rejection")); if (true) break; Promise.resolve(2); }',
      'for (let index = 0; index < 1; index += 1) { Promise.reject(new Error("conditional continue completion rejection")); if (true) continue; Promise.resolve(2); }',
      'const flag = true; L: for (let index = 0; index < 1; index += 1) { Promise.reject(new Error("labeled continue completion rejection")); if (flag) continue L; Promise.resolve(2); }',
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

  test('retains labeled break paths through finalizers and nested switches', async () => {
    const sources = [
      'const flag = true; L: { try { throw 1; } finally { if (flag) break L; } } Promise.reject(new Error("outer labeled completion rejection"));',
      'const flag = true; L: { switch (1) { case 1: Promise.reject(new Error("nested switch labeled break rejection")); if (flag) break L; Promise.resolve(2); } }',
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

      const second = vmTransport();
      const secondSend = second.transport.send;
      second.transport.send = async (method, params, options) => {
        const result = await secondSend(method, params, options);
        if (method === 'Runtime.evaluate' && String(params?.expression).includes('nested switch labeled break rejection')) {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        return result;
      };
      await expect(createAppEvaluator(second.transport, lifecycle())(sources[1]!, {
        awaitPromise: true,
        timeout: 1000,
      })).rejects.toThrow('nested switch labeled break rejection');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandledRejections).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
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
    expect(String(sourceCall?.params.expression)).toContain('PromiseCtor.prototype.then.call');
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
      String(call.params.expression).includes('observePromise'))).toBe(true);
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
          String(params?.expression).includes('Object.defineProperty(globalThis')) {
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
          String(params?.expression).includes('Object.defineProperty(globalThis')) {
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
    expect(calls).toHaveLength(1); // stalled setup; cleanup has no remaining budget
  });

  test('releases a late completion with a bounded post-deadline cleanup budget', async () => {
    let resolveSource: ((result: unknown) => void) | undefined;
    const calls: Array<{ method: string; options?: Record<string, unknown> }> = [];
    const transport = {
      send: async (method: string, params?: Record<string, unknown>, options?: Record<string, unknown>) => {
        calls.push({ method, options });
        if (method === 'Runtime.evaluate' &&
            String(params?.expression).includes('Object.defineProperty(globalThis')) {
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
