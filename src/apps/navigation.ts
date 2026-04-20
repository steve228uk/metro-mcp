import { wrapAppHtml, BRIDGE_BOOTSTRAP_JS } from '../utils/apps.js';

export function buildNavigationHtml(): string {
  const styles = `
#app{display:flex;flex-direction:column;height:100vh}
#toolbar{display:flex;align-items:center;gap:8px;padding:8px;background:var(--color-surface);border-bottom:1px solid var(--color-border);flex-shrink:0}
#status{font-size:11px;color:var(--color-text-secondary)}
#current-route{padding:8px 12px;background:rgba(34,197,94,.08);border-bottom:1px solid rgba(34,197,94,.2);font-size:12px;display:none}
#tree-wrap{flex:1;overflow-y:auto;padding:12px}
.route-node{margin-bottom:4px}
.route-row{display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:var(--radius);cursor:pointer;font-size:12px}
.route-row:hover{background:rgba(255,255,255,.05)}
.route-row.active{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3)}
.route-row.active .route-name{color:var(--color-success)}
.route-type{font-size:10px;font-weight:700;border-radius:3px;padding:1px 5px;flex-shrink:0}
.type-stack{background:rgba(79,156,249,.15);color:var(--color-accent)}
.type-tab{background:rgba(167,139,250,.15);color:#a78bfa}
.type-drawer{background:rgba(245,158,11,.15);color:var(--color-warn)}
.type-screen{background:rgba(255,255,255,.08);color:var(--color-text-secondary)}
.route-name{font-family:var(--font-mono);font-weight:600;color:var(--color-text-primary)}
.route-index{color:var(--color-text-secondary);font-size:11px}
.children{padding-left:20px;border-left:1px solid var(--color-border);margin-left:10px}
.params{padding:4px 8px 4px 36px;font-size:11px;font-family:var(--font-mono);color:var(--color-text-secondary);display:none}
.params.show{display:block}
.param-key{color:var(--color-accent)}
.empty{text-align:center;padding:40px;color:var(--color-text-secondary)}
`;

  const body = `
<div id="app">
  <div id="toolbar">
    <button id="btn-refresh">↻ Refresh</button>
    <span id="status">Loading…</span>
  </div>
  <div id="current-route" id="current">
    <span style="color:var(--color-text-secondary);font-size:11px;margin-right:6px">ACTIVE ROUTE</span>
    <span id="active-name" style="color:var(--color-success);font-weight:600"></span>
  </div>
  <div id="tree-wrap"><div class="empty">Loading navigation state…</div></div>
</div>
<script>
${BRIDGE_BOOTSTRAP_JS}

var navState = null;
var expandedParams = new Set();

function escHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function getRouteType(route) {
  if (!route) return 'screen';
  var name = (route.type || '').toLowerCase();
  if (name.indexOf('stack') !== -1) return 'stack';
  if (name.indexOf('tab') !== -1) return 'tab';
  if (name.indexOf('drawer') !== -1) return 'drawer';
  if (route.routes && route.routes.length) return 'stack';
  return 'screen';
}

function findActiveRoute(state, depth) {
  if (!state) return null;
  if (depth > 20) return null;
  var routes = state.routes || state.history || [];
  var idx = state.index !== undefined ? state.index : routes.length - 1;
  var active = routes[idx];
  if (!active) return null;
  if (active.state) return findActiveRoute(active.state, depth + 1) || active;
  return active;
}

function renderParams(params) {
  if (!params || typeof params !== 'object' || !Object.keys(params).length) return '';
  return Object.entries(params).map(function(e) {
    return '<span class="param-key">' + escHtml(e[0]) + '</span>=<span>' + escHtml(JSON.stringify(e[1])) + '</span>';
  }).join('  ');
}

function renderRoute(route, isActive, depth) {
  if (!route || depth > 15) return '';
  var type = getRouteType(route);
  var typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
  var hasParams = route.params && Object.keys(route.params).length > 0;
  var key = route.key || route.name || '';
  var isExpanded = expandedParams.has(key);
  var childRoutes = (route.state && route.state.routes) ? route.state.routes : (route.routes || []);
  var activeIdx = route.state ? (route.state.index !== undefined ? route.state.index : childRoutes.length - 1) : -1;
  return '<div class="route-node">' +
    '<div class="route-row' + (isActive ? ' active' : '') + '" data-key="' + escHtml(key) + '">' +
      '<span class="route-type type-' + type + '">' + typeLabel + '</span>' +
      '<span class="route-name">' + escHtml(route.name || '?') + '</span>' +
      (route.index !== undefined ? '<span class="route-index">· index ' + route.index + '</span>' : '') +
      (hasParams ? '<span class="route-index" style="cursor:pointer" data-toggle="' + escHtml(key) + '">' + (isExpanded ? '▾ params' : '▸ params') + '</span>' : '') +
    '</div>' +
    (hasParams ? '<div class="params' + (isExpanded ? ' show' : '') + '" id="params-' + escHtml(key) + '">' + renderParams(route.params) + '</div>' : '') +
    (childRoutes.length ? '<div class="children">' + childRoutes.map(function(r,i) {
      return renderRoute(r, i === activeIdx, depth + 1);
    }).join('') + '</div>' : '') +
    '</div>';
}

function render() {
  var wrap = document.getElementById('tree-wrap');
  var currentDiv = document.getElementById('current-route');
  if (!navState) { wrap.innerHTML = '<div class="empty">No navigation state. Is React Navigation set up?</div>'; return; }

  // Find and display active route
  var active = findActiveRoute(navState, 0);
  if (active) {
    currentDiv.style.display = 'block';
    document.getElementById('active-name').textContent = active.name || '?';
  } else {
    currentDiv.style.display = 'none';
  }

  // Render top-level state
  var routes = navState.routes || navState.history || [];
  var activeIdx = navState.index !== undefined ? navState.index : routes.length - 1;
  wrap.innerHTML = routes.map(function(r, i) { return renderRoute(r, i === activeIdx, 0); }).join('') ||
    '<div class="empty">No routes found in state.</div>';
}

document.getElementById('tree-wrap').addEventListener('click', function(e) {
  var toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    var key = toggle.dataset.toggle;
    if (expandedParams.has(key)) expandedParams.delete(key); else expandedParams.add(key);
    render();
  }
});

function fetchState() {
  mcpBridge.call('tools/call', { name: 'get_navigation_state', arguments: {} })
    .then(function(r) {
      var text = r && r.content && r.content[0] && r.content[0].text || '';
      try { navState = JSON.parse(text); } catch { navState = null; }
      document.getElementById('status').textContent = 'Loaded';
      render();
    })
    .catch(function(e) { document.getElementById('status').textContent = 'Error: ' + e.message; });
}

mcpBridge.on('ui/notifications/tool-result', function(p) {
  if (p && p.result && p.result.content) {
    var item = p.result.content.find(function(c) { return c.type === 'text'; });
    if (item) { try { navState = JSON.parse(item.text); render(); } catch {} }
  }
});

document.getElementById('btn-refresh').addEventListener('click', fetchState);
mcpBridge.initialize().then(fetchState).catch(function() {
  document.getElementById('status').textContent = 'Host not connected';
});
</script>`;

  return wrapAppHtml(body, { title: 'Navigation — Metro MCP', extraStyles: styles });
}
