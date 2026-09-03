import { describe, expect, test } from 'bun:test';
import vm from 'node:vm';
import type { PluginContext } from '../plugin.js';
import {
  awaitAppResult,
  type AppEvaluationCompletion,
  type AwaitAppResultOptions,
} from './await-app-result.js';

function hermesHarness() {
  // A VM context gives eval its own global object, so global var/function
  // declarations behave like Runtime.evaluate across separate calls.
  const runtime = vm.createContext({ setTimeout, clearTimeout });
  const evaluate: PluginContext['evalInApp'] = async (expression) => {
    const result = new vm.Script(expression).runInContext(runtime);
    // Simulate CDP returnByValue ignoring awaitPromise, not JS-level awaiting.
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
  };
  const remoteObjects = new Map<string, unknown>();
  const releasedGroups: string[] = [];
  let nextObjectId = 0;
  const evaluateScript = async (expression: string): Promise<AppEvaluationCompletion> => {
    const result = new vm.Script(expression).runInContext(runtime);
    if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
      const objectId = `remote-${++nextObjectId}`;
      remoteObjects.set(objectId, result);
      return { objectId };
    }
    return { value: result };
  };
  const settleRemote = async (objectId: string, mailboxName: string) => {
    const state = (runtime as Record<string, unknown>)[mailboxName] as Record<string, unknown>;
    const result = remoteObjects.get(objectId);
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      void Promise.resolve(result).then(
        (value) => {
          if (state) { state.value = value; state.status = 'fulfilled'; }
        },
        (error) => {
          if (state) {
            state.error = String(error && (error as Error).message || error);
            state.status = 'rejected';
          }
        },
      );
    } else if (state) {
      state.value = result;
      state.status = 'fulfilled';
    }
    return true;
  };
  const awaitResult = (
    expression: string,
    timeout?: number,
    options?: AwaitAppResultOptions,
  ) => awaitAppResult(
    evaluate,
    expression,
    timeout,
    {
      ...options,
      evaluateScript,
      settleRemote,
      releaseObjectGroup: async (objectGroup) => { releasedGroups.push(objectGroup); },
    },
  );
  return { runtime, evaluate, awaitResult, releasedGroups };
}

function userRuntimeKeys(runtime: vm.Context): string[] {
  return Object.getOwnPropertyNames(runtime).filter(
    (name) => name !== 'setTimeout' && name !== 'clearTimeout',
  );
}

describe('async app read results', () => {
  test('awaits a promise when CDP serializes the promise object', async () => {
    const { runtime, evaluate, awaitResult } = hermesHarness();
    expect(await evaluate('Promise.resolve(42)', { awaitPromise: true })).toEqual(
      {},
    );
    expect(await awaitResult(
      'new Promise(resolve => setTimeout(() => resolve({ found: true }), 10))',
    )).toEqual({ found: true });
    expect(userRuntimeKeys(runtime)).toEqual([]);
  });

  test('propagates rejected and synchronously thrown errors and cleans up', async () => {
    const { runtime, awaitResult } = hermesHarness();
    await expect(awaitResult(
      'Promise.reject(new Error("measurement failed"))',
    )).rejects.toThrow('measurement failed');
    await expect(awaitResult(
      '(() => { throw new Error("sync failure"); })()',
    )).rejects.toThrow('sync failure');
    expect(userRuntimeKeys(runtime)).toEqual([]);
  });

  test('bounds pending reads and leaves expiry to the app after host deadline', async () => {
    const { runtime, awaitResult, releasedGroups } = hermesHarness();
    await expect(awaitResult(
      'new Promise(() => {})',
      30,
    )).rejects.toThrow('timed out');
    expect(userRuntimeKeys(runtime)).toHaveLength(1);
    expect(userRuntimeKeys(runtime)[0]).toStartWith('__METRO_MCP_ASYNC_');
    expect(releasedGroups).toHaveLength(0); // Runtime.releaseObject handled the Promise
  });

  test('isolates concurrent reads and preserves undefined and null', async () => {
    const { runtime, awaitResult } = hermesHarness();
    expect(await Promise.all([
      awaitResult('Promise.resolve(undefined)'),
      awaitResult('Promise.resolve(null)'),
      awaitResult('Promise.resolve(42)'),
    ])).toEqual([undefined, null, 42]);
    expect(userRuntimeKeys(runtime)).toEqual([]);
  });

  test('preserves script completion values and executes the source once', async () => {
    const { runtime, awaitResult, releasedGroups } = hermesHarness();
    expect(await awaitResult(
      `globalThis.evaluationCount = (globalThis.evaluationCount || 0) + 1;
       Promise.resolve({ count: globalThis.evaluationCount, value: 7 });`,
    )).toEqual({ count: 1, value: 7 });
    expect(runtime).toMatchObject({ evaluationCount: 1 });
    expect(userRuntimeKeys(runtime)).toEqual(['evaluationCount']);
    expect(releasedGroups).toHaveLength(0);
  });

  test('assimilates nested thenables and ignores repeated resolution', async () => {
    const { awaitResult } = hermesHarness();
    await expect(awaitResult(`({
      then: function(resolve) {
        resolve({ then: function(resolveNested) {
          resolveNested('nested value');
        }});
        resolve('second value');
      }
    })`)).resolves.toBe('nested value');
  });

  test('can reconnect mailbox reads without replaying the source', async () => {
    const { runtime, awaitResult, evaluate } = hermesHarness();
    let pollReads = 0;
    let transportRecovered = false;
    const pollEvaluate: PluginContext['evalInApp'] = async (expression, options) => {
      pollReads += 1;
      if (pollReads === 1) {
        // A server-side poll wrapper reconnects, then retries this read.
        transportRecovered = true;
      }
      return evaluate(expression, options);
    };

    // The helper leaves retry policy to its polling evaluator. This models a
    // server reconnect that retries only a mailbox read after a lost transport.
    await expect(awaitResult(
      `globalThis.evaluationCount = (globalThis.evaluationCount || 0) + 1;
       new Promise(resolve => setTimeout(() => resolve(globalThis.evaluationCount), 10));`,
      1000,
      { pollEvaluate },
    )).resolves.toBe(1);
    expect(runtime).toMatchObject({ evaluationCount: 1 });
    expect(pollReads).toBeGreaterThan(1);
    expect(transportRecovered).toBe(true);
  });

  test('keeps global script declarations across awaited evaluations', async () => {
    const { runtime, awaitResult } = hermesHarness();
    await expect(awaitResult(
      'let persistedValue = 41; class PersistedClass {} Promise.resolve(persistedValue);',
    )).resolves.toBe(41);
    await expect(awaitResult(
      'Promise.resolve(persistedValue + (typeof PersistedClass === "function" ? 1 : 0));',
    )).resolves.toBe(42);
  });
});
