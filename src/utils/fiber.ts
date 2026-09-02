/**
 * Shared fiber tree utilities used across plugins.
 *
 * JavaScript snippets in this file are embedded into evalInApp() calls. They
 * must remain self-contained JavaScript and cannot reference TypeScript imports.
 */

export const DEFAULT_FIBER_MAX_DEPTH = 200;
export const MAX_FIBER_DEPTH = 600;
export const DEFAULT_FIBER_MAX_NODES = 1200;
export const MAX_FIBER_NODES = 5000;

export interface FiberTraversalOptions {
  maxDepth?: number;
  maxNodes?: number;
}

export interface FiberTraversalMetadata {
  scope: 'focused-scene' | 'all-scenes';
  complete: boolean;
  depthReached: number;
  scannedNodes: number;
  truncationReason?:
    | 'max-depth'
    | 'max-nodes'
    | 'fiber-roots-unavailable'
    | 'cursor-expired';
}

export interface TestableElement {
  name: string;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  text?: string;
  interactive?: boolean;
}

export function normalizeFiberTraversalOptions(
  options: FiberTraversalOptions = {},
): Required<FiberTraversalOptions> {
  return {
    maxDepth: Math.min(
      MAX_FIBER_DEPTH,
      Math.max(0, Math.floor(options.maxDepth ?? DEFAULT_FIBER_MAX_DEPTH)),
    ),
    maxNodes: Math.min(
      MAX_FIBER_NODES,
      Math.max(1, Math.floor(options.maxNodes ?? DEFAULT_FIBER_MAX_NODES)),
    ),
  };
}

/**
 * Defines the shared iterative walker used by every read-only fiber tool.
 *
 * `metroWalkFibers(options, visitor)` invokes visitor in pre-order with
 * `(fiber, context)`. A visitor may return `{ childContext }` to pass a value
 * to descendants. Inactive SceneView children are pruned only when a focused
 * navigation route can be resolved, leaving sibling overlays visible.
 */
