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
  buildFiberReadExpression,
} from '../utils/fiber.js';
import { adbPrefix, resolveDevice } from '../utils/device-discovery.js';
import { NativeInputController, type NativeDispatchResult, type NativeInputConfig } from '../utils/native-input.js';

// Connection setup failures happen before Runtime.evaluate is dispatched, so
// native input remains safe. Any other rejection may follow an app-side action
// and must stop to avoid duplicate input.
function isPreDispatchConnectionFailure(error: unknown): boolean {
  return error instanceof Error && (
    error.message === 'Not connected to CDP target' ||
    error.message ===
      'Not connected to Metro. Use list_devices to check connection status.'
  );
}

export const uiInteractPlugin = definePlugin({
  name: 'ui-interact',

  description: 'UI automation via React handlers, SimView, IDB, and adb',

  async setup(ctx) {
    const resolveTarget = (platform: 'ios' | 'android' | 'auto') =>
      resolveDevice(ctx, platform, ctx.cdp.getTarget());
    const nativeInput = new NativeInputController({
      projectRoot: typeof ctx.config.projectRoot === 'string' ? ctx.config.projectRoot : undefined,
      config: (ctx.config.input ?? {}) as NativeInputConfig,
      runner: { execFile: ctx.execFile, exec: ctx.exec },
      registerCleanup: ctx.registerCleanup,
      logger: ctx.logger,
    });
    const nativeResult = (action: string, dispatch: NativeDispatchResult): string => {
      const outcome = dispatch.status === 'handled' ? action : `${action} failed`;
      return `${outcome} [backend=${dispatch.backend}, dispatch=${dispatch.dispatch}, dispatched=${dispatch.dispatched}, status=${dispatch.status}]${dispatch.message ? `: ${dispatch.message}` : ''}`;
    };

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
        'Tap by label, testID, or logical device-point coordinates. Uses React handlers, then installed SimView or IDB on iOS and adb on Android. Coordinates use native input directly; native results identify the backend and dispatch state.',
      annotations: { destructiveHint: false },
      parameters: z.object({
        label: z.string().optional().describe('Accessibility label, aria-label, or testID to tap'),
        x: z.number().optional().describe('X coordinate'),
        y: z.number().optional().describe('Y coordinate'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ label, x, y, platform }) => {
        // ── Coordinate tap ──────────────────────────────────────────────────
        if (x !== undefined && y !== undefined) {
          const target = await resolveTarget(platform);
          if (!target) return 'No simulator/emulator detected.';
          const dispatch = await nativeInput.tap(target, x, y);
          return nativeResult(`Tapped at (${x}, ${y})`, dispatch);
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
        `).catch((error) => {
          if (!isPreDispatchConnectionFailure(error)) throw error;
          return false;
        });
        if (tapped) return `Tapped "${label}"`;

        const target = await resolveTarget(platform);
        if (!target) return 'No simulator/emulator detected.';

        // ── Android fallback: adb uiautomator ───────────────────────────────
        if (target.platform === 'android') {
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

        const dispatch = await nativeInput.tapLabel(target, label);
        return nativeResult(`Tapped "${label}"`, dispatch);
      },
    });

    ctx.registerTool('type_text', {
      description:
        'Type text into an input field. Targets a specific input by testID/label, or the first visible TextInput. Uses the React handler first, then SimView or IDB on iOS and the selected ADB serial on Android.',
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
        // ── CDP: find TextInput and call onChangeText ─────────────────────────
        const jsText = JSON.stringify(text);
        const jsTestID = testID ? JSON.stringify(testID) : 'null';
        const typed = await ctx.evalInApp(buildFiberReadExpression(`
          ${FIBER_ROOT_JS}
          var targetID = ${jsTestID};
          var target = null;
          metroWalkFibers(FIBER_OPTIONS, function(fiber) {
            if (target) return { prune: true };
            if (metroFiberName(fiber) !== 'TextInput') return;
            var props = fiber.memoizedProps || {};
            if (!targetID || props.testID === targetID || props.accessibilityLabel === targetID) target = fiber;
            return target ? { prune: true } : undefined;
          });
          if (!target) return false;
          var props = target.memoizedProps || {};
          if (props.onChangeText) { props.onChangeText(${jsText}); return true; }
          if (props.onChange) {
            props.onChange({ nativeEvent: { text: ${jsText}, target: 0, eventCount: 1 } });
            return true;
          }
          return false;
        `, { maxDepth: MAX_FIBER_DEPTH, maxNodes: MAX_FIBER_NODES })).catch((error) => {
          if (!isPreDispatchConnectionFailure(error)) throw error;
          return false;
        });
        if (typed) return `Typed "${text}"`;

        const target = await resolveTarget(platform);
        if (!target) return 'No simulator/emulator detected.';
        const dispatch = await nativeInput.typeText(target, text);
        return nativeResult(`Typed "${text}"`, dispatch);
      },
    });

    ctx.registerTool('long_press', {
      description:
        'Long press using a React handler by label/testID, or native input at logical device-point coordinates. Native results identify the backend and dispatch state.',
      annotations: { destructiveHint: false },
      parameters: z.object({
        label: z.string().optional().describe('Accessibility label or testID of the element to long press'),
        x: z.number().optional().describe('X coordinate'),
        y: z.number().optional().describe('Y coordinate'),
        duration: z.number().default(1000).describe('Duration in milliseconds'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ label, x, y, duration, platform }) => {
        // ── CDP: find element by label/testID and call onLongPress ────────────
        if (label && x === undefined && y === undefined) {
          const jsLabel = JSON.stringify(label);
          let evaluationError: unknown;
          const pressed = await ctx.evalInApp(`
            (function() {
              ${FIBER_ROOT_JS}
              ${FIND_AND_INVOKE_JS}
              return findAndInvoke(${jsLabel}, 'onLongPress');
            })()
          `).catch((error) => {
            if (!isPreDispatchConnectionFailure(error)) throw error;
            evaluationError = error;
            return false;
          });
          if (pressed) return `Long pressed "${label}"`;
          if (evaluationError) {
            return `Could not evaluate the connected app while long pressing "${label}".`;
          }
        }

        // ── Coordinate fallbacks ──────────────────────────────────────────────
        if (x !== undefined && y !== undefined) {
          const target = await resolveTarget(platform);
          if (!target) return 'No simulator/emulator detected.';
          const dispatch = await nativeInput.longPress(target, x, y, duration);
          return nativeResult(`Long pressed at (${x}, ${y}) for ${duration}ms`, dispatch);
        }

        return label
          ? `Element "${label}" not found or has no onLongPress handler. Provide x,y coordinates as fallback.`
          : 'Provide a label/testID or x,y coordinates.';
      },
    });

    ctx.registerTool('swipe', {
      description:
        'Scroll through React, then use installed SimView or IDB on iOS and the selected ADB serial on Android. Native results identify the backend and dispatch state.',
      annotations: { destructiveHint: false },
      parameters: z.object({
        direction: z.enum(['up', 'down', 'left', 'right']).describe('Swipe direction'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ direction, platform }) => {
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
            return false;
          })()
        `).catch((error) => {
          if (!isPreDispatchConnectionFailure(error)) throw error;
          return false;
        });
        if (scrolled) result = `Swiped ${direction}`;

        if (!result) {
          const target = await resolveTarget(platform);
          if (!target) return 'No simulator/emulator detected.';
          // ── Native fallback using current device geometry ───────────────────
          const dispatch = await nativeInput.swipeDirection(target, direction, 300);
          result = nativeResult(`Swiped ${direction}`, dispatch);
          if (dispatch.status !== 'handled') return result;
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
        // ── ENTER/DELETE: bounded CDP handler on every platform ───────────────
        if (button === 'ENTER' || button === 'DELETE') {
          const handler = button === 'ENTER' ? 'onSubmitEditing' : 'onChangeText';
          const handled = await ctx.evalInApp(buildFiberReadExpression(`
            var handled = false;
            metroWalkFibers(FIBER_OPTIONS, function(fiber) {
              if (handled || metroFiberName(fiber) !== 'TextInput') return;
              var props = fiber.memoizedProps || {};
              if (typeof props[${JSON.stringify(handler)}] !== 'function') return;
              if (${JSON.stringify(button)} === 'ENTER') {
                props.onSubmitEditing({ nativeEvent: { text: props.value || '' } });
              } else {
                props.onChangeText(String(props.value || '').slice(0, -1));
              }
              handled = true;
              return { prune: true };
            });
            return handled;
          `, { maxDepth: MAX_FIBER_DEPTH, maxNodes: MAX_FIBER_NODES })).catch((error) => {
            if (!isPreDispatchConnectionFailure(error)) throw error;
            return false;
          });
          if (handled) return `Pressed ${button}`;
        }

        const target = await resolveTarget(platform);
        if (!target) return 'No simulator/emulator detected.';

        const dispatch = await nativeInput.button(target, button);
        return nativeResult(`Pressed ${button}`, dispatch);
      },
    });
  },
});
