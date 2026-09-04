import { isIP } from 'node:net';
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
  if (/^[A-Za-z0-9._:-]+$/.test(value)) return true;
  const networkSerial = value.match(/^\[([^\]]+)\]:(\d{1,5})$/);
  if (!networkSerial || isIP(networkSerial[1]) !== 6) return false;
  const port = Number(networkSerial[2]);
  return port >= 1 && port <= 65_535;
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
  appId?: string;
  deviceName?: string;
  reactNative?: { logicalDeviceId?: string };
}

/**
 * Return target metadata only while its CDP connection is current.
 * metro-bridge retains the last target after disconnecting, so using that
 * metadata during native discovery can reject or select a replacement device.
 */
export function getConnectedDeviceTarget(
  ctx: { cdp: { isConnected: boolean; getTarget(): ConnectedDeviceTarget | null } },
): ConnectedDeviceTarget | undefined {
  return ctx.cdp.isConnected ? ctx.cdp.getTarget() ?? undefined : undefined;
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

  // If one inventory failed, names and sole-device fallbacks are unsafe while
  // a Metro target is connected: the surviving inventory may describe an
  // unrelated device. Require concrete identity evidence in that case and
  // let callers retry after the failed discovery has recovered.
  if (
    (iosResult.status === 'rejected' || androidResult.status === 'rejected') &&
    target != null
  ) {
    // Some hosts (for example Linux) cannot run xcrun at all. When that
    // impossible platform is the only failed inventory, a connected Android
    // target can still be resolved from a unique surviving inventory match.
    // Keep the stricter retry path for ordinary discovery failures, where the
    // missing inventory may simply be temporarily unavailable.
    if (
      iosResult.status === 'rejected' &&
      androidResult.status === 'fulfilled' &&
      isUnavailableToolError(iosResult.reason)
    ) {
      const authorized = androidResult.value.filter((device) => device.status === 'device');
      const nameMatches = connectedName ? findAndroidNameMatches(authorized, connectedName) : [];
      if (nameMatches.length === 1) {
        const match = nameMatches[0];
        return { platform: 'android', id: match.id, name: match.model };
      }
      // An opaque Metro logical ID is still evidence that a target is
      // connected. With only one authorized Android device remaining, there
      // is no competing local candidate to choose accidentally.
      if (connectedId && authorized.length === 1 &&
        (!connectedName || nameMatches.length === 1)) {
        const device = authorized[0];
        return { platform: 'android', id: device.id, name: device.model };
      }
    }
    if (
      androidResult.status === 'rejected' &&
      iosResult.status === 'fulfilled' &&
      isUnavailableToolError(androidResult.reason)
    ) {
      const nameMatches = findIosNames(iosResult.value, connectedName);
      if (nameMatches.length === 1) return toResolvedIos(nameMatches[0]);
      // A connected opaque inspector ID plus one booted simulator is the
      // symmetric iOS case: the missing Android executable cannot hide a
      // competing local Android device.
      if (connectedId && iosResult.value.length === 1 &&
        (!connectedName || nameMatches.length === 1)) {
        return toResolvedIos(iosResult.value[0]);
      }
    }
    const failed = [
      iosResult.status === 'rejected' ? 'iOS simulator' : null,
      androidResult.status === 'rejected' ? 'Android device' : null,
    ].filter(Boolean).join(' and ');
    throw new Error(
      `Unable to verify the connected device because ${failed} discovery failed. ` +
      'Retry after device discovery is available.',
    );
  }

  // Resolve name evidence for both platforms before selecting either one.
  // A Metro target's name is not platform-qualified, so selecting the first
  // inventory to report a match can silently target an unrelated app when
  // both runtimes use the same model name.
  const bootedIos = iosResult.status === 'fulfilled' ? iosResult.value : [];
  const authorizedAndroid = androidResult.status === 'fulfilled'
    ? androidResult.value.filter((device) => device.status === 'device')
    : [];
  const iosNameMatches = iosResult.status === 'fulfilled'
    ? findIosNames(iosResult.value, connectedName)
    : [];
  const androidNameMatches = connectedName
    ? findAndroidNameMatches(authorizedAndroid, connectedName)
    : [];
  if (iosNameMatches.length > 0 && androidNameMatches.length > 0) {
    throw new Error(
      `Ambiguous connected device name "${connectedName}" across iOS and Android: ` +
      `${iosNameMatches.map((device) => device.udid).join(', ')}, ` +
      `${androidNameMatches.map((device) => device.id).join(', ')}.`,
    );
  }
  if (iosNameMatches.length > 1 || androidNameMatches.length > 1) {
    // Do not let a unique name on the other platform hide an ambiguous
    // same-name inventory. The name evidence cannot establish the platform.
    if (iosNameMatches.length > 1) {
      throw new Error(
        `Ambiguous booted iOS simulators named "${connectedName}": ` +
        `${iosNameMatches.map((device) => device.udid).join(', ')}.`,
      );
    }
    throw new Error(
      `Ambiguous Android devices named "${connectedName}": ` +
      `${androidNameMatches.map((device) => device.id).join(', ')}.`,
    );
  }
  if (iosNameMatches.length === 1) return toResolvedIos(iosNameMatches[0]);
  if (androidNameMatches.length === 1) {
    const match = androidNameMatches[0];
    return { platform: 'android', id: match.id, name: match.model };
  }
  // Once the connected target's concrete identity and name evidence have
  // been exhausted, runtime ordering cannot identify which platform it is on.
  // Refuse to choose iOS merely because it happens to be listed first.
  if (bootedIos.length > 0 && authorizedAndroid.length > 0) {
    throw new Error(
      'Ambiguous available devices across iOS and Android: ' +
      `${bootedIos.map((device) => `${device.name} (${device.udid})`).join(', ')}; ` +
      `${authorizedAndroid.map((device) => `${device.model ?? device.id} (${device.id})`).join(', ')}.`,
    );
  }
  // A sole inventory is safe to use when the connected target only exposes an
  // opaque logical ID. A device name is useful contradiction evidence, while
  // an unmatched logical ID may simply be an inspector-generated identifier;
  // exact matches returned above already win.
  if (bootedIos.length > 0) {
    if (bootedIos.length === 1 && connectedName) {
      throw new Error(
        'Connected Metro target does not match the sole available iOS simulator.',
      );
    }
    return resolveIosDevice(bootedIos, target);
  }
  if (authorizedAndroid.length > 0) {
    if (authorizedAndroid.length === 1) {
      if (connectedName) {
        throw new Error(
          'Connected Metro target does not match the sole available Android device.',
        );
      }
      return { platform: 'android', id: authorizedAndroid[0].id, name: authorizedAndroid[0].model };
    }
    if (authorizedAndroid.length > 1) {
      throw new Error(
        `Ambiguous Android devices: ${authorizedAndroid.map((device) => device.id).join(', ')}.`,
      );
    }
  }
  if (iosResult.status === 'rejected' && androidResult.status === 'rejected') {
    throw iosResult.reason instanceof Error ? iosResult.reason : new Error(String(iosResult.reason));
  }
  return null;
}

