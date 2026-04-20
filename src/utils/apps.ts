// ── MCP Apps support ─────────────────────────────────────────────────────────
// Implements the MCP Apps extension (spec 2026-01-26) natively without the
// @modelcontextprotocol/ext-apps package, which requires SDK ^1.29.0 while
// metro-mcp currently uses ^1.12.1. Replace with the official package once
// the SDK dependency is upgraded.

/** MIME type for MCP App HTML resources. */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * Build the _meta object that links a tool result to an MCP App.
 * Sets both the legacy 'ui/resourceUri' key (older hosts) and the current
 * 'ui.resourceUri' shape (spec 2026-01-26+) for maximum host compatibility.
 */
export function buildAppMeta(resourceUri: string): Record<string, unknown> {
  return {
    'ui/resourceUri': resourceUri,
    ui: { resourceUri },
  };
}

/**
 * Shared postMessage bridge for MCP App HTML pages.
 *
 * Embed this in each app's <script> tag. Exposes a global `mcpBridge` object:
 *   mcpBridge.initialize()           → Promise<void> — handshake with host
 *   mcpBridge.call(method, params)   → Promise<unknown> — JSON-RPC call to host
 *   mcpBridge.on(method, handler)    → listen for host notifications
 *
 * The host sends CSS variables via ui/notifications/host-context-changed;
 * the bridge applies them to :root automatically for theming.
 */
export const BRIDGE_BOOTSTRAP_JS = `(function() {
  var pending = new Map();
  var handlers = new Map();
  var nextId = 1;

  function send(msg) {
    window.parent.postMessage(JSON.stringify(msg), '*');
  }

  window.addEventListener('message', function(e) {
    var msg;
    try { msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    if (!msg || msg.jsonrpc !== '2.0') return;

    if (msg.id != null && pending.has(msg.id)) {
      var cb = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) cb.reject(new Error(msg.error.message || 'RPC error'));
      else cb.resolve(msg.result);
      return;
    }

    if (msg.method) {
      // Apply theming from host-context-changed
      if (msg.method === 'ui/notifications/host-context-changed') {
        var css = msg.params && msg.params.cssVariables;
        if (css && typeof css === 'object') {
          var root = document.documentElement;
          Object.keys(css).forEach(function(k) { root.style.setProperty(k, css[k]); });
        }
      }
      var h = handlers.get(msg.method);
      if (h) h(msg.params || {});
    }
  });

  window.mcpBridge = {
    initialize: function() {
      return new Promise(function(resolve, reject) {
        var id = nextId++;
        pending.set(id, { resolve: resolve, reject: reject });
        send({
          jsonrpc: '2.0', id: id, method: 'ui/initialize',
          params: {
            appInfo: { name: 'metro-mcp-app', version: '1.0' },
            appCapabilities: {},
            protocolVersion: '2026-01-26'
          }
        });
      });
    },
    call: function(method, params) {
      return new Promise(function(resolve, reject) {
        var id = nextId++;
        pending.set(id, { resolve: resolve, reject: reject });
        send({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
      });
    },
    on: function(method, handler) {
      handlers.set(method, handler);
    }
  };
})();`;

/**
 * Wrap a body HTML snippet in a complete, self-contained MCP App document.
 * Includes the postMessage bridge, CSS reset, and theme-aware custom properties.
 */
export function wrapAppHtml(body: string, opts?: { title?: string; extraStyles?: string }): string {
  const title = opts?.title ?? 'Metro MCP';
  const extraStyles = opts?.extraStyles ?? '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --color-bg:#0d0d0d;
  --color-surface:#1a1a1a;
  --color-border:#2a2a2a;
  --color-text-primary:#e8e8e8;
  --color-text-secondary:#888;
  --color-accent:#4f9cf9;
  --color-warn:#f59e0b;
  --color-error:#ef4444;
  --color-success:#22c55e;
  --font-sans:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --font-mono:'SF Mono','Fira Code',monospace;
  --radius:6px;
}
body{
  background:var(--color-bg);
  color:var(--color-text-primary);
  font-family:var(--font-sans);
  font-size:13px;
  line-height:1.5;
  height:100vh;
  overflow:hidden;
}
button{
  background:var(--color-surface);
  color:var(--color-text-primary);
  border:1px solid var(--color-border);
  border-radius:var(--radius);
  padding:4px 10px;
  cursor:pointer;
  font-size:12px;
  font-family:inherit;
}
button:hover{background:var(--color-border)}
input,select{
  background:var(--color-surface);
  color:var(--color-text-primary);
  border:1px solid var(--color-border);
  border-radius:var(--radius);
  padding:4px 8px;
  font-size:12px;
  font-family:inherit;
  outline:none;
}
input:focus,select:focus{border-color:var(--color-accent)}
${extraStyles}
</style>
</head>
<body>
${body}
<script>${BRIDGE_BOOTSTRAP_JS}</script>
</body>
</html>`;
}
