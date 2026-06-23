import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupStaleDaemonRecords,
  createDaemonIdentity,
  getDaemonKey,
  getDaemonRecordPath,
  readLiveRecord,
  removeDaemonRecordForProcess,
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
});

describe('daemon records', () => {
  test('reuses a matching live daemon record', async () => {
    const expected = identity();
    const key = getDaemonKey(expected.args, expected);

    await withHealthServer(
      { ok: true, name: 'metro-mcp', version: expected.version, daemon: { key, identity: expected } },
      async (url) => {
        writeDaemonRecord(record(key, url, expected));

        const live = await readLiveRecord(key, expected);

        expect(live?.url).toBe(url);
        expect(fs.existsSync(getDaemonRecordPath(key))).toBe(true);
      },
    );
  });

  test('removes a live record when the health version does not match', async () => {
    const expected = identity();
    const key = getDaemonKey(expected.args, expected);

    await withHealthServer(
      { ok: true, name: 'metro-mcp', version: '0.9.0', daemon: { key, identity: expected } },
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
      { ok: true, name: 'metro-mcp', version: expected.version, daemon: { key, identity: actual } },
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
      { ok: true, name: 'metro-mcp', version: expected.version, daemon: { key: liveKey, identity: expected } },
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
});

describe('HTTP health', () => {
  test('exposes daemon identity while keeping name and version', async () => {
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
      expect(body.daemon?.key).toBe(key);
      expect(body.daemon?.identity).toEqual(daemonIdentity);
    } finally {
      await server.close();
    }
  });
});
