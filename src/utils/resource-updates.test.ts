import { expect, test } from 'bun:test';
import { createResourceUpdateScheduler } from './resource-updates.js';

test('coalesces resource updates per uri and subscribed target', () => {
  const sent: string[] = [];
  const subscribed = new Set(['metro://logs']);
  const scheduler = createResourceUpdateScheduler({
    delayMs: 10_000,
    getTargets: () => [
      {
        id: 'session-1',
        isSubscribed: (uri) => subscribed.has(uri),
        sendResourceUpdated: async (uri) => {
          sent.push(uri);
        },
      },
    ],
  });

  scheduler.notify('metro://logs');
  scheduler.notify('metro://logs');
  scheduler.notify('metro://logs');

  expect(sent).toEqual([]);
  scheduler.flush('metro://logs');
  expect(sent).toEqual(['metro://logs']);
  scheduler.close();
});

test('skips updates when no target is subscribed', () => {
  const sent: string[] = [];
  const scheduler = createResourceUpdateScheduler({
    delayMs: 10_000,
    getTargets: () => [
      {
        id: 'session-1',
        isSubscribed: () => false,
        sendResourceUpdated: async (uri) => {
          sent.push(uri);
        },
      },
    ],
  });

  scheduler.notify('metro://logs');
  scheduler.flush('metro://logs');

  expect(sent).toEqual([]);
  scheduler.close();
});
