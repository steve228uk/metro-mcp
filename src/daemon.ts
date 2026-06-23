import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from './utils/logger.js';
import { version } from './version.js';

const logger = createLogger('daemon');

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.config', 'metro-mcp');
const DAEMON_KEY_ENV = 'METRO_MCP_DAEMON_KEY';
const DAEMON_CONFIG_DIR_ENV = 'METRO_MCP_DAEMON_CONFIG_DIR';
const STARTUP_LOCK_TIMEOUT_MS = 10_000;
const STARTUP_LOCK_STALE_MS = 30_000;
const DAEMON_ENV_KEYS = [
  'METRO_HOST',
  'METRO_PORT',
  'METRO_MCP_CONFIG',
  'METRO_MCP_PLUGINS',
  'METRO_MCP_PROXY_PORT',
  'METRO_MCP_PROXY_ENABLED',
] as const;

export interface DaemonIdentity {
  version: string;
  cwd: string;
  args: string[];
  env: Record<string, string | undefined>;
  entrypoint: string;
  runtime: string;
}

export interface DaemonRecord {
  pid: number;
  host: string;
  port: number;
  url: string;
  key: string;
  cwd: string;
  args: string[];
  identity?: DaemonIdentity;
  startedAt: string;
}

export interface DaemonHealth {
  ok: boolean;
  name: string;
  version: string;
  daemon?: {
    key: string;
    identity: DaemonIdentity;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectedEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of DAEMON_ENV_KEYS) {
    env[key] = process.env[key];
  }
  return env;
}

function resolvePath(value: string | undefined): string {
  if (!value) return '';
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function getConfigDir(): string {
  return process.env[DAEMON_CONFIG_DIR_ENV] || DEFAULT_CONFIG_DIR;
}

export function createDaemonIdentity(args: string[], overrides: Partial<DaemonIdentity> = {}): DaemonIdentity {
  return {
    version: overrides.version ?? version,
    cwd: overrides.cwd ?? getDaemonCwd(),
    args: overrides.args ?? [...args],
    env: overrides.env ?? selectedEnv(),
    entrypoint: overrides.entrypoint ?? resolvePath(process.argv[1]),
    runtime: overrides.runtime ?? resolvePath(process.execPath),
  };
}

export function getDaemonKey(args: string[], identity = createDaemonIdentity(args)): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(identity));
  return hash.digest('hex').slice(0, 16);
}

export function getDaemonCwd(): string {
  try {
    return fs.realpathSync(process.cwd());
  } catch {
    return process.cwd();
  }
}

export function getDaemonRecordPath(key: string): string {
  return path.join(getConfigDir(), `daemon-${key}.json`);
}

function getDaemonLockPath(key: string): string {
  return path.join(getConfigDir(), `daemon-${key}.lock`);
}

export function writeDaemonRecord(record: DaemonRecord): void {
  fs.mkdirSync(getConfigDir(), { recursive: true });
  fs.writeFileSync(getDaemonRecordPath(record.key), JSON.stringify(record, null, 2));
}

function removeDaemonRecord(key: string): void {
  try {
    fs.unlinkSync(getDaemonRecordPath(key));
  } catch {
    // Already gone.
  }
}

export function removeDaemonRecordForProcess(key: string, pid: number): void {
  try {
    const record = JSON.parse(fs.readFileSync(getDaemonRecordPath(key), 'utf8')) as DaemonRecord;
    if (record.pid !== pid) return;
    removeDaemonRecord(key);
  } catch {
    // Missing or corrupt records will be cleaned opportunistically on next startup.
  }
}

