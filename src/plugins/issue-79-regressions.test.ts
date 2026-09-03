import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import type { ComponentNode, PluginContext, ToolHandlerResult } from '../plugin.js';
import { filesystemPlugin } from './filesystem.js';
import { permissionsPlugin } from './permissions.js';

type RegisteredTool = {
  parameters: z.ZodType;
  handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult>;
};

function createContext(options: {
  inventory?: 'android' | 'missing';
  resetFailure?: boolean;
  evaluate?: unknown;
  ios?: string[];
  android?: string[];
  target?: { deviceName: string; logicalDeviceId: string };
}) {
  const tools = new Map<string, RegisteredTool>();
  const execCalls: string[] = [];
  const execFileCalls: string[][] = [];
  const ios = [...(options.ios ?? [JSON.stringify({ devices: {} })])];
  const android = [...(options.android ?? (options.inventory === 'android'
    ? ['List of devices attached\nemulator-42\tdevice model:Pixel_8\n']
    : []))];
  const target = {
    id: 'metro-target',
    title: 'com.example.app (React Native)',
    description: 'React Native',
    type: 'node',
    deviceName: options.target?.deviceName ?? 'Pixel 8',
    reactNative: { logicalDeviceId: options.target?.logicalDeviceId ?? 'emulator-42' },
  } as never;

  const ctx: PluginContext = {
    cdp: {
      on: () => {}, off: () => {}, isConnected: true,
      getTarget: () => target,
      send: async () => ({}),
    },
    events: { on: () => {}, off: () => {}, isConnected: () => true },
    registerTool: (name, config) => tools.set(name, {
      parameters: config.parameters,
      handler: config.handler as RegisteredTool['handler'],
    }),
    registerResource: () => {}, registerAppResource: () => {}, registerPrompt: () => {},
    config: { packageName: 'com.example.app' },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    metro: { host: 'localhost', port: 8081, fetch: async () => new Response() },
    exec: async (command) => {
      execCalls.push(command);
      if (options.resetFailure && command.includes('pm reset-permissions')) {
        throw new Error('pm reset unsupported');
      }
      if (command.includes('echo $HOME')) return '';
      return command.includes('pm clear') ? 'Success' : '';
    },
    execFile: async (command, args) => {
      execFileCalls.push([command, ...args]);
      if (command === 'adb' && options.inventory === 'missing') {
        throw new Error('adb unavailable');
      }
      if (command === 'adb') {
        return Buffer.from(android.shift() ?? android.at(-1) ?? 'List of devices attached\n');
      }
      return Buffer.from(ios.shift() ?? ios.at(-1) ?? JSON.stringify({ devices: {} }));
    },
    format: {
      summarize: () => '', compact: (value: unknown) => JSON.stringify(value),
      truncate: (value: string) => value, structureOnly: (value: ComponentNode) => value,
    },
    evalInApp: async () => options.evaluate,
    getActiveDeviceKey: () => null, getActiveDeviceName: () => null,
    notifyResourceUpdated: () => {},
  };
  return { ctx, tools, execCalls, execFileCalls };
}

