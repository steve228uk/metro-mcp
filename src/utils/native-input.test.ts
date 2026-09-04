import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeInputController, discoverNativeProviders, normalizeLogicalPoint } from './native-input.js';

function fakeRunner() {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    exec: async () => '',
    execFile: async (command: string, args: string[], _options?: { maxBuffer?: number; timeout?: number }) => {
      calls.push({ command, args });
      if (command === 'which' && args[0] !== 'idb') throw new Error('not found');
      if (args[args.length - 1] === '--version') return Buffer.from('1.0.0');
      if (args.at(-1) === '--help' && args.at(-2) === 'ui') return Buffer.from('{describe-all,tap,text,swipe,button}');
      if (args.at(-1) === '--help' && args.at(-2) === 'tap') return Buffer.from('--duration DURATION');
      if (args.at(-1) === '--help' && args.at(-2) === 'swipe') return Buffer.from('--duration DURATION');
      if (args.at(-1) === '--help' && args.at(-2) === 'button') return Buffer.from('{APPLE_PAY,HOME,LOCK,SIDE_BUTTON,SIRI}');
      if (args.at(-1) === '--help') return Buffer.from('commands: ui describe');
      return Buffer.from('{}');
    },
  };
}

describe('native input providers', () => {
  test('discovers configured providers without invoking a shell', async () => {
    const runner = fakeRunner();
    const providers = await discoverNativeProviders({
      config: { simviewCommand: '/bin/echo', idbCommand: '/bin/echo' },
      runner,
    });

    expect(providers.every((provider) => provider.available)).toBe(true);
    expect(runner.calls.filter(({ args }) => args.at(-1) === '--version')).toEqual([
      { command: '/bin/echo', args: ['--version'] },
      { command: '/bin/echo', args: ['--version'] },
    ]);
  });

  test('bounds a SimView version probe and still dispatches through IDB', async () => {
    const runner = fakeRunner();
    const versionCalls: Array<{ command: string; args: string[]; timeout?: number }> = [];
    const baseExecFile = runner.execFile;
    runner.execFile = async (command, args, options) => {
      if (command === '/bin/echo' && args.at(-1) === '--version') {
        versionCalls.push({ command, args, timeout: options?.timeout });
        return new Promise<never>(() => {});
      }
      return baseExecFile(command, args);
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: '/bin/echo', idbCommand: 'idb' },
      runner,
      simviewRequestTimeoutMs: 20,
      simviewClientFactory: () => { throw new Error('unavailable SimView must not be connected'); },
    });

    const started = Date.now();
    await expect(controller.tap({ platform: 'ios', id: 'version-timeout' }, 1, 2)).resolves.toMatchObject({
      backend: 'idb', status: 'handled', dispatched: true, dispatch: 'submitted',
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(versionCalls).toHaveLength(1);
    expect(versionCalls[0]?.timeout).toBeGreaterThan(0);
    expect(versionCalls[0]?.timeout).toBeLessThanOrEqual(20);
  });

  test('bounds a stalled IDB version probe', async () => {
    const runner = fakeRunner();
    const versionCalls: Array<{ timeout?: number }> = [];
    const baseExecFile = runner.execFile;
    runner.execFile = async (command, args, options) => {
      if (command === 'idb' && args.at(-1) === '--version') {
        versionCalls.push({ timeout: options?.timeout });
        return new Promise<never>(() => {});
      }
      return baseExecFile(command, args, options);
    };

    const started = Date.now();
    const providers = await discoverNativeProviders(
      { config: { nativeBackend: 'idb', idbCommand: 'idb' }, runner },
      Date.now() + 20,
    );

    expect(providers[0]).toMatchObject({ available: false });
    expect(versionCalls).toHaveLength(1);
    expect(versionCalls[0]?.timeout).toBeGreaterThan(0);
    expect(versionCalls[0]?.timeout).toBeLessThanOrEqual(20);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('bounds a stalled IDB help probe after a successful version check', async () => {
    const runner = fakeRunner();
    const helpCalls: Array<{ args: string[]; timeout?: number }> = [];
    const baseExecFile = runner.execFile;
    runner.execFile = async (command, args, options) => {
      if (command === 'idb' && args.at(-1) === '--help') {
        helpCalls.push({ args, timeout: options?.timeout });
        return new Promise<never>(() => {});
      }
      return baseExecFile(command, args, options);
    };

    const started = Date.now();
    const providers = await discoverNativeProviders(
      { config: { nativeBackend: 'idb', idbCommand: 'idb' }, runner },
      Date.now() + 20,
    );

    expect(providers[0]).toMatchObject({ available: false });
    expect(helpCalls).toHaveLength(1);
    expect(helpCalls[0]?.args).toEqual(['--help']);
    expect(helpCalls[0]?.timeout).toBeGreaterThan(0);
    expect(helpCalls[0]?.timeout).toBeLessThanOrEqual(20);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('dispatches through SimView without probing a stalled IDB installation', async () => {
    const runner = fakeRunner();
    const baseExecFile = runner.execFile;
    runner.execFile = async (command, args, options) => {
      if (command === 'which' && args[0] === 'simview') return Buffer.from('/usr/local/bin/simview');
      if (command === 'idb' && args.at(-1) === '--version') return new Promise<never>(() => {});
      return baseExecFile(command, args, options);
    };
    const calls: string[] = [];
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'tap'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(name);
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:simview-first', capabilities: { input: { touch: true } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        return { structuredContent: { accepted: true, inputDispatched: true } };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: 'simview', idbCommand: 'idb' },
      runner,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
      simviewRequestTimeoutMs: 50,
    });

    const started = Date.now();
    await expect(controller.tap({ platform: 'ios', id: 'simview-first' }, 1, 2)).resolves.toMatchObject({
      backend: 'simview', status: 'handled', dispatched: true, dispatch: 'submitted',
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(calls).toContain('tap');
    expect(runner.calls.some(({ command, args }) => command === 'idb' && args.at(-1) === '--version')).toBe(false);
    await controller.close();
  });

  test('bounds slow SimView plugin discovery and still dispatches through IDB', async () => {
    const runner = fakeRunner();
    let directoryReads = 0;
    const fileSystem = {
      executable: async () => false,
      readDirectory: async () => {
        directoryReads += 1;
        return new Promise<never>(() => {});
      },
      readFile: async () => '',
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', idbCommand: 'idb' },
      runner,
      simviewRequestTimeoutMs: 20,
      simviewFileSystem: fileSystem,
      simviewClientFactory: () => { throw new Error('unavailable SimView must not be connected'); },
    });

    const started = Date.now();
    await expect(controller.tap({ platform: 'ios', id: 'filesystem-timeout' }, 1, 2)).resolves.toMatchObject({
      backend: 'idb', status: 'handled', dispatched: true, dispatch: 'submitted',
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(directoryReads).toBe(1);
  });

  test('retries unavailable provider discovery so a later installation can recover', async () => {
    const runner = fakeRunner();
    const baseExecFile = runner.execFile;
    let simviewInstalled = false;
    runner.execFile = async (command, args, options) => {
      if (command === 'which' && args[0] === 'simview') {
        runner.calls.push({ command, args });
        if (!simviewInstalled) throw new Error('simview is not installed');
        return Buffer.from('/usr/local/bin/simview');
      }
      if (command === '/usr/local/bin/simview' && args.at(-1) === '--version') return Buffer.from('0.4.0');
      return baseExecFile(command, args, options);
    };
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'tap'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:recoverable-device', capabilities: { input: { touch: true } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        return { structuredContent: { accepted: true, inputDispatched: true } };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', idbCommand: 'idb' },
      runner,
      simviewFileSystem: {
        executable: async () => false,
        readDirectory: async () => [],
        readFile: async () => '',
      },
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });

    await expect(controller.tap({ platform: 'ios', id: 'recoverable-device' }, 1, 2)).resolves.toMatchObject({
      backend: 'idb', status: 'handled', dispatched: true,
    });
    simviewInstalled = true;
    await expect(controller.tap({ platform: 'ios', id: 'recoverable-device' }, 3, 4)).resolves.toMatchObject({
      backend: 'simview', status: 'handled', dispatched: true,
    });
    expect(runner.calls.filter(({ command, args }) => command === 'which' && args[0] === 'simview')).toHaveLength(2);
    await controller.close();
  });

  test('keeps a PATH SimView ahead of a stalled plugin cache scan', async () => {
    const runner = fakeRunner();
    const baseExecFile = runner.execFile;
    runner.execFile = async (command, args, options) => {
      if (command === 'which' && args[0] === 'simview') {
        runner.calls.push({ command, args });
        return Buffer.from('/usr/local/bin/simview');
      }
      return baseExecFile(command, args, options);
    };
    let directoryReads = 0;
    const fileSystem = {
      executable: async () => false,
      readDirectory: async () => {
        directoryReads += 1;
        return new Promise<never>(() => {});
      },
      readFile: async () => '',
    };
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'tap'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:path-simview', capabilities: { input: { touch: true } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        return { structuredContent: { accepted: true, inputDispatched: true } };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', idbCommand: 'idb' },
      runner,
      simviewRequestTimeoutMs: 100,
      simviewFileSystem: fileSystem,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });

    await expect(controller.tap({ platform: 'ios', id: 'path-simview' }, 1, 2)).resolves.toMatchObject({
      backend: 'simview', status: 'handled', dispatched: true,
    });
    expect(directoryReads).toBe(0);
    expect(runner.calls.some(({ command, args }) => command === 'which' && args[0] === 'simview')).toBe(true);
  });

  test('validates plugin manifests and discovers the newest installed SimView version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metro-mcp-simview-'));
    try {
      for (const [version, valid] of [['0.3.0', false] as const, ['0.4.0', true] as const]) {
        const install = join(root, version);
        await mkdir(join(install, 'bin'), { recursive: true });
        await mkdir(join(install, '.codex-plugin'));
        await writeFile(join(install, 'bin/simview'), '#!/bin/sh\nprintf 0.4.0\n');
        await chmod(join(install, 'bin/simview'), 0o755);
        await writeFile(join(install, '.codex-plugin/plugin.json'), JSON.stringify({ name: valid ? 'simview' : 'other', repository: 'https://github.com/toolingtools/SimView' }));
        await writeFile(join(install, '.mcp.json'), JSON.stringify({ mcpServers: { simview: { command: './bin/simview', args: ['mcp'] } } }));
      }
      const providers = await discoverNativeProviders({ config: { nativeBackend: 'simview' }, runner: fakeRunner(), simviewPluginRoots: [root] });
      expect(providers).toHaveLength(1);
      expect(providers[0]?.command).toBe(join(root, '0.4.0/bin/simview'));

      const spaced = join(root, 'bin with space');
      await writeFile(spaced, '#!/bin/sh\nprintf 0.4.0\n');
      await chmod(spaced, 0o755);
      const configuredRunner = fakeRunner();
      const configured = await discoverNativeProviders({ config: { nativeBackend: 'simview', simviewCommand: spaced }, runner: configuredRunner });
      expect(configured[0]?.command).toBe(spaced);
      expect(configuredRunner.calls[0]).toEqual({ command: spaced, args: ['--version'] });
      const argumentRunner = fakeRunner();
      const withArgument = await discoverNativeProviders({ config: { nativeBackend: 'simview', simviewCommand: `${spaced} --test-mode` }, runner: argumentRunner });
      expect(withArgument[0]).toMatchObject({ command: spaced, args: ['--test-mode'] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('uses supported IDB syntax and concrete simulator UDID', async () => {
    const runner = fakeRunner();
    const controller = new NativeInputController({
      config: { nativeBackend: 'idb', idbCommand: 'idb' },
      runner,
    });
    const target = { platform: 'ios' as const, id: 'FAKE-IOS-UDID' };

    expect((await controller.tap(target, 12, 34)).status).toBe('handled');
    expect((await controller.longPress(target, 12, 34, 800)).status).toBe('handled');
    expect((await controller.swipe(target, { x: 10, y: 20 }, { x: 30, y: 40 }, 300)).status).toBe('handled');
    expect((await controller.typeText(target, 'hello world')).status).toBe('handled');

    expect(runner.calls.filter(({ args }) => args[0] === 'ui' && args.includes('--udid'))).toEqual([
      { command: 'idb', args: ['ui', 'tap', '12', '34', '--udid', target.id] },
      { command: 'idb', args: ['ui', 'tap', '12', '34', '--duration', '0.8', '--udid', target.id] },
      { command: 'idb', args: ['ui', 'swipe', '10', '20', '30', '40', '--duration', '0.3', '--udid', target.id] },
      { command: 'idb', args: ['ui', 'text', 'hello world', '--udid', target.id] },
    ]);
    expect(runner.calls.some(({ args }) => args.includes('--by-label') || args.includes('long-press'))).toBe(false);
  });

  test('rounds fractional logical points only at the IDB CLI boundary', async () => {
    const runner = fakeRunner();
    const controller = new NativeInputController({ config: { nativeBackend: 'idb', idbCommand: 'idb' }, runner });
    const target = { platform: 'ios' as const, id: 'fractional-points' };
    try {
      await controller.tap(target, 12.2, 34.8);
      await controller.longPress(target, 12.8, 34.2, 500);
      await controller.swipe(target, { x: 10.4, y: 20.6 }, { x: 30.6, y: 40.4 }, 300);
      expect(runner.calls.filter(({ args }) => args[0] === 'ui' && args.includes('--udid')).map(({ args }) => args.slice(0, args.indexOf('--udid')))).toEqual([
        ['ui', 'tap', '12', '35'],
        ['ui', 'tap', '13', '34', '--duration', '0.5'],
        ['ui', 'swipe', '10', '21', '31', '40', '--duration', '0.3'],
      ]);
    } finally {
      await controller.close();
    }
  });

  test('accepts IDB versions without --version when read-only help exposes supported UI commands', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = {
      calls,
      exec: async () => '',
      execFile: async (command: string, args: string[]) => {
        calls.push({ command, args });
        if (args.at(-1) === '--version') throw new Error('unrecognized arguments: --version');
        if (args.at(-1) === '--help' && args.at(-2) === 'ui') return Buffer.from('describe-all tap text swipe button');
        if (args.at(-1) === '--help') return Buffer.from('commands: describe ui list');
        return Buffer.from('ok');
      },
    };
    const providers = await discoverNativeProviders({ config: { nativeBackend: 'idb', idbCommand: '/bin/idb' }, runner });
    expect(providers[0]).toMatchObject({ available: true });
    const controller = new NativeInputController({ config: { nativeBackend: 'idb', idbCommand: '/bin/idb' }, runner });
    expect((await controller.tap({ platform: 'ios', id: 'fake-udid' }, 1, 2)).status).toBe('handled');
    expect(calls.map(({ args }) => args)).toContainEqual(['ui', 'tap', '1', '2', '--udid', 'fake-udid']);
  });

  test('rejects an IDB binary when both version and supported UI help probes fail', async () => {
    const runner = {
      calls: [] as Array<{ command: string; args: string[] }>,
      exec: async () => '',
      execFile: async (command: string, args: string[]) => {
        runner.calls.push({ command, args });
        throw new Error('unsupported');
      },
    };
    const providers = await discoverNativeProviders({ config: { nativeBackend: 'idb', idbCommand: '/bin/idb' }, runner });
    expect(providers[0]).toMatchObject({ available: false });
  });

  test('scopes Android actions to the selected serial and reports unsupported iOS buttons', async () => {
    const runner = fakeRunner();
    const controller = new NativeInputController({ config: { nativeBackend: 'idb', idbCommand: '/bin/echo' }, runner });
    const android = { platform: 'android' as const, id: 'emulator-5556' };
    expect((await controller.tap(android, 1, 2)).dispatched).toBe(true);
    expect(runner.calls.at(-1)).toEqual({ command: 'adb', args: ['-s', android.id, 'shell', 'input', 'tap', '1', '2'] });
    expect((await controller.typeText(android, `a b'c\\d$e;f`)).dispatched).toBe(true);
    expect(runner.calls.at(-1)).toEqual({ command: 'adb', args: ['-s', android.id, 'shell', 'input', 'text', `'a%sb'\\''c\\d$e;f'`] });
    expect((await controller.button({ platform: 'ios', id: 'ios-device' }, 'ENTER')).status).toBe('unsupported');
  });

  test('discovers IDB ui key as a provider capability', async () => {
    const runner = fakeRunner();
    const baseExecFile = runner.execFile;
    runner.execFile = async (command, args) => {
      if (args.at(-1) === '--help' && args.at(-2) === 'ui') return Buffer.from('{key}');
      return baseExecFile(command, args);
    };
    const providers = await discoverNativeProviders({ config: { nativeBackend: 'idb', idbCommand: 'idb' }, runner });
    expect(providers[0]?.capabilities?.has('key')).toBe(true);
  });

  test('uses IDB ui key HID codes for iOS enter and delete', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = {
      calls,
      exec: async () => '',
      execFile: async (command: string, args: string[]) => {
        calls.push({ command, args });
        if (args.at(-1) === '--version') return Buffer.from('1.0.0');
        if (args.at(-1) === '--help' && args.at(-2) === 'ui') return Buffer.from('{key}');
        if (args.at(-1) === '--help') return Buffer.from('commands: ui');
        return Buffer.from('ok');
      },
    };
    const controller = new NativeInputController({ config: { nativeBackend: 'idb', idbCommand: 'idb' }, runner });
    const target = { platform: 'ios' as const, id: 'key-udid' };
    await expect(controller.button(target, 'ENTER')).resolves.toMatchObject({ backend: 'idb', status: 'handled', dispatched: true });
    await expect(controller.button(target, 'DELETE')).resolves.toMatchObject({ backend: 'idb', status: 'handled', dispatched: true });
    expect(calls.filter(({ args }) => args.includes('--udid')).map(({ args }) => args)).toEqual([
      ['ui', 'key', '40', '--udid', target.id],
      ['ui', 'key', '42', '--udid', target.id],
    ]);
  });

  test('dispatches iOS enter and delete through SimView named keys when available', async () => {
    const runner = fakeRunner();
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'press_key'].map((name) => ({ name })) }),
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push({ name, arguments: args });
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:key-device', capabilities: { input: { touch: true, keys: ['return', 'delete'] } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        return { structuredContent: { accepted: true } };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'simview', simviewCommand: '/bin/echo' },
      runner,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });
    const target = { platform: 'ios' as const, id: 'key-device' };
    await expect(controller.button(target, 'ENTER')).resolves.toMatchObject({ backend: 'simview', status: 'handled', dispatched: true });
    await expect(controller.button(target, 'DELETE')).resolves.toMatchObject({ backend: 'simview', status: 'handled', dispatched: true });
    expect(calls.filter(({ name }) => name === 'press_key').map(({ arguments: args }) => args)).toEqual([
      { key: 'return' },
      { key: 'delete' },
    ]);
    expect(runner.calls.some(({ args }) => args.includes('ui') && args.includes('key'))).toBe(false);
  });

  test('falls through to IDB when SimView does not advertise press_key', async () => {
    const runner = fakeRunner();
    const baseExecFile = runner.execFile;
    runner.execFile = async (command, args) => {
      if (command === 'idb' && args.at(-1) === '--help' && args.at(-2) === 'ui') return Buffer.from('{key}');
      return baseExecFile(command, args);
    };
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:key-device', capabilities: { input: { touch: true } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        return { structuredContent: { accepted: true } };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: '/bin/echo', idbCommand: 'idb' },
      runner,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });
    await expect(controller.button({ platform: 'ios', id: 'key-device' }, 'ENTER')).resolves.toMatchObject({ backend: 'idb', status: 'handled', dispatched: true });
    expect(runner.calls).toContainEqual({ command: 'idb', args: ['ui', 'key', '40', '--udid', 'key-device'] });
  });

  test('falls through to IDB when SimView excludes a key before dispatch', async () => {
    const runner = fakeRunner();
    const baseExecFile = runner.execFile;
    runner.execFile = async (command, args) => {
      if (command === 'idb' && args.at(-1) === '--help' && args.at(-2) === 'ui') return Buffer.from('{key}');
      return baseExecFile(command, args);
    };
    const calls: string[] = [];
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'press_key'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(name);
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:key-device', capabilities: { input: { touch: true, keys: [] } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        return { structuredContent: { accepted: true } };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: '/bin/echo', idbCommand: 'idb' },
      runner,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });
    await expect(controller.button({ platform: 'ios', id: 'key-device' }, 'DELETE')).resolves.toMatchObject({ backend: 'idb', status: 'handled', dispatched: true });
    expect(calls).not.toContain('press_key');
    expect(runner.calls).toContainEqual({ command: 'idb', args: ['ui', 'key', '42', '--udid', 'key-device'] });
  });

  test('does not fall through after an accepted SimView key receipt', async () => {
    const runner = fakeRunner();
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'press_key'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:key-device', capabilities: { input: { touch: true } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        return { structuredContent: { accepted: true } };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: '/bin/echo', idbCommand: 'idb' },
      runner,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });
    await expect(controller.button({ platform: 'ios', id: 'key-device' }, 'ENTER')).resolves.toMatchObject({ backend: 'simview', status: 'handled', dispatched: true });
    expect(runner.calls.some(({ command, args }) => command === 'idb' && args.includes('ui') && args.includes('key'))).toBe(false);
  });

  test('normalizes logical points using current device geometry and clamps edges', () => {
    expect(normalizeLogicalPoint({ x: 540, y: 960 }, 1080, 1920)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizeLogicalPoint({ x: -1, y: 3000 }, 1080, 1920)).toEqual({ x: 0, y: 1 });
  });

  test('serializes a shared SimView client, refreshes geometry, and closes once', async () => {
    const runner = fakeRunner();
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    let closed = 0;
    let connectedDevice = 'ios:device-a';
    let factoryArgs: string[] = [];
    let cleanup: (() => void | Promise<void>) | undefined;
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'tap'].map((name) => ({ name })) }),
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push({ name, arguments: args });
        if (name === 'connect_device') connectedDevice = String(args.deviceId);
        if (name === 'get_simview_state') return { structuredContent: { device: { id: connectedDevice, capabilities: { input: { touch: true, text: 'unicode', buttons: ['home'] } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        return { structuredContent: { accepted: true } };
      },
      close: async () => { closed += 1; },
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'simview', simviewCommand: '/bin/echo mcp' },
      runner,
      registerCleanup: (callback) => { cleanup = callback; },
      simviewClientFactory: (_command, args) => { factoryArgs = args; return { client, transport: { close: async () => {} } }; },
    });
    const first = controller.tap({ platform: 'ios', id: 'device-a' }, 200, 400);
    const second = controller.tap({ platform: 'ios', id: 'device-b' }, 100, 200);
    expect((await first).dispatch).toBe('submitted');
    expect((await second).dispatch).toBe('submitted');
    expect(calls.filter((call) => call.name === 'connect_device').map((call) => call.arguments.deviceId).sort()).toEqual(['ios:device-a', 'ios:device-b']);
    expect(factoryArgs).toEqual(['mcp']);
    expect(calls.filter((call) => call.name === 'tap').map((call) => call.arguments)).toContainEqual({ x: 0.5, y: 0.5 });
    await cleanup?.();
    await cleanup?.();
    expect(closed).toBe(1);
  });

  test('rejects non-ASCII text when IDB is the selected backend', async () => {
    const runner = fakeRunner();
    const controller = new NativeInputController({ config: { nativeBackend: 'idb', idbCommand: '/bin/echo' }, runner });
    const response = await controller.typeText({ platform: 'ios', id: 'fake-udid' }, 'café');
    expect(response).toMatchObject({ backend: 'idb', status: 'unsupported', dispatch: 'not-sent' });
    expect(runner.calls.some(({ args }) => args.includes('café'))).toBe(false);
  });

  test('invalidates a cached SimView session when a target switch cannot refresh state', async () => {
    const runner = fakeRunner();
    const connected: string[] = [];
    let active = '';
    let closed = 0;
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'tap'].map((name) => ({ name })) }),
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        if (name === 'connect_device') { active = String(args.deviceId); connected.push(active); return { structuredContent: { connected: true } }; }
        if (name === 'get_simview_state' && active === 'ios:device-b') return { isError: true };
        if (name === 'get_simview_state') return { structuredContent: { device: { id: active, capabilities: { input: { touch: true, text: 'unicode', buttons: [] } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        return { structuredContent: { accepted: true } };
      },
      close: async () => { closed += 1; },
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'simview', simviewCommand: '/bin/echo' },
      runner,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });
    expect((await controller.tap({ platform: 'ios', id: 'device-a' }, 1, 2)).status).toBe('handled');
    expect((await controller.tap({ platform: 'ios', id: 'device-b' }, 1, 2)).status).toBe('unavailable');
    expect((await controller.tap({ platform: 'ios', id: 'device-a' }, 1, 2)).status).toBe('handled');
    expect(connected).toEqual(['ios:device-a', 'ios:device-b', 'ios:device-a']);
    expect(closed).toBe(1);
  });

  test('stops on an explicit SimView rejection and does not call IDB', async () => {
    const runner = fakeRunner();
    const calls: string[] = [];
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'tap'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(name);
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:device-a', capabilities: { input: { touch: true, text: 'unicode', buttons: [] } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        return { structuredContent: { accepted: false } };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: '/bin/echo', idbCommand: 'idb' },
      runner,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });
    const response = await controller.tap({ platform: 'ios', id: 'device-a' }, 1, 2);
    expect(response).toMatchObject({ backend: 'simview', status: 'failed', dispatched: false, dispatch: 'not-sent' });
    expect(runner.calls.some(({ command, args }) => command === 'idb' && args[0] === 'ui' && args.includes('--udid'))).toBe(false);
    expect(calls).toContain('tap');
  });

  test('falls back to IDB when SimView cannot connect before dispatch', async () => {
    const runner = fakeRunner();
    const calls: string[] = [];
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'tap'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(name);
        if (name === 'connect_device') return { isError: true };
        return { structuredContent: {} };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: '/bin/echo', idbCommand: 'idb' },
      runner,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });

    await expect(controller.tap({ platform: 'ios', id: 'device-a' }, 1, 2)).resolves.toMatchObject({
      backend: 'idb', status: 'handled', dispatched: true, dispatch: 'submitted',
    });
    expect(calls).toEqual(['connect_device']);
    expect(runner.calls).toContainEqual({ command: 'idb', args: ['ui', 'tap', '1', '2', '--udid', 'device-a'] });
  });

  test('bounds an initial SimView handshake and falls back to IDB', async () => {
    const runner = fakeRunner();
    let closed = 0;
    let transportClosed = 0;
    const client = {
      connect: async () => new Promise<void>(() => {}),
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ isError: true }),
      close: async () => { closed += 1; return new Promise<never>(() => {}); },
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: '/bin/echo', idbCommand: 'idb' },
      runner,
      simviewRequestTimeoutMs: 20,
      simviewClientFactory: () => ({ client, transport: { close: async () => { transportClosed += 1; return new Promise<never>(() => {}); } } }),
    });

    const started = Date.now();
    await expect(controller.tap({ platform: 'ios', id: 'device-a' }, 1, 2)).resolves.toMatchObject({
      backend: 'idb', status: 'handled', dispatched: true, dispatch: 'submitted',
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(closed).toBe(1);
    expect(transportClosed).toBe(1);
    expect(runner.calls).toContainEqual({ command: 'idb', args: ['ui', 'tap', '1', '2', '--udid', 'device-a'] });
  });

  test('detaches resources after repeated timed-out SimView handshakes', async () => {
    const runner = fakeRunner();
    let closed = 0;
    let transportClosed = 0;
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: '/bin/echo', idbCommand: 'idb' },
      runner,
      simviewRequestTimeoutMs: 20,
      simviewClientFactory: () => ({
        client: {
          connect: async () => new Promise<void>(() => {}),
          listTools: async () => ({ tools: [] }),
          callTool: async () => ({ isError: true }),
          close: async () => { closed += 1; return new Promise<never>(() => {}); },
        },
        transport: { close: async () => { transportClosed += 1; return new Promise<never>(() => {}); } },
      }),
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(controller.tap({ platform: 'ios', id: `repeat-${attempt}` }, 1, 2)).resolves.toMatchObject({ backend: 'idb', status: 'handled' });
    }
    expect(closed).toBe(3);
    expect(transportClosed).toBe(3);
    expect((controller as unknown as { resources: Set<unknown> }).resources.size).toBe(0);
    await controller.close();
    expect(closed).toBe(3);
    expect(transportClosed).toBe(3);
  });

  test('bounds a cached SimView state refresh, closes it, and falls back to IDB', async () => {
    const runner = fakeRunner();
    let stateReads = 0;
    let closed = 0;
    let transportClosed = 0;
    const calls: string[] = [];
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'tap'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(name);
        if (name === 'get_simview_state' && ++stateReads > 2) return new Promise<never>(() => {});
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:device-a', capabilities: { input: { touch: true } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        return { structuredContent: { accepted: true, inputDispatched: true } };
      },
      close: async () => { closed += 1; return new Promise<never>(() => {}); },
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: '/bin/echo', idbCommand: 'idb' },
      runner,
      simviewRequestTimeoutMs: 20,
      simviewClientFactory: () => ({ client, transport: { close: async () => { transportClosed += 1; return new Promise<never>(() => {}); } } }),
    });

    await expect(controller.tap({ platform: 'ios', id: 'device-a' }, 1, 2)).resolves.toMatchObject({ backend: 'simview', status: 'handled' });
    const started = Date.now();
    await expect(controller.tap({ platform: 'ios', id: 'device-a' }, 3, 4)).resolves.toMatchObject({
      backend: 'idb', status: 'handled', dispatched: true, dispatch: 'submitted',
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(closed).toBe(1);
    expect(transportClosed).toBe(1);
    expect(calls.filter((name) => name === 'tap')).toHaveLength(1);
    expect(runner.calls).toContainEqual({ command: 'idb', args: ['ui', 'tap', '3', '4', '--udid', 'device-a'] });
  });

  test('bounds a cached SimView observation refresh, closes it, and falls back to IDB', async () => {
    const runner = fakeRunner();
    let observations = 0;
    let closed = 0;
    const calls: string[] = [];
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'tap'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(name);
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:device-a', capabilities: { input: { touch: true } } } } };
        if (name === 'observe_screen' && ++observations > 2) return new Promise<never>(() => {});
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        return { structuredContent: { accepted: true, inputDispatched: true } };
      },
      close: async () => { closed += 1; },
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: '/bin/echo', idbCommand: 'idb' },
      runner,
      simviewRequestTimeoutMs: 20,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });

    await expect(controller.tap({ platform: 'ios', id: 'device-a' }, 1, 2)).resolves.toMatchObject({ backend: 'simview', status: 'handled' });
    const started = Date.now();
    await expect(controller.tap({ platform: 'ios', id: 'device-a' }, 3, 4)).resolves.toMatchObject({
      backend: 'idb', status: 'handled', dispatched: true, dispatch: 'submitted',
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(closed).toBe(1);
    expect(calls.filter((name) => name === 'tap')).toHaveLength(1);
    expect(runner.calls).toContainEqual({ command: 'idb', args: ['ui', 'tap', '3', '4', '--udid', 'device-a'] });
  });

  test('falls back to IDB when a cached SimView session refresh fails before dispatch', async () => {
    const runner = fakeRunner();
    const calls: string[] = [];
    let refreshes = 0;
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'tap'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(name);
        if (name === 'get_simview_state' && ++refreshes > 2) return { isError: true };
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:device-a', capabilities: { input: { touch: true, text: 'unicode', buttons: [] } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        return { structuredContent: { accepted: true, inputDispatched: true } };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: '/bin/echo', idbCommand: 'idb' },
      runner,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });

    await expect(controller.tap({ platform: 'ios', id: 'device-a' }, 1, 2)).resolves.toMatchObject({ backend: 'simview', status: 'handled' });
    await expect(controller.tap({ platform: 'ios', id: 'device-a' }, 3, 4)).resolves.toMatchObject({
      backend: 'idb', status: 'handled', dispatched: true, dispatch: 'submitted',
    });
    expect(calls.filter((name) => name === 'tap')).toHaveLength(1);
    expect(runner.calls).toContainEqual({ command: 'idb', args: ['ui', 'tap', '3', '4', '--udid', 'device-a'] });
  });

  test('falls back to IDB label lookup when SimView cannot connect before dispatch', async () => {
    const runner = fakeRunner();
    const baseExecFile = runner.execFile;
    runner.execFile = async (command, args) => {
      if (command === 'idb' && args[0] === 'ui' && args[1] === 'describe-all') {
        return Buffer.from(JSON.stringify([{ label: 'Continue', frame: { x: 10, y: 20, width: 80, height: 40 } }]));
      }
      return baseExecFile(command, args);
    };
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'find_elements', 'tap_element'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        if (name === 'connect_device') return { isError: true };
        return { structuredContent: {} };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: '/bin/echo', idbCommand: 'idb' },
      runner,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });

    await expect(controller.tapLabel({ platform: 'ios', id: 'device-a' }, 'Continue')).resolves.toMatchObject({
      backend: 'idb', status: 'handled', dispatched: true, dispatch: 'submitted',
    });
    expect(runner.calls).toContainEqual({ command: 'idb', args: ['ui', 'tap', '50', '40', '--udid', 'device-a'] });
  });

  test('shares the discovery deadline with a stalled SimView semantic handshake', async () => {
    const runner = fakeRunner();
    const baseExecFile = runner.execFile;
    runner.execFile = async (command, args) => {
      if (command === '/bin/echo' && args.at(-1) === '--version') {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return Buffer.from('0.4.0');
      }
      if (command === 'idb' && args[0] === 'ui' && args[1] === 'describe-all') {
        return Buffer.from(JSON.stringify([{ label: 'Continue', frame: { x: 10, y: 20, width: 80, height: 40 } }]));
      }
      return baseExecFile(command, args);
    };
    const calls: string[] = [];
    const client = {
      connect: async () => { calls.push('connect'); await new Promise((resolve) => setTimeout(resolve, 50)); },
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'find_elements', 'tap_element'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(name);
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:semantic-handshake', capabilities: { input: { touch: true } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        if (name === 'find_elements') return { structuredContent: { matches: [{ ref: 'element:1' }] } };
        return { structuredContent: { accepted: true, inputDispatched: true } };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: '/bin/echo', idbCommand: 'idb' },
      runner,
      simviewRequestTimeoutMs: 60,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });

    const started = Date.now();
    await expect(controller.tapLabel({ platform: 'ios', id: 'semantic-handshake' }, 'Continue')).resolves.toMatchObject({
      backend: 'idb', status: 'handled', dispatched: true, dispatch: 'submitted',
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(calls).toContain('connect');
    expect(calls).not.toContain('tap_element');
    expect(runner.calls.some(({ command, args }) => command === 'idb' && args[0] === 'ui' && args[1] === 'tap' && !args.includes('--help'))).toBe(true);
  });

  test('shares the discovery deadline with a stalled SimView semantic search', async () => {
    const runner = fakeRunner();
    const baseExecFile = runner.execFile;
    runner.execFile = async (command, args) => {
      if (command === '/bin/echo' && args.at(-1) === '--version') {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return Buffer.from('0.4.0');
      }
      if (command === 'idb' && args[0] === 'ui' && args[1] === 'describe-all') {
        return Buffer.from(JSON.stringify([{ label: 'Continue', frame: { x: 10, y: 20, width: 80, height: 40 } }]));
      }
      return baseExecFile(command, args);
    };
    const calls: string[] = [];
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'find_elements', 'long_press'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(name);
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:semantic-search', capabilities: { input: { touch: true } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        if (name === 'find_elements') {
          await new Promise((resolve) => setTimeout(resolve, 90));
          return { structuredContent: { matches: [{ element: { frame: { x: 10, y: 20, width: 80, height: 40 } } }] } };
        }
        return { structuredContent: { accepted: true, inputDispatched: true } };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: '/bin/echo', idbCommand: 'idb' },
      runner,
      simviewRequestTimeoutMs: 100,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });

    const started = Date.now();
    await expect(controller.longPressLabel({ platform: 'ios', id: 'semantic-search' }, 'Continue', 800)).resolves.toMatchObject({
      backend: 'idb', status: 'handled', dispatched: true, dispatch: 'submitted',
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(calls.filter((name) => name === 'find_elements')).toHaveLength(1);
    expect(calls).not.toContain('long_press');
    expect(runner.calls.some(({ command, args }) => command === 'idb' && args[0] === 'ui' && args[1] === 'tap' && args.includes('--duration'))).toBe(true);
  });

  test('reports IDB label discovery failures as not-sent before tap dispatch', async () => {
    const runner = fakeRunner();
    const baseExecFile = runner.execFile;
    runner.execFile = async (command, args, ...rest) => {
      if (command === 'idb' && args[0] === 'ui' && args[1] === 'describe-all' && !args.includes('--help')) {
        throw new Error('describe-all failed');
      }
      return baseExecFile(command, args, ...rest);
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'idb', idbCommand: 'idb' },
      runner,
    });

    await expect(controller.tapLabel({ platform: 'ios', id: 'device-a' }, 'Continue')).resolves.toMatchObject({
      backend: 'idb', status: 'failed', dispatched: false, dispatch: 'not-sent',
    });
    expect(runner.calls.some(({ args }) => args[0] === 'ui' && args[1] === 'tap' && !args.includes('--help'))).toBe(false);
  });

  test('bounds a stalled IDB accessibility read before label dispatch', async () => {
    const runner = fakeRunner();
    const baseExecFile = runner.execFile;
    const timeouts: number[] = [];
    runner.execFile = async (command, args, options) => {
      if (command === 'idb' && args[0] === 'ui' && args[1] === 'describe-all' && !args.includes('--help')) {
        timeouts.push(options?.timeout ?? 0);
        return new Promise<never>(() => {});
      }
      return baseExecFile(command, args, options);
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'idb', idbCommand: 'idb' },
      runner,
      simviewRequestTimeoutMs: 20,
    });

    const started = Date.now();
    await expect(controller.tapLabel({ platform: 'ios', id: 'stalled-read' }, 'Continue'))
      .resolves.toMatchObject({ backend: 'idb', status: 'failed', dispatch: 'not-sent' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeGreaterThan(0);
    expect(timeouts[0]).toBeLessThanOrEqual(20);
    expect(runner.calls.some(({ args }) => args[0] === 'ui' && args[1] === 'tap' && !args.includes('--help'))).toBe(false);
  });

  test('bounds a stalled IDB geometry read before directional swipe dispatch', async () => {
    const runner = fakeRunner();
    const baseExecFile = runner.execFile;
    const timeouts: number[] = [];
    runner.execFile = async (command, args, options) => {
      if (command === 'idb' && args[0] === 'describe' && !args.includes('--help')) {
        timeouts.push(options?.timeout ?? 0);
        return new Promise<never>(() => {});
      }
      return baseExecFile(command, args, options);
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'idb', idbCommand: 'idb' },
      runner,
      simviewRequestTimeoutMs: 20,
    });

    const started = Date.now();
    await expect(controller.swipeDirection({ platform: 'ios', id: 'stalled-geometry' }, 'up', 300))
      .resolves.toMatchObject({ backend: 'none', status: 'unavailable', dispatch: 'not-sent' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeGreaterThan(0);
    expect(timeouts[0]).toBeLessThanOrEqual(20);
    expect(runner.calls.some(({ args }) => args[0] === 'ui' && args[1] === 'swipe' && !args.includes('--help'))).toBe(false);
  });

  test('bounds a stalled IDB action as an uncertain dispatch', async () => {
    const runner = fakeRunner();
    const baseExecFile = runner.execFile;
    const timeouts: number[] = [];
    runner.execFile = async (command, args, options) => {
      if (command === 'idb' && args[0] === 'ui' && args[1] === 'tap' && !args.includes('--help')) {
        timeouts.push(options?.timeout ?? 0);
        return new Promise<never>(() => {});
      }
      return baseExecFile(command, args, options);
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'idb', idbCommand: 'idb' },
      runner,
      simviewRequestTimeoutMs: 20,
    });

    const started = Date.now();
    await expect(controller.tap({ platform: 'ios', id: 'stalled-action' }, 1, 2))
      .resolves.toMatchObject({ backend: 'idb', status: 'failed', dispatched: false, dispatch: 'unknown' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeGreaterThan(0);
    expect(timeouts[0]).toBeLessThanOrEqual(20);
  });

  test('does not report a coordinate action as handled when the receipt did not dispatch input', async () => {
    const runner = fakeRunner();
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'tap'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:device-a', capabilities: { input: { touch: true, text: 'unicode', buttons: [] } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        return { structuredContent: { accepted: true, inputDispatched: false } };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'simview', simviewCommand: '/bin/echo' },
      runner,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });
    await expect(controller.tap({ platform: 'ios', id: 'device-a' }, 1, 2)).resolves.toMatchObject({
      backend: 'simview', status: 'failed', dispatched: false, dispatch: 'not-sent',
    });
  });

  test('falls through to IDB when SimView explicitly reports that input was not sent', async () => {
    const runner = fakeRunner();
    const calls: string[] = [];
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'tap'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(name);
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:not-sent-device', capabilities: { input: { touch: true } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        return { structuredContent: { accepted: true, inputDispatched: false } };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: '/bin/echo', idbCommand: 'idb' },
      runner,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });

    await expect(controller.tap({ platform: 'ios', id: 'not-sent-device' }, 1, 2)).resolves.toMatchObject({
      backend: 'idb', status: 'handled', dispatched: true, dispatch: 'submitted',
    });
    expect(calls).toContain('tap');
    expect(runner.calls).toContainEqual({ command: 'idb', args: ['ui', 'tap', '1', '2', '--udid', 'not-sent-device'] });
    await controller.close();
  });

  test('uses the public semantic search match element ref and stops on tap uncertainty', async () => {
    const runner = fakeRunner();
    const calls: string[] = [];
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'find_elements', 'tap_element'].map((name) => ({ name })) }),
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(`${name}:${JSON.stringify(args)}`);
        if (name === 'connect_device') return { structuredContent: { connected: true } };
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:device-a', capabilities: { input: { touch: true, text: 'unicode', buttons: [] } } } } };
        if (name === 'observe_screen') return { structuredContent: { snapshot: { screen: { width: 402, height: 874 } } } };
        if (name === 'find_elements') return { structuredContent: { matches: [{ ref: 'generation:node-1' }], count: 1 } };
        return { isError: true, structuredContent: { interaction: { accepted: true, inputDispatched: true, retryInput: false } }, content: [{ type: 'text', text: 'action receipt unavailable' }] };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'simview', simviewCommand: '/bin/echo' },
      runner,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });
    const response = await controller.tapLabel({ platform: 'ios', id: 'device-a' }, 'Continue');
    expect(response).toMatchObject({ backend: 'simview', status: 'failed', dispatched: true, dispatch: 'submitted' });
    expect(calls).toContain('find_elements:{"name":"Continue","exact":true}');
    expect(calls).toContain('tap_element:{"ref":"generation:node-1"}');
    expect(runner.calls.some(({ command, args }) => command === 'idb' && args[0] === 'ui' && args.includes('--udid'))).toBe(false);
  });

  test('long presses the unique SimView semantic match at its normalized frame center', async () => {
    const runner = fakeRunner();
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'find_elements', 'long_press'].map((name) => ({ name })) }),
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push({ name, arguments: args });
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:device-a', pointWidth: 400, pointHeight: 800, capabilities: { input: { touch: true } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        if (name === 'find_elements') return { structuredContent: { matches: [{ element: { frame: { points: { x: 10, y: 20, width: 80, height: 40 }, normalized: { x: 0.25, y: 0.1, width: 0.5, height: 0.2 } } } }] } };
        return { structuredContent: { accepted: true } };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'simview', simviewCommand: '/bin/echo' },
      runner,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });

    await expect(controller.longPressLabel({ platform: 'ios', id: 'device-a' }, 'Continue', 900)).resolves.toMatchObject({
      backend: 'simview', status: 'handled', dispatched: true,
    });
    expect(calls.find((call) => call.name === 'long_press')?.arguments).toEqual({ x: 0.5, y: 0.2, durationMs: 900 });
  });

  test('falls through to IDB when SimView reports no touch capability', async () => {
    const runner = fakeRunner();
    const baseExecFile = runner.execFile;
    runner.execFile = async (command, args) => {
      if (command === 'idb' && args[0] === 'ui' && args[1] === 'describe-all') {
        return Buffer.from(JSON.stringify([{ label: 'Continue', frame: { x: 10, y: 20, width: 80, height: 40 } }]));
      }
      return baseExecFile(command, args);
    };
    const calls: string[] = [];
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'find_elements', 'long_press'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(name);
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:device-a', pointWidth: 400, pointHeight: 800, capabilities: { input: { touch: false } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        return { structuredContent: { connected: true } };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: '/bin/echo', idbCommand: 'idb' },
      runner,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });

    await expect(controller.longPressLabel({ platform: 'ios', id: 'device-a' }, 'Continue', 900)).resolves.toMatchObject({
      backend: 'idb', status: 'handled', dispatched: true,
    });
    expect(calls).not.toContain('find_elements');
    expect(calls).not.toContain('long_press');
  });

  test('reports unsupported Android semantic long press before dispatch when touch is unavailable', async () => {
    const runner = fakeRunner();
    const calls: string[] = [];
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'find_elements', 'long_press'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(name);
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'android:device-a', pointWidth: 400, pointHeight: 800, capabilities: { input: { touch: false } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        return { structuredContent: { connected: true } };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'simview', simviewCommand: '/bin/echo' },
      runner,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });

    await expect(controller.longPressLabel({ platform: 'android', id: 'device-a' }, 'Continue', 900)).resolves.toMatchObject({
      backend: 'simview', status: 'unsupported', dispatched: false, dispatch: 'not-sent',
    });
    expect(calls).not.toContain('find_elements');
    expect(calls).not.toContain('long_press');
  });

  test('falls back to IDB long press using the accessibility frame center', async () => {
    const runner = fakeRunner();
    const baseExecFile = runner.execFile;
    runner.execFile = async (command, args) => {
      if (command === 'idb' && args[0] === 'ui' && args[1] === 'describe-all') {
        return Buffer.from(JSON.stringify([{ label: 'Continue', frame: { x: 10, y: 20, width: 80, height: 40 } }]));
      }
      return baseExecFile(command, args);
    };
    const controller = new NativeInputController({ config: { nativeBackend: 'idb', idbCommand: 'idb' }, runner });

    await expect(controller.longPressLabel({ platform: 'ios', id: 'device-a' }, 'Continue', 900)).resolves.toMatchObject({
      backend: 'idb', status: 'handled', dispatched: true,
    });
    expect(runner.calls).toContainEqual({ command: 'idb', args: ['ui', 'tap', '50', '40', '--duration', '0.9', '--udid', 'device-a'] });
  });

  test('stops a raw SimView action when safeToContinue is false, even with a dispatch receipt', async () => {
    const runner = fakeRunner();
    const calls: string[] = [];
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'tap'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(name);
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:device-a', capabilities: { input: { touch: true, text: 'unicode', buttons: [] } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        return { structuredContent: { accepted: true, inputDispatched: true, safeToContinue: false } };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: '/bin/echo', idbCommand: 'idb' },
      runner,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });
    const response = await controller.tap({ platform: 'ios', id: 'device-a' }, 1, 2);
    expect(response).toMatchObject({ backend: 'simview', status: 'failed', dispatched: true, dispatch: 'submitted' });
    expect(calls).toContain('tap');
    expect(runner.calls.some(({ command, args }) => command === 'idb' && args[0] === 'ui' && args.includes('--udid'))).toBe(false);
  });

  test('stops a semantic SimView action when nested safeToContinue is false', async () => {
    const runner = fakeRunner();
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'find_elements', 'tap_element'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:device-a', capabilities: { input: { touch: true, text: 'unicode', buttons: [] } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        if (name === 'find_elements') return { structuredContent: { matches: [{ ref: 'element:1' }] } };
        return { structuredContent: { interaction: { accepted: true, inputDispatched: true, safeToContinue: false } } };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'simview', simviewCommand: '/bin/echo' },
      runner,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });
    await expect(controller.tapLabel({ platform: 'ios', id: 'device-a' }, 'Continue')).resolves.toMatchObject({
      backend: 'simview', status: 'failed', dispatched: true, dispatch: 'submitted',
    });
  });

  test('retains partial IDB capabilities and refuses unsupported operations before dispatch', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = {
      calls,
      exec: async () => '',
      execFile: async (command: string, args: string[]) => {
        calls.push({ command, args });
        if (args.at(-1) === '--version') return Buffer.from('1.0.0');
        if (args.at(-1) === '--help' && args.at(-2) === 'ui') return Buffer.from('{describe-all,tap,text,swipe,button}');
        if (args.at(-1) === '--help' && args.at(-2) === 'tap') return Buffer.from('tap options without duration');
        if (args.at(-1) === '--help' && args.at(-2) === 'swipe') return Buffer.from('swipe options without duration');
        if (args.at(-1) === '--help' && args.at(-2) === 'button') return Buffer.from('{HOME}');
        if (args.at(-1) === '--help') return Buffer.from('commands: ui describe');
        return Buffer.from('ok');
      },
    };
    const controller = new NativeInputController({ config: { nativeBackend: 'idb', idbCommand: '/bin/idb' }, runner });
    const target = { platform: 'ios' as const, id: 'partial-idb' };
    expect((await controller.tap(target, 1, 2)).status).toBe('handled');
    expect((await controller.typeText(target, 'hello')).status).toBe('handled');
    expect((await controller.longPress(target, 1, 2, 500)).status).toBe('unsupported');
    expect((await controller.swipe(target, { x: 1, y: 2 }, { x: 3, y: 4 }, 500)).status).toBe('unsupported');
    expect((await controller.button(target, 'HOME')).status).toBe('handled');
    expect((await controller.button(target, 'POWER')).status).toBe('unsupported');
    const dispatches = calls.filter(({ args }) => args.includes('--udid'));
    expect(dispatches).toHaveLength(3);
    expect(dispatches.some(({ args }) => args.includes('--duration'))).toBe(false);
  });

  test('does not dispatch IDB text when the UI help omits text', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = {
      calls,
      exec: async () => '',
      execFile: async (command: string, args: string[]) => {
        calls.push({ command, args });
        if (args.at(-1) === '--version') throw new Error('no version command');
        if (args.at(-1) === '--help' && args.at(-2) === 'ui') return Buffer.from('{tap}');
        if (args.at(-1) === '--help' && args.at(-2) === 'tap') return Buffer.from('--duration DURATION');
        if (args.at(-1) === '--help') return Buffer.from('commands: ui describe');
        return Buffer.from('ok');
      },
    };
    const controller = new NativeInputController({ config: { nativeBackend: 'idb', idbCommand: '/bin/idb' }, runner });
    const response = await controller.typeText({ platform: 'ios', id: 'missing-text' }, 'hello');
    expect(response).toMatchObject({ backend: 'idb', status: 'unsupported', dispatch: 'not-sent' });
    expect(calls.some(({ args }) => args.includes('--udid'))).toBe(false);
  });

  test('derives IDB directional swipes from the reported point geometry', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = {
      calls,
      exec: async () => '',
      execFile: async (command: string, args: string[]) => {
        calls.push({ command, args });
        if (args.at(-1) === '--version') return Buffer.from('1.0.0');
        if (args.at(-1) === '--help' && args.at(-2) === 'ui') return Buffer.from('{describe-all,tap,text,swipe}');
        if (args.at(-1) === '--help' && args.at(-2) === 'tap') return Buffer.from('--duration DURATION');
        if (args.at(-1) === '--help' && args.at(-2) === 'swipe') return Buffer.from('--duration DURATION');
        if (args.at(-1) === '--help') return Buffer.from('commands: ui describe');
        if (args.includes('describe')) return Buffer.from(JSON.stringify({ screen_dimensions: { width_points: 402, height_points: 874 } }));
        return Buffer.from('ok');
      },
    };
    const controller = new NativeInputController({ config: { nativeBackend: 'idb', idbCommand: '/bin/echo --profile fixture' }, runner });
    const response = await controller.swipeDirection({ platform: 'ios', id: 'fake-udid' }, 'up', 300);
    expect(response).toMatchObject({ backend: 'idb', status: 'handled', dispatch: 'submitted' });
    expect(calls.at(-2)?.args).toEqual(['--profile', 'fixture', 'describe', '--udid', 'fake-udid', '--json']);
    expect(calls.at(-1)?.args).toEqual(['--profile', 'fixture', 'ui', 'swipe', '201', '656', '201', '219', '--duration', '0.3', '--udid', 'fake-udid']);
  });

  test('does not retry stalled SimView geometry before falling back to IDB directional swipe', async () => {
    const runner = fakeRunner();
    const calls: string[] = [];
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'swipe'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(name);
        if (name === 'connect_device') return { structuredContent: { connected: true } };
        if (name === 'get_simview_state') return new Promise<never>(() => {});
        return { structuredContent: { accepted: true, inputDispatched: true } };
      },
      close: async () => {},
    };
    const baseExecFile = runner.execFile;
    runner.execFile = async (command, args) => {
      if (command === 'idb' && args[0] === 'describe') {
        runner.calls.push({ command, args });
        return Buffer.from(JSON.stringify({ screen_dimensions: { width_points: 402, height_points: 874 } }));
      }
      return baseExecFile(command, args);
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: '/bin/echo', idbCommand: 'idb' },
      runner,
      simviewRequestTimeoutMs: 20,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });

    const started = Date.now();
    await expect(controller.swipeDirection({ platform: 'ios', id: 'fake-udid' }, 'up', 300)).resolves.toMatchObject({
      backend: 'idb', status: 'handled', dispatched: true, dispatch: 'submitted',
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(calls).toEqual(['connect_device', 'get_simview_state']);
    expect(runner.calls.filter(({ command, args }) => command === 'idb' && args[0] === 'ui' && args[1] === 'swipe' && !args.includes('--help'))).toHaveLength(1);
  });

  test('uses the final Android override geometry for directional swipes', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = {
      calls,
      exec: async () => '',
      execFile: async (command: string, args: string[]) => {
        calls.push({ command, args });
        if (command === 'adb' && args.at(-1) === 'size') return Buffer.from('Physical size: 1080x1920\nOverride size: 414x896\n');
        return Buffer.from('ok');
      },
    };
    const controller = new NativeInputController({ config: { nativeBackend: 'idb' }, runner });
    await controller.swipeDirection({ platform: 'android', id: 'emulator' }, 'up', 300);
    expect(calls.at(-1)?.args).toEqual(['-s', 'emulator', 'shell', 'input', 'swipe', '207', '672', '207', '224', '300']);
  });

  test('treats a transport failure during dispatch as unknown and never falls through', async () => {
    const runner = fakeRunner();
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'tap'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:fake-udid', capabilities: { input: { touch: true, text: 'unicode', buttons: [] } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        if (name === 'connect_device') return { structuredContent: { accepted: true } };
        throw new Error('connection lost after dispatch');
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: '/bin/echo', idbCommand: 'idb' },
      runner,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });
    const response = await controller.tap({ platform: 'ios', id: 'fake-udid' }, 1, 2);
    expect(response).toMatchObject({ backend: 'simview', status: 'failed', dispatched: false, dispatch: 'unknown' });
    expect(runner.calls.some(({ command, args }) => command === 'idb' && args[0] === 'ui' && args.includes('--udid'))).toBe(false);
  });

  test('bounds a stalled SimView action and never falls through after dispatch may have started', async () => {
    const runner = fakeRunner();
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'tap'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:stalled-simview', capabilities: { input: { touch: true } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        if (name === 'tap') return new Promise<never>(() => {});
        return { structuredContent: { connected: true } };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: '/bin/echo', idbCommand: 'idb' },
      runner,
      simviewRequestTimeoutMs: 20,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });

    const started = Date.now();
    await expect(controller.tap({ platform: 'ios', id: 'stalled-simview' }, 1, 2))
      .resolves.toMatchObject({ backend: 'simview', status: 'failed', dispatched: false, dispatch: 'unknown' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(runner.calls.some(({ command, args }) => command === 'idb' && args[0] === 'ui' && args.includes('--udid'))).toBe(false);
  });

  test('bounds a stalled semantic SimView action and never falls through', async () => {
    const runner = fakeRunner();
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'find_elements', 'tap_element'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:stalled-semantic', capabilities: { input: { touch: true } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        if (name === 'find_elements') return { structuredContent: { matches: [{ ref: 'element:1' }] } };
        if (name === 'tap_element') return new Promise<never>(() => {});
        return { structuredContent: { connected: true } };
      },
      close: async () => {},
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'auto', simviewCommand: '/bin/echo', idbCommand: 'idb' },
      runner,
      simviewRequestTimeoutMs: 20,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });

    const started = Date.now();
    await expect(controller.tapLabel({ platform: 'ios', id: 'stalled-semantic' }, 'Continue'))
      .resolves.toMatchObject({ backend: 'simview', status: 'failed', dispatched: false, dispatch: 'unknown' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(runner.calls.some(({ command, args }) => command === 'idb' && args[0] === 'ui' && args.includes('--udid'))).toBe(false);
  });

  test('closes a SimView client when initialization fails before a session is owned', async () => {
    const runner = fakeRunner();
    let closed = 0;
    const client = {
      connect: async () => { throw new Error('MCP handshake failed'); },
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ isError: true }),
      close: async () => { closed += 1; },
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'simview', simviewCommand: '/bin/echo' },
      runner,
      simviewClientFactory: () => ({ client, transport: { close: async () => {} } }),
    });
    const response = await controller.tap({ platform: 'ios', id: 'fake-udid' }, 1, 2);
    expect(response).toMatchObject({ backend: 'simview', status: 'unavailable', dispatch: 'not-sent' });
    expect(closed).toBe(1);
  });

  test('does not block shutdown on an in-flight native call', async () => {
    const runner = fakeRunner();
    let closed = 0;
    let transportClosed = 0;
    let dispatchStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { dispatchStarted = resolve; });
    const client = {
      connect: async () => {},
      listTools: async () => ({ tools: ['connect_device', 'get_simview_state', 'observe_screen', 'tap'].map((name) => ({ name })) }),
      callTool: async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
        if (name === 'get_simview_state') return { structuredContent: { device: { id: 'ios:fake-udid', capabilities: { input: { touch: true, text: 'unicode', buttons: [] } } } } };
        if (name === 'observe_screen') return { structuredContent: { viewport: { width: 400, height: 800 } } };
        if (name === 'tap') { dispatchStarted(); return new Promise<never>(() => {}); }
        return { structuredContent: { connected: true } };
      },
      close: async () => { closed += 1; },
    };
    const controller = new NativeInputController({
      config: { nativeBackend: 'simview', simviewCommand: '/bin/echo' },
      runner,
      simviewClientFactory: () => ({ client, transport: { close: async () => { transportClosed += 1; } } }),
    });
    void controller.tap({ platform: 'ios', id: 'fake-udid' }, 1, 2);
    await started;
    await Promise.race([controller.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown timed out')), 1500))]);
    expect(closed).toBe(1);
    expect(transportClosed).toBe(1);
    await controller.close();
    expect(closed).toBe(1);
    expect(transportClosed).toBe(1);
  });

  test('closes a client tracked before a never-resolving connection settles', async () => {
    const runner = fakeRunner();
    let clientClosed = 0;
    let transportClosed = 0;
    const client = {
      connect: async () => new Promise<void>(() => {}),
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ isError: true }),
      close: async () => { clientClosed += 1; },
    };
    const transport = { close: async () => { transportClosed += 1; } };
    const controller = new NativeInputController({
      config: { nativeBackend: 'simview', simviewCommand: '/bin/echo' },
      runner,
      simviewClientFactory: () => ({ client, transport }),
    });
    const action = controller.tap({ platform: 'ios', id: 'fake-udid' }, 1, 2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await Promise.race([controller.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown timed out')), 1500))]);
    expect(clientClosed).toBe(1);
    expect(transportClosed).toBe(1);
    await controller.close();
    expect(clientClosed).toBe(1);
    expect(transportClosed).toBe(1);
    void action;
  });
});
