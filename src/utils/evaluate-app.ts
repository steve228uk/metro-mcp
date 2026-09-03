import type { CDPConnection, EvalOptions } from '../plugin.js';
import { extractCDPExceptionMessage } from './cdp.js';
import { awaitAppResult } from './await-app-result.js';

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
  const result = (await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
    timeout: options?.timeout,
  })) as Record<string, unknown>;
  if (result.exceptionDetails) {
    throw new Error(
      extractCDPExceptionMessage(
        result.exceptionDetails as Record<string, unknown>,
      ),
    );
  }
  return (result.result as Record<string, unknown>).value;
}

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
      throw new Error(`App evaluation timed out after ${options.timeout ?? 10_000}ms`);
    }
    return evaluateAppScript(cdp, expression, options);
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
        { pollEvaluate: retryMailboxRead },
      );
    }

    // Runtime.evaluate is one-shot for all scripts. A transport failure after
    // dispatch is ambiguous, so retrying here could replay a mutation. The
    // awaitPromise:false option only changes completion handling.
    return rawEvaluate(expression, options);
  };
}
