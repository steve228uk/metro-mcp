import fs from 'fs';
import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('devtools');
const DEVTOOLS_STATE_FILE = '/tmp/metro-mcp-devtools.json';

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

async function tryFocusExisting(frontendUrl: string): Promise<boolean> {
  try {
    const state = JSON.parse(fs.readFileSync(DEVTOOLS_STATE_FILE, 'utf8'));
    if (!state.pid || !state.remoteDebuggingPort) return false;

    try { process.kill(state.pid, 0); } catch { return false; }

    const resp = await fetch(`http://localhost:${state.remoteDebuggingPort}/json`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!resp.ok) return false;

    const targets = await resp.json() as Array<{ id: string; url: string }>;
    const target = targets.find(t => t.url?.includes('rn_fusebox') || t.url === frontendUrl);
    if (!target?.id) return false;

    const activate = await fetch(
      `http://localhost:${state.remoteDebuggingPort}/json/activate/${target.id}`,
      { signal: AbortSignal.timeout(1000) },
    );
    return activate.ok;
  } catch {
    return false;
  }
}

async function launchDevTools(frontendUrl: string): Promise<void> {
  const { launch } = await import('chrome-launcher');
  const chrome = await launch({
    chromeFlags: [`--app=${frontendUrl}`, '--window-size=1200,600'],
  });
  chrome.process.unref();
  try {
    fs.writeFileSync(
      DEVTOOLS_STATE_FILE,
      JSON.stringify({ pid: chrome.pid, remoteDebuggingPort: chrome.port }),
    );
  } catch (err) {
    logger.warn('Failed to write devtools state:', err);
  }
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
              const focused = await tryFocusExisting(frontendUrl);
              if (!focused) {
                await launchDevTools(frontendUrl);
              }
              return { opened: true, url: frontendUrl };
            } catch (err) {
              logger.debug('Failed to open DevTools:', err);
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
