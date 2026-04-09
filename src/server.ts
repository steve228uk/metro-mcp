import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const execAsync = promisify(exec);
import { z } from 'zod';
import type {
  MetroMCPConfig,
  PluginContext,
  PluginDefinition,
  ToolConfig,
  ResourceConfig,
  PromptConfig,
  EvalOptions,
} from './plugin.js';
import { CDPSession, CDPMultiplexer, scanMetroPorts, selectBestTarget, fetchTargets, supportsMultipleDebuggers } from 'metro-bridge';
import type { MetroTarget } from 'metro-bridge';
import { MetroEventsClient } from './metro/events.js';
import { createLogger } from './utils/logger.js';
import { createFormatUtils } from './utils/format.js';
import { extractCDPExceptionMessage } from './utils/cdp.js';
import { version } from './version.js';

// Built-in plugins
import { consolePlugin } from './plugins/console.js';
import { networkPlugin } from './plugins/network.js';
import { errorsPlugin } from './plugins/errors.js';
import { evaluatePlugin } from './plugins/evaluate.js';
import { devicePlugin } from './plugins/device.js';
import { sourcePlugin } from './plugins/source.js';
import { reduxPlugin } from './plugins/redux.js';
import { componentsPlugin } from './plugins/components.js';
import { storagePlugin } from './plugins/storage.js';
import { simulatorPlugin } from './plugins/simulator.js';
import { deeplinkPlugin } from './plugins/deeplink.js';
import { uiInteractPlugin } from './plugins/ui-interact.js';
import { navigationPlugin } from './plugins/navigation.js';
import { accessibilityPlugin } from './plugins/accessibility.js';
import { commandsPlugin } from './plugins/commands.js';
import { testRecorderPlugin } from './plugins/test-recorder.js';
import { profilerPlugin } from './plugins/profiler.js';
import { promptsPlugin } from './plugins/prompts.js';
import { automationPlugin } from './plugins/automation.js';
import { statuslinePlugin } from './plugins/statusline.js';
import { debugGlobalsPlugin } from './plugins/debug-globals.js';
import { inspectPointPlugin } from './plugins/inspect-point.js';
import { devtoolsPlugin } from './plugins/devtools.js';

const logger = createLogger('server');

const BUILT_IN_PLUGINS: PluginDefinition[] = [
  consolePlugin,
  networkPlugin,
  errorsPlugin,
  evaluatePlugin,
  devicePlugin,
  sourcePlugin,
  reduxPlugin,
  componentsPlugin,
  storagePlugin,
  simulatorPlugin,
  deeplinkPlugin,
  uiInteractPlugin,
  navigationPlugin,
  accessibilityPlugin,
  commandsPlugin,
  testRecorderPlugin,
  profilerPlugin,
  promptsPlugin,
  automationPlugin,
  statuslinePlugin,
  debugGlobalsPlugin,
  inspectPointPlugin,
  devtoolsPlugin,
];

