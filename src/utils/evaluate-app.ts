import type { CDPConnection, EvalOptions } from '../plugin.js';
import { parse } from '@babel/parser';
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

/** An exception returned by the app runtime, after Runtime.evaluate ran. */
class AppEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppEvaluationError';
  }
}

function isTransportError(error: unknown): boolean {
  if (error instanceof AppEvaluationError) return false;
  return (
    error instanceof Error &&
    (error.message === 'WebSocket closed' ||
      error.message === 'Not connected to CDP target' ||
      error.message ===
        'Not connected to Metro. Use list_devices to check connection status.')
  );
}

// Metro Bridge uses this exact error when it rejects a request before writing
// anything to the target. It is safe to retry that request once after
// connection recovery; errors such as WebSocket closed can follow a request
// that already ran and must remain one-shot.
function isDefinitivePreDispatchFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    !(error instanceof AppEvaluationError) &&
    error.message === 'Not connected to CDP target'
  );
}

function isServerDisconnectedError(error: unknown): boolean {
  return error instanceof Error &&
    error.message === 'Not connected to Metro. Use list_devices to check connection status.';
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
    throw new AppEvaluationError(
      extractCDPExceptionMessage(
        result.exceptionDetails as Record<string, unknown>,
      ),
    );
  }
  return result;
}

type StatementLike = {
  type: string;
  body?: unknown;
  expression?: ExpressionLike;
  [key: string]: unknown;
};
type ExpressionLike = { start: number | null; end: number | null };
type CompletionPath = {
  expressions: ExpressionLike[];
  empty: boolean;
  normal: boolean;
};
type ExitPath = CompletionPath & { label: string | null };
type Completion = CompletionPath & {
  breaks: ExitPath[];
  continues: ExitPath[];
};

const emptyCompletion = (): Completion => ({
  expressions: [],
  empty: true,
  normal: true,
  breaks: [],
  continues: [],
});

const abruptCompletion = (): Completion => ({
  expressions: [],
  empty: false,
  normal: false,
  breaks: [],
  continues: [],
});

function mergePaths(left: CompletionPath, right: CompletionPath): CompletionPath {
  return {
    expressions: [...left.expressions, ...right.expressions],
    empty: left.empty || right.empty,
    normal: left.normal || right.normal,
  };
}

function mergeCompletions(left: Completion, right: Completion): Completion {
  const merged = mergePaths(left, right);
  return {
    ...merged,
    breaks: [...left.breaks, ...right.breaks],
    continues: [...left.continues, ...right.continues],
  };
}

function consumeBreaks(completion: Completion, label: string | null = null): Completion {
  let normal: CompletionPath = completion;
  const remaining: ExitPath[] = [];
  for (const path of completion.breaks) {
    if (path.label === label) normal = mergePaths(normal, path);
    else remaining.push(path);
  }
  return { ...normal, breaks: remaining, continues: completion.continues };
}

function consumeLoopExits(completion: Completion): Completion {
  let normal: CompletionPath = completion;
  const breaks: ExitPath[] = [];
  const continues: ExitPath[] = [];
  for (const path of completion.breaks) {
    if (path.label === null) normal = mergePaths(normal, path);
    else breaks.push(path);
  }
  for (const path of completion.continues) {
    if (path.label === null) normal = mergePaths(normal, path);
    else continues.push(path);
  }
  return { ...normal, breaks, continues };
}

function consumeLabelExits(completion: Completion, label: string): Completion {
  const afterBreaks = consumeBreaks(completion, label);
  let normal: CompletionPath = afterBreaks;
  const continues: ExitPath[] = [];
  for (const path of afterBreaks.continues) {
    if (path.label === label) normal = mergePaths(normal, path);
    else continues.push(path);
  }
  return { ...normal, breaks: afterBreaks.breaks, continues };
}

