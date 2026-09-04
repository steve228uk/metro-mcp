import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { MetroTarget } from 'metro-bridge';
import type { PluginContext } from '../plugin.js';
import { createMetroTargetPin, selectPinnedTarget } from './target-selection.js';

type Dispatch = 'not-sent' | 'submitted' | 'unknown';
type ReloadMethod = 'Page.reload' | 'metro-message';

export interface ReloadResult {
  status: 'failed' | 'unverified' | 'reloaded';
  dispatch: Dispatch;
  verified: boolean;
  method?: ReloadMethod;
  message?: string;
}

async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Reload deadline exceeded')), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Message-socket peers expose query strings, not CDP target IDs. */
export function selectReloadPeer(peers: unknown, target: MetroTarget): string | null {
  if (!peers || typeof peers !== 'object' || !target.appId || !target.deviceName) return null;
  const matches = Object.entries(peers).filter(([, query]) => {
    if (typeof query !== 'string') return false;
    const params = new URLSearchParams(query);
    return params.get('app') === target.appId && params.get('device') === target.deviceName;
  });
  return matches.length === 1 ? matches[0][0] : null;
}

/** Build Metro's message endpoint independently of any CDP proxy target URL. */
export function createMetroMessageUrl(host: string, port: number): URL {
  const normalizedHost = host.replace(/^\[|\]$/g, '');
  const urlHost = normalizedHost.includes(':') ? `[${normalizedHost}]` : normalizedHost;
  return new URL(`ws://${urlHost}:${port}/message`);
}

