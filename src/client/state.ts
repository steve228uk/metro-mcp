/**
 * State subscription manager for any state management library.
 * Works with Zustand, Jotai, MobX, or any getter function.
 */

export class StateSubscriptionManager {
  subscriptions = new Map<string, () => unknown>();

  subscribe(name: string, getter: () => unknown): void {
    this.subscriptions.set(name, getter);
  }

  unsubscribe(name: string): void {
    this.subscriptions.delete(name);
  }

  getState(name: string): unknown {
    const getter = this.subscriptions.get(name);
    if (!getter) return undefined;
    try {
      return getter();
    } catch {
      return undefined;
    }
  }

  getAllStates(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [name, getter] of this.subscriptions) {
      try {
        result[name] = getter();
      } catch {
        result[name] = '[error]';
      }
    }
    return result;
  }

  listSubscriptions(): string[] {
    return Array.from(this.subscriptions.keys());
  }
}
