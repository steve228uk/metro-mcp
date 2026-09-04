import { randomUUID } from 'node:crypto';
import { exec, execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  createMcpHandler,
  isInitializeRequest,
  isLegacyRequest,
  McpServer,
} from '@modelcontextprotocol/server';
import type {
  McpHttpHandler,
  ServerContext,
  ToolCallback,
  Transport,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  NodeStreamableHTTPServerTransport,
  hostHeaderValidation,
  originValidation,
  toNodeHandler,
  toWebRequest,
} from '@modelcontextprotocol/node';
import { z } from 'zod';
import type {
  MetroMCPConfig,
  PluginContext,
  PluginDefinition,
  ToolConfig,
  ResourceConfig,
  AppResourceConfig,
  PromptConfig,
} from './plugin.js';
import {
  CDPSession,
  CDPMultiplexer,
  scanMetroPorts,
  selectBestTarget,
  fetchTargets,
} from 'metro-bridge';
import type { MetroTarget } from 'metro-bridge';
import { MetroEventsClient } from './metro/events.js';
import { createLogger } from './utils/logger.js';
import { createFormatUtils } from './utils/format.js';
import { createAppEvaluator } from './utils/evaluate-app.js';
import { createPreferredFrameSizeMeta, withAppSizing } from './utils/apps.js';
import { ResourceSubscriptionManager } from './utils/resource-subscriptions.js';
import { createResourceUpdateScheduler } from './utils/resource-updates.js';
import {
  createMetroTargetPin,
  selectMetroTarget,
  selectPinnedTarget,
  type MetroTargetPin,
} from './utils/target-selection.js';
import { normalizeToolResult } from './utils/tool-results.js';
import { version } from './version.js';
import {
  createDaemonIdentity,
  DaemonLeaseRegistry,
  getDaemonKey,
  getDaemonIdentityFingerprint,
  getDaemonKeyFingerprint,
} from './daemon.js';
import type { DaemonIdentity } from './daemon.js';

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

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const logger = createLogger('server');
const RESOURCE_UPDATE_COALESCE_MS = 250;

/** Keep long-lived plugin contexts aligned with the Metro endpoint in use. */
export function updateMetroEndpoint(
  config: Required<MetroMCPConfig>,
  host: string,
  port: number,
): void {
  config.metro.host = host;
  config.metro.port = port;
}

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

export interface ReconnectWaitTimers {
  setInterval(callback: () => void, delay: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface ReconnectTimerState {
  timer: ReturnType<typeof setTimeout> | null;
}

export interface ReconnectController {
  schedule(): void;
  connectNow(): Promise<boolean>;
  cancelScheduled(): boolean;
  isReconnecting(): boolean;
  resetBackoff(): void;
}

interface ReconnectControllerOptions {
  connect: () => Promise<boolean>;
  /** Verify that a successful attempt is still connected when it settles. */
  isConnected?: () => boolean;
  isClosed: () => boolean;
  timers?: Pick<ReconnectWaitTimers, 'setTimeout' | 'clearTimeout'>;
  delays?: readonly number[];
  maxBurstAttempts?: number;
  backgroundDelay?: number;
  onSchedule?: (delay: number, attempt: number) => void;
}

const reconnectWaitTimers: ReconnectWaitTimers = {
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
};

/**
 * Cancel a background reconnect that has not started connecting yet.
 *
 * Keeping the timer separate from the active-attempt state lets an on-demand
 * tool request take over a long backoff immediately. The null check also makes
 * concurrent callers idempotent: only the first caller can claim the timer.
 */
export function cancelScheduledReconnect(
  state: ReconnectTimerState,
  timers: Pick<ReconnectWaitTimers, 'clearTimeout'> = reconnectWaitTimers,
): boolean {
  if (state.timer === null) return false;
  timers.clearTimeout(state.timer);
  state.timer = null;
  return true;
}

/**
 * Own reconnect scheduling independently of any caller waiting on an attempt.
 * A deadline-bounded caller may stop awaiting connectNow(), but the runtime
 * still observes the result and keeps background recovery alive.
 */
export function createReconnectController(
  options: ReconnectControllerOptions,
): ReconnectController {
  const timers = options.timers ?? reconnectWaitTimers;
  const delays = options.delays ?? [500, 1000, 2000, 4000, 8000, 16000];
  const maxBurstAttempts = options.maxBurstAttempts ?? 15;
  const backgroundDelay = options.backgroundDelay ?? 30000;
  const timerState: ReconnectTimerState = { timer: null };
  let attempts = 0;
  let activeAttempt: Promise<boolean> | null = null;

  const cancelScheduled = (): boolean =>
    cancelScheduledReconnect(timerState, timers);

  const schedule = (): void => {
    if (options.isClosed() || timerState.timer !== null || activeAttempt) return;
    const delay = attempts < maxBurstAttempts
      ? delays[Math.min(attempts, delays.length - 1)]!
      : backgroundDelay;
    attempts++;
    options.onSchedule?.(delay, attempts);
    timerState.timer = timers.setTimeout(() => {
      timerState.timer = null;
      void connectNow().catch(() => {});
    }, delay);
  };

  const connectNow = (): Promise<boolean> => {
    cancelScheduled();
    if (activeAttempt) return activeAttempt;
    const rawAttempt = Promise.resolve().then(options.connect);
    let ownedAttempt!: Promise<boolean>;
    ownedAttempt = rawAttempt.then(
      (connected) => {
        // A CDP connection can open and emit `reconnected`, then close again
        // before the owning connect operation settles. Treat that attempt as
        // failed so its disconnected event cannot be lost behind
        // activeAttempt ownership.
        const settledConnected = connected &&
          (options.isConnected?.() ?? true);
        // Clear active ownership before scheduling the next background retry;
        // schedule() must be able to claim the newly available slot.
        if (activeAttempt === ownedAttempt) activeAttempt = null;
        if (!settledConnected) schedule();
        return settledConnected;
      },
      (error) => {
        if (activeAttempt === ownedAttempt) activeAttempt = null;
        schedule();
        throw error;
      },
    );
    activeAttempt = ownedAttempt;
    return ownedAttempt;
  };

  return {
    schedule,
    connectNow,
    cancelScheduled,
    isReconnecting: () => activeAttempt !== null,
    resetBackoff: () => {
      attempts = 0;
    },
  };
}

export function waitForReconnect(
  isReconnecting: () => boolean,
  deadline?: number,
  timers: ReconnectWaitTimers = reconnectWaitTimers,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!isReconnecting()) {
      resolve();
      return;
    }
    let check: ReturnType<typeof setInterval> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: Error): void => {
      if (check) {
        timers.clearInterval(check);
        check = null;
      }
      if (deadlineTimer) {
        timers.clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
      if (error) reject(error);
      else resolve();
    };
    check = timers.setInterval(() => {
      if (!isReconnecting()) finish();
    }, 100);
    if (deadline !== undefined) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        finish(new Error('App evaluation timed out'));
        return;
      }
      deadlineTimer = timers.setTimeout(
        () => finish(new Error('App evaluation timed out')),
        remaining,
      );
    }
  });
}

