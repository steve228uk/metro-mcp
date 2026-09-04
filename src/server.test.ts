import { describe, expect, test } from 'bun:test';
import { createAppEvaluator } from './utils/evaluate-app.js';
import {
  cancelScheduledReconnect,
  createReconnectController,
  waitForConnectionUntil,
} from './server.js';

describe('server connection deadlines', () => {
  test('bounds an initial disconnected awaitPromise wait before source dispatch', async () => {
    const methods: string[] = [];
    let waits = 0;
    const evaluate = createAppEvaluator({
      send: async (method) => {
        methods.push(method);
        return { result: { value: undefined } };
      },
    }, {
      ensureConnected: async (deadline) => {
        const connected = await waitForConnectionUntil(
          () => waits++ === 0
            ? Promise.resolve(false)
            : new Promise<boolean>(() => {}),
          deadline,
        );
        if (!connected) {
          await waitForConnectionUntil(
            () => {
              waits += 1;
              return new Promise<boolean>(() => {});
            },
            deadline,
          );
        }
      },
      waitForReconnect: async () => {},
      reconnect: async () => {},
      isReconnecting: () => false,
    });

    const started = Date.now();
    await expect(evaluate('globalThis.shouldNotRun = true;', {
      awaitPromise: true,
      timeout: 30,
    })).rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(500);
    expect(waits).toBe(2);
    expect(methods.filter((method) => method === 'Runtime.evaluate')).toHaveLength(0);
  });
});

