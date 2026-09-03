import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { PluginContext } from '../plugin.js';

/**
 * Await a read expression without relying on CDP's awaitPromise support.
 * Hermes can return a serialized JS Promise instead of its resolved value.
 * A private, expiring mailbox lets us read the settled value synchronously.
 */
export async function awaitAppResult(
  evaluate: PluginContext['evalInApp'],
  expression: string,
  timeout = 10_000,
): Promise<unknown> {
  const key = JSON.stringify(`__METRO_MCP_ASYNC_${randomUUID()}`);
  const deadline = Date.now() + timeout;
  try {
    await evaluate(`(function() {
      var state = { status: 'pending' };
      Object.defineProperty(globalThis, ${key}, {
        value: state, configurable: true
      });
      state.timer = setTimeout(function() {
        if (globalThis[${key}] === state) delete globalThis[${key}];
      }, ${timeout + 1000});
      function reject(error) {
        state.status = 'rejected';
        state.error = String(error && error.message || error);
      }
      try {
        Promise.resolve(${expression}).then(function(value) {
          state.value = value;
          state.status = 'fulfilled';
        }, reject);
      } catch (error) { reject(error); }
      return true;
    })()`, { timeout });

    while (Date.now() < deadline) {
      const result = await evaluate(`(function() {
        var state = globalThis[${key}];
        if (!state) return { status: 'missing' };
        return {
          status: state.status, value: state.value, error: state.error
        };
      })()`, { timeout: Math.max(1, deadline - Date.now()) }) as {
        status: string;
        value?: unknown;
        error?: string;
      };
      if (result?.status === 'fulfilled') return result.value;
      if (result?.status === 'rejected') throw new Error(result.error);
      if (!result || result.status !== 'pending') {
        throw new Error('App evaluation context was lost before measurement completed');
      }
      await delay(Math.min(25, Math.max(0, deadline - Date.now())));
    }
    throw new Error(`App evaluation timed out after ${timeout}ms`);
  } finally {
    // Also expires inside the app if the MCP process or CDP connection is lost.
    await evaluate(`(function() {
      var state = globalThis[${key}];
      if (state) clearTimeout(state.timer);
      delete globalThis[${key}];
    })()`, { timeout: 1000 }).catch(() => {});
  }
}
