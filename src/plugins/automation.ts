import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { collectElements } from '../utils/fiber.js';

const CURRENT_ROUTE_JS = `(function() {
  try {
    var n = globalThis.__METRO_MCP_NAV_REF__;
    if (n && n.getCurrentRoute) { var r = n.getCurrentRoute(); return r ? r.name : null; }
  } catch(e) {}
  return null;
})()`;

export const automationPlugin = definePlugin({
  name: 'automation',

  description: 'Wait and polling tools for reliable E2E automation with async state changes',

  async setup(ctx) {
    ctx.registerTool('wait_for_element', {
      description:
        'Poll the component tree until an element matching the given testID or accessibilityLabel appears. ' +
        'Returns element info on success. Use after tap_element, navigate(), or any action that triggers ' +
        'async screen transitions or data loading — instead of immediately calling the next tool.',
      parameters: z.object({
        selector: z.string().describe('testID or accessibilityLabel to wait for'),
        timeout: z.number().int().min(100).max(60000).default(10000)
          .describe('Maximum wait time in milliseconds (default 10000)'),
        pollInterval: z.number().int().min(100).max(5000).default(500)
          .describe('How often to check in milliseconds (default 500)'),
      }),
      handler: async ({ selector, timeout, pollInterval }) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          try {
            const elements = await collectElements(ctx.evalInApp);
            const match = elements.find(
              (el) => el.testID === selector || el.accessibilityLabel === selector,
            );
            if (match) {
              return { found: true, element: match, elapsedMs: Date.now() - start };
            }
          } catch {
            // CDP may not be ready yet — keep polling
          }
          await new Promise<void>((r) => setTimeout(r, pollInterval));
        }
        throw new Error(
          `Timed out after ${timeout}ms waiting for element "${selector}". ` +
          `Call get_testable_elements to inspect what is currently on screen.`,
        );
      },
    });

    ctx.registerTool('wait_for_condition', {
      description:
        'Poll a JavaScript expression in the app until it returns a truthy value, then return that value. ' +
        'Useful for waiting on state changes, loading flags, API responses, or any async condition. ' +
        'Example: wait for globalThis.myStore?.isLoaded === true.',
      parameters: z.object({
        expression: z.string()
          .describe('JS expression to evaluate; polling stops when it returns truthy'),
        timeout: z.number().int().min(100).max(60000).default(10000)
          .describe('Maximum wait time in milliseconds (default 10000)'),
        pollInterval: z.number().int().min(100).max(5000).default(500)
          .describe('How often to check in milliseconds (default 500)'),
      }),
      handler: async ({ expression, timeout, pollInterval }) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          try {
            const result = await ctx.evalInApp(expression);
            if (result) {
              return { result, elapsedMs: Date.now() - start };
            }
          } catch {
            // keep polling
          }
          await new Promise<void>((r) => setTimeout(r, pollInterval));
        }
        throw new Error(
          `Timed out after ${timeout}ms waiting for condition to become truthy: ${expression}`,
        );
      },
    });

    ctx.registerTool('wait_for_navigation', {
      description:
        'Poll the active navigation route until it matches the expected route name, then return. ' +
        'Requires the navigation plugin to be set up (get_current_route must work). ' +
        'Use after tap_element on a link or after dispatching a navigate() action.',
      parameters: z.object({
        routeName: z.string()
          .describe('Expected route name to wait for (e.g. "HomeScreen", "ProfileTab")'),
        timeout: z.number().int().min(100).max(60000).default(10000)
          .describe('Maximum wait time in milliseconds (default 10000)'),
      }),
      handler: async ({ routeName, timeout }) => {
        const start = Date.now();
        const pollInterval = 300;
        while (Date.now() - start < timeout) {
          try {
            const current = await ctx.evalInApp(CURRENT_ROUTE_JS);
            if (current === routeName) {
              return { route: routeName, elapsedMs: Date.now() - start };
            }
          } catch {
            // keep polling
          }
          await new Promise<void>((r) => setTimeout(r, pollInterval));
        }
        throw new Error(
          `Timed out after ${timeout}ms waiting for route "${routeName}". ` +
          `Call get_current_route to see the currently active route.`,
        );
      },
    });
  },
});