export const FIBER_WALKER_JS = `
  function metroFiberName(fiber) {
    if (!fiber || !fiber.type) return null;
    if (typeof fiber.type === 'string') return fiber.type;
    return fiber.type.displayName || fiber.type.name || null;
  }

  function metroFiberRoots() {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    var entries = [];
    var seen = new Set();
    if (!hook || !hook.getFiberRoots) return entries;
    for (var rendererId = 1; rendererId <= 20; rendererId++) {
      try {
        var roots = hook.getFiberRoots(rendererId);
        if (!roots || !roots.size) continue;
        var renderer = hook.renderers && hook.renderers.get
          ? hook.renderers.get(rendererId)
          : null;
        Array.from(roots).forEach(function(root) {
          var fiber = root && root.current;
          if (!fiber || seen.has(fiber)) return;
          seen.add(fiber);
          entries.push({ fiber: fiber, renderer: renderer, rendererId: rendererId });
        });
      } catch (_) {}
    }
    return entries;
  }

  function metroNavigationState(rootEntries) {
    try {
      var bridge = globalThis.__METRO_BRIDGE__ || globalThis.__METRO_MCP__;
      if (bridge && bridge.navigation && bridge.navigation.getState) {
        var bridgeState = bridge.navigation.getState();
        if (bridgeState && bridgeState.routes) return bridgeState;
      }
      var navRef = globalThis.__METRO_MCP_NAV_REF__;
      if (navRef && navRef.getRootState) {
        var refState = navRef.getRootState();
        if (refState && refState.routes) return refState;
      }
      var expoState = globalThis.__EXPO_ROUTER_STATE__;
      if (typeof expoState === 'function') expoState = expoState();
      if (expoState && expoState.routes) return expoState;
    } catch (_) {}

    var stack = [];
    for (var rootIndex = rootEntries.length - 1; rootIndex >= 0; rootIndex--) {
      stack.push({ fiber: rootEntries[rootIndex].fiber, depth: 0 });
    }
    var inspected = 0;
    while (stack.length && inspected < 5000) {
      var entry = stack.pop();
      var fiber = entry && entry.fiber;
      var depth = entry && entry.depth;
      if (!fiber || depth > 600) continue;
      inspected++;
      var name = metroFiberName(fiber);
      var found = null;
      if (
        name === 'NavigationContainer' ||
        name === 'NavigationContainerInner' ||
        name === 'BaseNavigationContainer'
      ) {
        var hookState = fiber.memoizedState;
        while (hookState && !found) {
          if (hookState.memoizedState && hookState.memoizedState.routes) {
            found = hookState.memoizedState;
          } else if (
            hookState.queue &&
            hookState.queue.lastRenderedState &&
            hookState.queue.lastRenderedState.routes
          ) {
            found = hookState.queue.lastRenderedState;
          }
          hookState = hookState.next;
        }
        if (!found && fiber.memoizedProps && fiber.memoizedProps.state && fiber.memoizedProps.state.routes) {
          found = fiber.memoizedProps.state;
        }
      }
      if (found) return found;
      var children = [];
      var child = fiber.child;
      while (child) { children.push(child); child = child.sibling; }
      for (var childIndex = children.length - 1; childIndex >= 0; childIndex--) {
        stack.push({ fiber: children[childIndex], depth: depth + 1 });
      }
    }
    return null;
  }

  function metroFocusedRoutes(state) {
    var names = [];
    var keys = [];
    var current = state;
    while (current && Array.isArray(current.routes) && current.routes.length) {
      var index = typeof current.index === 'number'
        ? current.index
        : current.routes.length - 1;
      var route = current.routes[index];
      if (!route) break;
      if (typeof route.name === 'string') names.push(route.name);
      if (typeof route.key === 'string') keys.push(route.key);
      current = route.state;
    }
    return { names: names, keys: keys };
  }

  function metroSafeProps(fiber, limit) {
    var source = fiber && fiber.memoizedProps;
    var result = {};
    if (!source || typeof source !== 'object') return result;
    var keys = Object.keys(source);
    for (var index = 0; index < Math.min(keys.length, limit || 20); index++) {
      var key = keys[index];
      if (key === 'children') continue;
      var value = source[key];
      if (typeof value === 'function') result[key] = '[function]';
      else if (value && typeof value === 'object') {
        try { result[key] = JSON.parse(JSON.stringify(value)); }
        catch (_) { result[key] = '[object]'; }
      } else result[key] = value;
    }
    return result;
  }

  function metroPrimitiveText(value) {
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value).slice(0, 300);
    }
    if (!Array.isArray(value)) return null;
    var text = value
      .filter(function(item) {
        return typeof item === 'string' || typeof item === 'number';
      })
      .join(' ');
    return text ? text.slice(0, 300) : null;
  }

  function metroElementFromFiber(fiber) {
    var props = fiber.memoizedProps || {};
    var name = metroFiberName(fiber);
    if (!name || name.indexOf('RCT') === 0) return null;
    var testID = typeof props.testID === 'string' ? props.testID : null;
    var label = typeof props.accessibilityLabel === 'string'
      ? props.accessibilityLabel
      : (typeof props['aria-label'] === 'string' ? props['aria-label'] : null);
    var role = typeof props.accessibilityRole === 'string'
      ? props.accessibilityRole
      : (typeof props.role === 'string' ? props.role : null);
    var interactive = !!(
      props.onPress || props.onPressIn || props.onLongPress || props.onTap ||
      props.onClick || props.accessible || props.hitSlop || ('disabled' in props)
    );
    return {
      name: name,
      type: name,
      testID: testID,
      accessibilityLabel: label,
      label: label,
      accessibilityRole: role,
      role: role,
      text: metroPrimitiveText(props.children),
      interactive: interactive,
      hint: typeof props.accessibilityHint === 'string' ? props.accessibilityHint : null
    };
  }

  function metroWalkFibers(options, visitor) {
    var roots = metroFiberRoots();
    var requestedDepth = Number(options.maxDepth);
    var requestedNodes = Number(options.maxNodes);
    var maxDepth = Math.min(600, Math.max(
      0,
      Number.isFinite(requestedDepth) ? requestedDepth : 200
    ));
    var maxNodes = Math.min(5000, Math.max(
      1,
      Number.isFinite(requestedNodes) ? requestedNodes : 1200
    ));
    var focus = metroFocusedRoutes(metroNavigationState(roots));
    var focused = focus.keys.length > 0 || focus.names.length > 0;
    var state = {
      scope: focused ? 'focused-scene' : 'all-scenes',
      complete: roots.length > 0,
      depthReached: 0,
      scannedNodes: 0
    };
    if (!roots.length) {
      state.complete = false;
      state.truncationReason = 'fiber-roots-unavailable';
      return state;
    }

    function inactiveScene(route) {
      if (!focused || !route) return false;
      if (typeof route.key === 'string') return focus.keys.indexOf(route.key) === -1;
      return typeof route.name === 'string' && focus.names.indexOf(route.name) === -1;
    }

    var stack = [];
    for (var rootIndex = roots.length - 1; rootIndex >= 0; rootIndex--) {
      stack.push({
        fiber: roots[rootIndex].fiber,
        renderer: roots[rootIndex].renderer,
        rendererId: roots[rootIndex].rendererId,
        rootIndex: rootIndex,
        depth: 0,
        parentContext: null
      });
    }

    while (stack.length) {
      if (state.scannedNodes >= maxNodes) {
        state.complete = false;
        state.truncationReason = 'max-nodes';
        break;
      }
      var entry = stack.pop();
      var fiber = entry && entry.fiber;
      if (!fiber) continue;
      if (entry.depth > maxDepth) {
        state.complete = false;
        if (!state.truncationReason) state.truncationReason = 'max-depth';
        continue;
      }

      state.scannedNodes++;
      state.depthReached = Math.max(state.depthReached, entry.depth);
      var name = metroFiberName(fiber);
      var props = fiber.memoizedProps || {};
      if (name === 'SceneView' && inactiveScene(props.route)) continue;

      var visitResult = visitor(fiber, {
        depth: entry.depth,
        parentContext: entry.parentContext,
        renderer: entry.renderer,
        rendererId: entry.rendererId,
        rootIndex: entry.rootIndex
      });
      var childContext = visitResult && Object.prototype.hasOwnProperty.call(visitResult, 'childContext')
        ? visitResult.childContext
        : entry.parentContext;
      if (visitResult && visitResult.prune) continue;

      var children = [];
      var child = fiber.child;
      while (child) { children.push(child); child = child.sibling; }
      for (var index = children.length - 1; index >= 0; index--) {
        stack.push({
          fiber: children[index],
          renderer: entry.renderer,
          rendererId: entry.rendererId,
          rootIndex: entry.rootIndex,
          depth: entry.depth + 1,
          parentContext: childContext
        });
      }
    }
    return state;
  }
`;

