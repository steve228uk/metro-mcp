import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createLogger } from './utils/logger.js';
import { version } from './version.js';
import { resolveProjectRoot } from './config.js';

const logger = createLogger('daemon');

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.config', 'metro-mcp');
const DAEMON_KEY_ENV = 'METRO_MCP_DAEMON_KEY';
const DAEMON_CONFIG_DIR_ENV = 'METRO_MCP_DAEMON_CONFIG_DIR';
const STARTUP_LOCK_TIMEOUT_MS = 10_000;
const STARTUP_LOCK_STALE_MS = 30_000;
const DAEMON_LEASE_RENEW_MS = 10_000;
export const DAEMON_LEASE_TTL_MS = 30_000;
export const DAEMON_IDLE_GRACE_MS = 30_000;
const DAEMON_ENV_KEYS = [
  'METRO_HOST',
  'METRO_PORT',
  'METRO_MCP_CONFIG',
  'METRO_MCP_PLUGINS',
  'METRO_MCP_PROJECT_ROOT',
  'METRO_MCP_PROXY_PORT',
  'METRO_MCP_PROXY_ENABLED',
] as const;

export interface DaemonIdentity {
  version: string;
  cwd: string;
  projectRoot: string;
  args: string[];
  env: Record<string, string | undefined>;
  entrypoint: string;
  runtime: string;
  input?: {
    nativeBackend?: 'auto' | 'simview' | 'idb';
    simviewCommand?: string;
    idbCommand?: string;
  };
}

/** The resolved configuration fields that affect daemon ownership. */
export interface DaemonIdentityOverrides {
  projectRoot?: string;
  input?: DaemonIdentity['input'];
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
  /** Whether the server was auto-spawned and requires client leases. */
  managed?: boolean;
  startedAt: string;
}

export interface DaemonHealth {
  ok: boolean;
  name: string;
  version: string;
  daemon?: {
    keyHash: string;
    identityHash: string;
    managed?: boolean;
  };
}

export interface DaemonLeaseRegistryOptions {
  leaseTtlMs?: number;
  idleGraceMs?: number;
  onIdle: () => void | Promise<void>;
}

export class DaemonLeaseRegistry {
  private leases = new Map<string, ReturnType<typeof setTimeout>>();
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private idleTriggered = false;
  private readonly leaseTtlMs: number;
  private readonly idleGraceMs: number;

  constructor(private readonly options: DaemonLeaseRegistryOptions) {
    this.leaseTtlMs = options.leaseTtlMs ?? DAEMON_LEASE_TTL_MS;
    this.idleGraceMs = options.idleGraceMs ?? DAEMON_IDLE_GRACE_MS;
    this.scheduleGrace();
  }

  renew(clientId: string): boolean {
    if (this.closed || this.idleTriggered) return false;
    const existing = this.leases.get(clientId);
    if (existing) clearTimeout(existing);
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    const expiry = setTimeout(() => {
      this.leases.delete(clientId);
      this.scheduleGrace();
    }, this.leaseTtlMs);
    expiry.unref?.();
    this.leases.set(clientId, expiry);
    return true;
  }

  release(clientId: string): void {
    if (this.closed || this.idleTriggered) return;
    const expiry = this.leases.get(clientId);
    if (!expiry) return;
    clearTimeout(expiry);
    this.leases.delete(clientId);
    this.scheduleGrace();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const expiry of this.leases.values()) clearTimeout(expiry);
    this.leases.clear();
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  get size(): number {
    return this.leases.size;
  }

  private scheduleGrace(): void {
    if (
      this.closed ||
      this.idleTriggered ||
      this.leases.size > 0 ||
      this.graceTimer
    ) {
      return;
    }
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (this.closed || this.leases.size > 0 || this.idleTriggered) return;
      this.idleTriggered = true;
      Promise.resolve(this.options.onIdle()).catch((err) => {
        logger.error('Managed daemon idle shutdown failed:', err);
      });
    }, this.idleGraceMs);
    this.graceTimer.unref?.();
  }
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

export function createDaemonIdentity(
  args: string[],
  overrides: Partial<DaemonIdentity> = {},
): DaemonIdentity {
  const projectRoot =
    overrides.projectRoot ?? overrides.cwd ?? getDaemonCwd();
  return {
    version: overrides.version ?? version,
    // Daemon ownership is project-scoped. The launcher's incidental working
    // directory must not split one project across multiple daemon keys.
    cwd: projectRoot,
    projectRoot,
    args: overrides.args ?? [...args],
    env: overrides.env ?? selectedEnv(),
    entrypoint: overrides.entrypoint ?? resolvePath(process.argv[1]),
    runtime: overrides.runtime ?? resolvePath(process.execPath),
    ...(overrides.input ? { input: structuredClone(overrides.input) } : {}),
  };
}

