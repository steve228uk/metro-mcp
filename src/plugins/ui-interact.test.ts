import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import type { ComponentNode, PluginContext, ToolHandlerResult } from '../plugin.js';
import { uiInteractPlugin } from './ui-interact.js';

type Tool = {
  parameters: z.ZodType;
  handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult>;
};

async function createAppOnlyHarness(
  evaluation: 'success' | 'failure' | 'pre-dispatch' | 'unhandled' | 'fabric-focused' = 'success',
  nativeAvailable = false,
) {
  const tools = new Map<string, Tool>();
  let nativeCalls = 0;
  const evaluations: string[] = [];
  const execCommands: string[] = [];
  const reactCalls: string[] = [];
  const ctx: PluginContext = {
    cdp: {
      on: () => {}, off: () => {}, isConnected: true,
      getTarget: () => ({ deviceName: 'Connected app' } as never),
      send: async () => ({}),
    },
    events: { on: () => {}, off: () => {}, isConnected: () => true },
    registerTool: (name, config) => tools.set(name, {
      parameters: config.parameters,
      handler: config.handler as Tool['handler'],
    }),
    registerResource: () => {}, registerAppResource: () => {}, registerPrompt: () => {},
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    metro: { host: 'localhost', port: 8081, fetch: async () => new Response() },
    exec: async (command) => {
      nativeCalls++;
      execCommands.push(command);
      if (nativeAvailable) return '';
      throw new Error('native inventory unavailable');
    },
    execFile: async (command, _args) => {
      nativeCalls++;
      if (nativeAvailable && command === 'xcrun') {
        return Buffer.from(JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
              { name: 'Acceptance', udid: 'SIMULATOR123', state: 'Booted', isAvailable: true },
            ],
          },
        }));
      }
      if (nativeAvailable && command === 'adb') {
        return Buffer.from('List of devices attached\nemulator-42\tdevice model:Connected_app\n');
      }
      throw new Error('native inventory unavailable');
    },
    format: {
      summarize: () => '', compact: (value: unknown) => JSON.stringify(value),
      truncate: (value: string) => value, structureOnly: (value: ComponentNode) => value,
    },
    // A true result means the app-side handler was found and invoked.
    evalInApp: async (expression) => {
      evaluations.push(expression);
      if (evaluation === 'failure') throw new Error('CDP disconnected');
      if (evaluation === 'pre-dispatch') {
        throw new Error('Not connected to Metro. Use list_devices to check connection status.');
      }
      if (evaluation === 'unhandled') return false;
      if (evaluation === 'fabric-focused') {
        const host = {
          stateNode: { canonical: { publicInstance: { isFocused: () => true } } },
          child: null,
          sibling: null,
        };
        const textInput = {
          type: { displayName: 'TextInput' },
          memoizedProps: {
            value: 'hello',
            onSubmitEditing: () => reactCalls.push('submit'),
            onChangeText: () => reactCalls.push('change'),
          },
          stateNode: null,
          child: host,
          sibling: null,
        };
        const rootFiber = { type: 'Root', child: textInput, sibling: null };
        const previousHook = (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__;
        (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
          getFiberRoots: () => new Set([{ current: rootFiber }]),
        };
        try {
          return Function(`return (${expression});`)();
        } finally {
          (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = previousHook;
        }
      }
      return true;
    },
    getActiveDeviceKey: () => null, getActiveDeviceName: () => null,
    notifyResourceUpdated: () => {},
  };
  await uiInteractPlugin.setup(ctx);
  return { tools, getNativeCalls: () => nativeCalls, evaluations, execCommands, reactCalls };
}

