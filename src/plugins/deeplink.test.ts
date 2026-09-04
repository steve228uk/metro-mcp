import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import type { MetroTarget } from 'metro-bridge';
import type { ComponentNode, PluginContext, ToolHandlerResult } from '../plugin.js';
import {
  deeplinkPlugin,
  extractAndroidSchemeDump,
  isValidAndroidApplicationId,
  parseBundleUrlSchemes,
} from './deeplink.js';

type RegisteredTool = {
  parameters: z.ZodType;
  handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult>;
};

function createHarness(options: {
  target?: MetroTarget | null;
  targets?: Array<MetroTarget | null>;
  connected?: boolean;
  iosPlist?: unknown;
  appContainer?: string;
  androidDump?: string;
  androidInventory?: string;
} = {}) {
  const tools = new Map<string, RegisteredTool>();
  const calls: Array<{
    command: string;
    args: string[];
    options?: { maxBuffer?: number };
  }> = [];
  const target = options.target === undefined ? {
    id: 'target',
    title: 'Test app',
    description: 'React Native',
    type: 'node',
    appId: 'com.example.app',
    deviceName: 'iPhone 16',
    reactNative: { logicalDeviceId: 'SIM-UDID' },
  } satisfies MetroTarget : options.target;
  let targetCallCount = 0;
  const registerTool: PluginContext['registerTool'] = (name, config) => {
    tools.set(name, {
      parameters: config.parameters,
      handler: config.handler as RegisteredTool['handler'],
    });
  };
  const ctx: PluginContext = {
    cdp: {
      on: () => {},
      off: () => {},
      isConnected: options.connected ?? true,
      getTarget: () => {
        if (!options.targets) return target;
        const index = Math.min(targetCallCount, options.targets.length - 1);
        targetCallCount += 1;
        return options.targets[index] ?? target;
      },
      send: async () => ({}),
    },
    events: { on: () => {}, off: () => {}, isConnected: () => true },
    registerTool,
    registerResource: () => {},
    registerAppResource: () => {},
    registerPrompt: () => {},
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    metro: { host: 'localhost', port: 8081, fetch: async () => new Response() },
    exec: async () => '',
    execFile: async (command, args, execOptions) => {
      calls.push(execOptions ? { command, args, options: execOptions } : { command, args });
      if (command === 'xcrun' && args[1] === 'list') {
        return Buffer.from(JSON.stringify({ devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
            { name: 'iPhone 16', udid: 'SIM-UDID', state: 'Booted' },
          ],
        } }));
      }
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return Buffer.from(options.androidInventory ?? 'List of devices attached\n');
      }
      if (command === 'xcrun' && args[1] === 'get_app_container') {
        return Buffer.from(options.appContainer ?? '/tmp/Test.app\n');
      }
      if (command === 'plutil') {
        return Buffer.from(JSON.stringify(options.iosPlist ?? {}));
      }
      return Buffer.from(options.androidDump ?? '');
    },
    format: {
      summarize: () => '', compact: JSON.stringify, truncate: (value: string) => value,
      structureOnly: (value: ComponentNode) => value,
    },
    evalInApp: async () => null,
    getActiveDeviceKey: () => null,
    getActiveDeviceName: () => null,
    notifyResourceUpdated: () => {},
  };
  return { ctx, calls, tools, getTargetCallCount: () => targetCallCount, setup: async () => {
    await deeplinkPlugin.setup(ctx);
    return tools.get('list_url_schemes')!;
  } };
}

async function call(tool: RegisteredTool, args: Record<string, unknown>) {
  return tool.handler(tool.parameters.parse(args) as Record<string, unknown>);
}

