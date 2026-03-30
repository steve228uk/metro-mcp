import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { CircularBuffer, DeviceBufferManager } from '../utils/buffer.js';
import { formatTimestamp } from '../utils/format.js';
import { extractCDPExceptionMessage } from '../utils/cdp.js';

interface ErrorEntry {
  timestamp: number;
  message: string;
  stack?: string;
  symbolicatedStack?: string;
}

interface BundleError {
  timestamp: number;
  type: string;
  message: string;
  file?: string;
  lineNumber?: number;
  column?: number;
}

const BUNDLE_ERROR_PATTERNS = [
  /Unable to resolve module/,
  /SyntaxError/,
  /TransformError/,
  /Error: Module not found/,
  /Unexpected token/,
];

function parseErrorLocation(message: string): { file?: string; lineNumber?: number; column?: number } {
  const fileMatch = message.match(/(?:in |from )([^\s:]+(?:\.tsx?|\.jsx?|\.json))/);
  const lineMatch = message.match(/(?:line |:)(\d+)/);
  const colMatch = message.match(/:(\d+):(\d+)/);
  return {
    file: fileMatch?.[1],
    lineNumber: lineMatch ? parseInt(lineMatch[1]) : undefined,
    column: colMatch ? parseInt(colMatch[2]) : undefined,
  };
}

export const errorsPlugin = definePlugin({
  name: 'errors',

  description: 'Exception collection with auto-symbolication',

  async setup(ctx) {
    const buffers = new DeviceBufferManager<ErrorEntry>(100);
    // Bundle errors are per-Metro-server, not per-device, so a single buffer is fine.
    const bundleErrors = new CircularBuffer<BundleError>(100);

    // CDP console errors are a fallback — the Metro /events path below
    // is more reliable but may not be connected yet during startup.
    ctx.cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        const args = (params.args as Array<Record<string, unknown>>) || [];
        const message = args.map((a) => a.value || a.description || '').join(' ');
        for (const pattern of BUNDLE_ERROR_PATTERNS) {
          if (pattern.test(message)) {
            bundleErrors.push({
              timestamp: Date.now(),
              type: pattern.source.replace(/[\\^$]/g, ''),
              message,
              ...parseErrorLocation(message),
            });
            break;
          }
        }
      }
    });

    ctx.events.on('bundling_error', (event) => {
      const message = (event.message as string) || 'Unknown bundling error';
      bundleErrors.push({
        timestamp: Date.now(),
        type: 'BundlingError',
        message,
        ...parseErrorLocation(message),
      });
    });

    ctx.cdp.on('Runtime.exceptionThrown', async (params) => {
      const message = extractCDPExceptionMessage(
        params.exceptionDetails as Record<string, unknown>,
        'Unknown error'
      );

      const exceptionDetails = params.exceptionDetails as Record<string, unknown>;
      const stackTrace = exceptionDetails?.stackTrace as Record<string, unknown>;
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

      const key = ctx.getActiveDeviceKey();
      if (key) buffers.getOrCreate(key).push(entry);
    });

    function getErrors(device?: string): ErrorEntry[] {
      return buffers.resolve(device, ctx.getActiveDeviceKey());
    }

    ctx.registerTool('get_errors', {
      description: 'Get recent uncaught exceptions and errors from the React Native app.',
      parameters: z.object({
        limit: z.number().default(20).describe('Maximum number of errors to return'),
        summary: z.boolean().default(false).describe('Return summary with counts'),
        device: z.string().optional().describe('Device key or "all" for aggregated errors. Defaults to current device.'),
      }),
      handler: async ({ limit, summary, device }) => {
        const errors = getErrors(device);
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
      parameters: z.object({
        device: z.string().optional().describe('Device key to clear, or omit for current device. Use "all" to clear all.'),
      }),
      handler: async ({ device }) => {
        if (device === 'all') {
          buffers.clear();
          return 'Error buffer cleared for all devices.';
        }
        buffers.clear(device || ctx.getActiveDeviceKey() || undefined);
        return 'Error buffer cleared.';
      },
    });

    ctx.registerTool('get_bundle_errors', {
      description: 'Get recent Metro compilation/transform errors.',
      parameters: z.object({
        limit: z.number().default(20).describe('Maximum errors to return'),
      }),
      handler: async ({ limit }) => {
        const errs = bundleErrors.getAll().slice(-limit);
        if (errs.length === 0) return 'No bundle errors detected.';
        return errs.map((e) => ({
          time: formatTimestamp(e.timestamp),
          type: e.type,
          message: ctx.format.truncate(e.message, 500),
          file: e.file,
          line: e.lineNumber,
          column: e.column,
        }));
      },
    });

    ctx.registerResource('metro://errors', {
      name: 'Errors',
      description: 'Recent uncaught exceptions from the React Native app',
      handler: async () => {
        const all = getErrors();
        const errors = all.slice(-10);
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
