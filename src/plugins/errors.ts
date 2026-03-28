import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { CircularBuffer } from '../utils/buffer.js';
import { formatTimestamp } from '../utils/format.js';

interface ErrorEntry {
  timestamp: number;
  message: string;
  stack?: string;
  symbolicatedStack?: string;
}

export const errorsPlugin = definePlugin({
  name: 'errors',
  version: '0.1.0',
  description: 'Exception collection with auto-symbolication',

  async setup(ctx) {
    const buffer = new CircularBuffer<ErrorEntry>(100);

    ctx.cdp.on('Runtime.exceptionThrown', async (params) => {
      const exception = params.exceptionDetails as Record<string, unknown>;
      const exObj = exception?.exception as Record<string, unknown>;
      const message =
        (exObj?.description as string) ||
        (exObj?.value as string) ||
        (exception?.text as string) ||
        'Unknown error';

      const stackTrace = exception?.stackTrace as Record<string, unknown>;
      const stack = stackTrace?.callFrames
        ? JSON.stringify(stackTrace.callFrames)
        : undefined;

      const entry: ErrorEntry = {
        timestamp: Date.now(),
        message,
        stack,
      };

      // Try to symbolicate
      if (stack) {
        try {
          const frames = JSON.parse(stack);
          const response = await ctx.metro.fetch('/symbolicate');
          if (response.ok) {
            const body = JSON.stringify({ stack: frames });
            const symResponse = await fetch(
              `http://${ctx.metro.host}:${ctx.metro.port}/symbolicate`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
              }
            );
            if (symResponse.ok) {
              const result = (await symResponse.json()) as Record<string, unknown>;
              entry.symbolicatedStack = JSON.stringify(result.stack);
            }
          }
        } catch {
          // Symbolication failed, keep raw stack
        }
      }

      buffer.push(entry);
    });

    ctx.cdp.on('reconnected', async () => {
      try { await ctx.cdp.send('Runtime.enable'); } catch {}
    });

    try { await ctx.cdp.send('Runtime.enable'); } catch {}

    ctx.registerTool('get_errors', {
      description: 'Get recent uncaught exceptions and errors from the React Native app.',
      parameters: z.object({
        limit: z.number().default(20).describe('Maximum number of errors to return'),
        summary: z.boolean().default(false).describe('Return summary with counts'),
      }),
      handler: async ({ limit, summary }) => {
        const errors = buffer.getAll();
        if (summary) {
          return ctx.format.summarize(
            errors.map((e) => e.message),
            5
          );
        }
        return errors.slice(-limit).map((e) => ({
          time: formatTimestamp(e.timestamp),
          message: e.message,
          stack: e.symbolicatedStack || e.stack,
        }));
      },
    });

    ctx.registerTool('clear_errors', {
      description: 'Clear the error buffer.',
      parameters: z.object({}),
      handler: async () => {
        buffer.clear();
        return 'Error buffer cleared.';
      },
    });

    ctx.registerResource('metro://errors', {
      name: 'Errors',
      description: 'Recent uncaught exceptions from the React Native app',
      handler: async () => {
        const errors = buffer.getLast(10);
        return JSON.stringify(
          errors.map((e) => ({
            time: formatTimestamp(e.timestamp),
            message: e.message,
          })),
          null,
          2
        );
      },
    });
  },
});
