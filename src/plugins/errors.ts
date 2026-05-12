import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { CircularBuffer, DeviceBufferManager } from '../utils/buffer.js';
import { formatTime } from '../utils/format.js';
import { extractCDPExceptionMessage } from '../utils/cdp.js';
import { buildErrorsHtml } from '../apps/errors.js';

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
      if (key) {
        buffers.getOrCreate(key).push(entry);
        ctx.notifyResourceUpdated('metro://errors');
      }
    });

    function getErrors(device?: string): ErrorEntry[] {
      return buffers.resolve(device, ctx.getActiveDeviceKey());
    }

    ctx.registerAppResource('ui://metro/errors', {
      name: 'Error Viewer',
      description: 'Interactive error viewer with stack traces and symbolication',
      handler: async () => buildErrorsHtml(),
    });

    ctx.registerTool('get_errors', {
      description: 'Get recent uncaught exceptions from the React Native app.',
      annotations: { readOnlyHint: true },
      appUri: 'ui://metro/errors',
      parameters: z.object({
        limit: z.number().default(20).describe('Maximum number of errors to return'),
        since: z.number().optional().describe('Only return entries after this Unix timestamp (ms). Pass the timestamp of the last seen entry to fetch only new ones.'),
        summary: z.boolean().default(false).describe('Return a one-line summary with counts'),
        device: z.string().optional().describe('Device key or "all" for aggregated errors. Defaults to current device.'),
        format: z.enum(['text', 'json']).default('text').describe("Return 'json' for a structured array of error entries"),
      }),
      handler: async ({ limit, since, summary, device, format }) => {
        let errors = getErrors(device);
        if (since !== undefined) errors = errors.filter((e) => e.timestamp > since);
        if (summary) {
          return ctx.format.summarize(
            errors.map((e) => e.message),
            5
          );
        }
        const result = errors.slice(-limit);
        if (format === 'json') return result;
        if (result.length === 0) return '(no errors)';
        return result.map((e) => {
          const stack = e.symbolicatedStack || e.stack;
          return stack
            ? `${formatTime(e.timestamp)} ${e.message}\n${stack}`
            : `${formatTime(e.timestamp)} ${e.message}`;
        }).join('\n\n');
      },
    });

    ctx.registerTool('clear_errors', {
      description: 'Clear the error buffer.',
      annotations: { destructiveHint: true, idempotentHint: true },
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
      annotations: { readOnlyHint: true },
      parameters: z.object({
        limit: z.number().default(20).describe('Maximum errors to return'),
      }),
      handler: async ({ limit }) => {
        const errs = bundleErrors.getAll().slice(-limit);
        if (errs.length === 0) return 'No bundle errors detected.';
        return errs.map((e) => {
          const location = e.file ? ` ${e.file}${e.lineNumber ? `:${e.lineNumber}` : ''}${e.column ? `:${e.column}` : ''}` : '';
          return `${formatTime(e.timestamp)} [${e.type}]${location} ${ctx.format.truncate(e.message, 500)}`;
        }).join('\n\n');
      },
    });

    ctx.registerResource('metro://errors', {
      name: 'Errors',
      description: 'Recent uncaught exceptions from the React Native app',
      mimeType: 'text/plain',
      handler: async () => {
        const errors = getErrors().slice(-10);
        if (errors.length === 0) return '(no errors)';
        return errors.map((e) => `${formatTime(e.timestamp)} ${e.message}`).join('\n');
      },
    });
  },
});