describe('UI handler actions without native inventory', () => {
  test('runs an immediate app handler without probing local devices', async () => {
    const harness = await createAppOnlyHarness();
    const tool = harness.tools.get('tap_element')!;
    const result = await tool.handler(tool.parameters.parse({ label: 'Save' }) as Record<string, unknown>);
    expect(result).toBe('Tapped "Save"');
    expect(harness.getNativeCalls()).toBe(0);
  });

  test('runs text input handler without replaying through native fallback', async () => {
    const harness = await createAppOnlyHarness();
    const tool = harness.tools.get('type_text')!;
    const result = await tool.handler(tool.parameters.parse({ text: 'hello' }) as Record<string, unknown>);
    expect(result).toBe('Typed "hello"');
    expect(harness.getNativeCalls()).toBe(0);
  });

  test('keeps the remaining handler actions usable without native inventory', async () => {
    const harness = await createAppOnlyHarness();

    const longPress = harness.tools.get('long_press')!;
    expect(await longPress.handler(longPress.parameters.parse({ label: 'Save' }) as Record<string, unknown>))
      .toBe('Long pressed "Save"');

    const swipe = harness.tools.get('swipe')!;
    expect(await swipe.handler(swipe.parameters.parse({ direction: 'up' }) as Record<string, unknown>))
      .toBe('Swiped up');

    for (const button of ['ENTER', 'DELETE'] as const) {
      const press = harness.tools.get('press_button')!;
      expect(await press.handler(press.parameters.parse({ button }) as Record<string, unknown>))
        .toBe(`Pressed ${button}`);
    }
    expect(harness.getNativeCalls()).toBe(0);
  });

  test('uses Android key events when no focused app handler accepts the action', async () => {
    const harness = await createAppOnlyHarness('unhandled', true);
    for (const button of ['ENTER', 'DELETE'] as const) {
      const press = harness.tools.get('press_button')!;
      expect(await press.handler(press.parameters.parse({ button, platform: 'android' }) as Record<string, unknown>))
        .toBe(`Pressed ${button}`);
    }
    expect(harness.evaluations).toHaveLength(2);
    expect(harness.execCommands).toEqual([
      'adb -s "emulator-42" shell input keyevent 66',
      'adb -s "emulator-42" shell input keyevent 67',
    ]);
  });

  test('invokes focused Fabric TextInput key handlers without native inventory', async () => {
    const harness = await createAppOnlyHarness('fabric-focused');
    const press = harness.tools.get('press_button')!;
    for (const button of ['ENTER', 'DELETE'] as const) {
      expect(await press.handler(press.parameters.parse({ button, platform: 'ios' }) as Record<string, unknown>))
        .toBe(`Pressed ${button}`);
    }
    expect(harness.reactCalls).toEqual(['submit', 'change']);
    expect(harness.getNativeCalls()).toBe(0);
  });

  test('does not replay a possibly dispatched action after a CDP rejection', async () => {
    const harness = await createAppOnlyHarness('failure');
    const tool = harness.tools.get('tap_element')!;
    const result = await tool.handler(tool.parameters.parse({ label: 'Save' }) as Record<string, unknown>);
    expect(result).toContain('Could not evaluate');
    expect(harness.getNativeCalls()).toBe(0);
  });

  test('uses native fallback after a known pre-dispatch connection failure', async () => {
    const harness = await createAppOnlyHarness('pre-dispatch', true);
    const tool = harness.tools.get('tap_element')!;
    const result = await tool.handler(tool.parameters.parse({ label: 'Save', platform: 'ios' }) as Record<string, unknown>);
    expect(result).toBe('Tapped "Save"');
    expect(harness.getNativeCalls()).toBeGreaterThan(0);
  });

  test('uses native fallback for other known pre-dispatch handler failures', async () => {
    const harness = await createAppOnlyHarness('pre-dispatch', true);
    const cases = [
      ['type_text', { text: 'hello', platform: 'ios' }, 'Typed "hello"'],
      ['long_press', { label: 'Save', x: 1, y: 2, platform: 'ios' }, 'Long pressed at (1, 2) for 1000ms'],
      ['swipe', { direction: 'up', platform: 'ios' }, 'Swiped up'],
      ['press_button', { button: 'ENTER', platform: 'ios' }, 'Pressed ENTER'],
      ['press_button', { button: 'DELETE', platform: 'ios' }, 'Pressed DELETE'],
    ] as const;
    for (const [name, args, expected] of cases) {
      const tool = harness.tools.get(name)!;
      expect(await tool.handler(tool.parameters.parse(args) as Record<string, unknown>)).toBe(expected);
    }
    expect(harness.getNativeCalls()).toBeGreaterThan(0);
  });

  test('reports a pre-dispatch failure for a label-only long press', async () => {
    const harness = await createAppOnlyHarness('pre-dispatch', true);
    const tool = harness.tools.get('long_press')!;
    const result = await tool.handler(tool.parameters.parse({ label: 'Save' }) as Record<string, unknown>);
    expect(result).toContain('Could not evaluate');
    expect(harness.getNativeCalls()).toBe(0);
  });
});
