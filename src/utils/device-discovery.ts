import type { PluginContext } from '../plugin.js';

/** A booted simulator as reported by CoreSimulatorService. */
export interface BootedSimulator {
  name: string;
  udid: string;
  state: string;
  runtime: string;
}

// UDIDs/serials are later passed as one shell argument by legacy plugin
// commands. Keep only identifier characters so inventory data cannot turn into
// shell syntax before those commands are migrated to execFile.
export function isSafeDeviceId(value: string): boolean {
  return /^[A-Za-z0-9._:-]+$/.test(value);
}

/** Safely scope a legacy shell based adb command to one resolved serial. */
export function adbPrefix(serial: string): string {
  if (!isSafeDeviceId(serial)) throw new Error('Invalid Android device serial');
  return `adb -s "${serial}"`;
}

export interface AndroidDevice {
  id: string;
  status: string;
  model?: string;
  [key: string]: string | undefined;
}

export interface ResolvedDevice {
  platform: 'ios' | 'android';
  /** A concrete simulator UDID. Android uses the adb serial in `id`. */
  id: string;
  name?: string;
  runtime?: string;
}

export interface DeviceDiscoveryRunner {
  execFile(
    command: string,
    args: string[],
    options?: { maxBuffer?: number },
  ): Promise<Buffer | string>;
}

export interface ConnectedDeviceTarget {
  deviceName?: string;
  reactNative?: { logicalDeviceId?: string };
}

function outputText(output: Buffer | string): string {
  return typeof output === 'string' ? output : output.toString('utf8');
}

/** Parse simctl's JSON output without accepting a partially valid inventory. */
export function parseBootedSimulators(output: string): BootedSimulator[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(
      `Malformed iOS simulator inventory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Malformed iOS simulator inventory: expected an object');
  }
  const devices = (parsed as { devices?: unknown }).devices;
  if (!devices || typeof devices !== 'object' || Array.isArray(devices)) {
    throw new Error('Malformed iOS simulator inventory: missing devices map');
  }

  const result: BootedSimulator[] = [];
  for (const [runtime, entries] of Object.entries(devices)) {
    const normalizedRuntime = runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '');
    if (!/^iOS(?:-|$)/i.test(normalizedRuntime)) continue;
    if (!Array.isArray(entries)) {
      throw new Error(`Malformed iOS simulator inventory: ${runtime} is not an array`);
    }
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') {
        throw new Error('Malformed iOS simulator inventory: invalid device entry');
      }
      const device = entry as Record<string, unknown>;
      if (
        device.state !== 'Booted' ||
        device.isAvailable === false ||
        device.isAvailable === 'NO'
      ) continue;
      if (typeof device.udid !== 'string' || !device.udid.trim()) {
        throw new Error('Malformed iOS simulator inventory: booted device has no UDID');
      }
      if (!isSafeDeviceId(device.udid)) {
        throw new Error('Malformed iOS simulator inventory: booted device has an invalid UDID');
      }
      if (typeof device.name !== 'string' || !device.name.trim()) {
        throw new Error('Malformed iOS simulator inventory: booted device has no name');
      }
      result.push({
        name: device.name,
        udid: device.udid,
        state: 'Booted',
        runtime: normalizedRuntime,
      });
    }
  }
  return result;
}

export async function discoverBootedSimulators(
  runner: DeviceDiscoveryRunner,
): Promise<BootedSimulator[]> {
  const output = await runner.execFile('xcrun', [
    'simctl',
    'list',
    'devices',
    'booted',
    '--json',
  ]);
  return parseBootedSimulators(outputText(output));
}

export function parseAndroidDevices(output: string): AndroidDevice[] {
  const lines = output.split(/\r?\n/).slice(1);
  return lines.flatMap((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2 || !parts[0] || parts[0].startsWith('*')) return [];
    if (!isSafeDeviceId(parts[0])) {
      throw new Error('Malformed Android device inventory: invalid device serial');
    }
    const info: AndroidDevice = { id: parts[0], status: parts[1] };
    for (const part of parts.slice(2)) {
      const separator = part.indexOf(':');
      if (separator > 0) info[part.slice(0, separator)] = part.slice(separator + 1);
    }
    return [info];
  });
}

export async function discoverAndroidDevices(
  runner: DeviceDiscoveryRunner,
): Promise<AndroidDevice[]> {
  const output = await runner.execFile('adb', ['devices', '-l']);
  return parseAndroidDevices(outputText(output));
}

function targetId(target?: ConnectedDeviceTarget | null): string | undefined {
  const id = target?.reactNative?.logicalDeviceId?.trim();
  return id || undefined;
}

/**
 * Resolve one concrete device for a tool invocation. Discovery is intentionally
 * uncached: a simulator booted after a failed call must be visible immediately.
 */
export async function resolveDevice(
  runner: DeviceDiscoveryRunner,
  platform: 'ios' | 'android' | 'auto',
  target?: ConnectedDeviceTarget | null,
): Promise<ResolvedDevice | null> {
  if (platform === 'android') {
    const devices = await discoverAndroidDevices(runner);
    const authorized = devices.filter((device) => device.status === 'device');
    if (authorized.length === 0) return null;
    const selected = findAndroidTarget(authorized, targetId(target), target?.deviceName?.trim())
      ?? (authorized.length === 1 ? authorized[0] : undefined);
    if (!selected) {
      throw new Error(
        `Ambiguous Android devices: ${authorized.map((device) => device.id).join(', ')}.`,
      );
    }
    return { platform: 'android', id: selected.id, name: selected.model };
  }

  if (platform === 'ios') {
    const devices = await discoverBootedSimulators(runner);
    return resolveIosDevice(devices, target);
  }

  const [iosResult, androidResult] = await Promise.allSettled([
    discoverBootedSimulators(runner),
    discoverAndroidDevices(runner),
  ]);
  // A connected target is stronger evidence than runtime ordering. This
  // matters when an Android app is connected while an unrelated iOS
  // simulator happens to be booted.
  const connectedId = targetId(target);
  const connectedName = target?.deviceName?.trim();
  // Check concrete IDs across both inventories before considering names. A
  // Metro logical ID is the only evidence that can unambiguously identify the
  // connected runtime when another platform has a colliding device name.
  const ios = iosResult.status === 'fulfilled'
    ? findIosId(iosResult.value, connectedId)
    : undefined;
  const android = androidResult.status === 'fulfilled'
    ? androidResult.value
        .filter((device) => device.status === 'device')
        .find((device) => device.id === connectedId)
    : undefined;
  if (ios && android) {
    throw new Error(`Ambiguous connected device ID "${connectedId}" across iOS and Android.`);
  }
  if (ios) return toResolvedIos(ios);
  if (android) return { platform: 'android', id: android.id, name: android.model };

  if (iosResult.status === 'fulfilled') {
    const iosMatch = findIosName(iosResult.value, connectedName);
    if (iosMatch) return toResolvedIos(iosMatch);
  }
  if (androidResult.status === 'fulfilled') {
    const android = androidResult.value.filter((device) => device.status === 'device');
    const match = findAndroidTarget(android, undefined, connectedName);
    if (match) return { platform: 'android', id: match.id, name: match.model };
  }
  // A valid iOS inventory wins when both runtimes are present, matching the
  // historical auto-selection order while making ambiguity explicit.
  if (iosResult.status === 'fulfilled' && iosResult.value.length > 0) {
    return resolveIosDevice(iosResult.value, target);
  }
  if (androidResult.status === 'fulfilled') {
    const authorized = androidResult.value.filter((device) => device.status === 'device');
    if (authorized.length === 1) {
      return { platform: 'android', id: authorized[0].id, name: authorized[0].model };
    }
    if (authorized.length > 1) {
      throw new Error(
        `Ambiguous Android devices: ${authorized.map((device) => device.id).join(', ')}.`,
      );
    }
  }
  if (iosResult.status === 'rejected' && androidResult.status === 'rejected') {
    throw iosResult.reason instanceof Error ? iosResult.reason : new Error(String(iosResult.reason));
  }
  return null;
}

function findAndroidTarget(
  devices: AndroidDevice[],
  connectedId?: string,
  connectedName?: string,
): AndroidDevice | undefined {
  const byId = connectedId ? devices.find((device) => device.id === connectedId) : undefined;
  if (byId) return byId;
  if (!connectedName) return undefined;
  // ADB sanitizes every non-alphanumeric UTF-8 byte in its model field.
  const modelName = Buffer.from(connectedName, 'utf8').toString('latin1').replace(/[^a-zA-Z0-9]/g, '_');
  const matches = devices.filter((device) => device.model === modelName);
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous Android devices named "${connectedName}": ${matches.map((device) => device.id).join(', ')}.`,
    );
  }
  return matches[0];
}

