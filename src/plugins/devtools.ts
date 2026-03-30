import { spawn } from 'child_process';
import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('devtools');

/**
 * Find a Chrome/Edge binary path using the same strategy as Metro's
 * DefaultToolLauncher: try chrome-launcher first, fall back to
 * chromium-edge-launcher.
 */
async function findBrowserPath(): Promise<string | null> {
  try {
    const { Launcher } = await import('chrome-launcher');
    const path = Launcher.getFirstInstallation();
    if (path) return path;
  } catch {}

  try {
    const { Launcher: EdgeLauncher } = await import('chromium-edge-launcher');
    const path = EdgeLauncher.getFirstInstallation();
    if (path) return path;
  } catch {}

  return null;
}

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
        open: z.boolean().default(true).describe('Attempt to open the browser automatically'),
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
          const browserPath = await findBrowserPath();

          if (browserPath) {
            try {
              // Spawn detached in --app mode, exactly like Metro's DefaultToolLauncher.
              const child = spawn(
                browserPath,
                [`--app=${frontendUrl}`, '--window-size=1200,600'],
                { detached: true, stdio: 'ignore' },
              );
              child.unref();
              return { opened: true, url: frontendUrl };
            } catch (err) {
              logger.debug('Failed to launch browser:', err);
            }
          } else {
            logger.debug('No Chrome/Edge installation found');
          }
        }

        return {
          opened: false,
          url: frontendUrl,
          instructions: 'Open this URL in Chrome or Edge: ' + frontendUrl,
        };
      },
    });
  },
});