export function getDaemonKey(
  args: string[],
  identity = createDaemonIdentity(args),
): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(identity));
  return hash.digest('hex').slice(0, 16);
}

export function getDaemonIdentityFingerprint(identity: DaemonIdentity): string {
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export function getDaemonKeyFingerprint(key: string): string {
  return createHash('sha256')
    .update('metro-mcp-daemon-key\0')
    .update(key)
    .digest('hex');
}

function ensureConfigDir(): void {
  fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  fs.chmodSync(getConfigDir(), 0o700);
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

export function getDaemonLockPath(key: string): string {
  return path.join(getConfigDir(), `daemon-${key}.lock`);
}

export function writeDaemonRecord(record: DaemonRecord): void {
  ensureConfigDir();
  fs.writeFileSync(
    getDaemonRecordPath(record.key),
    JSON.stringify(record, null, 2),
    { mode: 0o600 },
  );
  fs.chmodSync(getDaemonRecordPath(record.key), 0o600);
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
    const record = JSON.parse(
      fs.readFileSync(getDaemonRecordPath(key), 'utf8'),
    ) as DaemonRecord;
    if (record.pid !== pid) return;
    removeDaemonRecord(key);
  } catch {
    // Missing or corrupt records will be cleaned opportunistically on next startup.
  }
}

function identityMatches(
  actual: DaemonIdentity | undefined,
  expected: DaemonIdentity,
): boolean {
  if (!actual) return false;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function parseLocalDaemonUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

async function readHealth(record: DaemonRecord): Promise<DaemonHealth | null> {
  const daemonUrl = parseLocalDaemonUrl(record.url);
  if (!daemonUrl) return null;
  const healthUrl = new URL('/health', daemonUrl);
  const response = await fetch(healthUrl, {
    signal: AbortSignal.timeout(1000),
  });
  if (!response.ok) return null;
  return (await response.json()) as DaemonHealth;
}

async function isRecordLive(
  record: DaemonRecord,
  expectedIdentity?: DaemonIdentity,
): Promise<boolean> {
  if (!isProcessAlive(record.pid)) return false;

  try {
    const health = await readHealth(record);
    if (!health || health.name !== 'metro-mcp') return false;
    if (!expectedIdentity) return true;

    if (health.version !== expectedIdentity.version) {
      logger.warn(
        `Ignoring metro-mcp daemon ${record.url}: version ${health.version} does not match ${expectedIdentity.version}`,
      );
      return false;
    }

    const daemon = health.daemon;
    if (
      !daemon ||
      daemon.keyHash !== getDaemonKeyFingerprint(record.key) ||
      daemon.identityHash !== getDaemonIdentityFingerprint(expectedIdentity) ||
      !identityMatches(record.identity, expectedIdentity)
    ) {
      logger.warn(
        `Ignoring metro-mcp daemon ${record.url}: daemon identity does not match current launch context`,
      );
      return false;
    }

    record.managed = daemon.managed === true;
    return true;
  } catch {
    return false;
  }
}

export async function readLiveRecord(
  key: string,
  expectedIdentity?: DaemonIdentity,
): Promise<DaemonRecord | null> {
  try {
    const record = JSON.parse(
      fs.readFileSync(getDaemonRecordPath(key), 'utf8'),
    ) as DaemonRecord;
    if (await isRecordLive(record, expectedIdentity)) return record;
  } catch {
    // Missing or corrupt record.
  }
  removeDaemonRecord(key);
  return null;
}

async function waitForRecord(
  key: string,
  expectedIdentity: DaemonIdentity,
): Promise<DaemonRecord> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const record = await readLiveRecord(key, expectedIdentity);
    if (record) return record;
    await sleep(100);
  }
  throw new Error('Timed out waiting for metro-mcp daemon to start');
}

export async function withStartupLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  ensureConfigDir();
  const lockPath = getDaemonLockPath(key);
  const deadline = Date.now() + STARTUP_LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let fd: number | null = null;
    let lockToken: string | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      lockToken = randomUUID();
      fs.writeFileSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
          token: lockToken,
        }),
      );
      heartbeat = setInterval(() => {
        try {
          const now = new Date();
          fs.futimesSync(fd!, now, now);
        } catch {
          // The owned lock descriptor may already be closing.
        }
      }, Math.floor(STARTUP_LOCK_STALE_MS / 3));
      heartbeat.unref?.();
      return await fn();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const snapshot = readStartupLock(lockPath);
      if (!snapshot) continue;
      const stale = Date.now() - snapshot.mtimeMs > STARTUP_LOCK_STALE_MS;
      if ((snapshot.valid && !isProcessAlive(snapshot.pid)) || stale) {
        removeStartupLockIfUnchanged(lockPath, snapshot);
        continue;
      }
      await sleep(100);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
        if (lockToken) removeStartupLockIfOwned(lockPath, lockToken);
      }
    }
  }

  throw new Error('Timed out waiting for metro-mcp daemon startup lock');
}

