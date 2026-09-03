import { describe, expect, test } from 'bun:test';
import vm from 'node:vm';
import type { z } from 'zod';
import type { EvalOptions, PluginContext, ToolHandlerContext } from '../plugin.js';
import { getFocusedRoute } from '../utils/navigation.js';
import { createAppEvaluator } from '../utils/evaluate-app.js';
import { automationPlugin } from './automation.js';
import { navigationPlugin } from './navigation.js';

interface RegisteredTool {
  parameters: z.ZodType;
  handler(args: Record<string, unknown>, ctx: ToolHandlerContext): Promise<unknown>;
}

async function harness(runtime: Record<string, unknown>) {
  const tools = new Map<string, RegisteredTool>();
  const timeouts: Array<number | undefined> = [];
  const appGlobal = vm.createContext({ ...runtime, setTimeout, clearTimeout });
  const evaluate = createAppEvaluator({
    send: async (_method, params) => {
      const result = new vm.Script(String(params?.expression)).runInContext(appGlobal);
      // Hermes serializes promises instead of honoring CDP awaitPromise.
      return { result: { value: result === undefined ? undefined : JSON.parse(JSON.stringify(result)) } };
    },
  }, {
    ensureConnected: async () => {},
    waitForReconnect: async () => {},
    reconnect: async () => {},
    isReconnecting: () => false,
  });
  const registerTool: PluginContext['registerTool'] = (name, config) => {
    tools.set(name, config as unknown as RegisteredTool);
  };
  const context = {
    registerTool,
    registerAppResource() {},
    registerResource() {},
    evalInApp: async (expression: string, options?: EvalOptions) => {
      timeouts.push(options?.timeout);
      // The shared evaluator owns promise resolution; the plugins must request it.
      expect(options?.awaitPromise).toBe(true);
      return evaluate(expression, options);
    },
    format: { compact: JSON.stringify },
  } as unknown as PluginContext;
  await navigationPlugin.setup(context);
  await automationPlugin.setup(context);
  return {
    timeouts,
    async call(name: string, args: Record<string, unknown> = {}) {
      const tool = tools.get(name)!;
      return tool.handler(tool.parameters.parse(args) as Record<string, unknown>, {});
    },
  };
}

function state(name: string) {
  return { index: 0, routes: [{ name, key: `${name}-key`, params: { id: 1 } }] };
}

function fiberRuntime(navigation: unknown, depth = 255) {
  let current: Record<string, unknown> = {
    type: { displayName: 'NavigationContainerInner' },
    memoizedState: { queue: { lastRenderedState: navigation } },
  };
  for (let index = 0; index < depth; index++) {
    current = { type: { displayName: 'Provider' }, child: current };
  }
  return {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      getFiberRoots: (id: number) => id === 12 ? new Set([{ current }]) : new Set(),
    },
  };
}

describe('navigation inspection and waits', () => {
  for (const bridgeName of ['__METRO_BRIDGE__', '__METRO_MCP__']) {
    test(`an already focused SDK route works without a nav ref (${bridgeName})`, async () => {
      const nav = state('Home');
      const { call } = await harness({ [bridgeName]: { navigation: { getState: () => nav } } });
      expect(await call('get_navigation_state')).toEqual(nav);
      expect(await call('get_current_route')).toEqual(nav.routes[0]);
      expect(await call('wait_for_navigation', { routeName: 'Home', timeout: 100 }))
        .toMatchObject({ route: 'Home', elapsedMs: expect.any(Number) });
    });
  }

  test('waits for a later nested transition from an asynchronous SDK', async () => {
    let reads = 0;
    const { call } = await harness({
      __METRO_BRIDGE__: { navigation: { getState: async () => {
        reads++;
        return { routes: [{ name: 'Tabs', state: state(reads === 1 ? 'Home' : 'Profile') }] };
      } } },
    });
    expect(await call('wait_for_navigation', { routeName: 'Profile', timeout: 1000 }))
      .toMatchObject({ route: 'Profile' });
    expect(reads).toBe(2);
    expect(await call('get_current_route')).toEqual(state('Profile').routes[0]);
  });

  test('discovers deep Fiber state in renderer 12 for both tools', async () => {
    const nav = { routes: [{ name: 'Root', state: state('Details') }] };
    const { call } = await harness(fiberRuntime(nav));
    expect(await call('get_navigation_state')).toEqual(nav);
    expect(await call('get_current_route')).toEqual(state('Details').routes[0]);
    expect(await call('wait_for_navigation', { routeName: 'Details', timeout: 100 }))
      .toMatchObject({ route: 'Details' });
  });

  test('retains a current-route-only navigation ref', async () => {
    const route = state('Home').routes[0];
    const { call } = await harness({ __METRO_MCP_NAV_REF__: { getCurrentRoute: () => route } });
    expect(await call('get_current_route')).toEqual(route);
    expect(await call('wait_for_navigation', { routeName: 'Home', timeout: 100 }))
      .toMatchObject({ route: 'Home' });
  });

  test('falls back from an unavailable SDK to Expo state', async () => {
    const { call } = await harness({
      __METRO_BRIDGE__: { navigation: { getState: async () => { throw new Error('not ready'); } } },
      __EXPO_ROUTER_STATE__: () => state('ExpoHome'),
    });
    expect(await call('get_current_route')).toEqual(state('ExpoHome').routes[0]);
  });

  test('does not call an unavailable SDK again during Fiber fallback', async () => {
    let reads = 0;
    const { call } = await harness({
      ...fiberRuntime(state('FiberHome')),
      __METRO_BRIDGE__: { navigation: { getState: async () => {
        reads++;
        throw new Error('not ready');
      } } },
    });
    expect(await call('get_current_route')).toEqual(state('FiberHome').routes[0]);
    expect(reads).toBe(1);
  });

  test('times out when the route remains different, bounding each evaluation', async () => {
    const { call, timeouts } = await harness({
      __METRO_MCP_NAV_REF__: { getRootState: () => state('Home') },
    });
    await expect(call('wait_for_navigation', { routeName: 'Missing', timeout: 100 }))
      .rejects.toThrow('Timed out after 100ms waiting for route "Missing"');
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts.every((timeout) => timeout! > 0 && timeout! <= 100)).toBe(true);
  });

  test('missing state preserves inspection messages and navigation timeout', async () => {
    const { call } = await harness({});
    expect(await call('get_current_route')).toBe('No focused route found.');
    await expect(call('wait_for_navigation', { routeName: 'Home', timeout: 100 }))
      .rejects.toThrow('Timed out');
  });
});

test('focused route resolution handles empty, invalid, and cyclic states', () => {
  for (const input of [null, {}, { routes: [] }, { index: 5, routes: [{ name: 'Home' }] }]) {
    expect(getFocusedRoute(input)).toBeNull();
  }
  const cycle: { routes: Array<{ name: string; state?: unknown }> } = { routes: [{ name: 'Loop' }] };
  cycle.routes[0].state = cycle;
  expect(getFocusedRoute(cycle)).toBeNull();
  expect(getFocusedRoute({ routes: [{ name: 'Home' }, { name: 'Details' }] }))
    .toEqual({ name: 'Details', params: {}, key: undefined });
});