function resolveIosDevice(
  devices: BootedSimulator[],
  target?: ConnectedDeviceTarget | null,
): ResolvedDevice | null {
  if (devices.length === 0) return null;

  const match = findIosId(devices, targetId(target)) ?? findIosName(devices, target?.deviceName?.trim());
  if (match) return toResolvedIos(match);

  if (devices.length === 1) {
    const device = devices[0];
    return toResolvedIos(device);
  }
  throw new Error(
    `Ambiguous booted iOS simulators: ${devices.map((device) => `${device.name} (${device.udid})`).join(', ')}.`,
  );
}

function toResolvedIos(device: BootedSimulator): ResolvedDevice {
  return { platform: 'ios', id: device.udid, name: device.name, runtime: device.runtime };
}

function findIosId(
  devices: BootedSimulator[],
  connectedId?: string,
): BootedSimulator | undefined {
  return connectedId
    ? devices.find((device) => device.udid.toLowerCase() === connectedId.toLowerCase())
    : undefined;
}

function findIosName(
  devices: BootedSimulator[],
  connectedName?: string,
): BootedSimulator | undefined {
  const byName = connectedName
    ? devices.filter((device) => device.name === connectedName)
    : [];
  return byName.length === 1 ? byName[0] : undefined;
}

/** Convenience wrapper used by plugins that only need the selected platform. */
export async function detectPlatform(
  ctx: PluginContext,
): Promise<'ios' | 'android' | null> {
  const device = await resolveDevice(ctx, 'auto', ctx.cdp.getTarget());
  return device?.platform ?? null;
}
