import { readFile } from 'fs/promises';
import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import {
  DEFAULT_FIBER_MAX_DEPTH,
  DEFAULT_FIBER_MAX_NODES,
  FIBER_ROOT_JS,
  FIND_AND_INVOKE_JS,
  GET_ROUTE_FUNC_JS,
  MAX_FIBER_DEPTH,
  MAX_FIBER_NODES,
  SWIPE_COORDS,
  buildFiberReadExpression,
} from '../utils/fiber.js';
import { adbPrefix, resolveDevice } from '../utils/device-discovery.js';

// Module-level caches — persist across tool handler calls for the lifetime of the server.
let idbAvailableCache: boolean | null = null;

export const uiInteractPlugin = definePlugin({
  name: 'ui-interact',

  description: 'UI automation via fiber tree, simctl, adb, and IDB',

  async setup(ctx) {
    const resolveTarget = (platform: 'ios' | 'android' | 'auto') =>
      resolveDevice(ctx, platform, ctx.cdp.getTarget());

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
        'Get labelled or interactive elements from the focused React screen. Check traversal.complete before treating an empty elements array as definitive.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        interactiveOnly: z.boolean().default(false).describe('Return only elements with onPress handlers'),
        maxDepth: z
          .number()
          .int()
          .min(0)
          .max(MAX_FIBER_DEPTH)
          .default(DEFAULT_FIBER_MAX_DEPTH),
        maxNodes: z
          .number()
          .int()
          .min(1)
          .max(MAX_FIBER_NODES)
          .default(DEFAULT_FIBER_MAX_NODES),
      }),
      handler: async ({ interactiveOnly, maxDepth, maxNodes }) => {
        const expression = buildFiberReadExpression(
          `
            var elements = [];
            var INTERACTIVE = new Set([
              'TouchableOpacity','TouchableHighlight','TouchableWithoutFeedback',
              'TouchableNativeFeedback','Pressable','Button',
              'RectButton','BorderlessButton','BaseButton','TouchableRipple',
              'LongPressGestureHandler','TapGestureHandler',
              'Chip','FAB','IconButton','ListItem','MenuItem',
            ]);
            var traversal = metroWalkFibers(FIBER_OPTIONS, function(fiber, context) {
              var element = metroElementFromFiber(fiber);
              if (!element) return;
              element.interactive = element.interactive || INTERACTIVE.has(element.name);
              if (${interactiveOnly} && !element.interactive) return;
              if (!element.label && !element.testID && !element.interactive) return;
              element.depth = context.depth;
              elements.push(element);
            });
            return { elements: elements, traversal: traversal };
          `,
          { maxDepth, maxNodes },
        );
        return ctx.evalInApp(expression, { timeout: 10_000 });
      },
    });

    ctx.registerTool('tap_element', {
      description:
        'Tap an element by label, testID, or coordinates. Uses CDP fiber tree, then simctl/adb, then IDB.',
      annotations: { destructiveHint: false },
      parameters: z.object({
        label: z.string().optional().describe('Accessibility label, aria-label, or testID to tap'),
        x: z.number().optional().describe('X coordinate'),
        y: z.number().optional().describe('Y coordinate'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ label, x, y, platform }) => {
        const target = await resolveTarget(platform);
        if (!target) return 'No simulator/emulator detected.';
        const p = target.platform;

        // ── Coordinate tap ──────────────────────────────────────────────────
        if (x !== undefined && y !== undefined) {
          if (p === 'android') {
            await ctx.exec(`${adbPrefix(target.id)} shell input tap ${x} ${y}`);
            return `Tapped at (${x}, ${y})`;
          }
          // iOS: simctl first (Xcode 14+), then IDB
          try {
            await ctx.exec(`xcrun simctl io "${target.id}" tap ${x} ${y}`);
            return `Tapped at (${x}, ${y})`;
          } catch {}
          if (!(await isIDBAvailable())) {
            return `Coordinate tap failed. ${IDB_INSTALL}`;
          }
          await ctx.exec(`idb ui tap ${x} ${y} --udid "${target.id}"`);
          return `Tapped at (${x}, ${y})`;
        }

        if (!label) return 'Provide a label/testID or x,y coordinates.';

        // ── Label/testID tap: CDP fiber tree (works on both platforms) ───────
        const jsLabel = JSON.stringify(label);
        const tapped = await ctx.evalInApp(`
          (function() {
            ${FIBER_ROOT_JS}
            ${FIND_AND_INVOKE_JS}
            return findAndInvoke(${jsLabel}, 'onPress');
          })()
        `).catch(() => false);
        if (tapped) return `Tapped "${label}"`;

        // ── Android fallback: adb uiautomator ───────────────────────────────
        if (p === 'android') {
          const tmpFile = '/tmp/metro-mcp-uidump.xml';
          let content = '';
          try {
            await ctx.exec(
              `${adbPrefix(target.id)} shell uiautomator dump /sdcard/uidump.xml && ${adbPrefix(target.id)} pull /sdcard/uidump.xml ${tmpFile} 2>/dev/null`
            );
            content = await readFile(tmpFile, 'utf8');
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
              await ctx.exec(`${adbPrefix(target.id)} shell input tap ${cx} ${cy}`);
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
          await ctx.exec(`idb ui tap --by-label "${label}" --udid "${target.id}"`);
          return `Tapped "${label}"`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : '';
          if (msg.includes('117')) {
            return `IDB exit 117: companion not running. Try: idb_companion --udid ${target.id} &`;
          }
          return `Element "${label}" not found.`;
        }
      },
    });

    ctx.registerTool('type_text', {
      description:
        'Type text into an input field. Targets a specific input by testID/label, or the first visible TextInput. Uses CDP fiber tree, then adb/IDB.',
      annotations: { destructiveHint: false },
      parameters: z.object({
        text: z.string().describe('Text to type'),
        testID: z
          .string()
          .optional()
          .describe('testID or accessibilityLabel of the TextInput to target (defaults to first visible input)'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ text, testID, platform }) => {
        const target = await resolveTarget(platform);
        if (!target) return 'No simulator/emulator detected.';
        const p = target.platform;

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
          await ctx.exec(`${adbPrefix(target.id)} shell input text "${escaped}"`);
          return `Typed "${text}"`;
        }

        // ── iOS fallback: IDB ─────────────────────────────────────────────────
        if (!(await isIDBAvailable())) {
          return `Could not find a TextInput via fiber tree. ${IDB_INSTALL}`;
        }
        await ctx.exec(`idb ui text "${text}" --udid "${target.id}"`);
        return `Typed "${text}"`;
      },
    });

    ctx.registerTool('long_press', {
      description:
        'Long press an element by label/testID, or at coordinates. Uses CDP fiber tree, then adb/IDB.',
      annotations: { destructiveHint: false },
      parameters: z.object({
        label: z.string().optional().describe('Accessibility label or testID of the element to long press'),
        x: z.number().optional().describe('X coordinate'),
        y: z.number().optional().describe('Y coordinate'),
        duration: z.number().default(1000).describe('Duration in milliseconds'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ label, x, y, duration, platform }) => {
        const target = await resolveTarget(platform);
        if (!target) return 'No simulator/emulator detected.';
        const p = target.platform;

        // ── CDP: find element by label/testID and call onLongPress ────────────
        if (label) {
          const jsLabel = JSON.stringify(label);
          const pressed = await ctx.evalInApp(`
            (function() {
              ${FIBER_ROOT_JS}
              ${FIND_AND_INVOKE_JS}
              return findAndInvoke(${jsLabel}, 'onLongPress');
            })()
          `).catch(() => false);
          if (pressed) return `Long pressed "${label}"`;
        }

        // ── Coordinate fallbacks ──────────────────────────────────────────────
        if (x !== undefined && y !== undefined) {
          if (p === 'android') {
            await ctx.exec(`${adbPrefix(target.id)} shell input swipe ${x} ${y} ${x} ${y} ${duration}`);
            return `Long pressed at (${x}, ${y}) for ${duration}ms`;
          }
          if (!(await isIDBAvailable())) {
            return `Coordinate long press requires IDB on iOS. ${IDB_INSTALL}`;
          }
          await ctx.exec(`idb ui long-press ${x} ${y} --duration ${duration / 1000} --udid "${target.id}"`);
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
      annotations: { destructiveHint: false },
      parameters: z.object({
        direction: z.enum(['up', 'down', 'left', 'right']).describe('Swipe direction'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ direction, platform }) => {
        const target = await resolveTarget(platform);
        if (!target) return 'No simulator/emulator detected.';
        const p = target.platform;

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
            await ctx.exec(`${adbPrefix(target.id)} shell input swipe ${sx} ${sy} ${ex} ${ey} 300`);
            result = `Swiped ${direction}`;
          } else if (!(await isIDBAvailable())) {
            return `Swipe requires IDB on iOS. ${IDB_INSTALL}`;
          } else {
            await ctx.exec(`idb ui swipe ${sx} ${sy} ${ex} ${ey} --udid "${target.id}"`);
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
      annotations: { destructiveHint: false },
      parameters: z.object({
        button: z
          .enum(['HOME', 'BACK', 'VOLUME_UP', 'VOLUME_DOWN', 'POWER', 'ENTER', 'DELETE'])
          .describe('Button to press'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ button, platform }) => {
        const target = await resolveTarget(platform);
        if (!target) return 'No simulator/emulator detected.';
        const p = target.platform;

        // ── Android: adb keycodes ─────────────────────────────────────────────
        if (p === 'android') {
          const keycodes: Record<string, number> = {
            HOME: 3, BACK: 4, VOLUME_UP: 24, VOLUME_DOWN: 25,
            POWER: 26, ENTER: 66, DELETE: 67,
          };
          await ctx.exec(`${adbPrefix(target.id)} shell input keyevent ${keycodes[button]}`);
          return `Pressed ${button}`;
        }

        // ── iOS HOME: simctl (no IDB needed) ──────────────────────────────────
        if (button === 'HOME') {
          try {
            await ctx.exec(
              `xcrun simctl spawn "${target.id}" launchctl kickstart -k system/com.apple.SpringBoard 2>/dev/null`
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
        await ctx.exec(`idb ui button ${idbMap[button] || button} --udid "${target.id}"`);
        return `Pressed ${button}`;
      },
    });
  },
});
