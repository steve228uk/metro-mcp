import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('devtools');

export const devtoolsPlugin = definePlugin({
  name: 'devtools',

  description: 'Open React Native DevTools via the CDP proxy',

  async setup(ctx) {
    ctx.registerTool('open_devtools', {
      description:
        'Open the React Native DevTools debugger panel in Chrome. ' +
        'Uses Metro\'s bundled DevTools frontend but connects through our CDP proxy ' +
        'so both DevTools and the MCP can share the single Hermes connection.',
      parameters: z.object({
        open: z.boolean().default(true).describe('Attempt to open Chrome automatically (macOS only)'),
      }),
      handler: async ({ open }) => {
        const config = ctx.config as Record<string, unknown>;
        const proxyConfig = config.proxy as { port?: number } | undefined;
        const proxyPort = proxyConfig?.port;

        if (!proxyPort) {
          return 'CDP proxy is not running. Set proxy.enabled to true in your metro-mcp config.';
        }

        // Build a URL using Metro's own DevTools frontend, but pointing the
        // WebSocket connection at our proxy instead of Metro's inspector.
        // This is the same frontend Metro uses when you press "j", served
        // from the @react-native/debugger-frontend package.
        const frontendUrl = `http://${ctx.metro.host}:${ctx.metro.port}/debugger-frontend/rn_fusebox.html`
          + `?ws=127.0.0.1:${proxyPort}`
          + `&sources.hide_add_folder=true`;

        if (open) {
          try {
            // Launch Chrome in app mode like Metro does (via DefaultToolLauncher)
            await ctx.exec(
              `/usr/bin/open -a "Google Chrome" --args --app="${frontendUrl}" --window-size=1200,600`
            );
            return { opened: true, url: frontendUrl };
          } catch {
            // Not macOS or Chrome not installed
          }
        }

        return {
          opened: false,
          url: frontendUrl,
          instructions: 'Open this URL in Chrome: ' + frontendUrl,
        };
      },
    });
  },
});
