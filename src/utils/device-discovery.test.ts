import { describe, expect, test } from 'bun:test';
import {
  discoverBootedSimulators,
  parseAndroidDevices,
  parseBootedSimulators,
  resolveDevice,
  type DeviceDiscoveryRunner,
} from './device-discovery.js';

const iosInventory = (devices: Array<Record<string, string>>) =>
  JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-0': devices,
    },
  });

function runnerFor(options: {
  ios?: string[];
  android?: string;
}): DeviceDiscoveryRunner & { calls: string[][] } {
  const ios = [...(options.ios ?? [iosInventory([
    { name: 'iPhone 16', udid: 'IOS-16', state: 'Booted' },
  ])])];
  const calls: string[][] = [];
  return {
    calls,
    async execFile(command, args) {
      calls.push([command, ...args]);
      if (command === 'xcrun') {
        const output = ios.shift() ?? ios.at(-1) ?? iosInventory([]);
        return Buffer.from(output);
      }
      return Buffer.from(options.android ?? 'List of devices attached\n');
    },
  };
}

describe('device discovery', () => {
  test('uses literal simctl JSON arguments and resolves a connected target by UDID', async () => {
    const runner = runnerFor({});
    const device = await resolveDevice(runner, 'ios', {
      deviceName: 'iPhone 16',
      reactNative: { logicalDeviceId: 'IOS-16' },
    });

    expect(device).toEqual({
      platform: 'ios',
      id: 'IOS-16',
      name: 'iPhone 16',
      runtime: 'iOS-18-0',
    });
    expect(runner.calls[0]).toEqual([
      'xcrun',
      'simctl',
      'list',
      'devices',
      'booted',
      '--json',
    ]);
  });

  test('auto selection uses the sole authorized Android device when iOS is unavailable', async () => {
    const runner = runnerFor({
      ios: [],
      android: 'List of devices attached\nemulator-42\tdevice model:Pixel_8\n',
    });
    const device = await resolveDevice(runner, 'auto');
    expect(device).toMatchObject({ platform: 'android', id: 'emulator-42' });
  });

  test('auto selection follows the connected Android target over booted iOS', async () => {
    const runner = runnerFor({
      ios: [iosInventory([
        { name: 'iPhone 16', udid: 'IOS-16', state: 'Booted' },
      ])],
      android: 'List of devices attached\nemulator-42\tdevice model:Pixel_8\n',
    });
    const device = await resolveDevice(runner, 'auto', {
      deviceName: 'Pixel_8',
      reactNative: { logicalDeviceId: 'emulator-42' },
    });
    expect(device).toMatchObject({ platform: 'android', id: 'emulator-42' });
  });

  test('does not choose the first Android device when target identity is absent', async () => {
    const runner = runnerFor({
      ios: [iosInventory([])],
      android: 'List of devices attached\none\tdevice model:Pixel_8\ntwo\tdevice model:Pixel_9\n',
    });
    await expect(resolveDevice(runner, 'auto')).rejects.toThrow('Ambiguous Android devices');
  });

  test('missing models and duplicate model names never select an arbitrary Android device', async () => {
    const withoutModels = runnerFor({
      ios: [iosInventory([])],
      android: 'List of devices attached\none\tdevice\ntwo\tdevice\n',
    });
    await expect(resolveDevice(withoutModels, 'auto')).rejects.toThrow('Ambiguous Android devices');
    for (const platform of ['auto', 'android'] as const) {
      const duplicates = runnerFor({
        ios: [iosInventory([])],
        android: 'List of devices attached\none\tdevice model:Pixel_8\ntwo\tdevice model:Pixel_8\n',
      });
      await expect(resolveDevice(duplicates, platform, { deviceName: 'Pixel_8' }))
        .rejects.toThrow('Ambiguous Android devices named');
      expect(await resolveDevice(duplicates, platform, {
        deviceName: 'Pixel_8', reactNative: { logicalDeviceId: 'two' },
      })).toMatchObject({ platform: 'android', id: 'two' });
    }
  });

  test('reports ambiguity instead of choosing an arbitrary booted simulator', async () => {
    const runner = runnerFor({
      ios: [iosInventory([
        { name: 'iPhone 16', udid: 'IOS-16', state: 'Booted' },
        { name: 'iPhone 17', udid: 'IOS-17', state: 'Booted' },
      ])],
    });
    await expect(resolveDevice(runner, 'ios')).rejects.toThrow(
      'Ambiguous booted iOS simulators',
    );
  });

  test('matches a unique inventory name when Metro supplies an opaque logical ID', async () => {
    const runner = runnerFor({
      ios: [iosInventory([
        { name: 'First simulator', udid: 'IOS-1', state: 'Booted' },
        { name: 'Connected simulator', udid: 'IOS-2', state: 'Booted' },
      ])],
      android: 'List of devices attached\none\tdevice model:Pixel_8\ntwo\tdevice model:Pixel_9\n',
    });
    // Metro's logical ID is an inspector identity, not necessarily a simctl
    // UDID or adb serial. A unique inventory name remains usable evidence.
    expect(await resolveDevice(runner, 'ios', {
      deviceName: 'Connected simulator',
      reactNative: { logicalDeviceId: 'opaque-metro-inspector-id' },
    })).toMatchObject({ id: 'IOS-2' });
    expect(await resolveDevice(runner, 'android', {
      deviceName: 'Pixel_9',
      reactNative: { logicalDeviceId: 'another-opaque-inspector-id' },
    })).toMatchObject({ id: 'two' });
  });

  test('retries discovery on every call after a missed boot', async () => {
    const runner = runnerFor({
      ios: [iosInventory([]), iosInventory([
        { name: 'iPhone 16', udid: 'IOS-16', state: 'Booted' },
      ])],
    });
    expect(await resolveDevice(runner, 'ios')).toBeNull();
    expect(await resolveDevice(runner, 'ios')).toMatchObject({ id: 'IOS-16' });
    expect(runner.calls).toHaveLength(2);
  });

  test('excludes an unavailable booted entry and supports explicit platform selection', async () => {
    const runner = runnerFor({
      ios: [iosInventory([
        { name: 'Unavailable', udid: 'IOS-OLD', state: 'Booted', isAvailable: 'NO' },
        { name: 'Available', udid: 'IOS-NEW', state: 'Booted', isAvailable: 'YES' },
      ])],
      android: 'List of devices attached\nemulator-42\tdevice\n',
    });
    expect(await resolveDevice(runner, 'ios')).toMatchObject({ id: 'IOS-NEW' });
    // Explicit Android reads only adb and does not get shadowed by iOS state.
    expect(await resolveDevice(runner, 'android')).toMatchObject({ id: 'emulator-42' });
  });

  test('ignores booted watchOS runtimes when selecting an iOS app simulator', async () => {
    const runner = runnerFor({
      ios: [JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [
            { name: 'Apple Watch', udid: 'WATCH-1', state: 'Booted' },
          ],
          'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
            { name: 'iPhone 16', udid: 'IOS-16', state: 'Booted' },
          ],
        },
      })],
    });
    expect(await resolveDevice(runner, 'ios')).toMatchObject({ id: 'IOS-16' });
    const watchOnly = runnerFor({
      ios: [JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [
            { name: 'Apple Watch', udid: 'WATCH-1', state: 'Booted' },
          ],
        },
      })],
    });
    expect(await resolveDevice(watchOnly, 'ios')).toBeNull();
  });

  test('rejects malformed inventories and ignores unauthorized Android devices', async () => {
    expect(() => parseBootedSimulators('{"devices": []}')).toThrow(
      'missing devices map',
    );
    expect(parseAndroidDevices(
      'List of devices attached\noffline-1\toffline\nunauth-1\tunauthorized\n',
    )).toEqual([
      { id: 'offline-1', status: 'offline' },
      { id: 'unauth-1', status: 'unauthorized' },
    ]);
    const runner = runnerFor({
      android: 'List of devices attached\noffline-1\toffline\n',
    });
    expect(await resolveDevice(runner, 'android')).toBeNull();
    await expect(discoverBootedSimulators({
      execFile: async () => Buffer.from('not-json'),
    })).rejects.toThrow('Malformed iOS simulator inventory');
    expect(() => parseAndroidDevices(
      'List of devices attached\nserial;touch\tdevice\n',
    )).toThrow('invalid device serial');
  });
});
