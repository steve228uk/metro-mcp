import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('daemon');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'metro-mcp');
const DAEMON_KEY_ENV = 'METRO_MCP_DAEMON_KEY';
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

interface DaemonRecord {
  pid: number;
  host: string;
  port: number;
  url: string;
  key: string;
  cwd: string;
  args: string[];
  startedAt: string;
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

export function getDaemonKey(args: string[]): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ args, cwd: getDaemonCwd(), env: selectedEnv() }));
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
  return path.join(CONFIG_DIR, `daemon-${key}.json`);
}

function getDaemonLockPath(key: string): string {
  return path.join(CONFIG_DIR, `daemon-${key}.lock`);
}

export function writeDaemonRecord(record: DaemonRecord): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(getDaemonRecordPath(record.key), JSON.stringify(record, null, 2));
}

function removeDaemonRecord(key: string): void {
  try {
    fs.unlinkSync(getDaemonRecordPath(key));
  } catch {
    // Already gone.
  }
}

async function isRecordLive(record: DaemonRecord): Promise<boolean> {
  try {
    process.kill(record.pid, 0);
  } catch {
    return false;
  }

  try {
    const healthUrl = new URL('/health', record.url);
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function readLiveRecord(key: string): Promise<DaemonRecord | null> {
  try {
    const record = JSON.parse(fs.readFileSync(getDaemonRecordPath(key), 'utf8')) as DaemonRecord;
    if (await isRecordLive(record)) return record;
  } catch {
    // Missing or corrupt record.
  }
  removeDaemonRecord(key);
  return null;
}

async function waitForRecord(key: string): Promise<DaemonRecord> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const record = await readLiveRecord(key);
    if (record) return record;
    await sleep(100);
  }
  throw new Error('Timed out waiting for metro-mcp daemon to start');
}

async function withStartupLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
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

async function ensureDaemon(args: string[]): Promise<DaemonRecord> {
  const key = getDaemonKey(args);
  const existing = await readLiveRecord(key);
  if (existing) return existing;

  return withStartupLock(key, async () => {
    const lockedExisting = await readLiveRecord(key);
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
    return waitForRecord(key);
  });
}

export function getDaemonKeyFromEnv(args: string[]): string {
  return process.env[DAEMON_KEY_ENV] || getDaemonKey(args);
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
