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

interface CDPRemoteObject {
  type?: string;
  subtype?: string;
  className?: string;
  description?: string;
  objectId?: string;
  value?: unknown;
  preview?: CDPObjectPreview;
}

interface CDPObjectPreview {
  type?: string;
  subtype?: string;
  description?: string;
  overflow?: boolean;
  properties?: CDPPropertyPreview[];
}

interface CDPPropertyPreview {
  name: string;
  type: string;
  value?: string;
  valuePreview?: CDPObjectPreview;
}

function formatPreview(preview: CDPObjectPreview): string | null {
  if (!preview.properties) return null;

  const props = preview.properties.map((p) => {
    if (p.type === 'object' && p.valuePreview) {
      const nested = formatPreview(p.valuePreview);
      return `${p.name}: ${nested || p.value || '[object]'}`;
    }
    return `${p.name}: ${p.value}`;
  });

  const overflow = preview.overflow ? ', ...' : '';
  if (preview.subtype === 'array') return `[${props.join(', ')}${overflow}]`;
  return `{${props.join(', ')}${overflow}}`;
}

/**
 * Synchronously format a CDP RemoteObject using its value, preview, or description.
 * Used as the immediate fallback before async deep resolution completes.
 */
function formatRemoteObject(obj: CDPRemoteObject): string {
  if (obj.type === 'string') return obj.value as string;
  if (obj.type === 'number') return String(obj.value);
  if (obj.type === 'boolean') return String(obj.value);
  if (obj.type === 'undefined') return 'undefined';
  if (obj.subtype === 'null') return 'null';
  if (obj.preview) {
    const formatted = formatPreview(obj.preview);
    if (formatted) return formatted;
  }
  if (obj.description) return obj.description;
  if (obj.value !== undefined) return JSON.stringify(obj.value);
  return (obj.className as string) || (obj.type as string) || '[object]';
}

function formatCDPArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'object' && arg !== null) {
        return formatRemoteObject(arg as CDPRemoteObject);
      }
      return String(arg);
    })
    .join(' ');
}

async function resolveRemoteObject(
  cdpSend: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  objectId: string,
): Promise<string | null> {
  try {
    const result = (await cdpSend('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration:
        'function() { try { return JSON.stringify(this, null, 2); } catch(e) { return "[unserializable]"; } }',
      returnByValue: true,
    })) as Record<string, unknown>;
    const inner = result.result as Record<string, unknown> | undefined;
    return inner?.value ? (inner.value as string) : null;
  } catch {
    return null;
  }
}

async function formatCDPArgsDeep(
  cdpSend: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  args: unknown[],
): Promise<string> {
  const parts = await Promise.all(
    args.map(async (arg) => {
      if (typeof arg !== 'object' || arg === null) return String(arg);
      const remoteObj = arg as CDPRemoteObject;
      if (remoteObj.objectId && remoteObj.type === 'object') {
        const deep = await resolveRemoteObject(cdpSend, remoteObj.objectId);
        if (deep) return deep;
      }
      return formatRemoteObject(remoteObj);
    }),
  );
  return parts.join(' ');
}

export const consolePlugin = definePlugin({
  name: 'console',

  description: 'Console log collection and filtering',

  async setup(ctx) {
    const buffers = new DeviceBufferManager<LogEntry>(500);
    const cdpSend = ctx.cdp.send.bind(ctx.cdp);

    ctx.cdp.on('Runtime.consoleAPICalled', (params) => {
      const key = ctx.getActiveDeviceKey();
      if (!key) return;
      const args = (params.args as unknown[]) || [];

      const entry: LogEntry = {
        timestamp: Date.now(),
        level: params.type as string,
        message: formatCDPArgs(args),
        stackTrace: params.stackTrace
          ? JSON.stringify((params.stackTrace as Record<string, unknown>).callFrames)
          : undefined,
      };
      buffers.getOrCreate(key).push(entry);

      // ObjectIds are short-lived, so resolve promptly after the log event.
      const hasResolvable = args.some(
        (arg) => typeof arg === 'object' && arg !== null && (arg as CDPRemoteObject).objectId,
      );
      if (hasResolvable) {
        formatCDPArgsDeep(cdpSend, args)
          .then((deep) => {
            if (deep !== entry.message) entry.message = deep;
          })
          .catch(() => {});
      }
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