export async function startServer(config: Required<MetroMCPConfig>): Promise<void> {
  const mcpServer = new McpServer(
    {
      name: 'metro-mcp',
      version,
    },
    {
      instructions: `React Native runtime debugging MCP server. Connects to Metro bundler via Chrome DevTools Protocol to provide console logs, network requests, component tree inspection, state management debugging, device control, and more. Use list_devices to see connected targets, then use other tools to inspect and interact with the running app.`,
    }
  );

  const cdpSession = new CDPSession();
  const eventsClient = new MetroEventsClient();
  const formatUtils = createFormatUtils();

  // Track URIs that clients have subscribed to for live update notifications
  const subscribedResources = new Set<string>();

  // Wire up resource subscription handlers so clients can receive push notifications
  // when resource content changes (e.g. new logs, errors, network requests).
  mcpServer.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    subscribedResources.add(req.params.uri);
    logger.debug(`Client subscribed to resource: ${req.params.uri}`);
    return {};
  });

  mcpServer.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscribedResources.delete(req.params.uri);
    logger.debug(`Client unsubscribed from resource: ${req.params.uri}`);
    return {};
  });

  function notifyResourceUpdated(uri: string): void {
    if (subscribedResources.has(uri)) {
      mcpServer.server.sendResourceUpdated({ uri }).catch(() => {});
    }
  }

  // Active device tracking — used by plugins to key per-device buffers.
  let activeDeviceKey: string | null = null;
  let activeDeviceName: string | null = null;

  // Server-side reconnect state — single source of truth for all reconnect logic.
  // Start with a very short delay (500ms) to recover quickly from brief disconnects
  // like hot reloads, then ramp up for longer outages.
  const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 16000];
  const MAX_RECONNECT_ATTEMPTS = 15;
  let reconnectAttempts = 0;
  let isReconnecting = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function waitForReconnect(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!isReconnecting) { resolve(); return; }
      const check = setInterval(() => {
        if (!isReconnecting) { clearInterval(check); resolve(); }
      }, 100);
    });
  }

  // Enable required CDP domains on every connection (initial and reconnect).
  cdpSession.on('reconnected', async () => {
    reconnectAttempts = 0;
    isReconnecting = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    await Promise.all([
      cdpSession.send('Runtime.enable').catch(() => {}),
      cdpSession.send('Network.enable').catch(() => {}),
    ]);
  });

  // Drive all reconnection through connectToMetro() so we always get a fresh target URL.
  cdpSession.on('disconnected', () => {
    scheduleReconnect();
  });

  // Create the plugin context factory
  function createPluginContext(plugin: PluginDefinition): PluginContext {
    const pluginLogger = createLogger(plugin.name);
    return {
      cdp: cdpSession,
      events: eventsClient,
      registerTool: <T extends z.ZodType>(name: string, toolConfig: ToolConfig<T>) => {
        try {
          const inputSchema = toolConfig.parameters instanceof z.ZodObject
            ? (toolConfig.parameters as z.ZodObject<z.ZodRawShape>).shape
            : { input: toolConfig.parameters };

          mcpServer.registerTool(
            name,
            {
              description: toolConfig.description,
              inputSchema,
              annotations: toolConfig.annotations,
            },
            async (args, extra) => {
              // Build a sendProgress helper if the client sent a progressToken
              const progressToken = extra._meta?.progressToken;
              const sendProgress = progressToken !== undefined
                ? async (progress: number, total: number, message?: string) => {
                    await extra.sendNotification({
                      method: 'notifications/progress',
                      params: { progressToken, progress, total, ...(message ? { message } : {}) },
                    } as Parameters<typeof extra.sendNotification>[0]);
                  }
                : undefined;

              try {
                const result = await toolConfig.handler(args as z.infer<T>, { sendProgress });
                const content = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
                return { content: [{ type: 'text' as const, text: content }] };
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
              }
            }
          );
          pluginLogger.debug(`Registered tool: ${name}`);
        } catch (err) {
          pluginLogger.error(`Failed to register tool ${name}:`, err);
        }
      },
      registerResource: (uri: string, resourceConfig: ResourceConfig) => {
        try {
          mcpServer.resource(
            resourceConfig.name,
            uri,
            { description: resourceConfig.description, mimeType: resourceConfig.mimeType || 'application/json' },
            async () => {
              const content = await resourceConfig.handler();
              return { contents: [{ uri, text: content, mimeType: resourceConfig.mimeType || 'application/json' }] };
            }
          );
          pluginLogger.debug(`Registered resource: ${uri}`);
        } catch (err) {
          pluginLogger.error(`Failed to register resource ${uri}:`, err);
        }
      },
      registerPrompt: (name: string, promptConfig: PromptConfig) => {
        try {
          // Build args schema shape for MCP SDK
          const argsShape: Record<string, z.ZodType> = {};
          if (promptConfig.arguments) {
            for (const arg of promptConfig.arguments) {
              argsShape[arg.name] = arg.required ? z.string() : z.string().optional();
            }
          }
          mcpServer.prompt(
            name,
            promptConfig.description,
            argsShape,
            async (args) => {
              const messages = await promptConfig.handler(args as Record<string, string>);
              return {
                messages: messages.map((m) => ({
                  role: m.role as 'user' | 'assistant',
                  content: { type: 'text' as const, text: m.content },
                })),
              };
            }
          );
          pluginLogger.debug(`Registered prompt: ${name}`);
        } catch (err) {
          pluginLogger.error(`Failed to register prompt ${name}:`, err);
        }
      },
      evalInApp: async (expression: string, options?: EvalOptions) => {
        async function tryEval() {
          if (!cdpSession.isConnected) {
            if (isReconnecting) {
              // A reconnect is already in flight — wait for it rather than starting another
              await waitForReconnect();
            } else {
              // Reset the attempt counter so the background scheduler can resume
              // after this tool-triggered reconnect, rather than staying capped out.
              reconnectAttempts = 0;
              const connected = await cdpSession.waitForConnection();
              if (!connected) await connectToMetro();
            }
          }
          if (!cdpSession.isConnected) {
            throw new Error('Not connected to Metro. Use list_devices to check connection status.');
          }
          const result = (await cdpSession.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: options?.awaitPromise ?? false,
            timeout: options?.timeout,
          })) as Record<string, unknown>;
          if (result.exceptionDetails) {
            throw new Error(extractCDPExceptionMessage(result.exceptionDetails as Record<string, unknown>));
          }
          return (result.result as Record<string, unknown>).value;
        }
        try {
          return await tryEval();
        } catch (err) {
          if (err instanceof Error && (
            err.message === 'WebSocket closed' ||
            err.message === 'Not connected to CDP target' ||
            err.message === 'Not connected to Metro. Use list_devices to check connection status.'
          )) {
            if (isReconnecting) {
              await waitForReconnect();
            } else {
              reconnectAttempts = 0;
              await connectToMetro();
            }
            return await tryEval();
          }
          throw err;
        }
      },
      config: config as unknown as Record<string, unknown>,
      logger: pluginLogger,
      metro: {
        host: config.metro.host!,
        port: config.metro.port!,
        fetch: async (path: string) => {
          return fetch(`http://${config.metro.host}:${config.metro.port}${path}`);
        },
      },
      exec: async (command: string) => {
        const { stdout } = await execAsync(command);
        return stdout;
      },
      format: formatUtils,
      getActiveDeviceKey: () => activeDeviceKey,
      getActiveDeviceName: () => activeDeviceName,
      notifyResourceUpdated,
    };
  }

  // Load and initialize all plugins
  const allPlugins = [...BUILT_IN_PLUGINS];

  // Load external plugins from config
  for (const pluginPath of config.plugins) {
    try {
      const mod = await import(pluginPath);
      const plugin: PluginDefinition = mod.default || mod;
      if (plugin?.name && typeof plugin?.setup === 'function') {
        allPlugins.push(plugin);
        logger.info(`Loaded external plugin: ${plugin.name}`);
      }
    } catch (err) {
      logger.error(`Failed to load plugin ${pluginPath}:`, err);
    }
  }

  // Initialize plugins
  for (const plugin of allPlugins) {
    try {
      const ctx = createPluginContext(plugin);
      await plugin.setup(ctx);
      logger.debug(`Initialized plugin: ${plugin.name}`);
    } catch (err) {
      logger.error(`Failed to initialize plugin ${plugin.name}:`, err);
    }
  }

  // Singleton proxy lock — prevents multiple metro-mcp instances from competing
  // for Metro's single CDP WebSocket, which causes a connect/disconnect spam loop.
  // The first instance connects directly to Metro and writes its CDP proxy port to
  // a lock file. Subsequent instances detect the lock and connect through the
  // existing proxy instead.
  const PROXY_LOCK_FILE = '/tmp/metro-mcp-proxy.json';
  let isPrimaryInstance = false;

  async function tryConnectViaProxy(): Promise<boolean> {
    try {
      const lockData = JSON.parse(fs.readFileSync(PROXY_LOCK_FILE, 'utf8'));
      if (lockData.pid && lockData.port) {
        // Check if the owning process is still alive
        try { process.kill(lockData.pid, 0); } catch { return false; }
        const resp = await fetch(`http://127.0.0.1:${lockData.port}/json`, {
          signal: AbortSignal.timeout(2000),
        });
        if (!resp.ok) return false;
        const targets = await resp.json() as Array<{ id?: string; title?: string; webSocketDebuggerUrl?: string }>;
        if (targets.length > 0 && targets[0].webSocketDebuggerUrl) {
          logger.info(
            `Found existing metro-mcp proxy (PID ${lockData.pid}, port ${lockData.port}) — connecting as secondary`
          );
          await cdpSession.connectToTarget(targets[0] as unknown as MetroTarget);
          if (lockData.metroPort) {
            eventsClient.connect(config.metro.host!, lockData.metroPort);
            config.metro.port = lockData.metroPort;
          }
          // Point devtools plugin at the primary's proxy so open_devtools uses the right port
          (config as Record<string, unknown>).proxy = {
            ...config.proxy,
            port: lockData.port,
          };
          activeDeviceKey = targets[0].id ? `${lockData.port}-${targets[0].id}` : null;
          activeDeviceName = targets[0].title || targets[0].id || 'secondary';
          return true;
        }
      }
    } catch {
      // Lock file missing, stale, or unreadable — fall through to direct connect
    }
    return false;
  }

  function writeProxyLock(proxyPort: number, metroPort: number): void {
    try {
      fs.writeFileSync(
        PROXY_LOCK_FILE,
        JSON.stringify({ pid: process.pid, port: proxyPort, metroPort })
      );
      isPrimaryInstance = true;
      logger.info(`Wrote proxy lock (port ${proxyPort})`);
    } catch (err) {
      logger.warn('Failed to write proxy lock:', err);
    }
  }

  function cleanProxyLock(): void {
    if (!isPrimaryInstance) return;
    try {
      const lockData = JSON.parse(fs.readFileSync(PROXY_LOCK_FILE, 'utf8'));
      if (lockData.pid === process.pid) {
        fs.unlinkSync(PROXY_LOCK_FILE);
      }
    } catch {
      // Already cleaned or another instance took over
    }
  }

  // Connect to Metro — always re-discovers targets to get a fresh webSocketDebuggerUrl.
  // Idempotent: concurrent callers wait for the in-flight attempt to finish.
  async function connectToMetro(): Promise<boolean> {
    if (isReconnecting) {
      await waitForReconnect();
      return cdpSession.isConnected;
    }
    isReconnecting = true;
    try {
      // If another metro-mcp instance is already connected, piggyback on its proxy
      if (await tryConnectViaProxy()) {
        return true;
      }

      let servers;
      if (config.metro.autoDiscover) {
        servers = await scanMetroPorts(config.metro.host!);
      } else {
        const targets = await fetchTargets(config.metro.host!, config.metro.port!);
        servers = targets.length > 0 ? [{ host: config.metro.host!, port: config.metro.port!, targets }] : [];
      }

      if (servers.length === 0) {
        logger.warn('No Metro servers found. Tools will report disconnected status.');
        return false;
      }

      const server = servers[0];
      config.metro.port = server.port;
      const target = selectBestTarget(server.targets);

      if (!target) {
        logger.warn('No suitable CDP target found.');
        return false;
      }

      await cdpSession.connectToTarget(target);
      eventsClient.connect(server.host, server.port);

      // Track active device for per-device buffers
      activeDeviceKey = `${server.port}-${target.id}`;
      activeDeviceName = target.title || target.deviceName || target.id;

      if (supportsMultipleDebuggers(target)) {
        logger.info('Target supports multiple debuggers (RN 0.85+) — skipping CDP proxy');
      } else {
        if (!cdpMultiplexer && config.proxy?.enabled !== false) {
          const mux = new CDPMultiplexer(cdpSession, { protectedDomains: ['Runtime', 'Network'] });
          try {
            const startedPort = await mux.start(preferredProxyPort);
            const devtoolsUrl = mux.getDevToolsUrl();
            logger.info(`CDP proxy started on port ${startedPort}`);
            if (devtoolsUrl) logger.info(`Chrome DevTools URL: ${devtoolsUrl}`);
            (config as Record<string, unknown>).proxy = {
              ...config.proxy,
              port: startedPort,
              url: devtoolsUrl,
            };
            cdpMultiplexer = mux;
          } catch (err) {
            logger.warn('Could not start CDP proxy:', err);
          }
        }

        const proxyConfig = (config as Record<string, unknown>).proxy as { port?: number } | undefined;
        if (proxyConfig?.port) {
          writeProxyLock(proxyConfig.port, server.port);
        }
      }

      return true;
    } catch (err) {
      logger.warn('Could not connect to Metro:', err);
      return false;
    } finally {
      isReconnecting = false;
    }
  }

  // Schedule a reconnect with exponential backoff, driven from server.ts so we always
  // re-fetch a fresh target URL from Metro's /json endpoint.
  function scheduleReconnect(): void {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.error('Max reconnection attempts reached, giving up');
      return;
    }
    if (reconnectTimer !== null || isReconnecting) return; // already scheduled or in progress

    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1)];
    reconnectAttempts++;
    logger.info(`Reconnecting to Metro in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    isReconnecting = true;
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      isReconnecting = false;
      const success = await connectToMetro();
      if (!success) {
        scheduleReconnect();
      }
    }, delay);
  }

  // CDP proxy for Chrome DevTools coexistence — started lazily on first connect
  // only when the target does not support multiple debuggers natively (RN <0.85).
  let cdpMultiplexer: CDPMultiplexer | null = null;

  // Read preferred proxy port once at startup (stale lock reuse / explicit config).
  let preferredProxyPort = config.proxy?.port ?? 0;
  if (preferredProxyPort === 0) {
    try {
      const stale = JSON.parse(fs.readFileSync(PROXY_LOCK_FILE, 'utf8'));
      if (stale.port) preferredProxyPort = stale.port;
    } catch { /* no stale lock */ }
  }

  // Start MCP transport
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  logger.info('MCP server started');

  // Clean up on shutdown
  process.on('SIGINT', () => { cleanProxyLock(); cdpMultiplexer?.stop(); process.exit(0); });
  process.on('SIGTERM', () => { cleanProxyLock(); cdpMultiplexer?.stop(); process.exit(0); });
  process.on('exit', () => { cleanProxyLock(); });

  // Try connecting to Metro (non-blocking — server works without connection)
  void connectToMetro();
}
