import { describe, expect, test } from 'bun:test';
import vm from 'node:vm';
import type { z } from 'zod';
import type { ComponentNode, EvalOptions, PluginContext, PluginDefinition } from '../plugin.js';
import { profilerPlugin } from './profiler.js';
import { testRecorderPlugin } from './test-recorder.js';

interface Tool {
  parameters: z.ZodType;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

type Runner = ((name: string, args?: Record<string, unknown>) => Promise<unknown>) & {
  resource: (uri: string) => Promise<string>;
};

function appWithDeepButton() {
  const app = vm.createContext({ setTimeout, clearTimeout });
  vm.runInContext(`
    var handlerCalls = 0;
    var leaf = {
      type: { displayName: 'Button' },
      memoizedProps: Object.freeze({
        testID: 'deep-button',
        onPress: function() { handlerCalls++; }
      }),
      stateNode: null,
      child: null,
      sibling: null,
      return: null
    };
    leaf.stateNode = {
      fiber: leaf,
      forceUpdate: function() {
        var next = {
          testID: 'deep-button',
          onPress: function() { handlerCalls++; }
        };
        this.fiber.pendingProps = next;
        var target = this.fiber;
        setTimeout(function() { target.memoizedProps = Object.freeze(target.pendingProps); }, 0);
      }
    };
    var current = leaf;
    for (var depth = 254; depth >= 0; depth--) {
      var parent = {
        type: { displayName: 'Provider' + depth },
        memoizedProps: Object.freeze({}),
        stateNode: null,
        child: current,
        sibling: null,
        return: null
      };
      current.return = parent;
      current = parent;
    }
    var root = current;
    var renderer = { overrideProps: function(fiber) {
      var next = {};
      var props = fiber.memoizedProps || {};
      for (var key in props) next[key] = props[key];
      fiber.pendingProps = next;
      var target = fiber;
      setTimeout(function() { target.memoizedProps = Object.freeze(target.pendingProps); }, 0);
    } };
    var hook = {
      getFiberRoots: function(id) { return id === 12 ? new Set([{ current: root }]) : new Set(); },
      renderers: new Map([[12, renderer]]),
      onCommitFiberRoot: function() {}
    };
    globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  `, app);
  return app;
}

function appWithNaturalScroll() {
  const app = appWithDeepButton();
  vm.runInContext(`
    var scrollRoot = __REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(12).values().next().value.current;
    scrollRoot.memoizedProps = Object.freeze({ scrollEnabled: true, testID: 'scroll-root' });
  `, app);
  return app;
}

function appWithMomentumOnlyScroll() {
  const app = appWithDeepButton();
  vm.runInContext(`
    var scrollRoot = __REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(12).values().next().value.current;
    scrollRoot.memoizedProps = Object.freeze({
      testID: 'momentum-only-scroll',
      onMomentumScrollEnd: function() {}
    });
  `, app);
  return app;
}

function appWithoutFiberRefresh() {
  const app = appWithDeepButton();
  vm.runInContext(`
    var originalRoot = __REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(12).values().next().value.current;
    originalRoot.stateNode = { forceUpdate: function() {} };
    var leafWithoutRefresh = originalRoot;
    while (leafWithoutRefresh.child) leafWithoutRefresh = leafWithoutRefresh.child;
    leafWithoutRefresh.stateNode = { forceUpdate: function() {} };
    hook.renderers.get(12).overrideProps = null;
  `, app);
  return app;
}

function appWithNoopAncestorAndTargetRefresh() {
  const app = appWithDeepButton();
  vm.runInContext(`
    var target = __REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(12).values().next().value.current;
    while (target.child) target = target.child;
    target.stateNode = null;
    var ancestor = target.return;
    while (ancestor && !ancestor.return) ancestor = ancestor.return;
    ancestor.stateNode = { forceUpdate: function() {} };
  `, app);
  return app;
}

function appWithoutFiberRoots() {
  const app = appWithDeepButton();
  vm.runInContext(`
    __REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = function() { return new Set(); };
  `, app);
  return app;
}

async function createHarness(
  app: Record<string, unknown>,
  plugins: PluginDefinition[],
  beforeEval?: (expression: string, options?: EvalOptions) => void,
): Promise<Runner> {
  const tools = new Map<string, Tool>();
  const resources = new Map<string, () => Promise<string>>();
  const ctx: PluginContext = {
    cdp: {
      on: () => {}, off: () => {}, isConnected: true, getTarget: () => null,
      send: async () => ({}),
    },
    events: { on: () => {}, off: () => {}, isConnected: () => true },
    registerTool: (name, config) => tools.set(name, {
      parameters: config.parameters,
      handler: config.handler as Tool['handler'],
    }),
    registerResource: (uri, config) => resources.set(uri, config.handler),
    registerAppResource: () => {}, registerPrompt: () => {},
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    metro: { host: 'localhost', port: 8081, fetch: async () => new Response() },
    exec: async () => '', execFile: async () => Buffer.alloc(0),
    format: {
      summarize: () => '', compact: (value: unknown) => JSON.stringify(value),
      truncate: (value: string) => value, structureOnly: (value: ComponentNode) => value,
    },
    evalInApp: async (expression, options) => {
      beforeEval?.(expression, options);
      const value = new vm.Script(expression).runInContext(app as vm.Context);
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    },
    getActiveDeviceKey: () => 'device', getActiveDeviceName: () => 'Device',
    notifyResourceUpdated: () => {},
  };
  for (const plugin of plugins) await plugin.setup(ctx);
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return tool.handler(tool.parameters.parse(args) as Record<string, unknown>);
  };
  run.resource = async (uri: string) => {
    const resource = resources.get(uri);
    if (!resource) throw new Error(`missing resource ${uri}`);
    return resource();
  };
  return run;
}

