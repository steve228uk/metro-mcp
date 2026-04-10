import { z } from 'zod';
import { definePlugin } from '../plugin.js';

const PLATFORM_SCHEMA = z
  .enum(['ios', 'android', 'auto'])
  .default('auto')
  .describe("Target platform. 'auto' detects from active device.");

// iOS services supported by xcrun simctl privacy
const IOS_SERVICES = [
  'all',
  'bluetooth',
  'calendars',
  'camera',
  'contacts',
  'faceid',
  'focus',
  'health',
  'homekit',
  'location',
  'medialibrary',
  'microphone',
  'motion',
  'network',
  'notifications',
  'photos',
  'reminders',
  'screentime',
  'siri',
  'speech',
  'tracking',
  'usertracking',
] as const;

async function detectPlatform(ctx: { exec: (cmd: string) => Promise<string> }): Promise<'ios' | 'android'> {
  try {
    await ctx.exec('xcrun simctl list devices --json');
    return 'ios';
  } catch {
    return 'android';
  }
}

async function getBootedIosDevice(ctx: { exec: (cmd: string) => Promise<string> }): Promise<string> {
  return 'booted'; // xcrun simctl accepts 'booted' as a device specifier
}

async function resolveBundleId(
  ctx: { exec: (cmd: string) => Promise<string>; evalInApp: (expr: string) => Promise<unknown>; config: Record<string, unknown> },
  platform: 'ios' | 'android',
  provided?: string
): Promise<string | null> {
  if (provided) return provided;
  if (ctx.config.bundleId) return String(ctx.config.bundleId);

  // Try to read from app runtime
  try {
    if (platform === 'ios') {
      const id = await ctx.evalInApp(
        `(function() {
          try { return require('expo-application').applicationId; } catch(e) {}
          try { return require('react-native-device-info').getBundleId(); } catch(e) {}
          return null;
        })()`
      );
      if (id) return String(id);
    } else {
      const id = await ctx.evalInApp(
        `(function() {
          try { return require('expo-application').applicationId; } catch(e) {}
          try { return require('react-native-device-info').getBundleId(); } catch(e) {}
          return null;
        })()`
      );
      if (id) return String(id);
    }
  } catch {
    // ignore
  }

  return null;
}

