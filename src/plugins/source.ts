import { z } from 'zod';
import { definePlugin } from '../plugin.js';

export const sourcePlugin = definePlugin({
  name: 'source',

  description: 'Stack trace symbolication via Metro',

  async setup(ctx) {
    ctx.registerTool('symbolicate', {
      description:
        'Symbolicate a stack trace using Metro bundler source maps. Converts minified/bundled locations back to original source files.',
      parameters: z.object({
        stack: z
          .array(
            z.object({
              lineNumber: z.number(),
              column: z.number(),
              file: z.string().optional(),
              methodName: z.string().optional(),
            })
          )
          .describe('Array of stack frames to symbolicate'),
      }),
      handler: async ({ stack }) => {
        try {
          const response = await fetch(
            `http://${ctx.metro.host}:${ctx.metro.port}/symbolicate`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ stack }),
            }
          );

          if (!response.ok) {
            return `Symbolication failed: ${response.status} ${response.statusText}`;
          }

          const result = (await response.json()) as Record<string, unknown>;
          return result.stack || result;
        } catch (err) {
          return `Symbolication error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
  },
});