describe('test recorder readiness', () => {
  test('wraps frozen handlers in mounted inactive scenes before they become focused', async () => {
    const app = appWithDeepButton();
    vm.runInContext(`
      var navigationState = { index: 0, routes: [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }] };
      globalThis.__METRO_MCP_NAV_REF__ = { getRootState: function() { return navigationState; } };
      var inactiveLeaf = { type: 'Button', memoizedProps: Object.freeze({ testID: 'inactive-button', onPress: function() { handlerCalls++; } }) };
      var sceneB = { type: { name: 'SceneView' }, memoizedProps: { route: navigationState.routes[1] }, child: inactiveLeaf };
      var sceneA = { type: { name: 'SceneView' }, memoizedProps: { route: navigationState.routes[0] }, child: root, sibling: sceneB };
      var navRoot = { type: 'Navigator', memoizedProps: { state: navigationState }, child: sceneA };
      hook.getFiberRoots = function(id) { return id === 12 ? new Set([{ current: navRoot }]) : new Set(); };
    `, app);
    const call = await createHarness(app, [testRecorderPlugin]);
    expect(await call('start_test_recording')).toContain('Recording started');
    vm.runInContext('navigationState.index = 1; inactiveLeaf.memoizedProps.onPress()', app);
    expect(await call('stop_test_recording')).toContain('1 tap');
    expect(vm.runInContext('handlerCalls', app)).toBe(1);
  });

  test('removes inactive recorder and profiler predecessors after an interleaved restart', async () => {
    const app = appWithDeepButton();
    const originalHook = vm.runInContext('hook.onCommitFiberRoot', app);
    const call = await createHarness(app, [testRecorderPlugin, profilerPlugin]);
    await call('start_test_recording');
    await call('start_profiling');
    await call('start_test_recording');
    await call('stop_profiling');
    await call('stop_test_recording');
    expect(vm.runInContext('hook.onCommitFiberRoot', app)).toBe(originalHook);
  });

  test('bounds cyclic ancestor refresh searches and still instruments through the renderer', async () => {
    const app = appWithDeepButton();
    vm.runInContext('leaf.stateNode = null; leaf.return = leaf;', app);
    const call = await createHarness(app, [testRecorderPlugin]);
    expect(await call('start_test_recording')).toContain('Recording started');
    vm.runInContext('leaf.memoizedProps.onPress()', app);
    expect(await call('stop_test_recording')).toContain('1 tap');
  });

  test('restores instrumentation when the initial mounted-props scan throws', async () => {
    const app = appWithDeepButton();
    const originalFreeze = vm.runInContext('Object.freeze', app);
    const originalCommit = vm.runInContext('hook.onCommitFiberRoot', app);
    vm.runInContext(`Object.defineProperty(leaf, 'memoizedProps', { get: function() { throw new Error('props unavailable'); } })`, app);
    const call = await createHarness(app, [testRecorderPlugin]);
    expect(String(await call('start_test_recording'))).toContain('Could not inject recording hooks');
    expect(vm.runInContext('Object.freeze', app)).toBe(originalFreeze);
    expect(vm.runInContext('hook.onCommitFiberRoot', app)).toBe(originalCommit);
    expect(vm.runInContext('globalThis.__METRO_MCP_REC_STATE__', app)).toBeUndefined();
  });

  test('refreshes frozen props through depth 255 before enabling capture', async () => {
    const app = appWithDeepButton();
    const call = await createHarness(app, [testRecorderPlugin]);
    const started = await call('start_test_recording');
    expect(String(started)).toContain('Recording started');

    const event = await new vm.Script('globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(12).values().next().value.current').runInContext(app as vm.Context);
    let leaf = event as { child?: unknown };
    while (leaf.child) leaf = leaf.child as { child?: unknown };
    (leaf as { memoizedProps: { onPress: () => void } }).memoizedProps.onPress();
    expect(await call('stop_test_recording')).toContain('1 tap');
    expect(vm.runInContext('handlerCalls', app)).toBe(1);
  });

  test('bounds every startup evaluation by one deadline', async () => {
    const app = appWithDeepButton();
    const evaluations: Array<{ expression: string; options?: EvalOptions; remaining: number }> = [];
    const call = await createHarness(app, [testRecorderPlugin], (expression, options) => {
      if (options?.deadline !== undefined) {
        evaluations.push({ expression, options, remaining: options.deadline - Date.now() });
      }
    });

    expect(await call('start_test_recording')).toContain('Recording started');
    expect(evaluations.length).toBeGreaterThanOrEqual(4);
    const deadlines = new Set(evaluations.map(({ options }) => options?.deadline));
    expect(deadlines.size).toBe(1);
    for (const { options, remaining } of evaluations) {
      expect(options?.timeout).toBeGreaterThan(0);
      expect(options?.timeout).toBeLessThanOrEqual(6000);
      // `evaluateStartup` and this observer read the clock separately.
      expect((options?.timeout ?? 0) - remaining).toBeLessThanOrEqual(25);
    }
  });

  test('uses target overrideProps when an ancestor forceUpdate is a no-op', async () => {
    const app = appWithNoopAncestorAndTargetRefresh();
    const call = await createHarness(app, [testRecorderPlugin]);
    expect(await call('start_test_recording')).toContain('Recording started');
    vm.runInContext('leaf.memoizedProps.onPress()', app);
    expect(await call('stop_test_recording')).toContain('1 tap');
  });

  test('uses the most specific metadata when a forwarded handler is wrapped twice', async () => {
    const app = appWithDeepButton();
    const call = await createHarness(app, [testRecorderPlugin]);
    expect(await call('start_test_recording')).toContain('Recording started');
    vm.runInContext(`
      var receiver = { calls: 0 };
      var forwarded = function(first, second) {
        this.calls++;
        if (first === 'throw') throw new Error('forwarded failure');
        return [this, first, second];
      };
      var outerProps = { testID: 'outer-control', onPress: forwarded };
      Object.freeze(outerProps);
      var childProps = { testID: 'inner-control', onPress: outerProps.onPress };
      Object.freeze(childProps);
      leaf.memoizedProps = childProps;
    `, app);
    const result = vm.runInContext('leaf.memoizedProps.onPress.call(receiver, "first", "second")', app) as unknown[];
    expect(result[0]).toBe(vm.runInContext('receiver', app));
    expect(result.slice(1)).toEqual(['first', 'second']);
    expect(vm.runInContext('receiver.calls', app)).toBe(1);
    expect(() => vm.runInContext('leaf.memoizedProps.onPress.call(receiver, "throw")', app)).toThrow('forwarded failure');
    expect(vm.runInContext('receiver.calls', app)).toBe(2);
    const stopped = await call('stop_test_recording');
    expect(stopped).toContain('2 taps');
    const events = JSON.parse(await call.resource('metro://recording/status'));
    expect(events.eventCount).toBe(2);
    const raw = vm.runInContext('__METRO_MCP_REC_EVENTS__', app) as Array<{ testID?: string }>;
    expect(raw).toHaveLength(2);
    expect(raw[0].testID).toBe('inner-control');
    expect(raw[1].testID).toBe('inner-control');
  });

  test('does not add a second wrapper when forwarded identifiers are unchanged', async () => {
    const app = appWithDeepButton();
    const call = await createHarness(app, [testRecorderPlugin]);
    expect(await call('start_test_recording')).toContain('Recording started');
    vm.runInContext(`
      var forwarded = function() { handlerCalls++; };
      var outerProps = { testID: 'same-control', onPress: forwarded };
      Object.freeze(outerProps);
      var childProps = { testID: 'same-control', onPress: outerProps.onPress };
      Object.freeze(childProps);
      leaf.memoizedProps = childProps;
      leaf.memoizedProps.onPress();
    `, app);
    expect(await call('stop_test_recording')).toContain('1 tap');
    expect(vm.runInContext('handlerCalls', app)).toBe(1);
    const raw = vm.runInContext('__METRO_MCP_REC_EVENTS__', app) as Array<{ testID?: string }>;
    expect(raw).toHaveLength(1);
    expect(raw[0].testID).toBe('same-control');
  });

  test('does not reuse a forwarded wrapper across handler kinds', async () => {
    const app = appWithDeepButton();
    const call = await createHarness(app, [testRecorderPlugin]);
    expect(await call('start_test_recording')).toContain('Recording started');
    vm.runInContext(`
      var forwarded = function() { handlerCalls++; };
      var outerProps = { testID: 'same-control', onPress: forwarded };
      Object.freeze(outerProps);
      var childProps = { testID: 'same-control', onLongPress: outerProps.onPress };
      Object.freeze(childProps);
      leaf.memoizedProps = childProps;
      leaf.memoizedProps.onLongPress();
    `, app);
    expect(await call('stop_test_recording')).toContain('1 long_press');
    expect(vm.runInContext('handlerCalls', app)).toBe(1);
    const raw = vm.runInContext('__METRO_MCP_REC_EVENTS__', app) as Array<{ type?: string }>;
    expect(raw).toHaveLength(1);
    expect(raw[0].type).toBe('long_press');
  });

  test('does not report readiness for a forwarded wrapper from another handler kind', async () => {
    const app = appWithDeepButton();
    let replacedBeforeReadiness = false;
    const call = await createHarness(app, [testRecorderPlugin], (expression) => {
      if (replacedBeforeReadiness || !expression.includes('handlerCount')) return;
      replacedBeforeReadiness = true;
      vm.runInContext(`
        leaf.memoizedProps = {
          testID: 'deep-button',
          onLongPress: leaf.memoizedProps.onPress
        };
      `, app);
    });
    const realNow = Date.now;
    let clockReads = 0;
    Date.now = () => realNow() + (clockReads++ < 5 ? 0 : 7000);
    let result: unknown;
    try {
      result = await call('start_test_recording');
    } finally {
      Date.now = realNow;
    }
    expect(replacedBeforeReadiness).toBe(true);
    expect(String(result)).toContain('unwrapped handlers: onLongPress');
    expect(vm.runInContext('globalThis.__METRO_MCP_REC_STATE__', app)).toBeUndefined();
    expect(vm.runInContext('globalThis.__METRO_MCP_REC_ACTIVE__', app)).toBe(false);
  });

  test('keeps recorder and profiler commit hooks chained in either stop order', async () => {
    const app = appWithDeepButton();
    const call = await createHarness(app, [testRecorderPlugin, profilerPlugin]);
    const originalHook = vm.runInContext('__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot', app);
    await call('start_profiling');
    const profilerHook = vm.runInContext('__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot', app);
    await call('start_test_recording');
    const recorderHook = vm.runInContext('__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot', app);
    expect(recorderHook).not.toBe(profilerHook);
    await call('stop_profiling');
    expect(vm.runInContext('__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot', app)).toBe(recorderHook);
    await call('stop_test_recording');
    expect(vm.runInContext('__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot', app)).toBe(originalHook);

    const reverseApp = appWithDeepButton();
    const reverseCall = await createHarness(reverseApp, [testRecorderPlugin, profilerPlugin]);
    const reverseOriginalHook = vm.runInContext('__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot', reverseApp);
    await reverseCall('start_test_recording');
    const reverseRecorderHook = vm.runInContext('__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot', reverseApp);
    await reverseCall('start_profiling');
    const reverseProfilerHook = vm.runInContext('__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot', reverseApp);
    await reverseCall('stop_test_recording');
    expect(vm.runInContext('__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot', reverseApp)).toBe(reverseProfilerHook);
    await reverseCall('stop_profiling');
    expect(vm.runInContext('__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot', reverseApp)).toBe(reverseOriginalHook);
  });

  test('does not let a repeated session capture through stale wrappers', async () => {
    const app = appWithDeepButton();
    const call = await createHarness(app, [testRecorderPlugin]);
    await call('start_test_recording');
    await call('stop_test_recording');
    await call('start_test_recording');
    const event = await new vm.Script('globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(12).values().next().value.current').runInContext(app as vm.Context);
    let leaf = event as { child?: unknown };
    while (leaf.child) leaf = leaf.child as { child?: unknown };
    (leaf as { memoizedProps: { onPress: () => void } }).memoizedProps.onPress();
    const stopped = await call('stop_test_recording');
    expect(stopped).toContain('1 tap');
  });

  test('patches a natural scroll view with no pre-existing callbacks', async () => {
    const app = appWithNaturalScroll();
    const call = await createHarness(app, [testRecorderPlugin]);
    expect(await call('start_test_recording')).toContain('Recording started');
    vm.runInContext(`
      var scrollProps = __REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(12).values().next().value.current.memoizedProps;
      scrollProps.onScrollBeginDrag({ nativeEvent: { contentOffset: { x: 0, y: 0 } } });
      scrollProps.onScrollEndDrag({ nativeEvent: { contentOffset: { x: 0, y: 250 } } });
    `, app);
    expect(await call('stop_test_recording')).toContain('1 swipe');
  });

  test('instruments a scroll view identified only by its momentum callback', async () => {
    const app = appWithMomentumOnlyScroll();
    const call = await createHarness(app, [testRecorderPlugin]);
    expect(await call('start_test_recording')).toContain('Recording started');
    vm.runInContext(`
      var scrollProps = __REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(12).values().next().value.current.memoizedProps;
      scrollProps.onScrollBeginDrag({ nativeEvent: { contentOffset: { x: 0, y: 0 } } });
      scrollProps.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 0, y: 250 } } });
    `, app);
    expect(await call('stop_test_recording')).toContain('1 swipe');
  });

  test('shares scroll state when a forwarded begin handler gets new end callbacks', async () => {
    const app = appWithNaturalScroll();
    const call = await createHarness(app, [testRecorderPlugin]);
    expect(await call('start_test_recording')).toContain('Recording started');
    vm.runInContext(`
      var scrollRoot = __REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(12).values().next().value.current;
      var firstProps = {
        scrollEnabled: true,
        testID: 'forwarded-scroll',
        onScrollBeginDrag: function() {},
        onScrollEndDrag: function() {}
      };
      Object.freeze(firstProps);
      scrollRoot.memoizedProps = firstProps;
      var forwardedBegin = firstProps.onScrollBeginDrag;
      var secondProps = {
        scrollEnabled: true,
        testID: 'forwarded-scroll',
        onScrollBeginDrag: forwardedBegin,
        onScrollEndDrag: function() {}
      };
      Object.freeze(secondProps);
      scrollRoot.memoizedProps = secondProps;
      secondProps.onScrollBeginDrag({ nativeEvent: { contentOffset: { x: 0, y: 0 } } });
      secondProps.onScrollEndDrag({ nativeEvent: { contentOffset: { x: 0, y: 250 } } });
    `, app);
    expect(await call('stop_test_recording')).toContain('1 swipe');
  });

  test('repairs conflicting forwarded scroll states before readiness', async () => {
    const app = appWithNaturalScroll();
    let injected = false;
    const call = await createHarness(app, [testRecorderPlugin], (expression) => {
      if (injected || !expression.includes('handlerCount')) return;
      injected = true;
      vm.runInContext(`
        var scrollRoot = __REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(12).values().next().value.current;
        var originalScrollCalls = 0;
        var firstProps = {
          scrollEnabled: true,
          testID: 'conflicting-scroll',
          onScrollBeginDrag: function() { originalScrollCalls++; },
          onScrollEndDrag: function() { originalScrollCalls++; }
        };
        Object.freeze(firstProps);
        var secondProps = {
          scrollEnabled: true,
          testID: 'conflicting-scroll',
          onScrollBeginDrag: function() { originalScrollCalls++; },
          onScrollEndDrag: function() { originalScrollCalls++; }
        };
        Object.freeze(secondProps);
        var conflictingProps = {
          scrollEnabled: true,
          testID: 'conflicting-scroll',
          onScrollBeginDrag: firstProps.onScrollBeginDrag,
          onScrollEndDrag: secondProps.onScrollEndDrag
        };
        Object.freeze(conflictingProps);
        Object.defineProperty(scrollRoot, 'memoizedProps', {
          configurable: true,
          get: function() { return conflictingProps; },
          set: function() {}
        });
      `, app);
    });
    expect(await call('start_test_recording')).toContain('Recording started');
    vm.runInContext(`
      var repairedProps = __REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(12).values().next().value.current.memoizedProps;
      repairedProps.onScrollBeginDrag({ nativeEvent: { contentOffset: { x: 0, y: 0 } } });
      repairedProps.onScrollEndDrag({ nativeEvent: { contentOffset: { x: 0, y: 250 } } });
    `, app);
    expect(await call('stop_test_recording')).toContain('1 swipe');
    expect(vm.runInContext('__METRO_MCP_REC_EVENTS__', app)).toHaveLength(1);
    expect(vm.runInContext('originalScrollCalls', app)).toBe(2);
  });

  for (const forwardedHandler of ['onScrollEndDrag', 'onMomentumScrollEnd'] as const) {
    test(`shares scroll state when a forwarded ${forwardedHandler} gets a new begin callback`, async () => {
      const app = appWithNaturalScroll();
      const call = await createHarness(app, [testRecorderPlugin]);
      expect(await call('start_test_recording')).toContain('Recording started');
      vm.runInContext(`
        var scrollRoot = __REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(12).values().next().value.current;
        var firstProps = {
          scrollEnabled: true,
          testID: 'forwarded-scroll',
          onScrollBeginDrag: function() {},
          onScrollEndDrag: function() {},
          onMomentumScrollEnd: function() {}
        };
        Object.freeze(firstProps);
        var secondProps = {
          scrollEnabled: true,
          testID: 'forwarded-scroll',
          onScrollBeginDrag: function() {},
          ${forwardedHandler}: firstProps.${forwardedHandler}
        };
        Object.freeze(secondProps);
        scrollRoot.memoizedProps = secondProps;
        secondProps.onScrollBeginDrag({ nativeEvent: { contentOffset: { x: 0, y: 0 } } });
        secondProps.${forwardedHandler}({ nativeEvent: { contentOffset: { x: 0, y: 250 } } });
      `, app);
      expect(await call('stop_test_recording')).toContain('1 swipe');
      const raw = vm.runInContext('__METRO_MCP_REC_EVENTS__', app) as Array<{ direction?: string }>;
      expect(raw).toHaveLength(1);
      expect(raw[0].direction).toBe('up');
    });
  }

  test('does not reuse an unfinished scroll from a previous recording session', async () => {
    const app = appWithNaturalScroll();
    const call = await createHarness(app, [testRecorderPlugin]);
    expect(await call('start_test_recording')).toContain('Recording started');
    vm.runInContext(`
      var scrollRoot = __REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(12).values().next().value.current;
      var scrollProps = {
        scrollEnabled: true,
        testID: 'restarted-scroll',
        onScrollBeginDrag: function() {},
        onScrollEndDrag: function() {}
      };
      Object.freeze(scrollProps);
      scrollRoot.memoizedProps = scrollProps;
      scrollProps.onScrollBeginDrag({ nativeEvent: { contentOffset: { x: 0, y: 0 } } });
    `, app);
    expect(await call('stop_test_recording')).toContain('No interactions');

    expect(await call('start_test_recording')).toContain('Recording started');
    vm.runInContext(
      `scrollRoot.memoizedProps.onScrollEndDrag({ nativeEvent: { contentOffset: { x: 0, y: 250 } } });`,
      app,
    );
    expect(await call('stop_test_recording')).toContain('No interactions');
  });

  test('exposes active status and annotations only after capture activates', async () => {
    const app = appWithDeepButton();
    const call = await createHarness(app, [testRecorderPlugin]);
    expect(JSON.parse(await call.resource('metro://recording/status'))).toMatchObject({ isRecording: false });
    await call('start_test_recording');
    expect(await call('add_recording_annotation', { note: 'checkpoint' })).toContain('Annotation added');
    expect(JSON.parse(await call.resource('metro://recording/status'))).toMatchObject({ isRecording: true, eventCount: 1 });
    await call('stop_test_recording');
    expect(JSON.parse(await call.resource('metro://recording/status'))).toMatchObject({ isRecording: false });
  });

  test('does not extend the startup deadline when a commit does not produce wrapped props', async () => {
    const app = appWithoutFiberRefresh();
    const originalCommit = vm.runInContext('__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot', app);
    const evaluations: Array<{ expression: string; options?: EvalOptions }> = [];
    const call = await createHarness(app, [testRecorderPlugin], (expression, options) => {
      evaluations.push({ expression, options });
    });
    const realNow = Date.now;
    let clockReads = 0;
    Date.now = () => realNow() + (clockReads++ < 5 ? 0 : 7000);
    let result: unknown;
    try {
      result = await call('start_test_recording');
    } finally {
      Date.now = realNow;
    }
    expect(String(result)).toContain('coverage did not become ready');
    expect(evaluations.filter(({ expression }) => expression.includes('handlerCount'))).toHaveLength(1);
    expect(evaluations.every(({ options }) => (options?.timeout ?? 0) > 0)).toBe(true);
    expect(vm.runInContext('__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot', app)).toBe(originalCommit);
    expect(vm.runInContext('globalThis.__METRO_MCP_REC_STATE__', app)).toBeUndefined();
    expect(vm.runInContext('globalThis.__METRO_MCP_REC_ACTIVE__', app)).toBe(false);
  });

  test('fails honestly when fiber roots are unavailable', async () => {
    const app = appWithoutFiberRoots();
    const call = await createHarness(app, [testRecorderPlugin]);
    const realNow = Date.now;
    let clockReads = 0;
    Date.now = () => realNow() + (clockReads++ < 5 ? 0 : 7000);
    let result: unknown;
    try {
      result = await call('start_test_recording');
    } finally {
      Date.now = realNow;
    }
    expect(String(result)).toContain('coverage did not become ready');
    expect(vm.runInContext('globalThis.__METRO_MCP_REC_STATE__', app)).toBeUndefined();
  });
});
