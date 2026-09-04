import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { reloadApp } from '../utils/reload-app.js';
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
      description: 'Reload the connected app and verify a fresh runtime. Uses Page.reload, with a directed Metro message fallback only for a verified app/device peer.',
      parameters: z.object({
        timeout: z.number().int().min(100).max(60000).default(15000)
          .describe('Maximum time in milliseconds to submit and verify the reload'),
      }),
      handler: async ({ timeout }) => reloadApp(ctx, timeout),
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
