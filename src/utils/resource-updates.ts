interface ResourceUpdateTarget {
  id: string;
  isSubscribed(uri: string): boolean;
  sendResourceUpdated(uri: string): Promise<void>;
}

interface PendingUpdate {
  targetIds: Set<string>;
  timer: ReturnType<typeof setTimeout>;
}

interface ResourceUpdateSchedulerOptions {
  delayMs: number;
  getTargets(): ResourceUpdateTarget[];
}

export interface ResourceUpdateScheduler {
  notify(uri: string): void;
  removeTarget(targetId: string): void;
  close(): void;
  flush(uri: string): void;
}

export function createResourceUpdateScheduler({
  delayMs,
  getTargets,
}: ResourceUpdateSchedulerOptions): ResourceUpdateScheduler {
  const pendingByUri = new Map<string, PendingUpdate>();

  function flush(uri: string): void {
    const pending = pendingByUri.get(uri);
    if (!pending) return;
    pendingByUri.delete(uri);

    const targets = new Map(getTargets().map((target) => [target.id, target]));
    for (const targetId of pending.targetIds) {
      const target = targets.get(targetId);
      if (target?.isSubscribed(uri)) {
        target.sendResourceUpdated(uri).catch(() => {});
      }
    }
  }

  return {
    notify(uri: string): void {
      const subscribed = getTargets().filter((target) => target.isSubscribed(uri));
      if (subscribed.length === 0) return;

      let pending = pendingByUri.get(uri);
      if (!pending) {
        pending = {
          targetIds: new Set<string>(),
          timer: setTimeout(() => flush(uri), delayMs),
        };
        pendingByUri.set(uri, pending);
      }

      for (const target of subscribed) {
        pending.targetIds.add(target.id);
      }
    },

    removeTarget(targetId: string): void {
      for (const [uri, pending] of pendingByUri) {
        pending.targetIds.delete(targetId);
        if (pending.targetIds.size === 0) {
          clearTimeout(pending.timer);
          pendingByUri.delete(uri);
        }
      }
    },

    close(): void {
      for (const pending of pendingByUri.values()) {
        clearTimeout(pending.timer);
      }
      pendingByUri.clear();
    },

    flush,
  };
}
