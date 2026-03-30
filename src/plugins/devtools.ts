import { z } from 'zod';
import { definePlugin } from '../plugin.js';

export const devtoolsPlugin = definePlugin({
  name: 'devtools',

  description: 'Open Chrome DevTools alongside the MCP connection',

  async setup(ctx) {
    ctx.registerTool('open_devtools', {
      description:
        'Get the Chrome DevTools URL for the CDP proxy. ' +
        'Since Hermes only allows a single debugger connection, the MCP acts as a proxy ' +
        'so Chrome DevTools can connect alongside the MCP. ' +
        'On macOS, this will also attempt to open Chrome automatically.',
      parameters: z.object({
        open: z.boolean().default(true).describe('Attempt to open Chrome automatically (macOS only)'),
      }),
      handler: async ({ open }) => {
        const config = ctx.config as Record<string, unknown>;
        const proxyConfig = config.proxy as { url?: string; port?: number } | undefined;
        const proxyUrl = proxyConfig?.url;
        const proxyPort = proxyConfig?.port;

        if (!proxyUrl || !proxyPort) {
          return 'CDP proxy is not running. Set proxy.enabled to true in your metro-mcp config.';
        }

        if (open) {
          try {
            // Launch Chrome with the DevTools URL using open -a on macOS.
            // The chrome-devtools:// scheme requires Chrome to handle it directly.
            await ctx.exec(
              `/usr/bin/open -a "Google Chrome" "${proxyUrl}"`
            );
            return { opened: true, url: proxyUrl, port: proxyPort };
          } catch {
            // Not macOS or Chrome not installed — fall through to manual instructions
          }
        }

        return {
          opened: false,
          url: proxyUrl,
          port: proxyPort,
          instructions: `Open this URL in Chrome: ${proxyUrl}`,
        };
      },
    });
  },
});
