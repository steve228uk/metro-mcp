import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import type { PluginContext, ToolHandlerContext } from '../plugin.js';
import type { FiberTraversalMetadata } from '../utils/fiber.js';
import { accessibilityPlugin } from './accessibility.js';

interface Fiber {
  type: { displayName: string };
  memoizedProps: Record<string, unknown>;
  child?: Fiber;
  sibling?: Fiber;
}

function fiber(name: string, props: Record<string, unknown> = {}): Fiber {
  return { type: { displayName: name }, memoizedProps: props };
}

interface Audit {
  issues: Array<{ issue: string; severity: string; component: string }>;
  summary: string;
  traversal: FiberTraversalMetadata;
}

async function auditor(root?: Fiber) {
  let audit!: {
    parameters: z.ZodType;
    handler(args: Record<string, unknown>, context: ToolHandlerContext): Promise<unknown>;
  };
  const runtime = {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      getFiberRoots: (id: number) => id === 12 && root ? new Set([{ current: root }]) : new Set(),
    },
  };
  const registerTool: PluginContext['registerTool'] = (name, config) => {
    if (name === 'audit_accessibility') audit = config as unknown as typeof audit;
  };
  const context: Pick<PluginContext, 'registerTool' | 'evalInApp'> = {
    registerTool,
    evalInApp: async (expression) => new Function('globalThis', `return ${expression};`)(runtime),
  };
  await accessibilityPlugin.setup(context as PluginContext);
  return async (args: Record<string, unknown> = {}) =>
    await audit.handler(audit.parameters.parse(args) as Record<string, unknown>, {}) as Audit;
}

function deepTree(depth: number): Fiber {
  let root = fiber('Image');
  for (let index = 0; index < depth; index++) root = { ...fiber('Provider'), child: root };
  return root;
}

describe('bounded accessibility audits', () => {
  test('finds violations past the former depth-50 cutoff by default', async () => {
    const audit = await auditor(deepTree(150));
    const result = await audit();
    expect(result.issues).toMatchObject([{ component: 'Image', severity: 'error' }]);
    expect(result.traversal).toMatchObject({ complete: true, depthReached: 150 });
  });

  test('reports insufficient depth and finds the deep violation with a larger budget', async () => {
    const audit = await auditor(deepTree(263));
    const partial = await audit();
    expect(partial.issues).toEqual([]);
    expect(partial.traversal).toMatchObject({ complete: false, truncationReason: 'max-depth' });
    expect(partial.summary).toContain('Audit incomplete');
    expect(partial.summary).not.toContain('No accessibility issues found!');
    const complete = await audit({ maxDepth: 600 });
    expect(complete.issues).toMatchObject([{ component: 'Image', severity: 'error' }]);
    expect(complete.traversal.complete).toBe(true);
  });

  test('does not scan a wide child list outside the node budget or invent a missing label', async () => {
    let reads = 0;
    function sibling(index: number): Fiber {
      const node = fiber(index === 99_999 ? 'Text' : 'View');
      Object.defineProperty(node, 'sibling', { get() {
        reads++;
        return index < 99_999 ? sibling(index + 1) : undefined;
      } });
      return node;
    }
    const root = fiber('Pressable', { testID: 'submit', accessibilityRole: 'button' });
    root.child = sibling(0);
    const result = await (await auditor(root))({ maxNodes: 20 });
    expect(result.traversal).toMatchObject({ complete: false, scannedNodes: 20, truncationReason: 'max-nodes' });
    expect(reads).toBeLessThan(50);
    expect(result.issues).toEqual([]);
    expect(result.summary).toContain('Audit incomplete');
  });

  test('preserves the direct text-child label rule', async () => {
    const root = fiber('Pressable', { testID: 'submit', accessibilityRole: 'button' });
    root.child = fiber('View');
    root.child.sibling = fiber('Text', { children: 'Submit' });
    const result = await (await auditor(root))();
    expect(result.issues).toEqual([]);
    expect(result.traversal.complete).toBe(true);
    expect(result.summary).toBe('No accessibility issues found!');
  });

  test('preserves audit rules and filters issues while keeping all-severity counts', async () => {
    const root = fiber('Pressable');
    root.sibling = fiber('Image');
    // Root siblings are separate roots in React, so put all fixtures under a provider.
    const provider = fiber('Provider');
    provider.child = root;
    root.sibling.sibling = fiber('TextInput');
    root.sibling.sibling.sibling = fiber('Text', { accessibilityRole: 'header' });
    const audit = await auditor(provider);
    const all = await audit();
    expect(all.summary).toBe('6 issues found: 3 errors, 2 warnings, 1 info');
    const filtered = await audit({ severity: 'error' });
    expect(filtered.issues).toHaveLength(3);
    expect(filtered.issues.every((issue) => issue.severity === 'error')).toBe(true);
    expect(filtered.summary).toBe(all.summary);
  });

  test('returns a complete envelope for a clean tree and incomplete coverage without roots', async () => {
    const clean = await (await auditor(fiber('Pressable', {
      accessibilityLabel: 'Submit', accessibilityRole: 'button', testID: 'submit',
    })))();
    expect(clean).toMatchObject({ issues: [], traversal: { complete: true } });
    const missing = await (await auditor())();
    expect(missing).toMatchObject({
      issues: [], traversal: { complete: false, truncationReason: 'fiber-roots-unavailable' },
    });
    expect(missing.summary).toContain('Audit incomplete');
  });
});
