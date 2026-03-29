import { writeFileSync } from 'node:fs';
import { definePlugin } from '../plugin.js';

export const STATUS_FILE = '/tmp/metro-mcp-status.json';

interface StatusData {
  connected: boolean;
  host: string;
  port: number;
  target: string | null;
  updatedAt: number;
}

function writeStatus(data: StatusData): void {
  try {
    writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2));
  } catch {
    // ignore write errors — status bar is best-effort
  }
}

export const statuslinePlugin = definePlugin({
  name: 'statusline',
  description: 'Writes CDP connection state to a file for Claude Code status bar integration',

  async setup(ctx) {
    function write(connected: boolean): void {
      const target = ctx.cdp.getTarget();
      writeStatus({
        connected,
        host: ctx.metro.host,
        port: ctx.metro.port,
        target: target?.description ?? null,
        updatedAt: Date.now(),
      });
    }

    ctx.cdp.on('reconnected', () => write(true));
    ctx.cdp.on('disconnected', () => write(false));

    // Write initial state
    write(ctx.cdp.isConnected());
  },
});
