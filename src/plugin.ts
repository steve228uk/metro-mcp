import { z } from 'zod';
import {
  isCallToolResult,
  type CallToolResult,
  type ContentBlock,
} from '@modelcontextprotocol/server';
import type { CircularBuffer } from './utils/buffer.js';
import type { MetroTarget } from 'metro-bridge';

// ── CDP Connection Interface ──

export interface CDPConnection {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (params: Record<string, unknown>) => void): void;
  off(event: string, handler: (params: Record<string, unknown>) => void): void;
  isConnected: boolean;
  /** Returns metadata about the currently connected CDP target, or null if not connected. */
  getTarget(): MetroTarget | null;
}

// ── Format Utilities ──

export interface FormatUtils {
  summarize<T>(items: T[], lastN?: number): string;
  compact(obj: unknown): string;
  truncate(str: string, maxLen: number): string;
  structureOnly(tree: ComponentNode): ComponentNode;
}

export interface ComponentNode {
  name: string;
  children?: ComponentNode[];
  props?: Record<string, unknown>;
  state?: unknown;
  [key: string]: unknown;
}

// ── Tool / Resource / Prompt Registration ──

export interface ToolAnnotations {
  /** Human-readable name for display in client UIs */
  title?: string;
  /** If true, the tool does not modify any state (safe to auto-approve) */
  readOnlyHint?: boolean;
  /** If true, the tool may perform irreversible or destructive actions */
  destructiveHint?: boolean;
  /** If true, calling with identical arguments multiple times has no additional effect */
  idempotentHint?: boolean;
  /** If true, the tool may interact with external systems beyond the local environment */
  openWorldHint?: boolean;
}

export interface ToolHandlerContext {
  /** Send a progress notification to the client (only if client provided a progressToken) */
  sendProgress?: (
    progress: number,
    total: number,
    message?: string,
  ) => Promise<void>;
}

/** A native MCP content block returned directly by a plugin tool. */
export type NativeToolContentBlock = ContentBlock;

const NATIVE_TOOL_RESULT_BRAND = Symbol.for(
  'io.github.steve228uk.metro-mcp.native-tool-result',
);
declare const nativeToolResultTypeBrand: unique symbol;

/** A validated native MCP tool result, including image/audio/resource blocks. */
export type NativeToolResult = CallToolResult & {
  readonly [nativeToolResultTypeBrand]: true;
};

/**
 * Validate and explicitly opt a plugin result into native MCP delivery.
 * Ordinary objects remain JSON text, even when they happen to be shaped like
 * a CallToolResult.
 */
export function nativeToolResult(result: CallToolResult): NativeToolResult {
  if (!isCallToolResult(result)) {
    throw new TypeError('Invalid native MCP tool result');
  }

  const brandedResult = { ...result };
  Object.defineProperty(brandedResult, NATIVE_TOOL_RESULT_BRAND, {
    value: true,
  });
  return brandedResult as NativeToolResult;
}

export function isNativeToolResult(result: unknown): result is NativeToolResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as Record<PropertyKey, unknown>)[NATIVE_TOOL_RESULT_BRAND] === true &&
    isCallToolResult(result)
  );
}

/**
 * Plugin handlers may return a native MCP result or any JSON-serializable value.
 * Native results are validated before being passed through; other values are
 * preserved as the existing JSON text response.
 */
export type ToolHandlerResult = NativeToolResult | unknown;

export interface ToolConfig<
  T extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
> {
  description: string;
  parameters: T;
  annotations?: ToolAnnotations;
  /**
   * URI of the MCP App resource to display alongside this tool.
   * When set, the tool definition will include `_meta.ui.resourceUri`
   * automatically.
   * The resource at this URI must be registered via `ctx.registerAppResource`.
   * Example: `'ui://metro/network'`
   */
  appUri?: string;
  handler: (args: z.infer<T>, ctx: ToolHandlerContext) => Promise<ToolHandlerResult>;
}

export interface ResourceConfig {
  name: string;
  description: string;
  mimeType?: string;
  handler: () => Promise<string>;
  /** Called when a client subscribes to this resource URI */
  onSubscribe?: (uri: string) => void;
  /** Called when a client unsubscribes from this resource URI */
  onUnsubscribe?: (uri: string) => void;
}

