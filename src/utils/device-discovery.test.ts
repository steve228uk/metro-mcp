import { describe, expect, test } from 'bun:test';
import {
  adbPrefix,
  discoverBootedSimulators,
  getConnectedDeviceTarget,
  isSafeDeviceId,
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
  iosFailure?: boolean;
  iosUnavailable?: boolean;
  androidFailure?: boolean;
  androidUnavailable?: boolean;
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
        if (options.iosUnavailable) {
          throw Object.assign(new Error('spawn xcrun ENOENT'), { code: 'ENOENT' });
        }
        if (options.iosFailure) throw new Error('simctl unavailable');
        const output = ios.shift() ?? ios.at(-1) ?? iosInventory([]);
        return Buffer.from(output);
      }
      if (options.androidUnavailable) {
        throw Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' });
      }
      if (options.androidFailure) throw new Error('adb unavailable');
      return Buffer.from(options.android ?? 'List of devices attached\n');
    },
  };
}

describe('device discovery', () => {
  test('ignores stale target metadata after CDP disconnects', () => {
    const target = {
      deviceName: 'Old simulator',
      reactNative: { logicalDeviceId: 'OLD-UDID' },
    };
    const cdp = {
      getTarget: () => target,
      isConnected: false,
    };

    expect(getConnectedDeviceTarget({ cdp })).toBeUndefined();
    expect(getConnectedDeviceTarget({ cdp: { ...cdp, isConnected: true } })).toBe(target);
  });

  test('accepts a valid bracketed IPv6 ADB serial and keeps it quoted', () => {
    const serial = '[2001:db8::1]:5555';
    expect(parseAndroidDevices(`List of devices attached\n${serial}\tdevice model:Pixel_8\n`))
      .toEqual([{ id: serial, status: 'device', model: 'Pixel_8' }]);
    expect(adbPrefix(serial)).toBe('adb -s "[2001:db8::1]:5555"');
    expect(isSafeDeviceId('[not-an-ipv6]:5555')).toBe(false);
    expect(isSafeDeviceId('[2001:db8::1]:70000')).toBe(false);
  });

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

  test('uses a unique Android name when xcrun is unavailable for a connected target', async () => {
    const runner = runnerFor({
      iosUnavailable: true,
      android: 'List of devices attached\nemulator-42\tdevice model:Pixel_8\n',
    });
    await expect(resolveDevice(runner, 'auto', {
      deviceName: 'Pixel 8',
      reactNative: { logicalDeviceId: 'opaque-inspector-id' },
    })).resolves.toMatchObject({ platform: 'android', id: 'emulator-42' });
  });

  test('uses the sole Android device when xcrun is unavailable and Metro ID is opaque', async () => {
    const runner = runnerFor({
      iosUnavailable: true,
      android: 'List of devices attached\nemulator-42\tdevice model:Pixel_8\n',
    });
    await expect(resolveDevice(runner, 'auto', {
      reactNative: { logicalDeviceId: 'opaque-inspector-id' },
    })).resolves.toMatchObject({ platform: 'android', id: 'emulator-42' });
  });

  test('rejects a contradictory Android name when xcrun is unavailable', async () => {
    const runner = runnerFor({
      iosUnavailable: true,
      android: 'List of devices attached\nemulator-42\tdevice model:Pixel_8\n',
    });
    await expect(resolveDevice(runner, 'auto', {
      deviceName: 'Other device',
      reactNative: { logicalDeviceId: 'opaque-inspector-id' },
    })).rejects.toThrow('iOS simulator discovery failed');
  });

  test('uses a unique iOS name when adb is unavailable for a connected target', async () => {
    const runner = runnerFor({
      ios: [iosInventory([
        { name: 'iPhone 16', udid: 'IOS-16', state: 'Booted' },
        { name: 'iPhone 17', udid: 'IOS-17', state: 'Booted' },
      ])],
      androidUnavailable: true,
    });
    await expect(resolveDevice(runner, 'auto', {
      deviceName: 'iPhone 17',
      reactNative: { logicalDeviceId: 'opaque-inspector-id' },
    })).resolves.toMatchObject({ platform: 'ios', id: 'IOS-17' });
  });

  test('uses the sole iOS simulator when adb is unavailable and Metro ID is opaque', async () => {
    const runner = runnerFor({
      androidUnavailable: true,
    });
    await expect(resolveDevice(runner, 'auto', {
      reactNative: { logicalDeviceId: 'opaque-inspector-id' },
    })).resolves.toMatchObject({ platform: 'ios', id: 'IOS-16' });
  });

  test('rejects a contradictory iOS name when adb is unavailable', async () => {
    const runner = runnerFor({
      androidUnavailable: true,
    });
    await expect(resolveDevice(runner, 'auto', {
      deviceName: 'Other simulator',
      reactNative: { logicalDeviceId: 'opaque-inspector-id' },
    })).rejects.toThrow('Android device discovery failed');
  });

  test('does not treat a generic iOS inventory error as a missing executable', async () => {
    const runner = runnerFor({
      iosFailure: true,
      android: 'List of devices attached\nemulator-42\tdevice model:Pixel_8\n',
    });
    await expect(resolveDevice(runner, 'auto', {
      deviceName: 'Pixel 8',
      reactNative: { logicalDeviceId: 'opaque-inspector-id' },
    })).rejects.toThrow('iOS simulator discovery failed');
  });

  test('does not use a sole fallback for a connected target with no identity metadata', async () => {
    const runner = runnerFor({
      iosFailure: true,
      android: 'List of devices attached\nemulator-42\tdevice model:Pixel_8\n',
    });
    await expect(resolveDevice(runner, 'auto', {})).rejects.toThrow(
      'iOS simulator discovery failed',
    );
  });

  test('does not use an iOS name or sole fallback when Android discovery fails for a connected target', async () => {
    const runner = runnerFor({
      ios: [iosInventory([
        { name: 'Pixel 8', udid: 'IOS-16', state: 'Booted' },
      ])],
      androidFailure: true,
    });
    await expect(resolveDevice(runner, 'auto', {
      deviceName: 'Pixel 8',
      reactNative: { logicalDeviceId: 'opaque-inspector-id' },
    })).rejects.toThrow('Android device discovery failed');
  });

  test('keeps exact connected IDs usable when the other inventory is unavailable', async () => {
    const runner = runnerFor({
      iosFailure: true,
      android: 'List of devices attached\nemulator-42\tdevice model:Pixel_8\n',
    });
    expect(await resolveDevice(runner, 'auto', {
      deviceName: 'Pixel 8',
      reactNative: { logicalDeviceId: 'emulator-42' },
    })).toMatchObject({ platform: 'android', id: 'emulator-42' });
  });

  test('keeps sole fallback usable without a connected target after an inventory failure', async () => {
    const runner = runnerFor({
      iosFailure: true,
      android: 'List of devices attached\nemulator-42\tdevice model:Pixel_8\n',
    });
    expect(await resolveDevice(runner, 'auto')).toMatchObject({
      platform: 'android', id: 'emulator-42',
    });
  });

  test('reports ambiguity when an unmatched connected target has devices on both platforms', async () => {
    const runner = runnerFor({
      ios: [iosInventory([
        { name: 'iPhone 16', udid: 'IOS-16', state: 'Booted' },
      ])],
      android: 'List of devices attached\nemulator-42\tdevice model:Pixel_8\n',
    });
    await expect(resolveDevice(runner, 'auto', {
      deviceName: 'Unknown device',
      reactNative: { logicalDeviceId: 'opaque-inspector-id' },
    })).rejects.toThrow('Ambiguous available devices across iOS and Android');
  });

  test('reports ambiguity when no target is connected and both platforms have candidates', async () => {
    const runner = runnerFor({
      ios: [iosInventory([
        { name: 'iPhone 16', udid: 'IOS-16', state: 'Booted' },
      ])],
      android: 'List of devices attached\nemulator-42\tdevice model:Pixel_8\n',
    });
    await expect(resolveDevice(runner, 'auto')).rejects.toThrow(
      'Ambiguous available devices across iOS and Android',
    );
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

  test('uses a sole iOS simulator when Android discovery is successfully empty and the Metro ID is opaque', async () => {
    const runner = runnerFor({
      ios: [iosInventory([
        { name: 'iPhone 16', udid: 'IOS-16', state: 'Booted' },
      ])],
      android: 'List of devices attached\n',
    });
    await expect(resolveDevice(runner, 'auto', {
      reactNative: { logicalDeviceId: 'opaque-inspector-id' },
    })).resolves.toMatchObject({ platform: 'ios', id: 'IOS-16' });
  });

  test('uses a sole Android device when iOS discovery is successfully empty and the Metro ID is opaque', async () => {
    const runner = runnerFor({
      ios: [iosInventory([])],
      android: 'List of devices attached\nemulator-42\tdevice model:Pixel_8\n',
    });
    await expect(resolveDevice(runner, 'auto', {
      reactNative: { logicalDeviceId: 'opaque-inspector-id' },
    })).resolves.toMatchObject({ platform: 'android', id: 'emulator-42' });
  });

  test('does not use a sole iOS fallback for a contradictory connected Android target', async () => {
    const runner = runnerFor({
      ios: [iosInventory([
        { name: 'iPhone 16', udid: 'IOS-16', state: 'Booted' },
      ])],
      android: 'List of devices attached\n',
    });
    await expect(resolveDevice(runner, 'auto', {
      deviceName: 'Pixel 8',
      reactNative: { logicalDeviceId: 'emulator-42' },
    })).rejects.toThrow('does not match the sole available iOS simulator');
  });

  test('does not use a sole Android fallback for a contradictory connected iOS target', async () => {
    const runner = runnerFor({
      ios: [iosInventory([])],
      android: 'List of devices attached\nemulator-42\tdevice model:Pixel_8\n',
    });
    await expect(resolveDevice(runner, 'auto', {
      deviceName: 'iPhone 16',
      reactNative: { logicalDeviceId: 'IOS-16' },
    })).rejects.toThrow('does not match the sole available Android device');
  });

  test('checks exact target IDs before a colliding iOS device name', async () => {
    const runner = runnerFor({
      ios: [iosInventory([
        { name: 'Pixel_8', udid: 'IOS-16', state: 'Booted' },
      ])],
      android: 'List of devices attached\nemulator-42\tdevice model:Pixel_8\n',
    });
    const device = await resolveDevice(runner, 'auto', {
      deviceName: 'Pixel_8',
      reactNative: { logicalDeviceId: 'emulator-42' },
    });
    expect(device).toMatchObject({ platform: 'android', id: 'emulator-42' });
  });

  test('reports ambiguity when an opaque target name matches both platforms', async () => {
    const runner = runnerFor({
      ios: [iosInventory([
        { name: 'Pixel 8', udid: 'IOS-16', state: 'Booted' },
      ])],
      android: 'List of devices attached\nemulator-42\tdevice model:Pixel_8\n',
    });
    await expect(resolveDevice(runner, 'auto', {
      deviceName: 'Pixel 8',
      reactNative: { logicalDeviceId: 'opaque-metro-inspector-id' },
    })).rejects.toThrow('Ambiguous connected device name "Pixel 8" across iOS and Android');
  });

  test('does not hide an ambiguous iOS name behind a unique Android name', async () => {
    const runner = runnerFor({
      ios: [iosInventory([
        { name: 'Pixel 8', udid: 'IOS-16', state: 'Booted' },
        { name: 'Pixel 8', udid: 'IOS-17', state: 'Booted' },
      ])],
      android: 'List of devices attached\nemulator-42\tdevice model:Pixel_8\n',
    });
    await expect(resolveDevice(runner, 'auto', {
      deviceName: 'Pixel 8',
      reactNative: { logicalDeviceId: 'opaque-metro-inspector-id' },
    })).rejects.toThrow('Ambiguous connected device name "Pixel 8" across iOS and Android');
  });

  test('keeps explicit platform selection independent of cross-platform names', async () => {
    const runner = runnerFor({
      ios: [iosInventory([
        { name: 'Pixel 8', udid: 'IOS-16', state: 'Booted' },
      ])],
      android: 'List of devices attached\nemulator-42\tdevice model:Pixel_8\n',
    });
    const target = {
      deviceName: 'Pixel 8',
      reactNative: { logicalDeviceId: 'opaque-metro-inspector-id' },
    };
    expect(await resolveDevice(runner, 'ios', target)).toMatchObject({
      platform: 'ios', id: 'IOS-16',
    });
    expect(await resolveDevice(runner, 'android', target)).toMatchObject({
      platform: 'android', id: 'emulator-42',
    });
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

  test('matches ADB model underscores to Metro names containing spaces', async () => {
    for (const platform of ['auto', 'android'] as const) {
      const runner = runnerFor({
        android: 'List of devices attached\none\tdevice model:Pixel_8\ntwo\tdevice model:Pixel_9_Pro\n',
      });
      expect(await resolveDevice(runner, platform, {
        deviceName: 'Pixel 9 Pro', reactNative: { logicalDeviceId: 'opaque-inspector-id' },
      })).toMatchObject({ platform: 'android', id: 'two' });
      const duplicates = runnerFor({
        android: 'List of devices attached\none\tdevice model:Pixel_8\ntwo\tdevice model:Pixel_8\n',
      });
      await expect(resolveDevice(duplicates, platform, { deviceName: 'Pixel 8' }))
        .rejects.toThrow('Ambiguous Android devices named');
    }
  });

  test('matches the full ADB model sanitization while keeping collisions ambiguous', async () => {
    for (const [name, model] of [['SM-G991B', 'SM_G991B'], ['Pixel (Pro)', 'Pixel__Pro_'], ['Téléphone', 'T__l__phone']]) {
      for (const platform of ['auto', 'android'] as const) {
        const runner = runnerFor({
          android: `List of devices attached\none\tdevice model:Other\ntwo\tdevice model:${model}\n`,
        });
        expect(await resolveDevice(runner, platform, {
          deviceName: name, reactNative: { logicalDeviceId: 'opaque-inspector-id' },
        })).toMatchObject({ platform: 'android', id: 'two' });
      }
    }
    const collision = runnerFor({
      android: 'List of devices attached\none\tdevice model:SM_G991B\ntwo\tdevice model:SM_G991B\n',
    });
    await expect(resolveDevice(collision, 'android', { deviceName: 'SM-G991B' }))
      .rejects.toThrow('Ambiguous Android devices named');
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
