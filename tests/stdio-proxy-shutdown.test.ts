import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { registerStdioProxyShutdown } from '../src/daemon.js';

describe('stdio proxy shutdown triggers', () => {
  for (const event of ['end', 'close', 'SIGINT', 'SIGTERM', 'beforeExit']) {
    test(`releases on ${event} exactly once and removes its listeners`, () => {
      const input = new EventEmitter();
      const lifecycle = new EventEmitter();
      let shutdowns = 0;
      const cleanup = registerStdioProxyShutdown(
        () => shutdowns++,
        input,
        lifecycle,
      );
      (event === 'end' || event === 'close' ? input : lifecycle).emit(event);
      input.emit('end');
      input.emit('close');
      lifecycle.emit('SIGTERM');
      expect(shutdowns).toBe(1);
      cleanup();
      cleanup();
      expect(input.eventNames()).toEqual([]);
      expect(lifecycle.eventNames()).toEqual([]);
    });
  }
});
