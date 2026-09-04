import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { PluginContext } from '../plugin.js';
import { decodeCDPUnserializableValue } from './cdp.js';

type Evaluate = PluginContext['evalInApp'];

type SetupMailbox = (
  expression: string,
  options: { timeout?: number; deadline: number },
) => Promise<number | undefined>;

type RetryMailboxSetup = (
  options: { timeout?: number; deadline: number },
) => Promise<number | undefined>;

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
  options?: {
    timeout?: number;
    deadline?: number;
    objectGroup?: string;
    completionKey?: string;
    generation?: number;
    /** Recreate the mailbox after a safe pre-dispatch source retry. */
    retryMailboxSetup?: RetryMailboxSetup;
  },
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

const RELEASE_GROUP_TIMEOUT_MS = 100;
const RELEASE_GROUP_AFTER_DEADLINE_MS = 250;

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

export async function awaitPromiseBeforeDeadline<T>(
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
  /** Absolute caller deadline shared by every awaited stage. */
  deadline?: number;
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
  /** Runtime generation captured after mailbox creation. */
  getRuntimeGeneration?: () => number;
  /** Create the mailbox while bracketing the dispatch with generation checks. */
  setupMailbox?: SetupMailbox;
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
  const timeoutDeadline = Date.now() + timeout;
  const deadline = options?.deadline === undefined
    ? timeoutDeadline
    : Math.min(timeoutDeadline, options.deadline);
  let sourceCompletedByValue = false;
  let remoteHandleReleased = false;
  let sourceEvaluationStarted = false;
  let sourceEvaluation: Promise<AppEvaluationCompletion> | undefined;
  let sourceEvaluationSettled = false;

  const releaseGroup = async (): Promise<void> => {
    if (!options?.releaseObjectGroup) return;
    const remaining = deadline - Date.now();
    // Cleanup is detached from the caller, so it may use a small independent
    // budget after the caller deadline to release a handle whose evaluate
    // response arrived late. Before the deadline, retain the caller bound.
    const releaseTimeout = remaining > 0
      ? Math.min(RELEASE_GROUP_TIMEOUT_MS, remaining)
      : RELEASE_GROUP_AFTER_DEADLINE_MS;
    const releaseDeadline = Date.now() + releaseTimeout;
    await awaitPromiseBeforeDeadline(
      options.releaseObjectGroup(objectGroup, { timeout: releaseTimeout }),
      releaseDeadline,
      releaseTimeout,
    ).catch(() => {});
  };

  try {
    const mailboxLifetime = Math.max(
      0,
      Math.min(timeout, deadline - Date.now()),
    ) + 1000;
    const mailboxSetup = `(function() {
      var root = this;
      var state = { status: 'pending', observing: false };
      function rejectionMessage(error) {
        var message;
        try {
          if (error !== null && error !== undefined) message = error.message;
        } catch (_) {}
        if (message !== undefined && message !== null) {
          try { return String(message); } catch (_) {}
        }
        try { return String(error); } catch (_) {}
        return 'Promise rejected with an unstringifiable reason';
      }
      function fulfill(value) {
        if (root[${key}] !== state) return;
        state.unserializableValue = undefined;
        if (typeof value === 'number') {
          if (value !== value) state.unserializableValue = 'NaN';
          else if (value === Infinity) state.unserializableValue = 'Infinity';
          else if (value === -Infinity) state.unserializableValue = '-Infinity';
          else if (value === 0 && 1 / value === -Infinity) state.unserializableValue = '-0';
        } else if (typeof value === 'bigint') {
          state.unserializableValue = String(value) + 'n';
        }
        state.value = state.unserializableValue === undefined ? value : undefined;
        state.status = 'fulfilled';
      }
      function reject(error) {
        if (root[${key}] !== state) return;
        state.error = rejectionMessage(error);
        state.status = 'rejected';
      }
      state.observe = async function(value) {
        if (state.observing) return;
        state.observing = true;
        try { fulfill(await value); } catch (error) { reject(error); }
      };
      root.Object.defineProperty(root, ${key}, {
        value: state, configurable: true
      });
      state.timer = root.setTimeout(function() {
        if (root[${key}] === state) delete root[${key}];
      }, ${mailboxLifetime});
      return true;
    })()`;
    const mailboxGeneration = options?.setupMailbox
      ? await evaluateBeforeDeadline(
        options.setupMailbox,
        mailboxSetup,
        { timeout, deadline },
        timeout,
      )
      : await evaluateBeforeDeadline(
        evaluate,
        mailboxSetup,
        { timeout, deadline },
        timeout,
      ).then(() => options?.getRuntimeGeneration?.());

    // Runtime.evaluate must receive the user's source itself. Indirect eval
    // runs in a separate variable environment and silently loses top-level
    // let/const/class declarations. The evaluator supplied by the server
    // requests a remote completion object so Hermes' Promise can settle the
    // mailbox without replaying the source during a reconnect.
    let completion: AppEvaluationCompletion;
    if (options?.evaluateScript) {
      if (Date.now() >= deadline) throw timeoutError(timeout);
      sourceEvaluationStarted = true;
      sourceEvaluation = options.evaluateScript(expression, {
        timeout,
        deadline,
        objectGroup,
        completionKey: mailboxName,
        generation: mailboxGeneration,
        retryMailboxSetup: options.setupMailbox
          ? (retryOptions) => options.setupMailbox!(mailboxSetup, retryOptions)
          : undefined,
      });
      sourceEvaluation.then(
        () => { sourceEvaluationSettled = true; },
        () => { sourceEvaluationSettled = true; },
      );
      completion = await awaitPromiseBeforeDeadline(sourceEvaluation, deadline, timeout);
    } else {
      completion = { value: await evaluateBeforeDeadline(evaluate, expression, { timeout, deadline }, timeout) };
      sourceCompletedByValue = true;
    }

    const runtimeGenerationChanged = mailboxGeneration !== undefined &&
      options?.getRuntimeGeneration !== undefined &&
      options.getRuntimeGeneration() !== mailboxGeneration;
    if (completion.objectId && !runtimeGenerationChanged) {
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
    } else if (!completion.objectId) {
      // Runtime.evaluate returns primitives by value when the source has no
      // remote object completion. They are already complete, so writing them
      // back through the mailbox would add an unnecessary request and poll.
      // The finally block still performs best-effort mailbox cleanup.
      sourceCompletedByValue = true;
      return completion.value;
    }

    // The source may have completed just before a reconnect changed the
    // runtime generation. Its completion handle is now stale, but the
    // source's mailbox observation is still the safe one-shot result.

    while (Date.now() < deadline) {
      const result = await evaluateBeforeDeadline(pollEvaluate, `(function() {
        var root = this;
        var state = root[${key}];
        if (!state) return { status: 'missing' };
        return {
          status: state.status,
          value: state.value,
          unserializableValue: state.unserializableValue,
          error: state.error
        };
      })()`, { timeout: Math.max(1, deadline - Date.now()), deadline }, timeout) as {
        status: string;
        value?: unknown;
        unserializableValue?: unknown;
        error?: string;
      };
      if (result?.status === 'fulfilled') {
        return result.unserializableValue === undefined
          ? result.value
          : decodeCDPUnserializableValue(result.unserializableValue);
      }
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
    if (sourceEvaluationStarted && !sourceCompletedByValue && !remoteHandleReleased) {
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
      // Cleanup is best effort and must not delay delivery of a value that has
      // already settled. The mailbox also has an in-app expiry for a lost
      // host, so leave this bounded operation detached from the caller.
      void evaluateBeforeDeadline(cleanupEvaluate, `(function() {
        var root = this;
        var state = root[${key}];
        if (state) root.clearTimeout(state.timer);
        delete root[${key}];
      })()`, { timeout: Math.min(1000, remaining), deadline }, timeout).catch(() => {});
    }
  }
}
