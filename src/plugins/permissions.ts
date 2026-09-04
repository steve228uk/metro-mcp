import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { openAppSettingsExpression } from '../utils/app-settings.js';
import {
  adbPrefix,
  getConnectedDeviceTarget,
  resolveDevice,
} from '../utils/device-discovery.js';

// Bundle IDs are stable for a plugin session; device state is deliberately
// resolved on every call so a simulator booted after a miss is visible.
let bundleIdCache: string | null = null;

// TCC service name → friendly name
const TCC_SERVICE_MAP: Record<string, string> = {
  kTCCServiceCamera: 'camera',
  kTCCServicePhotos: 'photos',
  kTCCServiceMicrophone: 'microphone',
  kTCCServiceLocation: 'location',
  kTCCServiceLiverpool: 'location-always',
  kTCCServiceContacts: 'contacts',
  kTCCServiceContactsFull: 'contacts-full',
  kTCCServiceCalendar: 'calendar',
  kTCCServiceReminders: 'reminders',
  kTCCServiceMotion: 'motion',
  kTCCServiceMediaLibrary: 'media-library',
  kTCCServiceSiri: 'siri',
  kTCCServiceBluetoothAlways: 'bluetooth',
  kTCCServiceFaceID: 'face-id',
  kTCCServiceUserTracking: 'tracking',
};

// TCC auth_value integer (as string) → permission status
const TCC_AUTH_VALUE_MAP: Record<string, string> = {
  '0': 'denied',
  '1': 'not-determined',
  '2': 'granted',
  '3': 'limited',
  '4': 'restricted',
};

// locationd Authorization: 0=notDetermined, 1=restricted, 2=whenInUse, 3=always, 4=denied
const LOCATIOND_AUTH_MAP: Record<number, string> = {
  0: 'not-determined',
  1: 'restricted',
  2: 'when-in-use',
  3: 'always',
  4: 'denied',
};

// Services supported by `xcrun simctl privacy booted grant/revoke/reset`
// Note: camera, bluetooth, face-id, tracking, notifications are NOT supported.
const IOS_SIMCTL_PRIVACY_SERVICES = new Set([
  'all',
  'calendar',
  'contacts-limited',
  'contacts',
  'location',
  'location-always',
  'photos-add',
  'photos',
  'media-library',
  'microphone',
  'motion',
  'reminders',
  'siri',
]);

function normalizeAndroidPermission(service: string): string {
  return service.startsWith('android.permission.')
    ? service
    : `android.permission.${service.toUpperCase()}`;
}

function formatPermissions(
  platform: 'ios' | 'android',
  bundleId: string,
  permissions: Record<string, string>
): string {
  const header = `[${platform}] ${bundleId}`;
  const lines = Object.entries(permissions).map(([k, v]) => `${k}=${v}`);
  return `${header}\n${lines.join('\n')}`;
}

const permissionServiceParams = z.object({
  service: z
    .string()
    .describe(
      'iOS: simctl service (calendar, contacts, contacts-limited, location, location-always, microphone, motion, photos, photos-add, media-library, reminders, siri). Android: runtime permission (e.g. "CAMERA" or "android.permission.CAMERA").'
    ),
  platform: z.enum(['ios', 'android', 'auto']).default('auto').describe('Target platform'),
  bundleId: z
    .string()
    .optional()
    .describe('Bundle ID (iOS) or package name (Android). Auto-detected if omitted.'),
});

