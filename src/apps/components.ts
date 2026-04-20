import { wrapAppHtml, BRIDGE_BOOTSTRAP_JS } from '../utils/apps.js';

export function buildComponentsHtml(): string {
  const styles = `
#app{display:flex;flex-direction:column;height:100vh}
#toolbar{display:flex;align-items:center;gap:8px;padding:8px;background:var(--color-surface);border-bottom:1px solid var(--color-border);flex-shrink:0}
#search{flex:1;min-width:120px}
#status{font-size:11px;color:var(--color-text-secondary)}
#main{flex:1;display:flex;overflow:hidden}
#tree-pane{flex:1;overflow-y:auto;padding:8px 0;font-size:12px;font-family:var(--font-mono)}
#detail-pane{width:260px;flex-shrink:0;border-left:1px solid var(--color-border);overflow-y:auto;display:none;background:var(--color-surface)}
#detail-pane.open{display:block}
.comp-row{display:flex;align-items:center;gap:4px;padding:2px 8px;cursor:pointer;white-space:nowrap}
.comp-row:hover{background:rgba(255,255,255,.05)}
.comp-row.selected{background:rgba(79,156,249,.12)}
.comp-row.highlighted .comp-name{background:rgba(79,156,249,.2);border-radius:2px}
.toggler{width:14px;text-align:center;color:var(--color-text-secondary);cursor:pointer;flex-shrink:0;font-size:10px}
.comp-name{color:var(--color-text-primary)}
.comp-name.has-testid{color:var(--color-accent)}
.comp-meta{font-size:10px;color:var(--color-text-secondary);margin-left:4px}
.detail-section{padding:10px 12px;border-bottom:1px solid var(--color-border)}
.detail-section h4{font-size:10px;font-weight:700;color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.prop-row{font-size:11px;padding:1px 0;word-break:break-all}
.prop-key{color:var(--color-accent)}
.prop-val{color:var(--color-text-secondary)}
#detail-close{background:none;border:none;color:var(--color-text-secondary);cursor:pointer;font-size:16px}
.empty{text-align:center;padding:40px;color:var(--color-text-secondary)}
`;

  const body = `
<div id="app">
  <div id="toolbar">
    <input id="search" type="text" placeholder="Filter components…">
    <button id="btn-refresh">↻ Refresh</button>
    <button id="btn-expand">Expand All</button>
    <button id="btn-collapse">Collapse All</button>
    <span id="status">Loading…</span>
  </div>
  <div id="main">
    <div id="tree-pane"><div class="empty">Loading component tree…</div></div>
    <div id="detail-pane">
      <div class="detail-section" style="display:flex;align-items:center;justify-content:space-between">
        <strong id="detail-name" style="font-size:12px"></strong>
        <button id="detail-close">✕</button>
      </div>
      <div id="detail-body"></div>
    </div>
  </div>
</div>
<script>
${BRIDGE_BOOTSTRAP_JS}

var tree = null;
var collapsed = new Set();
var searchText = '';
var selectedPath = null;

function escHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function hasMatch(node) {
  if (!searchText) return true;
  if (node.name && node.name.toLowerCase().indexOf(searchText) !== -1) return true;
  if (node.children) return node.children.some(hasMatch);
  return false;
}

function renderNode(node, path, depth) {
  if (!node) return '';
  if (searchText && !hasMatch(node)) return '';
  var hasChildren = node.children && node.children.length > 0;
  var isCollapsed = collapsed.has(path);
  var isSelected = selectedPath === path;
  var isMatch = searchText && node.name && node.name.toLowerCase().indexOf(searchText) !== -1;
  var hasTestId = !!node.testID;
  var indent = 'padding-left:' + (8 + depth * 16) + 'px';
  var html = '<div class="comp-row' + (isSelected ? ' selected' : '') + (isMatch ? ' highlighted' : '') + '" style="' + indent + '" data-path="' + escHtml(path) + '">' +
    '<span class="toggler" data-toggle="' + escHtml(path) + '">' + (hasChildren ? (isCollapsed ? '▶' : '▼') : ' ') + '</span>' +
    '<span class="comp-name' + (hasTestId ? ' has-testid' : '') + '">' + escHtml(node.name || '?') + '</span>' +
    (node.testID ? '<span class="comp-meta">#' + escHtml(node.testID) + '</span>' : '') +
    (node.accessibilityLabel ? '<span class="comp-meta">a11y:"' + escHtml(node.accessibilityLabel.slice(0,20)) + '"</span>' : '') +
    '</div>';
  if (hasChildren && !isCollapsed) {
    html += node.children.map(function(child, i) {
      return renderNode(child, path + '.' + i, depth + 1);
    }).join('');
  }
  return html;
}

function render() {
  var pane = document.getElementById('tree-pane');
  if (!tree) { pane.innerHTML = '<div class="empty">Loading…</div>'; return; }
  var html = Array.isArray(tree)
    ? tree.map(function(n, i) { return renderNode(n, '$.' + i, 0); }).join('')
    : renderNode(tree, '$', 0);
  pane.innerHTML = html || '<div class="empty">No components match.</div>';
}

document.getElementById('tree-pane').addEventListener('click', function(e) {
  var tog = e.target.closest('[data-toggle]');
  if (tog) {
    var path = tog.dataset.toggle;
    if (collapsed.has(path)) collapsed.delete(path); else collapsed.add(path);
    render();
    return;
  }
  var row = e.target.closest('.comp-row');
  if (row) {
    selectedPath = row.dataset.path;
    render();
    openDetail(row.dataset.path);
  }
});

function openDetail(path) {
  var node = getByPath(path);
  if (!node) return;
  var pane = document.getElementById('detail-pane');
  pane.classList.add('open');
  document.getElementById('detail-name').textContent = node.name || '?';
  var html = '';
  if (node.testID || node.accessibilityLabel || node.accessibilityRole) {
    html += '<div class="detail-section"><h4>Accessibility</h4>';
    if (node.testID) html += prop('testID', node.testID);
    if (node.accessibilityLabel) html += prop('label', node.accessibilityLabel);
    if (node.accessibilityRole) html += prop('role', node.accessibilityRole);
    html += '</div>';
  }
  if (node.props && Object.keys(node.props).length) {
    html += '<div class="detail-section"><h4>Props</h4>';
    Object.entries(node.props).slice(0, 30).forEach(function(e) {
      html += prop(e[0], e[1]);
    });
    html += '</div>';
  }
  if (node.state !== undefined && node.state !== null) {
    html += '<div class="detail-section"><h4>State</h4><pre style="font-size:11px;color:var(--color-text-secondary);white-space:pre-wrap;word-break:break-all">' + escHtml(JSON.stringify(node.state, null, 2).slice(0, 1000)) + '</pre></div>';
  }
  document.getElementById('detail-body').innerHTML = html;
}

function prop(k, v) {
  return '<div class="prop-row"><span class="prop-key">' + escHtml(k) + '</span>: <span class="prop-val">' + escHtml(JSON.stringify(v).slice(0, 100)) + '</span></div>';
}

function getByPath(path) {
  try {
    return path.split('.').slice(1).reduce(function(o, k) {
      var i = parseInt(k);
      return Array.isArray(o) ? o[i] : (o.children ? o.children[i] : o);
    }, Array.isArray(tree) ? tree : [tree]);
  } catch { return null; }
}

document.getElementById('detail-close').addEventListener('click', function() {
  document.getElementById('detail-pane').classList.remove('open');
  selectedPath = null;
  render();
});

document.getElementById('search').addEventListener('input', function(e) {
  searchText = e.target.value.toLowerCase();
  render();
});

document.getElementById('btn-refresh').addEventListener('click', fetchTree);
document.getElementById('btn-expand').addEventListener('click', function() { collapsed.clear(); render(); });
document.getElementById('btn-collapse').addEventListener('click', function() {
  function collapseAll(node, path) {
    if (!node) return;
    if (node.children && node.children.length) {
      collapsed.add(path);
      node.children.forEach(function(c, i) { collapseAll(c, path + '.' + i); });
    }
  }
  if (Array.isArray(tree)) tree.forEach(function(n, i) { collapseAll(n, '$.' + i); });
  else collapseAll(tree, '$');
  render();
});

function fetchTree() {
  mcpBridge.call('tools/call', { name: 'get_component_tree', arguments: { structureOnly: false } })
    .then(function(r) {
      var text = r && r.content && r.content[0] && r.content[0].text || '{}';
      try { tree = JSON.parse(text); } catch { tree = null; }
      document.getElementById('status').textContent = 'Loaded';
      render();
    })
    .catch(function(e) { document.getElementById('status').textContent = 'Error: ' + e.message; });
}

mcpBridge.on('ui/notifications/tool-result', function(p) {
  if (p && p.result && p.result.content) {
    var item = p.result.content.find(function(c) { return c.type === 'text'; });
    if (item) { try { tree = JSON.parse(item.text); render(); } catch {} }
  }
});

mcpBridge.initialize().then(fetchTree).catch(function() {
  document.getElementById('status').textContent = 'Host not connected';
});
</script>`;

  return wrapAppHtml(body, { title: 'Components — Metro MCP', extraStyles: styles });
}
