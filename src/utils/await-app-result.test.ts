import { describe, expect, test } from 'bun:test';
import vm from 'node:vm';
import type { PluginContext } from '../plugin.js';
import { awaitAppResult } from './await-app-result.js';

function hermesHarness() {
  // A VM context gives eval its own global object, so global var/function
  // declarations behave like Runtime.evaluate across separate calls.
  const runtime = vm.createContext({ setTimeout, clearTimeout });
  const evaluate: PluginContext['evalInApp'] = async (expression) => {
    const result = new vm.Script(expression).runInContext(runtime);
    // Simulate CDP returnByValue ignoring awaitPromise, not JS-level awaiting.
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
  };
  return { runtime, evaluate };
}

function userRuntimeKeys(runtime: vm.Context): string[] {
  return Object.getOwnPropertyNames(runtime).filter(
    (name) => name !== 'setTimeout' && name !== 'clearTimeout',
  );
}

describe('async app read results', () => {
  test('awaits a promise when CDP serializes the promise object', async () => {
    const { runtime, evaluate } = hermesHarness();
    expect(await evaluate('Promise.resolve(42)', { awaitPromise: true })).toEqual(
      {},
    );
    expect(await awaitAppResult(
      evaluate,
      'new Promise(resolve => setTimeout(() => resolve({ found: true }), 10))',
    )).toEqual({ found: true });
    expect(userRuntimeKeys(runtime)).toEqual([]);
  });

  test('propagates rejected and synchronously thrown errors and cleans up', async () => {
    const { runtime, evaluate } = hermesHarness();
    await expect(awaitAppResult(
      evaluate,
      'Promise.reject(new Error("measurement failed"))',
    )).rejects.toThrow('measurement failed');
    await expect(awaitAppResult(
      evaluate,
      '(() => { throw new Error("sync failure"); })()',
    )).rejects.toThrow('sync failure');
    expect(userRuntimeKeys(runtime)).toEqual([]);
  });

  test('bounds pending reads and leaves expiry to the app after host deadline', async () => {
    const { runtime, evaluate } = hermesHarness();
    await expect(awaitAppResult(
      evaluate,
      'new Promise(() => {})',
      30,
    )).rejects.toThrow('timed out');
    expect(userRuntimeKeys(runtime)).toHaveLength(1);
    expect(userRuntimeKeys(runtime)[0]).toStartWith('__METRO_MCP_ASYNC_');
  });

  test('isolates concurrent reads and preserves undefined and null', async () => {
    const { runtime, evaluate } = hermesHarness();
    expect(await Promise.all([
      awaitAppResult(evaluate, 'Promise.resolve(undefined)'),
      awaitAppResult(evaluate, 'Promise.resolve(null)'),
      awaitAppResult(evaluate, 'Promise.resolve(42)'),
    ])).toEqual([undefined, null, 42]);
    expect(userRuntimeKeys(runtime)).toEqual([]);
  });

  test('preserves script completion values and executes the source once', async () => {
    const { runtime, evaluate } = hermesHarness();
    expect(await awaitAppResult(
      evaluate,
      `globalThis.evaluationCount = (globalThis.evaluationCount || 0) + 1;
       Promise.resolve({ count: globalThis.evaluationCount, value: 7 });`,
    )).toEqual({ count: 1, value: 7 });
    expect(runtime).toMatchObject({ evaluationCount: 1 });
    expect(userRuntimeKeys(runtime)).toEqual(['evaluationCount']);
  });

  test('can reconnect mailbox reads without replaying the source', async () => {
    const { runtime, evaluate } = hermesHarness();
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
    await expect(awaitAppResult(
      evaluate,
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
    const { runtime, evaluate } = hermesHarness();
    await expect(awaitAppResult(
      evaluate,
      'var persistedValue = 41; Promise.resolve(persistedValue);',
    )).resolves.toBe(41);
    await expect(awaitAppResult(
      evaluate,
      'Promise.resolve(persistedValue + 1);',
    )).resolves.toBe(42);
    expect(runtime).toHaveProperty('persistedValue', 41);
  });
});
