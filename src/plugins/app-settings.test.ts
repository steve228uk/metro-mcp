import { describe, expect, test } from 'bun:test';
import vm from 'node:vm';
import type { z } from 'zod';
import type { EvalOptions, PluginContext, ToolHandlerContext } from '../plugin.js';
import { createAppEvaluator } from '../utils/evaluate-app.js';
import { permissionsPlugin } from './permissions.js';

interface RegisteredTool {
  parameters: z.ZodType;
  handler(args: Record<string, unknown>, ctx: ToolHandlerContext): Promise<unknown>;
}

async function harness(runtime: Record<string, unknown>, appId: string | null = 'com.example.app') {
  let tool: RegisteredTool;
  let evaluations = 0;
  const app = vm.createContext({ ...runtime, setTimeout, clearTimeout });
  const evaluate = createAppEvaluator({
    send: async (_method, params) => {
      const value = new vm.Script(String(params?.expression)).runInContext(app);
      return { result: { value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) } };
    },
  }, {
    ensureConnected: async () => {},
    waitForReconnect: async () => {},
    reconnect: async () => {},
    isReconnecting: () => false,
  });
  const registerTool: PluginContext['registerTool'] = (name, config) => {
    if (name === 'open_app_settings') tool = config as unknown as RegisteredTool;
  };
  await permissionsPlugin.setup({
    cdp: { isConnected: appId !== null, getTarget: () => appId === null ? null : { appId } },
    registerTool,
    registerResource() {},
    exec: async () => { throw new Error('App settings must not use host shell commands'); },
    evalInApp: async (expression: string, options?: EvalOptions) => {
      evaluations++;
      expect(options?.awaitPromise).toBe(true);
      return evaluate(expression, options);
    },
  } as unknown as PluginContext);
  return {
    get evaluations() { return evaluations; },
    async call(args: Record<string, unknown> = {}) {
      return tool.handler(tool.parameters.parse(args) as Record<string, unknown>, {});
    },
  };
}

function registry(exports: unknown[]) {
  const modules = new Map(exports.map((value, index) => [
    701 + index, { publicModule: { exports: value }, verboseName: `unrelated-${index}` },
  ]));
  return { __r: Object.assign(() => { throw new Error('Do not require modules by name'); }, {
    getModules: () => modules,
  }) };
}

describe('open_app_settings', () => {
  test('resolves lazy React Native exports without require and waits for native completion', async () => {
    let finished = false;
    let calls = 0;
    const native = {
      AppRegistry: {}, View: {}, Platform: { OS: 'ios' },
      get Linking() {
        return { openSettings: async () => {
          calls++;
          await new Promise((resolve) => setTimeout(resolve, 30));
          finished = true;
        } };
      },
    };
    const tool = await harness(registry([{}, native]));
    const result = tool.call({ platform: 'ios', bundleId: 'com.example.app' });
    expect(finished).toBe(false);
    expect(await result).toBe('Opened app settings for com.example.app.');
    expect(finished).toBe(true);
    expect(calls).toBe(1);
  });

  test('supports initialized default Linking and Platform exports on Android', async () => {
    let calls = 0;
    const linking = {
      openSettings() { calls++; }, openURL() {}, canOpenURL() {}, getInitialURL() {},
    };
    const tool = await harness(registry([{ default: linking }, { OS: 'android', select() {} }]));
    expect(await tool.call({ platform: 'android' })).toBe('Opened app settings for com.example.app.');
    expect(calls).toBe(1);
  });

  test('rejects a mismatched or unverifiable bundle before evaluating', async () => {
    const tool = await harness({});
    expect(await tool.call({ bundleId: 'com.other.app' })).toContain('does not match');
    expect(tool.evaluations).toBe(0);
    const unknown = await harness({}, '');
    expect(await unknown.call({ bundleId: 'com.example.app' })).toContain('cannot be verified');
    expect(unknown.evaluations).toBe(0);
  });

  test('rejects a mismatched platform before calling Linking', async () => {
    let calls = 0;
    const tool = await harness(registry([{
      AppRegistry: {}, View: {}, Platform: { OS: 'ios' }, Linking: { openSettings() { calls++; } },
    }]));
    expect(await tool.call({ platform: 'android' })).toContain('does not match requested platform');
    expect(calls).toBe(0);
  });

  test('reports disconnected and unsupported runtimes without claiming success', async () => {
    const disconnected = await harness({}, null);
    expect(await disconnected.call()).toContain('No connected app');
    expect(disconnected.evaluations).toBe(0);
    const unavailable = await harness({});
    expect(await unavailable.call()).toContain('Unsupported capability: Metro module registry');
    const noLinking = await harness(registry([{}]));
    expect(await noLinking.call()).toContain('Linking.openSettings is unavailable');
  });

  test('reports native rejection and invokes the action only once', async () => {
    let calls = 0;
    const tool = await harness(registry([{
      AppRegistry: {}, View: {}, Platform: { OS: 'ios' }, Linking: {
        openSettings: async () => { calls++; throw new Error('native rejected'); },
      },
    }]));
    expect(await tool.call()).toBe('Failed to open app settings: native rejected');
    expect(calls).toBe(1);
  });
});
