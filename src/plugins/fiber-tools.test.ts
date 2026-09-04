import { describe, expect, test } from 'bun:test';
import vm from 'node:vm';
import type { z } from 'zod';
import type {
  ComponentNode,
  PluginContext,
  PluginDefinition,
} from '../plugin.js';
import { automationPlugin } from './automation.js';
import { componentsPlugin } from './components.js';
import { inspectPointPlugin } from './inspect-point.js';
import { uiInteractPlugin } from './ui-interact.js';
import { MAX_FIBER_PROP_BYTES } from '../utils/fiber.js';

interface Fiber {
  type: string | { displayName: string } | null;
  memoizedProps: Record<string, unknown>;
  memoizedState?: unknown;
  stateNode?: unknown;
  child?: Fiber | null;
  sibling?: Fiber | null;
  return?: Fiber | null;
}

type MeasureCallback = (
  x: number,
  y: number,
  width: number,
  height: number,
  pageX: number,
  pageY: number,
) => void;

interface RegisteredTool {
  parameters: z.ZodType;
  handler: (
    args: Record<string, unknown>,
    context: Record<string, never>,
  ) => Promise<unknown>;
}

function fiber(
  name: string | null,
  props: Record<string, unknown> = {},
  host = false,
): Fiber {
  return {
    type: name ? (host ? name : { displayName: name }) : null,
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

function runtimeFor(
  roots: Fiber[],
  renderer: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      getFiberRoots: (rendererId: number) =>
        rendererId === 12
          ? new Set(roots.map((current) => ({ current })))
          : new Set(),
      renderers: new Map([[12, renderer]]),
    },
  };
}

async function createHarness(
  runtime: Record<string, unknown>,
  plugins: PluginDefinition[],
  commands: Partial<Pick<PluginContext, 'exec' | 'execFile'>> = {},
) {
  // Runtime.evaluate executes against a persistent global object. A VM
  // context exercises that behavior. Wrapping snippets in new
  // Function(globalThis) does not provide equivalent global declaration
  // semantics.
  const appGlobal = vm.createContext({
    ...runtime,
    setTimeout,
    clearTimeout,
  });
  const tools = new Map<string, RegisteredTool>();
  const registerTool: PluginContext['registerTool'] = (name, config) => {
    tools.set(name, {
      parameters: config.parameters,
      handler: config.handler as unknown as RegisteredTool['handler'],
    });
  };
  // Also works when the screenshot plugin's execFile context API is present.
  const commandStubs = {
    exec: async () => '',
    execFile: async (command: string, args: string[]) => {
      if (command === 'xcrun' && args.join(' ') === 'simctl list devices booted --json') {
        return Buffer.from(JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ name: 'Test iPhone', udid: 'TEST-UDID', state: 'Booted' }] } }));
      }
      return Buffer.alloc(0);
    },
  };
  const ctx: PluginContext = {
    cdp: {
      on: () => {},
      off: () => {},
      isConnected: true,
      getTarget: () => null,
      send: async () => ({}),
    },
    events: { on: () => {}, off: () => {}, isConnected: () => true },
    registerTool,
    registerResource: () => {},
    registerAppResource: () => {},
    registerPrompt: () => {},
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    metro: { host: 'localhost', port: 8081, fetch: async () => new Response() },
    ...commandStubs,
    ...commands,
    format: {
      summarize: () => '',
      compact: (value: unknown) => JSON.stringify(value),
      truncate: (value: string) => value,
      structureOnly: (value: ComponentNode) => value,
    },
    evalInApp: async (expression, options) => {
      // Mirror returnByValue without assuming CDP awaits an app's JS Promise.
      const result = new vm.Script(expression).runInContext(appGlobal);
      if (options?.awaitPromise && result && typeof result === 'object' &&
          typeof (result as Promise<unknown>).then === 'function') {
        return result;
      }
      return result === undefined
        ? undefined
        : JSON.parse(JSON.stringify(result));
    },
    getActiveDeviceKey: () => 'device',
    getActiveDeviceName: () => 'Device',
    notifyResourceUpdated: () => {},
  };
  for (const plugin of plugins) await plugin.setup(ctx);

  return async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`${name} was not registered`);
    return tool.handler(
      tool.parameters.parse(args) as Record<string, unknown>,
      {},
    );
  };
}

