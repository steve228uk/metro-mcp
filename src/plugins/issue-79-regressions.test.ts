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
  connected?: boolean;
  packageName?: string | null;
  target?: { deviceName: string; logicalDeviceId: string };
  targetTitle?: string;
  targetAfterInventory?: { title?: string; appId?: string };
}) {
  const tools = new Map<string, RegisteredTool>();
  const execCalls: string[] = [];
  const execFileCalls: string[][] = [];
  const ios = [...(options.ios ?? [JSON.stringify({ devices: {} })])];
  const android = [...(options.android ?? (options.inventory === 'android'
    ? ['List of devices attached\nemulator-42\tdevice model:Pixel_8\n']
    : []))];
  let target: {
    id: string;
    title: string;
    description: string;
    type: string;
    deviceName: string;
    reactNative: { logicalDeviceId: string };
    appId?: string;
  } = {
    id: 'metro-target',
    title: options.targetTitle ?? 'com.example.app (React Native)',
    description: 'React Native',
    type: 'node',
    deviceName: options.target?.deviceName ?? 'Pixel 8',
    reactNative: { logicalDeviceId: options.target?.logicalDeviceId ?? 'emulator-42' },
  } as never;

  const ctx: PluginContext = {
    cdp: {
      on: () => {}, off: () => {}, isConnected: options.connected ?? true,
      getTarget: () => target,
      send: async () => ({}),
    },
    events: { on: () => {}, off: () => {}, isConnected: () => true },
    registerTool: (name, config) => tools.set(name, {
      parameters: config.parameters,
      handler: config.handler as RegisteredTool['handler'],
    }),
    registerResource: () => {}, registerAppResource: () => {}, registerPrompt: () => {},
    config: options.packageName === undefined
      ? { packageName: 'com.example.app' }
      : options.packageName === null
        ? {}
        : { packageName: options.packageName },
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
      if (command === 'xcrun' && options.targetAfterInventory) {
        target = {
          ...target,
          ...options.targetAfterInventory,
        };
      }
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
  test('requests a package name instead of using a stale disconnected target title', async () => {
    const harness = createContext({
      inventory: 'android',
      connected: false,
      packageName: null,
      target: { deviceName: 'Old emulator', logicalDeviceId: 'old-serial' },
    });
    await permissionsPlugin.setup(harness.ctx);
    const tool = harness.tools.get('grant_permission')!;

    const result = await tool.handler(tool.parameters.parse({
      platform: 'auto',
      service: 'camera',
    }) as Record<string, unknown>);

    expect(result).toBe('Bundle ID / package name required. Provide bundleId or ensure the app is running.');
    expect(harness.execCalls).toEqual([]);
  });

  test('filesystem resolves a replacement device when its disconnected target is stale', async () => {
    const harness = createContext({
      inventory: 'android',
      connected: false,
      target: { deviceName: 'Old emulator', logicalDeviceId: 'old-serial' },
    });
    await filesystemPlugin.setup(harness.ctx);
    const tool = harness.tools.get('read_file')!;

    await tool.handler(tool.parameters.parse({
      path: '/data/data/com.example.app/files/state.json',
      bundleId: 'com.example.app',
      platform: 'auto',
    }) as Record<string, unknown>);

    expect(harness.execCalls).toEqual([
      'adb -s "emulator-42" shell run-as com.example.app dd if="/data/data/com.example.app/files/state.json" bs=51200 count=1 2>/dev/null',
    ]);
  });

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

  test('derives the permission app ID from the same target snapshot as inventory', async () => {
    const ios = (udid: string) => JSON.stringify({ devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
        { name: 'iPhone 16', udid, state: 'Booted' },
      ],
    } });
    const harness = createContext({
      ios: [ios('IOS-1')],
      target: { deviceName: 'iPhone 16', logicalDeviceId: 'IOS-1' },
      targetAfterInventory: { title: 'com.other.app (React Native)' },
    });
    await permissionsPlugin.setup(harness.ctx);
    const tool = harness.tools.get('grant_permission')!;
    const result = await tool.handler(tool.parameters.parse({
      platform: 'ios', service: 'calendar',
    }) as Record<string, unknown>);

    expect(result).toContain('Granted');
    expect(harness.execCalls).toEqual([
      'xcrun simctl privacy "IOS-1" grant "calendar" "com.example.app"',
    ]);
  });

  test('does not reuse an app ID across permission plugin targets', async () => {
    const ios = (udid: string) => JSON.stringify({ devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
        { name: 'iPhone 16', udid, state: 'Booted' },
      ],
    } });
    const first = createContext({
      ios: [ios('IOS-1')],
      target: { deviceName: 'iPhone 16', logicalDeviceId: 'IOS-1' },
      targetTitle: 'com.first.app (React Native)',
    });
    await permissionsPlugin.setup(first.ctx);
    const firstTool = first.tools.get('grant_permission')!;
    await firstTool.handler(firstTool.parameters.parse({
      platform: 'ios', service: 'calendar',
    }) as Record<string, unknown>);

    const second = createContext({
      ios: [ios('IOS-2')],
      target: { deviceName: 'iPhone 16', logicalDeviceId: 'IOS-2' },
      targetTitle: 'com.second.app (React Native)',
    });
    await permissionsPlugin.setup(second.ctx);
    const secondTool = second.tools.get('grant_permission')!;
    await secondTool.handler(secondTool.parameters.parse({
      platform: 'ios', service: 'calendar',
    }) as Record<string, unknown>);

    expect(second.execCalls).toEqual([
      'xcrun simctl privacy "IOS-2" grant "calendar" "com.second.app"',
    ]);
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
