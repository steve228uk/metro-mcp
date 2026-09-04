import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import type { ComponentNode, PluginContext, ToolHandlerResult } from '../plugin.js';
import { AppEvaluationError } from '../utils/evaluate-app.js';
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
    | 'timeout'
    | 'ambiguous-timeout'
    | 'app-error'
    | 'unhandled'
    | 'fabric-focused'
    | 'paper-focused'
    | 'fabric-empty'
    | 'paper-empty'
    | 'fabric-uncontrolled'
    | 'paper-uncontrolled' = 'success',
  nativeAvailable = false,
  inputBehavior: {
    submitBehavior?: 'newline' | 'submit' | 'blurAndSubmit';
    blurOnSubmit?: boolean;
    multiline?: boolean;
    value?: string;
  } = {},
  connectedLogicalDeviceId?: string,
  sharedInventoryDeviceId = false,
  unavailablePlatform?: 'ios' | 'android',
  androidStatus: 'device' | 'offline' | 'unauthorized' = 'device',
) {
  const tools = new Map<string, Tool>();
  let nativeCalls = 0;
  const execFileCalls: Array<{ command: string; args: string[] }> = [];
  const reactCalls: Array<{ type: 'submit' | 'change'; value: unknown }> = [];
  const evaluations: string[] = [];
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
    config: nativeAvailable ? {
      input: { nativeBackend: 'idb', idbCommand: 'idb' },
    } : {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    metro: { host: 'localhost', port: 8081, fetch: async () => new Response() },
    exec: async (command) => {
      nativeCalls++;
      if (command.includes('pull /sdcard/uidump.xml')) {
        await Bun.write('/tmp/metro-mcp-uidump.xml', '<node text="Save" content-desc="Save" bounds="[0,0][100,100]"/>');
      }
      if (nativeAvailable) return '';
      throw new Error('native inventory unavailable');
    },
    execFile: async (command, args) => {
      nativeCalls++;
      execFileCalls.push({ command, args });
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
        if (args[0] === 'devices') {
          const androidId = sharedInventoryDeviceId && connectedLogicalDeviceId
            ? connectedLogicalDeviceId
            : 'emulator-42';
          return Buffer.from(`List of devices attached\n${androidId}\t${androidStatus} model:Pixel_8\n`);
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
      evaluations.push(expression);
      if (evaluation === 'failure') throw new Error('CDP disconnected');
      if (evaluation === 'pre-dispatch') {
        throw new Error('Not connected to Metro. Use list_devices to check connection status.');
      }
      if (evaluation === 'timeout') throw new Error('App evaluation timed out');
      if (evaluation === 'ambiguous-timeout') {
        throw new Error('App evaluation timed out after 30ms');
      }
      if (evaluation === 'app-error') {
        throw new AppEvaluationError('Not connected to CDP target');
      }
      if (evaluation === 'unhandled') return false;
      if (evaluation.endsWith('-focused') || evaluation.endsWith('-empty') || evaluation.endsWith('-uncontrolled')) {
        const publicInstance = {
          isFocused: () => true,
          blur: () => { blurCalls++; },
        };
        const fabric = evaluation.startsWith('fabric-');
        const controlled = !evaluation.endsWith('-uncontrolled');
        const value = inputBehavior.value ?? (evaluation.endsWith('-empty') ? '' : 'hello');
        const host = {
          stateNode: fabric ? { canonical: { publicInstance } } : publicInstance,
          child: null,
          sibling: null,
        };
        const textInput = {
          type: { displayName: 'TextInput' },
          memoizedProps: {
            ...(controlled ? { value } : { defaultValue: value }),
            ...inputBehavior,
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
  return {
    tools,
    getNativeCalls: () => nativeCalls,
    execFileCalls,
    reactCalls,
    evaluations,
    getBlurCalls: () => blurCalls,
  };
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
    const harness = await createAppOnlyHarness('unhandled', true, {}, undefined, false);
    const press = harness.tools.get('press_button')!;
    for (const button of ['ENTER', 'DELETE'] as const) {
      const result = await press.handler(press.parameters.parse({ button, platform: 'android' }) as Record<string, unknown>);
      expect(result).toContain('backend=adb');
      expect(result).toContain('status=handled');
    }
    expect(harness.reactCalls).toEqual([]);
  });

  test('invokes focused controlled Paper and Fabric key handlers with exact payloads', async () => {
    for (const renderer of ['paper', 'fabric'] as const) {
      for (const [state, value] of [['focused', 'hello'], ['empty', '']] as const) {
        const harness = await createAppOnlyHarness(`${renderer}-${state}`);
        const press = harness.tools.get('press_button')!;
        for (const button of ['ENTER', 'DELETE'] as const) {
          expect(await press.handler(press.parameters.parse({ button, platform: 'auto' }) as Record<string, unknown>))
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
      const harness = await createAppOnlyHarness(`${renderer}-uncontrolled`, true, {}, 'SIMULATOR123');
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

  test('uses Android key events for uncontrolled Paper and Fabric inputs', async () => {
    for (const renderer of ['paper', 'fabric'] as const) {
      const harness = await createAppOnlyHarness(`${renderer}-uncontrolled`, true, {}, 'emulator-42');
      const press = harness.tools.get('press_button')!;
      for (const button of ['ENTER', 'DELETE'] as const) {
        const result = await press.handler(press.parameters.parse({
          button,
          platform: 'android',
        }) as Record<string, unknown>);
        expect(result).toContain('backend=adb');
        expect(result).toContain('status=handled');
      }
      expect(harness.reactCalls).toEqual([]);
      expect(harness.execFileCalls.filter(({ command, args }) =>
        command === 'adb' && args[4] === 'keyevent',
      )).toEqual([
        { command: 'adb', args: ['-s', 'emulator-42', 'shell', 'input', 'keyevent', '66'] },
        { command: 'adb', args: ['-s', 'emulator-42', 'shell', 'input', 'keyevent', '67'] },
      ]);
    }
  });

  test('deletes a complete non-BMP code point from controlled inputs', async () => {
    const harness = await createAppOnlyHarness('paper-focused', false, { value: 'A😀' });
    const press = harness.tools.get('press_button')!;
    expect(await press.handler(press.parameters.parse({ button: 'DELETE' }) as Record<string, unknown>))
      .toBe('Pressed DELETE');
    expect(harness.reactCalls).toEqual([
      { type: 'change', value: 'A' },
    ]);
  });

  test('preserves Android controlled TextInput submit and blur behavior', async () => {
    for (const renderer of ['paper', 'fabric'] as const) {
      for (const inputBehavior of [
        { submitBehavior: 'blurAndSubmit' as const },
        { blurOnSubmit: true },
        {},
      ]) {
        const blurred = await createAppOnlyHarness(
          `${renderer}-focused`,
          true,
          inputBehavior,
          'emulator-42',
        );
        const press = blurred.tools.get('press_button')!;
        expect(await press.handler(press.parameters.parse({
          button: 'ENTER',
          platform: 'android',
        }) as Record<string, unknown>)).toBe('Pressed ENTER');
        expect(blurred.reactCalls).toEqual([
          { type: 'submit', value: { nativeEvent: { text: 'hello' } } },
        ]);
        expect(blurred.getBlurCalls()).toBe(1);
        expect(blurred.execFileCalls.filter(({ command, args }) => command === 'idb' && args[0] === 'ui')).toHaveLength(0);
      }

      const submitted = await createAppOnlyHarness(
        `${renderer}-focused`,
        true,
        { submitBehavior: 'submit' },
        'emulator-42',
      );
      const submitPress = submitted.tools.get('press_button')!;
      expect(await submitPress.handler(submitPress.parameters.parse({
        button: 'ENTER',
        platform: 'android',
      }) as Record<string, unknown>)).toBe('Pressed ENTER');
      expect(submitted.reactCalls).toHaveLength(1);
      expect(submitted.getBlurCalls()).toBe(0);
    }
  });

  test('uses native Android ENTER for controlled newline behavior', async () => {
    for (const inputBehavior of [
      { submitBehavior: 'newline' as const },
      { blurOnSubmit: false },
      { multiline: true },
    ]) {
      const harness = await createAppOnlyHarness(
        'fabric-focused',
        true,
        inputBehavior,
      );
      const press = harness.tools.get('press_button')!;
      const result = await press.handler(press.parameters.parse({
        button: 'ENTER',
        platform: 'android',
      }) as Record<string, unknown>);
      expect(result).toContain('backend=adb');
      expect(result).toContain('status=handled');
      expect(harness.reactCalls).toEqual([]);
      expect(harness.getBlurCalls()).toBe(0);
      expect(harness.execFileCalls).toContainEqual({
        command: 'adb',
        args: ['-s', 'emulator-42', 'shell', 'input', 'keyevent', '66'],
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

  test('leaves uncontrolled Paper and Fabric inputs for native handling', async () => {
    for (const renderer of ['paper', 'fabric'] as const) {
      const harness = await createAppOnlyHarness(`${renderer}-uncontrolled`, true, {}, 'emulator-42');
      const keyPress = harness.tools.get('press_button')!;
      await keyPress.handler(keyPress.parameters.parse({ button: 'ENTER', platform: 'android' }) as Record<string, unknown>);
      await keyPress.handler(keyPress.parameters.parse({ button: 'DELETE', platform: 'android' }) as Record<string, unknown>);
      expect(harness.reactCalls).toEqual([]);
      expect(harness.execFileCalls).toContainEqual({ command: 'adb', args: ['-s', 'emulator-42', 'shell', 'input', 'keyevent', '66'] });
      expect(harness.execFileCalls).toContainEqual({ command: 'adb', args: ['-s', 'emulator-42', 'shell', 'input', 'keyevent', '67'] });
    }
  });

  test('uses IDB HID keys for uncontrolled Paper and Fabric inputs on iOS', async () => {
    for (const renderer of ['paper', 'fabric'] as const) {
      const harness = await createAppOnlyHarness(`${renderer}-uncontrolled`, true, {}, 'SIMULATOR123');
      const keyPress = harness.tools.get('press_button')!;
      await keyPress.handler(keyPress.parameters.parse({ button: 'ENTER', platform: 'ios' }) as Record<string, unknown>);
      await keyPress.handler(keyPress.parameters.parse({ button: 'DELETE', platform: 'ios' }) as Record<string, unknown>);
      expect(harness.reactCalls).toEqual([]);
      expect(harness.execFileCalls).toContainEqual({ command: 'idb', args: ['ui', 'key', '40', '--udid', 'SIMULATOR123'] });
      expect(harness.execFileCalls).toContainEqual({ command: 'idb', args: ['ui', 'key', '42', '--udid', 'SIMULATOR123'] });
    }
  });

  test('does not replay a possibly dispatched action after a CDP rejection', async () => {
    const harness = await createAppOnlyHarness('failure');
    const tool = harness.tools.get('tap_element')!;
    await expect(tool.handler(tool.parameters.parse({ label: 'Save' }) as Record<string, unknown>))
      .rejects.toThrow('CDP disconnected');
    expect(harness.getNativeCalls()).toBe(0);
  });

  test('uses native fallback after a known pre-dispatch connection failure', async () => {
    const harness = await createAppOnlyHarness('pre-dispatch', true, {}, 'SIMULATOR123');
    const tool = harness.tools.get('tap_element')!;
    const result = await tool.handler(tool.parameters.parse({ label: 'Save', platform: 'ios' }) as Record<string, unknown>);
    expect(result).toContain('Tapped "Save"');
    expect(result).toContain('backend=idb');
    expect(result).toContain('status=handled');
    expect(harness.getNativeCalls()).toBeGreaterThan(0);
  });

  test('does not replay native actions after an app-originated connection-looking error', async () => {
    const harness = await createAppOnlyHarness('app-error', true, {}, 'SIMULATOR123');
    const cases = [
      ['tap_element', { label: 'Save', platform: 'ios' }],
      ['type_text', { text: 'hello', platform: 'ios' }],
      ['long_press', { label: 'Save', platform: 'ios' }],
      ['swipe', { direction: 'up', platform: 'ios' }],
      ['press_button', { button: 'ENTER', platform: 'ios' }],
    ] as const;
    for (const [name, args] of cases) {
      const tool = harness.tools.get(name)!;
      await expect(tool.handler(tool.parameters.parse(args) as Record<string, unknown>))
        .rejects.toThrow('Not connected to CDP target');
    }
    expect(harness.execFileCalls.some((call) => call.command === 'idb')).toBe(false);
  });

  test('uses native fallback for other known pre-dispatch handler failures', async () => {
    const harness = await createAppOnlyHarness('pre-dispatch', true, {}, 'SIMULATOR123');
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

  test('uses native fallback for the exact pre-dispatch evaluation timeout', async () => {
    const harness = await createAppOnlyHarness('timeout', true, {}, 'SIMULATOR123');
    const cases = [
      ['tap_element', { label: 'Save', platform: 'ios' }, 'Tapped "Save"'],
      ['type_text', { text: 'hello', platform: 'ios' }, 'Typed "hello"'],
      ['long_press', { label: 'Save', x: 1, y: 2, platform: 'ios' }, 'Long pressed at (1, 2) for 1000ms'],
      ['swipe', { direction: 'up', platform: 'ios' }, 'Swiped up'],
      ['press_button', { button: 'ENTER', platform: 'ios' }, 'Pressed ENTER'],
    ] as const;
    for (const [name, args, expected] of cases) {
      const tool = harness.tools.get(name)!;
      const result = await tool.handler(tool.parameters.parse(args) as Record<string, unknown>);
      expect(result).toContain(expected);
      expect(result).toContain('status=handled');
    }
    expect(harness.getNativeCalls()).toBeGreaterThan(0);
  });

  test('requires a verified iOS target before explicit React-first actions', async () => {
    const harness = await createAppOnlyHarness('success', true, {}, 'emulator-42');
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
    const harness = await createAppOnlyHarness('success', true, {}, 'SIMULATOR123');
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
      const harness = await createAppOnlyHarness('success', true, {}, 'SHARED-DEVICE', true);
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
        {},
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
    const harness = await createAppOnlyHarness('success', true, {}, 'SIMULATOR123');
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
        {},
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
    const harness = await createAppOnlyHarness('success', true, {}, 'SIMULATOR123');
    const tool = harness.tools.get('tap_element')!;
    expect(await tool.handler(tool.parameters.parse({
      x: 10, y: 20, platform: 'ios',
    }) as Record<string, unknown>)).toContain('Tapped at (10, 20)');
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
    const harness = await createAppOnlyHarness('ambiguous-timeout', true, {}, 'SIMULATOR123');
    const tool = harness.tools.get('tap_element')!;
    await expect(tool.handler(tool.parameters.parse({
      label: 'Save',
      platform: 'ios',
    }) as Record<string, unknown>)).rejects.toThrow('App evaluation timed out after 30ms');
    expect(harness.execFileCalls.filter(({ command, args }) => command === 'idb' && args[0] === 'ui')).toHaveLength(0);
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
