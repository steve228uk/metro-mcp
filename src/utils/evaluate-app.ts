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
  start?: number | null;
  end?: number | null;
  body?: unknown;
  expression?: ExpressionLike;
  [key: string]: unknown;
};
type ExpressionLike = { start: number | null; end: number | null };
type CompletionPath = {
  expressions: ExpressionLike[];
  clearRanges: Array<{ start: number; end: number; kind: 'break' | 'continue'; label: string | null }>;
  empty: boolean;
  undefined: boolean;
  normal: boolean;
};
type ExitPath = CompletionPath & { label: string | null; inherit: boolean };
type Completion = CompletionPath & {
  breaks: ExitPath[];
  continues: ExitPath[];
};

const emptyCompletion = (): Completion => ({
  expressions: [],
  clearRanges: [],
  empty: true,
  undefined: false,
  normal: true,
  breaks: [],
  continues: [],
});

const abruptCompletion = (): Completion => ({
  expressions: [],
  clearRanges: [],
  empty: false,
  undefined: false,
  normal: false,
  breaks: [],
  continues: [],
});

const undefinedCompletion = (): Completion => ({
  expressions: [],
  clearRanges: [],
  empty: false,
  undefined: true,
  normal: true,
  breaks: [],
  continues: [],
});

function normalizeControlCompletion(completion: Completion): Completion {
  return {
    ...completion,
    empty: false,
    undefined: completion.undefined || completion.empty,
  };
}

function asFinallyCompletion(completion: Completion): Completion {
  // A normal finalizer uses UpdateEmpty. Control statements such as an
  // untaken if/loop therefore preserve the guarded completion in a finally
  // clause, even though they produce undefined at script level.
  return {
    ...completion,
    empty: completion.empty || completion.undefined,
    undefined: false,
  };
}

function applyFinallyCompletion(
  guarded: Completion,
  _finalizer: Completion,
): CompletionPath {
  // A normal finally completion is always discarded by TryStatement. The
  // guarded completion is returned whether the finalizer's own completion is
  // empty, undefined, or a value; only an abrupt finalizer replaces it.
  return guarded;
}

function markNonInheritingExits(completion: Completion): Completion {
  return {
    ...completion,
    breaks: completion.breaks.map((path) => ({ ...path, inherit: false })),
    continues: completion.continues.map((path) => ({ ...path, inherit: false })),
  };
}

function completionFromExit(path: ExitPath): CompletionPath {
  return path.inherit ? { ...path, clearRanges: [] } : path;
}

function mergePaths(left: CompletionPath, right: CompletionPath): CompletionPath {
  return {
    expressions: [...left.expressions, ...right.expressions],
    clearRanges: [...left.clearRanges, ...right.clearRanges],
    empty: left.empty || right.empty,
    undefined: left.undefined || right.undefined,
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
    if (path.label === label) normal = mergePaths(normal, completionFromExit(path));
    else remaining.push(path);
  }
  return { ...normal, breaks: remaining, continues: completion.continues };
}

function consumeLoopExits(completion: Completion): Completion {
  let normal: CompletionPath = completion;
  const breaks: ExitPath[] = [];
  const continues: ExitPath[] = [];
  for (const path of completion.breaks) {
    if (path.label === null) normal = mergePaths(normal, completionFromExit(path));
    else breaks.push(path);
  }
  for (const path of completion.continues) {
    if (path.label === null) normal = mergePaths(normal, completionFromExit(path));
    else continues.push(path);
  }
  return { ...normal, breaks, continues };
}

