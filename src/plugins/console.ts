import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { DeviceBufferManager } from '../utils/buffer.js';
import { formatTimestamp } from '../utils/format.js';

interface LogEntry {
  timestamp: number;
  level: string;
  message: string;
  stackTrace?: string;
}

function formatCDPArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'object' && arg !== null) {
        const remoteObj = arg as Record<string, unknown>;
        if (remoteObj.type === 'string') return remoteObj.value as string;
        if (remoteObj.type === 'number') return String(remoteObj.value);
        if (remoteObj.type === 'boolean') return String(remoteObj.value);
        if (remoteObj.type === 'undefined') return 'undefined';
        if (remoteObj.subtype === 'null') return 'null';
        if (remoteObj.description) return remoteObj.description as string;
        if (remoteObj.value !== undefined) return JSON.stringify(remoteObj.value);
        return remoteObj.className || remoteObj.type || '[object]';
      }
      return String(arg);
    })
    .join(' ');
}

export const consolePlugin = definePlugin({
  name: 'console',

  description: 'Console log collection and filtering',

  async setup(ctx) {
    const buffers = new DeviceBufferManager<LogEntry>(500);

    ctx.cdp.on('Runtime.consoleAPICalled', (params) => {
      const key = ctx.getActiveDeviceKey();
      if (!key) return;
      const args = (params.args as unknown[]) || [];
      buffers.getOrCreate(key).push({
        timestamp: Date.now(),
        level: params.type as string,
        message: formatCDPArgs(args),
        stackTrace: params.stackTrace
          ? JSON.stringify((params.stackTrace as Record<string, unknown>).callFrames)
          : undefined,
      });
    });

    // Mark when Metro starts rebuilding — a reload is imminent.
    ctx.events.on('bundle_transform_progressed', (event) => {
      if (event.transformedFileCount === 1) {
        const key = ctx.getActiveDeviceKey();
        if (!key) return;
        buffers.getOrCreate(key).push({
          timestamp: Date.now(),
          level: 'info',
          message: '── Metro rebuilding ── (file change detected)',
        });
      }
    });

    // Insert a visible boundary marker when the CDP connection is re-established,
    // so it's clear where a gap in logs may have occurred.
    ctx.cdp.on('reconnected', () => {
      const key = ctx.getActiveDeviceKey();
      if (!key) return;
      buffers.getOrCreate(key).push({
        timestamp: Date.now(),
        level: 'info',
        message: '── CDP reconnected ── (logs during the disconnection gap may be missing)',
      });
    });

    ctx.registerTool('get_console_logs', {
      description: 'Get recent console output from the React Native app. Filter by log level and search text.',
      parameters: z.object({
        level: z.enum(['log', 'warn', 'error', 'info', 'debug']).optional().describe('Filter by log level'),
        search: z.string().optional().describe('Search text to filter logs'),
        limit: z.number().default(50).describe('Maximum number of logs to return'),
        summary: z.boolean().default(false).describe('Return summary with counts + last few entries'),
        compact: z.boolean().default(false).describe('Return compact single-line format'),
        device: z.string().optional().describe('Device key or "all" for aggregated logs. Defaults to current device.'),
      }),
      handler: async ({ level, search, limit, summary, compact: isCompact, device }) => {
        let logs = buffers.resolve(device, ctx.getActiveDeviceKey());
        if (level) logs = logs.filter((l) => l.level === level);
        if (search) logs = logs.filter((l) => l.message.toLowerCase().includes(search.toLowerCase()));

        if (summary) {
          return ctx.format.summarize(
            logs.map((l) => `[${l.level.toUpperCase()}] ${l.message}`),
            5
          );
        }

        const result = logs.slice(-limit);
        if (isCompact) {
          return result.map((l) => `${formatTimestamp(l.timestamp)} [${l.level}] ${l.message}`).join('\n');
        }

        return result.map((l) => ({
          time: formatTimestamp(l.timestamp),
          level: l.level,
          message: l.message,
        }));
      },
    });

    ctx.registerTool('clear_console_logs', {
      description: 'Clear the console log buffer.',
      parameters: z.object({
        device: z.string().optional().describe('Device key to clear, or omit for current device. Use "all" to clear all.'),
      }),
      handler: async ({ device }) => {
        if (device === 'all') {
          buffers.clear();
          return 'Console logs cleared for all devices.';
        }
        buffers.clear(device || ctx.getActiveDeviceKey() || undefined);
        return 'Console logs cleared.';
      },
    });

    ctx.registerResource('metro://logs', {
      name: 'Console Logs',
      description: 'Recent console output from the React Native app',
      handler: async () => {
        const logs = buffers.resolve(undefined, ctx.getActiveDeviceKey()).slice(-20);
        return JSON.stringify(
          logs.map((l) => ({
            time: formatTimestamp(l.timestamp),
            level: l.level,
            message: l.message,
          })),
          null,
          2
        );
      },
    });
  },
});
