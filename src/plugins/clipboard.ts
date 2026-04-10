import { z } from 'zod';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { definePlugin } from '../plugin.js';

const PLATFORM_SCHEMA = z
  .enum(['ios', 'android', 'auto'])
  .default('auto')
  .describe("Target platform. 'auto' detects from active device.");

async function detectPlatform(ctx: { exec: (cmd: string) => Promise<string> }): Promise<'ios' | 'android'> {
  try {
    await ctx.exec('xcrun simctl list devices --json');
    return 'ios';
  } catch {
    return 'android';
  }
}

const GET_CLIPBOARD_EXPR = `(function() {
  try {
    var C = require('@react-native-clipboard/clipboard').default;
    if (C && typeof C.getString === 'function') return C.getString();
  } catch(e) {}
  try {
    var RN = require('react-native');
    if (RN.Clipboard && typeof RN.Clipboard.getString === 'function') return RN.Clipboard.getString();
  } catch(e) {}
  return null;
})()`;

function buildSetClipboardExpr(content: string): string {
  const escaped = JSON.stringify(content);
  return `(function() {
  try {
    var C = require('@react-native-clipboard/clipboard').default;
    if (C && typeof C.setString === 'function') { C.setString(${escaped}); return true; }
  } catch(e) {}
  try {
    var RN = require('react-native');
    if (RN.Clipboard && typeof RN.Clipboard.setString === 'function') { RN.Clipboard.setString(${escaped}); return true; }
  } catch(e) {}
  return false;
})()`;
}

export const clipboardPlugin = definePlugin({
  name: 'clipboard',
  description: 'Read and write the device clipboard for testing copy/paste flows.',

  async setup(ctx) {
    ctx.registerTool('get_clipboard', {
      description:
        'Read the current clipboard content from the device. ' +
        'On iOS Simulator uses xcrun simctl pbpaste. ' +
        'On Android uses @react-native-clipboard/clipboard via evalInApp.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        platform: PLATFORM_SCHEMA,
      }),
      handler: async ({ platform }) => {
        const resolved = platform === 'auto' ? await detectPlatform(ctx) : platform;

        if (resolved === 'ios') {
          try {
            const content = await ctx.exec('xcrun simctl pbpaste booted');
            return { platform: 'ios', content };
          } catch (err) {
            return `Failed to read iOS clipboard: ${err instanceof Error ? err.message : String(err)}. Is the iOS Simulator running?`;
          }
        }

        // Android: try evalInApp first
        try {
          const result = await ctx.evalInApp(GET_CLIPBOARD_EXPR, { awaitPromise: true });
          if (result !== null && result !== undefined) {
            return { platform: 'android', content: String(result) };
          }
        } catch {
          // fall through
        }

        return 'Clipboard not available. Install @react-native-clipboard/clipboard in your app.';
      },
    });

    ctx.registerTool('set_clipboard', {
      description:
        'Write content to the device clipboard. ' +
        'On iOS Simulator uses xcrun simctl pbcopy. ' +
        'On Android uses @react-native-clipboard/clipboard via evalInApp.',
      annotations: { destructiveHint: true },
      parameters: z.object({
        content: z.string().describe('Text to write to the clipboard'),
        platform: PLATFORM_SCHEMA,
      }),
      handler: async ({ content, platform }) => {
        const resolved = platform === 'auto' ? await detectPlatform(ctx) : platform;

        if (resolved === 'ios') {
          // Write to temp file then pipe to pbcopy to safely handle special characters
          const tmpFile = path.join(os.tmpdir(), `metro-mcp-clipboard-${Date.now()}.txt`);
          try {
            fs.writeFileSync(tmpFile, content, 'utf8');
            await ctx.exec(`cat ${JSON.stringify(tmpFile)} | xcrun simctl pbcopy booted`);
            return { platform: 'ios', success: true, length: content.length };
          } catch (err) {
            return `Failed to write iOS clipboard: ${err instanceof Error ? err.message : String(err)}. Is the iOS Simulator running?`;
          } finally {
            try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
          }
        }

        // Android: evalInApp
        try {
          const result = await ctx.evalInApp(buildSetClipboardExpr(content));
          if (result === true) {
            return { platform: 'android', success: true, length: content.length };
          }
        } catch {
          // fall through
        }

        return 'Clipboard write not available. Install @react-native-clipboard/clipboard in your app.';
      },
    });
  },
});
