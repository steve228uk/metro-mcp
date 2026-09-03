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
export const MAX_FIBER_PROP_BYTES = 256 * 1024;

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
    | 'max-prop-bytes'
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
  var metroPropByteBudget = {
    remaining: ${MAX_FIBER_PROP_BYTES},
    traversal: null
  };

  function metroMarkPropsTruncated() {
    var traversal = metroPropByteBudget.traversal;
    if (!traversal) return;
    traversal.complete = false;
    if (!traversal.truncationReason) traversal.truncationReason = 'max-prop-bytes';
  }

  function metroFiberName(fiber) {
    if (!fiber || !fiber.type) return null;
    if (typeof fiber.type === 'string') return fiber.type;
    return fiber.type.displayName || fiber.type.name || null;
  }

  function metroFiberRoots(limit) {
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
        var iterator = roots.values();
        var nextRoot;
        while (!(nextRoot = iterator.next()).done) {
          var root = nextRoot.value;
          var fiber = root && root.current;
          if (!fiber || seen.has(fiber)) continue;
          seen.add(fiber);
          entries.push({ fiber: fiber, renderer: renderer, rendererId: rendererId });
          if (entries.length >= limit) return entries;
        }
      } catch (_) {}
    }
    return entries;
  }

  function metroNavigationState() {
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

    return null;
  }

  function metroNavigationStateFromFiber(fiber) {
    var name = metroFiberName(fiber);
    if (
      name !== 'NavigationContainer' &&
      name !== 'NavigationContainerInner' &&
      name !== 'BaseNavigationContainer'
    ) return null;

    var found = null;
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
    if (
      !found &&
      fiber.memoizedProps &&
      fiber.memoizedProps.state &&
      fiber.memoizedProps.state.routes
    ) {
      found = fiber.memoizedProps.state;
    }
    return found;
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
    if (metroPropByteBudget.remaining <= 0) {
      metroMarkPropsTruncated();
      return result;
    }
    var budget = { remaining: 100 };
    var seen = [];

    function safeValue(value, depth) {
      if (typeof value === 'function') return '[function]';
      if (typeof value === 'string') return value.slice(0, 1000);
      if (
        value === null ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) return value;
      if (typeof value !== 'object') return String(value).slice(0, 1000);
      if (depth >= 3) return Array.isArray(value) ? '[array]' : '[object]';
      if (seen.indexOf(value) !== -1) return '[circular]';
      if (budget.remaining <= 0) return '[truncated]';

      seen.push(value);
      var output;
      if (Array.isArray(value)) {
        output = [];
        var itemLimit = Math.min(value.length, 20);
        for (var itemIndex = 0; itemIndex < itemLimit; itemIndex++) {
          if (budget.remaining <= 0) break;
          budget.remaining--;
          output.push(safeValue(value[itemIndex], depth + 1));
        }
        if (value.length > output.length) output.push('[truncated]');
      } else {
        output = {};
        var nestedKeys;
        try { nestedKeys = Object.keys(value); }
        catch (_) {
          seen.pop();
          return '[object]';
        }
        var propertyLimit = Math.min(nestedKeys.length, 20);
        var copied = 0;
        for (var propertyIndex = 0; propertyIndex < propertyLimit; propertyIndex++) {
          if (budget.remaining <= 0) break;
          var nestedKey = nestedKeys[propertyIndex];
          var safeNestedKey = String(nestedKey).slice(0, 200);
          budget.remaining--;
          try { output[safeNestedKey] = safeValue(value[nestedKey], depth + 1); }
          catch (_) { output[safeNestedKey] = '[unavailable]'; }
          copied++;
        }
        if (nestedKeys.length > copied) output.__truncated__ = true;
      }
      seen.pop();
      return output;
    }

    var keys;
    try { keys = Object.keys(source); }
    catch (_) { return result; }
    for (var index = 0; index < Math.min(keys.length, limit || 20); index++) {
      var key = keys[index];
      if (key === 'children') continue;
      var safeKey = String(key).slice(0, 200);
      try { result[safeKey] = safeValue(source[key], 0); }
      catch (_) { result[safeKey] = '[unavailable]'; }
    }
    if (!Object.keys(result).length) return result;

    var json = JSON.stringify(result);
    var bytes = 0;
    for (var byteIndex = 0; byteIndex < json.length; byteIndex++) {
      var code = json.charCodeAt(byteIndex);
      if (code <= 0x7f) bytes++;
      else if (code <= 0x7ff) bytes += 2;
      else if (
        code >= 0xd800 && code <= 0xdbff &&
        byteIndex + 1 < json.length &&
        json.charCodeAt(byteIndex + 1) >= 0xdc00 &&
        json.charCodeAt(byteIndex + 1) <= 0xdfff
      ) {
        bytes += 4;
        byteIndex++;
      } else bytes += 3;
    }
    if (bytes > metroPropByteBudget.remaining) {
      metroPropByteBudget.remaining = 0;
      metroMarkPropsTruncated();
      return {};
    }
    metroPropByteBudget.remaining -= bytes;
    return result;
  }

  function metroPrimitiveText(value) {
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value).slice(0, 300);
    }
    if (!Array.isArray(value)) return null;
    var parts = [];
    var length = 0;
    for (var index = 0; index < value.length && index < 100 && length < 300; index++) {
      var item = value[index];
      if (typeof item !== 'string' && typeof item !== 'number') continue;
      var separatorLength = parts.length ? 1 : 0;
      var remaining = 300 - length - separatorLength;
      if (remaining <= 0) break;
      var part = String(item).slice(0, remaining);
      parts.push(part);
      length += separatorLength + part.length;
    }
    return parts.length ? parts.join(' ') : null;
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
    var roots = metroFiberRoots(maxNodes + 1);
    var state = {
      scope: 'all-scenes',
      complete: roots.length > 0,
      depthReached: 0,
      scannedNodes: 0
    };
    metroPropByteBudget.traversal = state;
    if (!roots.length) {
      state.complete = false;
      state.truncationReason = 'fiber-roots-unavailable';
      return state;
    }

    var stack = [];
    for (var rootIndex = roots.length - 1; rootIndex >= 0; rootIndex--) {
      stack.push({
        fiber: roots[rootIndex].fiber,
        renderer: roots[rootIndex].renderer,
        rendererId: roots[rootIndex].rendererId,
        rootIndex: rootIndex,
        depth: 0,
        parentIndex: null,
        includeSiblings: false
      });
    }

    var entries = [];
    var navigationState = metroNavigationState();
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
      var entryIndex = entries.length;
      entries.push(entry);
      var sibling = entry.includeSiblings ? fiber.sibling : null;
      if (sibling) {
        stack.push({
          fiber: sibling,
          renderer: entry.renderer,
          rendererId: entry.rendererId,
          rootIndex: entry.rootIndex,
          depth: entry.depth,
          parentIndex: entry.parentIndex,
          includeSiblings: true
        });
      }
      if (!navigationState) {
        navigationState = metroNavigationStateFromFiber(fiber);
      }

      var collectionFocus = metroFocusedRoutes(navigationState);
      var entryName = metroFiberName(fiber);
      var entryRoute = fiber.memoizedProps && fiber.memoizedProps.route;
      var pruneInactiveScene = entryName === 'SceneView' && entryRoute && (
        (typeof entryRoute.key === 'string' && collectionFocus.keys.length > 0 &&
          collectionFocus.keys.indexOf(entryRoute.key) === -1) ||
        (typeof entryRoute.key !== 'string' && typeof entryRoute.name === 'string' &&
          collectionFocus.names.length > 0 &&
          collectionFocus.names.indexOf(entryRoute.name) === -1)
      );
      if (!pruneInactiveScene) {
        var child = fiber.child;
        if (child) {
          stack.push({
            fiber: child,
            renderer: entry.renderer,
            rendererId: entry.rendererId,
            rootIndex: entry.rootIndex,
            depth: entry.depth + 1,
            parentIndex: entryIndex,
            includeSiblings: true
          });
        }
      }
    }

    var focus = metroFocusedRoutes(navigationState);
    var focused = focus.keys.length > 0 || focus.names.length > 0;
    state.scope = focused ? 'focused-scene' : 'all-scenes';

    function inactiveScene(route) {
      if (!focused || !route) return false;
      if (typeof route.key === 'string') return focus.keys.indexOf(route.key) === -1;
      return typeof route.name === 'string' && focus.names.indexOf(route.name) === -1;
    }

    var visitStates = [];
    for (var visitIndex = 0; visitIndex < entries.length; visitIndex++) {
      var visitEntry = entries[visitIndex];
      var parentState = visitEntry.parentIndex === null
        ? null
        : visitStates[visitEntry.parentIndex];
      if (parentState && parentState.pruned) {
        visitStates.push({ pruned: true, childContext: parentState.childContext });
        continue;
      }
      var visitFiber = visitEntry.fiber;
      var visitName = metroFiberName(visitFiber);
      var visitProps = visitFiber.memoizedProps || {};
      if (visitName === 'SceneView' && inactiveScene(visitProps.route)) {
        visitStates.push({ pruned: true, childContext: parentState && parentState.childContext });
        continue;
      }
      var parentContext = parentState ? parentState.childContext : null;
      var visitResult = visitor(visitFiber, {
        depth: visitEntry.depth,
        parentContext: parentContext,
        renderer: visitEntry.renderer,
        rendererId: visitEntry.rendererId,
        rootIndex: visitEntry.rootIndex
      });
      var childContext = visitResult && Object.prototype.hasOwnProperty.call(visitResult, 'childContext')
        ? visitResult.childContext
        : parentContext;
      visitStates.push({
        pruned: !!(visitResult && visitResult.prune),
        childContext: childContext
      });
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

const COLLECT_ELEMENTS_BODY = `
  var elements = [];
  var traversal = metroWalkFibers(FIBER_OPTIONS, function(fiber) {
    var element = metroElementFromFiber(fiber);
    if (!element) return;
    if (!(element.testID || element.accessibilityLabel || element.text)) return;
    elements.push(element);
  });
  return { elements: elements, traversal: traversal };
`;

export const COLLECT_ELEMENTS_JS = buildFiberReadExpression(
  COLLECT_ELEMENTS_BODY,
);

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

export interface CollectedElements {
  elements: TestableElement[];
  traversal: FiberTraversalMetadata;
}

export async function collectElements(
  evalInApp: EvalFn,
  options: FiberTraversalOptions = {},
): Promise<CollectedElements> {
  const expression = buildFiberReadExpression(COLLECT_ELEMENTS_BODY, options);
  const result = (await evalInApp(expression, {
    timeout: 5000,
  })) as CollectedElements | null;
  return result ?? {
    elements: [],
    traversal: {
      scope: 'all-scenes',
      complete: false,
      depthReached: 0,
      scannedNodes: 0,
      truncationReason: 'fiber-roots-unavailable',
    },
  };
}
