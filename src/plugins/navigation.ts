import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { buildNavigationHtml } from '../apps/navigation.js';
import { readNavigationState, readFocusedRoute } from '../utils/navigation.js';

export const navigationPlugin = definePlugin({
  name: 'navigation',

  description: 'React Navigation / Expo Router state inspection',

  async setup(ctx) {
    ctx.registerAppResource('ui://metro/navigation', {
      name: 'Navigation Tree',
      description: 'Visual React Navigation / Expo Router route tree with active screen highlighted',
      handler: async () => buildNavigationHtml(),
    });

    ctx.registerTool('get_navigation_state', {
      description:
        'Get the full React Navigation / Expo Router state tree including current route, params, and stack history.',
      annotations: { readOnlyHint: true },
      appUri: 'ui://metro/navigation',
      parameters: z.object({
        compact: z.boolean().default(false).describe('Return compact format'),
      }),
      handler: async ({ compact: isCompact }) => {
        const state = await readNavigationState(ctx.evalInApp);
        if (!state) {
          return 'Navigation state not found. Ensure your app uses React Navigation or Expo Router.';
        }
        if (isCompact) return ctx.format.compact(state);
        return state;
      },
    });

    ctx.registerTool('get_current_route', {
      description: 'Get the currently focused route name and params.',
      annotations: { readOnlyHint: true },
      parameters: z.object({}),
      handler: async () => {
        const result = await readFocusedRoute(ctx.evalInApp);
        if (!result) return 'No focused route found.';
        return result;
      },
    });

    ctx.registerTool('get_route_history', {
      description: 'Get the navigation back stack / history.',
      annotations: { readOnlyHint: true },
      parameters: z.object({}),
      handler: async () => {
        const state = await readNavigationState(ctx.evalInApp);
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
      description: 'List registered route names from available navigation state. Uninitialized nested navigators are not discoverable.',
      annotations: { readOnlyHint: true },
      parameters: z.object({}),
      handler: async () => {
        const state = await readNavigationState(ctx.evalInApp);
        if (!state || typeof state !== 'object') return 'Navigation state not found.';

        const routeNames = new Set<string>();
        const pending: unknown[] = [state];
        const seen = new Set<object>();
        while (pending.length) {
          const next = pending.pop();
          if (!next || typeof next !== 'object' || seen.has(next)) continue;
          seen.add(next);
          const navigation = next as Record<string, unknown>;
          if (Array.isArray(navigation.routeNames)) {
            for (const name of navigation.routeNames) {
              if (typeof name === 'string') routeNames.add(name);
            }
          }
          if (!Array.isArray(navigation.routes)) continue;
          for (const route of navigation.routes) {
            if (!route || typeof route !== 'object') continue;
            if (typeof route.name === 'string') routeNames.add(route.name);
            if (route.state) {
              pending.push(route.state);
            }
          }
        }
        return Array.from(routeNames).sort();
      },
    });

    ctx.registerResource('metro://navigation', {
      name: 'Navigation State',
      description: 'Current React Navigation / Expo Router state',
      handler: async () => {
        try {
          const state = await readNavigationState(ctx.evalInApp);
          return JSON.stringify(state, null, 2);
        } catch {
          return JSON.stringify({ error: 'Navigation state not available' });
        }
      },
    });
  },
});
