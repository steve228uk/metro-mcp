import type { ResourceConfig } from '../plugin.js';

export interface ResourceSubscriptionSession {
  subscribedResources: Set<string>;
}

type ResourceHooks = Pick<ResourceConfig, 'onSubscribe' | 'onUnsubscribe'>;

export class ResourceSubscriptionManager {
  private hooks = new Map<string, ResourceHooks>();

  register(uri: string, hooks: ResourceHooks): void {
    this.hooks.set(uri, hooks);
  }

  clearHooks(): void {
    this.hooks.clear();
  }

  subscribe(session: ResourceSubscriptionSession, uri: string): void {
    const wasSubscribed = session.subscribedResources.has(uri);
    session.subscribedResources.add(uri);
    if (!wasSubscribed) {
      this.hooks.get(uri)?.onSubscribe?.(uri);
    }
  }

  unsubscribe(session: ResourceSubscriptionSession, uri: string): void {
    const wasSubscribed = session.subscribedResources.delete(uri);
    if (wasSubscribed) {
      this.hooks.get(uri)?.onUnsubscribe?.(uri);
    }
  }
}
