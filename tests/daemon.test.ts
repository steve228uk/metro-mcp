import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  cleanupStaleDaemonRecords,
  createDaemonIdentity,
  getDaemonIdentityFingerprint,
  getDaemonKey,
  getDaemonKeyFingerprint,
  getDaemonLockPath,
  getDaemonRecordPath,
  readLiveRecord,
  removeDaemonRecordForProcess,
  withStartupLock,
  writeDaemonRecord,
} from '../src/daemon.js';
import { loadConfig } from '../src/config.js';
import { startHttpServer } from '../src/server.js';
import { version } from '../src/version.js';
import type { DaemonHealth, DaemonIdentity, DaemonRecord } from '../src/daemon.js';

const CONFIG_DIR_ENV = 'METRO_MCP_DAEMON_CONFIG_DIR';

let tempDir: string;
let previousConfigDir: string | undefined;
let nextPort = 46000 + Math.floor(Math.random() * 1000);

beforeEach(() => {
  previousConfigDir = process.env[CONFIG_DIR_ENV];
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metro-mcp-daemon-test-'));
  process.env[CONFIG_DIR_ENV] = tempDir;
});

afterEach(() => {
  if (previousConfigDir === undefined) {
    delete process.env[CONFIG_DIR_ENV];
  } else {
    process.env[CONFIG_DIR_ENV] = previousConfigDir;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function identity(overrides: Partial<DaemonIdentity> = {}): DaemonIdentity {
  return createDaemonIdentity(['--port', '8081'], {
    version: '1.0.0',
    cwd: '/tmp/react-native-app',
    args: ['--port', '8081'],
    env: {
      METRO_HOST: undefined,
      METRO_PORT: '8081',
      METRO_MCP_CONFIG: undefined,
      METRO_MCP_PLUGINS: undefined,
      METRO_MCP_PROXY_PORT: undefined,
      METRO_MCP_PROXY_ENABLED: undefined,
    },
    entrypoint: '/tmp/metro-mcp/src/index.ts',
    runtime: '/usr/local/bin/bun',
    ...overrides,
  });
}

function record(key: string, url: string, recordIdentity: DaemonIdentity): DaemonRecord {
  const recordUrl = new URL(url);
  return {
    pid: process.pid,
    host: '127.0.0.1',
    port: recordUrl.port ? Number(recordUrl.port) : 0,
    url,
    key,
    cwd: recordIdentity.cwd,
    args: recordIdentity.args,
    identity: recordIdentity,
    startedAt: new Date().toISOString(),
  };
}

async function withHealthServer<T>(
  health: DaemonHealth,
  fn: (url: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(health));
      return;
    }
    res.writeHead(404).end('Not found');
  });

  const port = await listen(server);

  try {
    return await fn(`http://127.0.0.1:${port}/mcp`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
}

async function listen(server: http.Server): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = nextPort++;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return port;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }
  }

  throw new Error('Could not find an available test port');
}