export const permissionsPlugin = definePlugin({
  name: 'permissions',

  description: 'Inspect and manage app permissions on iOS Simulator and Android Emulator',

  async setup(ctx) {
    async function detectBundleId(platform: 'ios' | 'android'): Promise<string | null> {
      if (bundleIdCache) return bundleIdCache;
      const config = ctx.config as Record<string, unknown>;
      if (platform === 'android' && config.packageName)
        return (bundleIdCache = String(config.packageName));
      if (config.bundleId) return (bundleIdCache = String(config.bundleId));
      const title = ctx.cdp.getTarget()?.title;
      if (title) {
        const match = title.match(/^(.+?)\s+\(/);
        if (match?.[1]) return (bundleIdCache = match[1]);
      }
      return null;
    }

    async function resolveTarget(
      platform: 'ios' | 'android' | 'auto' | undefined,
      bundleId: string | undefined
    ): Promise<{ p: 'ios' | 'android'; id: string; deviceId: string } | string> {
      const device = await resolveDevice(
        ctx,
        platform === 'auto' || !platform ? 'auto' : platform,
        getConnectedDeviceTarget(ctx),
      );
      if (!device) return 'No simulator/emulator detected.';
      const p = device.platform;
      const id = bundleId || (await detectBundleId(p));
      if (!id)
        return 'Bundle ID / package name required. Provide bundleId or ensure the app is running.';
      return { p, id, deviceId: device.id };
    }

    function validateIosService(service: string): string | null {
      if (IOS_SIMCTL_PRIVACY_SERVICES.has(service)) return null;
      return `"${service}" not supported. Use: calendar, contacts, contacts-limited, location, location-always, microphone, motion, photos, photos-add, media-library, reminders, siri.`;
    }

    function permissionMutationHandler(action: 'grant' | 'revoke') {
      return async ({ service, platform, bundleId }: z.infer<typeof permissionServiceParams>) => {
        const resolved = await resolveTarget(platform, bundleId);
        if (typeof resolved === 'string') return resolved;
        const { p, id } = resolved;
        if (p === 'ios') {
          const serviceError = validateIosService(service);
          if (serviceError) return serviceError;
          try {
            await ctx.exec(`xcrun simctl privacy "${resolved.deviceId}" ${action} "${service}" "${id}"`);
            return action === 'grant'
              ? `Granted "${service}" permission to ${id} on iOS simulator.`
              : `Revoked "${service}" permission from ${id} on iOS simulator.`;
          } catch (err) {
            return `Failed to ${action} permission: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          const perm = normalizeAndroidPermission(service);
          try {
            await ctx.exec(`${adbPrefix(resolved.deviceId)} shell pm ${action} "${id}" "${perm}"`);
            return action === 'grant'
              ? `Granted "${perm}" to ${id} on Android device.`
              : `Revoked "${perm}" from ${id} on Android device.`;
          } catch (err) {
            return `Failed to ${action} permission: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      };
    }

    async function fetchPermissions(
      p: 'ios' | 'android',
      id: string,
      deviceId: string,
    ): Promise<Record<string, string> | string> {
      if (p === 'ios') {
        try {
          // simctl privacy has no 'list' action — read the TCC database directly.
          const udid = deviceId;

          const safeId = id.replace(/'/g, "''");
          const tccDb = `${process.env.HOME}/Library/Developer/CoreSimulator/Devices/${udid}/data/Library/TCC/TCC.db`;
          // Location is managed by locationd, not TCC — read clients.plist separately.
          // Keys are like "i<bundleId>:" (leading i, trailing colon); PlistBuddy escapes the
          // literal colon in the key name with \:
          const locationdPlist = `${process.env.HOME}/Library/Developer/CoreSimulator/Devices/${udid}/data/Library/Caches/locationd/clients.plist`;

          const [tccResult, locationResult] = await Promise.allSettled([
            ctx.exec(
              `sqlite3 "${tccDb}" "SELECT service, auth_value FROM access WHERE client = '${safeId}'" 2>/dev/null`
            ),
            ctx.exec(
              `/usr/libexec/PlistBuddy -c "Print 'i${id}\\::Authorization'" "${locationdPlist}" 2>/dev/null`
            ),
          ]);

          const permissions: Record<string, string> = {};

          if (tccResult.status === 'fulfilled') {
            for (const line of tccResult.value.trim().split('\n')) {
              if (!line) continue;
              const parts = line.split('|');
              if (parts.length < 2) continue;
              const [service, authValue] = parts;
              permissions[TCC_SERVICE_MAP[service] ?? service] =
                TCC_AUTH_VALUE_MAP[authValue] ?? authValue;
            }
          }

          if (locationResult.status === 'fulfilled') {
            const auth = parseInt(locationResult.value.trim(), 10);
            if (!isNaN(auth)) {
              permissions['location'] = LOCATIOND_AUTH_MAP[auth] ?? String(auth);
            }
          }

          return permissions;
        } catch (err) {
          return `Failed to list permissions: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        try {
          const output = await ctx.exec(`${adbPrefix(deviceId)} shell dumpsys package "${id}" 2>/dev/null`);
          const permissions: Record<string, string> = {};
          const permRegex = /(android\.permission\.\w+):\s*granted=(\w+)/g;
          let match;
          while ((match = permRegex.exec(output)) !== null) {
            permissions[match[1]] = match[2] === 'true' ? 'granted' : 'denied';
          }
          return permissions;
        } catch (err) {
          return `Failed to list permissions: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }

    ctx.registerTool('list_permissions', {
      description:
        'List all app permission statuses on the connected iOS simulator or Android emulator. Returns compact text: one name=status line per permission.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        platform: z.enum(['ios', 'android', 'auto']).default('auto').describe('Target platform'),
        bundleId: z
          .string()
          .optional()
          .describe('Bundle ID (iOS) or package name (Android). Auto-detected if omitted.'),
      }),
      handler: async ({ platform, bundleId }) => {
        const resolved = await resolveTarget(platform, bundleId);
        if (typeof resolved === 'string') return resolved;
        const { p, id } = resolved;
        const perms = await fetchPermissions(p, id, resolved.deviceId);
        if (typeof perms === 'string') return perms;
        if (Object.keys(perms).length === 0)
          return p === 'ios'
            ? `No permissions found for "${id}". The app has not requested any permissions yet on this simulator.`
            : `No permissions found for "${id}". Make sure the app is installed on the connected device.`;
        return formatPermissions(p, id, perms);
      },
    });

    ctx.registerTool('grant_permission', {
      description:
        'Grant a permission to the app on the connected iOS simulator or Android emulator.',
      annotations: { destructiveHint: true },
      parameters: permissionServiceParams,
      handler: permissionMutationHandler('grant'),
    });

    ctx.registerTool('revoke_permission', {
      description:
        'Revoke a permission from the app on the connected iOS simulator or Android emulator.',
      annotations: { destructiveHint: true },
      parameters: permissionServiceParams,
      handler: permissionMutationHandler('revoke'),
    });

    ctx.registerTool('reset_permissions', {
      description:
        'Reset one or all permissions for the app on the connected iOS simulator or Android emulator. On iOS, omitting service resets all services. On Android, omitting service resets all runtime permissions.',
      annotations: { destructiveHint: true },
      parameters: z.object({
        service: z
          .string()
          .optional()
          .describe(
            'iOS: specific service to reset (e.g. "location"); omit to reset all. Android: permission name (e.g. "CAMERA"); omit to reset all runtime permissions.'
          ),
        platform: z.enum(['ios', 'android', 'auto']).default('auto').describe('Target platform'),
        bundleId: z
          .string()
          .optional()
          .describe('Bundle ID (iOS) or package name (Android). Auto-detected if omitted.'),
      }),
      handler: async ({ service, platform, bundleId }) => {
        let resolved: Awaited<ReturnType<typeof resolveTarget>>;
        try {
          resolved = await resolveTarget(platform, bundleId);
        } catch (err) {
          return `Failed to reset permissions: ${err instanceof Error ? err.message : String(err)}`;
        }
        if (typeof resolved === 'string') return resolved;
        const { p, id } = resolved;
        // Resolve the native target once, outside the reset fallback. If
        // inventory discovery fails, never interpret that as a failed adb
        // reset and issue a second destructive command.
        const deviceId = p === 'android' ? resolved.deviceId : null;

        if (p === 'ios') {
          const iosTarget = service ?? 'all';
          if (service !== undefined) {
            const serviceError = validateIosService(service);
            if (serviceError) return serviceError;
          }
          try {
            await ctx.exec(`xcrun simctl privacy "${resolved.deviceId}" reset "${iosTarget}" "${id}"`);
            return `Reset ${service ? `"${service}"` : 'all'} permissions for ${id} on iOS simulator.`;
          } catch (err) {
            return `Failed to reset permissions: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          try {
            if (service) {
              const perm = normalizeAndroidPermission(service);
              await ctx.exec(`${adbPrefix(deviceId!)} shell pm revoke "${id}" "${perm}"`);
              return `Reset "${perm}" for ${id} on Android device.`;
            } else {
              // pm reset-permissions not available on older Android; pm clear resets all app state including permissions
              try {
                await ctx.exec(`${adbPrefix(deviceId!)} shell pm reset-permissions -p "${id}" 2>/dev/null`);
              } catch {
                await ctx.exec(`${adbPrefix(deviceId!)} shell pm clear "${id}"`);
              }
              return `Reset all permissions for ${id} on Android device.`;
            }
          } catch (err) {
            return `Failed to reset permissions: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      },
    });

    ctx.registerTool('open_app_settings', {
      description:
        "Open the connected app's system settings page using React Native Linking.openSettings().",
      annotations: { destructiveHint: false },
      parameters: z.object({
        platform: z.enum(['ios', 'android', 'auto']).default('auto').describe('Target platform'),
        bundleId: z
          .string()
          .optional()
          .describe(
            'Bundle ID (iOS) or package name (Android). If supplied, it must match the connected app.'
          ),
      }),
      handler: async ({ platform, bundleId }) => {
        const target = ctx.cdp.getTarget();
        if (!target || !ctx.cdp.isConnected) return 'No connected app. Connect to the requested app first.';
        if (bundleId && bundleId !== target.appId) {
          return target.appId
            ? `Bundle ID does not match the connected app (${target.appId}). Connect to the requested app first.`
            : 'The connected app bundle ID is unavailable; the requested bundle ID cannot be verified.';
        }
        try {
          await ctx.evalInApp(openAppSettingsExpression(platform), { awaitPromise: true });
          return target.appId
            ? `Opened app settings for ${target.appId}.`
            : 'Opened settings for the connected app.';
        } catch (err) {
          return `Failed to open app settings: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerResource('metro://permissions', {
      name: 'App Permissions',
      description:
        'Current permission statuses for the connected app (auto-detected platform and bundle ID)',
      mimeType: 'text/plain',
      handler: async () => {
        const target = await resolveDevice(ctx, 'auto', getConnectedDeviceTarget(ctx));
        if (!target) return '(no simulator/emulator detected)';
        const p = target.platform;
        const id = await detectBundleId(p);
        if (!id) return `(${p}) bundle ID not detected — run the app first`;
        const perms = await fetchPermissions(p, id, target.id);
        if (typeof perms === 'string') return perms;
        if (Object.keys(perms).length === 0)
          return `[${p}] ${id}\n(no permissions requested yet)`;
        return formatPermissions(p, id, perms);
      },
    });
  },
});