describe('issue 79 device discovery regressions', () => {
  test('keeps the explicit Android filesystem fallback available without ADB', async () => {
    const harness = createContext({
      inventory: 'missing',
      evaluate: {
        documents: 'file:///data/user/0/com.example.app/files/',
        cache: 'file:///data/user/0/com.example.app/cache/',
        temp: 'file:///data/user/0/com.example.app/cache/',
        library: null,
      },
    });
    await filesystemPlugin.setup(harness.ctx);
    const tool = harness.tools.get('get_app_directories')!;
    const result = await tool.handler(tool.parameters.parse({
      bundleId: 'com.example.app', platform: 'android',
    }) as Record<string, unknown>);

    expect(result).toEqual({
      documents: 'file:///data/user/0/com.example.app/files/',
      cache: 'file:///data/user/0/com.example.app/cache/',
      temp: 'file:///data/user/0/com.example.app/cache/',
      library: null,
    });
    expect(harness.execCalls).toEqual([]);
    expect(harness.execFileCalls).toHaveLength(1);
  });

  test('keeps the default auto filesystem fallback available without ADB', async () => {
    const directories = {
      documents: 'file:///data/user/0/com.example.app/files/',
      cache: 'file:///data/user/0/com.example.app/cache/',
      temp: 'file:///data/user/0/com.example.app/cache/',
      library: null,
    };
    const harness = createContext({ inventory: 'missing', evaluate: directories });
    await filesystemPlugin.setup(harness.ctx);
    const tool = harness.tools.get('get_app_directories')!;

    await expect(tool.handler(tool.parameters.parse({
      bundleId: 'com.example.app',
    }) as Record<string, unknown>)).resolves.toEqual(directories);
    expect(harness.execCalls).toEqual([]);
  });

  test('does not clear app data when Android inventory resolution fails', async () => {
    const harness = createContext({ inventory: 'missing', resetFailure: true });
    await permissionsPlugin.setup(harness.ctx);
    const tool = harness.tools.get('reset_permissions')!;
    const result = await tool.handler(tool.parameters.parse({
      bundleId: 'com.example.app', platform: 'android',
    }) as Record<string, unknown>);

    expect(String(result)).toContain('Failed to reset permissions');
    expect(harness.execCalls).toEqual([]);
    expect(harness.execFileCalls).toHaveLength(1);
  });

  test('uses the same resolved Android serial for reset fallback after pm reset dispatch', async () => {
    const harness = createContext({
      inventory: 'android',
      android: [
        'List of devices attached\nemulator-42\tdevice model:Pixel_8\n',
        'List of devices attached\nemulator-99\tdevice model:Pixel_8\n',
      ],
      resetFailure: true,
    });
    await permissionsPlugin.setup(harness.ctx);
    const tool = harness.tools.get('reset_permissions')!;
    const result = await tool.handler(tool.parameters.parse({
      bundleId: 'com.example.app', platform: 'android',
    }) as Record<string, unknown>);

    expect(result).toContain('Reset all permissions');
    expect(harness.execCalls).toEqual([
      'adb -s "emulator-42" shell pm reset-permissions -p "com.example.app" 2>/dev/null',
      'adb -s "emulator-42" shell pm clear "com.example.app"',
    ]);
    expect(harness.execFileCalls).toHaveLength(1);
  });

  test('uses the originally resolved Android serial for permission mutations', async () => {
    const harness = createContext({
      android: [
        'List of devices attached\nemulator-42\tdevice model:Pixel_8\n',
        'List of devices attached\nemulator-99\tdevice model:Pixel_8\n',
      ],
    });
    await permissionsPlugin.setup(harness.ctx);
    const tool = harness.tools.get('grant_permission')!;
    const result = await tool.handler(tool.parameters.parse({
      bundleId: 'com.example.app', platform: 'android', service: 'camera',
    }) as Record<string, unknown>);

    expect(result).toContain('Granted');
    expect(harness.execCalls).toEqual([
      'adb -s "emulator-42" shell pm grant "com.example.app" "android.permission.CAMERA"',
    ]);
    expect(harness.execFileCalls.filter(([command]) => command === 'adb')).toHaveLength(1);
  });

  test('uses the originally resolved iOS UDID for permission mutations', async () => {
    const ios = (udid: string) => JSON.stringify({ devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
        { name: 'iPhone 16', udid, state: 'Booted' },
      ],
    } });
    const harness = createContext({
      ios: [ios('IOS-1'), ios('IOS-2')],
      target: { deviceName: 'iPhone 16', logicalDeviceId: 'IOS-1' },
    });
    await permissionsPlugin.setup(harness.ctx);
    const tool = harness.tools.get('grant_permission')!;
    const result = await tool.handler(tool.parameters.parse({
      bundleId: 'com.example.app', platform: 'ios', service: 'calendar',
    }) as Record<string, unknown>);

    expect(result).toContain('Granted');
    expect(harness.execCalls).toEqual([
      'xcrun simctl privacy "IOS-1" grant "calendar" "com.example.app"',
    ]);
    expect(harness.execFileCalls.filter(([command]) => command === 'xcrun')).toHaveLength(1);
  });

  test('uses the originally resolved Android serial for permission reads', async () => {
    const harness = createContext({
      android: [
        'List of devices attached\nemulator-42\tdevice model:Pixel_8\n',
        'List of devices attached\nemulator-99\tdevice model:Pixel_8\n',
      ],
    });
    await permissionsPlugin.setup(harness.ctx);
    const tool = harness.tools.get('list_permissions')!;
    const result = await tool.handler(tool.parameters.parse({
      bundleId: 'com.example.app', platform: 'android',
    }) as Record<string, unknown>);

    expect(result).toContain('No permissions found');
    expect(harness.execCalls).toEqual([
      'adb -s "emulator-42" shell dumpsys package "com.example.app" 2>/dev/null',
    ]);
    expect(harness.execFileCalls.filter(([command]) => command === 'adb')).toHaveLength(1);
  });
});
