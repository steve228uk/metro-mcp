import { exec } from 'child_process';
import { promisify } from 'util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

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
import { CDPClient } from './metro/connection.js';
import { MetroEventsClient } from './metro/events.js';
import { scanMetroPorts, selectBestTarget, fetchTargets } from './metro/discovery.js';
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

  const cdpClient = new CDPClient();
  const eventsClient = new MetroEventsClient();
  const formatUtils = createFormatUtils();

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
  cdpClient.on('reconnected', async () => {
    reconnectAttempts = 0;
    isReconnecting = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    await Promise.all([
      cdpClient.send('Runtime.enable').catch(() => {}),
      cdpClient.send('Network.enable').catch(() => {}),
    ]);
  });

  // Drive all reconnection through connectToMetro() so we always get a fresh target URL.
  cdpClient.on('disconnected', () => {
    scheduleReconnect();
  });

  // Create the plugin context factory
  function createPluginContext(plugin: PluginDefinition): PluginContext {
    const pluginLogger = createLogger(plugin.name);
    return {
      cdp: cdpClient,
      events: eventsClient,
      registerTool: <T extends z.ZodType>(name: string, toolConfig: ToolConfig<T>) => {
        try {
          mcpServer.tool(
            name,
            toolConfig.description,
            toolConfig.parameters instanceof z.ZodObject
              ? (toolConfig.parameters as z.ZodObject<z.ZodRawShape>).shape
              : { input: toolConfig.parameters },
            async (args) => {
              try {
                const result = await toolConfig.handler(args as z.infer<T>);
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
          if (!cdpClient.isConnected()) {
            if (isReconnecting) {
              // A reconnect is already in flight — wait for it rather than starting another
              await waitForReconnect();
            } else {
              const connected = await cdpClient.waitForConnection();
              if (!connected) await connectToMetro();
            }
          }
          if (!cdpClient.isConnected()) {
            throw new Error('Not connected to Metro. Use list_devices to check connection status.');
          }
          const result = (await cdpClient.send('Runtime.evaluate', {
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

  // Connect to Metro — always re-discovers targets to get a fresh webSocketDebuggerUrl.
  // Idempotent: concurrent callers wait for the in-flight attempt to finish.
  async function connectToMetro(): Promise<boolean> {
    if (isReconnecting) {
      await waitForReconnect();
      return cdpClient.isConnected();
    }
    isReconnecting = true;
    try {
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

      await cdpClient.connect(target);
      eventsClient.connect(server.host, server.port);

      // Track active device for per-device buffers
      activeDeviceKey = `${server.port}-${target.id}`;
      activeDeviceName = target.title || target.deviceName || target.id;

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

  // Start MCP transport
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  logger.info('MCP server started');

  // Try connecting to Metro (non-blocking — server works without connection)
  void connectToMetro();
}
