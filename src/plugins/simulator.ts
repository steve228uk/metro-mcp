import { z } from 'zod';
import { definePlugin } from '../plugin.js';

export const simulatorPlugin = definePlugin({
  name: 'simulator',

  description: 'Unified iOS simulator / Android emulator device control',

  async setup(ctx) {
    async function detectPlatform(): Promise<'ios' | 'android' | null> {
      try {
        await ctx.exec('xcrun simctl list booted 2>/dev/null');
        return 'ios';
      } catch {}
      try {
        await ctx.exec('adb devices 2>/dev/null');
        return 'android';
      } catch {}
      return null;
    }

    ctx.registerTool('take_screenshot', {
      description: 'Capture a screenshot from the connected iOS simulator or Android device.',
      parameters: z.object({
        platform: z.enum(['ios', 'android', 'auto']).default('auto').describe('Target platform'),
      }),
      handler: async ({ platform }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return 'No simulator/emulator detected.';

        const tmpFile = `/tmp/metro-mcp-screenshot-${Date.now()}.png`;

        if (p === 'ios') {
          await ctx.exec(`xcrun simctl io booted screenshot "${tmpFile}"`);
        } else {
          await ctx.exec(`adb exec-out screencap -p > "${tmpFile}"`);
        }

        // Read file and return as base64
        const file = Bun.file(tmpFile);
        if (await file.exists()) {
          const buffer = await file.arrayBuffer();
          const base64 = Buffer.from(buffer).toString('base64');
          await ctx.exec(`rm -f "${tmpFile}"`);
          return {
            type: 'image',
            format: 'png',
            data: base64,
            note: 'Screenshot captured successfully',
          };
        }
        return 'Failed to capture screenshot.';
      },
    });

    ctx.registerTool('list_simulators', {
      description: 'List available iOS simulators or Android emulators.',
      parameters: z.object({
        platform: z.enum(['ios', 'android', 'both']).default('both'),
        bootedOnly: z.boolean().default(false).describe('Show only booted/running devices'),
      }),
      handler: async ({ platform, bootedOnly }) => {
        const results: Record<string, unknown[]> = {};

        if (platform === 'ios' || platform === 'both') {
          try {
            const flag = bootedOnly ? 'booted' : '';
            const output = await ctx.exec(`xcrun simctl list devices ${flag} -j 2>/dev/null`);
            const parsed = JSON.parse(output);
            const devices: unknown[] = [];
            for (const [runtime, devs] of Object.entries(parsed.devices || {})) {
              for (const dev of devs as Array<Record<string, unknown>>) {
                devices.push({
                  name: dev.name,
                  udid: dev.udid,
                  state: dev.state,
                  runtime: runtime.replace('com.apple.CoreSimulator.SimRuntime.', ''),
                });
              }
            }
            results.ios = devices;
          } catch {
            results.ios = [{ error: 'xcrun simctl not available' }];
          }
        }

        if (platform === 'android' || platform === 'both') {
          try {
            const output = await ctx.exec('adb devices -l 2>/dev/null');
            const lines = output.trim().split('\n').slice(1);
            results.android = lines
              .filter((l) => l.trim())
              .map((line) => {
                const parts = line.trim().split(/\s+/);
                const info: Record<string, string> = { id: parts[0], status: parts[1] };
                for (const part of parts.slice(2)) {
                  const [key, val] = part.split(':');
                  if (key && val) info[key] = val;
                }
                return info;
              });
          } catch {
            results.android = [{ error: 'adb not available' }];
          }
        }

        return results;
      },
    });

    ctx.registerTool('install_certificate', {
      description: 'Install a root certificate on the iOS simulator or Android device.',
      parameters: z.object({
        certPath: z.string().describe('Path to the certificate file'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ certPath, platform }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return 'No simulator/emulator detected.';

        if (p === 'ios') {
          await ctx.exec(`xcrun simctl keychain booted add-root-cert "${certPath}"`);
          return 'Certificate installed on iOS simulator.';
        } else {
          await ctx.exec(`adb push "${certPath}" /sdcard/cert.pem`);
          return 'Certificate pushed to Android device at /sdcard/cert.pem. You may need to install it manually via Settings > Security.';
        }
      },
    });

    ctx.registerTool('get_native_logs', {
      description: 'Get native platform logs from iOS simulator (syslog) or Android device (logcat).',
      parameters: z.object({
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
        filter: z.string().optional().describe('Filter string (process name for iOS, tag for Android)'),
        lines: z.number().default(50).describe('Number of log lines to return'),
      }),
      handler: async ({ platform, filter, lines }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return 'No simulator/emulator detected.';

        try {
          if (p === 'ios') {
            const predicate = filter
              ? `--predicate 'processImagePath contains "${filter}"'`
              : '';
            const output = await ctx.exec(
              `xcrun simctl spawn booted log show --last 1m ${predicate} --style compact 2>/dev/null | tail -${lines}`
            );
            return output || 'No logs found.';
          } else {
            const tagFilter = filter ? `-s "${filter}:*"` : '';
            const output = await ctx.exec(
              `adb logcat -d ${tagFilter} -t ${lines} 2>/dev/null`
            );
            return output || 'No logs found.';
          }
        } catch (err) {
          return `Failed to get native logs: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('app_lifecycle', {
      description: 'Launch, terminate, install, or uninstall an app on the simulator/emulator.',
      parameters: z.object({
        action: z.enum(['launch', 'terminate', 'install', 'uninstall']).describe('Action to perform'),
        bundleId: z.string().describe('App bundle identifier (e.g., com.example.app)'),
        appPath: z.string().optional().describe('Path to .app or .apk file (for install)'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ action, bundleId, appPath, platform }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return 'No simulator/emulator detected.';

        const commands: Record<string, Record<string, string>> = {
          ios: {
            launch: `xcrun simctl launch booted "${bundleId}"`,
            terminate: `xcrun simctl terminate booted "${bundleId}"`,
            install: `xcrun simctl install booted "${appPath}"`,
            uninstall: `xcrun simctl uninstall booted "${bundleId}"`,
          },
          android: {
            launch: `adb shell am start -n "${bundleId}/.MainActivity"`,
            terminate: `adb shell am force-stop "${bundleId}"`,
            install: `adb install "${appPath}"`,
            uninstall: `adb uninstall "${bundleId}"`,
          },
        };

        const cmd = commands[p][action];
        if (action === 'install' && !appPath) return 'appPath is required for install action.';

        const output = await ctx.exec(cmd);
        return `${action} completed for ${bundleId}${output ? ': ' + output.trim() : ''}`;
      },
    });

    ctx.registerTool('get_screen_orientation', {
      description: 'Get the current screen orientation of the device.',
      parameters: z.object({
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ platform }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return 'No simulator/emulator detected.';

        if (p === 'android') {
          const output = await ctx.exec('adb shell settings get system user_rotation 2>/dev/null');
          const rotation = parseInt(output.trim());
          const orientations: Record<number, string> = {
            0: 'portrait',
            1: 'landscape',
            2: 'reverse-portrait',
            3: 'reverse-landscape',
          };
          return orientations[rotation] || `unknown (${rotation})`;
        }
        return 'Orientation detection is available for Android via adb.';
      },
    });
  },
});