export function buildFiberReadExpression(
  body: string,
  options: FiberTraversalOptions = {},
  asynchronous = false,
): string {
  const normalized = normalizeFiberTraversalOptions(options);
  return `(${asynchronous ? 'async ' : ''}function() {
    ${FIBER_WALKER_JS}
    var FIBER_OPTIONS = ${JSON.stringify(normalized)};
    ${body}
  })()`;
}

/**
 * Legacy root snippet used by write/interaction tools. Read tools use the
 * shared walker above; interactions retain their existing behaviour.
 */
export const FIBER_ROOT_JS = `
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || !hook.getFiberRoots) return null;
  var fiberRoots;
  try {
    for (var i = 1; i <= 20; i++) {
      fiberRoots = hook.getFiberRoots(i);
      if (fiberRoots && fiberRoots.size > 0) break;
    }
  } catch(e) { return null; }
  if (!fiberRoots || fiberRoots.size === 0) return null;
  var rootFiber = Array.from(fiberRoots)[0].current;
`;

export const COLLECT_ELEMENTS_JS = buildFiberReadExpression(`
  var elements = [];
  var seen = new Set();
  var traversal = metroWalkFibers(FIBER_OPTIONS, function(fiber) {
    var element = metroElementFromFiber(fiber);
    if (!element) return;
    var key = element.testID || element.accessibilityLabel;
    if (!(element.testID || element.accessibilityLabel || element.text)) return;
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    elements.push(element);
  });
  return { elements: elements, traversal: traversal };
`);

/**
 * Swipe coordinates [startX, startY, endX, endY] — assumes ~1080×1920 viewport.
 * Shared by test-recorder (test generation) and ui-interact (native fallback swipes).
 */
export const SWIPE_COORDS: Record<string, [number, number, number, number]> = {
  up: [500, 1500, 500, 500],
  down: [500, 500, 500, 1500],
  left: [800, 1000, 200, 1000],
  right: [200, 1000, 800, 1000],
};

/**
 * JS snippet defining `findAndInvoke(needle, handlerName)`.
 * Requires `rootFiber` to be set (embed after FIBER_ROOT_JS).
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

/** Defines getRoute(), reading from the navigation ref set by the navigation plugin. */
export const GET_ROUTE_FUNC_JS = `function getRoute() {
  try {
    var n = globalThis.__METRO_MCP_NAV_REF__;
    if (n && n.getCurrentRoute) { var r = n.getCurrentRoute(); return r ? r.name : null; }
  } catch(e) {}
  return null;
}`;

type EvalFn = (
  expr: string,
  opts?: { timeout?: number; awaitPromise?: boolean },
) => Promise<unknown>;

export async function collectElements(evalInApp: EvalFn): Promise<TestableElement[]> {
  const result = (await evalInApp(COLLECT_ELEMENTS_JS, {
    timeout: 5000,
  })) as { elements?: TestableElement[] } | null;
  return result?.elements ?? [];
}
