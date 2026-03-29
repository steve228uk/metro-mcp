import { z } from 'zod';
import type { CircularBuffer } from './utils/buffer.js';

// ── CDP Connection Interface ──

export interface CDPConnection {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (params: Record<string, unknown>) => void): void;
  off(event: string, handler: (params: Record<string, unknown>) => void): void;
  isConnected(): boolean;
  /** Returns metadata about the currently connected CDP target, or null if not connected. */
  getTarget(): { description?: string; reactNative?: { capabilities?: { prefersFuseboxFrontend?: boolean } } } | null;
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

export interface ToolConfig<T extends z.ZodType = z.ZodType> {
  description: string;
  parameters: T;
  handler: (args: z.infer<T>) => Promise<unknown>;
}

export interface ResourceConfig {
  name: string;
  description: string;
  mimeType?: string;
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

// ── Plugin Context ──

export interface PluginContext {
  cdp: CDPConnection;
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
  version: string;
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
}

export function defineConfig(config: MetroMCPConfig): MetroMCPConfig {
  return config;
}
