import { z } from 'zod';
import { definePlugin } from '../plugin.js';

const KNOWN_GLOBALS = [
  { path: '__METRO_BRIDGE__', name: 'Metro Bridge Client SDK', description: 'Custom commands, Redux, navigation, performance tracking (metro-bridge/client)' },
  { path: '__METRO_MCP__', name: 'Metro MCP Client SDK (deprecated)', description: 'Legacy global — migrate to metro-bridge/client' },
  { path: '__REDUX_DEVTOOLS_EXTENSION__', name: 'Redux DevTools Extension', description: 'Redux DevTools browser extension hook' },
  { path: '__REACT_DEVTOOLS_GLOBAL_HOOK__', name: 'React DevTools Hook', description: 'React DevTools fiber inspection hook' },
  { path: '__EXPO_ROUTER_STATE__', name: 'Expo Router State', description: 'Expo Router navigation state' },
  { path: 'ErrorUtils', name: 'React Native ErrorUtils', description: 'Global error handler (setGlobalHandler)' },
];

export const debugGlobalsPlugin = definePlugin({
  name: 'debug-globals',

  description: 'Discover well-known global debugging objects in the app runtime',

  async setup(ctx) {
    ctx.registerTool('list_debug_globals', {
      description:
        'Auto-discover well-known global debugging objects (Redux stores, Apollo Client, Expo Router, React DevTools hook, etc.) available in the app runtime.',
      parameters: z.object({
        detailed: z.boolean().default(false).describe('Include top-level keys for each discovered global'),
      }),
      handler: async ({ detailed }) => {
        const expression = `(function() {
          var globals = ${JSON.stringify(KNOWN_GLOBALS)};
          var results = [];
          for (var i = 0; i < globals.length; i++) {
            var g = globals[i];
            var val = globalThis[g.path];
            var entry = { name: g.name, path: g.path, available: val != null, description: g.description };
            if (val != null) {
              entry.type = typeof val;
              ${detailed ? 'if (typeof val === "object" && val !== null) { try { entry.keys = Object.keys(val).slice(0, 20); } catch(e) {} }' : ''}
            }
            results.push(entry);
          }

          // Also look for common Redux store patterns
          var storeLocations = ['store', '__REDUX_STORE__', '__store__'];
          for (var j = 0; j < storeLocations.length; j++) {
            var loc = storeLocations[j];
            var s = globalThis[loc];
            if (s && typeof s === 'object' && typeof s.getState === 'function' && typeof s.dispatch === 'function') {
              results.push({ name: 'Redux Store', path: loc, available: true, type: 'object', description: 'Redux store with getState() and dispatch()' });
            }
          }

          // Apollo Client
          if (globalThis.__APOLLO_CLIENT__) {
            results.push({ name: 'Apollo Client', path: '__APOLLO_CLIENT__', available: true, type: typeof globalThis.__APOLLO_CLIENT__, description: 'Apollo GraphQL Client instance' });
          }

          return results;
        })()`;

        const result = await ctx.evalInApp(expression);
        return result;
      },
    });
  },
});
