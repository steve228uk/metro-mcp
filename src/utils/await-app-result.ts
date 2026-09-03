import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { PluginContext } from '../plugin.js';

type Evaluate = PluginContext['evalInApp'];

function timeoutError(timeout: number): Error {
  return new Error(`App evaluation timed out after ${timeout}ms`);
}

async function evaluateBeforeDeadline(
  evaluate: Evaluate,
  expression: string,
  options: { timeout?: number; deadline: number },
  timeout: number,
): Promise<unknown> {
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) throw timeoutError(timeout);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = evaluate(expression, {
    timeout: Math.max(1, Math.min(options.timeout ?? remaining, remaining)),
    deadline: options.deadline,
  });
  const deadlineReached = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(timeout)), remaining);
  });
  try {
    return await Promise.race([operation, deadlineReached]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface AwaitAppResultOptions {
  /**
   * Evaluation used for mailbox reads. This may reconnect before a read, but
   * must never replay the expression that created the mailbox.
   */
  pollEvaluate?: Evaluate;
  /** Evaluation used to remove the mailbox during cleanup. */
  cleanupEvaluate?: Evaluate;
}

/**
 * Await a read expression without relying on CDP's awaitPromise support.
 * Hermes can return a serialized JS Promise instead of its resolved value.
 * A private, expiring mailbox lets us read the settled value synchronously.
 */
export async function awaitAppResult(
  evaluate: PluginContext['evalInApp'],
  expression: string,
  timeout = 10_000,
  options?: AwaitAppResultOptions,
): Promise<unknown> {
  const pollEvaluate = options?.pollEvaluate ?? evaluate;
  const cleanupEvaluate = options?.cleanupEvaluate ?? evaluate;
  const key = JSON.stringify(`__METRO_MCP_ASYNC_${randomUUID()}`);
  const deadline = Date.now() + timeout;
  try {
    await evaluateBeforeDeadline(evaluate, `(function() {
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
        // Evaluate the caller's source as a script so awaitPromise works for
        // the same completion values as Runtime.evaluate (including multiple
        // statements and declarations), rather than interpolating it into an
        // expression. The source is evaluated exactly once before polling.
        Promise.resolve((0, eval)(${JSON.stringify(expression)})).then(function(value) {
          state.value = value;
          state.status = 'fulfilled';
        }, reject);
      } catch (error) { reject(error); }
      return true;
    })()`, { timeout, deadline }, timeout);

    while (Date.now() < deadline) {
      const result = await evaluateBeforeDeadline(pollEvaluate, `(function() {
        var state = globalThis[${key}];
        if (!state) return { status: 'missing' };
        return {
          status: state.status, value: state.value, error: state.error
        };
      })()`, { timeout: Math.max(1, deadline - Date.now()), deadline }, timeout) as {
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
    throw timeoutError(timeout);
  } finally {
    // Also expires inside the app if the MCP process or CDP connection is lost.
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await evaluateBeforeDeadline(cleanupEvaluate, `(function() {
        var state = globalThis[${key}];
        if (state) clearTimeout(state.timer);
        delete globalThis[${key}];
      })()`, { timeout: Math.min(1000, remaining), deadline }, timeout).catch(() => {});
    }
  }
}