function isUnavailableToolError(reason: unknown): boolean {
  if (typeof reason !== 'object' || reason === null) return false;
  if ('code' in reason && reason.code === 'ENOENT') return true;

  // xcrun can start successfully and still fail because the requested
  // developer utility is absent. Treat only that precise simctl diagnostic as
  // unavailable; malformed inventories and other non-zero exits remain
  // strict so they cannot silently select a different runtime.
  const error = reason as { message?: unknown; stderr?: unknown };
  const text = [error.message, error.stderr]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  return /xcrun:\s*error:\s*unable to find utility ["']simctl["']/i.test(text);
}

function findAndroidTarget(
  devices: AndroidDevice[],
  connectedId?: string,
  connectedName?: string,
): AndroidDevice | undefined {
  const byId = connectedId ? devices.find((device) => device.id === connectedId) : undefined;
  if (byId) return byId;
  if (!connectedName) return undefined;
  const matches = findAndroidNameMatches(devices, connectedName);
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous Android devices named "${connectedName}": ${matches.map((device) => device.id).join(', ')}.`,
    );
  }
  return matches[0];
}

function findAndroidNameMatches(
  devices: AndroidDevice[],
  connectedName: string,
): AndroidDevice[] {
  // ADB sanitizes every non-alphanumeric UTF-8 byte in its model field.
  const modelName = Buffer.from(connectedName, 'utf8').toString('latin1').replace(/[^a-zA-Z0-9]/g, '_');
  return devices.filter((device) => device.model === modelName);
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
  const byName = findIosNames(devices, connectedName);
  return byName.length === 1 ? byName[0] : undefined;
}

function findIosNames(
  devices: BootedSimulator[],
  connectedName?: string,
): BootedSimulator[] {
  return connectedName ? devices.filter((device) => device.name === connectedName) : [];
}

/** Convenience wrapper used by plugins that only need the selected platform. */
export async function detectPlatform(
  ctx: PluginContext,
): Promise<'ios' | 'android' | null> {
  const device = await resolveDevice(ctx, 'auto', getConnectedDeviceTarget(ctx));
  return device?.platform ?? null;
}
