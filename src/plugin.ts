import { z } from 'zod';
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
  sendProgress?: (progress: number, total: number, message?: string) => Promise<void>;
}

export interface ToolConfig<T extends z.ZodType = z.ZodType> {
  description: string;
  parameters: T;
  annotations?: ToolAnnotations;
  /**
   * URI of the MCP App resource to display alongside this tool's result.
   * When set, the tool result will include `_meta.ui.resourceUri` automatically.
   * The resource at this URI must be registered via `ctx.registerAppResource`.
   * Example: `'ui://metro/network'`
   */
  appUri?: string;
  handler: (args: z.infer<T>, ctx: ToolHandlerContext) => Promise<unknown>;
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
  handler: (args: Record<string, string>) => Promise<Array<{ role: 'user' | 'assistant'; content: string }>>;
}

// ── Eval Options ──

export interface EvalOptions {
  /** Wait for a returned Promise to resolve before returning the value */
  awaitPromise?: boolean;
  /** CDP timeout in milliseconds (default: 10000) */
  timeout?: number;
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
  registerTool<T extends z.ZodType>(name: string, config: ToolConfig<T>): void;
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