function completionForStatement(statement: StatementLike): Completion {
  switch (statement.type) {
    case 'EmptyStatement':
    case 'VariableDeclaration':
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
    case 'DebuggerStatement':
      return emptyCompletion();
    case 'ExpressionStatement':
      return statement.expression ? {
        expressions: [statement.expression],
        empty: false,
        normal: true,
        breaks: [],
        continues: [],
      } : emptyCompletion();
    case 'BlockStatement':
      return Array.isArray(statement.body)
        ? completionForStatements(statement.body as StatementLike[])
        : emptyCompletion();
    case 'IfStatement': {
      const consequent = completionForStatement(statement.consequent as StatementLike);
      const alternate = statement.alternate
        ? completionForStatement(statement.alternate as StatementLike)
        : emptyCompletion();
      return mergeCompletions(consequent, alternate);
    }
    case 'TryStatement': {
      const body = completionForStatement(statement.block as StatementLike);
      const handler = statement.handler
        ? completionForStatement((statement.handler as { body: StatementLike }).body)
        : abruptCompletion();
      const guarded = mergeCompletions(body, handler);
      if (!statement.finalizer) return guarded;
      const finalizer = completionForStatement(statement.finalizer as StatementLike);
      if (!finalizer.normal) return finalizer;
      // A normal `finally` completion is UpdateEmpty: its expression value is
      // discarded, while the prior try/catch completion is retained. This is
      // why `try { 1 } finally { 2 }` evaluates to 1 in a script.
      return {
        ...guarded,
        breaks: [...guarded.breaks, ...finalizer.breaks],
        continues: [...guarded.continues, ...finalizer.continues],
      };
    }
    case 'LabeledStatement':
      return consumeLabelExits(
        completionForStatement(statement.body as StatementLike),
        (statement.label as { name: string } | null | undefined)?.name ?? '',
      );
    case 'WithStatement':
      return completionForStatement(statement.body as StatementLike);
    case 'SwitchStatement': {
      const cases = (statement.cases as Array<{ consequent: StatementLike[] }> | undefined) ?? [];
      let completion = emptyCompletion();
      for (let index = 0; index < cases.length; index += 1) {
        const caseCompletion = completionForStatements(
          cases.slice(index).flatMap((entry) => entry.consequent),
        );
        completion = mergeCompletions(
          completion,
          consumeBreaks(caseCompletion),
        );
      }
      return completion;
    }
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
      return mergeCompletions(
        consumeLoopExits(completionForStatement(statement.body as StatementLike)),
        emptyCompletion(),
      );
    case 'ThrowStatement':
    case 'ReturnStatement':
      return abruptCompletion();
    case 'BreakStatement':
      return {
        ...abruptCompletion(),
        breaks: [{ ...emptyCompletion(), label: (statement.label as { name: string } | null | undefined)?.name ?? null }],
      };
    case 'ContinueStatement':
      return {
        ...abruptCompletion(),
        continues: [{ ...emptyCompletion(), label: (statement.label as { name: string } | null | undefined)?.name ?? null }],
      };
    default:
      return abruptCompletion();
  }
}

function completionForStatements(statements: StatementLike[]): Completion {
  let completion = emptyCompletion();
  for (const statement of statements) {
    const next = completionForStatement(statement);
    const breaks: ExitPath[] = [
      ...completion.breaks,
      ...next.breaks.map((path) => path.empty ? { ...completion, label: path.label } : path),
    ];
    const continues: ExitPath[] = [
      ...completion.continues,
      ...next.continues.map((path) => path.empty ? { ...completion, label: path.label } : path),
    ];
    if (!next.normal) {
      return { ...next, breaks, continues };
    }
    completion = {
      ...(next.empty ? mergePaths(completion, next) : next),
      breaks,
      continues,
    };
  }
  return completion;
}