describe('daemon identity', () => {
  test('changes the daemon key when the server version changes', () => {
    const current = identity({ version: '1.0.0' });
    const next = identity({ version: '1.0.1' });

    expect(getDaemonKey(current.args, current)).not.toBe(getDaemonKey(next.args, next));
  });

  test('changes the daemon key when launcher context changes', () => {
    const installed = identity({ entrypoint: '/tmp/bunx/metro-mcp/dist/bin/metro-mcp.js' });
    const local = identity({ entrypoint: '/Users/stephenradford/Sites/metro-mcp/src/index.ts' });
    const node = identity({ runtime: '/usr/local/bin/node' });

    expect(getDaemonKey(installed.args, installed)).not.toBe(getDaemonKey(local.args, local));
    expect(getDaemonKey(installed.args, installed)).not.toBe(getDaemonKey(node.args, node));
  });

  test('starts and reuses a daemon with the loaded input identity', async () => {
    const configFile = path.join(tempDir, 'metro-mcp.shared.config.ts');
    fs.writeFileSync(
      configFile,
      "export default { metro: { host: '127.0.0.1', port: 65535, autoDiscover: false }, proxy: { enabled: false }, input: { nativeBackend: 'simview', simviewCommand: '/tmp/uninstalled-simview' } };\n",
    );
    const args = ['--project-root', tempDir, '--config', configFile];
    const entrypoint = path.resolve(import.meta.dir, '../src/index.ts');
    const config = await loadConfig(args);
    const identity = createDaemonIdentity(args, {
      projectRoot: config.projectRoot,
      input: config.input,
      entrypoint,
      runtime: fs.realpathSync(process.execPath),
    });
    const key = getDaemonKey(args, identity);
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] =>
        entry[1] !== undefined,
      ),
    );
    for (const variable of [
      'METRO_HOST',
      'METRO_PORT',
      'METRO_MCP_CONFIG',
      'METRO_MCP_PLUGINS',
      'METRO_MCP_PROJECT_ROOT',
      'METRO_MCP_PROXY_PORT',
      'METRO_MCP_PROXY_ENABLED',
      'METRO_MCP_DAEMON_KEY',
      'METRO_MCP_MULTIPLEX',
    ]) delete environment[variable];
    environment.METRO_MCP_DAEMON_CONFIG_DIR = tempDir;

    const clients: Client[] = [];
    const transports: StdioClientTransport[] = [];
    let daemonPid: number | undefined;
    try {
      for (const name of ['first', 'second']) {
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [entrypoint, ...args],
          cwd: tempDir,
          env: environment,
          stderr: 'pipe',
        });
        const client = new Client({ name: `daemon-${name}`, version: '1.0.0' });
        transports.push(transport);
        clients.push(client);
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.some((tool) => tool.name === 'list_devices')).toBe(true);

        const record = JSON.parse(
          fs.readFileSync(getDaemonRecordPath(key), 'utf8'),
        ) as DaemonRecord;
        expect(record.key).toBe(key);
        expect(record.identity).toEqual(identity);
        if (daemonPid === undefined) daemonPid = record.pid;
        expect(record.pid).toBe(daemonPid);
        expect(transport.pid).not.toBe(daemonPid);
      }
    } finally {
      for (const client of clients) await client.close().catch(() => {});
      for (const transport of transports) await transport.close().catch(() => {});
      if (daemonPid === undefined) {
        try {
          const record = JSON.parse(
            fs.readFileSync(getDaemonRecordPath(key), 'utf8'),
          ) as DaemonRecord;
          if (record.cwd === tempDir && Number.isInteger(record.pid)) {
            daemonPid = record.pid;
          }
        } catch {
          // The proxy may have failed before its owned daemon wrote a record.
        }
      }
      if (daemonPid !== undefined) {
        try {
          process.kill(daemonPid, 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
          try {
            process.kill(daemonPid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        try {
          process.kill(daemonPid, 0);
          process.kill(daemonPid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        removeDaemonRecordForProcess(key, daemonPid);
      }
    }
  }, 15_000);
});

describe('daemon records', () => {
  test('reuses a matching live daemon record', async () => {
    const expected = identity();
    const key = getDaemonKey(expected.args, expected);

    await withHealthServer(
      {
        ok: true,
        name: 'metro-mcp',
        version: expected.version,
        daemon: {
          keyHash: getDaemonKeyFingerprint(key),
          identityHash: getDaemonIdentityFingerprint(expected),
          managed: true,
        },
      },
      async (url) => {
        writeDaemonRecord(record(key, url, expected));

        const live = await readLiveRecord(key, expected);

        expect(live?.url).toBe(url);
        expect(live?.managed).toBe(true);
        expect(fs.existsSync(getDaemonRecordPath(key))).toBe(true);
        expect(fs.statSync(getDaemonRecordPath(key)).mode & 0o777).toBe(0o600);
      },
    );
  });

  test('removes a live record when the health version does not match', async () => {
    const expected = identity();
    const key = getDaemonKey(expected.args, expected);

    await withHealthServer(
      {
        ok: true,
        name: 'metro-mcp',
        version: '0.9.0',
        daemon: {
          keyHash: getDaemonKeyFingerprint(key),
          identityHash: getDaemonIdentityFingerprint(expected),
        },
      },
      async (url) => {
        writeDaemonRecord(record(key, url, expected));

        await expect(readLiveRecord(key, expected)).resolves.toBeNull();
        expect(fs.existsSync(getDaemonRecordPath(key))).toBe(false);
      },
    );
  });

  test('removes a live record when daemon identity does not match', async () => {
    const expected = identity();
    const actual = identity({ entrypoint: '/tmp/old-metro-mcp/src/index.ts' });
    const key = getDaemonKey(expected.args, expected);

    await withHealthServer(
      {
        ok: true,
        name: 'metro-mcp',
        version: expected.version,
        daemon: {
          keyHash: getDaemonKeyFingerprint(key),
          identityHash: getDaemonIdentityFingerprint(actual),
        },
      },
      async (url) => {
        writeDaemonRecord(record(key, url, expected));

        await expect(readLiveRecord(key, expected)).resolves.toBeNull();
        expect(fs.existsSync(getDaemonRecordPath(key))).toBe(false);
      },
    );
  });

  test('cleans corrupt and unreachable daemon records without removing other live metro-mcp records', async () => {
    const expected = identity();
    const liveKey = getDaemonKey(expected.args, expected);
    const corruptKey = 'deadbeefdeadbeef';
    const unreachableKey = 'ffffffffffffffff';
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(getDaemonRecordPath(corruptKey), '{nope');
    writeDaemonRecord({
      ...record(unreachableKey, 'http://127.0.0.1:1/mcp', expected),
      key: unreachableKey,
    });

    await withHealthServer(
      {
        ok: true,
        name: 'metro-mcp',
        version: expected.version,
        daemon: {
          keyHash: getDaemonKeyFingerprint(liveKey),
          identityHash: getDaemonIdentityFingerprint(expected),
        },
      },
      async (url) => {
        writeDaemonRecord(record(liveKey, url, expected));

        await cleanupStaleDaemonRecords();

        expect(fs.existsSync(getDaemonRecordPath(corruptKey))).toBe(false);
        expect(fs.existsSync(getDaemonRecordPath(unreachableKey))).toBe(false);
        expect(fs.existsSync(getDaemonRecordPath(liveKey))).toBe(true);
      },
    );
  });

  test('cleans records whose health endpoint is not metro-mcp', async () => {
    const expected = identity();
    const key = getDaemonKey(expected.args, expected);

    await withHealthServer(
      { ok: true, name: 'other-server', version: expected.version },
      async (url) => {
        writeDaemonRecord(record(key, url, expected));

        await cleanupStaleDaemonRecords();

        expect(fs.existsSync(getDaemonRecordPath(key))).toBe(false);
      },
    );
  });

  test('removes only the daemon record owned by the exiting process', () => {
    const expected = identity();
    const ownedKey = getDaemonKey(expected.args, expected);
    const otherKey = 'aaaaaaaaaaaaaaaa';
    writeDaemonRecord(record(ownedKey, 'http://127.0.0.1:4567/mcp', expected));
    writeDaemonRecord({
      ...record(otherKey, 'http://127.0.0.1:4568/mcp', expected),
      key: otherKey,
      pid: process.pid + 1,
    });

    removeDaemonRecordForProcess(ownedKey, process.pid);
    removeDaemonRecordForProcess(otherKey, process.pid);

    expect(fs.existsSync(getDaemonRecordPath(ownedKey))).toBe(false);
    expect(fs.existsSync(getDaemonRecordPath(otherKey))).toBe(true);
  });

  test('cleans dead and stale startup locks while preserving a fresh live lock', async () => {
    const deadPath = getDaemonLockPath('deadbeefdeadbeef');
    const stalePath = getDaemonLockPath('aaaaaaaaaaaaaaaa');
    const livePath = getDaemonLockPath('bbbbbbbbbbbbbbbb');
    fs.writeFileSync(deadPath, JSON.stringify({ pid: 2_147_483_647, token: 'dead' }));
    fs.writeFileSync(stalePath, JSON.stringify({ pid: process.pid, token: 'stale' }));
    fs.writeFileSync(livePath, JSON.stringify({ pid: process.pid, token: 'live' }));
    const staleDate = new Date(Date.now() - 31_000);
    fs.utimesSync(stalePath, staleDate, staleDate);

    await cleanupStaleDaemonRecords();

    expect(fs.existsSync(deadPath)).toBe(false);
    expect(fs.existsSync(stalePath)).toBe(false);
    expect(fs.existsSync(livePath)).toBe(true);
  });

  test('preserves live records and fresh locks when PID probing returns EPERM', async () => {
    const expected = identity();
    const key = getDaemonKey(expected.args, expected);
    const lockPath = getDaemonLockPath(key);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'live' }));

    await withHealthServer(
      {
        ok: true,
        name: 'metro-mcp',
        version: expected.version,
        daemon: {
          keyHash: getDaemonKeyFingerprint(key),
          identityHash: getDaemonIdentityFingerprint(expected),
          managed: true,
        },
      },
      async (url) => {
        writeDaemonRecord(record(key, url, expected));
        const kill = spyOn(process, 'kill').mockImplementation(() => {
          throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
        });
        try {
          await cleanupStaleDaemonRecords();
          expect(fs.existsSync(lockPath)).toBe(true);
          expect(fs.existsSync(getDaemonRecordPath(key))).toBe(true);
          expect((await readLiveRecord(key, expected))?.managed).toBe(true);
        } finally {
          kill.mockRestore();
        }
      },
    );
  });

  test('preserves a fresh startup lock while its payload is being written', async () => {
    const lockPath = getDaemonLockPath('dddddddddddddddd');
    fs.writeFileSync(lockPath, '');

    await cleanupStaleDaemonRecords();

    expect(fs.existsSync(lockPath)).toBe(true);
  });

  test('removes an unparsable startup lock only after it becomes stale', async () => {
    const lockPath = getDaemonLockPath('eeeeeeeeeeeeeeee');
    fs.writeFileSync(lockPath, '');
    const staleDate = new Date(Date.now() - 31_000);
    fs.utimesSync(lockPath, staleDate, staleDate);

    await cleanupStaleDaemonRecords();

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('does not remove a replacement lock when the previous owner finishes', async () => {
    const key = 'cccccccccccccccc';
    const lockPath = getDaemonLockPath(key);
    await withStartupLock(key, async () => {
      fs.unlinkSync(lockPath);
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
          token: 'replacement-owner',
        }),
      );
    });

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token).toBe(
      'replacement-owner',
    );
  });

  test('rejects daemon records that point outside localhost', async () => {
    const expected = identity();
    const key = getDaemonKey(expected.args, expected);
    writeDaemonRecord(record(key, 'http://example.com:8080/mcp', expected));

    await expect(readLiveRecord(key, expected)).resolves.toBeNull();
    expect(fs.existsSync(getDaemonRecordPath(key))).toBe(false);
  });
});

describe('HTTP health', () => {
  test('exposes a daemon fingerprint without leaking its lease key', async () => {
    const args = ['--port', '65535'];
    const daemonIdentity = identity({ version, args });
    const key = getDaemonKey(args, daemonIdentity);
    const config = await loadConfig(args);
    config.metro.host = '127.0.0.1';
    config.metro.port = 65535;
    config.metro.autoDiscover = false;
    config.proxy.enabled = false;

    const server = await startHttpServer(config, args, {
      port: nextPort++,
      daemon: { key, identity: daemonIdentity },
    });

    try {
      const response = await fetch(new URL('/health', server.url));
      const body = await response.json() as DaemonHealth;

      expect(body.name).toBe('metro-mcp');
      expect(body.version).toBe(version);
      expect(body.daemon?.keyHash).toBe(getDaemonKeyFingerprint(key));
      expect(body.daemon?.identityHash).toBe(
        getDaemonIdentityFingerprint(daemonIdentity),
      );
      expect(body.daemon).not.toHaveProperty('key');
      expect(body.daemon).not.toHaveProperty('identity');
      expect(body.daemon?.managed).toBe(false);
    } finally {
      await server.close();
    }
  });
});
