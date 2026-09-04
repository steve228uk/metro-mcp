import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import type { ComponentNode, PluginContext, ToolHandlerResult } from '../plugin.js';
import { uiInteractPlugin } from './ui-interact.js';

type Tool = {
  parameters: z.ZodType;
  handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult>;
};

type AppEvaluation =
  | 'success'
  | 'failure'
  | 'pre-dispatch'
  | 'timeout'
  | 'ambiguous-timeout'
  | 'unhandled'
  | {
      renderer: 'paper' | 'fabric';
      value: string;
      submitBehavior?: 'newline' | 'submit' | 'blurAndSubmit';
      blurOnSubmit?: boolean;
      multiline?: boolean;
    }
  | {
      renderer: 'paper' | 'fabric';
      defaultValue: string;
    };

async function createAppOnlyHarness(
  evaluation: AppEvaluation = 'success',
  nativeAvailable = false,
  connectedLogicalDeviceId?: string,
  sharedInventoryDeviceId = false,
  unavailablePlatform?: 'ios' | 'android',
  androidStatus: 'device' | 'offline' | 'unauthorized' = 'device',
) {
  const tools = new Map<string, Tool>();
  let nativeCalls = 0;
  const evaluations: string[] = [];
  const execCommands: string[] = [];
  const reactCalls: Array<{ type: 'submit' | 'change'; value: unknown }> = [];
  let blurCalls = 0;
  const ctx: PluginContext = {
    cdp: {
      on: () => {}, off: () => {}, isConnected: true,
      getTarget: () => ({
        deviceName: 'Connected app',
        ...(connectedLogicalDeviceId
          ? { reactNative: { logicalDeviceId: connectedLogicalDeviceId } }
          : {}),
      } as never),
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
      if (command.includes('pull /sdcard/uidump.xml')) {
        await Bun.write('/tmp/metro-mcp-uidump.xml', '<node text="Save" content-desc="Save" bounds="[0,0][100,100]"/>');
      }
      if (nativeAvailable) return '';
      throw new Error('native inventory unavailable');
    },
    execFile: async (command, _args) => {
      nativeCalls++;
      if (nativeAvailable && unavailablePlatform === 'ios' && command === 'xcrun') {
        throw new Error('simctl inventory unavailable');
      }
      if (nativeAvailable && unavailablePlatform === 'android' && command === 'adb') {
        throw new Error('adb inventory unavailable');
      }
      if (nativeAvailable && command === 'xcrun') {
        const simulatorId = sharedInventoryDeviceId && connectedLogicalDeviceId
          ? connectedLogicalDeviceId
          : 'SIMULATOR123';
        return Buffer.from(JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
              { name: 'Acceptance', udid: simulatorId, state: 'Booted', isAvailable: true },
            ],
          },
        }));
      }
      if (nativeAvailable && command === 'adb') {
        const androidId = sharedInventoryDeviceId && connectedLogicalDeviceId
          ? connectedLogicalDeviceId
          : 'emulator-42';
        return Buffer.from(`List of devices attached\n${androidId}\t${androidStatus} model:Connected_app\n`);
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
      if (evaluation === 'timeout') throw new Error('App evaluation timed out');
      if (evaluation === 'ambiguous-timeout') {
        throw new Error('App evaluation timed out after 30ms');
      }
      if (evaluation === 'unhandled') return false;
      if (typeof evaluation === 'object') {
        const publicInstance = { isFocused: () => true, blur: () => { blurCalls++; } };
        const fabric = evaluation.renderer === 'fabric';
        const controlled = 'value' in evaluation;
        const value = controlled ? evaluation.value : evaluation.defaultValue;
        const host = {
          stateNode: fabric ? { canonical: { publicInstance } } : publicInstance,
          child: null,
          sibling: null,
        };
        const textInput = {
          type: { displayName: 'TextInput' },
          memoizedProps: {
            ...(controlled ? { value } : { defaultValue: value }),
            ...('submitBehavior' in evaluation && evaluation.submitBehavior !== undefined
              ? { submitBehavior: evaluation.submitBehavior } : {}),
            ...('blurOnSubmit' in evaluation && evaluation.blurOnSubmit !== undefined
              ? { blurOnSubmit: evaluation.blurOnSubmit } : {}),
            ...('multiline' in evaluation && evaluation.multiline !== undefined
              ? { multiline: evaluation.multiline } : {}),
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
  return { tools, getNativeCalls: () => nativeCalls, evaluations, execCommands, reactCalls,
    getBlurCalls: () => blurCalls };
}

async function pressTextInputKeys(
  evaluation: Extract<AppEvaluation, object>,
  options: { nativeAvailable?: boolean; platform?: 'ios' | 'android' | 'auto' } = {},
) {
  const harness = await createAppOnlyHarness(evaluation, options.nativeAvailable);
  const press = harness.tools.get('press_button')!;
  for (const button of ['ENTER', 'DELETE'] as const) {
    expect(await press.handler(press.parameters.parse({
      button,
      platform: options.platform ?? 'auto',
    }) as Record<string, unknown>)).toBe(`Pressed ${button}`);
  }
  return harness;
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
    const harness = await createAppOnlyHarness('unhandled', true, 'emulator-42');
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

  test('invokes controlled Paper and Fabric handlers with exact non-empty payloads', async () => {
    for (const renderer of ['paper', 'fabric'] as const) {
      const harness = await pressTextInputKeys({ renderer, value: 'hello' });
      expect(harness.reactCalls).toEqual([
        { type: 'submit', value: { nativeEvent: { text: 'hello' } } },
        { type: 'change', value: 'hell' },
      ]);
      expect(harness.getNativeCalls()).toBe(0);
    }
  });

  test('invokes controlled Paper and Fabric handlers with exact empty payloads', async () => {
    for (const renderer of ['paper', 'fabric'] as const) {
      const harness = await pressTextInputKeys({ renderer, value: '' });
      expect(harness.reactCalls).toEqual([
        { type: 'submit', value: { nativeEvent: { text: '' } } },
        { type: 'change', value: '' },
      ]);
      expect(harness.getNativeCalls()).toBe(0);
    }
  });

  test('matches Android blurAndSubmit semantics for controlled Paper and Fabric inputs', async () => {
    for (const renderer of ['paper', 'fabric'] as const) {
      const harness = await createAppOnlyHarness({ renderer, value: 'hello', submitBehavior: 'blurAndSubmit' });
      const press = harness.tools.get('press_button')!;
      expect(await press.handler(press.parameters.parse({ button: 'ENTER', platform: 'auto' }) as Record<string, unknown>));
      expect(harness.reactCalls).toEqual([
        { type: 'submit', value: { nativeEvent: { text: 'hello' } } },
      ]);
      expect(harness.getBlurCalls()).toBe(1);
      expect(harness.getNativeCalls()).toBe(0);
    }
  });

  test('keeps Android newline and legacy blurOnSubmit=false inputs on native handling', async () => {
    for (const evaluation of [
      { renderer: 'paper' as const, value: 'hello', submitBehavior: 'newline' as const },
      { renderer: 'fabric' as const, value: 'hello', blurOnSubmit: false },
      { renderer: 'paper' as const, value: 'hello', multiline: true },
    ]) {
      const harness = await createAppOnlyHarness(evaluation, true);
      const press = harness.tools.get('press_button')!;
      expect(await press.handler(press.parameters.parse({ button: 'ENTER', platform: 'android' }) as Record<string, unknown>))
        .toBe('Pressed ENTER');
      expect(harness.reactCalls).toEqual([]);
      expect(harness.getBlurCalls()).toBe(0);
      expect(harness.execCommands).toEqual([
        'adb -s "emulator-42" shell input keyevent 66',
      ]);
    }
  });

  test('blurs after submitting with legacy blurOnSubmit=true', async () => {
    const harness = await createAppOnlyHarness({ renderer: 'paper', value: 'hello', blurOnSubmit: true });
    const press = harness.tools.get('press_button')!;
    expect(await press.handler(press.parameters.parse({ button: 'ENTER', platform: 'auto' }) as Record<string, unknown>))
      .toBe('Pressed ENTER');
    expect(harness.reactCalls).toEqual([
      { type: 'submit', value: { nativeEvent: { text: 'hello' } } },
    ]);
    expect(harness.getBlurCalls()).toBe(1);
    expect(harness.getNativeCalls()).toBe(0);
  });

  test('leaves uncontrolled Paper and Fabric inputs for native handling', async () => {
    for (const renderer of ['paper', 'fabric'] as const) {
      const harness = await pressTextInputKeys(
        { renderer, defaultValue: 'hello' },
        { nativeAvailable: true, platform: 'android' },
      );
      expect(harness.reactCalls).toEqual([]);
      expect(harness.execCommands).toEqual([
        'adb -s "emulator-42" shell input keyevent 66',
        'adb -s "emulator-42" shell input keyevent 67',
      ]);
    }
  });

  test('uses IDB HID keys for uncontrolled Paper and Fabric inputs on iOS', async () => {
    for (const renderer of ['paper', 'fabric'] as const) {
      const harness = await pressTextInputKeys(
        { renderer, defaultValue: 'hello' },
        { nativeAvailable: true, platform: 'ios' },
      );
      expect(harness.reactCalls).toEqual([]);
      expect(harness.execCommands.filter((command) => command.startsWith('idb ui key'))).toEqual([
        'idb ui key 40 --udid "SIMULATOR123"',
        'idb ui key 42 --udid "SIMULATOR123"',
      ]);
    }
  });

  test('does not replay a possibly dispatched action after a CDP rejection', async () => {
    const harness = await createAppOnlyHarness('failure');
    const tool = harness.tools.get('tap_element')!;
    const result = await tool.handler(tool.parameters.parse({ label: 'Save' }) as Record<string, unknown>);
    expect(result).toContain('Could not evaluate');
    expect(harness.getNativeCalls()).toBe(0);
  });

  test('uses native fallback after a known pre-dispatch connection failure', async () => {
    const harness = await createAppOnlyHarness('pre-dispatch', true, 'SIMULATOR123');
    const tool = harness.tools.get('tap_element')!;
    const result = await tool.handler(tool.parameters.parse({ label: 'Save', platform: 'ios' }) as Record<string, unknown>);
    expect(result).toBe('Tapped "Save"');
    expect(harness.getNativeCalls()).toBeGreaterThan(0);
  });

  test('uses native fallback for other known pre-dispatch handler failures', async () => {
    const harness = await createAppOnlyHarness('pre-dispatch', true, 'SIMULATOR123');
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

  test('uses native fallback for the exact pre-dispatch evaluation timeout', async () => {
    const harness = await createAppOnlyHarness('timeout', true, 'SIMULATOR123');
    const cases = [
      ['tap_element', { label: 'Save', platform: 'ios' }, 'Tapped "Save"'],
      ['type_text', { text: 'hello', platform: 'ios' }, 'Typed "hello"'],
      ['long_press', { label: 'Save', x: 1, y: 2, platform: 'ios' }, 'Long pressed at (1, 2) for 1000ms'],
      ['swipe', { direction: 'up', platform: 'ios' }, 'Swiped up'],
      ['press_button', { button: 'ENTER', platform: 'ios' }, 'Pressed ENTER'],
    ] as const;
    for (const [name, args, expected] of cases) {
      const tool = harness.tools.get(name)!;
      expect(await tool.handler(tool.parameters.parse(args) as Record<string, unknown>)).toBe(expected);
    }
    expect(harness.getNativeCalls()).toBeGreaterThan(0);
  });

  test('requires a verified iOS target before explicit React-first actions', async () => {
    const harness = await createAppOnlyHarness('success', true, 'emulator-42');
    const cases = [
      ['tap_element', { label: 'Save', platform: 'ios' }],
      ['type_text', { text: 'hello', platform: 'ios' }],
      ['long_press', { label: 'Save', platform: 'ios' }],
      ['swipe', { direction: 'up', platform: 'ios' }],
      ['press_button', { button: 'ENTER', platform: 'ios' }],
      ['press_button', { button: 'DELETE', platform: 'ios' }],
    ] as const;
    for (const [name, args] of cases) {
      const tool = harness.tools.get(name)!;
      await tool.handler(tool.parameters.parse(args) as Record<string, unknown>);
    }
    expect(harness.evaluations).toHaveLength(0);
  });

  test('requires a verified Android target before explicit React-first actions', async () => {
    const harness = await createAppOnlyHarness('success', true, 'SIMULATOR123');
    const cases = [
      ['tap_element', { label: 'Save', platform: 'android' }],
      ['type_text', { text: 'hello', platform: 'android' }],
      ['long_press', { label: 'Save', platform: 'android' }],
      ['swipe', { direction: 'up', platform: 'android' }],
      ['press_button', { button: 'ENTER', platform: 'android' }],
      ['press_button', { button: 'DELETE', platform: 'android' }],
    ] as const;
    for (const [name, args] of cases) {
      const tool = harness.tools.get(name)!;
      await tool.handler(tool.parameters.parse(args) as Record<string, unknown>);
    }
    expect(harness.evaluations).toHaveLength(0);
  });

  test('never dispatches React handlers when the connected ID is shared across platforms', async () => {
    for (const platform of ['ios', 'android'] as const) {
      const harness = await createAppOnlyHarness('success', true, 'SHARED-DEVICE', true);
      const cases = [
        ['tap_element', { label: 'Save', platform }],
        ['type_text', { text: 'hello', platform }],
        ['long_press', { label: 'Save', platform }],
        ['swipe', { direction: 'up', platform }],
        ['press_button', { button: 'ENTER', platform }],
        ['press_button', { button: 'DELETE', platform }],
      ] as const;
      for (const [name, args] of cases) {
        const tool = harness.tools.get(name)!;
        await tool.handler(tool.parameters.parse(args) as Record<string, unknown>);
      }
      expect(harness.evaluations).toHaveLength(0);
    }
  });

  test('treats offline and unauthorized opposite Android IDs as collisions', async () => {
    for (const androidStatus of ['offline', 'unauthorized'] as const) {
      const harness = await createAppOnlyHarness(
        'success',
        true,
        'SHARED-DEVICE',
        true,
        undefined,
        androidStatus,
      );
      const cases = [
        ['tap_element', { label: 'Save', platform: 'ios' }],
        ['type_text', { text: 'hello', platform: 'ios' }],
        ['long_press', { label: 'Save', platform: 'ios' }],
        ['swipe', { direction: 'up', platform: 'ios' }],
        ['press_button', { button: 'ENTER', platform: 'ios' }],
        ['press_button', { button: 'DELETE', platform: 'ios' }],
      ] as const;
      for (const [name, args] of cases) {
        const tool = harness.tools.get(name)!;
        await tool.handler(tool.parameters.parse(args) as Record<string, unknown>);
      }
      expect(harness.evaluations).toHaveLength(0);
    }
  });

  test('keeps explicit React-first handling for a verified same-platform target', async () => {
    const harness = await createAppOnlyHarness('success', true, 'SIMULATOR123');
    const tool = harness.tools.get('tap_element')!;
    expect(await tool.handler(tool.parameters.parse({ label: 'Save', platform: 'ios' }) as Record<string, unknown>))
      .toBe('Tapped "Save"');
    expect(harness.evaluations).toHaveLength(1);
  });

  test('requires the opposite inventory before explicit React-first handling', async () => {
    for (const [platform, logicalId, unavailablePlatform] of [
      ['ios', 'SIMULATOR123', 'android'],
      ['android', 'emulator-42', 'ios'],
    ] as const) {
      const harness = await createAppOnlyHarness(
        'success',
        true,
        logicalId,
        false,
        unavailablePlatform,
      );
      const tool = harness.tools.get('tap_element')!;
      await tool.handler(tool.parameters.parse({ label: 'Save', platform }) as Record<string, unknown>);
      expect(harness.evaluations).toHaveLength(0);
      expect(harness.getNativeCalls()).toBeGreaterThan(0);
    }
  });

  test('keeps explicit coordinate actions native-direct', async () => {
    const harness = await createAppOnlyHarness('success', true, 'SIMULATOR123');
    const tool = harness.tools.get('tap_element')!;
    expect(await tool.handler(tool.parameters.parse({
      x: 10, y: 20, platform: 'ios',
    }) as Record<string, unknown>)).toBe('Tapped at (10, 20)');
    expect(harness.evaluations).toHaveLength(0);
  });

  test('keeps label React handling when long press has only one coordinate', async () => {
    for (const args of [
      { label: 'Save', x: 10, platform: 'auto' as const },
      { label: 'Save', y: 20, platform: 'auto' as const },
    ]) {
      const harness = await createAppOnlyHarness();
      const tool = harness.tools.get('long_press')!;
      expect(await tool.handler(tool.parameters.parse(args) as Record<string, unknown>))
        .toBe('Long pressed "Save"');
      expect(harness.evaluations).toHaveLength(1);
    }
  });

  test('does not use native fallback for a timed out evaluation with an ambiguous dispatch', async () => {
    const harness = await createAppOnlyHarness('ambiguous-timeout', true, 'SIMULATOR123');
    const tool = harness.tools.get('tap_element')!;
    const result = await tool.handler(tool.parameters.parse({ label: 'Save', platform: 'ios' }) as Record<string, unknown>);
    expect(result).toContain('Could not evaluate');
    expect(harness.execCommands).toHaveLength(0);
  });

  test('reports a pre-dispatch failure for a label-only long press', async () => {
    const harness = await createAppOnlyHarness('pre-dispatch', true, 'SIMULATOR123');
    const tool = harness.tools.get('long_press')!;
    const result = await tool.handler(tool.parameters.parse({ label: 'Save' }) as Record<string, unknown>);
    expect(result).toContain('Could not evaluate');
    expect(harness.getNativeCalls()).toBe(0);
  });
});
