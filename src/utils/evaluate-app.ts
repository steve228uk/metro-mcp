import type { CDPConnection, EvalOptions } from '../plugin.js';
import {
  decodeCDPUnserializableValue,
  extractCDPExceptionMessage,
} from './cdp.js';
import {
  awaitAppResult,
  awaitPromiseBeforeDeadline,
  type AppEvaluationCompletion,
} from './await-app-result.js';

export interface AppEvaluationLifecycle {
  /** Ensure a request can be sent before it is dispatched. */
  ensureConnected(deadline?: number): Promise<void>;
  /** Wait for an already running reconnect attempt. */
  waitForReconnect(deadline?: number): Promise<void>;
  /** Start a reconnect attempt when a safe mailbox read loses transport. */
  reconnect(): Promise<void>;
  /** Whether a reconnect attempt is already running. */
  isReconnecting(): boolean;
  /** Monotonic runtime generation; changes invalidate remote handles. */
  getGeneration?: () => number;
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

function remoteObjectValue(remote: Record<string, unknown>): unknown {
  return Object.prototype.hasOwnProperty.call(remote, 'unserializableValue')
    ? decodeCDPUnserializableValue(remote.unserializableValue)
    : remote.value;
}

function boundedRequestTimeout(options?: {
  timeout?: number;
  deadline?: number;
}): number | undefined {
  if (options?.deadline === undefined) return options?.timeout;
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) throw timeoutError(options.timeout ?? 10_000);
  return Math.min(options.timeout ?? 10_000, Math.max(1, remaining));
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
  return remoteObjectValue((result.result ?? {}) as Record<string, unknown>);
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
  const value = remoteObjectValue(remote);
  if (typeof remote.objectId === 'string') {
    return {
      objectId: remote.objectId,
      ...(value === undefined ? {} : { value }),
    };
  }
  return { value };
}

const SETTLE_REMOTE_FUNCTION = `function(key) {
  var state = globalThis[key];
  if (!state) return false;
  function fulfill(value) {
    if (globalThis[key] !== state) return;
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
  function reject(error) {
    if (globalThis[key] !== state) return;
    state.error = rejectionMessage(error);
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
    await lifecycle.ensureConnected(options?.deadline);
    const timeout = boundedRequestTimeout(options);
    return evaluateAppScript(cdp, expression, { ...options, timeout });
  };

  const evaluateScript = async (
    expression: string,
    options?: {
      timeout?: number;
      deadline?: number;
      objectGroup?: string;
      generation?: number;
    },
  ): Promise<AppEvaluationCompletion> => {
    await lifecycle.ensureConnected(options?.deadline);
    if (
      options?.generation !== undefined &&
      lifecycle.getGeneration &&
      options.generation !== lifecycle.getGeneration()
    ) {
      throw new Error('App evaluation context changed before source dispatch');
    }
    const timeout = boundedRequestTimeout(options);
    return evaluateAppScriptCompletion(cdp, expression, { timeout, objectGroup: options?.objectGroup });
  };

  const setupMailbox = async (
    expression: string,
    options: { timeout?: number; deadline: number },
  ): Promise<number | undefined> => {
    await lifecycle.ensureConnected(options.deadline);
    const generation = lifecycle.getGeneration?.();
    const timeout = boundedRequestTimeout(options);
    await evaluateAppScript(cdp, expression, { timeout });
    if (
      generation !== undefined &&
      lifecycle.getGeneration &&
      generation !== lifecycle.getGeneration()
    ) {
      throw new Error('App evaluation context changed during mailbox setup');
    }
    return generation;
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
      // The request may have run the user's thenable before its response was
      // lost. Remote handles are invalid after reconnect, so replaying this
      // callFunctionOn could invoke a side-effecting thenable twice. Recover
      // transport and continue mailbox polling; a pre-dispatch loss remains
      // pending and is allowed to time out.
      await awaitPromiseBeforeDeadline(
        recoverTransport(options.deadline, options.timeout),
        options.deadline,
        options.timeout ?? 10_000,
      );
      if (Date.now() >= options.deadline) {
        throw timeoutError(options.timeout ?? 10_000);
      }
      return false;
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

  async function recoverTransport(deadline?: number, timeout = 10_000): Promise<void> {
    if (deadline !== undefined && Date.now() >= deadline) {
      throw timeoutError(timeout);
    }
    if (lifecycle.isReconnecting()) {
      await lifecycle.waitForReconnect(deadline);
    } else {
      const reconnect = lifecycle.reconnect();
      if (deadline === undefined) await reconnect;
      else await awaitPromiseBeforeDeadline(reconnect, deadline, timeout);
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
      await recoverTransport(options?.deadline, options?.timeout);
      if (options?.deadline !== undefined && Date.now() >= options.deadline) {
        throw timeoutError(options.timeout ?? 10_000);
      }
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
          getRuntimeGeneration: lifecycle.getGeneration,
          setupMailbox,
        },
      );
    }

    // Runtime.evaluate is one-shot for all scripts. A transport failure after
    // dispatch is ambiguous, so retrying here could replay a mutation. The
    // awaitPromise:false option only changes completion handling.
    return rawEvaluate(expression, options);
  };
}