describe('fiber read tools', () => {
  test('finds and inspects components beyond the old depth limit', async () => {
    const root = fiber('Provider0');
    let current = root;
    for (let depth = 1; depth <= 230; depth++) {
      const child = fiber(
        depth === 230 ? 'CustomButton' : `Provider${depth}`,
        depth === 230
          ? { testID: 'continue', accessibilityLabel: 'Continue' }
          : {},
      );
      append(current, child);
      current = child;
    }
    const call = await createHarness(runtimeFor([root]), [componentsPlugin]);

    const found = (await call('find_components', {
      pattern: 'CustomButton',
      maxDepth: 300,
    })) as { matches: Array<{ name: string }>; traversal: { complete: boolean } };
    expect(found.matches).toEqual([
      expect.objectContaining({ name: 'CustomButton' }),
    ]);
    expect(found.traversal.complete).toBe(true);

    const testable = (await call('get_testable_elements', {
      maxDepth: 300,
    })) as {
      elements: Array<{ testID: string }>;
      traversal: { complete: boolean };
    };
    expect(testable.elements).toEqual([
      expect.objectContaining({ testID: 'continue' }),
    ]);

    const inspected = (await call('inspect_component', {
      name: 'CustomButton',
      maxDepth: 300,
    })) as { result: { name: string }; traversal: { complete: boolean } };
    expect(inspected.result.name).toBe('CustomButton');
    expect(inspected.traversal.complete).toBe(true);
  });

  test('pages flat component nodes with stable parent IDs', async () => {
    const root = fiber('Node0');
    let current = root;
    for (let index = 1; index < 260; index++) {
      const child = fiber(`Node${index}`);
      append(current, child);
      current = child;
    }
    const call = await createHarness(runtimeFor([root]), [componentsPlugin]);
    const first = (await call('get_component_tree', {
      structureOnly: true,
      pageSize: 100,
      maxDepth: 300,
    })) as {
      snapshotId: string;
      nodes: Array<{ id: string; parentId: string | null; depth: number }>;
      nextCursor: string;
      traversal: { complete: boolean };
    };
    const second = (await call('get_component_tree', {
      cursor: first.nextCursor,
      pageSize: 100,
    })) as typeof first;

    expect(first.nodes).toHaveLength(100);
    expect(first.nodes[0]).toMatchObject({ parentId: null, depth: 0 });
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.nodes[0]).toMatchObject({
      parentId: first.nodes.at(-1)?.id,
      depth: 100,
    });
    expect(first.traversal.complete).toBe(true);
  });

  test('bounds nested component props before returning them', async () => {
    const root = fiber('LargeProps', {
      payload: {
        items: Array.from({ length: 500 }, (_, index) => ({
          index,
          value: 'x'.repeat(2_000),
        })),
      },
    });
    const call = await createHarness(runtimeFor([root]), [componentsPlugin]);
    const result = (await call('get_component_tree', {
      structureOnly: false,
    })) as {
      nodes: Array<{ props: { payload: { items: unknown[] } } }>;
    };

    expect(result.nodes[0].props.payload.items).toHaveLength(21);
    expect(result.nodes[0].props.payload.items.at(-1)).toBe('[truncated]');
    expect(JSON.stringify(result).length).toBeLessThan(25_000);
  });

  test('shares a UTF-8 prop-byte budget across the entire paged snapshot', async () => {
    const sharedProps = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `value${index}`,
        '😀'.repeat(1_000),
      ]),
    );
    const root = append(
      fiber('Root'),
      ...Array.from({ length: 300 }, (_, index) => fiber(`Item${index}`, sharedProps)),
    );
    const call = await createHarness(runtimeFor([root]), [componentsPlugin]);
    type Page = {
      nodes: Array<{ props?: Record<string, unknown> }>;
      nextCursor?: string;
      traversal: Record<string, unknown>;
    };
    let page = (await call('get_component_tree', {
      structureOnly: false,
      pageSize: 100,
    })) as Page;
    const nodes = [...page.nodes];
    while (page.nextCursor) {
      page = (await call('get_component_tree', { cursor: page.nextCursor })) as Page;
      nodes.push(...page.nodes);
    }

    const propBytes = nodes.reduce(
      (total, node) => total + (node.props
        ? Buffer.byteLength(JSON.stringify(node.props), 'utf8')
        : 0),
      0,
    );
    expect(nodes).toHaveLength(301);
    expect(propBytes).toBeGreaterThan(0);
    expect(propBytes).toBeLessThanOrEqual(MAX_FIBER_PROP_BYTES);
    expect(page.traversal).toMatchObject({
      complete: false,
      scannedNodes: 301,
      truncationReason: 'max-prop-bytes',
    });
  });

  test('keeps distinct sibling controls that share a label', async () => {
    const root = append(
      fiber('Root'),
      fiber('Pressable', { accessibilityLabel: 'Option', onPress: () => {} }),
      fiber('Pressable', { accessibilityLabel: 'Option', onPress: () => {} }),
    );
    const call = await createHarness(runtimeFor([root]), [
      componentsPlugin,
      uiInteractPlugin,
    ]);

    const testable = (await call('get_testable_elements')) as {
      elements: Array<{ accessibilityLabel: string }>;
    };
    const listed = (await call('list_elements', { interactiveOnly: true })) as {
      elements: Array<{ label: string }>;
    };

    expect(testable.elements).toHaveLength(2);
    expect(listed.elements).toHaveLength(2);
  });

  test('bounds primitive child-array text extraction', async () => {
    const values = new Proxy(
      Array.from({ length: 10_000 }, () => 'x'),
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) {
            if (Number(property) >= 100) {
              throw new Error('text extraction exceeded its item budget');
            }
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const root = fiber('Text', {
      accessibilityLabel: 'Bounded text',
      children: values,
    });
    const call = await createHarness(runtimeFor([root]), [uiInteractPlugin]);

    const result = (await call('list_elements')) as {
      elements: Array<{ text: string }>;
    };

    expect(result.elements[0].text.length).toBeLessThanOrEqual(300);
  });

  test('reports incomplete traversal from wait_for_element', async () => {
    const root = append(
      fiber('Root'),
      ...Array.from({ length: 10 }, (_, index) =>
        fiber('Item', index === 9 ? { testID: 'late-item' } : {}),
      ),
    );
    const call = await createHarness(runtimeFor([root]), [automationPlugin]);

    const result = (await call('wait_for_element', {
      selector: 'late-item',
      timeout: 100,
      pollInterval: 100,
      maxNodes: 3,
    })) as {
      found: boolean;
      traversal: { complete: boolean; truncationReason?: string };
    };

    expect(result).toMatchObject({
      found: false,
      traversal: {
        complete: false,
        truncationReason: 'max-nodes',
      },
    });
  });

  test('list_elements returns an explicit envelope and deep elements', async () => {
    const root = fiber('Root');
    let current = root;
    for (let depth = 1; depth <= 210; depth++) {
      const child = fiber(
        depth === 210 ? 'Pressable' : `Wrapper${depth}`,
        depth === 210
          ? { accessibilityLabel: 'Continue', onPress: () => {} }
          : {},
      );
      append(current, child);
      current = child;
    }
    const call = await createHarness(runtimeFor([root]), [uiInteractPlugin]);
    const result = (await call('list_elements', {
      interactiveOnly: true,
      maxDepth: 300,
    })) as {
      elements: Array<{ label: string }>;
      traversal: { complete: boolean; depthReached: number };
    };

    expect(result.elements).toEqual([
      expect.objectContaining({ label: 'Continue' }),
    ]);
    expect(result.traversal).toMatchObject({
      complete: true,
      depthReached: 210,
    });
  });

  test('types into an immediate deep TextInput handler beyond depth 200', async () => {
    const root = fiber('Root');
    let current = root;
    let received = '';
    for (let depth = 1; depth <= 255; depth++) {
      const child = fiber(depth === 255 ? 'TextInput' : `Wrapper${depth}`, depth === 255 ? { onChangeText: (value: string) => { received = value; } } : {});
      append(current, child);
      current = child;
    }
    const call = await createHarness(runtimeFor([root]), [uiInteractPlugin]);
    expect(await call('type_text', { text: 'immediate', platform: 'auto' })).toBe('Typed "immediate"');
    expect(received).toBe('immediate');
  });

  test('presses ENTER through a deep TextInput handler before native input', async () => {
    const root = fiber('Root');
    let current = root;
    let submitted = false;
    for (let depth = 1; depth <= 255; depth++) {
      const child = fiber(
        depth === 255 ? 'TextInput' : `Wrapper${depth}`,
        depth === 255
          ? { value: 'ready', onSubmitEditing: () => { submitted = true; } }
          : {},
      );
      if (depth === 255) {
        child.stateNode = { canonical: { publicInstance: { isFocused: () => true } } };
      }
      append(current, child);
      current = child;
    }
    const call = await createHarness(runtimeFor([root]), [uiInteractPlugin]);
    expect(await call('press_button', { button: 'ENTER', platform: 'auto' })).toBe('Pressed ENTER');
    expect(submitted).toBe(true);
  });

  test('does not replay a scroll whose React method throws after invocation', async () => {
    const host = fiber('RCTScrollView', {}, true);
    host.stateNode = { scrollTo: () => { throw new Error('scroll dispatch uncertain'); } };
    const root = append(fiber('ScrollView'), host);
    const call = await createHarness(runtimeFor([root]), [uiInteractPlugin]);
    await expect(call('swipe', { direction: 'up', platform: 'auto' }))
      .rejects.toThrow('scroll dispatch uncertain');
  });

  test('does not record a native swipe when no provider can dispatch it', async () => {
    const events: unknown[] = [];
    const call = await createHarness({
      ...runtimeFor([fiber('Root')]),
      __METRO_MCP_REC_ACTIVE__: true,
      __METRO_MCP_REC_EVENTS__: events,
    }, [uiInteractPlugin], {
      execFile: async (command) => {
        if (command === 'xcrun') return Buffer.from(JSON.stringify({
          devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
            { name: 'Test iPhone', udid: 'TEST-UDID', state: 'Booted' },
          ] },
        }));
        throw new Error('Native provider unavailable');
      },
    });
    expect(await call('swipe', { direction: 'up', platform: 'ios' })).toContain('failed');
    expect(events).toEqual([]);
  });

  test('does not fall through to native input when a React handler rejects', async () => {
    const root = fiber('Root');
    let current = root;
    for (let depth = 1; depth <= 255; depth++) {
      const child = fiber(depth === 255 ? 'TextInput' : `Wrapper${depth}`, depth === 255 ? { onChangeText: () => { throw new Error('handler failed'); } } : {});
      append(current, child);
      current = child;
    }
    const call = await createHarness(runtimeFor([root]), [uiInteractPlugin]);
    await expect(call('type_text', { text: 'reject', platform: 'auto' })).rejects.toThrow('handler failed');
  });
});