/**
 * Wait for an in-flight CDP connection without allowing it to outlive the
 * caller's evaluation deadline. The underlying connection attempt cannot be
 * cancelled, so consume its eventual result while clearing the only timer we
 * own when either side settles.
 */
export function waitForConnectionUntil(
  waitForConnection: () => Promise<boolean>,
  deadline?: number,
  timers: ReconnectWaitTimers = reconnectWaitTimers,
): Promise<boolean> {
  if (deadline === undefined) return waitForConnection();
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error('App evaluation timed out'));

  return new Promise<boolean>((resolve, reject) => {
    let deadlineTimer: ReturnType<typeof setTimeout> | null = timers.setTimeout(
      () => {
        deadlineTimer = null;
        reject(new Error('App evaluation timed out'));
      },
      remaining,
    );
    void waitForConnection().then(
      (connected) => {
        if (deadlineTimer) {
          timers.clearTimeout(deadlineTimer);
          deadlineTimer = null;
        }
        resolve(connected);
      },
      (error) => {
        if (deadlineTimer) {
          timers.clearTimeout(deadlineTimer);
          deadlineTimer = null;
        }
        reject(error);
      },
    );
  });
}

type RuntimeRegistration = (server: McpServer) => { remove: () => void };

interface McpSession {
  id: string;
  server: McpServer;
  subscribedResources: Set<string>;
  registrations: Array<{ remove: () => void }>;
}

interface HttpServerOptions {
  host?: string;
  port?: number;
  daemon?: {
    key: string;
    identity: DaemonIdentity;
    managed?: boolean;
    leaseTtlMs?: number;
    idleGraceMs?: number;
  };
  onManagedDaemonIdle?: () => void | Promise<void>;
  onListening?: (info: { host: string; port: number; url: string }) => void;
}

function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'metro-mcp',
      version,
    },
    {
      instructions: `React Native runtime debugging MCP server. Connects to Metro bundler via Chrome DevTools Protocol to provide console logs, network requests, component tree inspection, state management debugging, device control, and more. Use list_devices to see connected targets, then use other tools to inspect and interact with the running app.`,
    },
  );
  server.server.registerCapabilities({ resources: { subscribe: true } });
  return server;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

async function closeQuietly(closable: {
  close(): Promise<void>;
}): Promise<void> {
  await closable.close().catch(() => {});
}

