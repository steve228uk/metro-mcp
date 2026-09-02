import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import {
  scanMetroPorts,
  fetchTargets,
  checkMetroStatus,
  classifyMetroTarget,
  type MetroTarget,
} from 'metro-bridge';

export function describeMetroTarget(target: MetroTarget) {
  return {
    id: target.id,
    appId: target.appId,
    title: target.title,
    type: target.type,
    deviceName: target.deviceName,
    logicalDeviceId: target.reactNative?.logicalDeviceId,
    vm: target.vm,
    ...classifyMetroTarget(target),
  };
}

export const devicePlugin = definePlugin({
  name: 'device',

  description: 'Device and connection information',

  async setup(ctx) {
    ctx.registerTool('list_devices', {
      description: 'List connected devices and debuggable targets from Metro bundler.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        rescan: z.boolean().default(false).describe('Rescan all Metro ports'),
      }),
      handler: async ({ rescan }) => {
        const config = ctx.config as Record<string, Record<string, unknown>>;
        const metroConfig = config.metro as { host: string; port: number; autoDiscover: boolean };
        const host = metroConfig?.host || 'localhost';

        if (rescan || metroConfig?.autoDiscover) {
          const servers = await scanMetroPorts(host);
          return servers.map((s) => ({
            port: s.port,
            targets: s.targets.map(describeMetroTarget),
          }));
        }

        const port = metroConfig?.port || 8081;
        const targets = await fetchTargets(host, port);
        return targets.map(describeMetroTarget);
      },
    });

    ctx.registerTool('get_app_info', {
      description: 'Get information about the connected React Native app (bundle URL, platform, device name).',
      annotations: { readOnlyHint: true },
      parameters: z.object({}),
      handler: async () => {
        if (!ctx.cdp.isConnected) {
          return 'Not connected to Metro. Start your React Native app and try again.';
        }

        const target = ctx.cdp.getTarget();
        if (!target) return 'No target info available.';

        return {
          title: target.title,
          type: target.type,
          deviceName: target.deviceName,
          url: target.url,
          vm: target.vm,
          connected: true,
        };
      },
    });

    ctx.registerTool('get_connection_status', {
      description: 'Check the connection status to Metro bundler.',
      annotations: { readOnlyHint: true },
      parameters: z.object({}),
      handler: async () => {
        const config = ctx.config as Record<string, Record<string, unknown>>;
        const metroConfig = config.metro as { host: string; port: number };
        const host = metroConfig?.host || 'localhost';
        const port = metroConfig?.port || 8081;

        const status = await checkMetroStatus(host, port);
        return {
          cdpConnected: ctx.cdp.isConnected,
          metroStatus: status || 'unreachable',
          metroUrl: `http://${host}:${port}`,
        };
      },
    });

    ctx.registerTool('reload_app', {
      description: 'Reload the React Native app. Tries the Metro HTTP endpoint first, falls back to CDP evaluation.',
      annotations: { idempotentHint: true },
      parameters: z.object({}),
      handler: async () => {
        // Try Metro HTTP reload endpoint first (most reliable)
        try {
          const response = await ctx.metro.fetch('/reload');
          if (response.ok) return 'App reloaded via Metro.';
        } catch {
          // Metro endpoint not available, try CDP fallback
        }

        // Fallback: evaluate DevSettings.reload() in the app
        try {
          const result = await ctx.evalInApp(
            `(function() {
              try {
                var DevSettings = require('react-native/Libraries/Utilities/DevSettings');
                if (DevSettings && DevSettings.reload) { DevSettings.reload(); return 'ok'; }
              } catch(e) {}
              try {
                var NativeModules = require('react-native').NativeModules;
                if (NativeModules.DevSettings) { NativeModules.DevSettings.reload(); return 'ok'; }
              } catch(e) {}
              return 'no reload method found';
            })()`
          );
          if (result === 'no reload method found') {
            return 'Could not find a reload method. The app may not support programmatic reload.';
          }
          return 'App reload triggered.';
        } catch (err) {
          return `Could not reload app: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerResource('metro://status', {
      name: 'Connection Status',
      description: 'Current connection status to Metro bundler',
      handler: async () => {
        const target = ctx.cdp.getTarget();
        return JSON.stringify(
          {
            connected: ctx.cdp.isConnected,
            target: target
              ? { title: target.title, deviceName: target.deviceName }
              : null,
          },
          null,
          2
        );
      },
    });
  },
});
