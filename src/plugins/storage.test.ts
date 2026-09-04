import { describe, expect, test } from 'bun:test';
import vm from 'node:vm';
import type { z } from 'zod';
import type { EvalOptions, PluginContext, ToolHandlerContext } from '../plugin.js';
import { createAppEvaluator } from '../utils/evaluate-app.js';
import { storagePlugin } from './storage.js';

interface RegisteredTool {
  parameters: z.ZodType;
  handler(args: Record<string, unknown>, ctx: ToolHandlerContext): Promise<unknown>;
}

async function harness(runtime: Record<string, unknown>) {
  const tools = new Map<string, RegisteredTool>();
  const app = vm.createContext({ ...runtime, setTimeout, clearTimeout });
  const remoteObjects = new Map<string, { value: unknown; objectGroup?: string }>();
  let nextObjectId = 0;
  const sourceExpressions: string[] = [];

  const evaluate = createAppEvaluator({
    send: async (method, params = {}) => {
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression);
        if (expression.includes('var AsyncStorage')) sourceExpressions.push(expression);
        const value = new vm.Script(expression).runInContext(app);
        if (params.returnByValue === false && value !== null &&
            (typeof value === 'object' || typeof value === 'function')) {
          const objectId = `remote-${++nextObjectId}`;
          remoteObjects.set(objectId, {
            value,
            ...(typeof params.objectGroup === 'string'
              ? { objectGroup: params.objectGroup }
              : {}),
          });
          return {
            result: {
              type: 'object',
              ...(value instanceof Promise ? { subtype: 'promise' } : {}),
              objectId,
            },
          };
        }
        return { result: { value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) } };
      }
      if (method === 'Runtime.callFunctionOn') {
        const remote = remoteObjects.get(String(params.objectId));
        if (!remote) return { result: { value: false } };
        const fn = new vm.Script(`(${String(params.functionDeclaration)})`)
          .runInContext(app) as (...args: unknown[]) => unknown;
        const args = (params.arguments as Array<{ value: unknown }> | undefined)
          ?.map((arg) => arg.value) ?? [];
        const value = fn.call(remote.value, ...args);
        return { result: { value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) } };
      }
      if (method === 'Runtime.releaseObject') {
        remoteObjects.delete(String(params.objectId));
        return { result: { value: undefined } };
      }
      if (method === 'Runtime.releaseObjectGroup') {
        for (const [objectId, remote] of remoteObjects) {
          if (remote.objectGroup === params.objectGroup) remoteObjects.delete(objectId);
        }
        return { result: { value: undefined } };
      }
      return { result: { value: undefined } };
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
  await storagePlugin.setup({
    registerTool,
    registerResource() {},
    registerAppResource() {},
    evalInApp: async (expression: string, options?: EvalOptions) => {
      expect(options?.awaitPromise).toBe(true);
      return evaluate(expression, options);
    },
  } as unknown as PluginContext);

  return {
    sourceExpressions,
    async call(name: string, args: Record<string, unknown> = {}) {
      const tool = tools.get(name)!;
      return tool.handler(tool.parameters.parse(args) as Record<string, unknown>, {});
    },
  };
}

function registry(exports: unknown[]) {
  const modules = new Map(exports.map((value, index) => [
    701 + index,
    { publicModule: { exports: value }, verboseName: `unrelated-${index}` },
  ]));
  return { __r: Object.assign(() => { throw new Error('Do not require modules by name'); }, {
    getModules: () => modules,
  }) };
}

describe('AsyncStorage tools', () => {
  test('reads keys, JSON values, and truncated values from an initialized registry export', async () => {
    const values: Record<string, string> = {
      session: JSON.stringify({ userId: 42 }),
      flag: 'fixture-value',
    };
    let requireCalls = 0;
    const asyncStorage = {
      async getAllKeys() { return Object.keys(values); },
      async getItem(key: string) { return values[key] ?? null; },
      async multiGet(keys: string[]) { return keys.map((key) => [key, values[key] ?? null]); },
    };
    const tool = await harness({
      ...registry([{ default: asyncStorage }]),
      require() { requireCalls++; throw new Error('require should not run'); },
    });

    expect(await tool.call('get_storage_keys')).toEqual({ keys: ['session', 'flag'] });
    expect(await tool.call('get_storage_item', { key: 'session' }))
      .toEqual({ key: 'session', value: { userId: 42 } });
    expect(await tool.call('get_all_storage', { maxLength: 5 }))
      .toEqual({ session: '{"use...(truncated)', flag: 'fixtu...(truncated)' });
    expect(requireCalls).toBe(0);
    expect(tool.sourceExpressions).toHaveLength(3);
  });

  test('supports the legacy callable require fallback', async () => {
    const asyncStorage = {
      getAllKeys: async () => ['legacy'],
      getItem: async () => 'value',
      multiGet: async () => [['legacy', 'value']],
    };
    const calls: string[] = [];
    const tool = await harness({
      require(name: string) {
        calls.push(name);
        if (name === '@react-native-async-storage/async-storage') return { default: asyncStorage };
        throw new Error('unexpected module');
      },
    });

    expect(await tool.call('get_storage_keys')).toEqual({ keys: ['legacy'] });
    expect(calls).toEqual(['@react-native-async-storage/async-storage']);
  });

  test('reports unsupported capability when no initialized or legacy module exists', async () => {
    const tool = await harness({});
    await expect(tool.call('get_storage_keys')).resolves.toEqual({
      error: 'Unsupported capability: initialized AsyncStorage module is unavailable.',
    });
    await expect(tool.call('get_storage_item', { key: 'missing' })).resolves.toEqual({
      error: 'Unsupported capability: initialized AsyncStorage module is unavailable.',
    });
    await expect(tool.call('get_all_storage')).resolves.toEqual({
      error: 'Unsupported capability: initialized AsyncStorage module is unavailable.',
    });
  });
});
