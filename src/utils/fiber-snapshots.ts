import { randomUUID } from 'node:crypto';
import type { FiberTraversalMetadata } from './fiber.js';

export interface FlatFiberNode {
  id: string;
  parentId: string | null;
  depth: number;
  name: string;
  props?: Record<string, unknown>;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityRole?: string;
}

interface FiberSnapshot {
  id: string;
  nodes: FlatFiberNode[];
  traversal: FiberTraversalMetadata;
  createdAt: number;
}

export interface FiberSnapshotPage {
  snapshotId: string | null;
  nodes: FlatFiberNode[];
  traversal: FiberTraversalMetadata;
  nextCursor?: string;
  error?: string;
}

const expiredTraversal: FiberTraversalMetadata = {
  scope: 'all-scenes',
  complete: false,
  depthReached: 0,
  scannedNodes: 0,
  truncationReason: 'cursor-expired',
};

export class FiberSnapshotStore {
  readonly #snapshots = new Map<string, FiberSnapshot>();
  readonly #cursors = new Map<
    string,
    { snapshotId: string; offset: number }
  >();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 60_000,
    private readonly maxSnapshots = 8,
  ) {}

  create(
    nodes: FlatFiberNode[],
    traversal: FiberTraversalMetadata,
    pageSize: number,
  ): FiberSnapshotPage {
    this.#cleanup();
    while (this.#snapshots.size >= this.maxSnapshots) {
      const oldest = this.#snapshots.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#deleteSnapshot(oldest);
    }

    const snapshot: FiberSnapshot = {
      id: randomUUID(),
      nodes,
      traversal,
      createdAt: this.now(),
    };
    this.#snapshots.set(snapshot.id, snapshot);
    return this.#page(snapshot, 0, pageSize);
  }

  read(cursor: string, pageSize: number): FiberSnapshotPage {
    this.#cleanup();
    const decoded = this.#cursors.get(cursor);
    if (!decoded) return this.#expiredPage();
    const snapshot = this.#snapshots.get(decoded.snapshotId);
    if (!snapshot) return this.#expiredPage(decoded.snapshotId);
    if (decoded.offset < 0 || decoded.offset >= snapshot.nodes.length) {
      return this.#expiredPage(decoded.snapshotId);
    }
    return this.#page(snapshot, decoded.offset, pageSize);
  }

  #page(
    snapshot: FiberSnapshot,
    offset: number,
    pageSize: number,
  ): FiberSnapshotPage {
    const size = Math.min(250, Math.max(1, Math.floor(pageSize)));
    const nextOffset = offset + size;
    return {
      snapshotId: snapshot.id,
      nodes: snapshot.nodes.slice(offset, nextOffset),
      traversal: snapshot.traversal,
      ...(nextOffset < snapshot.nodes.length
        ? { nextCursor: this.#createCursor(snapshot.id, nextOffset) }
        : {}),
    };
  }

  #cleanup(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, snapshot] of this.#snapshots) {
      if (snapshot.createdAt <= cutoff) this.#deleteSnapshot(id);
    }
  }

  #createCursor(snapshotId: string, offset: number): string {
    const cursor = randomUUID();
    this.#cursors.set(cursor, { snapshotId, offset });
    return cursor;
  }

  #deleteSnapshot(snapshotId: string): void {
    this.#snapshots.delete(snapshotId);
    for (const [cursor, value] of this.#cursors) {
      if (value.snapshotId === snapshotId) this.#cursors.delete(cursor);
    }
  }

  #expiredPage(snapshotId: string | null = null): FiberSnapshotPage {
    return {
      snapshotId,
      nodes: [],
      traversal: expiredTraversal,
      error: 'Component-tree cursor is invalid or has expired.',
    };
  }
}
