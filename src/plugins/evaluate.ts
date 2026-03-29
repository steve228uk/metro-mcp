import { z } from 'zod';
import { definePlugin } from '../plugin.js';

export const evaluatePlugin = definePlugin({
  name: 'evaluate',

  description: 'JavaScript expression evaluation in the app runtime',

  async setup(ctx) {
    ctx.registerTool('evaluate_js', {
      description:
        'Execute a JavaScript expression in the running React Native app and return the result. Use this for inspecting variables, calling functions, or querying app state.',
      parameters: z.object({
        expression: z.string().describe('JavaScript expression to evaluate'),
        awaitPromise: z.boolean().default(true).describe('Wait for promise to resolve if expression returns a promise'),
      }),
      handler: async ({ expression, awaitPromise }) => {
        try {
          const value = await ctx.evalInApp(expression, { awaitPromise });
          return value === undefined ? 'undefined' : value;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
  },
});
