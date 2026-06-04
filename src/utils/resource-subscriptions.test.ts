import { expect, test } from 'bun:test';
import { ResourceSubscriptionManager } from './resource-subscriptions.js';

test('subscription hooks fire once per session subscription state change', () => {
  const manager = new ResourceSubscriptionManager();
  const session = { subscribedResources: new Set<string>() };
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];

  manager.register('metro://logs', {
    onSubscribe: (uri) => subscribed.push(uri),
    onUnsubscribe: (uri) => unsubscribed.push(uri),
  });

  manager.subscribe(session, 'metro://logs');
  manager.subscribe(session, 'metro://logs');
  manager.unsubscribe(session, 'metro://logs');
  manager.unsubscribe(session, 'metro://logs');

  expect(subscribed).toEqual(['metro://logs']);
  expect(unsubscribed).toEqual(['metro://logs']);
});
