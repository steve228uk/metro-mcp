import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveProjectRoot } from '../src/config.js';
import { createDaemonIdentity, getDaemonKey } from '../src/daemon.js';

const PROJECT_ROOT_ENV = 'METRO_MCP_PROJECT_ROOT';
let previousProjectRoot: string | undefined;

afterEach(() => {
  if (previousProjectRoot === undefined) delete process.env[PROJECT_ROOT_ENV];
  else process.env[PROJECT_ROOT_ENV] = previousProjectRoot;
  previousProjectRoot = undefined;
});

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metro-mcp-config-test-'));
}

describe('project-root configuration', () => {
  test('canonicalizes the working directory when no root is supplied', async () => {
    const root = tempProject();
    const config = await loadConfig([], root);
    expect(config.projectRoot).toBe(fs.realpathSync(root));
  });

  test('applies CLI, environment, then CWD project-root precedence', () => {
    const cwdRoot = tempProject();
    const envRoot = tempProject();
    const cliRoot = tempProject();

    previousProjectRoot = process.env[PROJECT_ROOT_ENV];
    process.env[PROJECT_ROOT_ENV] = envRoot;
    expect(resolveProjectRoot([], cwdRoot)).toBe(fs.realpathSync(envRoot));
    expect(resolveProjectRoot(['--project-root', cliRoot], cwdRoot)).toBe(
      fs.realpathSync(cliRoot),
    );

    delete process.env[PROJECT_ROOT_ENV];
    expect(resolveProjectRoot([], cwdRoot)).toBe(fs.realpathSync(cwdRoot));
  });

  test('rejects missing and non-directory project roots with actionable errors', () => {
    const root = tempProject();
    const file = path.join(root, 'not-a-directory');
    fs.writeFileSync(file, 'x');

    expect(() =>
      resolveProjectRoot(['--project-root', path.join(root, 'missing')]),
    ).toThrow(/does not exist/);
    expect(() => resolveProjectRoot(['--project-root', file])).toThrow(
      /not a directory/,
    );
  });

  test('resolves relative config and plugin paths from the effective project root', async () => {
    const root = tempProject();
    fs.mkdirSync(path.join(root, 'plugins'));
    fs.writeFileSync(
      path.join(root, 'plugins', 'local.ts'),
      'export default {}',
    );
    fs.writeFileSync(
      path.join(root, 'metro-mcp.config.ts'),
      `export default { metro: { port: 19000 }, plugins: ['./plugins/local.ts'] };\n`,
    );

    const config = await loadConfig([], root);
    expect(config.metro.port).toBe(19000);
    expect(config.plugins).toEqual([
      path.join(fs.realpathSync(root), 'plugins', 'local.ts'),
    ]);
  });

  test('separates daemon identities by effective project root', () => {
    const first = createDaemonIdentity([], { projectRoot: '/tmp/project-a' });
    const second = createDaemonIdentity([], { projectRoot: '/tmp/project-b' });
    expect(getDaemonKey([], first)).not.toBe(getDaemonKey([], second));
  });
});
