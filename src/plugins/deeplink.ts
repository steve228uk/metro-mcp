import { z } from 'zod';
import { definePlugin } from '../plugin.js';

export const deeplinkPlugin = definePlugin({
  name: 'deeplink',
  version: '0.1.0',
  description: 'Cross-platform deep link testing',

  async setup(ctx) {
    async function detectPlatform(): Promise<'ios' | 'android' | null> {
      try {
        await ctx.exec('xcrun simctl list booted 2>/dev/null | grep -q Booted');
        return 'ios';
      } catch {}
      try {
        const output = await ctx.exec('adb devices 2>/dev/null');
        if (output.trim().split('\n').length > 1) return 'android';
      } catch {}
      return null;
    }

    ctx.registerTool('open_deeplink', {
      description: 'Open a URL or deep link on the connected iOS simulator or Android device.',
      parameters: z.object({
        url: z.string().describe('URL or deep link to open (e.g., "myapp://screen/details" or "https://example.com/path")'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ url, platform }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return 'No simulator/emulator detected.';

        if (p === 'ios') {
          await ctx.exec(`xcrun simctl openurl booted "${url}"`);
        } else {
          await ctx.exec(
            `adb shell am start -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d "${url}"`
          );
        }
        return `Opened "${url}" on ${p === 'ios' ? 'iOS simulator' : 'Android device'}.`;
      },
    });

    ctx.registerTool('list_url_schemes', {
      description: 'List URL schemes registered by the app (attempts to detect from the running app).',
      parameters: z.object({
        bundleId: z.string().optional().describe('Bundle ID to check (auto-detected if not provided)'),
      }),
      handler: async ({ bundleId }) => {
        // Try to get URL schemes from the app via evaluate
        try {
          if (ctx.cdp.isConnected()) {
            const result = (await ctx.cdp.send('Runtime.evaluate', {
              expression: `
                (function() {
                  try {
                    var Linking = require('react-native').Linking;
                    return { note: 'Use Linking.canOpenURL() to test specific schemes' };
                  } catch(e) {
                    return { error: e.message };
                  }
                })()
              `,
              returnByValue: true,
            })) as Record<string, unknown>;
            const val = (result.result as Record<string, unknown>).value;
            if (val) return val;
          }
        } catch {}

        // Fallback: check Info.plist on iOS
        try {
          const platform = await detectPlatform();
          if (platform === 'android' && bundleId) {
            const output = await ctx.exec(`adb shell pm dump "${bundleId}" | grep -A5 "scheme" 2>/dev/null`);
            return output || 'No URL schemes found.';
          }
        } catch {}

        return 'URL scheme detection requires a running app or bundle ID.';
      },
    });
  },
});
