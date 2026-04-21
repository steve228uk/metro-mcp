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
  --bg:#0d0d0d;--surface:#141414;--surface-2:#1e1e1e;--border:#2a2a2a;
  --text:#e8e8e8;--text-2:#888;--accent:#4f9cf9;--warn:#f59e0b;
  --error:#ef4444;--success:#22c55e;--purple:#a78bfa;
  --font:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --mono:'SF Mono','Fira Code','Cascadia Code',monospace;--r:5px;
}
@media(prefers-color-scheme:light){
  :root{--bg:#f5f5f7;--surface:#ffffff;--surface-2:#f0f0f2;--border:#e2e2e2;
    --text:#111111;--text-2:#666666;--accent:#1a73e8;--warn:#d97706;
    --error:#dc2626;--success:#16a34a;--purple:#7c3aed;}
}
body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:13px;line-height:1.5;height:100vh;overflow:hidden}
button{background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:var(--r);padding:4px 10px;cursor:pointer;font-size:12px;font-family:inherit}
button:hover{background:var(--surface-2)}
input,select{background:var(--surface-2);color:var(--text);border:1px solid var(--border);border-radius:var(--r);padding:5px 8px;font-size:12px;font-family:inherit;outline:none}
input:focus,select:focus{border-color:var(--accent)}
a{color:var(--accent);text-decoration:none}
${extraStyles}
</style>
</head>
<body>
${body}
<script>${BRIDGE_BOOTSTRAP_JS}</script>
</body>
</html>`;
}