describe('list_url_schemes', () => {
  test('parses and deduplicates all URL schemes from multiple iOS URL types', () => {
    expect(parseBundleUrlSchemes({
      CFBundleURLTypes: [
        { CFBundleURLSchemes: ['first', 'shared', ''] },
        { CFBundleURLSchemes: ['shared', 'second', 42] },
      ],
    })).toEqual(['first', 'shared', 'second']);
  });

  test('reads the selected installed app Info.plist with literal executable arguments', async () => {
    const harness = createHarness({
      appContainer: '/tmp/App With Spaces.app',
      iosPlist: { CFBundleURLTypes: [{ CFBundleURLSchemes: ['first', 'second'] }] },
    });
    const tool = await harness.setup();
    expect(await call(tool, { bundleId: 'com.example.requested' })).toEqual(['first', 'second']);
    expect(harness.calls).toContainEqual({
      command: 'xcrun',
      args: ['simctl', 'get_app_container', 'SIM-UDID', 'com.example.requested', 'app'],
    });
    expect(harness.calls).toContainEqual({
      command: 'plutil',
      args: ['-convert', 'json', '-o', '-', '/tmp/App With Spaces.app/Info.plist'],
    });
  });

  test('uses the connected Metro appId when bundleId is omitted and does not evaluate Hermes require', async () => {
    const harness = createHarness({
      iosPlist: { CFBundleURLTypes: [{ CFBundleURLSchemes: ['connected'] }] },
    });
    const tool = await harness.setup();
    expect(await call(tool, {})).toEqual(['connected']);
    expect(harness.calls.some(({ command }) => command === 'plutil')).toBe(true);
  });

  test('reports missing URL metadata without treating malformed entries as schemes', async () => {
    const harness = createHarness({ iosPlist: { CFBundleDisplayName: 'No links' } });
    const tool = await harness.setup();
    expect(await call(tool, {})).toBe('No URL schemes found.');
    expect(parseBundleUrlSchemes({ CFBundleURLTypes: [{ CFBundleURLSchemes: 'not-an-array' }] })).toEqual([]);
  });

  test('keeps Android package discovery serial scoped and returns the established dump text', async () => {
    const harness = createHarness({
      target: {
        id: 'android-target', title: 'Android app', description: 'React Native', type: 'node',
        appId: 'com.example.android', deviceName: 'Pixel 8',
        reactNative: { logicalDeviceId: 'emulator-2' },
      },
      androidDump: 'IntentFilter:\n  scheme:\n    Scheme: "example"\n  host: example.test\n',
      androidInventory: 'List of devices attached\nemulator-2\tdevice model:Pixel_8\n',
    });
    // Replace the iOS inventory response with an unavailable inventory in the
    // fixture by relying on the connected Android target match.
    const tool = await harness.setup();
    expect(await call(tool, {})).toContain('scheme:');
    expect(harness.calls).toContainEqual({
      command: 'adb',
      args: ['devices', '-l'],
    });
    expect(harness.calls).toContainEqual({
      command: 'adb',
      args: ['-s', 'emulator-2', 'shell', 'pm', 'dump', 'com.example.android'],
      options: { maxBuffer: 64 * 1024 * 1024 },
    });
  });

  test('uses an explicit Android platform when the connected target is iOS', async () => {
    const harness = createHarness({
      androidDump: 'IntentFilter:\n  scheme:\n    Scheme: "android-example"\n',
      androidInventory: 'List of devices attached\nemulator-2\tdevice model:Pixel_8\n',
    });
    const tool = await harness.setup();

    expect(await call(tool, {
      platform: 'android',
      bundleId: 'com.example.android',
    })).toContain('Scheme: "android-example"');
    expect(harness.calls).toContainEqual({
      command: 'adb',
      args: ['-s', 'emulator-2', 'shell', 'pm', 'dump', 'com.example.android'],
      options: { maxBuffer: 64 * 1024 * 1024 },
    });
    expect(harness.calls.some(({ command }) => command === 'xcrun')).toBe(false);
  });

  test('rejects unsafe Android IDs before running adb', async () => {
    for (const bundleId of ['com.example;id', 'com.example app', 'com.example$(id)']) {
      const harness = createHarness();
      const tool = await harness.setup();

      expect(await call(tool, { platform: 'android', bundleId }))
        .toContain(`Invalid Android application ID ${JSON.stringify(bundleId)}`);
      expect(harness.calls.filter(({ command }) => command === 'adb')).toEqual([]);
      expect(isValidAndroidApplicationId(bundleId)).toBe(false);
    }
  });

  test('rejects an unsafe connected Android app ID before package dump dispatch', async () => {
    const bundleId = 'com.example;id';
    const harness = createHarness({
      target: {
        id: 'android-target', title: 'Android app', description: 'React Native', type: 'node',
        appId: bundleId, deviceName: 'Pixel 8',
        reactNative: { logicalDeviceId: 'emulator-2' },
      },
      androidInventory: 'List of devices attached\nemulator-2\tdevice model:Pixel_8\n',
    });
    const tool = await harness.setup();

    expect(await call(tool, { platform: 'auto' }))
      .toContain(`Invalid Android application ID ${JSON.stringify(bundleId)}`);
    expect(harness.calls.some(({ command, args }) =>
      command === 'adb' && args.includes('pm'))).toBe(false);
  });

  test('accepts Android application IDs with valid segment syntax', () => {
    expect(isValidAndroidApplicationId('com.example.app_2')).toBe(true);
    expect(isValidAndroidApplicationId('Com.Example2.Feature_')).toBe(true);
    expect(isValidAndroidApplicationId('example')).toBe(false);
    expect(isValidAndroidApplicationId('2com.example')).toBe(false);
  });

  test('requires an explicit app ID before discovering an explicit platform', async () => {
    for (const platform of ['ios', 'android'] as const) {
      const harness = createHarness();
      const tool = await harness.setup();
      expect(await call(tool, { platform }))
        .toBe(`Bundle ID is required when selecting the ${platform} platform explicitly.`);
      expect(harness.calls).toEqual([]);
    }
  });

  test('uses one connected-target snapshot for auto device and app ID selection', async () => {
    const iosTarget = {
      id: 'ios-target', title: 'iOS app', description: 'React Native', type: 'node',
      appId: 'com.example.ios', deviceName: 'iPhone 16',
      reactNative: { logicalDeviceId: 'SIM-UDID' },
    } satisfies MetroTarget;
    const androidTarget = {
      id: 'android-target', title: 'Android app', description: 'React Native', type: 'node',
      appId: 'com.example.android', deviceName: 'Pixel 8',
      reactNative: { logicalDeviceId: 'emulator-2' },
    } satisfies MetroTarget;
    const harness = createHarness({
      targets: [iosTarget, androidTarget],
      androidInventory: 'List of devices attached\nemulator-2\tdevice model:Pixel_8\n',
    });
    const tool = await harness.setup();

    expect(await call(tool, {})).toBe('No URL schemes found.');
    expect(harness.getTargetCallCount()).toBe(1);
    expect(harness.calls).toContainEqual({
      command: 'xcrun',
      args: ['simctl', 'get_app_container', 'SIM-UDID', 'com.example.ios', 'app'],
    });
    expect(harness.calls.some(({ command, args }) =>
      command === 'adb' && args.includes('dump'))).toBe(false);
  });

  test('requires a bundle ID without using stale target metadata after disconnect', async () => {
    const harness = createHarness({
      connected: false,
      target: {
        id: 'stale-target', title: 'Stale app', description: 'React Native', type: 'node',
        appId: 'com.example.stale', deviceName: 'Old iPhone',
        reactNative: { logicalDeviceId: 'STALE-UDID' },
      },
    });
    const tool = await harness.setup();

    expect(await call(tool, {}))
      .toBe('Bundle ID is required when no connected app target is available.');
    expect(harness.calls).toEqual([]);
    expect(harness.getTargetCallCount()).toBe(0);
  });

  test('discovers and queries the replacement sole simulator for an explicit bundle ID', async () => {
    const harness = createHarness({
      connected: false,
      target: {
        id: 'stale-target', title: 'Stale app', description: 'React Native', type: 'node',
        appId: 'com.example.stale', deviceName: 'Old iPhone',
        reactNative: { logicalDeviceId: 'STALE-UDID' },
      },
      iosPlist: { CFBundleURLTypes: [{ CFBundleURLSchemes: ['replacement'] }] },
    });
    const tool = await harness.setup();

    expect(await call(tool, { bundleId: 'com.example.requested' })).toEqual(['replacement']);
    expect(harness.calls).toContainEqual({
      command: 'xcrun',
      args: ['simctl', 'list', 'devices', 'booted', '--json'],
    });
    expect(harness.calls).toContainEqual({
      command: 'xcrun',
      args: ['simctl', 'get_app_container', 'SIM-UDID', 'com.example.requested', 'app'],
    });
    expect(harness.calls.some(({ args }) => args.includes('STALE-UDID'))).toBe(false);
    expect(harness.getTargetCallCount()).toBe(0);
  });
});

test('extractAndroidSchemeDump preserves matching lines and their context', () => {
  expect(extractAndroidSchemeDump('before\nscheme:\n  Scheme: "x"\nafter\n')).toBe('scheme:\n  Scheme: "x"\nafter');
  expect(extractAndroidSchemeDump('scheme one\n1\n2\n3\nscheme two\n5\n6\n7\n8\n9\nexcluded\n')).toBe('scheme one\n1\n2\n3\nscheme two\n5\n6\n7\n8\n9');
  expect(extractAndroidSchemeDump('nothing here')).toBe('');
});
