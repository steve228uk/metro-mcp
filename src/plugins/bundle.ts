import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { CircularBuffer } from '../utils/buffer.js';
import { formatTimestamp } from '../utils/format.js';
import { checkMetroStatus } from '../metro/discovery.js';

interface BundleError {
  timestamp: number;
  type: string;
  message: string;
  file?: string;
  lineNumber?: number;
  column?: number;
  codeFrame?: string;
}

export const bundlePlugin = definePlugin({
  name: 'bundle',
  version: '0.1.0',
  description: 'Metro bundle diagnostics and error detection',

  async setup(ctx) {
    const errors = new CircularBuffer<BundleError>(100);

    // Listen for compilation errors via console
    ctx.cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        const args = (params.args as Array<Record<string, unknown>>) || [];
        const message = args.map((a) => a.value || a.description || '').join(' ');

        // Detect common bundle error patterns
        const patterns = [
          /Unable to resolve module/,
          /SyntaxError/,
          /TransformError/,
          /Error: Module not found/,
          /Unexpected token/,
        ];

        for (const pattern of patterns) {
          if (pattern.test(message)) {
            const fileMatch = message.match(/(?:in |from )([^\s:]+(?:\.tsx?|\.jsx?|\.json))/);
            const lineMatch = message.match(/(?:line |:)(\d+)/);
            const colMatch = message.match(/:(\d+):(\d+)/);

            errors.push({
              timestamp: Date.now(),
              type: pattern.source.replace(/[\\^$]/g, ''),
              message,
              file: fileMatch?.[1],
              lineNumber: lineMatch ? parseInt(lineMatch[1]) : undefined,
              column: colMatch ? parseInt(colMatch[2]) : undefined,
            });
            break;
          }
        }
      }
    });

    ctx.registerTool('get_bundle_status', {
      description: 'Check Metro bundler status and health.',
      parameters: z.object({}),
      handler: async () => {
        const status = await checkMetroStatus(ctx.metro.host, ctx.metro.port);
        return {
          status: status || 'unreachable',
          url: `http://${ctx.metro.host}:${ctx.metro.port}`,
          cdpConnected: ctx.cdp.isConnected(),
          recentErrors: errors.size,
        };
      },
    });

    ctx.registerTool('get_bundle_errors', {
      description: 'Get recent Metro compilation/transform errors.',
      parameters: z.object({
        limit: z.number().default(20).describe('Maximum errors to return'),
      }),
      handler: async ({ limit }) => {
        const errs = errors.getAll().slice(-limit);
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

    ctx.registerResource('metro://bundle/status', {
      name: 'Bundle Status',
      description: 'Metro bundler status and recent errors',
      handler: async () => {
        const status = await checkMetroStatus(ctx.metro.host, ctx.metro.port);
        return JSON.stringify(
          {
            status: status || 'unreachable',
            errorCount: errors.size,
          },
          null,
          2
        );
      },
    });
  },
});