function identityMatches(actual: DaemonIdentity | undefined, expected: DaemonIdentity): boolean {
  if (!actual) return false;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function readHealth(record: DaemonRecord): Promise<DaemonHealth | null> {
  const healthUrl = new URL('/health', record.url);
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
  if (!response.ok) return null;
  return await response.json() as DaemonHealth;
}

async function isRecordLive(record: DaemonRecord, expectedIdentity?: DaemonIdentity): Promise<boolean> {
  try {
    process.kill(record.pid, 0);
  } catch {
    return false;
  }

  try {
    const health = await readHealth(record);
    if (!health || health.name !== 'metro-mcp') return false;
    if (!expectedIdentity) return true;

    if (health.version !== expectedIdentity.version) {
      logger.warn(
        `Ignoring metro-mcp daemon ${record.url}: version ${health.version} does not match ${expectedIdentity.version}`
      );
      return false;
    }

    if (health.daemon?.key !== record.key || !identityMatches(health.daemon.identity, expectedIdentity)) {
      logger.warn(`Ignoring metro-mcp daemon ${record.url}: daemon identity does not match current launch context`);
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export async function readLiveRecord(key: string, expectedIdentity?: DaemonIdentity): Promise<DaemonRecord | null> {
  try {
    const record = JSON.parse(fs.readFileSync(getDaemonRecordPath(key), 'utf8')) as DaemonRecord;
    if (await isRecordLive(record, expectedIdentity)) return record;
  } catch {
    // Missing or corrupt record.
  }
  removeDaemonRecord(key);
  return null;
}

async function waitForRecord(key: string, expectedIdentity: DaemonIdentity): Promise<DaemonRecord> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const record = await readLiveRecord(key, expectedIdentity);
    if (record) return record;
    await sleep(100);
  }
  throw new Error('Timed out waiting for metro-mcp daemon to start');
}

async function withStartupLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(getConfigDir(), { recursive: true });
  const lockPath = getDaemonLockPath(key);
  const deadline = Date.now() + STARTUP_LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return await fn();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STARTUP_LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      await sleep(100);
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
      }
    }
  }

  throw new Error('Timed out waiting for metro-mcp daemon startup lock');
}

export async function cleanupStaleDaemonRecords(): Promise<void> {
  let entries: string[];
  try {
    entries = fs.readdirSync(getConfigDir());
  } catch {
    return;
  }

  await Promise.all(entries.map(async (entry) => {
    const match = /^daemon-([a-f0-9]+)\.json$/.exec(entry);
    if (!match) return;

    const key = match[1];
    try {
      const record = JSON.parse(fs.readFileSync(getDaemonRecordPath(key), 'utf8')) as DaemonRecord;
      if (await isRecordLive(record)) return;
    } catch {
      // Corrupt records are stale.
    }
    removeDaemonRecord(key);
  }));
}

async function ensureDaemon(args: string[]): Promise<DaemonRecord> {
  const identity = createDaemonIdentity(args);
  const key = getDaemonKey(args, identity);
  await cleanupStaleDaemonRecords();

  const existing = await readLiveRecord(key, identity);
  if (existing) return existing;

  return withStartupLock(key, async () => {
    const lockedExisting = await readLiveRecord(key, identity);
    if (lockedExisting) return lockedExisting;

    const entry = process.argv[1];
    if (!entry) throw new Error('Cannot locate metro-mcp entrypoint for daemon startup');

    const child = spawn(process.execPath, [entry, 'serve', ...args], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        [DAEMON_KEY_ENV]: key,
      },
    });
    child.unref();

    logger.info('Started metro-mcp daemon');
    return waitForRecord(key, identity);
  });
}

export function getDaemonKeyFromEnv(args: string[], identity = createDaemonIdentity(args)): string {
  return process.env[DAEMON_KEY_ENV] || getDaemonKey(args, identity);
}

export async function startStdioProxy(args: string[]): Promise<void> {
  const record = await ensureDaemon(args);
  const stdio = new StdioServerTransport();
  const daemonTransport = new StreamableHTTPClientTransport(new URL(record.url));
  let closing = false;

  async function closeQuietly(transport: { close(): Promise<void> }): Promise<void> {
    await transport.close().catch(() => {});
  }

  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    await Promise.all([
      closeQuietly(stdio),
      closeQuietly(daemonTransport),
    ]);
    process.exit(0);
  }

  stdio.onmessage = (message: JSONRPCMessage) => {
    daemonTransport.send(message).catch((err) => {
      logger.error('Failed to forward stdio message to daemon:', err);
      void close();
    });
  };
  daemonTransport.onmessage = (message: JSONRPCMessage) => {
    stdio.send(message).catch((err) => {
      logger.error('Failed to forward daemon message to stdio:', err);
      void close();
    });
  };
  stdio.onerror = (err) => logger.error('stdio transport error:', err);
  daemonTransport.onerror = (err) => logger.error('daemon transport error:', err);
  stdio.onclose = () => void close();
  daemonTransport.onclose = () => void close();

  await daemonTransport.start();
  await stdio.start();
  logger.info(`Connected stdio client to metro-mcp daemon ${record.url}`);
}
