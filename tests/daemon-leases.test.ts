import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import {
  DaemonLeaseClient,
  createDaemonIdentity,
  getDaemonKey,
  type DaemonRecord,
} from '../src/daemon.js';
import { startHttpServer } from '../src/server.js';

const servers: Array<Awaited<ReturnType<typeof startHttpServer>>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

async function startLeaseServer(options: {
  managed?: boolean;
  leaseTtlMs?: number;
  idleGraceMs?: number;
  onIdle: () => void | Promise<void>;
}) {
  const args = ['--project-root', process.cwd(), '--port', '65535'];
  const config = await loadConfig(args);
  config.metro.host = '127.0.0.1';
  config.metro.port = 65535;
  config.metro.autoDiscover = false;
  config.proxy.enabled = false;
  const identity = createDaemonIdentity(args, {
    projectRoot: config.projectRoot,
  });
  const key = getDaemonKey(args, identity);
  const server = await startHttpServer(config, args, {
    port: 0,
    daemon: {
      key,
      identity,
      managed: options.managed ?? true,
      leaseTtlMs: options.leaseTtlMs,
      idleGraceMs: options.idleGraceMs,
    },
    onManagedDaemonIdle: options.onIdle,
  });
  servers.push(server);
  return { server, key };
}

async function updateLease(
  server: Awaited<ReturnType<typeof startHttpServer>>,
  key: string,
  clientId: string,
  method: 'PUT' | 'DELETE',
  suppliedKey = key,
): Promise<Response> {
  return fetch(
    new URL(`/_metro-mcp/clients/${clientId}`, server.url),
    {
      method,
      headers: { 'x-metro-mcp-daemon-key': suppliedKey },
    },
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function expectPending(promise: Promise<void>, durationMs: number) {
  const settled = await Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), durationMs)),
  ]);
  expect(settled).toBe(false);
}

describe('managed daemon leases', () => {
  test('requires the matching daemon key', async () => {
    const idle = deferred();
    const { server, key } = await startLeaseServer({
      idleGraceMs: 500,
      onIdle: idle.resolve,
    });

    const response = await updateLease(
      server,
      key,
      randomUUID(),
      'PUT',
      'wrong-key',
    );

    expect(response.status).toBe(403);
  });

  test('renews one lease and shuts down after it is released', async () => {
    const idle = deferred();
    const { server, key } = await startLeaseServer({
      leaseTtlMs: 100,
      idleGraceMs: 35,
      onIdle: idle.resolve,
    });
    const clientId = randomUUID();

    expect((await updateLease(server, key, clientId, 'PUT')).status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await updateLease(server, key, clientId, 'PUT')).status).toBe(204);
    await expectPending(idle.promise, 45);
    expect((await updateLease(server, key, clientId, 'DELETE')).status).toBe(
      204,
    );
    await expect(idle.promise).resolves.toBeUndefined();
  });

  test('keeps the daemon alive until the final concurrent client releases', async () => {
    const idle = deferred();
    const { server, key } = await startLeaseServer({
      leaseTtlMs: 200,
      idleGraceMs: 35,
      onIdle: idle.resolve,
    });
    const first = randomUUID();
    const second = randomUUID();
    await updateLease(server, key, first, 'PUT');
    await updateLease(server, key, second, 'PUT');

    await updateLease(server, key, first, 'DELETE');
    await expectPending(idle.promise, 50);
    await updateLease(server, key, second, 'DELETE');
    await expect(idle.promise).resolves.toBeUndefined();
  });

  test('expires crashed clients and allows a new lease to cancel grace', async () => {
    const expiredIdle = deferred();
    const expired = await startLeaseServer({
      leaseTtlMs: 25,
      idleGraceMs: 25,
      onIdle: expiredIdle.resolve,
    });
    await updateLease(expired.server, expired.key, randomUUID(), 'PUT');
    await expect(expiredIdle.promise).resolves.toBeUndefined();

    const cancelledIdle = deferred();
    const cancelled = await startLeaseServer({
      leaseTtlMs: 200,
      idleGraceMs: 45,
      onIdle: cancelledIdle.resolve,
    });
    const first = randomUUID();
    const second = randomUUID();
    await updateLease(cancelled.server, cancelled.key, first, 'PUT');
    await updateLease(cancelled.server, cancelled.key, first, 'DELETE');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await updateLease(cancelled.server, cancelled.key, second, 'PUT');
    await expectPending(cancelledIdle.promise, 40);
    await updateLease(cancelled.server, cancelled.key, second, 'DELETE');
    await expect(cancelledIdle.promise).resolves.toBeUndefined();
  });

  test('does not apply idle shutdown to an explicit foreground server', async () => {
    const idle = deferred();
    await startLeaseServer({
      managed: false,
      leaseTtlMs: 20,
      idleGraceMs: 20,
      onIdle: idle.resolve,
    });

    await expectPending(idle.promise, 60);
  });

  test('rejects new leases after idle shutdown becomes irrevocable', async () => {
    const idle = deferred();
    const { server, key } = await startLeaseServer({
      idleGraceMs: 20,
      onIdle: idle.resolve,
    });
    await idle.promise;

    const response = await updateLease(
      server,
      key,
      randomUUID(),
      'PUT',
    );

    expect(response.status).toBe(409);
  });
});

function leaseRecord(
  managed: boolean,
  url = 'http://127.0.0.1:8765/mcp',
): DaemonRecord {
  const daemonIdentity = createDaemonIdentity([], {
    projectRoot: process.cwd(),
  });
  return {
    pid: process.pid,
    host: new URL(url).hostname,
    port: Number(new URL(url).port),
    url,
    key: getDaemonKey([], daemonIdentity),
    cwd: process.cwd(),
    args: [],
    identity: daemonIdentity,
    managed,
    startedAt: new Date().toISOString(),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('stdio daemon lease client', () => {
  test('does not lease an explicit foreground server', async () => {
    const methods: string[] = [];
    const client = new DaemonLeaseClient(leaseRecord(false), {
      update: async (_record, _clientId, method) => {
        methods.push(method);
      },
    });

    await client.start();
    await client.stop();

    expect(methods).toEqual([]);
  });

  test('waits for an in-flight renewal before releasing the lease', async () => {
    const methods: string[] = [];
    const renewal = deferred();
    let putCount = 0;
    const client = new DaemonLeaseClient(leaseRecord(true), {
      renewIntervalMs: 5,
      update: async (_record, _clientId, method) => {
        methods.push(method);
        if (method === 'PUT' && ++putCount === 2) await renewal.promise;
      },
    });
    await client.start();
    await waitUntil(() => putCount === 2);

    const stopping = client.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(methods).toEqual(['PUT', 'PUT']);
    renewal.resolve();
    await stopping;

    expect(methods).toEqual(['PUT', 'PUT', 'DELETE']);
  });

  test('refuses to send a daemon key to a non-local URL', async () => {
    const client = new DaemonLeaseClient(
      leaseRecord(true, 'http://example.com:8765/mcp'),
    );

    await expect(client.start()).rejects.toThrow(
      'Refusing daemon lease request to non-local URL',
    );
  });
});
