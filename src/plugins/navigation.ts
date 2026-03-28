import { z } from 'zod';
import { definePlugin } from '../plugin.js';

export const navigationPlugin = definePlugin({
  name: 'navigation',
  version: '0.1.0',
  description: 'React Navigation / Expo Router state inspection',

  async setup(ctx) {
    const GET_NAV_STATE_EXPR = `
      (function() {
        // Try client SDK first
        if (global.__METRO_MCP__?.navigation?.getState) {
          return global.__METRO_MCP__.navigation.getState();
        }

        // Walk fiber tree to find NavigationContainer
        var hook = global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
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

    ctx.registerTool('get_current_route', {
      description: 'Get the currently focused route name and params.',
      parameters: z.object({}),
      handler: async () => {
        const expr = `
          (function() {
            var state = ${GET_NAV_STATE_EXPR.replace('(function()', 'function getState()')
              .replace(/\n\s*\}\)\(\)/, '\n      }\n      return getState()')};

            if (!state) return null;

            // Walk to the deepest focused route
            function getFocusedRoute(s) {
              if (!s || !s.routes) return null;
              var idx = s.index !== undefined ? s.index : s.routes.length - 1;
              var route = s.routes[idx];
              if (route.state && route.state.routes) {
                return getFocusedRoute(route.state);
              }
              return { name: route.name, params: route.params || {}, key: route.key };
            }

            return getFocusedRoute(state);
          })()
        `;
        const result = await ctx.evalInApp(expr, { awaitPromise: true });
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
