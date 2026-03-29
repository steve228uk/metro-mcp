import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { FIBER_ROOT_JS, GET_ROUTE_FUNC_JS, SWIPE_COORDS } from '../utils/fiber.js';

// Module-level caches — persist across tool handler calls for the lifetime of the server.
let idbAvailableCache: boolean | null = null;
let platformCache: { value: 'ios' | 'android' | null; ts: number } | null = null;
const PLATFORM_TTL_MS = 5000;

export const uiInteractPlugin = definePlugin({
  name: 'ui-interact',
  version: '0.1.0',
  description: 'UI automation via fiber tree, simctl, adb, and IDB',

  async setup(ctx) {
    async function detectPlatform(): Promise<'ios' | 'android' | null> {
      const now = Date.now();
      if (platformCache && now - platformCache.ts < PLATFORM_TTL_MS) return platformCache.value;
      const [iosResult, androidResult] = await Promise.allSettled([
        ctx.exec('xcrun simctl list booted 2>/dev/null | grep -q Booted'),
        ctx.exec('adb devices 2>/dev/null'),
      ]);
      let platform: 'ios' | 'android' | null = null;
      if (iosResult.status === 'fulfilled') {
        platform = 'ios';
      } else if (androidResult.status === 'fulfilled') {
        const output = (androidResult as PromiseFulfilledResult<string>).value;
        if (output.trim().split('\n').length > 1) platform = 'android';
      }
      platformCache = { value: platform, ts: now };
      return platform;
    }

    async function isIDBAvailable(): Promise<boolean> {
      if (idbAvailableCache !== null) return idbAvailableCache;
      try {
        await ctx.exec('which idb 2>/dev/null');
        idbAvailableCache = true;
      } catch {
        idbAvailableCache = false;
      }
      return idbAvailableCache;
    }

    const IDB_INSTALL = 'Install IDB with: brew install idb-companion';

    ctx.registerTool('list_elements', {
      description:
        'Get interactive elements from the current screen via the React component tree. Returns labels, testIDs, and roles — use label or testID with tap_element.',
      parameters: z.object({
        interactiveOnly: z.boolean().default(false).describe('Return only elements with onPress handlers'),
      }),
      handler: async ({ interactiveOnly }) => {
        const elements = await ctx.evalInApp(`
          (function() {
            ${FIBER_ROOT_JS}
            var results = [];
            var INTERACTIVE = new Set([
              'TouchableOpacity','TouchableHighlight','TouchableWithoutFeedback',
              'TouchableNativeFeedback','Pressable','Button',
              'RectButton','BorderlessButton','BaseButton','TouchableRipple',
              'LongPressGestureHandler','TapGestureHandler',
              'Chip','FAB','IconButton','ListItem','MenuItem',
            ]);
            function getName(fiber) {
              if (!fiber || !fiber.type) return null;
              if (typeof fiber.type === 'string') return fiber.type;
              return fiber.type.displayName || fiber.type.name || null;
            }
            var seenTestIDs = {};
            var stack = [{ fiber: rootFiber, depth: 0 }];
            while (stack.length > 0) {
              var item = stack.pop();
              var fiber = item.fiber; var depth = item.depth;
              if (!fiber || depth > 200) continue;
              var name = getName(fiber);
              if (name && name.indexOf('RCT') === 0) {
                if (fiber.sibling) stack.push({ fiber: fiber.sibling, depth: depth });
                if (fiber.child) stack.push({ fiber: fiber.child, depth: depth + 1 });
                continue;
              }
              if (name) {
                var props = fiber.memoizedProps || {};
                var label = props.accessibilityLabel || props['aria-label'] || null;
                var testID = props.testID || null;
                var role  = props.accessibilityRole || props['role'] || null;
                var interactive = !!(props.onPress || props.onPressIn || props.onLongPress ||
                                     props.onTap || props.onClick || props.accessible ||
                                     props.hitSlop || ('disabled' in props)) ||
                                  INTERACTIVE.has(name);
                if (label || testID || interactive) {
                  if (!testID || !seenTestIDs[testID]) {
                    if (testID) seenTestIDs[testID] = true;
                    results.push({ type: name, label, testID, role, interactive,
                                   hint: props.accessibilityHint || null });
                  }
                }
              }
              if (fiber.sibling) stack.push({ fiber: fiber.sibling, depth: depth });
              if (fiber.child) stack.push({ fiber: fiber.child, depth: depth + 1 });
            }
            return results;
          })()
        `).catch(() => null);

        if (!elements || !Array.isArray(elements)) {
          return 'Component tree not available. Ensure the app is running and Metro is connected.';
        }
        const filtered = interactiveOnly
          ? (elements as Array<Record<string, unknown>>).filter((e) => e.interactive)
          : elements;
        if ((filtered as unknown[]).length === 0) {
          return interactiveOnly
            ? 'No interactive elements found on the current screen.'
            : 'No labelled or interactive elements found on the current screen.';
        }
        return filtered;
      },
    });

    ctx.registerTool('tap_element', {
      description:
        'Tap an element by label, testID, or coordinates. Uses CDP fiber tree, then simctl/adb, then IDB.',
      parameters: z.object({
        label: z.string().optional().describe('Accessibility label, aria-label, or testID to tap'),
        x: z.number().optional().describe('X coordinate'),
        y: z.number().optional().describe('Y coordinate'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ label, x, y, platform }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return 'No simulator/emulator detected.';

        // ── Coordinate tap ──────────────────────────────────────────────────
        if (x !== undefined && y !== undefined) {
          if (p === 'android') {
            await ctx.exec(`adb shell input tap ${x} ${y}`);
            return `Tapped at (${x}, ${y})`;
          }
          // iOS: simctl first (Xcode 14+), then IDB
          try {
            await ctx.exec(`xcrun simctl io booted tap ${x} ${y}`);
            return `Tapped at (${x}, ${y})`;
          } catch {}
          if (!(await isIDBAvailable())) {
            return `Coordinate tap failed. ${IDB_INSTALL}`;
          }
          await ctx.exec(`idb ui tap ${x} ${y} --udid booted`);
          return `Tapped at (${x}, ${y})`;
        }

        if (!label) return 'Provide a label/testID or x,y coordinates.';

        // ── Label/testID tap: CDP fiber tree (works on both platforms) ───────
        const jsLabel = JSON.stringify(label);
        const tapped = await ctx.evalInApp(`
          (function() {
            ${FIBER_ROOT_JS}
            var needle = ${jsLabel};
            var target = null;
            var stack = [rootFiber];
            while (stack.length && !target) {
              var fiber = stack.pop();
              if (!fiber) continue;
              var props = fiber.memoizedProps || {};
              if ((props.accessibilityLabel === needle ||
                   props['aria-label'] === needle ||
                   props.testID === needle) && props.onPress) {
                target = fiber;
              } else {
                if (fiber.sibling) stack.push(fiber.sibling);
                if (fiber.child) stack.push(fiber.child);
              }
            }
            if (!target) return false;
            target.memoizedProps.onPress({ nativeEvent: {} });
            return true;
          })()
        `).catch(() => false);
        if (tapped) return `Tapped "${label}"`;

        // ── Android fallback: adb uiautomator ───────────────────────────────
        if (p === 'android') {
          const tmpFile = '/tmp/metro-mcp-uidump.xml';
          let content = '';
          try {
            await ctx.exec(
              `adb shell uiautomator dump /sdcard/uidump.xml && adb pull /sdcard/uidump.xml ${tmpFile} 2>/dev/null`
            );
            content = await Bun.file(tmpFile).text();
          } finally {
            await ctx.exec(`rm -f ${tmpFile}`).catch(() => {});
          }
          try {
            const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const bounds = `"\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`;
            const match =
              content.match(new RegExp(`text="${esc}"[^>]*bounds=${bounds}`, 'i')) ||
              content.match(new RegExp(`content-desc="${esc}"[^>]*bounds=${bounds}`, 'i'));
            if (match) {
              const cx = Math.round((parseInt(match[1]) + parseInt(match[3])) / 2);
              const cy = Math.round((parseInt(match[2]) + parseInt(match[4])) / 2);
              await ctx.exec(`adb shell input tap ${cx} ${cy}`);
              return `Tapped "${label}" at (${cx}, ${cy})`;
            }
          } catch {}
          return `Element "${label}" not found.`;
        }

        // ── iOS fallback: IDB --by-label ─────────────────────────────────────
        if (!(await isIDBAvailable())) {
          return `Element "${label}" not found via fiber tree. ${IDB_INSTALL}`;
        }
        try {
          await ctx.exec(`idb ui tap --by-label "${label}" --udid booted`);
          return `Tapped "${label}"`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : '';
          if (msg.includes('117')) {
            return `IDB exit 117: companion not running. Try: idb_companion --udid booted &`;
          }
          return `Element "${label}" not found.`;
        }
      },
    });

    ctx.registerTool('type_text', {
      description:
        'Type text into an input field. Targets a specific input by testID/label, or the first visible TextInput. Uses CDP fiber tree, then adb/IDB.',
      parameters: z.object({
        text: z.string().describe('Text to type'),
        testID: z
          .string()
          .optional()
          .describe('testID or accessibilityLabel of the TextInput to target (defaults to first visible input)'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ text, testID, platform }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return 'No simulator/emulator detected.';

        // ── CDP: find TextInput and call onChangeText ─────────────────────────
        const jsText = JSON.stringify(text);
        const jsTestID = testID ? JSON.stringify(testID) : 'null';
        const typed = await ctx.evalInApp(`
          (function() {
            ${FIBER_ROOT_JS}
            var targetID = ${jsTestID};
            var target = null;
            var stack = [{ f: rootFiber, d: 0 }];
            while (stack.length && !target) {
              var item = stack.pop();
              var fiber = item.f; var depth = item.d;
              if (!fiber || depth > 200) continue;
              var name = typeof fiber.type === 'string' ? fiber.type :
                         (fiber.type && (fiber.type.displayName || fiber.type.name));
              if (name === 'TextInput') {
                var props = fiber.memoizedProps || {};
                if (!targetID || props.testID === targetID || props.accessibilityLabel === targetID) {
                  target = fiber;
                }
              }
              if (!target) {
                if (fiber.sibling) stack.push({ f: fiber.sibling, d: depth });
                if (fiber.child) stack.push({ f: fiber.child, d: depth + 1 });
              }
            }
            if (!target) return false;
            var props = target.memoizedProps || {};
            if (props.onChangeText) { props.onChangeText(${jsText}); return true; }
            if (props.onChange) {
              props.onChange({ nativeEvent: { text: ${jsText}, target: 0, eventCount: 1 } });
              return true;
            }
            return false;
          })()
        `).catch(() => false);
        if (typed) return `Typed "${text}"`;

        // ── Android fallback: adb input text ─────────────────────────────────
        if (p === 'android') {
          // adb shell input text uses %s for spaces; other shell metacharacters need escaping.
          const escaped = text
            .replace(/\\/g, '\\\\')
            .replace(/ /g, '%s')
            .replace(/"/g, '\\"')
            .replace(/&/g, '\\&')
            .replace(/\|/g, '\\|')
            .replace(/;/g, '\\;')
            .replace(/\$/g, '\\$')
            .replace(/`/g, '\\`');
          await ctx.exec(`adb shell input text "${escaped}"`);
          return `Typed "${text}"`;
        }

        // ── iOS fallback: IDB ─────────────────────────────────────────────────
        if (!(await isIDBAvailable())) {
          return `Could not find a TextInput via fiber tree. ${IDB_INSTALL}`;
        }
        await ctx.exec(`idb ui text "${text}" --udid booted`);
        return `Typed "${text}"`;
      },
    });

    ctx.registerTool('long_press', {
      description:
        'Long press an element by label/testID, or at coordinates. Uses CDP fiber tree, then adb/IDB.',
      parameters: z.object({
        label: z.string().optional().describe('Accessibility label or testID of the element to long press'),
        x: z.number().optional().describe('X coordinate'),
        y: z.number().optional().describe('Y coordinate'),
        duration: z.number().default(1000).describe('Duration in milliseconds'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ label, x, y, duration, platform }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return 'No simulator/emulator detected.';

        // ── CDP: find element by label/testID and call onLongPress ────────────
        if (label) {
          const jsLabel = JSON.stringify(label);
          const pressed = await ctx.evalInApp(`
            (function() {
              ${FIBER_ROOT_JS}
              var needle = ${jsLabel};
              var target = null;
              var stack = [rootFiber];
              while (stack.length && !target) {
                var fiber = stack.pop();
                if (!fiber) continue;
                var props = fiber.memoizedProps || {};
                if ((props.accessibilityLabel === needle ||
                     props['aria-label'] === needle ||
                     props.testID === needle) && props.onLongPress) {
                  target = fiber;
                } else {
                  if (fiber.sibling) stack.push(fiber.sibling);
                  if (fiber.child) stack.push(fiber.child);
                }
              }
              if (!target) return false;
              target.memoizedProps.onLongPress({ nativeEvent: {} });
              return true;
            })()
          `).catch(() => false);
          if (pressed) return `Long pressed "${label}"`;
        }

        // ── Coordinate fallbacks ──────────────────────────────────────────────
        if (x !== undefined && y !== undefined) {
          if (p === 'android') {
            await ctx.exec(`adb shell input swipe ${x} ${y} ${x} ${y} ${duration}`);
            return `Long pressed at (${x}, ${y}) for ${duration}ms`;
          }
          if (!(await isIDBAvailable())) {
            return `Coordinate long press requires IDB on iOS. ${IDB_INSTALL}`;
          }
          await ctx.exec(`idb ui long-press ${x} ${y} --duration ${duration / 1000} --udid booted`);
          return `Long pressed at (${x}, ${y}) for ${duration}ms`;
        }

        return label
          ? `Element "${label}" not found or has no onLongPress handler. Provide x,y coordinates as fallback.`
          : 'Provide a label/testID or x,y coordinates.';
      },
    });

    ctx.registerTool('swipe', {
      description:
        'Swipe or scroll in a direction. Tries CDP ScrollView scrollTo, then adb/IDB.',
      parameters: z.object({
        direction: z.enum(['up', 'down', 'left', 'right']).describe('Swipe direction'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ direction, platform }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return 'No simulator/emulator detected.';

        let result: string | null = null;

        // ── CDP: find ScrollView and invoke scrollTo on its native node ────────
        const jsDir = JSON.stringify(direction);
        const scrolled = await ctx.evalInApp(`
          (function() {
            ${FIBER_ROOT_JS}
            var dir = ${jsDir};
            var target = null;
            var stack = [{ f: rootFiber, d: 0 }];
            while (stack.length && !target) {
              var item = stack.pop();
              var fiber = item.f; var depth = item.d;
              if (!fiber || depth > 200) continue;
              var name = typeof fiber.type === 'string' ? fiber.type :
                         (fiber.type && (fiber.type.displayName || fiber.type.name));
              if (name === 'ScrollView' || name === 'FlatList' || name === 'SectionList') {
                target = fiber;
              } else {
                if (fiber.sibling) stack.push({ f: fiber.sibling, d: depth });
                if (fiber.child) stack.push({ f: fiber.child, d: depth + 1 });
              }
            }
            if (!target) return false;
            // Walk down to the host (RCT) fiber whose stateNode has scroll methods
            var hf = target.child;
            while (hf && typeof hf.type !== 'string') hf = hf.child;
            if (!hf || !hf.stateNode) return false;
            var node = hf.stateNode;
            var delta = 400;
            try {
              if (typeof node.scrollTo === 'function') {
                node.scrollTo({
                  x: dir === 'left' ? delta : dir === 'right' ? -delta : 0,
                  y: dir === 'up' ? delta : dir === 'down' ? -delta : 0,
                  animated: true,
                });
                return true;
              }
              if (typeof node.scrollToOffset === 'function') {
                node.scrollToOffset({ offset: dir === 'up' ? delta : 0, animated: true });
                return true;
              }
            } catch(e) {}
            return false;
          })()
        `).catch(() => false);
        if (scrolled) result = `Swiped ${direction}`;

        if (!result) {
          // ── Native fallbacks (fixed midpoint coordinates) ───────────────────
          const [sx, sy, ex, ey] = SWIPE_COORDS[direction];

          if (p === 'android') {
            await ctx.exec(`adb shell input swipe ${sx} ${sy} ${ex} ${ey} 300`);
            result = `Swiped ${direction}`;
          } else if (!(await isIDBAvailable())) {
            return `Swipe requires IDB on iOS. ${IDB_INSTALL}`;
          } else {
            await ctx.exec(`idb ui swipe ${sx} ${sy} ${ex} ${ey} --udid booted`);
            result = `Swiped ${direction}`;
          }
        }

        // ── Log to test recorder if a recording is active ─────────────────────
        await ctx.evalInApp(`
          (function() {
            if (!globalThis.__METRO_MCP_REC_ACTIVE__) return;
            ${GET_ROUTE_FUNC_JS}
            globalThis.__METRO_MCP_REC_EVENTS__.push({
              type: 'swipe', direction: ${JSON.stringify(direction)},
              route: getRoute(), timestamp: Date.now()
            });
          })()
        `, { timeout: 2000 }).catch(() => {});

        return result;
      },
    });

    ctx.registerTool('press_button', {
      description: 'Press a device button (HOME, BACK, VOLUME_UP, etc.).',
      parameters: z.object({
        button: z
          .enum(['HOME', 'BACK', 'VOLUME_UP', 'VOLUME_DOWN', 'POWER', 'ENTER', 'DELETE'])
          .describe('Button to press'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ button, platform }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return 'No simulator/emulator detected.';

        // ── Android: adb keycodes ─────────────────────────────────────────────
        if (p === 'android') {
          const keycodes: Record<string, number> = {
            HOME: 3, BACK: 4, VOLUME_UP: 24, VOLUME_DOWN: 25,
            POWER: 26, ENTER: 66, DELETE: 67,
          };
          await ctx.exec(`adb shell input keyevent ${keycodes[button]}`);
          return `Pressed ${button}`;
        }

        // ── iOS HOME: simctl (no IDB needed) ──────────────────────────────────
        if (button === 'HOME') {
          try {
            await ctx.exec(
              'xcrun simctl spawn booted launchctl kickstart -k system/com.apple.SpringBoard 2>/dev/null'
            );
            return 'Pressed HOME';
          } catch {}
        }

        // ── iOS ENTER/DELETE: CDP on focused TextInput ─────────────────────────
        if (p === 'ios' && button === 'ENTER') {
          const submitted = await ctx.evalInApp(`
            (function() {
              ${FIBER_ROOT_JS}
              var target = null;
              var stack = [{ f: rootFiber, d: 0 }];
              while (stack.length && !target) {
                var item = stack.pop();
                var fiber = item.f; var depth = item.d;
                if (!fiber || depth > 200) continue;
                var name = typeof fiber.type === 'string' ? fiber.type :
                           (fiber.type && (fiber.type.displayName || fiber.type.name));
                if (name === 'TextInput' && fiber.memoizedProps && fiber.memoizedProps.onSubmitEditing) {
                  target = fiber;
                }
                if (!target) {
                  if (fiber.sibling) stack.push({ f: fiber.sibling, d: depth });
                  if (fiber.child) stack.push({ f: fiber.child, d: depth + 1 });
                }
              }
              if (!target) return false;
              target.memoizedProps.onSubmitEditing({ nativeEvent: { text: target.memoizedProps.value || '' } });
              return true;
            })()
          `).catch(() => false);
          if (submitted) return 'Pressed ENTER';
        }

        if (p === 'ios' && button === 'DELETE') {
          const deleted = await ctx.evalInApp(`
            (function() {
              ${FIBER_ROOT_JS}
              var target = null;
              var stack = [{ f: rootFiber, d: 0 }];
              while (stack.length && !target) {
                var item = stack.pop();
                var fiber = item.f; var depth = item.d;
                if (!fiber || depth > 200) continue;
                var name = typeof fiber.type === 'string' ? fiber.type :
                           (fiber.type && (fiber.type.displayName || fiber.type.name));
                if (name === 'TextInput' && fiber.memoizedProps && fiber.memoizedProps.onChangeText) {
                  target = fiber;
                }
                if (!target) {
                  if (fiber.sibling) stack.push({ f: fiber.sibling, d: depth });
                  if (fiber.child) stack.push({ f: fiber.child, d: depth + 1 });
                }
              }
              if (!target) return false;
              var val = (target.memoizedProps.value || '').slice(0, -1);
              target.memoizedProps.onChangeText(val);
              return true;
            })()
          `).catch(() => false);
          if (deleted) return 'Pressed DELETE';
        }

        // ── iOS fallback: IDB ─────────────────────────────────────────────────
        if (!(await isIDBAvailable())) {
          return `Button ${button} requires IDB on iOS. ${IDB_INSTALL}`;
        }
        const idbMap: Record<string, string> = {
          HOME: 'HOME', VOLUME_UP: 'VOLUME_UP', VOLUME_DOWN: 'VOLUME_DOWN', POWER: 'LOCK', BACK: 'HOME',
        };
        await ctx.exec(`idb ui button ${idbMap[button] || button} --udid booted`);
        return `Pressed ${button}`;
      },
    });
  },
});