function consumeLabelExits(completion: Completion, label: string): Completion {
  const afterBreaks = consumeBreaks(completion, label);
  let normal: CompletionPath = afterBreaks;
  const continues: ExitPath[] = [];
  for (const path of afterBreaks.continues) {
    if (path.label === label) normal = mergePaths(normal, completionFromExit(path));
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
        clearRanges: [],
        empty: false,
        undefined: false,
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
        : undefinedCompletion();
      return normalizeControlCompletion(markNonInheritingExits(
        mergeCompletions(consequent, alternate),
      ));
    }
    case 'TryStatement': {
      const body = completionForStatement(statement.block as StatementLike);
      const handler = statement.handler
        ? completionForStatement((statement.handler as { body: StatementLike }).body)
        : abruptCompletion();
      const guarded = mergeCompletions(body, handler);
      if (!statement.finalizer) return normalizeControlCompletion(guarded);
      const finalizer = asFinallyCompletion(
        completionForStatement(statement.finalizer as StatementLike),
      );
      if (!finalizer.normal) return finalizer;
      // A normal `finally` completion is UpdateEmpty: its expression value is
      // discarded, while the prior try/catch completion is retained. This is
      // why `try { 1 } finally { 2 }` evaluates to 1 in a script.
      const applied = applyFinallyCompletion(guarded, finalizer);
      return {
        ...applied,
        breaks: [
          ...guarded.breaks,
          ...finalizer.breaks.map((path) => ({ ...path, inherit: false })),
        ],
        continues: [
          ...guarded.continues,
          ...finalizer.continues.map((path) => ({ ...path, inherit: false })),
        ],
      };
    }
    case 'LabeledStatement':
      return consumeLabelExits(
        completionForStatement(statement.body as StatementLike),
        (statement.label as { name: string } | null | undefined)?.name ?? '',
      );
    case 'WithStatement':
      return normalizeControlCompletion(markNonInheritingExits(
        completionForStatement(statement.body as StatementLike),
      ));
    case 'SwitchStatement': {
      const cases = (statement.cases as Array<{ consequent: StatementLike[] }> | undefined) ?? [];
      let completion = undefinedCompletion();
      for (let index = 0; index < cases.length; index += 1) {
        const caseCompletion = completionForStatements(
          cases.slice(index).flatMap((entry) => entry.consequent),
        );
        completion = mergeCompletions(
          completion,
          normalizeControlCompletion(consumeBreaks(caseCompletion)),
        );
      }
      return normalizeControlCompletion(completion);
    }
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
      const body = normalizeControlCompletion(
        completionForStatement(statement.body as StatementLike),
      );
      const loop = consumeLoopExits(body);
      return statement.type === 'DoWhileStatement'
        ? normalizeControlCompletion(loop)
        : normalizeControlCompletion(mergeCompletions(loop, undefinedCompletion()));
    case 'ThrowStatement':
    case 'ReturnStatement':
      return abruptCompletion();
    case 'BreakStatement':
      return {
        ...abruptCompletion(),
        breaks: [{ ...emptyCompletion(), label: (statement.label as { name: string } | null | undefined)?.name ?? null,
          inherit: true,
          clearRanges: [{
            start: statement.start as number,
            end: statement.end as number,
            kind: 'break',
            label: (statement.label as { name: string } | null | undefined)?.name ?? null,
          }] }],
      };
    case 'ContinueStatement':
      return {
        ...abruptCompletion(),
        continues: [{ ...emptyCompletion(), label: (statement.label as { name: string } | null | undefined)?.name ?? null,
          inherit: true,
          clearRanges: [{
            start: statement.start as number,
            end: statement.end as number,
            kind: 'continue',
            label: (statement.label as { name: string } | null | undefined)?.name ?? null,
          }] }],
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
      ...next.breaks.map((path) => path.empty && path.inherit
        ? { ...completion, label: path.label, inherit: path.inherit, clearRanges: [...completion.clearRanges] }
        : path),
    ];
    const continues: ExitPath[] = [
      ...completion.continues,
      ...next.continues.map((path) => path.empty && path.inherit
        ? { ...completion, label: path.label, inherit: path.inherit, clearRanges: [...completion.clearRanges] }
        : path),
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

function promiseObservationExpression(expression: string, completionKey?: string): string {
  let ast;
  try {
    ast = parse(expression, { sourceType: 'script' });
  } catch {
    return expression;
  }
  const completion = completionForStatements(ast.program.body as StatementLike[]);
  if (!completion.normal || completion.expressions.length === 0) return expression;
  const candidates = completion.expressions
    .filter(({ start, end }) => start !== null && end !== null)
    .filter((candidate, index, all) =>
      all.findIndex((other) =>
        other.start === candidate.start && other.end === candidate.end,
      ) === index,
    );
  if (candidates.length === 0) return expression;
  // Awaited evaluation always supplies the already-expiring mailbox key. If
  // this low-level helper is called without one, leave the source untouched
  // rather than creating state that cannot be cleaned up on an exception.
  if (!completionKey) return expression;
  const key = completionKey;
  const keyLiteral = JSON.stringify(key);
  const clearCompletion = `(function(root) {
    var state = root[${keyLiteral}];
    if (state) state.completionValue = void 0;
  })(this)`;
  const capture = (candidate: string): string => `(function(root, value) {
    var state = root[${keyLiteral}];
    if (state) state.completionValue = value;
    return value;
  })(this, (\n    ${candidate}
  ))`;
  let transformed = expression;
  const clearRanges = completion.clearRanges.filter((range, index, all) =>
    all.findIndex((other) =>
      other.start === range.start &&
      other.end === range.end &&
      other.kind === range.kind &&
      other.label === range.label,
    ) === index,
  );
  const replacements = [
    ...candidates.map(({ start, end }) => ({
      start: start as number,
      end: end as number,
      replacement: capture(expression.slice(start as number, end as number)),
    })),
    ...clearRanges.map(({ start, end, kind, label }) => ({
      start,
      end,
      // A plain block keeps an unlabeled break/continue targeted at its
      // original enclosing switch or loop. An artificial loop here would
      // capture that exit and change the caller's control flow.
      replacement: `{ ${clearCompletion}; ${kind}${label ? ` ${label}` : ''}; }`,
    })),
  ].sort((left, right) => right.start - left.start);
  for (const { start, end, replacement } of replacements) {
    transformed = transformed.slice(0, start) + replacement + transformed.slice(end);
  }
  const directives = (ast.program.directives as Array<{
    end?: number | null;
    value?: { value?: unknown };
  }> | undefined) ?? [];
  const directiveEnd = directives.length > 0
    ? directives[directives.length - 1]!.end as number
    : 0;
  const setup = `;\n(function(root) {
    var state = root[${keyLiteral}];
    if (state) state.completionValue = void 0;
  })(this);\n`;
  transformed = transformed.slice(0, directiveEnd) + setup + transformed.slice(directiveEnd);
  const observe = `(function(root) {
    var state = root[${keyLiteral}];
    var value = state ? state.completionValue : void 0;
    try {
      var PromiseCtor = root && root.Promise;
      if (PromiseCtor) PromiseCtor.prototype.then.call(value, function() {}, function() {});
    } catch (_) {}
    if (state) state.completionValue = void 0;
    return value;
  })(this)`;
  return `${transformed}\n;\n${observe}`;
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
  options?: EvalOptions & { observePromiseRejection?: boolean; completionKey?: string },
): Promise<AppEvaluationCompletion> {
  const result = await sendRuntimeEvaluate(cdp, {
    expression: options?.observePromiseRejection
      ? promiseObservationExpression(expression, options.completionKey)
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
  var root = (function() { return this; })();
  var state = root[key];
  if (!state) return false;
  function fulfill(value) {
    if (root[key] !== state) return;
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
    if (root[key] !== state) return;
    state.error = rejectionMessage(error);
    state.status = 'rejected';
  }
  try {
    // Assimilate arbitrary thenables exactly once. Calling this.then
    // directly would accept a second callback or a nested thenable as the
    // final value, unlike JavaScript Promise resolution.
    root.Promise.resolve(this).then(fulfill, reject);
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
  const ensureConnectedForDispatch = async (options?: EvalOptions): Promise<boolean> => {
    try {
      await lifecycle.ensureConnected(options?.deadline);
      return false;
    } catch (error) {
      if (!isServerDisconnectedError(error)) throw error;
      await recoverTransport(options?.deadline, options?.timeout);
      await lifecycle.ensureConnected(options?.deadline);
      return true;
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
      completionKey?: string;
      generation?: number;
      retryMailboxSetup?: (
        options: { timeout?: number; deadline: number },
      ) => Promise<number | undefined>;
    },
  ): Promise<AppEvaluationCompletion> => {
    let sourceGeneration = options?.generation;
    const evaluateOnce = async (): Promise<AppEvaluationCompletion> => {
      const recovered = await ensureConnectedForDispatch(options);
      const generationChanged = sourceGeneration !== undefined &&
        lifecycle.getGeneration &&
        sourceGeneration !== lifecycle.getGeneration();
      if ((recovered || generationChanged) && options?.retryMailboxSetup) {
        if (options.deadline === undefined) {
          throw new Error('App evaluation retry requires a deadline');
        }
        sourceGeneration = await options.retryMailboxSetup({
          timeout: options.timeout,
          deadline: options.deadline,
        });
      }
      if (sourceGeneration !== undefined && lifecycle.getGeneration &&
          sourceGeneration !== lifecycle.getGeneration()) {
        throw new Error('App evaluation context changed before source dispatch');
      }
      const timeout = boundedRequestTimeout(options);
      return evaluateAppScriptCompletion(cdp, expression, {
        timeout,
        objectGroup: options?.objectGroup,
        observePromiseRejection: true,
        completionKey: options?.completionKey,
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
