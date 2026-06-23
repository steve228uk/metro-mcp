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

test('unsubscribeAll clears subscribed resources and fires hooks once per uri', () => {
  const manager = new ResourceSubscriptionManager();
  const session = { subscribedResources: new Set<string>() };
  const unsubscribed: string[] = [];

  manager.register('metro://logs', {
    onUnsubscribe: (uri) => unsubscribed.push(uri),
  });
  manager.register('metro://network', {
    onUnsubscribe: (uri) => unsubscribed.push(uri),
  });

  manager.subscribe(session, 'metro://logs');
  manager.subscribe(session, 'metro://network');

  manager.unsubscribeAll(session);
  manager.unsubscribeAll(session);

  expect(session.subscribedResources.size).toBe(0);
  expect(unsubscribed).toEqual(['metro://logs', 'metro://network']);
});
