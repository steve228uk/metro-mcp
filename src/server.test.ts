import { describe, expect, test } from 'bun:test';
import { createAppEvaluator } from './utils/evaluate-app.js';
import { waitForConnectionUntil } from './server.js';

describe('server connection deadlines', () => {
  test('bounds an initial disconnected awaitPromise wait before source dispatch', async () => {
    const methods: string[] = [];
    let waits = 0;
    const evaluate = createAppEvaluator({
      send: async (method) => {
        methods.push(method);
        return { result: { value: undefined } };
      },
    }, {
      ensureConnected: async (deadline) => {
        const connected = await waitForConnectionUntil(
          () => waits++ === 0
            ? Promise.resolve(false)
            : new Promise<boolean>(() => {}),
          deadline,
        );
        if (!connected) {
          await waitForConnectionUntil(
            () => {
              waits += 1;
              return new Promise<boolean>(() => {});
            },
            deadline,
          );
        }
      },
      waitForReconnect: async () => {},
      reconnect: async () => {},
      isReconnecting: () => false,
    });

    const started = Date.now();
    await expect(evaluate('globalThis.shouldNotRun = true;', {
      awaitPromise: true,
      timeout: 30,
    })).rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(500);
    expect(waits).toBe(2);
    expect(methods.filter((method) => method === 'Runtime.evaluate')).toHaveLength(0);
  });
});
