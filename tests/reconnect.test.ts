import { describe, expect, test } from 'bun:test';
import {
  waitForReconnect,
  type ReconnectWaitTimers,
} from '../src/server.js';

function timerHarness() {
  let intervalCallback: (() => void) | undefined;
  let timeoutCallback: (() => void) | undefined;
  let intervalActive = false;
  let timeoutActive = false;
  let intervalCleared = 0;
  let timeoutCleared = 0;

  const timers: ReconnectWaitTimers = {
    setInterval(callback) {
      intervalCallback = callback;
      intervalActive = true;
      return 1 as ReturnType<typeof setInterval>;
    },
    clearInterval() {
      intervalActive = false;
      intervalCleared += 1;
    },
    setTimeout(callback) {
      timeoutCallback = callback;
      timeoutActive = true;
      return 1 as ReturnType<typeof setTimeout>;
    },
    clearTimeout() {
      timeoutActive = false;
      timeoutCleared += 1;
    },
  };

  return {
    timers,
    fireInterval() {
      if (intervalActive) intervalCallback?.();
    },
    fireTimeout() {
      if (timeoutActive) timeoutCallback?.();
    },
    state() {
      return { intervalActive, timeoutActive, intervalCleared, timeoutCleared };
    },
  };
}

describe('reconnect waits', () => {
  test('clears caller polling when its deadline expires', async () => {
    const harness = timerHarness();
    const wait = waitForReconnect(
      () => true,
      Date.now() + 1000,
      harness.timers,
    );

    expect(harness.state()).toMatchObject({
      intervalActive: true,
      timeoutActive: true,
    });
    harness.fireTimeout();

    await expect(wait).rejects.toThrow('App evaluation timed out');
    expect(harness.state()).toMatchObject({
      intervalActive: false,
      timeoutActive: false,
      intervalCleared: 1,
      timeoutCleared: 1,
    });
    harness.fireInterval();
    expect(harness.state().intervalCleared).toBe(1);
  });
});