function isProcessAlive(pid: number | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A process we cannot signal still exists; only a missing/invalid PID is dead.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readStartupLockToken(lockPath: string): string | null {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
      token?: unknown;
    };
    return typeof lock.token === 'string' ? lock.token : null;
  } catch {
    return null;
  }
}

function removeStartupLockIfOwned(lockPath: string, token: string): void {
  if (readStartupLockToken(lockPath) !== token) return;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // The lock may have been removed concurrently.
  }
}

interface StartupLockSnapshot {
  contents: string;
  device: number;
  inode: number;
  mtimeMs: number;
  size: number;
  pid?: number;
  valid: boolean;
}

function readStartupLock(lockPath: string): StartupLockSnapshot | null {
  try {
    const stat = fs.statSync(lockPath);
    const contents = fs.readFileSync(lockPath, 'utf8');
    let pid: number | undefined;
    let valid = false;
    try {
      const lock = JSON.parse(contents) as { pid?: unknown; token?: unknown };
      if (typeof lock.pid === 'number' && typeof lock.token === 'string') {
        pid = lock.pid;
        valid = true;
      }
    } catch {
      // A process may have created the file and not written its payload yet.
    }
    return {
      contents,
      device: stat.dev,
      inode: stat.ino,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      pid,
      valid,
    };
  } catch {
    return null;
  }
}

function removeStartupLockIfUnchanged(
  lockPath: string,
  expected: StartupLockSnapshot,
): void {
  try {
    const current = fs.statSync(lockPath);
    if (
      current.dev !== expected.device ||
      current.ino !== expected.inode ||
      current.mtimeMs !== expected.mtimeMs ||
      current.size !== expected.size ||
      fs.readFileSync(lockPath, 'utf8') !== expected.contents
    ) return;
    fs.unlinkSync(lockPath);
  } catch {
    // The lock may have been replaced or removed concurrently.
  }
}

export async function cleanupStaleDaemonRecords(): Promise<void> {
  ensureConfigDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(getConfigDir());
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const recordMatch = /^daemon-([a-f0-9]+)\.json$/.exec(entry);
      if (recordMatch) {
        const key = recordMatch[1];
        try {
          const record = JSON.parse(
            fs.readFileSync(getDaemonRecordPath(key), 'utf8'),
          ) as DaemonRecord;
          if (await isRecordLive(record)) return;
        } catch {
          // Corrupt records are stale.
        }
        removeDaemonRecord(key);
        return;
      }

      const lockMatch = /^daemon-([a-f0-9]+)\.lock$/.exec(entry);
      if (!lockMatch) return;
      const lockPath = getDaemonLockPath(lockMatch[1]);
      const snapshot = readStartupLock(lockPath);
      if (!snapshot) return;
      const stale = Date.now() - snapshot.mtimeMs > STARTUP_LOCK_STALE_MS;
      if (!stale && (!snapshot.valid || isProcessAlive(snapshot.pid))) return;
      removeStartupLockIfUnchanged(lockPath, snapshot);
    }),
  );
}

