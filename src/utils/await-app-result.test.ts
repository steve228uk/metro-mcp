import { describe, expect, test } from 'bun:test';
import type { PluginContext } from '../plugin.js';
import { awaitAppResult } from './await-app-result.js';

function hermesHarness() {
  const runtime = {};
  const evaluate: PluginContext['evalInApp'] = async (expression) => {
    const result = new Function('globalThis', `return ${expression};`)(runtime);
    // Simulate CDP returnByValue ignoring awaitPromise, not JS-level awaiting.
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
  };
  return { runtime, evaluate };
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
    expect(Object.getOwnPropertyNames(runtime)).toEqual([]);
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
    expect(Object.getOwnPropertyNames(runtime)).toEqual([]);
  });

  test('bounds pending reads and deletes their mailbox', async () => {
    const { runtime, evaluate } = hermesHarness();
    await expect(awaitAppResult(
      evaluate,
      'new Promise(() => {})',
      30,
    )).rejects.toThrow('timed out');
    expect(Object.getOwnPropertyNames(runtime)).toEqual([]);
  });

  test('isolates concurrent reads and preserves undefined and null', async () => {
    const { runtime, evaluate } = hermesHarness();
    expect(await Promise.all([
      awaitAppResult(evaluate, 'Promise.resolve(undefined)'),
      awaitAppResult(evaluate, 'Promise.resolve(null)'),
      awaitAppResult(evaluate, 'Promise.resolve(42)'),
    ])).toEqual([undefined, null, 42]);
    expect(Object.getOwnPropertyNames(runtime)).toEqual([]);
  });
});
