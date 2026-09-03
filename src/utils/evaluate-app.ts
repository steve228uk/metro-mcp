import type { CDPConnection, EvalOptions } from '../plugin.js';
import { extractCDPExceptionMessage } from './cdp.js';
import {
  awaitAppResult,
  awaitPromiseBeforeDeadline,
  type AppEvaluationCompletion,
} from './await-app-result.js';

export interface AppEvaluationLifecycle {
  /** Ensure a request can be sent before it is dispatched. */
  ensureConnected(): Promise<void>;
  /** Wait for an already running reconnect attempt. */
  waitForReconnect(): Promise<void>;
  /** Start a reconnect attempt when a safe mailbox read loses transport. */
  reconnect(): Promise<void>;
  /** Whether a reconnect attempt is already running. */
  isReconnecting(): boolean;
}

function isTransportError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'WebSocket closed' ||
      error.message === 'Not connected to CDP target' ||
      error.message ===
        'Not connected to Metro. Use list_devices to check connection status.')
  );
}

function timeoutError(timeout: number): Error {
  return new Error(`App evaluation timed out after ${timeout}ms`);
}

async function sendRuntimeEvaluate(
  cdp: Pick<CDPConnection, 'send'>,
  params: Record<string, unknown>,
  timeout?: number,
): Promise<Record<string, unknown>> {
  const result = (await cdp.send(
    'Runtime.evaluate',
    params,
    timeout === undefined ? undefined : { timeoutMs: timeout },
  )) as Record<string, unknown>;
  if (result.exceptionDetails) {
    throw new Error(
      extractCDPExceptionMessage(
        result.exceptionDetails as Record<string, unknown>,
      ),
    );
  }
  return result;
}

/**
 * Send one Runtime.evaluate request and return its by-value completion value.
 *
 * This intentionally has no reconnect or retry policy. A transport error after
 * dispatch cannot tell us whether the app ran the script, so replaying it could
 * duplicate a mutation. Retry policy belongs to callers that know their read
 * is safe, such as mailbox polling.
 */
export async function evaluateAppScript(
  cdp: Pick<CDPConnection, 'send'>,
  expression: string,
  options?: EvalOptions,
): Promise<unknown> {
  const result = await sendRuntimeEvaluate(cdp, {
    expression,
    returnByValue: true,
    awaitPromise: false,
    ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
  }, options?.timeout);
  return (result.result as Record<string, unknown>).value;
}

/**
 * Execute a script once and retain its remote completion object. Keeping the
 * Runtime.evaluate request separate from mailbox setup is what preserves
 * normal script completion and declaration semantics on persistent runtimes.
 */
export async function evaluateAppScriptCompletion(
  cdp: Pick<CDPConnection, 'send'>,
  expression: string,
  options?: EvalOptions,
): Promise<AppEvaluationCompletion> {
  const result = await sendRuntimeEvaluate(cdp, {
    expression,
    returnByValue: false,
    awaitPromise: false,
    ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options?.objectGroup ? { objectGroup: options.objectGroup } : {}),
  }, options?.timeout);
  const remote = (result.result ?? {}) as Record<string, unknown>;
  if (typeof remote.objectId === 'string') {
    return {
      objectId: remote.objectId,
      ...(remote.value === undefined ? {} : { value: remote.value }),
    };
  }
  return { value: remote.value };
}

const SETTLE_REMOTE_FUNCTION = `function(key) {
  var state = globalThis[key];
  if (!state) return false;
  function fulfill(value) {
    if (globalThis[key] !== state) return;
    state.value = value;
    state.status = 'fulfilled';
  }
  function reject(error) {
    if (globalThis[key] !== state) return;
    state.error = String(error && error.message || error);
    state.status = 'rejected';
  }
  try {
    // Assimilate arbitrary thenables exactly once. Calling this.then
    // directly would accept a second callback or a nested thenable as the
    // final value, unlike JavaScript Promise resolution.
    Promise.resolve(this).then(fulfill, reject);
  } catch (error) { reject(error); }
  return true;
}`;

/**
 * Create the shared PluginContext evaluator policy. The raw primitive above
 * remains one-shot; only mailbox reads are eligible for reconnect/retry.
 */
