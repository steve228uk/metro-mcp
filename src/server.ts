import { exec } from 'child_process';
import { resolve } from 'node:path';
import { promisify } from 'util';
import fs from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema, RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

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
import { loadConfig } from './config.js';
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
import { permissionsPlugin } from './plugins/permissions.js';
import { filesystemPlugin } from './plugins/filesystem.js';
import { environmentPlugin } from './plugins/environment.js';

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
  permissionsPlugin,
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
  filesystemPlugin,
  environmentPlugin,
];

export async function startServer(config: Required<MetroMCPConfig>, args: string[] = []): Promise<void> {
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
  const MAX_BURST_ATTEMPTS = 15; // fast retries; after this, switch to slow background probe
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

  // Enable required CDP domains. Called on every CDP connection and after Metro
  // bundle rebuilds (fast refresh / hot reload resets Hermes domain registration).
  async function enableCDPDomains(): Promise<void> {
    try {
      await cdpSession.send('Runtime.enable');
      logger.debug('Runtime.enable OK');
    } catch (err) {
      logger.warn('Runtime.enable failed:', err);
    }
    try {
      await cdpSession.send('Network.enable');
      logger.debug('Network.enable OK');
    } catch (err) {
      logger.warn('Network.enable failed:', err);
    }
    // Fusebox (RN 0.77–0.84 New Architecture) requires the Debugger domain to be
    // enabled before the runtime fully activates its debug session and starts
    // emitting Runtime events. Disable all break behaviour so we don't freeze
    // the app. Failures here are non-fatal — older RN versions ignore these.
    try {
      await cdpSession.send('Debugger.enable');
      await Promise.all([
        cdpSession.send('Debugger.setPauseOnExceptions', { state: 'none' }),
        cdpSession.send('Debugger.setBreakpointsActive', { active: false }),
      ]);
      logger.debug('Debugger.enable OK');
    } catch {
      // Non-fatal
    }
    // If the runtime is paused waiting for a debugger to be ready (Fusebox may
    // pause on attach), resume it so the app continues executing and events flow.
    try {
      await cdpSession.send('Runtime.runIfWaitingForDebugger');
      logger.debug('Runtime.runIfWaitingForDebugger OK');
    } catch {
      // Non-fatal — not all runtimes support this command
    }
  }

  // Enable required CDP domains on every connection (initial and reconnect).
  cdpSession.on('reconnected', async () => {
    reconnectAttempts = 0;
    isReconnecting = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    await enableCDPDomains();
  });

  // Drive all reconnection through connectToMetro() so we always get a fresh target URL.
  cdpSession.on('disconnected', () => {
    scheduleReconnect();
  });

  // Re-enable CDP domains after a Metro bundle rebuild. Fast refresh / hot reload
  // resets the Hermes runtime context without triggering a WebSocket reconnect, so
  // the domain registrations (Runtime, Network, Debugger) are silently cleared.
  // Metro fires 'bundle_build_done' once the new bundle is ready to run.
  eventsClient.on('bundle_build_done', async () => {
    if (!cdpSession.isConnected) return;
    logger.info('Metro bundle rebuilt — re-enabling CDP domains');
    await enableCDPDomains();
  });

  // Tracks all plugin registrations (tools, resources, prompts) so they can be
  // removed and re-registered when the active project root changes.
  const registrations: Array<{ remove: () => void }> = [];

  // Create the plugin context factory
  function createPluginContext(plugin: PluginDefinition, cfg: Required<MetroMCPConfig>): PluginContext {
    const pluginLogger = createLogger(plugin.name);
    return {
      cdp: cdpSession,
      events: eventsClient,
      registerTool: <T extends z.ZodType>(name: string, toolConfig: ToolConfig<T>) => {
        try {
          // Use duck typing in addition to instanceof so plugins that bundle a
          // different copy of zod (e.g. via file: deps or yarn link) still work.
          const params = toolConfig.parameters as Record<string, unknown>;
          const isZodObject =
            params instanceof z.ZodObject ||
            (typeof params.shape === 'object' && params.shape !== null);
          const inputSchema = isZodObject
            ? (toolConfig.parameters as unknown as z.ZodObject<z.ZodRawShape>).shape
            : { input: toolConfig.parameters };

          const registration = mcpServer.registerTool(
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
                const content = typeof result === 'string' ? result : JSON.stringify(result);
                return { content: [{ type: 'text' as const, text: content }] };
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
              }
            }
          );
          registrations.push(registration);
          pluginLogger.debug(`Registered tool: ${name}`);
        } catch (err) {
          pluginLogger.error(`Failed to register tool ${name}:`, err);
        }
      },
      registerResource: (uri: string, resourceConfig: ResourceConfig) => {
        try {
          const registration = mcpServer.resource(
            resourceConfig.name,
            uri,
            { description: resourceConfig.description, mimeType: resourceConfig.mimeType || 'application/json' },
            async () => {
              const content = await resourceConfig.handler();
              return { contents: [{ uri, text: content, mimeType: resourceConfig.mimeType || 'application/json' }] };
            }
          );
          registrations.push(registration);
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
          const registration = mcpServer.prompt(
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
          registrations.push(registration);
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
      config: cfg as unknown as Record<string, unknown>,
      logger: pluginLogger,
      metro: {
        host: cfg.metro.host!,
        port: cfg.metro.port!,
        fetch: async (path: string) => {
          return fetch(`http://${cfg.metro.host}:${cfg.metro.port}${path}`);
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

  // Load and initialize all plugins. Clears existing registrations first so this
  // can be called again when the active project root changes.
  async function initPlugins(cfg: Required<MetroMCPConfig>, rootPath?: string): Promise<void> {
    // Remove all existing tool/resource/prompt registrations
    for (const reg of registrations) {
      try { reg.remove(); } catch { /* ignore */ }
    }
    registrations.length = 0;

    const baseDir = rootPath ?? process.cwd();
    const allPlugins = [...BUILT_IN_PLUGINS];

    for (const pluginPath of cfg.plugins) {
      try {
        const resolvedPath = pluginPath.startsWith('.')
          ? resolve(baseDir, pluginPath)
          : pluginPath.startsWith('/')
            ? pluginPath
            : import.meta.resolve(pluginPath);
        const mod = await import(resolvedPath);
        const plugin: PluginDefinition = mod.default || mod;
        if (plugin?.name && typeof plugin?.setup === 'function') {
          allPlugins.push(plugin);
          logger.info(`Loaded external plugin: ${plugin.name}`);
        }
      } catch (err) {
        logger.error(`Failed to load plugin ${pluginPath}:`, err);
      }
    }

    for (const plugin of allPlugins) {
      try {
        const ctx = createPluginContext(plugin, cfg);
        await plugin.setup(ctx);
        logger.debug(`Initialized plugin: ${plugin.name}`);
      } catch (err) {
        logger.error(`Failed to initialize plugin ${plugin.name}:`, err);
      }
    }
  }

  await initPlugins(config);

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
          // Set active device key BEFORE connecting so plugin event handlers
          // that fire on the 'reconnected' event can store events immediately.
          activeDeviceKey = targets[0].id ? `${lockData.port}-${targets[0].id}` : null;
          activeDeviceName = targets[0].title || targets[0].id || 'secondary';
          // Point devtools plugin at the primary's proxy so open_devtools uses the right port
          (config as Record<string, unknown>).proxy = {
            ...config.proxy,
            port: lockData.port,
          };
          await cdpSession.connectToTarget(targets[0] as unknown as MetroTarget);
          if (lockData.metroPort) {
            eventsClient.connect(config.metro.host!, lockData.metroPort);
            config.metro.port = lockData.metroPort;
          }
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

      // Set active device key BEFORE connecting so plugin event handlers
      // that fire on the 'reconnected' event can store events immediately.
      activeDeviceKey = `${server.port}-${target.id}`;
      activeDeviceName = target.title || target.deviceName || target.id;

      if (supportsMultipleDebuggers(target)) {
        // RN 0.85+: Metro handles multiple concurrent debugger sessions natively.
        // No CDPMultiplexer needed — connect directly and skip the proxy.
        logger.info('Target supports multiple debuggers (RN 0.85+) — skipping CDP proxy');
      } else if (!cdpMultiplexer && config.proxy?.enabled !== false) {
        // RN <0.85: start the CDPMultiplexer BEFORE connecting so that the
        // messageInterceptor is already in place when 'reconnected' fires and
        // events begin flowing from Metro. Starting it after connectToTarget()
        // caused a window where events were lost on initial connection.
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

      await cdpSession.connectToTarget(target);
      eventsClient.connect(server.host, server.port);

      if (!supportsMultipleDebuggers(target)) {
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
    if (reconnectTimer !== null || isReconnecting) return; // already scheduled or in progress

    // Use exponential backoff for the initial burst, then fall back to a slow
    // background probe so the server keeps trying indefinitely (e.g. app started
    // long after the MCP server).
    const delay = reconnectAttempts < MAX_BURST_ATTEMPTS
      ? RECONNECT_DELAYS[Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1)]
      : 30000;
    reconnectAttempts++;
    logger.info(`Reconnecting to Metro in ${delay}ms (attempt ${reconnectAttempts})`);

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

  // Reload config + plugins from the client's active project root. A concurrency
  // guard prevents interleaved runs if roots-changed fires while a reload is already
  // in progress (IDE batch-sends notifications on project switch).
  let reloadInProgress = false;
  async function reloadFromRoots(suppressErrors = false): Promise<void> {
    if (reloadInProgress) return;
    reloadInProgress = true;
    try {
      const { roots } = await mcpServer.server.listRoots();
      const firstRoot = roots[0];
      if (!firstRoot) return;
      const rootPath = new URL(firstRoot.uri).pathname;
      logger.info(`Reloading plugins from: ${rootPath}`);
      const newConfig = await loadConfig(args, rootPath);
      await initPlugins(newConfig, rootPath);
      logger.info(`Plugins reloaded for: ${rootPath}`);
    } catch (err) {
      if (!suppressErrors) logger.error('Failed to reload plugins on roots change:', err);
    } finally {
      reloadInProgress = false;
    }
  }

  // Reload all plugins when the client's active project root changes.
  // This lets a single global metro-mcp install automatically pick up the
  // metro-mcp.config.ts from whichever project the user is working in.
  mcpServer.server.setNotificationHandler(RootsListChangedNotificationSchema, () => reloadFromRoots());

  // On first client connection, load config from the initial project root (if any).
  // This handles the case where the user opens an IDE with a project already open.
  mcpServer.server.oninitialized = () => reloadFromRoots(true);

  // Clean up on shutdown
  process.on('SIGINT', () => { cleanProxyLock(); cdpMultiplexer?.stop(); process.exit(0); });
  process.on('SIGTERM', () => { cleanProxyLock(); cdpMultiplexer?.stop(); process.exit(0); });
  process.on('exit', () => { cleanProxyLock(); });

  // Try connecting to Metro (non-blocking — server works without connection).
  // If the initial attempt fails before creating any WebSocket (e.g. app not
  // running yet), no 'disconnected' event fires so scheduleReconnect() would
  // never be called — trigger it explicitly here so we keep retrying.
  void connectToMetro().then((connected) => {
    if (!connected) scheduleReconnect();
  });
}
