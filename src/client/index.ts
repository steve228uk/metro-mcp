/**
 * metro-mcp Client SDK
 *
 * Optional dev dependency for enhanced features.
 * All features register on globalThis.__METRO_MCP__ which the server
 * discovers via Runtime.evaluate.
 *
 * Usage:
 *   import { MetroMCPClient } from 'metro-mcp/client';
 *
 *   if (__DEV__) {
 *     const mcp = new MetroMCPClient();
 *     mcp.registerCommand('login', async ({ email, password }) => { ... });
 *     mcp.useReduxMiddleware(store);
 *     mcp.useNavigationTracking(navigationRef);
 *   }
 */

import { createReduxMiddleware, type ReduxStore } from './middleware/redux.js';
import { createNavigationTracking, type NavigationRef } from './middleware/navigation.js';
import { PerformanceTracker } from './performance.js';
import { StructuredLogger } from './logger.js';
import { StateSubscriptionManager } from './state.js';
import { LifecycleTracker } from './lifecycle.js';
import { ClientBuffer } from './client-buffer.js';

declare const __DEV__: boolean;

export interface MetroMCPGlobal {
  commands: Record<string, (params: Record<string, unknown>) => unknown>;
  redux?: {
    actions: ClientBuffer<unknown>;
    getState: () => unknown;
    dispatch: (action: unknown) => unknown;
  };
  navigation?: {
    events: ClientBuffer<unknown>;
    getState: () => unknown;
  };
  performance?: {
    marks: Map<string, number>;
    measures: Array<{ name: string; startMark: string; endMark: string; duration: number }>;
  };
  logs?: {
    channels: Map<string, ClientBuffer<unknown>>;
  };
  state?: {
    subscriptions: Map<string, () => unknown>;
  };
  lifecycle?: {
    events: ClientBuffer<unknown>;
  };
  renders?: unknown[];
  clearRenders?: () => void;
}

export class MetroMCPClient {
  private mcpGlobal: MetroMCPGlobal;
  private performance: PerformanceTracker;
  private logger: StructuredLogger;
  private stateManager: StateSubscriptionManager;
  private lifecycleTracker: LifecycleTracker;

  constructor() {
    this.mcpGlobal = {
      commands: {},
    };

    this.performance = new PerformanceTracker();
    this.logger = new StructuredLogger();
    this.stateManager = new StateSubscriptionManager();
    this.lifecycleTracker = new LifecycleTracker();

    // Register on globalThis
    (globalThis as Record<string, unknown>).__METRO_MCP__ = this.mcpGlobal;
  }

  // ── Custom Commands ──

  registerCommand(name: string, handler: (params: Record<string, unknown>) => unknown): void {
    this.mcpGlobal.commands[name] = handler;
  }

  // ── Redux ──

  useReduxMiddleware(store: ReduxStore): void {
    const { middleware, actions } = createReduxMiddleware();
    this.mcpGlobal.redux = {
      actions,
      getState: () => store.getState(),
      dispatch: (action: unknown) => store.dispatch(action),
    };
    // Apply middleware — user needs to add this to their store setup
    // Return a reference so they can compose it
    store.__metroMcpMiddleware = middleware;
  }

  /**
   * Get the Redux middleware to add to your store.
   * Call this AFTER useReduxMiddleware().
   */
  getReduxMiddleware(): unknown {
    if (!this.mcpGlobal.redux) {
      throw new Error('Call useReduxMiddleware(store) first');
    }
    return (this.mcpGlobal.redux as unknown as { actions: ClientBuffer<unknown> }).actions;
  }

  // ── Navigation ──

  useNavigationTracking(navigationRef: NavigationRef): void {
    const { events, getState } = createNavigationTracking(navigationRef);
    this.mcpGlobal.navigation = { events, getState };
  }

  // ── Performance ──

  mark(name: string): void {
    this.performance.mark(name);
    this.ensurePerformanceGlobal();
  }

  measure(name: string, startMark: string, endMark: string): number | null {
    const duration = this.performance.measure(name, startMark, endMark);
    this.ensurePerformanceGlobal();
    return duration;
  }

  private ensurePerformanceGlobal(): void {
    this.mcpGlobal.performance = {
      marks: this.performance.marks,
      measures: this.performance.measures,
    };
  }

  // ── Structured Logging ──

  log(channel: string, data: unknown): void {
    this.logger.log(channel, data);
    this.mcpGlobal.logs = { channels: this.logger.channels };
  }

  // ── State Subscriptions ──

  subscribeState(name: string, getter: () => unknown): void {
    this.stateManager.subscribe(name, getter);
    this.mcpGlobal.state = { subscriptions: this.stateManager.subscriptions };
  }

  // ── Lifecycle ──

  trackLifecycle(): void {
    this.lifecycleTracker.start();
    this.mcpGlobal.lifecycle = { events: this.lifecycleTracker.events };
  }
}

// Also export individual pieces for tree-shaking
export { createReduxMiddleware } from './middleware/redux.js';
export { createNavigationTracking } from './middleware/navigation.js';
export { PerformanceTracker, trackRender } from './performance.js';
export type { RenderRecord } from './performance.js';
export { StructuredLogger } from './logger.js';
export { StateSubscriptionManager } from './state.js';
export { LifecycleTracker } from './lifecycle.js';

// Convenience: register a command without creating a full client
export function registerCommand(
  name: string,
  handler: (params: Record<string, unknown>) => unknown
): void {
  const g = globalThis as Record<string, unknown>;
  if (!g.__METRO_MCP__) {
    g.__METRO_MCP__ = { commands: {} };
  }
  const mcp = g.__METRO_MCP__ as MetroMCPGlobal;
  if (!mcp.commands) mcp.commands = {};
  mcp.commands[name] = handler;
}