export function createAppEvaluator(
  cdp: Pick<CDPConnection, 'send'>,
  lifecycle: AppEvaluationLifecycle,
): (expression: string, options?: EvalOptions) => Promise<unknown> {
  const rawEvaluate = async (
    expression: string,
    options?: EvalOptions,
  ): Promise<unknown> => {
    await lifecycle.ensureConnected();
    if (options?.deadline !== undefined && Date.now() >= options.deadline) {
      throw timeoutError(options.timeout ?? 10_000);
    }
    const timeout = options?.deadline === undefined
      ? options?.timeout
      : Math.min(options.timeout ?? 10_000, Math.max(1, options.deadline - Date.now()));
    return evaluateAppScript(cdp, expression, { ...options, timeout });
  };

  const evaluateScript = async (
    expression: string,
    options?: { timeout?: number; deadline?: number; objectGroup?: string },
  ): Promise<AppEvaluationCompletion> => {
    await lifecycle.ensureConnected();
    if (options?.deadline !== undefined && Date.now() >= options.deadline) {
      throw timeoutError(options.timeout ?? 10_000);
    }
    const timeout = options?.deadline === undefined
      ? options?.timeout
      : Math.min(options.timeout ?? 10_000, Math.max(1, options.deadline - Date.now()));
    return evaluateAppScriptCompletion(cdp, expression, { timeout, objectGroup: options?.objectGroup });
  };

  const settleRemote = async (
    objectId: string,
    mailboxKey: string,
    options: { timeout?: number; deadline: number },
  ): Promise<boolean> => {
    const attachRemoteSettlement = async (): Promise<boolean> => {
      const remaining = options.deadline - Date.now();
      if (remaining <= 0) throw timeoutError(options.timeout ?? 10_000);
      const result = (await cdp.send(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: SETTLE_REMOTE_FUNCTION,
          arguments: [{ value: mailboxKey }],
          returnByValue: true,
        },
        { timeoutMs: Math.min(options.timeout ?? remaining, remaining) },
      )) as Record<string, unknown>;
      if (result.exceptionDetails) {
        throw new Error(
          extractCDPExceptionMessage(
            result.exceptionDetails as Record<string, unknown>,
          ),
        );
      }
      // Keep the unique object group responsible for cleanup. Its separately
      // bounded release runs after mailbox settlement, so handle cleanup cannot
      // delay polling or leave a detached, permanently pending transport call.
      return false;
    };

    try {
      return await attachRemoteSettlement();
    } catch (error) {
      if (!isTransportError(error)) throw error;
      // Attaching the same settlement callback twice is safe: it only writes
      // the private mailbox and never re-runs the caller's source. Bound the
      // reconnect itself by the same deadline as the attach and re-check it
      // before dispatching the retry, since reconnect may finish late.
      await awaitPromiseBeforeDeadline(
        recoverTransport(),
        options.deadline,
        options.timeout ?? 10_000,
      );
      if (Date.now() >= options.deadline) {
        throw timeoutError(options.timeout ?? 10_000);
      }
      return attachRemoteSettlement();
    }
  };

  const releaseObjectGroup = async (
    objectGroup: string,
    options: { timeout?: number },
  ): Promise<void> => {
    await cdp.send(
      'Runtime.releaseObjectGroup',
      { objectGroup },
      { timeoutMs: options.timeout ?? 500 },
    );
  };

  async function recoverTransport(): Promise<void> {
    if (lifecycle.isReconnecting()) {
      await lifecycle.waitForReconnect();
    } else {
      await lifecycle.reconnect();
    }
  }

  const retryMailboxRead = async (
    expression: string,
    options?: EvalOptions,
  ): Promise<unknown> => {
    try {
      return await rawEvaluate(expression, options);
    } catch (error) {
      if (!isTransportError(error)) throw error;
      await recoverTransport();
      // This expression is a mailbox read. The original caller source is
      // never passed here after Runtime.evaluate has been dispatched.
      return rawEvaluate(expression, options);
    }
  };

  return async (expression: string, options?: EvalOptions): Promise<unknown> => {
    if (options?.awaitPromise) {
      return awaitAppResult(
        rawEvaluate,
        expression,
        options.timeout ?? 10_000,
        {
          pollEvaluate: retryMailboxRead,
          evaluateScript,
          settleRemote,
          releaseObjectGroup,
        },
      );
    }

    // Runtime.evaluate is one-shot for all scripts. A transport failure after
    // dispatch is ambiguous, so retrying here could replay a mutation. The
    // awaitPromise:false option only changes completion handling.
    return rawEvaluate(expression, options);
  };
}
