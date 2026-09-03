import { describe, expect, test } from 'bun:test';
import vm from 'node:vm';
import type { z } from 'zod';
import type { ComponentNode, PluginContext, PluginDefinition } from '../plugin.js';
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

function appWithoutFiberRefresh() {
  const app = appWithDeepButton();
  vm.runInContext(`
    var originalRoot = __REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(12).values().next().value.current;
    originalRoot.stateNode = { forceUpdate: function() {} };
    var leafWithoutRefresh = originalRoot;
    while (leafWithoutRefresh.child) leafWithoutRefresh = leafWithoutRefresh.child;
    leafWithoutRefresh.stateNode = { forceUpdate: function() {} };
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

async function createHarness(app: Record<string, unknown>, plugins: PluginDefinition[], targetAppId?: string): Promise<Runner> {
  const tools = new Map<string, Tool>();
  const resources = new Map<string, () => Promise<string>>();
  const ctx: PluginContext = {
    cdp: {
      on: () => {}, off: () => {}, isConnected: true,
      getTarget: () => targetAppId ? ({ appId: targetAppId } as ReturnType<PluginContext['cdp']['getTarget']>) : null,
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
    evalInApp: async (expression) => {
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

  test('fails and cleans up when a commit does not produce wrapped props', async () => {
    const app = appWithoutFiberRefresh();
    const originalCommit = vm.runInContext('__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot', app);
    const call = await createHarness(app, [testRecorderPlugin]);
    const realNow = Date.now;
    let clockReads = 0;
    Date.now = () => realNow() + (clockReads++ === 0 ? 0 : 7000);
    let result: unknown;
    try {
      result = await call('start_test_recording');
    } finally {
      Date.now = realNow;
    }
    expect(String(result)).toContain('coverage did not become ready');
    expect(vm.runInContext('__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot', app)).toBe(originalCommit);
    expect(vm.runInContext('globalThis.__METRO_MCP_REC_STATE__', app)).toBeUndefined();
    expect(vm.runInContext('globalThis.__METRO_MCP_REC_ACTIVE__', app)).toBe(false);
  });

  test('fails honestly when fiber roots are unavailable', async () => {
    const app = appWithoutFiberRoots();
    const call = await createHarness(app, [testRecorderPlugin]);
    const realNow = Date.now;
    let clockReads = 0;
    Date.now = () => realNow() + (clockReads++ === 0 ? 0 : 7000);
    let result: unknown;
    try {
      result = await call('start_test_recording');
    } finally {
      Date.now = realNow;
    }
    expect(String(result)).toContain('coverage did not become ready');
    expect(vm.runInContext('globalThis.__METRO_MCP_REC_STATE__', app)).toBeUndefined();
  });

  test('generates WDIO runner specs for either setup mode without a second session', async () => {
    const app = appWithDeepButton();
    const call = await createHarness(app, [testRecorderPlugin]);
    expect(await call('start_test_recording')).toContain('Recording started');
    vm.runInContext(`
      var rootForSpec = __REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(12).values().next().value.current;
      var leafForSpec = rootForSpec;
      while (leafForSpec.child) leafForSpec = leafForSpec.child;
      leafForSpec.memoizedProps.onPress();
    `, app);
    await call('stop_test_recording');

    for (const includeSetup of [true, false]) {
      const generated = String(await call('generate_test_from_recording', {
        format: 'appium',
        platform: 'both',
        bundleId: `com.example.${includeSetup ? 'one' : 'two'}`,
        testName: `Flow ${includeSetup ? 'one' : 'two'} quoted`,
        includeSetup,
      }));
      expect(generated).toContain(`import { browser } from '@wdio/globals';`);
      expect(generated).not.toContain('remote(');
      expect(generated).not.toContain('deleteSession');
      expect(generated).not.toContain('beforeAll');
      expect(generated).not.toContain('afterAll');
      expect(generated).not.toContain('capabilities');
      expect(generated).toContain('browser.$("~deep-button").click()');
      expect(() => new Bun.Transpiler({ loader: 'ts' }).transformSync(generated)).not.toThrow();
    }
  });

  test('generates configurable iOS and Android capabilities without fixed simulator values', async () => {
    const call = await createHarness(appWithDeepButton(), [testRecorderPlugin]);
    const generated = String(await call('generate_wdio_config', {
      platform: 'both',
      bundleId: "com.example.special'app",
      appPath: '/tmp/My App.app',
      udid: 'device-123',
      deviceName: 'QA phone',
      platformVersion: '26.5',
      outputPath: './e2e/wdio.conf.ts',
    }));
    expect(generated).toContain('"appium:udid": "device-123"');
    expect(generated).toContain('"appium:deviceName": "QA phone"');
    expect(generated).toContain('"appium:platformVersion": "26.5"');
    expect(generated).toContain('"appium:app": "/tmp/My App.app"');
    expect(generated).not.toContain('iPhone 16');
    expect(generated).not.toContain('18.0');
    expect(generated).not.toContain('emulator-5554');
    expect(generated).toContain('config: WebdriverIO.Config');
    expect(generated).not.toContain('autoCompileOpts');
    expect(generated).not.toContain('appium: { command');
    expect(() => new Bun.Transpiler({ loader: 'ts' }).transformSync(generated)).not.toThrow();
  });

  test('uses the connected app ID when config arguments omit an app target', async () => {
    const call = await createHarness(appWithDeepButton(), [testRecorderPlugin], 'com.connected.app');
    const generated = String(await call('generate_wdio_config', { platform: 'ios' }));
    expect(generated).toContain('"appium:bundleId": "com.connected.app"');
    expect(generated).not.toContain('com.example.app');
    expect(() => new Bun.Transpiler({ loader: 'ts' }).transformSync(generated)).not.toThrow();
  });

  test('rejects an Appium config with no app path, bundle ID, or connected target', async () => {
    const call = await createHarness(appWithDeepButton(), [testRecorderPlugin]);
    await expect(call('generate_wdio_config', { platform: 'ios' })).resolves.toContain('without an app target');
  });

  test('generates W3C actions for recorded long presses and swipes', async () => {
    const app = appWithDeepButton();
    vm.runInContext(`
      var actionRoot = __REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(12).values().next().value.current;
      var actionLeaf = actionRoot;
      while (actionLeaf.child) actionLeaf = actionLeaf.child;
      actionLeaf.stateNode = null;
      actionLeaf.memoizedProps = Object.freeze({
        testID: 'action-button',
        onPress: function() {},
        onLongPress: function() {},
        onChangeText: function() {},
        onSubmitEditing: function() {},
        scrollEnabled: true,
        onScrollBeginDrag: function() {},
        onScrollEndDrag: function() {}
      });
    `, app);
    const call = await createHarness(app, [testRecorderPlugin]);
    expect(await call('start_test_recording')).toContain('Recording started');
    vm.runInContext(`
      var actionProps = actionLeaf.memoizedProps;
      actionProps.onLongPress();
      actionProps.onChangeText('hello');
      actionProps.onSubmitEditing();
      actionProps.onScrollBeginDrag({ nativeEvent: { contentOffset: { x: 0, y: 0 } } });
      actionProps.onScrollEndDrag({ nativeEvent: { contentOffset: { x: 0, y: 250 } } });
    `, app);
    await call('stop_test_recording');
    const generated = String(await call('generate_test_from_recording', { format: 'appium' }));
    expect(generated).toContain('await longPress(');
    expect(generated).toContain('await swipe(');
    expect(generated).toContain("await browser.keys(['Enter']);");
    expect(generated).toContain('browser.performActions');
    expect(generated).toContain('browser.releaseActions');
    expect(generated).not.toContain('touchAction');
    expect(() => new Bun.Transpiler({ loader: 'ts' }).transformSync(generated)).not.toThrow();
  });
});