describe('inspect_at_point', () => {
  test('awaits an async Fabric public instance measurement', async () => {
    const host = fiber('View', {}, true);
    host.stateNode = {};
    const root = append(fiber('CustomButton', { testID: 'button' }), host);
    const call = await createHarness(
      runtimeFor([root], {
        findHostInstanceByFiber: (candidate: Fiber) =>
          candidate === host
            ? {
                getBoundingClientRect: async () => ({
                  x: 10,
                  y: 20,
                  width: 100,
                  height: 50,
                }),
              }
            : null,
      }),
      [inspectPointPlugin],
    );
    const envelope = (await call('inspect_at_point', { x: 30, y: 40 })) as {
      result: Record<string, unknown>;
      traversal: { complete: boolean };
    };

    expect(envelope.result).toMatchObject({
      found: true,
      hostComponent: 'View',
      reactComponent: 'CustomButton',
      layout: { x: 10, y: 20, width: 100, height: 50 },
    });
    expect(envelope.traversal.complete).toBe(true);
  });

  test('measures Fabric shadow nodes before their public instance exists', async () => {
    const host = fiber('RCTText', {}, true);
    const shadowNode = {};
    const canonical = { publicInstance: null };
    host.stateNode = { node: shadowNode, canonical };
    const root = append(fiber('Label'), host);
    const runtime = {
      ...runtimeFor([root]),
      nativeFabricUIManager: {
        measure: (node: unknown, callback: MeasureCallback) => {
          expect(node).toBe(shadowNode);
          setTimeout(() => callback(0, 0, 80, 30, 5, 6), 5);
        },
      },
    };
    const call = await createHarness(runtime, [inspectPointPlugin]);
    const envelope = (await call('inspect_at_point', { x: 10, y: 10 })) as {
      result: Record<string, unknown>;
      traversal: { complete: boolean };
    };

    expect(envelope.result).toMatchObject({
      found: true,
      hostComponent: 'RCTText',
      reactComponent: 'Label',
      layout: { x: 5, y: 6, width: 80, height: 30 },
    });
    expect(envelope.traversal.complete).toBe(true);
    expect(canonical.publicInstance).toBeNull();
  });

  test('awaits callback-based Paper measurement', async () => {
    const host = fiber('Text', {}, true);
    host.stateNode = {
      measure: (callback: MeasureCallback) => callback(0, 0, 80, 30, 5, 6),
    };
    const root = append(fiber('Label'), host);
    const call = await createHarness(runtimeFor([root]), [inspectPointPlugin]);
    const envelope = (await call('inspect_at_point', { x: 10, y: 10 })) as {
      result: Record<string, unknown>;
    };

    expect(envelope.result).toMatchObject({
      found: true,
      hostComponent: 'Text',
      reactComponent: 'Label',
      layout: { x: 5, y: 6, width: 80, height: 30 },
    });
  });
});
