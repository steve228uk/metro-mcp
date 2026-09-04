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
import {
  discoverAndroidDevices,
  discoverBootedSimulators,
  getConnectedDeviceTarget,
  resolveDevice,
  snapshotConnectedDeviceTarget,
  type ResolvedDevice,
} from '../utils/device-discovery.js';
import { NativeInputController, type NativeDispatchResult, type NativeInputConfig } from '../utils/native-input.js';
import { isAppEvaluationError } from '../utils/evaluate-app.js';

interface PreparedTarget {
  target: ResolvedDevice | null;
  canUseReact: boolean;
  isCurrent(): boolean;
  isTargetCurrent(): boolean;
}

// Connection setup failures happen before Runtime.evaluate is dispatched, so
// native input remains safe. Any other rejection may follow an app-side action
// and must stop to avoid duplicate input.
function isPreDispatchConnectionFailure(error: unknown): boolean {
  if (isAppEvaluationError(error)) return false;
  return error instanceof Error && (
    error.message === 'Not connected to CDP target' ||
    error.message ===
      'Not connected to Metro. Use list_devices to check connection status.' ||
    // ensureConnected raises this exact error before Runtime.evaluate is
    // submitted. Duration-bearing timeout errors may follow dispatch and
    // must not trigger a duplicate native action.
    error.message === 'App evaluation timed out'
  );
}

