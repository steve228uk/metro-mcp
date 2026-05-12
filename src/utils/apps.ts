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
    window.parent.postMessage(msg, '*');
  }

  function applyHostContext(params) {
    var styleVariables = params && params.styles && params.styles.variables;
    var legacyVariables = params && params.cssVariables;
    var variables = styleVariables || legacyVariables;
    if (variables && typeof variables === 'object') {
      var root = document.documentElement;
      Object.keys(variables).forEach(function(k) {
        if (root.style.getPropertyValue(k) !== variables[k]) root.style.setProperty(k, variables[k]);
      });
    }
    if (params && params.theme && document.documentElement.dataset.theme !== params.theme) {
      document.documentElement.dataset.theme = params.theme;
    }
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
      if (msg.method === 'ui/notifications/host-context-changed') {
        applyHostContext(msg.params || {});
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
      }).then(function(result) {
        if (result && result.hostContext) applyHostContext(result.hostContext);
        send({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
        return result;
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

export const DEFAULT_APP_MIN_HEIGHT = 420;
export const MCP_UI_PREFERRED_FRAME_SIZE_META_KEY = 'mcpui.dev/ui-preferred-frame-size';

const APP_SIZING_ATTRIBUTE = 'data-metro-mcp-app-sizing';
const APP_SIZING_SELECTORS = ['html', 'body', '#app', '.layout'];
const APP_FIXED_HEIGHT_SELECTORS = ['body', '.layout'];
const APP_MEASURED_ELEMENT_SELECTORS = ['#app', '.layout'];
const APP_SIZE_RETRY_DELAYS = [0, 50, 250, 500, 1000];
const APP_SIZING_SELECTOR_LIST = APP_SIZING_SELECTORS.join(',');
const APP_FIXED_HEIGHT_SELECTOR_LIST = APP_FIXED_HEIGHT_SELECTORS.join(',');
const APP_MEASURED_ELEMENT_SELECTORS_JSON = JSON.stringify(APP_MEASURED_ELEMENT_SELECTORS);
const APP_SIZE_RETRY_DELAYS_JSON = JSON.stringify(APP_SIZE_RETRY_DELAYS);

function normalizeAppMinHeight(minHeight: number): number {
  if (Number.isFinite(minHeight) && minHeight > 0) return Math.round(minHeight);
  return DEFAULT_APP_MIN_HEIGHT;
}

export function createPreferredFrameSizeMeta(minHeight = DEFAULT_APP_MIN_HEIGHT): Record<string, unknown> {
  const safeMinHeight = normalizeAppMinHeight(minHeight);
  return {
    [MCP_UI_PREFERRED_FRAME_SIZE_META_KEY]: ['100%', `${safeMinHeight}px`],
  };
}

function insertBeforeClosingTag(html: string, closingTag: string, insertion: string, whenMissing: 'append' | 'prepend'): string {
  const index = html.indexOf(closingTag);
  if (index !== -1) {
    return `${html.slice(0, index)}${insertion}${html.slice(index)}`;
  }
  return whenMissing === 'append' ? `${html}${insertion}` : `${insertion}${html}`;
}

/**
 * Ensure MCP App resources have a non-collapsing initial height and can ask
 * hosts to resize via MCP Apps and MCP-UI compatibility sizing channels.
 */
export function withAppSizing(html: string, minHeight = DEFAULT_APP_MIN_HEIGHT): string {
  if (html.includes(APP_SIZING_ATTRIBUTE)) return html;

  const safeMinHeight = normalizeAppMinHeight(minHeight);

  const sizingStyle = `<style ${APP_SIZING_ATTRIBUTE}>
${APP_SIZING_SELECTOR_LIST}{min-height:${safeMinHeight}px!important}
${APP_FIXED_HEIGHT_SELECTOR_LIST}{height:max(100vh,${safeMinHeight}px)!important}
</style>
`;

  const sizingScript = `<script ${APP_SIZING_ATTRIBUTE}>
(function(){
  var minHeight = ${safeMinHeight};
  var measuredSelectors = ${APP_MEASURED_ELEMENT_SELECTORS_JSON};
  var retryDelays = ${APP_SIZE_RETRY_DELAYS_JSON};
  var lastWidth = 0;
  var lastHeight = 0;
  var scheduled = false;
  var initializePatched = false;
  function sendToHost(message){
    var target = window.parent || window;
    try {
      target.postMessage(message, '*');
    } catch (err) {
      try { target.postMessage(message); } catch (innerErr) {}
    }
  }
  function measureElement(element){
    if (!element) return 0;
    return Math.max(
      element.scrollHeight || 0,
      element.offsetHeight || 0,
      Math.ceil(element.getBoundingClientRect ? element.getBoundingClientRect().height : 0)
    );
  }
  function measureHeight(){
    var height = minHeight;
    height = Math.max(height, measureElement(document.documentElement), measureElement(document.body));
    for (var i = 0; i < measuredSelectors.length; i++) {
      height = Math.max(height, measureElement(document.querySelector(measuredSelectors[i])));
    }
    return height;
  }
  function postSize(force){
    scheduled = false;
    var width = Math.ceil(window.innerWidth || document.documentElement.clientWidth || 0);
    var height = measureHeight();
    if (!force && width === lastWidth && height === lastHeight) return;
    lastWidth = width;
    lastHeight = height;
    sendToHost({
      type: 'ui-size-change',
      payload: { height: height }
    });
    sendToHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/size-changed',
      params: { width: width, height: height }
    });
  }
  function schedulePostSize(){
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function(){ postSize(false); });
  }
  function forcePostSize(){
    postSize(true);
    requestAnimationFrame(function(){ postSize(true); });
  }
  function retryPostSizes(){
    postSize(true);
    retryDelays.forEach(function(delay){ setTimeout(forcePostSize, delay); });
  }
  function patchInitialize(){
    if (initializePatched || !window.mcpBridge || typeof window.mcpBridge.initialize !== 'function') return;
    initializePatched = true;
    var originalInitialize = window.mcpBridge.initialize;
    window.mcpBridge.initialize = function(){
      return originalInitialize.apply(window.mcpBridge, arguments).then(function(result){
        retryPostSizes();
        return result;
      });
    };
  }
  if ('ResizeObserver' in window) {
    var observer = new ResizeObserver(schedulePostSize);
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
    var app = document.getElementById('app');
    if (app) observer.observe(app);
  }
  patchInitialize();
  window.addEventListener('load', function(){
    patchInitialize();
    retryPostSizes();
  });
  window.addEventListener('resize', forcePostSize);
  retryPostSizes();
})();
</script>
`;

  const withStyle = insertBeforeClosingTag(html, '</head>', sizingStyle, 'prepend');
  return insertBeforeClosingTag(withStyle, '</body>', sizingScript, 'append');
}

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
