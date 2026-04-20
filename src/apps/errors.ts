import { wrapAppHtml, BRIDGE_BOOTSTRAP_JS } from '../utils/apps.js';

export function buildErrorsHtml(): string {
  const styles = `
#app{display:flex;flex-direction:column;height:100vh}
#toolbar{display:flex;align-items:center;gap:8px;padding:8px;background:var(--color-surface);border-bottom:1px solid var(--color-border);flex-shrink:0}
#status{font-size:11px;color:var(--color-text-secondary)}
#list{flex:1;overflow-y:auto;padding:12px}
.card{background:var(--color-surface);border:1px solid rgba(239,68,68,.25);border-radius:var(--radius);margin-bottom:10px;overflow:hidden}
.card-header{padding:10px 12px;cursor:pointer;display:flex;align-items:flex-start;gap:8px}
.card-header:hover{background:rgba(239,68,68,.05)}
.err-icon{color:var(--color-error);font-size:14px;flex-shrink:0;margin-top:1px}
.err-msg{font-size:12px;color:var(--color-text-primary);flex:1;font-family:var(--font-mono);word-break:break-all}
.err-ts{font-size:10px;color:var(--color-text-secondary);flex-shrink:0;white-space:nowrap}
.chevron{font-size:10px;color:var(--color-text-secondary);flex-shrink:0;margin-top:3px;transition:transform .2s}
.chevron.open{transform:rotate(90deg)}
.stack{display:none;padding:8px 12px 12px;border-top:1px solid rgba(239,68,68,.15)}
.stack.open{display:block}
.frame{font-size:11px;font-family:var(--font-mono);color:var(--color-text-secondary);padding:1px 0}
.frame .loc{color:var(--color-accent)}
.empty{text-align:center;padding:40px;color:var(--color-text-secondary)}
`;

  const body = `
<div id="app">
  <div id="toolbar">
    <button id="btn-refresh">↻ Refresh</button>
    <button id="btn-clear" style="color:var(--color-error)">Clear</button>
    <span id="status">Loading…</span>
  </div>
  <div id="list"><div class="empty">No errors captured.</div></div>
</div>
<script>
${BRIDGE_BOOTSTRAP_JS}

function escHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// Parse text format: "HH:MM:SS.mmm [ERROR] message\noptional stack frames"
function parseErrors(text) {
  if (!text || !text.trim()) return [];
  var TS_RE = /^(\\d{2}:\\d{2}:\\d{2}\\.\\d{3}) \\[error\\] /i;
  var errors = [];
  var current = null;
  text.split('\\n').forEach(function(line) {
    if (TS_RE.test(line)) {
      if (current) errors.push(current);
      var m = TS_RE.exec(line);
      current = { ts: m[1], msg: line.slice(m[0].length), frames: [] };
    } else if (current && line.trim()) {
      current.frames.push(line.trim());
    }
  });
  if (current) errors.push(current);
  return errors;
}

function renderFrames(frames) {
  if (!frames.length) return '<span class="frame" style="color:var(--color-text-secondary)">No stack trace</span>';
  return frames.slice(0, 30).map(function(f) {
    // Highlight file:line references
    var highlighted = f.replace(/([^\\s]+\\.js:\\d+:\\d+)/g, '<span class="loc">$1</span>');
    return '<div class="frame">' + highlighted + '</div>';
  }).join('');
}

var errors = [];
var openIdx = null;

function render() {
  var list = document.getElementById('list');
  if (!errors.length) { list.innerHTML = '<div class="empty">No errors captured.</div>'; return; }
  list.innerHTML = errors.map(function(e, i) {
    var isOpen = openIdx === i;
    return '<div class="card" data-i="' + i + '">' +
      '<div class="card-header">' +
        '<span class="err-icon">✕</span>' +
        '<span class="err-msg">' + escHtml(e.msg) + '</span>' +
        '<span class="err-ts">' + e.ts + '</span>' +
        '<span class="chevron' + (isOpen ? ' open' : '') + '">›</span>' +
      '</div>' +
      '<div class="stack' + (isOpen ? ' open' : '') + '">' + renderFrames(e.frames) + '</div>' +
      '</div>';
  }).join('');
  document.getElementById('status').textContent = errors.length + ' error' + (errors.length !== 1 ? 's' : '');
}

document.getElementById('list').addEventListener('click', function(e) {
  var card = e.target.closest('.card');
  if (!card) return;
  var i = parseInt(card.dataset.i);
  openIdx = openIdx === i ? null : i;
  render();
});

document.getElementById('btn-refresh').addEventListener('click', fetchErrors);
document.getElementById('btn-clear').addEventListener('click', function() {
  mcpBridge.call('tools/call', { name: 'clear_errors', arguments: {} })
    .then(function() { errors = []; openIdx = null; render(); })
    .catch(function(e) { document.getElementById('status').textContent = 'Error: ' + e.message; });
});

function fetchErrors() {
  mcpBridge.call('tools/call', { name: 'get_errors', arguments: { limit: 50 } })
    .then(function(r) {
      var text = r && r.content && r.content[0] && r.content[0].text || '';
      errors = parseErrors(text);
      render();
    })
    .catch(function(e) { document.getElementById('status').textContent = 'Error: ' + e.message; });
}

mcpBridge.on('ui/notifications/tool-result', function(p) {
  if (p && p.result && p.result.content) {
    var item = p.result.content.find(function(c) { return c.type === 'text'; });
    if (item) { errors = parseErrors(item.text || ''); render(); }
  }
});

mcpBridge.initialize().then(fetchErrors).catch(function() {
  document.getElementById('status').textContent = 'Host not connected';
});
setInterval(fetchErrors, 5000);
</script>`;

  return wrapAppHtml(body, { title: 'Errors — Metro MCP', extraStyles: styles });
}
