import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { z } from 'zod';
import type {
  ComponentNode,
  PluginContext,
  ToolHandlerResult,
} from '../plugin.js';
import {
  prepareScreenshotDirectory,
  simulatorPlugin,
} from './simulator.js';

type RegisteredTool = {
  parameters: z.ZodType;
  handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult>;
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean };
};

const createdFiles = new Set<string>();
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

afterEach(async () => {
  await Promise.all(
    [...createdFiles].map((path) => unlink(path).catch(() => {})),
  );
  createdFiles.clear();
});

async function createSimulatorHarness(
  options: {
    writeCapture?: boolean;
    execError?: Error;
    captureSize?: number;
    execFileCalls?: Array<{ command: string; args: string[] }>;
  } = {},
) {
  const tools = new Map<string, RegisteredTool>();
  const registerTool: PluginContext['registerTool'] = (name, config) => {
    tools.set(name, {
      parameters: config.parameters,
      handler: config.handler as RegisteredTool['handler'],
      annotations: config.annotations,
    });
  };
  const writeCapture = options.writeCapture ?? true;

  const ctx: PluginContext = {
    cdp: {
      on: () => {},
      off: () => {},
      isConnected: false,
      getTarget: () => null,
      send: async () => ({}),
    },
    events: {
      on: () => {},
      off: () => {},
      isConnected: () => false,
    },
    registerTool,
    registerResource: () => {},
    registerAppResource: () => {},
    registerPrompt: () => {},
    config: {},
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    metro: {
      host: 'localhost',
      port: 8081,
      fetch: async () => new Response(),
    },
    exec: async () => '',
    execFile: async (command, args) => {
      options.execFileCalls?.push({ command, args });
      const path = command === 'xcrun' ? args.at(-1) : undefined;
      if (writeCapture && path) {
        createdFiles.add(path);
        await writeFile(path, png);
        if (options.captureSize !== undefined) {
          await truncate(path, options.captureSize);
        }
      }
      if (options.execError) throw options.execError;
      return Buffer.from(png);
    },
    format: {
      summarize: () => '',
      compact: (value: unknown) => JSON.stringify(value),
      truncate: (value: string) => value,
      structureOnly: (value: ComponentNode) => value,
    },
    evalInApp: async () => null,
    getActiveDeviceKey: () => null,
    getActiveDeviceName: () => null,
    notifyResourceUpdated: () => {},
  };

  await simulatorPlugin.setup(ctx);
  const screenshot = tools.get('take_screenshot');
  if (!screenshot) throw new Error('take_screenshot was not registered');
  return screenshot;
}

async function capture(
  tool: RegisteredTool,
  args: Record<string, unknown>,
): Promise<ToolHandlerResult> {
  return tool.handler(tool.parameters.parse(args) as Record<string, unknown>);
}

describe('take_screenshot', () => {
  test('uses direct executable arguments instead of shell path quoting', async () => {
    const execFileCalls: Array<{ command: string; args: string[] }> = [];
    const tool = await createSimulatorHarness({ execFileCalls });

    await capture(tool, { platform: 'ios' });
    await capture(tool, { platform: 'android' });

    expect(execFileCalls[0].command).toBe('xcrun');
    expect(execFileCalls[0].args.slice(0, -1)).toEqual([
      'simctl',
      'io',
      'booted',
      'screenshot',
    ]);
    expect(execFileCalls[0].args.at(-1)?.startsWith(tmpdir())).toBe(true);
    expect(execFileCalls[1]).toEqual({
      command: 'adb',
      args: ['exec-out', 'screencap', '-p'],
    });
  });

  test('defaults to a retained temporary path with structured metadata', async () => {
    const tool = await createSimulatorHarness();
    const result = await capture(tool, { platform: 'ios' });

    expect(result).toMatchObject({
      content: [{ type: 'text' }],
      structuredContent: {
        mimeType: 'image/png',
        platform: 'ios',
      },
    });
    const path = (result as { structuredContent: { path: string } })
      .structuredContent.path;
    expect(path.startsWith(tmpdir())).toBe(true);
    if (process.getuid) {
      expect(dirname(path).endsWith(`-${process.getuid()}`)).toBe(true);
    }
    expect(existsSync(path)).toBe(true);
    expect(await readFile(path)).toEqual(Buffer.from(png));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect(tool.annotations).toEqual({ openWorldHint: true });
  });

  test('returns a native inline image and deletes the capture file', async () => {
    const tool = await createSimulatorHarness();
    const result = await capture(tool, {
      platform: 'android',
      delivery: 'inline',
    });

    expect(result).toEqual({
      content: [
        {
          type: 'image',
          data: Buffer.from(png).toString('base64'),
          mimeType: 'image/png',
        },
      ],
    });
    for (const path of createdFiles) expect(existsSync(path)).toBe(false);
  });

  test('uses unique files for concurrent path captures', async () => {
    const tool = await createSimulatorHarness();
    const results = await Promise.all([
      capture(tool, { platform: 'ios' }),
      capture(tool, { platform: 'ios' }),
    ]);
    const paths = results.map(
      (result) =>
        (result as { structuredContent: { path: string } }).structuredContent
          .path,
    );

    expect(new Set(paths).size).toBe(2);
    expect(paths.every((path) => existsSync(path))).toBe(true);
  });

  test('reports a failed capture when no file is produced', async () => {
    const tool = await createSimulatorHarness({ writeCapture: false });
    await expect(
      capture(tool, { platform: 'ios', delivery: 'path' }),
    ).rejects.toThrow('Failed to capture screenshot');
  });

  test('rejects and removes oversized iOS captures before delivery', async () => {
    const tool = await createSimulatorHarness({ captureSize: 65 * 1024 * 1024 });

    await expect(capture(tool, { platform: 'ios' })).rejects.toThrow(
      '64 MiB screenshot limit',
    );
    for (const path of createdFiles) expect(existsSync(path)).toBe(false);
  });

  test('removes a partial capture when the platform command fails', async () => {
    const tool = await createSimulatorHarness({
      execError: new Error('simctl failed'),
    });

    await expect(capture(tool, { platform: 'ios' })).rejects.toThrow(
      'simctl failed',
    );
    for (const path of createdFiles) expect(existsSync(path)).toBe(false);
  });

  test('removes only old Metro MCP screenshot files opportunistically', async () => {
    const tool = await createSimulatorHarness();
    const first = await capture(tool, { platform: 'ios' });
    const screenshotDirectory = dirname(
      (first as { structuredContent: { path: string } }).structuredContent.path,
    );
    const oldPath = join(
      screenshotDirectory,
      `metro-mcp-screenshot-${randomUUID()}.png`,
    );
    createdFiles.add(oldPath);
    await writeFile(oldPath, png);
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(oldPath, oldDate, oldDate);

    await capture(tool, { platform: 'ios' });

    expect(existsSync(oldPath)).toBe(false);
  });

  test('refuses a pre-existing screenshot directory symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metro-mcp-symlink-test-'));
    const target = join(root, 'target');
    const linkedDirectory = join(root, 'screenshots');
    await mkdir(target);
    await symlink(target, linkedDirectory, 'dir');

    try {
      await expect(prepareScreenshotDirectory(linkedDirectory)).rejects.toThrow(
        'Screenshot directory is not a real directory',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
