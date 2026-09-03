import { z } from 'zod';
import { definePlugin, type PluginContext } from '../plugin.js';
import {
  adbPrefix,
  resolveDevice,
} from '../utils/device-discovery.js';

function outputText(output: Buffer | string): string {
  return typeof output === 'string' ? output : output.toString('utf8');
}

/**
 * Extract the schemes declared in an iOS Info.plist JSON representation.
 * Invalid entries are ignored because an app may declare URL types for other
 * platforms or include optional plist values that are not strings.
 */
export function parseBundleUrlSchemes(plist: unknown): string[] {
  if (!plist || typeof plist !== 'object' || Array.isArray(plist)) return [];
  const urlTypes = (plist as Record<string, unknown>).CFBundleURLTypes;
  if (!Array.isArray(urlTypes)) return [];

  const schemes: string[] = [];
  const seen = new Set<string>();
  for (const urlType of urlTypes) {
    if (!urlType || typeof urlType !== 'object' || Array.isArray(urlType)) continue;
    const declared = (urlType as Record<string, unknown>).CFBundleURLSchemes;
    if (!Array.isArray(declared)) continue;
    for (const value of declared) {
      if (typeof value !== 'string') continue;
      const scheme = value.trim();
      if (scheme && !seen.has(scheme)) {
        seen.add(scheme);
        schemes.push(scheme);
      }
    }
  }
  return schemes;
}

/** Keep Android's existing text response while avoiding a shell pipeline. */
export function extractAndroidSchemeDump(output: string): string {
  const lines = output.split(/\r?\n/);
  const selected: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/scheme/i.test(lines[index] ?? '')) continue;
    selected.push(...lines.slice(index, index + 6));
  }
  return selected.join('\n').trim();
}

async function readIosBundleSchemes(
  ctx: PluginContext,
  udid: string,
  bundleId: string,
): Promise<string[]> {
  const appContainer = outputText(
    await ctx.execFile('xcrun', [
      'simctl',
      'get_app_container',
      udid,
      bundleId,
      'app',
    ]),
  ).trim();
  if (!appContainer || appContainer.includes('\0')) {
    throw new Error('simctl did not return an installed app container');
  }

  const plistPath = `${appContainer.replace(/\/+$/, '')}/Info.plist`;
  const plistJson = outputText(
    await ctx.execFile('plutil', ['-convert', 'json', '-o', '-', plistPath]),
  );
  let plist: unknown;
  try {
    plist = JSON.parse(plistJson);
  } catch (error) {
    throw new Error(
      `Info.plist was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseBundleUrlSchemes(plist);
}

export const deeplinkPlugin = definePlugin({
  name: 'deeplink',

  description: 'Cross-platform deep link testing',

  async setup(ctx) {
    const resolveTarget = (platform: 'ios' | 'android' | 'auto') =>
      resolveDevice(ctx, platform, ctx.cdp.getTarget());

    ctx.registerTool('open_deeplink', {
      description: 'Open a URL or deep link on the connected iOS simulator or Android device.',
      annotations: { openWorldHint: true },
      parameters: z.object({
        url: z.string().describe('URL or deep link to open (e.g., "myapp://screen/details" or "https://example.com/path")'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ url, platform }) => {
        const target = await resolveTarget(platform);
        if (!target) return 'No simulator/emulator detected.';
        const p = target.platform;

        if (p === 'ios') {
          await ctx.exec(`xcrun simctl openurl "${target.id}" "${url}"`);
        } else {
          await ctx.exec(
            `${adbPrefix(target.id)} shell am start -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d "${url}"`
          );
        }
        return `Opened "${url}" on ${p === 'ios' ? 'iOS simulator' : 'Android device'}.`;
      },
    });

    ctx.registerTool('list_url_schemes', {
      description: 'List URL schemes registered by an installed iOS app or Android package.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        bundleId: z.string().optional().describe('Bundle ID to check (auto-detected if not provided)'),
      }),
      handler: async ({ bundleId }) => {
        const targetInfo = ctx.cdp.getTarget();
        const target = await resolveTarget('auto');
        if (!target) return 'No simulator/emulator detected.';

        const requestedBundleId = bundleId?.trim() || targetInfo?.appId?.trim();
        if (!requestedBundleId) {
          return 'Bundle ID is required when no connected app target is available.';
        }

        if (target.platform === 'ios') {
          try {
            const schemes = await readIosBundleSchemes(
              ctx,
              target.id,
              requestedBundleId,
            );
            return schemes.length > 0 ? schemes : 'No URL schemes found.';
          } catch (error) {
            return `Could not read URL schemes for "${requestedBundleId}": ${error instanceof Error ? error.message : String(error)}`;
          }
        }

        // Android has no Info.plist equivalent. Keep the established package
        // dump response, but scope it to the resolved serial and filter it in
        // memory rather than sending an interpolated shell pipeline.
        try {
          const output = outputText(
            await ctx.execFile('adb', [
              '-s',
              target.id,
              'shell',
              'pm',
              'dump',
              requestedBundleId,
            ]),
          );
          return extractAndroidSchemeDump(output) || 'No URL schemes found.';
        } catch (error) {
          return `Could not read URL schemes for "${requestedBundleId}": ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    });
  },
});
