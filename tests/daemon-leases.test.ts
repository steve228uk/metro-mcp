import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createDaemonIdentity, getDaemonKey } from '../src/daemon.js';
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
});
