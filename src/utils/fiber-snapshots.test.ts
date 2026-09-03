import { describe, expect, test } from 'bun:test';
import { FiberSnapshotStore, type FlatFiberNode } from './fiber-snapshots.js';
import type { FiberTraversalMetadata } from './fiber.js';

const traversal: FiberTraversalMetadata = {
  scope: 'all-scenes',
  complete: true,
  depthReached: 3,
  scannedNodes: 3,
};

function nodes(count: number): FlatFiberNode[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `node-${index}`,
    parentId: index ? `node-${index - 1}` : null,
    depth: index,
    name: `Node${index}`,
  }));
}

describe('fiber snapshot pagination', () => {
  test('pages a stable snapshot with opaque cursors', () => {
    const store = new FiberSnapshotStore();
    const first = store.create(nodes(260), traversal, 100);
    const second = store.read(first.nextCursor!, 100);
    const third = store.read(second.nextCursor!, 100);

    expect(first.nodes).toHaveLength(100);
    expect(second.nodes[0]?.id).toBe('node-100');
    expect(third.nodes).toHaveLength(60);
    expect(third.nextCursor).toBeUndefined();
    expect(new Set([first.snapshotId, second.snapshotId, third.snapshotId]).size).toBe(1);
  });

  test('expires cursors after 60 seconds', () => {
    let now = 1_000;
    const store = new FiberSnapshotStore(() => now);
    const first = store.create(nodes(2), traversal, 1);
    now += 60_001;

    expect(store.read(first.nextCursor!, 1)).toMatchObject({
      nodes: [],
      error: 'Component-tree cursor is invalid or has expired.',
      traversal: { complete: false, truncationReason: 'cursor-expired' },
    });
  });

  test('retains at most eight snapshots', () => {
    const store = new FiberSnapshotStore(() => 1_000);
    const first = store.create(nodes(2), traversal, 1);
    for (let index = 0; index < 8; index++) {
      store.create(nodes(1), traversal, 1);
    }

    expect(store.read(first.nextCursor!, 1).error).toBeDefined();
  });
});
