/**
 * Shared fiber tree utilities used across plugins.
 *
 * JS string constants are embedded into evalInApp() calls, so they must be
 * valid JavaScript and cannot reference TypeScript imports.
 */

/**
 * Inline JS snippet that resolves `rootFiber` from the React DevTools hook.
 * Embed at the top of an IIFE; uses `return` to exit early on failure.
 * The early-return value should match the IIFE's failure sentinel (null or []).
 */
export const FIBER_ROOT_JS = `
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || !hook.getFiberRoots) return null;
  var fiberRoots;
  try {
    for (var i = 1; i <= 5; i++) {
      fiberRoots = hook.getFiberRoots(i);
      if (fiberRoots && fiberRoots.size > 0) break;
    }
  } catch(e) { return null; }
  if (!fiberRoots || fiberRoots.size === 0) return null;
  var rootFiber = Array.from(fiberRoots)[0].current;
`;

/**
 * Complete standalone IIFE that collects testable elements from the fiber tree.
 * Returns an array of { name, testID, accessibilityLabel, accessibilityRole, text, interactive }.
 * Uses an iterative stack to safely handle deep navigation trees (depth 200+).
 */
export const COLLECT_ELEMENTS_JS = `
  (function() {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || !hook.getFiberRoots) return [];
    var fiberRoots;
    try {
      for (var i = 1; i <= 5; i++) {
        fiberRoots = hook.getFiberRoots(i);
        if (fiberRoots && fiberRoots.size > 0) break;
      }
    } catch(e) { return []; }
    if (!fiberRoots || fiberRoots.size === 0) return [];
    var rootFiber = Array.from(fiberRoots)[0].current;
    var elements = [];
    var seen = {};
    var stack = [{ f: rootFiber, d: 0 }];
    while (stack.length) {
      var item = stack.pop();
      var fiber = item.f; var depth = item.d;
      if (!fiber || depth > 200) continue;
      var type = fiber.type;
      var name = typeof type === 'string' ? type : (type && (type.displayName || type.name));
      if (name && name.indexOf('RCT') !== 0) {
        var props = fiber.memoizedProps || {};
        var testID = props.testID || null;
        var label = props.accessibilityLabel || props['aria-label'] || null;
        var key = testID || label;
        if ((testID || label || typeof props.children === 'string') && (!key || !seen[key])) {
          if (key) seen[key] = true;
          elements.push({
            name: name,
            testID: testID,
            accessibilityLabel: label,
            accessibilityRole: props.accessibilityRole || props['role'] || null,
            text: typeof props.children === 'string' ? props.children : null,
            interactive: !!(props.onPress || props.onPressIn || props.onClick),
          });
        }
      }
      if (fiber.sibling) stack.push({ f: fiber.sibling, d: depth });
      if (fiber.child) stack.push({ f: fiber.child, d: depth + 1 });
    }
    return elements;
  })()
`;

/**
 * Swipe coordinates [startX, startY, endX, endY] — assumes ~1080×1920 viewport.
 * Shared by test-recorder (test generation) and ui-interact (native fallback swipes).
 */
export const SWIPE_COORDS: Record<string, [number, number, number, number]> = {
  up:    [500, 1500, 500,  500],
  down:  [500,  500, 500, 1500],
  left:  [800, 1000, 200, 1000],
  right: [200, 1000, 800, 1000],
};

/**
 * JS snippet defining `findAndInvoke(needle, handlerName)`.
 * Requires `rootFiber` to be set (embed after FIBER_ROOT_JS).
 * Finds the fiber matching needle by accessibilityLabel, aria-label, or testID,
 * then walks up to the nearest ancestor that has `handlerName` and calls it.
 */
export const FIND_AND_INVOKE_JS = `
  function findAndInvoke(needle, handlerName) {
    var target = null;
    var stack = [rootFiber];
    while (stack.length && !target) {
      var fiber = stack.pop();
      if (!fiber) continue;
      var props = fiber.memoizedProps || {};
      if (props.accessibilityLabel === needle ||
          props['aria-label'] === needle ||
          props.testID === needle) {
        target = fiber;
      } else {
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
    }
    if (!target) return false;
    var f = target;
    var depth = 0;
    while (f && depth < 50) {
      if (f.memoizedProps && f.memoizedProps[handlerName]) {
        f.memoizedProps[handlerName]({ nativeEvent: {} });
        return true;
      }
      f = f.return;
      depth++;
    }
    return false;
  }
`;

/**
 * JS snippet that defines a `getRoute()` function reading from the nav ref set by the
 * navigation plugin. Embed inside an IIFE that also calls `getRoute()`.
 */
export const GET_ROUTE_FUNC_JS = `function getRoute() {
  try {
    var n = globalThis.__METRO_MCP_NAV_REF__;
    if (n && n.getCurrentRoute) { var r = n.getCurrentRoute(); return r ? r.name : null; }
  } catch(e) {}
  return null;
}`;

export interface TestableElement {
  name: string;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  text?: string;
  interactive?: boolean;
}

type EvalFn = (expr: string, opts?: { timeout?: number; awaitPromise?: boolean }) => Promise<unknown>;

export async function collectElements(evalInApp: EvalFn): Promise<TestableElement[]> {
  return ((await evalInApp(COLLECT_ELEMENTS_JS, { timeout: 5000 })) as TestableElement[]) ?? [];
}
