import { describe, expect, test } from 'bun:test';
import { buildFiberReadExpression } from './fiber.js';

interface Fiber {
  type: string | { displayName: string } | null;
  memoizedProps?: Record<string, unknown>;
  memoizedState?: unknown;
  stateNode?: unknown;
  child?: Fiber | null;
  sibling?: Fiber | null;
  return?: Fiber | null;
}

function fiber(
  name: string | null,
  props: Record<string, unknown> = {},
): Fiber {
  return {
    type: name ? { displayName: name } : null,
    memoizedProps: props,
  };
}

function append(parent: Fiber, ...children: Fiber[]): Fiber {
  parent.child = children[0] ?? null;
  children.forEach((child, index) => {
    child.return = parent;
    child.sibling = children[index + 1] ?? null;
  });
  return parent;
}

function sandbox(
  roots: Fiber[],
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      getFiberRoots: (rendererId: number) =>
        rendererId === 7
          ? new Set(roots.map((current) => ({ current })))
          : new Set(),
      renderers: new Map([[7, {}]]),
    },
    ...extras,
  };
}

async function evaluate<T>(
  expression: string,
  runtime: Record<string, unknown>,
): Promise<T> {
  const evaluateExpression = new Function(
    'globalThis',
    `return ${expression};`,
  ) as (globalObject: Record<string, unknown>) => T | Promise<T>;
  return evaluateExpression(runtime);
}

function collectExpression(
  options: { maxDepth?: number; maxNodes?: number } = {},
): string {
  return buildFiberReadExpression(
    `
      var names = [];
      var traversal = metroWalkFibers(FIBER_OPTIONS, function(item) {
        var name = metroFiberName(item);
        if (name) names.push(name);
      });
      return { names: names, traversal: traversal };
    `,
    options,
  );
}