async function ensureDaemon(
  args: string[],
  overrides: DaemonIdentityOverrides = {},
): Promise<DaemonRecord> {
  const identity = createDaemonIdentity(args, {
    ...overrides,
    projectRoot: overrides.projectRoot ?? resolveProjectRoot(args),
  });
  const key = getDaemonKey(args, identity);
  await cleanupStaleDaemonRecords();

  const existing = await readLiveRecord(key, identity);
  if (existing) return existing;

  return withStartupLock(key, async () => {
    const lockedExisting = await readLiveRecord(key, identity);
    if (lockedExisting) return lockedExisting;

    const entry = process.argv[1];
    if (!entry)
      throw new Error('Cannot locate metro-mcp entrypoint for daemon startup');

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

export function getDaemonKeyFromEnv(
  args: string[],
  identity = createDaemonIdentity(args),
): string {
  return process.env[DAEMON_KEY_ENV] || getDaemonKey(args, identity);
}

export function isManagedDaemonProcess(): boolean {
  return Boolean(process.env[DAEMON_KEY_ENV]);
}

async function updateDaemonLease(
  record: DaemonRecord,
  clientId: string,
  method: 'PUT' | 'DELETE',
): Promise<void> {
  const daemonUrl = parseLocalDaemonUrl(record.url);
  if (!daemonUrl) {
    throw new Error(`Refusing daemon lease request to non-local URL: ${record.url}`);
  }
  const leaseUrl = new URL(
    `/_metro-mcp/clients/${encodeURIComponent(clientId)}`,
    daemonUrl,
  );
  const response = await fetch(leaseUrl, {
    method,
    headers: { 'x-metro-mcp-daemon-key': record.key },
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) {
    throw new Error(`Daemon lease ${method} failed with HTTP ${response.status}`);
  }
}

type DaemonLeaseUpdater = (
  record: DaemonRecord,
  clientId: string,
  method: 'PUT' | 'DELETE',
) => Promise<void>;

export interface DaemonLeaseClientOptions {
  clientId?: string;
  renewIntervalMs?: number;
  update?: DaemonLeaseUpdater;
}

/** Serializes lease shutdown behind initial acquisition and any renewal. */
export class DaemonLeaseClient {
  private readonly clientId: string;
  private readonly renewIntervalMs: number;
  private readonly update: DaemonLeaseUpdater;
  private renewalTimer: ReturnType<typeof setInterval> | null = null;
  private startPromise: Promise<void> | null = null;
  private renewalRequest: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private acquired = false;
  private stopping = false;

  constructor(
    private readonly record: DaemonRecord,
    options: DaemonLeaseClientOptions = {},
  ) {
    this.clientId = options.clientId ?? randomUUID();
    this.renewIntervalMs =
      options.renewIntervalMs ?? DAEMON_LEASE_RENEW_MS;
    this.update = options.update ?? updateDaemonLease;
  }

  start(): Promise<void> {
    if (this.record.managed !== true || this.stopping) {
      return Promise.resolve();
    }
    if (!this.startPromise) this.startPromise = this.acquire();
    return this.startPromise;
  }

  private async acquire(): Promise<void> {
    await this.update(this.record, this.clientId, 'PUT');
    this.acquired = true;
    if (this.stopping) return;
    this.renewalTimer = setInterval(
      () => this.renew(),
      this.renewIntervalMs,
    );
    this.renewalTimer.unref?.();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    if (this.renewalTimer) clearInterval(this.renewalTimer);
    this.renewalTimer = null;
    this.stopPromise = (async () => {
      await this.startPromise?.catch(() => {});
      await this.renewalRequest?.catch(() => {});
      await this.release();
    })();
    return this.stopPromise;
  }

  private renew(): void {
    if (this.stopping || !this.acquired || this.renewalRequest) return;
    const request = this.update(this.record, this.clientId, 'PUT');
    this.renewalRequest = request;
    void request
      .catch((err) => logger.warn('Failed to renew daemon lease:', err))
      .finally(() => {
        if (this.renewalRequest === request) this.renewalRequest = null;
      });
  }

  private async release(): Promise<void> {
    if (!this.acquired) return;
    this.acquired = false;
    await this.update(this.record, this.clientId, 'DELETE');
  }
}

/** SDK stdio transports do not turn stdin EOF into an onclose notification. */
export function registerStdioProxyShutdown(
  shutdown: () => void,
  input: EventEmitter = process.stdin,
  lifecycle: EventEmitter = process,
): () => void {
  let requested = false;
  const requestShutdown = () => {
    if (requested) return;
    requested = true;
    shutdown();
  };
  input.on('end', requestShutdown);
  input.on('close', requestShutdown);
  lifecycle.on('SIGINT', requestShutdown);
  lifecycle.on('SIGTERM', requestShutdown);
  lifecycle.on('beforeExit', requestShutdown);
  return () => {
    input.off('end', requestShutdown);
    input.off('close', requestShutdown);
    lifecycle.off('SIGINT', requestShutdown);
    lifecycle.off('SIGTERM', requestShutdown);
    lifecycle.off('beforeExit', requestShutdown);
  };
}

export async function startStdioProxy(
  args: string[],
  identityOverrides: DaemonIdentityOverrides = {},
): Promise<void> {
  const record = await ensureDaemon(args, identityOverrides);
  const lease = new DaemonLeaseClient(record);
  const stdio = new StdioServerTransport();
  const daemonTransport = new StreamableHTTPClientTransport(
    new URL(record.url),
  );
  let closing = false;
  const removeShutdownListeners = registerStdioProxyShutdown(() => void close());

  async function closeQuietly(transport: {
    close(): Promise<void>;
  }): Promise<void> {
    await transport.close().catch(() => {});
  }

  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    await lease.stop().catch(() => {});
    await Promise.all([closeQuietly(stdio), closeQuietly(daemonTransport)]);
    removeShutdownListeners();
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
  daemonTransport.onerror = (err) =>
    logger.error('daemon transport error:', err);
  stdio.onclose = () => void close();
  daemonTransport.onclose = () => void close();

  await lease.start();

  await daemonTransport.start();
  await stdio.start();
  logger.info(`Connected stdio client to metro-mcp daemon ${record.url}`);
}