/** Configuration for an MCP App HTML resource registered at a `ui://` URI. */
export interface AppResourceConfig {
  name: string;
  description: string;
  /** Minimum iframe height requested via CSS and Apps size notifications. Defaults to 420px. */
  minHeight?: number;
  /** Returns the full HTML document string for the app. */
  handler: () => Promise<string>;
}

export interface PromptConfig {
  description: string;
  arguments?: Array<{
    name: string;
    description: string;
    required?: boolean;
  }>;
  handler: (
    args: Record<string, string>,
  ) => Promise<Array<{ role: 'user' | 'assistant'; content: string }>>;
}

// ── Eval Options ──

export interface EvalOptions {
  /** Wait for a returned Promise to resolve before returning the value */
  awaitPromise?: boolean;
  /** CDP timeout in milliseconds (default: 10000) */
  timeout?: number;
  /** Internal absolute deadline used to bound reconnect and transport waits. */
  deadline?: number;
}

// ── Metro Events ──

export interface MetroEvent {
  type: string;
  [key: string]: unknown;
}

export interface MetroEventsConnection {
  on(event: string, handler: (event: MetroEvent) => void): void;
  off(event: string, handler: (event: MetroEvent) => void): void;
  isConnected(): boolean;
}

// ── Plugin Context ──

export interface PluginContext {
  cdp: CDPConnection;
  /** Metro `/events` WebSocket — build progress, bundling errors, etc. */
  events: MetroEventsConnection;
  registerTool<T extends z.ZodObject<z.ZodRawShape>>(
    name: string,
    config: ToolConfig<T>,
  ): void;
  registerResource(uri: string, config: ResourceConfig): void;
  registerPrompt(name: string, config: PromptConfig): void;
  config: Record<string, unknown>;
  logger: Logger;
  metro: {
    host: string;
    port: number;
    fetch(path: string): Promise<Response>;
  };
  exec(command: string): Promise<string>;
  /** Run an executable with literal arguments and return its binary stdout. */
  execFile(
    command: string,
    args: string[],
    options?: { maxBuffer?: number },
  ): Promise<Buffer>;
  format: FormatUtils;
  /** Evaluate a JavaScript expression in the connected app runtime */
  evalInApp(expression: string, options?: EvalOptions): Promise<unknown>;
  /** Returns the active device key (`${port}-${targetId}`), or null if not connected. */
  getActiveDeviceKey(): string | null;
  /** Returns a human-readable name for the active device, or null if not connected. */
  getActiveDeviceName(): string | null;
  /** Notify subscribed clients that a resource's content has changed */
  notifyResourceUpdated(uri: string): void;
  /**
   * Register an interactive MCP App at a `ui://` URI.
   * The resource is served with MIME type `text/html;profile=mcp-app` and
   * rendered in a sandboxed iframe by MCP Apps-capable hosts (Claude, VS Code, etc.).
   * Reference it from a tool via `appUri` in `registerTool`.
   *
   * URI convention: use `ui://metro/...` for built-in apps,
   * `ui://your-plugin-name/...` for community plugins.
   */
  registerAppResource(uri: string, config: AppResourceConfig): void;
}

// ── Logger ──

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

// ── Plugin Definition ──

export interface PluginDefinition {
  name: string;
  version?: string;
  description?: string;
  setup(ctx: PluginContext): Promise<void>;
}

export function definePlugin(plugin: PluginDefinition): PluginDefinition {
  return plugin;
}

// ── Config ──

export interface MetroMCPConfig {
  /** Effective project root; resolved by the CLI and not configurable in a file. */
  projectRoot?: string;
  metro?: {
    host?: string;
    port?: number;
    autoDiscover?: boolean;
  };
  plugins?: string[];
  bufferSizes?: {
    logs?: number;
    network?: number;
    errors?: number;
  };
  profiler?: {
    /**
     * Whether the app uses the New Architecture (Bridgeless/Fusebox).
     * When true (default), the React DevTools hook is used as the primary profiling
     * path and CDP Profiler domain fallbacks are skipped.
     * Set to false for legacy bridge apps that expose the CDP Profiler domain.
     */
    newArchitecture?: boolean;
  };
  proxy?: {
    /** Enable the CDP proxy so Chrome DevTools can connect alongside the MCP. Defaults to true. */
    enabled?: boolean;
    /** Port for the proxy server. Use 0 for OS-assigned. Defaults to 0. */
    port?: number;
  };
}

export function defineConfig(config: MetroMCPConfig): MetroMCPConfig {
  return config;
}