/** Send to one verified peer. A broadcast could reload unrelated apps. */
export function sendTargetedReload(
  target: MetroTarget,
  deadline: number,
  metroHost: string,
  metroPort: number,
): Promise<{ dispatch: Dispatch; error?: string }> {
  return new Promise((resolve) => {
    let dispatched = false;
    let settled = false;
    let socket: WebSocket;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (dispatch: Dispatch, error?: string) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      socket?.terminate();
      resolve({ dispatch, ...(error ? { error } : {}) });
    };
    const fail = (error: unknown) => finish(dispatched ? 'unknown' : 'not-sent',
      error instanceof Error ? error.message : String(error));
    try {
      if (Date.now() >= deadline) throw new Error('Reload deadline exceeded');
      // A target returned through the shared CDP multiplexer points at the
      // proxy. The message protocol belongs to Metro, so use the actual
      // server endpoint carried by the plugin context and always use ws.
      const url = createMetroMessageUrl(metroHost, metroPort);
      url.search = '?role=metro-mcp';
      const origin = `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
      socket = new WebSocket(url, { origin, handshakeTimeout: deadline - Date.now() });
      timer = setTimeout(() => fail(new Error('Metro message socket timed out')), Math.max(1, deadline - Date.now()));
      const id = randomUUID();
      socket.on('error', fail);
      socket.on('close', () => fail(new Error('Metro message socket closed')));
      socket.on('open', () => {
        try { socket.send(JSON.stringify({ version: 2, id, method: 'getpeers', target: 'server' })); }
        catch (error) { fail(error); }
      });
      socket.on('message', (data) => {
        if (settled || dispatched) return;
        try {
          const message = JSON.parse(data.toString());
          if (message.version !== 2 || message.id !== id) return;
          const peer = selectReloadPeer(message.result, target);
          if (!peer) throw new Error('No unique message peer matches the connected app and device; reload was not sent.');
          // No id makes this a native notification. `target` makes it a
          // directed message in Metro's protocol, never a broadcast.
          dispatched = true;
          socket.send(JSON.stringify({ version: 2, method: 'reload', target: peer }), (error) => {
            if (error) fail(error);
            else finish('submitted');
          });
        } catch (error) { fail(error); }
      });
    } catch (error) { fail(error); }
  });
}

export async function reloadApp(ctx: PluginContext, timeout: number): Promise<ReloadResult> {
  const target = ctx.cdp.getTarget();
  if (!target || !ctx.cdp.isConnected || !target.webSocketDebuggerUrl || !target.appId) {
    return { status: 'failed', dispatch: 'not-sent', verified: false, message: 'No connected app to reload.' };
  }
  const deadline = Date.now() + timeout;
  const url = new URL(target.webSocketDebuggerUrl);
  const pin = createMetroTargetPin({ host: url.hostname, port: Number(url.port) }, target);
  const sameTarget = () => {
    const current = ctx.cdp.getTarget();
    if (!current || !ctx.cdp.isConnected || !current.webSocketDebuggerUrl) return false;
    const currentUrl = new URL(current.webSocketDebuggerUrl);
    return currentUrl.host === url.host && !!selectPinnedTarget([current], pin);
  };
  const key = `__METRO_MCP_RELOAD_${randomUUID().replace(/-/g, '')}`;
  const marker = JSON.stringify(key);
  const requireOriginalRuntime = async () => {
    if (Date.now() >= deadline) throw new Error('Reload deadline exceeded before dispatch');
    if (!sameTarget()) throw new Error('Connected app changed before reload dispatch.');
    const present = await beforeDeadline(ctx.evalInApp(`this[${marker}] === true`, {
      awaitPromise: true, timeout: Math.max(1, deadline - Date.now()),
    }), deadline);
    if (present !== true || !sameTarget()) throw new Error('App runtime changed before reload dispatch; reload was not sent.');
  };
  try {
    const installed = await ctx.evalInApp(`(function() {
      var root = this;
      root[${marker}] = true;
      root.setTimeout(function() { delete root[${marker}]; }, ${timeout + 60_000});
      return root[${marker}];
    })()`, { awaitPromise: true, timeout: Math.max(1, deadline - Date.now()) });
    if (installed !== true || !sameTarget()) throw new Error('Connected app changed before reload dispatch.');
    await requireOriginalRuntime();
  } catch (error) {
    return { status: 'failed', dispatch: 'not-sent', verified: false,
      message: error instanceof Error ? error.message : String(error) };
  }

  let method: ReloadMethod = 'Page.reload';
  let dispatch: Dispatch = 'not-sent';
  let dispatchError: string | undefined;
  try {
    if (Date.now() >= deadline) throw new Error('Reload deadline exceeded before dispatch');
    dispatch = 'unknown';
    // Metro Bridge owns the transport timeout. Pass the remaining reload
    // budget through so a stalled CDP request cannot outlive this operation.
    await beforeDeadline(ctx.cdp.send.call(ctx.cdp, 'Page.reload', undefined, {
      timeoutMs: Math.max(1, deadline - Date.now()),
    }), deadline);
    dispatch = 'submitted';
  } catch (error) {
    dispatchError = error instanceof Error ? error.message : String(error);
    if (/unsupported method|method not found|method not supported|'Page\.reload' wasn't found/i.test(dispatchError)) {
      method = 'metro-message';
      dispatch = 'not-sent';
      try {
        await requireOriginalRuntime();
        const result = await sendTargetedReload(target, deadline, ctx.metro.host, ctx.metro.port);
        dispatch = result.dispatch;
        dispatchError = result.error;
      } catch (preflightError) {
        dispatchError = preflightError instanceof Error ? preflightError.message : String(preflightError);
      }
    }
    // A dropped response may still mean the app restarted. Verify, but do
    // not issue a second reload after an ambiguous dispatch.
  }

  if (dispatch !== 'not-sent') {
    while (Date.now() < deadline) {
      try {
        // Let the shared evaluator reconnect after a reload drops the CDP
        // target. Validate the refreshed target pin only after that read so a
        // reconnect to another app can never be reported as a restart.
        const present = await beforeDeadline(ctx.evalInApp(`this[${marker}] === true`, {
          awaitPromise: true, timeout: Math.max(1, Math.min(1000, deadline - Date.now())),
        }), deadline);
        if (present === false && sameTarget()) {
          return { status: 'reloaded', method, dispatch, verified: true };
        }
      } catch { /* A reload may temporarily disconnect or destroy the context. */ }
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(100, deadline - Date.now()))));
    }
  }
  // The marker expires after the verification window if the old runtime
  // survives. It cannot expire early and create a false restart result.
  return {
    status: dispatch === 'not-sent' ? 'failed' : 'unverified', method, dispatch, verified: false,
    message: dispatchError || 'Reload was submitted, but a fresh runtime on the same app was not observed before timeout.',
  };
}
