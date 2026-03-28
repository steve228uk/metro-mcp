import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { extractCDPExceptionMessage } from '../utils/cdp.js';

export const evaluatePlugin = definePlugin({
  name: 'evaluate',
  version: '0.1.0',
  description: 'JavaScript expression evaluation in the app runtime',

  async setup(ctx) {
    ctx.registerTool('evaluate_js', {
      description:
        'Execute a JavaScript expression in the running React Native app and return the result. Use this for inspecting variables, calling functions, or querying app state.',
      parameters: z.object({
        expression: z.string().describe('JavaScript expression to evaluate'),
        awaitPromise: z.boolean().default(true).describe('Wait for promise to resolve if expression returns a promise'),
        returnByValue: z.boolean().default(true).describe('Return the result by value (serialized)'),
      }),
      handler: async ({ expression, awaitPromise, returnByValue }) => {
        if (!ctx.cdp.isConnected()) {
          return 'Not connected to Metro. Use list_devices to check connection status.';
        }

        const result = (await ctx.cdp.send('Runtime.evaluate', {
          expression,
          awaitPromise,
          returnByValue,
          generatePreview: true,
          userGesture: true,
        })) as Record<string, unknown>;

        if (result.exceptionDetails) {
          return `Error: ${extractCDPExceptionMessage(result.exceptionDetails as Record<string, unknown>, 'Evaluation error')}`;
        }

        const value = result.result as Record<string, unknown>;
        if (value.type === 'undefined') return 'undefined';
        if (value.subtype === 'null') return 'null';
        if (value.value !== undefined) return value.value;
        if (value.description) return value.description;
        return value;
      },
    });
  },
});
