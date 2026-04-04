import { z } from 'zod';
import { definePlugin } from '../plugin.js';

export const reduxPlugin = definePlugin({
  name: 'redux',

  description: 'Redux state inspection via Runtime.evaluate',

  async setup(ctx) {
    ctx.registerTool('get_redux_state', {
      description:
        'Get the current Redux state tree or a specific slice. Works without client SDK if Redux DevTools extension is present or store is exposed globally.',
      parameters: z.object({
        path: z.string().optional().describe('Dot-separated path to a state slice (e.g., "user.profile")'),
        compact: z.boolean().default(false).describe('Return compact format'),
      }),
      handler: async ({ path, compact: isCompact }) => {
        // Try multiple ways to access Redux state
        const getStateExpr = `
          (function() {
            // Client SDK
            var _b = globalThis.__METRO_BRIDGE__ || globalThis.__METRO_MCP__;
            if (_b?.redux?.getState) {
              return _b.redux.getState();
            }
            // Redux DevTools
            if (globalThis.__REDUX_DEVTOOLS_EXTENSION__) {
              var stores = globalThis.__REDUX_DEVTOOLS_EXTENSION__.getStores?.();
              if (stores && stores.length > 0) return stores[0].getState();
            }
            // Common global patterns
            if (globalThis.__REDUX_STORE__) return globalThis.__REDUX_STORE__.getState();
            if (globalThis.store?.getState) return globalThis.store.getState();
            if (globalThis.__store__?.getState) return globalThis.__store__.getState();
            return '__REDUX_NOT_FOUND__';
          })()
        `;

        const state = await ctx.evalInApp(getStateExpr, { awaitPromise: true });
        if (state === '__REDUX_NOT_FOUND__') {
          return 'Redux store not found. Ensure Redux DevTools extension is enabled, or use the metro-mcp client SDK, or expose your store globally.';
        }

        let result = state;
        if (path && typeof state === 'object' && state !== null) {
          const parts = path.split('.');
          let current: unknown = state;
          for (const part of parts) {
            if (current && typeof current === 'object') {
              current = (current as Record<string, unknown>)[part];
            } else {
              return `Path "${path}" not found in state.`;
            }
          }
          result = current;
        }

        if (isCompact) return ctx.format.compact(result);
        return result;
      },
    });

    ctx.registerTool('dispatch_redux_action', {
      description: 'Dispatch a Redux action to the store.',
      parameters: z.object({
        type: z.string().describe('Action type'),
        payload: z.unknown().optional().describe('Action payload'),
      }),
      handler: async ({ type, payload }) => {
        const action = JSON.stringify({ type, payload });
        const expr = `
          (function() {
            var action = ${action};
            var _b = globalThis.__METRO_BRIDGE__ || globalThis.__METRO_MCP__;
            if (_b?.redux?.dispatch) return _b.redux.dispatch(action);
            if (globalThis.__REDUX_STORE__?.dispatch) return globalThis.__REDUX_STORE__.dispatch(action);
            if (globalThis.store?.dispatch) return globalThis.store.dispatch(action);
            return '__REDUX_NOT_FOUND__';
          })()
        `;
        const result = await ctx.evalInApp(expr, { awaitPromise: true });
        if (result === '__REDUX_NOT_FOUND__') return 'Redux store not found.';
        return `Dispatched: ${type}`;
      },
    });

    ctx.registerTool('get_redux_actions', {
      description: 'Get recent Redux actions (requires metro-mcp client SDK for real-time tracking).',
      parameters: z.object({
        limit: z.number().default(20).describe('Maximum actions to return'),
      }),
      handler: async ({ limit }) => {
        const expr = `
          (function() {
            var _b = globalThis.__METRO_BRIDGE__ || globalThis.__METRO_MCP__;
            if (_b?.redux?.actions) {
              var actions = _b.redux.actions;
              if (typeof actions.getAll === 'function') return actions.getAll();
              if (Array.isArray(actions)) return actions;
            }
            return '__NO_ACTIONS__';
          })()
        `;
        const result = await ctx.evalInApp(expr, { awaitPromise: true });
        if (result === '__NO_ACTIONS__') {
          return 'Action history not available. Install the metro-bridge client SDK to track Redux actions in real-time.';
        }
        if (Array.isArray(result)) return result.slice(-limit);
        return result;
      },
    });

    ctx.registerResource('metro://redux/state', {
      name: 'Redux State',
      description: 'Current Redux state snapshot',
      handler: async () => {
        try {
          const expr = `
            (function() {
              var _b = globalThis.__METRO_BRIDGE__ || globalThis.__METRO_MCP__;
              if (_b?.redux?.getState) return _b.redux.getState();
              if (globalThis.__REDUX_STORE__?.getState) return globalThis.__REDUX_STORE__.getState();
              if (globalThis.store?.getState) return globalThis.store.getState();
              return null;
            })()
          `;
          const state = await ctx.evalInApp(expr, { awaitPromise: true });
          return JSON.stringify(state, null, 2);
        } catch {
          return JSON.stringify({ error: 'Redux state not available' });
        }
      },
    });
  },
});