function promiseObservationExpression(expression: string): string {
  let ast;
  try {
    ast = parse(expression, { sourceType: 'script' });
  } catch {
    return expression;
  }
  const completion = completionForStatements(ast.program.body as StatementLike[]);
  if (!completion.normal || completion.expressions.length === 0) return expression;
  const edits = completion.expressions
    .filter(({ start, end }) => start !== null && end !== null)
    .map(({ start, end }) => ({ start: start as number, end: end as number }))
    .filter((edit, index, all) =>
      all.findIndex((candidate) => candidate.start === edit.start && candidate.end === edit.end) === index,
    )
    .sort((left, right) => right.start - left.start);
  let transformed = expression;
  for (const { start, end } of edits) {
    const candidate = expression.slice(start, end);
    const observer = `(function observePromise(value) {
      try {
        var PromiseCtor = globalThis.Promise;
        if (PromiseCtor) {
          PromiseCtor.prototype.then.call(value, function() {}, function() {});
        }
      } catch (_) {}
      return value;
    })((${candidate}
  ))`;
    transformed = transformed.slice(0, start) + observer + transformed.slice(end);
  }
  return transformed;
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
  options?: EvalOptions & { observePromiseRejection?: boolean },
): Promise<AppEvaluationCompletion> {
  const result = await sendRuntimeEvaluate(cdp, {
    expression: options?.observePromiseRejection
      ? promiseObservationExpression(expression)
      : expression,
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
 * remains one-shot after dispatch; a definitive pre-dispatch disconnect may
 * be recovered once, while mailbox reads also have their safe retry policy.
 */
export function createAppEvaluator(
  cdp: Pick<CDPConnection, 'send'>,
  lifecycle: AppEvaluationLifecycle,
): (expression: string, options?: EvalOptions) => Promise<unknown> {
  const ensureConnectedForDispatch = async (options?: EvalOptions): Promise<void> => {
    try {
      await lifecycle.ensureConnected(options?.deadline);
    } catch (error) {
      if (!isServerDisconnectedError(error)) throw error;
      await recoverTransport(options?.deadline, options?.timeout);
      await lifecycle.ensureConnected(options?.deadline);
    }
  };

  const rawEvaluateOnce = async (
    expression: string,
    options?: EvalOptions,
  ): Promise<unknown> => {
    await ensureConnectedForDispatch(options);
    const timeout = boundedRequestTimeout(options);
    return evaluateAppScript(cdp, expression, { ...options, timeout });
  };

  const rawEvaluate = async (
    expression: string,
    options?: EvalOptions,
  ): Promise<unknown> => {
    try {
      return await rawEvaluateOnce(expression, options);
    } catch (error) {
      if (!isDefinitivePreDispatchFailure(error)) throw error;
      // The Bridge rejected before writing Runtime.evaluate, so reconnecting
      // and issuing this one request cannot replay caller code.
      await recoverTransport(options?.deadline, options?.timeout);
      return rawEvaluateOnce(expression, options);
    }
  };

  const evaluateScript = async (
    expression: string,
    options?: {
      timeout?: number;
      deadline?: number;
      objectGroup?: string;
      generation?: number;
      retryMailboxSetup?: (
        options: { timeout?: number; deadline: number },
      ) => Promise<number | undefined>;
    },
  ): Promise<AppEvaluationCompletion> => {
    let sourceGeneration = options?.generation;
    const evaluateOnce = async (): Promise<AppEvaluationCompletion> => {
      await ensureConnectedForDispatch(options);
      if (
        sourceGeneration !== undefined &&
        lifecycle.getGeneration &&
        sourceGeneration !== lifecycle.getGeneration()
      ) {
        throw new Error('App evaluation context changed before source dispatch');
      }
      const timeout = boundedRequestTimeout(options);
      return evaluateAppScriptCompletion(cdp, expression, {
        timeout,
        objectGroup: options?.objectGroup,
        observePromiseRejection: true,
      });
    };
    try {
      return await evaluateOnce();
    } catch (error) {
      if (!isDefinitivePreDispatchFailure(error)) throw error;
      await recoverTransport(options?.deadline, options?.timeout);
      if (options?.retryMailboxSetup) {
        if (options.deadline === undefined) {
          throw new Error('App evaluation retry requires a deadline');
        }
        sourceGeneration = await options.retryMailboxSetup({
          timeout: options.timeout,
          deadline: options.deadline,
        });
      }
      return evaluateOnce();
    }
  };

  const setupMailbox = async (
    expression: string,
    options: { timeout?: number; deadline: number },
  ): Promise<number | undefined> => {
    const setupOnce = async (): Promise<number | undefined> => {
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

    try {
      return await setupOnce();
    } catch (error) {
      if (!isTransportError(error)) throw error;
      // Mailbox setup happens before the caller source is dispatched. A lost
      // setup response can therefore be retried safely after one bounded
      // reconnect, even when the first setup may already have installed the
      // mailbox in the old runtime.
      await recoverTransport(options.deadline, options.timeout);
      if (Date.now() >= options.deadline) {
        throw timeoutError(options.timeout ?? 10_000);
      }
      return setupOnce();
    }
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
        throw new AppEvaluationError(
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
          deadline: options.deadline,
        },
      );
    }

    // Runtime.evaluate is one-shot for all scripts. A transport failure after
    // dispatch is ambiguous, so retrying here could replay a mutation. The
    // awaitPromise:false option only changes completion handling.
    return rawEvaluate(expression, options);
  };
}
