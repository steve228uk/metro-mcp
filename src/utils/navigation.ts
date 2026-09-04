import type { PluginContext } from '../plugin.js';
import { buildFiberReadExpression, MAX_FIBER_DEPTH, MAX_FIBER_NODES } from './fiber.js';

/** Shared by navigation inspection and automation; SDK state may be asynchronous. */
export const NAVIGATION_STATE_EXPR = buildFiberReadExpression(`
  function fallbackState() {
    try {
      var ref = globalThis.__METRO_MCP_NAV_REF__;
      if (ref && ref.getRootState) {
        var refState = ref.getRootState();
        if (refState) return refState;
      }
      if (ref && ref.getCurrentRoute) {
        var route = ref.getCurrentRoute();
        if (route) return { index: 0, routes: [route] };
      }
    } catch (_) {}
    try {
      var expoState = globalThis.__EXPO_ROUTER_STATE__;
      if (typeof expoState === 'function') expoState = expoState();
      if (expoState) return expoState;
    } catch (_) {}

    var state = null;
    metroWalkFibers(FIBER_OPTIONS, function(fiber) {
      if (!state) state = metroNavigationStateFromFiber(fiber);
    }, null);
    return state;
  }

  try {
    var bridge = globalThis.__METRO_BRIDGE__ || globalThis.__METRO_MCP__;
    if (bridge && bridge.navigation && bridge.navigation.getState) {
      var state = bridge.navigation.getState();
      if (state && typeof state.then === 'function') {
        return state.then(function(value) { return value || fallbackState(); }, fallbackState);
      }
      if (state) return state;
    }
  } catch (_) {}
  return fallbackState();
`, { maxDepth: MAX_FIBER_DEPTH, maxNodes: MAX_FIBER_NODES });

export interface FocusedRoute {
  name: string;
  params: unknown;
  key: unknown;
}

export function getFocusedRoute(state: unknown): FocusedRoute | null {
  const seen = new Set<unknown>();
  let current = state;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const navigation = current as Record<string, unknown>;
    if (!Array.isArray(navigation.routes) || !navigation.routes.length) return null;
    const index = navigation.index ?? navigation.routes.length - 1;
    if (typeof index !== 'number' || !Number.isInteger(index)) return null;
    const route = navigation.routes[index] as Record<string, unknown> | undefined;
    if (!route || typeof route.name !== 'string') return null;
    if (route.state && typeof route.state === 'object') {
      current = route.state;
      continue;
    }
    return { name: route.name, params: route.params || {}, key: route.key };
  }
  return null;
}

export async function readFocusedRoute(
  evalInApp: PluginContext['evalInApp'],
  timeout?: number,
): Promise<FocusedRoute | null> {
  return getFocusedRoute(await readNavigationState(evalInApp, timeout));
}

export function readNavigationState(
  evalInApp: PluginContext['evalInApp'],
  timeout?: number,
): Promise<unknown> {
  return evalInApp(NAVIGATION_STATE_EXPR, { awaitPromise: true, timeout });
}
