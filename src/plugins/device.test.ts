import { describe, expect, test } from 'bun:test';
import { describeMetroTarget } from './device.js';

describe('describeMetroTarget', () => {
  test('exposes app identity and attachability', () => {
    expect(
      describeMetroTarget({
        id: 'page-1',
        appId: 'com.example.app',
        title: 'Hermes React Native',
        description: 'React Native instance',
        type: 'node',
        deviceName: 'iPhone 17',
        webSocketDebuggerUrl: 'ws://127.0.0.1:8081/debug?page=1',
        reactNative: {
          logicalDeviceId: 'device-1',
          capabilities: { nativePageReloads: true },
        },
      }),
    ).toMatchObject({
      id: 'page-1',
      appId: 'com.example.app',
      logicalDeviceId: 'device-1',
      attachable: true,
    });
  });

  test('exposes rejection reasons', () => {
    expect(
      describeMetroTarget({
        id: 'worklet',
        title: 'anonymous',
        description: 'Worklet Runtime',
        type: 'node',
        webSocketDebuggerUrl: 'ws://127.0.0.1:8081/debug?page=2',
      }),
    ).toMatchObject({
      attachable: false,
      reason: 'auxiliary-runtime',
    });
  });
});