describe('shared fiber walker', () => {
  test('searches renderer IDs 1-20 and handles every root', async () => {
    const result = await evaluate<{
      names: string[];
      traversal: { complete: boolean; scannedNodes: number };
    }>(collectExpression(), sandbox([fiber('FirstRoot'), fiber('SecondRoot')]));

    expect(result.names).toEqual(['FirstRoot', 'SecondRoot']);
    expect(result.traversal).toMatchObject({ complete: true, scannedNodes: 2 });
  });

  test('supports a 230-level provider tree when the caller raises maxDepth', async () => {
    const root = fiber('Provider0');
    let current = root;
    for (let depth = 1; depth <= 230; depth++) {
      const child = fiber(depth === 230 ? 'DeepButton' : `Provider${depth}`);
      append(current, child);
      current = child;
    }

    const result = await evaluate<{
      names: string[];
      traversal: { complete: boolean; depthReached: number };
    }>(
      collectExpression({ maxDepth: 300, maxNodes: 1000 }),
      sandbox([root]),
    );

    expect(result.names.at(-1)).toBe('DeepButton');
    expect(result.traversal).toMatchObject({
      complete: true,
      depthReached: 230,
    });
  });

  test('reports max-depth truncation instead of a complete empty result', async () => {
    const root = fiber(null);
    let current = root;
    for (let depth = 1; depth <= 205; depth++) {
      const child = fiber(depth === 205 ? 'BeyondDefaultDepth' : null);
      append(current, child);
      current = child;
    }

    const result = await evaluate<{
      names: string[];
      traversal: Record<string, unknown>;
    }>(collectExpression(), sandbox([root]));

    expect(result.names).toEqual([]);
    expect(result.traversal).toMatchObject({
      complete: false,
      depthReached: 200,
      scannedNodes: 201,
      truncationReason: 'max-depth',
    });
  });

  test('reports max-node truncation', async () => {
    const root = fiber('Root');
    append(root, ...Array.from({ length: 10 }, (_, index) => fiber(`Item${index}`)));
    const result = await evaluate<{
      traversal: Record<string, unknown>;
    }>(collectExpression({ maxNodes: 5 }), sandbox([root]));

    expect(result.traversal).toMatchObject({
      complete: false,
      scannedNodes: 5,
      truncationReason: 'max-nodes',
    });
  });

  test('does not perform an unreported focus-discovery prepass', async () => {
    const root = fiber('Root');
    const child = fiber('Child');
    let childReads = 0;
    Object.defineProperty(root, 'child', {
      configurable: true,
      get: () => {
        childReads++;
        return child;
      },
    });

    const result = await evaluate<{
      names: string[];
      traversal: Record<string, unknown>;
    }>(collectExpression({ maxNodes: 1 }), sandbox([root]));

    expect(result.names).toEqual(['Root']);
    expect(result.traversal).toMatchObject({
      complete: false,
      scannedNodes: 1,
      truncationReason: 'max-nodes',
    });
    expect(childReads).toBe(1);
  });

  test('distinguishes a genuinely complete empty traversal', async () => {
    const result = await evaluate<{
      names: string[];
      traversal: Record<string, unknown>;
    }>(collectExpression(), sandbox([fiber(null)]));

    expect(result.names).toEqual([]);
    expect(result.traversal).toMatchObject({
      complete: true,
      scannedNodes: 1,
    });
  });

  test('prunes inactive scenes while retaining global overlays', async () => {
    const active = append(
      fiber('SceneView', { route: { key: 'active', name: 'Active' } }),
      fiber('ActiveScreen'),
    );
    const inactive = append(
      fiber('SceneView', { route: { key: 'inactive', name: 'Inactive' } }),
      fiber('InactiveScreen'),
    );
    const root = append(fiber('Root'), active, inactive, fiber('ToastOverlay'));
    const result = await evaluate<{
      names: string[];
      traversal: Record<string, unknown>;
    }>(
      collectExpression(),
      sandbox([root], {
        __EXPO_ROUTER_STATE__: {
          index: 0,
          routes: [
            { key: 'active', name: 'Active' },
            { key: 'inactive', name: 'Inactive' },
          ],
        },
      }),
    );

    expect(result.names).toContain('ActiveScreen');
    expect(result.names).toContain('ToastOverlay');
    expect(result.names).not.toContain('InactiveScreen');
    expect(result.traversal).toMatchObject({ scope: 'focused-scene' });
  });

  test('uses all scenes when navigation focus is unavailable', async () => {
    const root = append(
      fiber('Root'),
      append(fiber('SceneView', { route: { name: 'One' } }), fiber('One')),
      append(fiber('SceneView', { route: { name: 'Two' } }), fiber('Two')),
    );
    const result = await evaluate<{
      names: string[];
      traversal: Record<string, unknown>;
    }>(collectExpression(), sandbox([root]));

    expect(result.names).toEqual(['Root', 'SceneView', 'One', 'SceneView', 'Two']);
    expect(result.traversal).toMatchObject({ scope: 'all-scenes' });
  });

  test('resolves focus from navigation fibers when globals are unavailable', async () => {
    const navigation = fiber('BaseNavigationContainer');
    navigation.memoizedState = {
      memoizedState: {
        index: 1,
        routes: [
          { key: 'first', name: 'First' },
          { key: 'second', name: 'Second' },
        ],
      },
      next: null,
    };
    append(
      navigation,
      append(fiber('SceneView', { route: { key: 'first' } }), fiber('First')),
      append(fiber('SceneView', { route: { key: 'second' } }), fiber('Second')),
    );
    const result = await evaluate<{
      names: string[];
      traversal: Record<string, unknown>;
    }>(collectExpression(), sandbox([navigation]));

    expect(result.names).toContain('Second');
    expect(result.names).not.toContain('First');
    expect(result.traversal).toMatchObject({ scope: 'focused-scene' });
  });

  test('reports unavailable fiber roots as incomplete', async () => {
    const result = await evaluate<{
      names: string[];
      traversal: Record<string, unknown>;
    }>(collectExpression(), sandbox([]));

    expect(result.names).toEqual([]);
    expect(result.traversal).toMatchObject({
      complete: false,
      scannedNodes: 0,
      truncationReason: 'fiber-roots-unavailable',
    });
  });
});