describe('scheduled reconnect takeover', () => {
  test('preempts a long backoff for a tool request and is idempotent', () => {
    let scheduledCallback: (() => void) | undefined;
    let scheduledDelay = 0;
    let scheduledCancelled = false;
    let attempts = 0;
    const timers = {
      clearTimeout() {
        scheduledCancelled = true;
      },
    };
    const state = { timer: null as ReturnType<typeof setTimeout> | null };
    const timer = { callback: () => { attempts += 1; }, delay: 30_000 };
    scheduledCallback = timer.callback;
    scheduledDelay = timer.delay;
    state.timer = timer as unknown as ReturnType<typeof setTimeout>;

    expect(cancelScheduledReconnect(state, timers)).toBe(true);
    expect(state.timer).toBeNull();
    expect(scheduledCancelled).toBe(true);

    // A concurrent tool request observes that the first request already
    // claimed the scheduled retry and must not cancel or dispatch another one.
    expect(cancelScheduledReconnect(state, timers)).toBe(false);
    expect(scheduledDelay).toBe(30_000);

    // Model a direct lifecycle.reconnect that starts immediately. The timer's
    // callback is still present in the harness, but cancellation prevents it
    // from starting a duplicate attempt after the on-demand one succeeds.
    attempts += 1;
    if (!scheduledCancelled) scheduledCallback?.();
    expect(attempts).toBe(1);
  });

  test('retains one background retry when the tool deadline expires first', async () => {
    type FakeTimer = {
      callback: () => void;
      delay: number;
      cancelled: boolean;
    };
    const timers: FakeTimer[] = [];
    const timerApi = {
      setTimeout(callback: () => void, delay: number) {
        const timer = { callback, delay, cancelled: false };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout(handle: ReturnType<typeof setTimeout>) {
        (handle as unknown as FakeTimer).cancelled = true;
      },
    };
    let resolveAttempt: ((connected: boolean) => void) | undefined;
    let attempts = 0;
    const controller = createReconnectController({
      connect: () => {
        attempts += 1;
        return new Promise<boolean>((resolve) => {
          resolveAttempt = resolve;
        });
      },
      isClosed: () => false,
      timers: timerApi,
      delays: [30_000],
      maxBurstAttempts: 1,
      backgroundDelay: 30_000,
    });

    controller.schedule();
    const queued = timers[0]!;
    expect(queued.delay).toBe(30_000);
    const takeover = controller.connectNow();
    expect(queued.cancelled).toBe(true);
    // The caller can time out while the runtime-owned attempt continues.
    const callerDeadline = Promise.race([
      takeover,
      Promise.resolve().then(() => {
        throw new Error('App evaluation timed out');
      }),
    ]);
    await expect(callerDeadline).rejects.toThrow('timed out');
    resolveAttempt?.(false);
    await expect(takeover).resolves.toBe(false);

    expect(attempts).toBe(1);
    expect(timers.filter((timer) => !timer.cancelled)).toHaveLength(1);
    expect(timers.find((timer) => !timer.cancelled)?.delay).toBe(30_000);
  });

  test('shares a direct reconnect and schedules only one retry after failure', async () => {
    type FakeTimer = { callback: () => void; delay: number; cancelled: boolean };
    const timers: FakeTimer[] = [];
    const timerApi = {
      setTimeout(callback: () => void, delay: number) {
        const timer = { callback, delay, cancelled: false };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout(handle: ReturnType<typeof setTimeout>) {
        (handle as unknown as FakeTimer).cancelled = true;
      },
    };
    let resolveAttempt: ((connected: boolean) => void) | undefined;
    let attempts = 0;
    const controller = createReconnectController({
      connect: () => {
        attempts += 1;
        return new Promise<boolean>((resolve) => {
          resolveAttempt = resolve;
        });
      },
      isClosed: () => false,
      timers: timerApi,
      delays: [30_000],
      maxBurstAttempts: 1,
      backgroundDelay: 30_000,
    });

    controller.schedule();
    const first = controller.connectNow();
    const second = controller.connectNow();
    expect(first).toBe(second);
    await Promise.resolve();
    resolveAttempt?.(false);
    await expect(first).resolves.toBe(false);
    expect(attempts).toBe(1);
    expect(timers.filter((timer) => !timer.cancelled)).toHaveLength(1);
  });

  test('keeps escalated backoff when a reconnect flaps before stability', async () => {
    type FakeTimer = {
      callback: () => void;
      delay: number;
      cancelled: boolean;
    };
    const timers: FakeTimer[] = [];
    const timerApi = {
      setTimeout(callback: () => void, delay: number) {
        const timer = { callback, delay, cancelled: false };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout(handle: ReturnType<typeof setTimeout>) {
        (handle as unknown as FakeTimer).cancelled = true;
      },
    };
    const outcomes = [false, false, true];
    const controller = createReconnectController({
      connect: async () => outcomes.shift() ?? false,
      isClosed: () => false,
      timers: timerApi,
      delays: [500, 1000, 2000, 4000],
      maxBurstAttempts: 4,
      backgroundDelay: 30_000,
    });

    const fireNext = async (): Promise<void> => {
      const timer = timers.find((candidate) => !candidate.cancelled);
      expect(timer).toBeDefined();
      timer!.cancelled = true;
      timer!.callback();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };

    controller.schedule();
    expect(timers[0]?.delay).toBe(500);
    await fireNext();
    expect(timers.filter((timer) => !timer.cancelled).at(-1)?.delay).toBe(1000);
    await fireNext();
    expect(timers.filter((timer) => !timer.cancelled).at(-1)?.delay).toBe(2000);
    await fireNext();

    // The target reconnected, then flapped before the 5-second stability
    // timer could reset the backoff. The next disconnect remains escalated.
    controller.schedule();
    expect(timers.filter((timer) => !timer.cancelled).at(-1)?.delay).toBe(4000);
  });

  test('does not reset escalated backoff for repeated foreground reconnects', async () => {
    type FakeTimer = { callback: () => void; delay: number; cancelled: boolean };
    const timers: FakeTimer[] = [];
    const timerApi = {
      setTimeout(callback: () => void, delay: number) {
        const timer = { callback, delay, cancelled: false };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout(handle: ReturnType<typeof setTimeout>) {
        (handle as unknown as FakeTimer).cancelled = true;
      },
    };
    let attempts = 0;
    const controller = createReconnectController({
      connect: async () => {
        attempts += 1;
        return false;
      },
      isClosed: () => false,
      timers: timerApi,
      delays: [500],
      maxBurstAttempts: 1,
      backgroundDelay: 30_000,
    });

    controller.schedule();
    const firstTimer = timers[0]!;
    firstTimer.cancelled = true;
    firstTimer.callback();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(attempts).toBe(1);
    expect(timers.filter((timer) => !timer.cancelled).at(-1)?.delay).toBe(30_000);

    await expect(controller.connectNow()).resolves.toBe(false);
    await expect(controller.connectNow()).resolves.toBe(false);
    expect(attempts).toBe(3);
    expect(timers.filter((timer) => !timer.cancelled).at(-1)?.delay).toBe(30_000);
  });
});
