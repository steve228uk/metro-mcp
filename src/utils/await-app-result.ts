import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { PluginContext } from '../plugin.js';

type Evaluate = PluginContext['evalInApp'];

export type AppEvaluationCompletion =
  | {
      /** Remote object handle for object and Promise completions. */
      objectId: string;
      value?: unknown;
    }
  | {
      /** By-value completion, including an explicit undefined value. */
      objectId?: undefined;
      value: unknown;
    };

type EvaluateScript = (
  expression: string,
  options?: { timeout?: number; deadline?: number; objectGroup?: string },
) => Promise<AppEvaluationCompletion>;

type SettleRemote = (
  objectId: string,
  mailboxKey: string,
  options: { timeout?: number; deadline: number },
) => Promise<boolean>;

type ReleaseObjectGroup = (
  objectGroup: string,
  options: { timeout?: number },
) => Promise<void>;

function timeoutError(timeout: number): Error {
  return new Error(`App evaluation timed out after ${timeout}ms`);
}

type DeadlineEvaluate<T> = (
  expression: string,
  options: { timeout?: number; deadline: number; objectGroup?: string },
) => Promise<T>;

async function evaluateBeforeDeadline<T>(
  evaluate: DeadlineEvaluate<T>,
  expression: string,
  options: { timeout?: number; deadline: number; objectGroup?: string },
  timeout: number,
): Promise<T> {
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) throw timeoutError(timeout);
  return awaitPromiseBeforeDeadline(
    evaluate(expression, {
      timeout: Math.max(
        1,
        Math.min(
          options.timeout ?? remaining,
          remaining,
        ),
      ),
      deadline: options.deadline,
    }),
    options.deadline,
    timeout,
  );
}

async function awaitPromiseBeforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  timeout: number,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw timeoutError(timeout);

  let timer: ReturnType<typeof setTimeout> | undefined;
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
  /** Execute the caller's source as a Runtime.evaluate script exactly once. */
  evaluateScript?: EvaluateScript;
  /** Attach mailbox settlement to a remote Promise/object completion. */
  settleRemote?: SettleRemote;
  /** Release handles if source evaluation completes after the host deadline. */
  releaseObjectGroup?: ReleaseObjectGroup;
}

async function completeByValue(
  evaluate: Evaluate,
  key: string,
  value: unknown,
  options: { deadline: number; timeout: number },
): Promise<void> {
  const serialized = value === undefined ? 'void 0' : JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('App evaluation result could not be serialized');
  }
  await evaluateBeforeDeadline(
    evaluate,
    `(function() {
      var state = globalThis[${key}];
      if (state) {
        state.value = ${serialized};
        state.status = 'fulfilled';
      }
    })()`,
    options,
    options.timeout,
  );
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
  const mailboxName = `__METRO_MCP_ASYNC_${randomUUID()}`;
  const objectGroup = `__METRO_MCP_ASYNC_GROUP_${randomUUID()}`;
  const key = JSON.stringify(mailboxName);
  const deadline = Date.now() + timeout;
  let sourceCompletedByValue = false;
  let remoteHandleReleased = false;
  let sourceEvaluation: Promise<AppEvaluationCompletion> | undefined;
  let sourceEvaluationSettled = false;

  const releaseGroup = async (): Promise<void> => {
    if (!options?.releaseObjectGroup) return;
    const releaseDeadline = Date.now() + 100;
    await awaitPromiseBeforeDeadline(
      options.releaseObjectGroup(objectGroup, { timeout: 100 }),
      releaseDeadline,
      100,
    ).catch(() => {});
  };

  try {
    await evaluateBeforeDeadline(evaluate, `(function() {
      var state = { status: 'pending' };
      Object.defineProperty(globalThis, ${key}, {
        value: state, configurable: true
      });
      state.timer = setTimeout(function() {
        if (globalThis[${key}] === state) delete globalThis[${key}];
      }, ${timeout + 1000});
      return true;
    })()`, { timeout, deadline }, timeout);

    // Runtime.evaluate must receive the user's source itself. Indirect eval
    // runs in a separate variable environment and silently loses top-level
    // let/const/class declarations. The evaluator supplied by the server
    // requests a remote completion object so Hermes' Promise can settle the
    // mailbox without replaying the source during a reconnect.
    let completion: AppEvaluationCompletion;
    if (options?.evaluateScript) {
      if (Date.now() >= deadline) throw timeoutError(timeout);
      sourceEvaluation = options.evaluateScript(expression, { timeout, deadline, objectGroup });
      sourceEvaluation.then(
        () => { sourceEvaluationSettled = true; },
        () => { sourceEvaluationSettled = true; },
      );
      completion = await awaitPromiseBeforeDeadline(sourceEvaluation, deadline, timeout);
    } else {
      completion = { value: await evaluateBeforeDeadline(evaluate, expression, { timeout, deadline }, timeout) };
      sourceCompletedByValue = true;
    }

    if (completion.objectId) {
      if (!options?.settleRemote) {
        throw new Error('App evaluation returned a remote object without settlement support');
      }
      if (Date.now() >= deadline) throw timeoutError(timeout);
      remoteHandleReleased = await awaitPromiseBeforeDeadline(
        options.settleRemote(completion.objectId, mailboxName, {
          timeout,
          deadline,
        }),
        deadline,
        timeout,
      );
    } else {
      sourceCompletedByValue = true;
      // The source has already executed. A transport failure while writing its
      // completion is safe to retry through the mailbox evaluator, which owns
      // reconnect policy and never replays the caller's source.
      await completeByValue(pollEvaluate, key, completion.value, { deadline, timeout });
    }

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
    // Runtime.evaluate may still complete after the host-side deadline and
    // return an object handle that never reaches settleRemote. Release the
    // whole group best effort so late completions cannot accumulate handles.
    if (!sourceCompletedByValue && !remoteHandleReleased) {
      // Cleanup has its own transport and host deadline. Keep it detached so
      // a result found within the caller's deadline is never delayed past it.
      void releaseGroup();
      if (sourceEvaluation && !sourceEvaluationSettled) {
        // A transport timeout can race the engine's eventual response. Keep
        // this continuation bounded and release the same unique group after
        // that response arrives, without leaving a polling timer alive.
        void sourceEvaluation.then(() => releaseGroup(), () => releaseGroup());
      }
    }
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
