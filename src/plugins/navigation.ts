import { z } from 'zod';
import { definePlugin } from '../plugin.js';

export const navigationPlugin = definePlugin({
  name: 'navigation',

  description: 'React Navigation / Expo Router state inspection',

  async setup(ctx) {
    const GET_NAV_STATE_EXPR = `
      (function() {
        // Try client SDK first
        var _b = globalThis.__METRO_BRIDGE__ || globalThis.__METRO_MCP__;
        if (_b?.navigation?.getState) {
          return _b.navigation.getState();
        }

        // Walk fiber tree to find NavigationContainer
        var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (!hook || !hook.getFiberRoots) return null;

        var fiberRoots;
        for (var i = 1; i <= 5; i++) {
          fiberRoots = hook.getFiberRoots(i);
          if (fiberRoots && fiberRoots.size > 0) break;
        }
        if (!fiberRoots || fiberRoots.size === 0) return null;

        var rootFiber = Array.from(fiberRoots)[0].current;
        var navState = null;

        function findNavState(fiber) {
          if (!fiber || navState) return;
          var name = fiber.type?.displayName || fiber.type?.name || '';

          // Look for NavigationContainer or its internals
          if (name === 'NavigationContainer' || name === 'NavigationContainerInner' || name === 'BaseNavigationContainer') {
            // The navigation state is stored in memoizedState
            var state = fiber.memoizedState;
            while (state) {
              if (state.memoizedState && state.memoizedState.routes) {
                navState = state.memoizedState;
                return;
              }
              // Check queue for state updates
              if (state.queue?.lastRenderedState?.routes) {
                navState = state.queue.lastRenderedState;
                return;
              }
              state = state.next;
            }

            // Also check props for state
            if (fiber.memoizedProps?.state?.routes) {
              navState = fiber.memoizedProps.state;
              return;
            }
          }

          findNavState(fiber.child);
          if (!navState) findNavState(fiber.sibling);
        }

        findNavState(rootFiber);
        return navState;
      })()
    `;

    ctx.registerTool('get_navigation_state', {
      description:
        'Get the full React Navigation / Expo Router state tree including current route, params, and stack history.',
      parameters: z.object({
        compact: z.boolean().default(false).describe('Return compact format'),
      }),
      handler: async ({ compact: isCompact }) => {
        const state = await ctx.evalInApp(GET_NAV_STATE_EXPR, { awaitPromise: true });
        if (!state) {
          return 'Navigation state not found. Ensure your app uses React Navigation or Expo Router.';
        }
        if (isCompact) return ctx.format.compact(state);
        return state;
      },
    });

    function getFocusedRoute(s: Record<string, unknown>): Record<string, unknown> | null {
      const routes = s.routes as Array<Record<string, unknown>>;
      if (!routes) return null;
      const idx = s.index !== undefined ? (s.index as number) : routes.length - 1;
      const route = routes[idx];
      if (route.state && typeof route.state === 'object') {
        return getFocusedRoute(route.state as Record<string, unknown>);
      }
      return { name: route.name, params: route.params || {}, key: route.key };
    }

    ctx.registerTool('get_current_route', {
      description: 'Get the currently focused route name and params.',
      parameters: z.object({}),
      handler: async () => {
        const state = await ctx.evalInApp(GET_NAV_STATE_EXPR, { awaitPromise: true });
        if (!state || typeof state !== 'object') return 'No focused route found.';
        const result = getFocusedRoute(state as Record<string, unknown>);
        if (!result) return 'No focused route found.';
        return result;
      },
    });

    ctx.registerTool('get_route_history', {
      description: 'Get the navigation back stack / history.',
      parameters: z.object({}),
      handler: async () => {
        const state = await ctx.evalInApp(GET_NAV_STATE_EXPR, { awaitPromise: true });
        if (!state || typeof state !== 'object') return 'Navigation state not found.';

        const navState = state as Record<string, unknown>;
        const routes = navState.routes as Array<Record<string, unknown>>;
        if (!routes) return 'No routes found.';

        return routes.map((r, i) => ({
          index: i,
          name: r.name,
          params: r.params || {},
          focused: i === (navState.index as number ?? routes.length - 1),
        }));
      },
    });

    ctx.registerTool('list_routes', {
      description: 'List all registered route names in the app.',
      parameters: z.object({}),
      handler: async () => {
        const state = await ctx.evalInApp(GET_NAV_STATE_EXPR, { awaitPromise: true });
        if (!state || typeof state !== 'object') return 'Navigation state not found.';

        const routeNames = new Set<string>();
        function collectRoutes(s: Record<string, unknown>) {
          const routes = s.routes as Array<Record<string, unknown>>;
          if (!routes) return;
          for (const route of routes) {
            routeNames.add(route.name as string);
            if (route.state && typeof route.state === 'object') {
              collectRoutes(route.state as Record<string, unknown>);
            }
          }
        }
        collectRoutes(state as Record<string, unknown>);
        return Array.from(routeNames).sort();
      },
    });

    ctx.registerResource('metro://navigation', {
      name: 'Navigation State',
      description: 'Current React Navigation / Expo Router state',
      handler: async () => {
        try {
          const state = await ctx.evalInApp(GET_NAV_STATE_EXPR, { awaitPromise: true });
          return JSON.stringify(state, null, 2);
        } catch {
          return JSON.stringify({ error: 'Navigation state not available' });
        }
      },
    });
  },
});
