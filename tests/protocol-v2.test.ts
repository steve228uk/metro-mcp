import { afterEach, describe, expect, test } from 'bun:test';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { loadConfig } from '../src/config.js';
import { createMetroRuntime, startHttpServer } from '../src/server.js';

const clients: Client[] = [];
let server: Awaited<ReturnType<typeof startHttpServer>> | undefined;

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await server?.close().catch(() => {});
  server = undefined;
});

async function startTestServer() {
  const config = await loadConfig(['--project-root', process.cwd()]);
  config.metro.host = '127.0.0.1';
  config.metro.port = 65535;
  config.metro.autoDiscover = false;
  config.proxy.enabled = false;
  server = await startHttpServer(config, ['--project-root', process.cwd()], {
    port: 0,
  });
  return server;
}

function createClient(url: string, modern: boolean): Client {
  const client = new Client(
    {
      name: modern ? 'metro-mcp-modern-test' : 'metro-mcp-legacy-test',
      version: '1.0.0',
    },
    modern ? { versionNegotiation: { mode: 'auto' } } : undefined,
  );
  clients.push(client);
  void url;
  return client;
}

async function expectDirectStdioResourceUpdate(modern: boolean) {
  const config = await loadConfig(['--project-root', process.cwd()]);
  config.metro.host = '127.0.0.1';
  config.metro.port = 65535;
  config.metro.autoDiscover = false;
  config.proxy.enabled = false;
  const runtime = await createMetroRuntime(config, [
    '--project-root',
    process.cwd(),
  ]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = createClient('stdio', modern);
  let receivedUpdate: ((uri: string) => void) | undefined;
  const update = new Promise<string>((resolve) => {
    receivedUpdate = resolve;
  });
  client.setNotificationHandler('notifications/resources/updated', (notification) => {
    receivedUpdate?.(notification.params.uri);
  });

  try {
    await runtime.startStdio(serverTransport);
    await client.connect(clientTransport);
    if (modern) {
      const subscription = await client.listen({
        resourceSubscriptions: ['metro://logs'],
      });
      expect(subscription.honoredFilter.resourceSubscriptions).toEqual([
        'metro://logs',
      ]);
    } else {
      await client.subscribeResource({ uri: 'metro://logs' });
    }

    runtime.notifyResourceUpdated('metro://logs');
    expect(
      await Promise.race([
        update,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('resource update timed out')), 1000),
        ),
      ]),
    ).toBe('metro://logs');
  } finally {
    await client.close().catch(() => {});
    runtime.close();
  }
}

describe('V2 HTTP compatibility', () => {
  test('serves modern negotiation, tools, resources, prompts, and app metadata', async () => {
    const running = await startTestServer();
    const client = createClient(running.url, true);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(running.url)),
    );

    expect(client.getProtocolEra()).toBe('modern');
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === 'list_devices')).toBe(true);
    const consoleTool = tools.tools.find(
      (tool) => tool.name === 'get_console_logs',
    );
    expect(consoleTool?._meta).toMatchObject({
      ui: { resourceUri: 'ui://metro/console' },
      'ui/resourceUri': 'ui://metro/console',
    });

    const result = await client.callTool({
      name: 'get_app_info',
      arguments: {},
    });
    expect(result.content?.[0]).toMatchObject({ type: 'text' });

    const resources = await client.listResources();
    expect(
      resources.resources.some((resource) => resource.uri === 'metro://logs'),
    ).toBe(true);
    const app = await client.readResource({ uri: 'ui://metro/console' });
    expect(app.contents[0]).toMatchObject({
      mimeType: 'text/html;profile=mcp-app',
    });

    const prompts = await client.listPrompts();
    expect(prompts.prompts.some((prompt) => prompt.name === 'debug-app')).toBe(
      true,
    );
    expect(
      (await client.getPrompt({ name: 'debug-app' })).messages.length,
    ).toBeGreaterThan(0);
  });

  test('keeps the 2025-era initialize path on /mcp and removes legacy SSE endpoints', async () => {
    const running = await startTestServer();
    expect((await fetch(new URL('/sse', running.url))).status).toBe(404);
    expect((await fetch(new URL('/messages', running.url))).status).toBe(404);

    const client = createClient(running.url, false);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(running.url)),
    );
    expect(client.getProtocolEra()).toBe('legacy');
    expect((await client.listTools()).tools.length).toBeGreaterThan(20);
    await client.subscribeResource({ uri: 'metro://logs' });
  });
});

describe('direct stdio compatibility', () => {
  test('delivers modern resource updates through subscriptions/listen', async () => {
    await expectDirectStdioResourceUpdate(true);
  });

  test('delivers legacy resource updates through resources/subscribe', async () => {
    await expectDirectStdioResourceUpdate(false);
  });
});
