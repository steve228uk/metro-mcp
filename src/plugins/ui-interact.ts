import { z } from 'zod';
import { definePlugin } from '../plugin.js';

export const uiInteractPlugin = definePlugin({
  name: 'ui-interact',
  version: '0.1.0',
  description: 'UI automation via accessibility tree and native input',

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

    ctx.registerTool('list_elements', {
      description:
        'Get the accessibility tree with element labels, types, and coordinates. Structured data, no vision model needed.',
      parameters: z.object({
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ platform }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return 'No simulator/emulator detected.';

        if (p === 'ios') {
          try {
            // Try using idb if available
            const output = await ctx.exec('idb ui describe-all --udid booted 2>/dev/null');
            return output;
          } catch {
            // Fall back to accessibility description
            try {
              const output = await ctx.exec(
                'xcrun simctl spawn booted accessibility_inspector 2>/dev/null || echo "Use idb for element listing on iOS"'
              );
              return output || 'Install Facebook IDB (brew install idb-companion) for iOS element listing.';
            } catch {
              return 'Install Facebook IDB (brew install idb-companion) for iOS element listing, or use get_component_tree for React-level inspection.';
            }
          }
        } else {
          try {
            const tmpFile = '/tmp/metro-mcp-uidump.xml';
            await ctx.exec(`adb shell uiautomator dump /sdcard/uidump.xml 2>/dev/null && adb pull /sdcard/uidump.xml ${tmpFile} 2>/dev/null`);
            const content = await Bun.file(tmpFile).text();
            await ctx.exec(`rm -f ${tmpFile}`);

            // Parse the XML to extract elements
            const elements: Array<Record<string, string>> = [];
            const nodeRegex = /<node\s([^>]+)\/>/g;
            let match;
            while ((match = nodeRegex.exec(content)) !== null) {
              const attrs: Record<string, string> = {};
              const attrRegex = /(\w+(?:-\w+)*)="([^"]*)"/g;
              let attrMatch;
              while ((attrMatch = attrRegex.exec(match[1])) !== null) {
                attrs[attrMatch[1]] = attrMatch[2];
              }
              if (attrs['text'] || attrs['content-desc'] || attrs['resource-id']) {
                elements.push({
                  text: attrs['text'] || '',
                  contentDesc: attrs['content-desc'] || '',
                  resourceId: attrs['resource-id'] || '',
                  className: attrs['class'] || '',
                  bounds: attrs['bounds'] || '',
                  clickable: attrs['clickable'] || 'false',
                  enabled: attrs['enabled'] || 'true',
                });
              }
            }
            return elements;
          } catch (err) {
            return `Failed to get UI elements: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      },
    });

    ctx.registerTool('tap_element', {
      description: 'Tap an element by accessibility label, text, resource ID, or coordinates.',
      parameters: z.object({
        label: z.string().optional().describe('Accessibility label or text to find and tap'),
        x: z.number().optional().describe('X coordinate to tap'),
        y: z.number().optional().describe('Y coordinate to tap'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ label, x, y, platform }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return 'No simulator/emulator detected.';

        if (x !== undefined && y !== undefined) {
          if (p === 'ios') {
            try {
              await ctx.exec(`idb ui tap ${x} ${y} --udid booted 2>/dev/null`);
            } catch {
              await ctx.exec(`xcrun simctl io booted tap ${x} ${y} 2>/dev/null`);
            }
          } else {
            await ctx.exec(`adb shell input tap ${x} ${y}`);
          }
          return `Tapped at (${x}, ${y})`;
        }

        if (!label) return 'Provide either a label/text or x,y coordinates.';

        if (p === 'android') {
          // Find element by text and tap its center
          const tmpFile = '/tmp/metro-mcp-uidump.xml';
          await ctx.exec(`adb shell uiautomator dump /sdcard/uidump.xml && adb pull /sdcard/uidump.xml ${tmpFile} 2>/dev/null`);
          const content = await Bun.file(tmpFile).text();
          await ctx.exec(`rm -f ${tmpFile}`);

          const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(`text="${escapedLabel}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i');
          const match = content.match(regex) || content.match(new RegExp(`content-desc="${escapedLabel}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i'));

          if (match) {
            const cx = Math.round((parseInt(match[1]) + parseInt(match[3])) / 2);
            const cy = Math.round((parseInt(match[2]) + parseInt(match[4])) / 2);
            await ctx.exec(`adb shell input tap ${cx} ${cy}`);
            return `Tapped "${label}" at (${cx}, ${cy})`;
          }
          return `Element "${label}" not found.`;
        } else {
          try {
            await ctx.exec(`idb ui tap --by-label "${label}" --udid booted 2>/dev/null`);
            return `Tapped "${label}"`;
          } catch {
            return `Element "${label}" not found or IDB not available. Use coordinates instead.`;
          }
        }
      },
    });

    ctx.registerTool('swipe', {
      description: 'Swipe on the screen in a given direction.',
      parameters: z.object({
        direction: z.enum(['up', 'down', 'left', 'right']).describe('Swipe direction'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ direction, platform }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return 'No simulator/emulator detected.';

        // Use midpoint-based swipe
        const swipeCoords: Record<string, [number, number, number, number]> = {
          up: [500, 1500, 500, 500],
          down: [500, 500, 500, 1500],
          left: [800, 1000, 200, 1000],
          right: [200, 1000, 800, 1000],
        };

        const [sx, sy, ex, ey] = swipeCoords[direction];

        if (p === 'ios') {
          try {
            await ctx.exec(`idb ui swipe ${sx} ${sy} ${ex} ${ey} --udid booted 2>/dev/null`);
          } catch {
            return 'Swipe requires IDB on iOS. Install with: brew install idb-companion';
          }
        } else {
          await ctx.exec(`adb shell input swipe ${sx} ${sy} ${ex} ${ey} 300`);
        }
        return `Swiped ${direction}`;
      },
    });

    ctx.registerTool('type_text', {
      description: 'Type text into the currently focused input field.',
      parameters: z.object({
        text: z.string().describe('Text to type'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ text, platform }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return 'No simulator/emulator detected.';

        if (p === 'ios') {
          try {
            await ctx.exec(`idb ui text "${text}" --udid booted 2>/dev/null`);
          } catch {
            // Fallback: use simctl keyboard
            await ctx.exec(`xcrun simctl io booted keyboard "${text}" 2>/dev/null`);
          }
        } else {
          // Escape special characters for adb
          const escaped = text.replace(/ /g, '%s').replace(/"/g, '\\"');
          await ctx.exec(`adb shell input text "${escaped}"`);
        }
        return `Typed: "${text}"`;
      },
    });

    ctx.registerTool('press_button', {
      description: 'Press a device button (HOME, BACK, VOLUME_UP, etc.).',
      parameters: z.object({
        button: z.enum(['HOME', 'BACK', 'VOLUME_UP', 'VOLUME_DOWN', 'POWER', 'ENTER', 'DELETE']).describe('Button to press'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ button, platform }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return 'No simulator/emulator detected.';

        if (p === 'android') {
          const keycodes: Record<string, number> = {
            HOME: 3, BACK: 4, VOLUME_UP: 24, VOLUME_DOWN: 25,
            POWER: 26, ENTER: 66, DELETE: 67,
          };
          await ctx.exec(`adb shell input keyevent ${keycodes[button]}`);
        } else {
          try {
            const idbButtons: Record<string, string> = {
              HOME: 'HOME', VOLUME_UP: 'VOLUME_UP', VOLUME_DOWN: 'VOLUME_DOWN',
              POWER: 'LOCK', BACK: 'HOME',
            };
            await ctx.exec(`idb ui button ${idbButtons[button] || button} --udid booted 2>/dev/null`);
          } catch {
            if (button === 'HOME') {
              await ctx.exec('xcrun simctl spawn booted launchctl kickstart -k system/com.apple.SpringBoard 2>/dev/null');
            } else {
              return `Button ${button} requires IDB on iOS.`;
            }
          }
        }
        return `Pressed ${button}`;
      },
    });

    ctx.registerTool('long_press', {
      description: 'Long press at coordinates.',
      parameters: z.object({
        x: z.number().describe('X coordinate'),
        y: z.number().describe('Y coordinate'),
        duration: z.number().default(1000).describe('Duration in milliseconds'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ x, y, duration, platform }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return 'No simulator/emulator detected.';

        if (p === 'android') {
          await ctx.exec(`adb shell input swipe ${x} ${y} ${x} ${y} ${duration}`);
        } else {
          try {
            await ctx.exec(`idb ui long-press ${x} ${y} --duration ${duration / 1000} --udid booted 2>/dev/null`);
          } catch {
            return 'Long press requires IDB on iOS.';
          }
        }
        return `Long pressed at (${x}, ${y}) for ${duration}ms`;
      },
    });
  },
});
