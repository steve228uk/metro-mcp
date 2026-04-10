import { z } from 'zod';
import { definePlugin } from '../plugin.js';

// Module-level caches — persist across tool handler calls for the lifetime of the server.
let platformCache: { value: 'ios' | 'android' | null; ts: number } | null = null;
const PLATFORM_TTL_MS = 5000;
let bundleIdCache: string | null = null;

function normalizeAndroidPermission(service: string): string {
  return service.startsWith('android.permission.')
    ? service
    : `android.permission.${service.toUpperCase()}`;
}

const permissionServiceParams = z.object({
  service: z
    .string()
    .describe(
      'iOS: service name (e.g. "camera", "location"). Android: permission name (e.g. "CAMERA" or "android.permission.CAMERA").'
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
    async function detectPlatform(): Promise<'ios' | 'android' | null> {
      const now = Date.now();
      if (platformCache && now - platformCache.ts < PLATFORM_TTL_MS) return platformCache.value;
      const [iosResult, androidResult] = await Promise.allSettled([
        ctx.exec('xcrun simctl list booted 2>/dev/null | grep -q Booted'),
        ctx.exec('adb devices 2>/dev/null'),
      ]);
      let platform: 'ios' | 'android' | null = null;
      if (iosResult.status === 'fulfilled') {
        platform = 'ios';
      } else if (androidResult.status === 'fulfilled') {
        const output = (androidResult as PromiseFulfilledResult<string>).value;
        if (output.trim().split('\n').length > 1) platform = 'android';
      }
      platformCache = { value: platform, ts: now };
      return platform;
    }

    async function detectBundleId(platform: 'ios' | 'android'): Promise<string | null> {
      if (bundleIdCache) return bundleIdCache;
      const config = ctx.config as Record<string, unknown>;
      if (platform === 'android' && config.packageName)
        return (bundleIdCache = String(config.packageName));
      if (config.bundleId) return (bundleIdCache = String(config.bundleId));
      try {
        if (ctx.cdp.isConnected) {
          const id = await ctx.evalInApp(
            `(function(){ try { return require('react-native-device-info').getBundleId(); } catch(e) { return null; } })()`,
            { awaitPromise: false }
          );
          if (id) return (bundleIdCache = String(id));
        }
      } catch {}
      return null;
    }

    async function resolveTarget(
      platform: 'ios' | 'android' | 'auto' | undefined,
      bundleId: string | undefined
    ): Promise<{ p: 'ios' | 'android'; id: string } | string> {
      const p = platform === 'auto' || !platform ? await detectPlatform() : platform;
      if (!p) return 'No simulator/emulator detected.';
      const id = bundleId || (await detectBundleId(p));
      if (!id)
        return 'Bundle ID / package name required. Provide bundleId or ensure the app is running.';
      return { p, id };
    }

    function permissionMutationHandler(action: 'grant' | 'revoke') {
      return async ({ service, platform, bundleId }: z.infer<typeof permissionServiceParams>) => {
        const resolved = await resolveTarget(platform, bundleId);
        if (typeof resolved === 'string') return resolved;
        const { p, id } = resolved;
        if (p === 'ios') {
          try {
            await ctx.exec(`xcrun simctl privacy booted ${action} "${service}" "${id}"`);
            return action === 'grant'
              ? `Granted "${service}" permission to ${id} on iOS simulator.`
              : `Revoked "${service}" permission from ${id} on iOS simulator.`;
          } catch (err) {
            return `Failed to ${action} permission: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          const perm = normalizeAndroidPermission(service);
          try {
            await ctx.exec(`adb shell pm ${action} "${id}" "${perm}"`);
            return action === 'grant'
              ? `Granted "${perm}" to ${id} on Android device.`
              : `Revoked "${perm}" from ${id} on Android device.`;
          } catch (err) {
            return `Failed to ${action} permission: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      };
    }

    ctx.registerTool('list_permissions', {
      description:
        'List all app permission statuses on the connected iOS simulator or Android emulator. Returns an object mapping service/permission → status.',
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

        if (p === 'ios') {
          try {
            const output = await ctx.exec(
              `xcrun simctl privacy booted list "${id}" 2>/dev/null`
            );
            const permissions: Record<string, string> = {};
            for (const line of output.trim().split('\n')) {
              const match = line.match(/^\s*(\w+):\s*(\S+)/);
              if (match) permissions[match[1].toLowerCase()] = match[2].toLowerCase();
            }
            if (Object.keys(permissions).length === 0)
              return `No permissions found for "${id}". Make sure the app is installed on the booted simulator.`;
            return permissions;
          } catch (err) {
            return `Failed to list permissions: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          try {
            const output = await ctx.exec(`adb shell dumpsys package "${id}" 2>/dev/null`);
            const permissions: Record<string, string> = {};
            const permRegex = /(android\.permission\.\w+):\s*granted=(\w+)/g;
            let match;
            while ((match = permRegex.exec(output)) !== null) {
              permissions[match[1]] = match[2] === 'true' ? 'granted' : 'denied';
            }
            if (Object.keys(permissions).length === 0)
              return `No permissions found for "${id}". Make sure the app is installed on the connected device.`;
            return permissions;
          } catch (err) {
            return `Failed to list permissions: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
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
            'iOS: specific service to reset (e.g. "camera"); omit to reset all. Android: permission name (e.g. "CAMERA"); omit to reset all runtime permissions.'
          ),
        platform: z.enum(['ios', 'android', 'auto']).default('auto').describe('Target platform'),
        bundleId: z
          .string()
          .optional()
          .describe('Bundle ID (iOS) or package name (Android). Auto-detected if omitted.'),
      }),
      handler: async ({ service, platform, bundleId }) => {
        const resolved = await resolveTarget(platform, bundleId);
        if (typeof resolved === 'string') return resolved;
        const { p, id } = resolved;

        if (p === 'ios') {
          const iosTarget = service ?? 'all';
          try {
            await ctx.exec(`xcrun simctl privacy booted reset "${iosTarget}" "${id}"`);
            return `Reset ${service ? `"${service}"` : 'all'} permissions for ${id} on iOS simulator.`;
          } catch (err) {
            return `Failed to reset permissions: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          try {
            if (service) {
              const perm = normalizeAndroidPermission(service);
              await ctx.exec(`adb shell pm revoke "${id}" "${perm}"`);
              return `Reset "${perm}" for ${id} on Android device.`;
            } else {
              // pm reset-permissions not available on older Android; pm clear resets all app state including permissions
              try {
                await ctx.exec(`adb shell pm reset-permissions -p "${id}" 2>/dev/null`);
              } catch {
                await ctx.exec(`adb shell pm clear "${id}"`);
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
        "Open the app's system settings page on the connected iOS simulator or Android emulator.",
      annotations: { destructiveHint: false },
      parameters: z.object({
        platform: z.enum(['ios', 'android', 'auto']).default('auto').describe('Target platform'),
        bundleId: z
          .string()
          .optional()
          .describe(
            'Bundle ID (iOS) or package name (Android). Auto-detected if omitted. Required for Android.'
          ),
      }),
      handler: async ({ platform, bundleId }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return 'No simulator/emulator detected.';

        if (p === 'ios') {
          try {
            await ctx.exec('xcrun simctl openurl booted app-settings:');
            return 'Opened app settings on iOS simulator.';
          } catch (err) {
            return `Failed to open app settings: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          const id = bundleId || (await detectBundleId(p));
          if (!id) return 'Package name required for Android. Provide bundleId.';
          try {
            await ctx.exec(
              `adb shell am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d "package:${id}"`
            );
            return `Opened app settings for ${id} on Android device.`;
          } catch (err) {
            return `Failed to open app settings: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      },
    });
  },
});
