import { describe, expect, test } from 'bun:test';
import type { MetroServerInfo, MetroTarget } from 'metro-bridge';
import {
  createMetroTargetPin,
  selectMetroTarget,
  selectPinnedTarget,
} from './target-selection.js';

function target(
  id: string,
  overrides: Partial<MetroTarget> = {},
): MetroTarget {
  return {
    id,
    appId: 'com.example.app',
    title: 'Hermes React Native',
    description: 'React Native instance',
    type: 'node',
    deviceName: 'iPhone 17',
    webSocketDebuggerUrl: `ws://127.0.0.1:8081/debug?page=${id}`,
    reactNative: { logicalDeviceId: 'device-1' },
    ...overrides,
  };
}

function server(
  targets: MetroTarget[],
  overrides: Partial<MetroServerInfo> = {},
): MetroServerInfo {
  return { host: '127.0.0.1', port: 8081, targets, ...overrides };
}

describe('pinned Metro target selection', () => {
  test('reconnects to the same app after its page id changes', () => {
    const originalServer = server([target('page-1')]);
    const pin = createMetroTargetPin(originalServer, originalServer.targets[0]);
    const reloaded = target('page-2');

    expect(selectPinnedTarget([reloaded], pin)).toBe(reloaded);
  });

  test('falls back from logical device id to app id and device name', () => {
    const originalServer = server([target('page-1')]);
    const pin = createMetroTargetPin(originalServer, originalServer.targets[0]);
    const reloaded = target('page-2', {
      reactNative: { logicalDeviceId: 'replacement-device-id' },
    });

    expect(selectPinnedTarget([reloaded], pin)).toBe(reloaded);
  });

  test('refuses auxiliary runtimes and another device', () => {
    const originalServer = server([target('page-1')]);
    const pin = createMetroTargetPin(originalServer, originalServer.targets[0]);
    const worklet = target('worklet', {
      title: 'React Native animations',
      description: 'Worklet Runtime',
    });
    const otherDevice = target('page-2', {
      deviceName: 'iPhone 18',
      reactNative: { logicalDeviceId: 'device-2' },
    });

    expect(selectPinnedTarget([worklet, otherDevice], pin)).toBeNull();
  });

  test('rejects a recycled target id with conflicting app identity', () => {
    const originalServer = server([target('page-1')]);
    const pin = createMetroTargetPin(originalServer, originalServer.targets[0]);
    const replacement = target('page-1', {
      appId: 'com.example.other',
      deviceName: 'iPhone 18',
      reactNative: { logicalDeviceId: 'device-2' },
    });

    expect(selectPinnedTarget([replacement], pin)).toBeNull();
  });

  test('stays on the same Metro server', () => {
    const originalServer = server([target('page-1')]);
    const pin = createMetroTargetPin(originalServer, originalServer.targets[0]);
    const differentServer = server([target('page-2')], { port: 19000 });

    expect(selectMetroTarget([differentServer], pin)).toBeNull();
  });
});
