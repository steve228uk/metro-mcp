import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { scanMetroPorts, fetchTargets, checkMetroStatus } from '../metro/discovery.js';
import type { CDPClient } from '../metro/connection.js';

export const devicePlugin = definePlugin({
  name: 'device',
  version: '0.1.0',
  description: 'Device and connection information',

  async setup(ctx) {
    ctx.registerTool('list_devices', {
      description: 'List connected devices and debuggable targets from Metro bundler.',
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
            targets: s.targets.map((t) => ({
              id: t.id,
              title: t.title,
              type: t.type,
              deviceName: t.deviceName,
              vm: t.vm,
            })),
          }));
        }

        const port = metroConfig?.port || 8081;
        const targets = await fetchTargets(host, port);
        return targets.map((t) => ({
          id: t.id,
          title: t.title,
          type: t.type,
          deviceName: t.deviceName,
          vm: t.vm,
        }));
      },
    });

    ctx.registerTool('get_app_info', {
      description: 'Get information about the connected React Native app (bundle URL, platform, device name).',
      parameters: z.object({}),
      handler: async () => {
        if (!ctx.cdp.isConnected()) {
          return 'Not connected to Metro. Start your React Native app and try again.';
        }

        const cdpClient = ctx.cdp as CDPClient;
        const target = cdpClient.getTarget();
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
      parameters: z.object({}),
      handler: async () => {
        const config = ctx.config as Record<string, Record<string, unknown>>;
        const metroConfig = config.metro as { host: string; port: number };
        const host = metroConfig?.host || 'localhost';
        const port = metroConfig?.port || 8081;

        const status = await checkMetroStatus(host, port);
        return {
          cdpConnected: ctx.cdp.isConnected(),
          metroStatus: status || 'unreachable',
          metroUrl: `http://${host}:${port}`,
        };
      },
    });

    ctx.registerResource('metro://status', {
      name: 'Connection Status',
      description: 'Current connection status to Metro bundler',
      handler: async () => {
        const cdpClient = ctx.cdp as CDPClient;
        const target = cdpClient.getTarget();
        return JSON.stringify(
          {
            connected: ctx.cdp.isConnected(),
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
