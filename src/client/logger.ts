/**
 * Structured logging with channels.
 */

import { ClientBuffer } from './client-buffer.js';

export interface LogEntry {
  timestamp: number;
  channel: string;
  data: unknown;
}

export class StructuredLogger {
  channels = new Map<string, ClientBuffer<LogEntry>>();

  log(channel: string, data: unknown): void {
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new ClientBuffer<LogEntry>(200));
    }
    this.channels.get(channel)!.push({
      timestamp: Date.now(),
      channel,
      data,
    });
  }

  getChannel(channel: string): LogEntry[] {
    return this.channels.get(channel)?.getAll() || [];
  }

  getAllChannels(): string[] {
    return Array.from(this.channels.keys());
  }

  clear(channel?: string): void {
    if (channel) {
      this.channels.get(channel)?.clear();
    } else {
      this.channels.clear();
    }
  }
}