export const uiInteractPlugin = definePlugin({
  name: 'ui-interact',

  description: 'UI automation via React handlers, SimView, IDB, and adb',

  async setup(ctx) {
    const resolveTarget = (platform: 'ios' | 'android' | 'auto') =>
      resolveDevice(ctx, platform, getConnectedDeviceTarget(ctx));
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
    const prepareExplicitTarget = async (platform: 'ios' | 'android'): Promise<PreparedTarget> => {
      const connectedSnapshot = snapshotConnectedDeviceTarget(getConnectedDeviceTarget(ctx));
      const hasConnectedSnapshot = connectedSnapshot !== undefined;
      const targetId = connectedSnapshot?.id?.trim();
      const logicalId = connectedSnapshot?.reactNative?.logicalDeviceId?.trim();
      const generation = ctx.getRuntimeGeneration?.();
      const target = await resolveDevice(ctx, platform, connectedSnapshot);
      const sameId = (left: string, right: string, idPlatform: 'ios' | 'android') =>
        idPlatform === 'ios'
          ? left.toLowerCase() === right.toLowerCase()
          : left === right;
      const isTargetCurrent = () => {
        // An explicit platform request may legitimately have no CDP target
        // yet. In that case inventory resolution is the native target source;
        // there is no prior target to become stale.
        if (!hasConnectedSnapshot) return true;
        const current = getConnectedDeviceTarget(ctx);
        if (!current) return false;
        if (targetId && current.id?.trim() !== targetId) return false;
        const currentLogicalId = current.reactNative?.logicalDeviceId?.trim();
        if (logicalId && (!currentLogicalId || !sameId(currentLogicalId, logicalId, platform))) {
          return false;
        }
        return true;
      };
      const isCurrent = () => {
        if (!isTargetCurrent()) return false;
        const currentGeneration = ctx.getRuntimeGeneration?.();
        return generation === undefined || currentGeneration === undefined ||
          currentGeneration === generation;
      };
      if (!target || !logicalId || !sameId(target.id, logicalId, platform)) {
        return { target, canUseReact: false, isCurrent, isTargetCurrent };
      }
      const verifiedLogicalId = logicalId;

      // A requested-platform match alone cannot prove which runtime owns a
      // connected logical ID. The opposite inventory must also be available
      // and must not contain that ID before app-side dispatch is permitted.
      try {
        let oppositeHasId = false;
        if (platform === 'ios') {
          const opposite = await discoverAndroidDevices(ctx);
          oppositeHasId = opposite.some(
            (device) => sameId(device.id, verifiedLogicalId, 'android'),
          );
        } else {
          const opposite = await discoverBootedSimulators(ctx);
          oppositeHasId = opposite.some((device) => sameId(device.udid, verifiedLogicalId, 'ios'));
        }
        return { target, canUseReact: !oppositeHasId, isCurrent, isTargetCurrent };
      } catch {
        // Without a successful opposite inventory, the ID's platform is not
        // proven. Keep the requested target for native fallback.
        return { target, canUseReact: false, isCurrent, isTargetCurrent };
      }
    };

    const canUsePreparedReact = (prepared: PreparedTarget | undefined) =>
      !prepared || (prepared.canUseReact && prepared.isCurrent());

    const preparedNativeTarget = (
      prepared: PreparedTarget,
    ) => prepared.isTargetCurrent() ? prepared.target : null;

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
        const prepared = platform === 'auto' ? undefined : await prepareExplicitTarget(platform);
        const jsLabel = JSON.stringify(label);
        const tapped = canUsePreparedReact(prepared) && await ctx.evalInApp(`
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

        const target = prepared ? preparedNativeTarget(prepared) : await resolveTarget(platform);
        if (!target) return 'No simulator/emulator detected.';

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
        const prepared = platform === 'auto' ? undefined : await prepareExplicitTarget(platform);
        const jsText = JSON.stringify(text);
        const jsTestID = testID ? JSON.stringify(testID) : 'null';
        const typed = canUsePreparedReact(prepared) && await ctx.evalInApp(buildFiberReadExpression(`
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

        const target = prepared ? preparedNativeTarget(prepared) : await resolveTarget(platform);
        if (!target) return 'No simulator/emulator detected.';
        const dispatch = await nativeInput.typeText(target, text);
        return nativeResult(`Typed "${text}"`, dispatch);
      },
    });

    ctx.registerTool('long_press', {
      description:
        'Long press using a React handler by label/testID, then semantic native input through SimView or IDB when the handler is unavailable. Explicit coordinates use native input directly; native results identify the backend and dispatch state.',
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
        const hasCoordinates = x !== undefined && y !== undefined;
        const prepared = label && !hasCoordinates && platform !== 'auto'
          ? await prepareExplicitTarget(platform)
          : undefined;
        if (label && !hasCoordinates) {
          const jsLabel = JSON.stringify(label);
          const pressed = canUsePreparedReact(prepared) && await ctx.evalInApp(`
            (function() {
              ${FIBER_ROOT_JS}
              ${FIND_AND_INVOKE_JS}
              return findAndInvoke(${jsLabel}, 'onLongPress');
            })()
          `).catch((error) => {
            if (!isPreDispatchConnectionFailure(error)) throw error;
            return false;
          });
          if (pressed) return `Long pressed "${label}"`;
        }

        // ── Coordinate fallbacks ──────────────────────────────────────────────
        if (x !== undefined && y !== undefined) {
          const target = await resolveTarget(platform);
          if (!target) return 'No simulator/emulator detected.';
          const dispatch = await nativeInput.longPress(target, x, y, duration);
          return nativeResult(`Long pressed at (${x}, ${y}) for ${duration}ms`, dispatch);
        }

        if (label) {
          const target = prepared ? preparedNativeTarget(prepared) : await resolveTarget(platform);
          if (!target) return 'No simulator/emulator detected.';
          const dispatch = await nativeInput.longPressLabel(target, label, duration);
          return nativeResult(`Long pressed "${label}"`, dispatch);
        }

        return 'Provide a label/testID or x,y coordinates.';
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
        const prepared = platform === 'auto' ? undefined : await prepareExplicitTarget(platform);

        // ── CDP: find ScrollView and invoke scrollTo on its native node ────────
        const jsDir = JSON.stringify(direction);
        const scrolled = canUsePreparedReact(prepared) && await ctx.evalInApp(`
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
          const target = prepared ? preparedNativeTarget(prepared) : await resolveTarget(platform);
          if (!target) return 'No simulator/emulator detected.';
          // ── Native fallback using current device geometry ───────────────────
          const dispatch = await nativeInput.swipeDirection(target, direction, 300);
          result = nativeResult(`Swiped ${direction}`, dispatch);
          if (dispatch.status !== 'handled') return result;
        }

        // ── Log to test recorder if a recording is active ─────────────────────
        if (canUsePreparedReact(prepared)) await ctx.evalInApp(`
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
        const prepared = (button === 'ENTER' || button === 'DELETE') && platform !== 'auto'
          ? await prepareExplicitTarget(platform)
          : undefined;
        // ── ENTER/DELETE: bounded CDP handler on every platform ───────────────
        if (button === 'ENTER' || button === 'DELETE') {
          const handler = button === 'ENTER' ? 'onSubmitEditing' : 'onChangeText';
          const handled = canUsePreparedReact(prepared) && await ctx.evalInApp(buildFiberReadExpression(`
            var handled = false;
            var nativeRequired = false;
            metroWalkFibers(FIBER_OPTIONS, function(fiber) {
              if (handled || nativeRequired || metroFiberName(fiber) !== 'TextInput') return;
              var props = fiber.memoizedProps || {};
              if (typeof props[${JSON.stringify(handler)}] !== 'function') return;
              // Uncontrolled inputs keep their authoritative text natively;
              // their props.value may be absent or stale, so a synthetic
              // handler would submit or delete the wrong value.
              if (typeof props.value !== 'string') return;
              var current = fiber;
              var focused = false;
              var inspected = 0;
              while (current && inspected++ < 32) {
                var node = current.stateNode;
                var instance = node && node.canonical && node.canonical.publicInstance ||
                               node && node.publicInstance ||
                               node && node.__internalInstanceHandle &&
                                 node.__internalInstanceHandle.stateNode &&
                                 node.__internalInstanceHandle.stateNode.canonical &&
                                 node.__internalInstanceHandle.stateNode.canonical.publicInstance ||
                               node;
                try {
                  if (instance && typeof instance.isFocused === 'function' && instance.isFocused() === true) {
                    focused = true;
                    break;
                  }
                } catch (e) {}
                current = current.child;
              }
              if (!focused) return;
              if (${JSON.stringify(button)} === 'ENTER') {
                var submitBehavior = props.submitBehavior;
                if (typeof submitBehavior !== 'string') {
                  if (props.blurOnSubmit === true) submitBehavior = 'blurAndSubmit';
                  else if (props.blurOnSubmit === false) submitBehavior = 'newline';
                  else submitBehavior = props.multiline === true ? 'newline' : 'blurAndSubmit';
                }
                if (submitBehavior === 'newline') {
                  nativeRequired = true;
                  return { prune: true };
                }
                props.onSubmitEditing({ nativeEvent: { text: props.value } });
                if (submitBehavior === 'blurAndSubmit' && instance &&
                  typeof instance.blur === 'function') instance.blur();
              } else {
                var value = props.value;
                // A controlled value does not reveal the native caret. Only
                // synthesize DELETE when React exposes a valid UTF-16
                // selection; otherwise let the native provider preserve the
                // current selection and key-event behavior.
                var selection = props.selection;
                if (!selection || typeof selection !== 'object' ||
                  typeof selection.start !== 'number' || typeof selection.end !== 'number' ||
                  selection.start !== selection.start || selection.end !== selection.end ||
                  selection.start % 1 !== 0 || selection.end % 1 !== 0 ||
                  selection.start < 0 || selection.end < selection.start ||
                  selection.end > value.length) {
                  nativeRequired = true;
                  return { prune: true };
                }
                var start = selection.start;
                var end = selection.end;
                // A stale or malformed selection which splits a surrogate
                // pair must be resolved by the native input.
                if ((start > 0 && start < value.length &&
                    value.charCodeAt(start - 1) >= 0xd800 && value.charCodeAt(start - 1) <= 0xdbff &&
                    value.charCodeAt(start) >= 0xdc00 && value.charCodeAt(start) <= 0xdfff) ||
                  (end > 0 && end < value.length &&
                    value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff &&
                    value.charCodeAt(end) >= 0xdc00 && value.charCodeAt(end) <= 0xdfff)) {
                  nativeRequired = true;
                  return { prune: true };
                }
                if (start === end) {
                  if (start === 0) {
                    nativeRequired = true;
                    return { prune: true };
                  }
                  start -= 1;
                  // Remove one complete Unicode code point. Hermes supports
                  // these primitive operations on all supported RN versions.
                  if (start > 0 &&
                    value.charCodeAt(start) >= 0xdc00 && value.charCodeAt(start) <= 0xdfff &&
                    value.charCodeAt(start - 1) >= 0xd800 && value.charCodeAt(start - 1) <= 0xdbff) {
                    start -= 1;
                  }
                }
                props.onChangeText(value.slice(0, start) + value.slice(end));
              }
              handled = true;
              return { prune: true };
            });
            return handled && !nativeRequired;
          `, { maxDepth: MAX_FIBER_DEPTH, maxNodes: MAX_FIBER_NODES })).catch((error) => {
            if (!isPreDispatchConnectionFailure(error)) throw error;
            return false;
          });
          if (handled) return `Pressed ${button}`;
        }

        const target = prepared ? preparedNativeTarget(prepared) : await resolveTarget(platform);
        if (!target) return 'No simulator/emulator detected.';

        const dispatch = await nativeInput.button(target, button);
        return nativeResult(`Pressed ${button}`, dispatch);
      },
    });
  },
});
