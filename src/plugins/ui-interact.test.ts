import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import type { ComponentNode, PluginContext, ToolHandlerResult } from '../plugin.js';
import { uiInteractPlugin } from './ui-interact.js';

type Tool = {
  parameters: z.ZodType;
  handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult>;
};

async function createAppOnlyHarness(
  evaluation:
    | 'success'
    | 'failure'
    | 'pre-dispatch'
    | 'unhandled'
    | 'fabric-focused'
    | 'paper-focused'
    | 'fabric-empty'
    | 'paper-empty'
    | 'fabric-uncontrolled'
    | 'paper-uncontrolled' = 'success',
  nativeAvailable = false,
) {
  const tools = new Map<string, Tool>();
  let nativeCalls = 0;
  const execFileCalls: Array<{ command: string; args: string[] }> = [];
  const reactCalls: Array<{ type: 'submit' | 'change'; value: unknown }> = [];
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
    config: nativeAvailable ? {
      input: { nativeBackend: 'idb', idbCommand: 'idb' },
    } : {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    metro: { host: 'localhost', port: 8081, fetch: async () => new Response() },
    exec: async (command) => {
      nativeCalls++;
      if (nativeAvailable) return '';
      throw new Error('native inventory unavailable');
    },
    execFile: async (command, args) => {
      nativeCalls++;
      execFileCalls.push({ command, args });
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
        if (args[0] === 'devices') {
          return Buffer.from('List of devices attached\nemulator-42\tdevice model:Pixel_8\n');
        }
        return Buffer.from('');
      }
      if (nativeAvailable && command === 'idb') {
        if (args[0] === '--version') return Buffer.from('idb 1.1.0');
        if (args[0] === '--help') return Buffer.from('  ui\n  describe');
        if (args[0] === 'describe') {
          return Buffer.from(JSON.stringify({
            screen_dimensions: { width_points: 400, height_points: 800 },
          }));
        }
        if (args[0] === 'ui' && args[1] === '--help') {
          return Buffer.from('  describe-all\n  tap\n  text\n  key\n  swipe\n  button');
        }
        if (args[0] === 'ui' && args[2] === '--help') {
          return Buffer.from(args[1] === 'button' ? '{HOME}' : '--duration');
        }
        if (args[0] === 'ui' && args[1] === 'describe-all') {
          return Buffer.from(JSON.stringify([
            { label: 'Save', frame: { x: 10, y: 20, width: 80, height: 40 } },
          ]));
        }
        return Buffer.from('');
      }
      throw new Error('native inventory unavailable');
    },
    format: {
      summarize: () => '', compact: (value: unknown) => JSON.stringify(value),
      truncate: (value: string) => value, structureOnly: (value: ComponentNode) => value,
    },
    // A true result means the app-side handler was found and invoked.
    evalInApp: async (expression) => {
      if (evaluation === 'failure') throw new Error('CDP disconnected');
      if (evaluation === 'pre-dispatch') {
        throw new Error('Not connected to Metro. Use list_devices to check connection status.');
      }
      if (evaluation === 'unhandled') return false;
      if (evaluation.endsWith('-focused') || evaluation.endsWith('-empty') || evaluation.endsWith('-uncontrolled')) {
        const publicInstance = { isFocused: () => true };
        const fabric = evaluation.startsWith('fabric-');
        const controlled = !evaluation.endsWith('-uncontrolled');
        const value = evaluation.endsWith('-empty') ? '' : 'hello';
        const host = {
          stateNode: fabric ? { canonical: { publicInstance } } : publicInstance,
          child: null,
          sibling: null,
        };
        const textInput = {
          type: { displayName: 'TextInput' },
          memoizedProps: {
            ...(controlled ? { value } : { defaultValue: value }),
            onSubmitEditing: (event: unknown) => reactCalls.push({ type: 'submit', value: event }),
            onChangeText: (text: unknown) => reactCalls.push({ type: 'change', value: text }),
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
  return { tools, getNativeCalls: () => nativeCalls, execFileCalls, reactCalls };
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

  test('invokes focused controlled Paper and Fabric key handlers with exact payloads', async () => {
    for (const renderer of ['paper', 'fabric'] as const) {
      for (const [state, value] of [['focused', 'hello'], ['empty', '']] as const) {
        const harness = await createAppOnlyHarness(`${renderer}-${state}`);
        const press = harness.tools.get('press_button')!;
        for (const button of ['ENTER', 'DELETE'] as const) {
          expect(await press.handler(press.parameters.parse({ button, platform: 'ios' }) as Record<string, unknown>))
            .toBe(`Pressed ${button}`);
        }
        expect(harness.reactCalls).toEqual([
          { type: 'submit', value: { nativeEvent: { text: value } } },
          { type: 'change', value: value.slice(0, -1) },
        ]);
        expect(harness.getNativeCalls()).toBe(0);
      }
    }
  });

  test('uses native focused keys for uncontrolled Paper and Fabric inputs', async () => {
    for (const renderer of ['paper', 'fabric'] as const) {
      const harness = await createAppOnlyHarness(`${renderer}-uncontrolled`, true);
      const press = harness.tools.get('press_button')!;
      for (const button of ['ENTER', 'DELETE'] as const) {
        const result = await press.handler(press.parameters.parse({ button, platform: 'ios' }) as Record<string, unknown>);
        expect(result).toContain('backend=idb');
        expect(result).toContain('status=handled');
      }
      expect(harness.reactCalls).toEqual([]);
      expect(harness.execFileCalls).toContainEqual({
        command: 'idb',
        args: ['ui', 'key', '40', '--udid', 'SIMULATOR123'],
      });
      expect(harness.execFileCalls).toContainEqual({
        command: 'idb',
        args: ['ui', 'key', '42', '--udid', 'SIMULATOR123'],
      });
    }
  });

  test('uses the verified Android serial when no focused app handler accepts a key', async () => {
    const harness = await createAppOnlyHarness('unhandled', true);
    const press = harness.tools.get('press_button')!;
    const result = await press.handler(press.parameters.parse({ button: 'ENTER', platform: 'android' }) as Record<string, unknown>);
    expect(result).toContain('status=handled');
    expect(harness.execFileCalls).toContainEqual({
      command: 'adb',
      args: ['-s', 'emulator-42', 'shell', 'input', 'keyevent', '66'],
    });
  });

  test('does not replay a possibly dispatched action after a CDP rejection', async () => {
    const harness = await createAppOnlyHarness('failure');
    const tool = harness.tools.get('tap_element')!;
    await expect(tool.handler(tool.parameters.parse({ label: 'Save' }) as Record<string, unknown>))
      .rejects.toThrow('CDP disconnected');
    expect(harness.getNativeCalls()).toBe(0);
  });

  test('uses native fallback after a known pre-dispatch connection failure', async () => {
    const harness = await createAppOnlyHarness('pre-dispatch', true);
    const tool = harness.tools.get('tap_element')!;
    const result = await tool.handler(tool.parameters.parse({ label: 'Save', platform: 'ios' }) as Record<string, unknown>);
    expect(result).toContain('Tapped "Save"');
    expect(result).toContain('backend=idb');
    expect(result).toContain('status=handled');
    expect(harness.getNativeCalls()).toBeGreaterThan(0);
  });

  test('uses native fallback for other known pre-dispatch handler failures', async () => {
    const harness = await createAppOnlyHarness('pre-dispatch', true);
    const cases = [
      ['type_text', { text: 'hello', platform: 'ios' }, 'Typed "hello"'],
      ['swipe', { direction: 'up', platform: 'ios' }, 'Swiped up'],
      ['press_button', { button: 'ENTER', platform: 'android' }, 'Pressed ENTER'],
      ['press_button', { button: 'DELETE', platform: 'android' }, 'Pressed DELETE'],
    ] as const;
    for (const [name, args, expected] of cases) {
      const tool = harness.tools.get(name)!;
      const result = await tool.handler(tool.parameters.parse(args) as Record<string, unknown>);
      expect(result).toContain(expected);
      expect(result).toContain('status=handled');
    }
    expect(harness.getNativeCalls()).toBeGreaterThan(0);
  });

  test('uses native fallback for a label-only long press after a pre-dispatch failure', async () => {
    const harness = await createAppOnlyHarness('pre-dispatch', true);
    const tool = harness.tools.get('long_press')!;
    const result = await tool.handler(tool.parameters.parse({ label: 'Save', platform: 'ios' }) as Record<string, unknown>);
    expect(result).toContain('Long pressed "Save"');
    expect(result).toContain('backend=idb');
    expect(result).toContain('status=handled');
    expect(harness.getNativeCalls()).toBeGreaterThan(0);
  });
});
