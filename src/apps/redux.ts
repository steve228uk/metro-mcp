import { wrapAppHtml, BRIDGE_BOOTSTRAP_JS } from '../utils/apps.js';

export function buildReduxHtml(): string {
  const styles = `
#app{display:flex;flex-direction:column;height:100vh}
#toolbar{display:flex;align-items:center;gap:8px;padding:8px;background:var(--color-surface);border-bottom:1px solid var(--color-border);flex-shrink:0}
#search{flex:1;min-width:120px}
#status{font-size:11px;color:var(--color-text-secondary)}
#tree-wrap{flex:1;overflow-y:auto;padding:8px 12px;font-family:var(--font-mono);font-size:12px}
.node{padding:1px 0}
.toggler{cursor:pointer;color:var(--color-text-secondary);user-select:none;margin-right:4px;display:inline-block;width:12px;text-align:center}
.key{color:#4f9cf9}
.val-string{color:#86efac}
.val-number{color:#fca5a5}
.val-bool{color:#fcd34d}
.val-null{color:var(--color-text-secondary)}
.children{padding-left:18px;display:block}
.children.collapsed{display:none}
.copy-btn{font-size:9px;margin-left:6px;padding:0 4px;opacity:0;transition:opacity .15s;cursor:pointer;border:1px solid var(--color-border);border-radius:3px}
.node:hover .copy-btn{opacity:1}
.highlight{background:rgba(79,156,249,.2);border-radius:2px}
.empty{text-align:center;padding:40px;color:var(--color-text-secondary);font-size:13px}
`;

  const body = `
<div id="app">
  <div id="toolbar">
    <input id="search" type="text" placeholder="Search state keys…">
    <button id="btn-refresh">↻ Refresh</button>
    <button id="btn-expand">Expand All</button>
    <button id="btn-collapse">Collapse All</button>
    <span id="status">Loading…</span>
  </div>
  <div id="tree-wrap"><div class="empty">Loading state…</div></div>
</div>
<script>
${BRIDGE_BOOTSTRAP_JS}

var stateData = null;
var searchText = '';
var collapsedPaths = new Set();
var allExpanded = false;

function escHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function buildTree(val, path, depth) {
  if (depth > 30) return '<span class="val-null">[max depth]</span>';
  if (val === null) return '<span class="val-null">null</span>';
  if (val === undefined) return '<span class="val-null">undefined</span>';
  var type = typeof val;
  if (type === 'string') return '<span class="val-string">"' + escHtml(val.slice(0,200)) + (val.length > 200 ? '…' : '') + '"</span>';
  if (type === 'number') return '<span class="val-number">' + val + '</span>';
  if (type === 'boolean') return '<span class="val-bool">' + val + '</span>';
  if (Array.isArray(val)) {
    if (!val.length) return '<span class="val-null">[]</span>';
    var isCollapsed = collapsedPaths.has(path);
    var inner = val.map(function(v,i) {
      var childPath = path + '[' + i + ']';
      var match = !searchText || JSON.stringify(v).toLowerCase().indexOf(searchText) !== -1;
      if (!match) return '';
      return '<div class="node"><span class="key">' + i + '</span>: ' + buildTree(v, childPath, depth+1) + '</div>';
    }).filter(Boolean).join('');
    return '<span class="toggler" data-path="' + escHtml(path) + '">' + (isCollapsed ? '▶' : '▼') + '</span>' +
      '<span class="val-null">[' + val.length + ']</span>' +
      '<button class="copy-btn" data-copy="' + escHtml(path) + '">copy</button>' +
      '<div class="children' + (isCollapsed ? ' collapsed' : '') + '">' + inner + '</div>';
  }
  if (type === 'object') {
    var keys = Object.keys(val);
    if (!keys.length) return '<span class="val-null">{}</span>';
    var isCollapsed = collapsedPaths.has(path);
    var inner = keys.map(function(k) {
      var childPath = path + '.' + k;
      var match = !searchText || k.toLowerCase().indexOf(searchText) !== -1 || JSON.stringify(val[k]).toLowerCase().indexOf(searchText) !== -1;
      if (!match) return '';
      return '<div class="node"><span class="key">' + escHtml(k) + '</span>: ' + buildTree(val[k], childPath, depth+1) + '</div>';
    }).filter(Boolean).join('');
    return '<span class="toggler" data-path="' + escHtml(path) + '">' + (isCollapsed ? '▶' : '▼') + '</span>' +
      '<span class="val-null">{' + keys.length + '}</span>' +
      '<button class="copy-btn" data-copy="' + escHtml(path) + '">copy</button>' +
      '<div class="children' + (isCollapsed ? ' collapsed' : '') + '">' + inner + '</div>';
  }
  return '<span>' + escHtml(String(val)) + '</span>';
}

function render() {
  var wrap = document.getElementById('tree-wrap');
  if (!stateData) { wrap.innerHTML = '<div class="empty">No state loaded. Make sure Redux is set up in your app.</div>'; return; }
  wrap.innerHTML = buildTree(stateData, '$', 0);
}

document.getElementById('tree-wrap').addEventListener('click', function(e) {
  var tog = e.target.closest('.toggler');
  if (tog) {
    var path = tog.dataset.path;
    if (collapsedPaths.has(path)) collapsedPaths.delete(path); else collapsedPaths.add(path);
    render();
    return;
  }
  var copyBtn = e.target.closest('.copy-btn');
  if (copyBtn) {
    var path = copyBtn.dataset.copy;
    var val = getByPath(stateData, path);
    navigator.clipboard && navigator.clipboard.writeText(JSON.stringify(val, null, 2));
  }
});

function getByPath(obj, path) {
  try {
    return path.split('.').reduce(function(o,k) {
      var m = k.match(/^(\\w+)\\[(\\d+)\\]$/);
      if (m) return o[m[1]][parseInt(m[2])];
      return o[k];
    }, obj);
  } catch { return null; }
}

document.getElementById('search').addEventListener('input', function(e) {
  searchText = e.target.value.toLowerCase();
  render();
});
document.getElementById('btn-refresh').addEventListener('click', fetchState);
document.getElementById('btn-expand').addEventListener('click', function() { collapsedPaths.clear(); render(); });
document.getElementById('btn-collapse').addEventListener('click', function() {
  if (stateData) Object.keys(stateData).forEach(function(k) { collapsedPaths.add('$.' + k); });
  render();
});

function fetchState() {
  mcpBridge.call('tools/call', { name: 'get_redux_state', arguments: {} })
    .then(function(r) {
      var text = r && r.content && r.content[0] && r.content[0].text || '';
      try { stateData = JSON.parse(text); } catch { stateData = { _raw: text }; }
      document.getElementById('status').textContent = 'Loaded';
      render();
    })
    .catch(function(e) { document.getElementById('status').textContent = 'Error: ' + e.message; });
}

mcpBridge.on('ui/notifications/tool-result', function(p) {
  if (p && p.result && p.result.content) {
    var item = p.result.content.find(function(c) { return c.type === 'text'; });
    if (item) {
      try { stateData = JSON.parse(item.text); render(); } catch {}
    }
  }
});

mcpBridge.initialize().then(fetchState).catch(function() {
  document.getElementById('status').textContent = 'Host not connected';
});
</script>`;

  return wrapAppHtml(body, { title: 'Redux State — Metro MCP', extraStyles: styles });
}