export const permissionsPlugin = definePlugin({
  name: 'permissions',
  description:
    'Inspect and manage app permissions on iOS Simulator and Android Emulator via shell commands.',

  async setup(ctx) {
    ctx.registerTool('list_permissions', {
      description:
        'List the current permission status for the app. ' +
        'On iOS uses xcrun simctl privacy to query granted/denied/unset status. ' +
        'On Android uses adb shell dumpsys package to parse permission grants. ' +
        'Requires the app to be running or the bundle ID to be provided.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        platform: PLATFORM_SCHEMA,
        bundleId: z
          .string()
          .optional()
          .describe('App bundle ID (iOS) or package name (Android). Auto-detected if omitted.'),
      }),
      handler: async ({ platform, bundleId }) => {
        const resolved = platform === 'auto' ? await detectPlatform(ctx) : platform;
        const id = await resolveBundleId(ctx, resolved, bundleId);

        if (!id) {
          return (
            'Could not determine bundle ID. Provide bundleId parameter, or ensure expo-application ' +
            'or react-native-device-info is installed in your app.'
          );
        }

        if (resolved === 'ios') {
          try {
            const output = await ctx.exec(`xcrun simctl privacy booted list ${JSON.stringify(id)}`);
            // Parse "service: status" lines
            const permissions: Record<string, string> = {};
            for (const line of output.split('\n')) {
              const match = line.match(/^\s*(\w+):\s*(\w+)\s*$/);
              if (match) permissions[match[1]] = match[2];
            }
            return { platform: 'ios', bundleId: id, permissions };
          } catch (err) {
            return `Failed to list iOS permissions: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        // Android
        try {
          const output = await ctx.exec(`adb shell dumpsys package ${JSON.stringify(id)}`);
          const permissions: Record<string, string> = {};
          const lines = output.split('\n');
          let inPermSection = false;
          for (const line of lines) {
            if (line.includes('granted=true') || line.includes('granted=false')) {
              inPermSection = true;
            }
            if (inPermSection) {
              const match = line.match(/^\s*(android\.permission\.\w+):\s*granted=(\w+)/);
              if (match) {
                permissions[match[1]] = match[2] === 'true' ? 'granted' : 'denied';
              }
            }
          }
          return { platform: 'android', packageName: id, permissions };
        } catch (err) {
          return `Failed to list Android permissions: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('grant_permission', {
      description:
        'Grant a permission to the app. ' +
        'On iOS uses xcrun simctl privacy grant (e.g. camera, microphone, photos, location). ' +
        'On Android uses adb shell pm grant with the full android.permission.* name.',
      annotations: { destructiveHint: true },
      parameters: z.object({
        service: z
          .string()
          .describe(
            `Permission service to grant. iOS services: ${IOS_SERVICES.filter((s) => s !== 'all').join(', ')}. ` +
            `Android: full permission name e.g. android.permission.CAMERA`
          ),
        platform: PLATFORM_SCHEMA,
        bundleId: z.string().optional().describe('App bundle ID or package name. Auto-detected if omitted.'),
      }),
      handler: async ({ service, platform, bundleId }) => {
        const resolved = platform === 'auto' ? await detectPlatform(ctx) : platform;
        const id = await resolveBundleId(ctx, resolved, bundleId);
        if (!id) return 'Could not determine bundle ID. Provide bundleId parameter.';

        if (resolved === 'ios') {
          try {
            await ctx.exec(`xcrun simctl privacy booted grant ${JSON.stringify(service)} ${JSON.stringify(id)}`);
            return { platform: 'ios', bundleId: id, service, status: 'granted' };
          } catch (err) {
            return `Failed to grant iOS permission: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        try {
          await ctx.exec(`adb shell pm grant ${JSON.stringify(id)} ${JSON.stringify(service)}`);
          return { platform: 'android', packageName: id, permission: service, status: 'granted' };
        } catch (err) {
          return `Failed to grant Android permission: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('revoke_permission', {
      description:
        'Revoke a permission from the app. ' +
        'On iOS uses xcrun simctl privacy revoke. ' +
        'On Android uses adb shell pm revoke.',
      annotations: { destructiveHint: true },
      parameters: z.object({
        service: z.string().describe('Permission service to revoke (same values as grant_permission)'),
        platform: PLATFORM_SCHEMA,
        bundleId: z.string().optional().describe('App bundle ID or package name. Auto-detected if omitted.'),
      }),
      handler: async ({ service, platform, bundleId }) => {
        const resolved = platform === 'auto' ? await detectPlatform(ctx) : platform;
        const id = await resolveBundleId(ctx, resolved, bundleId);
        if (!id) return 'Could not determine bundle ID. Provide bundleId parameter.';

        if (resolved === 'ios') {
          try {
            await ctx.exec(`xcrun simctl privacy booted revoke ${JSON.stringify(service)} ${JSON.stringify(id)}`);
            return { platform: 'ios', bundleId: id, service, status: 'revoked' };
          } catch (err) {
            return `Failed to revoke iOS permission: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        try {
          await ctx.exec(`adb shell pm revoke ${JSON.stringify(id)} ${JSON.stringify(service)}`);
          return { platform: 'android', packageName: id, permission: service, status: 'revoked' };
        } catch (err) {
          return `Failed to revoke Android permission: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('reset_permissions', {
      description:
        'Reset permissions for the app back to their default (unset) state. ' +
        "On iOS uses xcrun simctl privacy reset. Pass service='all' to reset all permissions. " +
        'On Android clears the package runtime permissions.',
      annotations: { destructiveHint: true },
      parameters: z.object({
        service: z
          .string()
          .default('all')
          .describe("Permission service to reset, or 'all' to reset all permissions (default: 'all')"),
        platform: PLATFORM_SCHEMA,
        bundleId: z.string().optional().describe('App bundle ID or package name. Auto-detected if omitted.'),
      }),
      handler: async ({ service, platform, bundleId }) => {
        const resolved = platform === 'auto' ? await detectPlatform(ctx) : platform;
        const id = await resolveBundleId(ctx, resolved, bundleId);
        if (!id) return 'Could not determine bundle ID. Provide bundleId parameter.';

        if (resolved === 'ios') {
          try {
            await ctx.exec(`xcrun simctl privacy booted reset ${JSON.stringify(service)} ${JSON.stringify(id)}`);
            return {
              platform: 'ios',
              bundleId: id,
              service,
              status: 'reset',
              note: 'App may need to restart for changes to take effect.',
            };
          } catch (err) {
            return `Failed to reset iOS permissions: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        // Android: clear app data / reset permissions via pm clear or pm reset-permissions
        try {
          if (service === 'all') {
            await ctx.exec(`adb shell pm reset-permissions ${JSON.stringify(id)}`);
          } else {
            await ctx.exec(`adb shell pm revoke ${JSON.stringify(id)} ${JSON.stringify(service)}`);
          }
          return {
            platform: 'android',
            packageName: id,
            service,
            status: 'reset',
            note: 'App may need to restart for changes to take effect.',
          };
        } catch (err) {
          return `Failed to reset Android permissions: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('open_app_settings', {
      description:
        "Open the device's app permission settings screen for the app. " +
        'Useful to manually review or change permissions that cannot be set via CLI.',
      annotations: { destructiveHint: false, openWorldHint: true },
      parameters: z.object({
        platform: PLATFORM_SCHEMA,
        bundleId: z.string().optional().describe('App bundle ID or package name. Auto-detected if omitted.'),
      }),
      handler: async ({ platform, bundleId }) => {
        const resolved = platform === 'auto' ? await detectPlatform(ctx) : platform;
        const id = await resolveBundleId(ctx, resolved, bundleId);

        if (resolved === 'ios') {
          try {
            await ctx.exec('xcrun simctl openurl booted app-settings:');
            return { platform: 'ios', opened: true };
          } catch (err) {
            return `Failed to open iOS app settings: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        if (!id) return 'Could not determine package name. Provide bundleId parameter.';

        try {
          await ctx.exec(
            `adb shell am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d package:${JSON.stringify(id)}`
          );
          return { platform: 'android', packageName: id, opened: true };
        } catch (err) {
          return `Failed to open Android app settings: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
  },
});