export async function createMetroRuntime(
  initialConfig: Required<MetroMCPConfig>,
  args: string[] = [],
) {
  let config = initialConfig;
  const cdpSession = new CDPSession();
  const eventsClient = new MetroEventsClient();
  const formatUtils = createFormatUtils();
  const sessions = new Set<McpSession>();
  const modernStdioServers = new Set<McpServer>();
  const runtimeRegistrations: RuntimeRegistration[] = [];
  const resourceSubscriptions = new ResourceSubscriptionManager();
  let isInitializingPlugins = false;
  let runtimeClosed = false;
  let runtimeClosePromise: Promise<void> | null = null;
  let modernResourceNotifier: ((uri: string) => void) | null = null;
  let stdioHandle: { close(): Promise<void> } | null = null;

  const resourceUpdates = createResourceUpdateScheduler({
    delayMs: RESOURCE_UPDATE_COALESCE_MS,
    getTargets: () =>
      [...sessions].map((session) => ({
        id: session.id,
        isSubscribed: (uri) => session.subscribedResources.has(uri),
        sendResourceUpdated: async (uri) => {
          await session.server.server.sendResourceUpdated({ uri });
        },
      })),
  });

  function notifyResourceUpdated(uri: string): void {
    resourceUpdates.notify(uri);
    modernResourceNotifier?.(uri);
    for (const server of modernStdioServers) {
      server.server
        .sendResourceUpdated({ uri })
        .catch((err) => logger.warn('Failed to send stdio resource update:', err));
    }
  }

  // Active device tracking — used by plugins to key per-device buffers.
  let activeDeviceKey: string | null = null;
  let activeDeviceName: string | null = null;
  let targetPin: MetroTargetPin | null = null;

  const RECONNECT_STABLE_MS = 5000;
  let reconnectController: ReconnectController | null = null;
  let runtimeGeneration = 0;
  let reconnectStabilityTimer: ReturnType<typeof setTimeout> | null = null;

  const waitForCurrentReconnect = (deadline?: number): Promise<void> =>
    waitForReconnect(
      () => reconnectController?.isReconnecting() ?? false,
      deadline,
    );

  function clearReconnectStabilityTimer(): void {
    if (reconnectStabilityTimer) {
      clearTimeout(reconnectStabilityTimer);
      reconnectStabilityTimer = null;
    }
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
    runtimeGeneration++;
    reconnectController?.cancelScheduled();
    await enableCDPDomains();
    clearReconnectStabilityTimer();
    reconnectStabilityTimer = setTimeout(() => {
      reconnectStabilityTimer = null;
      if (!runtimeClosed && cdpSession.isConnected) {
        reconnectController?.resetBackoff();
        logger.debug('CDP connection stable; reset reconnect backoff');
      }
    }, RECONNECT_STABLE_MS);
  });

  // Drive all reconnection through connectToMetro() so we always get a fresh target URL.
  cdpSession.on('disconnected', () => {
    runtimeGeneration++;
    clearReconnectStabilityTimer();
    cleanProxyLock();
    scheduleReconnect();
  });

  // Re-enable CDP domains after a Metro bundle rebuild. Fast refresh / hot reload
  // resets the Hermes runtime context without triggering a WebSocket reconnect, so
  // the domain registrations (Runtime, Network, Debugger) are silently cleared.
  // Metro fires 'bundle_build_done' once the new bundle is ready to run.
  eventsClient.on('bundle_build_done', async () => {
    if (!cdpSession.isConnected) return;
    runtimeGeneration++;
    logger.info('Metro bundle rebuilt — re-enabling CDP domains');
    await enableCDPDomains();
  });

  function addRuntimeRegistration(
    register: RuntimeRegistration,
    registrationLogger: ReturnType<typeof createLogger>,
    debugMessage: string,
  ): void {
    runtimeRegistrations.push(register);
    registrationLogger.debug(debugMessage);
  }

  function materializeServer(server: McpServer): Array<{ remove: () => void }> {
    const registrations: Array<{ remove: () => void }> = [];
    for (const register of runtimeRegistrations) {
      try {
        registrations.push(register(server));
      } catch (err) {
        logger.error('Failed to materialize MCP registration:', err);
      }
    }
    return registrations;
  }

  // Create the plugin context factory
  function createPluginContext(
    plugin: PluginDefinition,
    cfg: Required<MetroMCPConfig>,
  ): PluginContext {
    const pluginLogger = createLogger(plugin.name);
    const evalInApp = createAppEvaluator(cdpSession, {
      ensureConnected: async (deadline?: number) => {
        if (!cdpSession.isConnected) {
          if (reconnectController?.isReconnecting()) {
            // A reconnect is already in flight — wait for it rather than
            // starting another one.
            await waitForCurrentReconnect(deadline);
          } else if (reconnectController?.cancelScheduled()) {
            // A background retry may be waiting behind a long backoff. An
            // on-demand tool request should claim that retry and connect now,
            // rather than consuming its shorter deadline waiting for the timer.
            const connected = await waitForConnectionUntil(
              () => connectToMetro(),
              deadline,
            );
            if (!connected) scheduleReconnect();
          } else {
            const connected = await waitForConnectionUntil(
              () => cdpSession.waitForConnection(),
              deadline,
            );
            if (!connected) {
              await waitForConnectionUntil(() => connectToMetro(), deadline);
            }
          }
          if (deadline !== undefined && Date.now() >= deadline) {
            throw new Error('App evaluation timed out');
          }
        }
        if (!cdpSession.isConnected) {
          throw new Error(
            'Not connected to Metro. Use list_devices to check connection status.',
          );
        }
      },
      waitForReconnect: waitForCurrentReconnect,
      isReconnecting: () => reconnectController?.isReconnecting() ?? false,
      getGeneration: () => runtimeGeneration,
      reconnect: async () => {
        await connectToMetro();
      },
    });
    return {
      cdp: cdpSession,
      events: eventsClient,
      registerTool: <T extends z.ZodObject<z.ZodRawShape>>(
        name: string,
        toolConfig: ToolConfig<T>,
      ) => {
        try {
          const handler = async (args: unknown, ctx: ServerContext) => {
            // V2 carries progress metadata and notification delivery on the
            // request context rather than the v1 callback `extra` object.
            const progressToken = ctx.mcpReq._meta?.progressToken;
            const sendProgress =
              progressToken !== undefined
                ? async (progress: number, total: number, message?: string) => {
                    await ctx.mcpReq.notify({
                      method: 'notifications/progress',
                      params: {
                        progressToken,
                        progress,
                        total,
                        ...(message ? { message } : {}),
                      },
                    });
                  }
                : undefined;

            try {
              const result = await toolConfig.handler(args as z.infer<T>, {
                sendProgress,
              });
              return normalizeToolResult(result);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              return {
                content: [{ type: 'text' as const, text: `Error: ${message}` }],
                isError: true,
              };
            }
          };

          addRuntimeRegistration(
            (server) =>
              server.registerTool(
                name,
                {
                  description: toolConfig.description,
                  inputSchema: toolConfig.parameters,
                  annotations: toolConfig.annotations,
                  ...(toolConfig.appUri
                    ? {
                        _meta: {
                          ui: { resourceUri: toolConfig.appUri },
                          'ui/resourceUri': toolConfig.appUri,
                        },
                      }
                    : {}),
                },
                handler as ToolCallback<T>,
              ),
            pluginLogger,
            `Registered tool: ${name}`,
          );
        } catch (err) {
          pluginLogger.error(`Failed to register tool ${name}:`, err);
        }
      },
      registerResource: (uri: string, resourceConfig: ResourceConfig) => {
        try {
          const mimeType = resourceConfig.mimeType || 'application/json';
          resourceSubscriptions.register(uri, {
            onSubscribe: resourceConfig.onSubscribe,
            onUnsubscribe: resourceConfig.onUnsubscribe,
          });
          addRuntimeRegistration(
            (server) =>
              server.registerResource(
                resourceConfig.name,
                uri,
                { description: resourceConfig.description, mimeType },
                async (resourceUri) => {
                  const content = await resourceConfig.handler();
                  return {
                    contents: [
                      { uri: resourceUri.href, text: content, mimeType },
                    ],
                  };
                },
              ),
            pluginLogger,
            `Registered resource: ${uri}`,
          );
        } catch (err) {
          pluginLogger.error(`Failed to register resource ${uri}:`, err);
        }
      },
      registerAppResource: (uri: string, appConfig: AppResourceConfig) => {
        try {
          const preferredFrameSizeMeta = createPreferredFrameSizeMeta(
            appConfig.minHeight,
          );
          addRuntimeRegistration(
            (server) =>
              server.registerResource(
                appConfig.name,
                uri,
                {
                  description: appConfig.description,
                  mimeType: 'text/html;profile=mcp-app',
                  _meta: preferredFrameSizeMeta,
                },
                async (resourceUri) => {
                  const html = await appConfig.handler();
                  return {
                    contents: [
                      {
                        uri: resourceUri.href,
                        text: withAppSizing(html, appConfig.minHeight),
                        mimeType: 'text/html;profile=mcp-app',
                        _meta: preferredFrameSizeMeta,
                      },
                    ],
                  };
                },
              ),
            pluginLogger,
            `Registered app resource: ${uri}`,
          );
        } catch (err) {
          pluginLogger.error(`Failed to register app resource ${uri}:`, err);
        }
      },
      registerPrompt: (name: string, promptConfig: PromptConfig) => {
        try {
          // Build args schema shape for MCP SDK
          const argsShape: Record<string, z.ZodType> = {};
          if (promptConfig.arguments) {
            for (const arg of promptConfig.arguments) {
              argsShape[arg.name] = arg.required
                ? z.string()
                : z.string().optional();
            }
          }
          const promptDefinition = {
            description: promptConfig.description,
            ...(promptConfig.arguments?.length
              ? { argsSchema: z.object(argsShape) }
              : {}),
          };
          addRuntimeRegistration(
            (server) =>
              server.registerPrompt(
                name,
                promptDefinition as any,
                async (args: any) => {
                  const messages = await promptConfig.handler(args ?? {});
                  return {
                    messages: messages.map((m) => ({
                      role: m.role as 'user' | 'assistant',
                      content: { type: 'text' as const, text: m.content },
                    })),
                  };
                },
              ),
            pluginLogger,
            `Registered prompt: ${name}`,
          );
        } catch (err) {
          pluginLogger.error(`Failed to register prompt ${name}:`, err);
        }
      },
      evalInApp,
      config: cfg as unknown as Record<string, unknown>,
      logger: pluginLogger,
      metro: {
        // Auto-discovery can replace the configured endpoint after plugin
        // contexts are created. Accessors keep fallback transports on the
        // Metro server that owns the active target.
        get host() { return cfg.metro.host!; },
        set host(host: string) { cfg.metro.host = host; },
        get port() { return cfg.metro.port!; },
        set port(port: number) { cfg.metro.port = port; },
        fetch: async (path: string) => {
          return fetch(`http://${cfg.metro.host}:${cfg.metro.port}${path}`);
        },
      },
      exec: async (command: string) => {
        const { stdout } = await execAsync(command);
        return stdout;
      },
      execFile: async (command, args, options) => {
        const { stdout } = await execFileAsync(command, args, {
          encoding: 'buffer',
          maxBuffer: options?.maxBuffer,
        });
        return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
      },
      format: formatUtils,
      getActiveDeviceKey: () => activeDeviceKey,
      getActiveDeviceName: () => activeDeviceName,
      notifyResourceUpdated,
    };
  }

  // Load and initialize plugins once into a long-lived runtime registration set.
  // Fresh MCP server instances are materialized from this set for each modern
  // request and each legacy connection.
  async function initPlugins(cfg: Required<MetroMCPConfig>): Promise<void> {
    runtimeRegistrations.length = 0;
    resourceSubscriptions.clearHooks();

    const allPlugins = [...BUILT_IN_PLUGINS];

    for (const pluginPath of cfg.plugins) {
      try {
        const resolvedPath = pluginPath.startsWith('/')
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

    isInitializingPlugins = true;
    try {
      for (const plugin of allPlugins) {
        try {
          const ctx = createPluginContext(plugin, cfg);
          await plugin.setup(ctx);
          logger.debug(`Initialized plugin: ${plugin.name}`);
        } catch (err) {
          logger.error(`Failed to initialize plugin ${plugin.name}:`, err);
        }
      }
    } finally {
      isInitializingPlugins = false;
    }
  }

  await initPlugins(config);

  // Singleton proxy lock — prevents multiple metro-mcp instances from competing
  // for Metro's single CDP WebSocket, which causes a connect/disconnect spam loop.
  // The first instance owns the upstream Metro connection and writes its CDP proxy port to
  // a lock file. Subsequent instances detect the lock and connect through the
  // existing proxy instead.
  const PROXY_LOCK_FILE = join(tmpdir(), 'metro-mcp-proxy.json');
  let isPrimaryInstance = false;

  async function tryConnectViaProxy(): Promise<boolean> {
    try {
      const lockData = JSON.parse(fs.readFileSync(PROXY_LOCK_FILE, 'utf8'));
      if (lockData.pid && lockData.port) {
        if (lockData.pid === process.pid) {
          return false;
        }

        // Check if the owning process is still alive
        try {
          process.kill(lockData.pid, 0);
        } catch {
          try {
            fs.unlinkSync(PROXY_LOCK_FILE);
          } catch {}
          return false;
        }

        const resp = await fetch(`http://127.0.0.1:${lockData.port}/json`, {
          signal: AbortSignal.timeout(2000),
        });
        if (!resp.ok) return false;
        const targets = (await resp.json()) as MetroTarget[];
        const metroHost = lockData.metroHost ?? config.metro.host!;
        const metroPort = lockData.metroPort ?? config.metro.port!;
        const target = targetPin
          ? targetPin.host === metroHost && targetPin.port === metroPort
            ? selectPinnedTarget(targets, targetPin)
            : null
          : selectBestTarget(targets);
        if (target) {
          logger.info(
            `Found existing metro-mcp proxy (PID ${lockData.pid}, port ${lockData.port}) — connecting as secondary`,
          );
          // Set active device key BEFORE connecting so plugin event handlers
          // that fire on the 'reconnected' event can store events immediately.
          activeDeviceKey = `${metroPort}-${target.id}`;
          activeDeviceName = target.title || target.deviceName || target.id;
          // Point devtools plugin at the primary's proxy so open_devtools uses the right port
          (config as Record<string, unknown>).proxy = {
            ...config.proxy,
            port: lockData.port,
          };
          await cdpSession.connectToTarget(target);
          eventsClient.connect(metroHost, metroPort);
          updateMetroEndpoint(config, metroHost, metroPort);
          targetPin ??= createMetroTargetPin(
            { host: metroHost, port: metroPort },
            target,
          );
          return true;
        }
      }
    } catch {
      // Lock file missing, stale, or unreadable — fall through to direct connect
    }
    return false;
  }

  function writeProxyLock(
    proxyPort: number,
    metroHost: string,
    metroPort: number,
  ): void {
    try {
      fs.writeFileSync(
        PROXY_LOCK_FILE,
        JSON.stringify({
          pid: process.pid,
          port: proxyPort,
          metroHost,
          metroPort,
        }),
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
  async function performConnectToMetro(): Promise<boolean> {
    try {
      const proxyEnabled = config.proxy?.enabled !== false;

      // If another metro-mcp instance is already connected, piggyback on its proxy
      if (proxyEnabled && (await tryConnectViaProxy())) {
        return true;
      }

      let servers;
      if (config.metro.autoDiscover) {
        servers = await scanMetroPorts(config.metro.host!);
      } else {
        const targets = await fetchTargets(
          config.metro.host!,
          config.metro.port!,
        );
        servers =
          targets.length > 0
            ? [{ host: config.metro.host!, port: config.metro.port!, targets }]
            : [];
      }

      if (servers.length === 0) {
        logger.warn(
          'No Metro servers found. Tools will report disconnected status.',
        );
        return false;
      }

      const selected = selectMetroTarget(servers, targetPin);
      if (!selected) {
        logger.warn(
          targetPin
            ? 'Pinned Metro app is unavailable; remaining disconnected.'
            : 'No suitable CDP target found.',
        );
        return false;
      }
      const { server, target } = selected;
      updateMetroEndpoint(config, server.host, server.port);

      // Set active device key BEFORE connecting so plugin event handlers
      // that fire on the 'reconnected' event can store events immediately.
      activeDeviceKey = `${server.port}-${target.id}`;
      activeDeviceName = target.title || target.deviceName || target.id;

      if (!cdpMultiplexer && proxyEnabled) {
        // Start the CDPMultiplexer BEFORE connecting so that the
        // messageInterceptor is already in place when 'reconnected' fires and
        // events begin flowing from Metro. Starting it after connectToTarget()
        // caused a window where events were lost on initial connection.
        const mux = new CDPMultiplexer(cdpSession, {
          protectedDomains: ['Runtime', 'Network'],
        });
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
      } else if (!proxyEnabled) {
        logger.warn(
          'CDP proxy is disabled; connecting directly without Metro MCP shared-debugger multiplexing.',
        );
      }

      await cdpSession.connectToTarget(target);
      eventsClient.connect(server.host, server.port);
      targetPin ??= createMetroTargetPin(server, target);

      if (cdpMultiplexer?.port) {
        writeProxyLock(cdpMultiplexer.port, server.host, server.port);
      }

      return true;
    } catch (err) {
      logger.warn('Could not connect to Metro:', err);
      return false;
    }
  }

  reconnectController = createReconnectController({
    connect: performConnectToMetro,
    isConnected: () => cdpSession.isConnected,
    isClosed: () => runtimeClosed,
    onSchedule: (delay, attempt) => {
      logger.info(`Reconnecting to Metro in ${delay}ms (attempt ${attempt})`);
    },
  });

  async function connectToMetro(): Promise<boolean> {
    return reconnectController!.connectNow();
  }

  // Schedule a reconnect with exponential backoff, driven from server.ts so we always
  // re-fetch a fresh target URL from Metro's /json endpoint.
  function scheduleReconnect(): void {
    reconnectController?.schedule();
  }

  // CDP proxy for Chrome DevTools coexistence — started lazily on first connect.
  // Metro MCP always prefers this shared path so MCP tools and DevTools do not
  // compete for the same upstream Metro inspector connection.
  let cdpMultiplexer: CDPMultiplexer | null = null;

  // Read preferred proxy port once at startup (stale lock reuse / explicit config).
  let preferredProxyPort = config.proxy?.port ?? 0;
  if (preferredProxyPort === 0) {
    try {
      const stale = JSON.parse(fs.readFileSync(PROXY_LOCK_FILE, 'utf8'));
      if (stale.port) preferredProxyPort = stale.port;
    } catch {
      /* no stale lock */
    }
  }

  async function connectSession(transport: Transport): Promise<McpSession> {
    const server = createMcpServer();
    const session: McpSession = {
      id: randomUUID(),
      server,
      subscribedResources: new Set<string>(),
      registrations: materializeServer(server),
    };

    server.server.setRequestHandler('resources/subscribe', async (req) => {
      resourceSubscriptions.subscribe(
        session,
        String((req.params as { uri: string }).uri),
      );
      logger.debug(`Client subscribed to resource: ${req.params.uri}`);
      return {};
    });

    server.server.setRequestHandler('resources/unsubscribe', async (req) => {
      resourceSubscriptions.unsubscribe(
        session,
        String((req.params as { uri: string }).uri),
      );
      logger.debug(`Client unsubscribed from resource: ${req.params.uri}`);
      return {};
    });

    const previousClose = transport.onclose;
    transport.onclose = () => {
      previousClose?.();
      resourceSubscriptions.unsubscribeAll(session);
      resourceUpdates.removeTarget(session.id);
      for (const registration of session.registrations) registration.remove();
      sessions.delete(session);
      logger.debug(`MCP session closed: ${session.id}`);
    };

    sessions.add(session);
    await session.server.connect(transport);
    logger.info(`MCP session connected: ${session.id}`);
    return session;
  }

  async function startStdio(transport?: Transport): Promise<void> {
    const handle = serveStdio(
      ({ era }) => {
        const server = createMcpServer();
        const registrations = materializeServer(server);
        const previousClose = server.close.bind(server);
        let closed = false;

        if (era === 'modern') {
          modernStdioServers.add(server);
        } else {
          const session: McpSession = {
            id: randomUUID(),
            server,
            subscribedResources: new Set<string>(),
            registrations,
          };
          server.server.setRequestHandler('resources/subscribe', async (req) => {
            resourceSubscriptions.subscribe(
              session,
              String((req.params as { uri: string }).uri),
            );
            return {};
          });
          server.server.setRequestHandler(
            'resources/unsubscribe',
            async (req) => {
              resourceSubscriptions.unsubscribe(
                session,
                String((req.params as { uri: string }).uri),
              );
              return {};
            },
          );
          sessions.add(session);
        }

        server.close = async () => {
          if (!closed) {
            closed = true;
            modernStdioServers.delete(server);
            const session = [...sessions].find(
              (candidate) => candidate.server === server,
            );
            if (session) {
              resourceSubscriptions.unsubscribeAll(session);
              resourceUpdates.removeTarget(session.id);
              sessions.delete(session);
            }
          }
          await previousClose();
        };
        return server;
      },
      {
        legacy: 'serve',
        ...(transport ? { transport } : {}),
        onerror: (err) => logger.error('stdio server error:', err),
      },
    );
    stdioHandle = handle;
    logger.info('MCP stdio server started');
  }

  function closeRuntime(): Promise<void> {
    if (runtimeClosePromise) return runtimeClosePromise;
    runtimeClosed = true;
    reconnectController?.cancelScheduled();
    clearReconnectStabilityTimer();
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
    process.off('beforeExit', handleBeforeExit);
    process.off('exit', handleExit);
    const sessionsToClose = [...sessions];
    const stdioToClose = stdioHandle;
    stdioHandle = null;
    resourceUpdates.close();
    runtimeClosePromise = (async () => {
      for (const session of sessionsToClose) {
        resourceSubscriptions.unsubscribeAll(session);
        resourceUpdates.removeTarget(session.id);
        for (const registration of session.registrations) registration.remove();
      }
      sessions.clear();
      modernStdioServers.clear();
      await Promise.all(
        sessionsToClose.map((session) => session.server.close().catch(() => {})),
      );
      await stdioToClose?.close().catch(() => {});
      eventsClient.disconnect();
      cleanProxyLock();
      await cdpMultiplexer?.stop().catch(() => {});
      cdpSession.disconnect();
    })();
    return runtimeClosePromise;
  }

  const handleSigint = () => {
    void closeRuntime().finally(() => process.exit(0));
  };
  const handleSigterm = () => {
    void closeRuntime().finally(() => process.exit(0));
  };
  const handleBeforeExit = () => {
    void closeRuntime().catch((err) => {
      logger.error('Runtime shutdown failed:', err);
    });
  };
  const handleExit = () => {
    // The exit event cannot await promises. Limit this fallback to synchronous
    // cleanup; normal signals and beforeExit use the complete async path above.
    eventsClient.disconnect();
    cleanProxyLock();
    cdpSession.disconnect();
  };

  // Clean up on shutdown
  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);
  process.on('beforeExit', handleBeforeExit);
  process.on('exit', handleExit);

  // Try connecting to Metro (non-blocking — server works without connection).
  // If the initial attempt fails before creating any WebSocket (e.g. app not
  // running yet), no 'disconnected' event fires so scheduleReconnect() would
  // never be called — trigger it explicitly here so we keep retrying.
  void connectToMetro().then((connected) => {
    if (!connected) scheduleReconnect();
  });

  return {
    connectSession,
    startStdio,
    createServer: () => {
      const server = createMcpServer();
      materializeServer(server);
      return server;
    },
    setModernResourceNotifier: (notifier: (uri: string) => void) => {
      modernResourceNotifier = notifier;
    },
    notifyResourceUpdated,
    close: closeRuntime,
  };
}

export async function startServer(
  config: Required<MetroMCPConfig>,
  args: string[] = [],
): Promise<void> {
  const runtime = await createMetroRuntime(config, args);
  await runtime.startStdio();
}

export async function startHttpServer(
  config: Required<MetroMCPConfig>,
  args: string[] = [],
  options: HttpServerOptions = {},
): Promise<{
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}> {
  const runtime = await createMetroRuntime(config, args);
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 0;
  const daemonIdentity = options.daemon?.identity ?? createDaemonIdentity(args);
  const daemonKey = options.daemon?.key ?? getDaemonKey(args, daemonIdentity);
  const streamableTransports = new Map<
    string,
    NodeStreamableHTTPServerTransport
  >();
  let leaseRegistry: DaemonLeaseRegistry | null = null;
  let shutdownPromise: Promise<void> | null = null;

  const modernHandler: McpHttpHandler = createMcpHandler(
    () => runtime.createServer(),
    { legacy: 'reject' },
  );
  runtime.setModernResourceNotifier((uri) =>
    modernHandler.notify.resourceUpdated(uri),
  );
  const modernNodeHandler = toNodeHandler(modernHandler, {
    onerror: (err) => logger.error('Modern MCP request failed:', err),
  });

  function getSessionIdHeader(req: http.IncomingMessage): string | undefined {
    const sessionId = req.headers['mcp-session-id'];
    return Array.isArray(sessionId) ? sessionId[0] : sessionId;
  }

  async function createStreamableTransport(): Promise<NodeStreamableHTTPServerTransport> {
    let transport: NodeStreamableHTTPServerTransport;
    transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (initializedSessionId) => {
        streamableTransports.set(initializedSessionId, transport);
      },
    });
    transport.onclose = () => {
      const closedSessionId = transport.sessionId;
      if (closedSessionId) streamableTransports.delete(closedSessionId);
    };
    await runtime.connectSession(transport);
    return transport;
  }

  async function handleLegacyMcpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedBody: unknown,
  ): Promise<void> {
    const sessionKey = getSessionIdHeader(req);
    let transport = sessionKey
      ? streamableTransports.get(sessionKey)
      : undefined;

    if (!transport) {
      if (
        req.method !== 'POST' ||
        !parsedBody ||
        !isInitializeRequest(parsedBody)
      ) {
        sendJson(res, 400, {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid MCP session' },
          id: null,
        });
        return;
      }
      transport = await createStreamableTransport();
    }

    await transport.handleRequest(req, res, parsedBody);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`);

    try {
      const leaseMatch =
        /^\/_metro-mcp\/clients\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
          url.pathname,
        );
      if (leaseMatch) {
        if (!leaseRegistry) {
          res.writeHead(404).end('Not found');
          return;
        }
        const suppliedKey = req.headers['x-metro-mcp-daemon-key'];
        if (
          typeof suppliedKey !== 'string' ||
          suppliedKey !== options.daemon?.key
        ) {
          res.writeHead(403).end('Forbidden');
          return;
        }
        if (req.method === 'PUT') {
          if (!leaseRegistry.renew(leaseMatch[1])) {
            res.writeHead(409).end('Daemon is shutting down');
            return;
          }
          res.writeHead(204).end();
          return;
        }
        if (req.method === 'DELETE') {
          leaseRegistry.release(leaseMatch[1]);
          res.writeHead(204).end();
          return;
        }
        res.setHeader('allow', 'PUT, DELETE');
        res.writeHead(405).end('Method not allowed');
        return;
      }

      if (url.pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          name: 'metro-mcp',
          version,
          daemon: {
            keyHash: getDaemonKeyFingerprint(daemonKey),
            identityHash: getDaemonIdentityFingerprint(daemonIdentity),
            managed: options.daemon?.managed === true,
          },
        });
        return;
      }

      if (url.pathname === '/mcp') {
        if (
          !hostHeaderValidation(['localhost', '127.0.0.1', '[::1]'])(req, res)
        )
          return;
        if (!originValidation(['localhost', '127.0.0.1', '[::1]'])(req, res))
          return;

        const parsedBody =
          req.method === 'POST' ? await readJsonBody(req) : undefined;
        const probe = await toWebRequest(req, parsedBody);
        if (await isLegacyRequest(probe, parsedBody)) {
          await handleLegacyMcpRequest(req, res, parsedBody);
        } else {
          await modernNodeHandler(req, res, parsedBody);
        }
        return;
      }

      res.writeHead(404).end('Not found');
    } catch (err) {
      logger.error('HTTP MCP request failed:', err);
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(requestedPort, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const port =
    typeof address === 'object' && address ? address.port : requestedPort;
  const url = `http://${host}:${port}/mcp`;
  options.onListening?.({ host, port, url });
  logger.info(`MCP HTTP server listening on ${url}`);

  async function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      leaseRegistry?.close();
      leaseRegistry = null;
      for (const transport of streamableTransports.values()) {
        await closeQuietly(transport);
      }
      streamableTransports.clear();
      await modernHandler.close();
      await runtime.close();
      if (!server.listening) return;
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
    })();
    return shutdownPromise;
  }

  if (options.daemon?.managed) {
    leaseRegistry = new DaemonLeaseRegistry({
      leaseTtlMs: options.daemon.leaseTtlMs,
      idleGraceMs: options.daemon.idleGraceMs,
      onIdle: async () => {
        logger.info('Managed daemon is idle; shutting down');
        if (options.onManagedDaemonIdle) {
          await options.onManagedDaemonIdle();
          return;
        }
        await shutdown();
        process.exit(0);
      },
    });
  }

  return {
    host,
    port,
    url,
    close: shutdown,
  };
}
