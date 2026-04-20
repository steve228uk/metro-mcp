import { wrapAppHtml, BRIDGE_BOOTSTRAP_JS } from '../utils/apps.js';

export function buildNetworkDashboardHtml(): string {
  const styles = `
#app{display:flex;flex-direction:column;height:100vh}
#toolbar{display:flex;align-items:center;gap:6px;padding:8px;background:var(--color-surface);border-bottom:1px solid var(--color-border);flex-shrink:0;flex-wrap:wrap}
#search{flex:1;min-width:120px}
.pill{padding:3px 8px;border-radius:12px;font-size:11px;cursor:pointer;border:1px solid var(--color-border);background:transparent;color:var(--color-text-secondary)}
.pill.active{background:var(--color-accent);color:#000;border-color:var(--color-accent)}
.pill.err.active{background:var(--color-error);border-color:var(--color-error)}
#status-filters{display:flex;gap:4px}
#btn-clear,#btn-refresh,#btn-auto{font-size:11px}
#btn-auto.on{background:rgba(79,156,249,.2);border-color:var(--color-accent);color:var(--color-accent)}
#main{flex:1;display:flex;overflow:hidden}
#list-pane{flex:1;overflow-y:auto;min-width:0}
#detail-pane{width:340px;flex-shrink:0;border-left:1px solid var(--color-border);overflow-y:auto;display:none;background:var(--color-surface)}
#detail-pane.open{display:block}
#status{font-size:11px;color:var(--color-text-secondary);padding:0 4px;white-space:nowrap}
table{width:100%;border-collapse:collapse;font-size:12px}
th{position:sticky;top:0;background:var(--color-surface);color:var(--color-text-secondary);font-weight:600;text-align:left;padding:6px 8px;border-bottom:1px solid var(--color-border);cursor:pointer;user-select:none;font-size:11px;white-space:nowrap}
th:hover{color:var(--color-text-primary)}
td{padding:5px 8px;border-bottom:1px solid rgba(255,255,255,.04);vertical-align:middle;max-width:0}
tr{cursor:pointer}
tr:hover td{background:rgba(255,255,255,.04)}
tr.selected td{background:rgba(79,156,249,.1)}
tr.new td{animation:flash .5s ease-out}
@keyframes flash{from{background:rgba(79,156,249,.25)}to{background:transparent}}
.method{font-weight:700;font-size:11px;border-radius:3px;padding:1px 5px;white-space:nowrap}
.m-GET{color:#22c55e;background:rgba(34,197,94,.1)}
.m-POST{color:#4f9cf9;background:rgba(79,156,249,.1)}
.m-PUT{color:#f59e0b;background:rgba(245,158,11,.1)}
.m-DELETE{color:#ef4444;background:rgba(239,68,68,.1)}
.m-PATCH{color:#a78bfa;background:rgba(167,139,250,.1)}
.m-other{color:var(--color-text-secondary);background:rgba(255,255,255,.06)}
.url{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-text-primary);max-width:300px}
.status-ok{color:var(--color-success)}
.status-redir{color:var(--color-warn)}
.status-err{color:var(--color-error)}
.status-pend{color:var(--color-text-secondary)}
.dur,.size{color:var(--color-text-secondary);white-space:nowrap;text-align:right}
#detail-header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--color-border)}
#detail-close{background:none;border:none;color:var(--color-text-secondary);cursor:pointer;font-size:16px;padding:0}
#detail-close:hover{color:var(--color-text-primary)}
.detail-section{padding:10px 12px;border-bottom:1px solid var(--color-border)}
.detail-section h4{font-size:11px;font-weight:700;color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.kv{display:flex;gap:8px;font-size:11px;padding:2px 0;word-break:break-all}
.kv-k{color:var(--color-text-secondary);flex-shrink:0;min-width:80px;max-width:120px}
.kv-v{color:var(--color-text-primary);overflow:hidden;text-overflow:ellipsis}
.body-pre{font-family:var(--font-mono);font-size:11px;white-space:pre-wrap;word-break:break-all;color:var(--color-text-primary);max-height:300px;overflow-y:auto;background:var(--color-bg);padding:8px;border-radius:4px;margin-top:4px}
.empty{text-align:center;padding:40px 16px;color:var(--color-text-secondary);font-size:13px}
`;

  const body = `
<div id="app">
  <div id="toolbar">
    <input id="search" type="text" placeholder="Filter by URL…">
    <div style="display:flex;gap:4px">
      <button class="pill active" data-method="all">All</button>
      <button class="pill" data-method="GET">GET</button>
      <button class="pill" data-method="POST">POST</button>
      <button class="pill" data-method="PUT">PUT</button>
      <button class="pill" data-method="DELETE">DEL</button>
    </div>
    <div id="status-filters" style="display:flex;gap:4px">
      <button class="pill active" data-status="all">All</button>
      <button class="pill" data-status="2xx">2xx</button>
      <button class="pill" data-status="4xx">4xx</button>
      <button class="pill" data-status="5xx">5xx</button>
      <button class="pill err" data-status="err">Err</button>
    </div>
    <button id="btn-auto" class="on" title="Toggle auto-refresh">⟳ Auto</button>
    <button id="btn-refresh" title="Refresh now">↻</button>
    <button id="btn-clear" title="Clear requests">Clear</button>
    <span id="status">Loading…</span>
  </div>
  <div id="main">
    <div id="list-pane">
      <table>
        <thead>
          <tr>
            <th style="width:70px" data-sort="method">Method</th>
            <th data-sort="url">URL</th>
            <th style="width:55px" data-sort="status">Status</th>
            <th style="width:65px" data-sort="dur">Duration</th>
            <th style="width:65px" data-sort="size">Size</th>
          </tr>
        </thead>
        <tbody id="tbody"></tbody>
      </table>
      <div id="empty-msg" class="empty" style="display:none">No network requests captured yet.</div>
    </div>
    <div id="detail-pane">
      <div id="detail-header">
        <span id="detail-title" style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1"></span>
        <button id="detail-close">✕</button>
      </div>
      <div id="detail-body"></div>
    </div>
  </div>
</div>
<script>
${BRIDGE_BOOTSTRAP_JS}

var rows = [];
var filteredRows = [];
var activeMethod = 'all';
var activeStatus = 'all';
var searchText = '';
var autoRefresh = true;
var sortCol = null;
var sortAsc = true;
var selectedUrl = null;
var pollTimer = null;

// Parse "HH:MM:SS.mmm METHOD URL → STATUS (DURATIONms, SIZE)" format
var LINE_RE = /^(\\d{2}:\\d{2}:\\d{2}\\.\\d{3}) (\\S+) (.+?) → (.+?) \\((.+?)(?:, (.+?))?\\)$/;

function parseLine(line) {
  var m = LINE_RE.exec(line.trim());
  if (!m) return null;
  var durStr = m[5] === 'pending' ? null : parseInt(m[5]);
  var statusStr = m[4];
  var status = null;
  var isErr = false;
  if (statusStr.startsWith('ERR:')) { isErr = true; }
  else { status = parseInt(statusStr) || null; }
  return {
    ts: m[1], method: m[2], url: m[3],
    status: status, isErr: isErr, errMsg: isErr ? statusStr.slice(5) : null,
    dur: durStr, sizeStr: m[6] || null
  };
}

function statusClass(row) {
  if (row.isErr) return 'status-err';
  if (!row.status) return 'status-pend';
  if (row.status < 300) return 'status-ok';
  if (row.status < 400) return 'status-redir';
  if (row.status < 500) return 'status-err';
  return 'status-err';
}

function methodClass(m) {
  var map = {GET:'m-GET',POST:'m-POST',PUT:'m-PUT',DELETE:'m-DELETE',PATCH:'m-PATCH'};
  return map[m] || 'm-other';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function applyFilters() {
  filteredRows = rows.filter(function(r) {
    if (activeMethod !== 'all' && r.method !== activeMethod) return false;
    if (activeStatus !== 'all') {
      if (activeStatus === 'err' && !r.isErr) return false;
      if (activeStatus === '2xx' && (r.isErr || !r.status || r.status < 200 || r.status >= 300)) return false;
      if (activeStatus === '4xx' && (r.isErr || !r.status || r.status < 400 || r.status >= 500)) return false;
      if (activeStatus === '5xx' && (r.isErr || !r.status || r.status < 500)) return false;
    }
    if (searchText && r.url.toLowerCase().indexOf(searchText) === -1) return false;
    return true;
  });
}

function renderTable() {
  var tbody = document.getElementById('tbody');
  var emptyMsg = document.getElementById('empty-msg');
  applyFilters();
  if (filteredRows.length === 0) {
    tbody.innerHTML = '';
    emptyMsg.style.display = 'block';
    return;
  }
  emptyMsg.style.display = 'none';
  tbody.innerHTML = filteredRows.map(function(r) {
    var sel = selectedUrl === r.url ? 'selected' : '';
    var sc = statusClass(r);
    var statusText = r.isErr ? 'ERR' : (r.status || '…');
    var durText = r.dur !== null ? r.dur + 'ms' : '…';
    return '<tr class="' + sel + '" data-url="' + escHtml(r.url) + '">' +
      '<td><span class="method ' + methodClass(r.method) + '">' + escHtml(r.method) + '</span></td>' +
      '<td><div class="url" title="' + escHtml(r.url) + '">' + escHtml(r.url) + '</div></td>' +
      '<td class="' + sc + '">' + statusText + '</td>' +
      '<td class="dur">' + durText + '</td>' +
      '<td class="size">' + escHtml(r.sizeStr || '—') + '</td>' +
      '</tr>';
  }).join('');
  setStatus(filteredRows.length + ' of ' + rows.length + ' requests');
}

document.getElementById('tbody').addEventListener('click', function(e) {
  var tr = e.target.closest('tr');
  if (!tr) return;
  var url = tr.dataset.url;
  if (!url) return;
  selectedUrl = url;
  renderTable();
  openDetail(url);
});

function openDetail(url) {
  var detail = document.getElementById('detail-pane');
  var detailBody = document.getElementById('detail-body');
  var detailTitle = document.getElementById('detail-title');
  detailTitle.textContent = url;
  detail.classList.add('open');
  detailBody.innerHTML = '<div style="padding:12px;color:var(--color-text-secondary);font-size:12px">Loading…</div>';
  mcpBridge.call('tools/call', { name: 'get_request_details', arguments: { url: url } })
    .then(function(result) {
      var text = result && result.content && result.content[0] && result.content[0].text || '{}';
      var req;
      try { req = JSON.parse(text); } catch { req = null; }
      if (!req || typeof req !== 'object') {
        detailBody.innerHTML = '<div class="detail-section"><pre class="body-pre">' + escHtml(text) + '</pre></div>';
        return;
      }
      var html = '';
      // General info
      html += '<div class="detail-section"><h4>Request</h4>';
      html += kv('Method', req.method);
      html += kv('Status', (req.status || '—') + (req.statusText ? ' ' + req.statusText : ''));
      var dur = req.endTime && req.startTime ? (req.endTime - req.startTime) + 'ms' : 'pending';
      html += kv('Duration', dur);
      if (req.size) html += kv('Size', req.size + ' bytes');
      if (req.type) html += kv('Type', req.type);
      html += '</div>';
      // Request headers
      if (req.requestHeaders && Object.keys(req.requestHeaders).length) {
        html += '<div class="detail-section"><h4>Request Headers</h4>';
        Object.entries(req.requestHeaders).forEach(function(e) { html += kv(e[0], e[1]); });
        html += '</div>';
      }
      // Response headers
      if (req.responseHeaders && Object.keys(req.responseHeaders).length) {
        html += '<div class="detail-section"><h4>Response Headers</h4>';
        Object.entries(req.responseHeaders).forEach(function(e) { html += kv(e[0], e[1]); });
        html += '</div>';
      }
      // Request body
      if (req.requestBody) {
        html += '<div class="detail-section"><h4>Request Body</h4><pre class="body-pre">' + prettyJson(req.requestBody) + '</pre></div>';
      }
      // Response body
      if (req.responseBody) {
        html += '<div class="detail-section"><h4>Response Body</h4><pre class="body-pre">' + prettyJson(req.responseBody) + '</pre></div>';
      }
      if (req.error) {
        html += '<div class="detail-section"><h4>Error</h4><pre class="body-pre" style="color:var(--color-error)">' + escHtml(req.error) + '</pre></div>';
      }
      detailBody.innerHTML = html;
    })
    .catch(function(e) {
      detailBody.innerHTML = '<div class="detail-section" style="color:var(--color-error)">' + escHtml(e.message) + '</div>';
    });
}

function kv(k, v) {
  return '<div class="kv"><span class="kv-k">' + escHtml(k) + '</span><span class="kv-v">' + escHtml(String(v)) + '</span></div>';
}

function prettyJson(text) {
  try { return escHtml(JSON.stringify(JSON.parse(text), null, 2)); }
  catch { return escHtml(text); }
}

document.getElementById('detail-close').addEventListener('click', function() {
  document.getElementById('detail-pane').classList.remove('open');
  selectedUrl = null;
  renderTable();
});

// Toolbar interactions
document.querySelectorAll('[data-method]').forEach(function(btn) {
  btn.addEventListener('click', function() {
    activeMethod = btn.dataset.method;
    document.querySelectorAll('[data-method]').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    renderTable();
  });
});
document.querySelectorAll('[data-status]').forEach(function(btn) {
  btn.addEventListener('click', function() {
    activeStatus = btn.dataset.status;
    document.querySelectorAll('[data-status]').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    renderTable();
  });
});
document.getElementById('search').addEventListener('input', function(e) {
  searchText = e.target.value.toLowerCase();
  renderTable();
});
document.getElementById('btn-auto').addEventListener('click', function() {
  autoRefresh = !autoRefresh;
  this.classList.toggle('on', autoRefresh);
  if (autoRefresh) startPoll(); else stopPoll();
});
document.getElementById('btn-refresh').addEventListener('click', fetchRequests);
document.getElementById('btn-clear').addEventListener('click', function() {
  mcpBridge.call('tools/call', { name: 'clear_network_requests', arguments: {} })
    .then(function() { rows = []; renderTable(); setStatus('Cleared'); selectedUrl = null; document.getElementById('detail-pane').classList.remove('open'); })
    .catch(function(e) { setStatus('Error: ' + e.message); });
});

function setStatus(msg) { document.getElementById('status').textContent = msg; }

function fetchRequests() {
  mcpBridge.call('tools/call', { name: 'get_network_requests', arguments: { limit: 150 } })
    .then(function(result) {
      var text = (result && result.content && result.content[0] && result.content[0].text) || '';
      var prevCount = rows.length;
      rows = text.trim().split('\\n').filter(Boolean).map(parseLine).filter(Boolean);
      renderTable();
      setStatus(rows.length + ' requests');
    })
    .catch(function(e) { setStatus('Error: ' + e.message); });
}

mcpBridge.on('ui/notifications/tool-result', function(params) {
  if (params && params.result && params.result.content) {
    var item = params.result.content.find(function(c) { return c.type === 'text'; });
    if (item && item.text) {
      rows = item.text.trim().split('\\n').filter(Boolean).map(parseLine).filter(Boolean);
      renderTable();
      setStatus(rows.length + ' requests');
    }
  }
});

function startPoll() { if (!pollTimer) pollTimer = setInterval(fetchRequests, 2500); }
function stopPoll() { clearInterval(pollTimer); pollTimer = null; }

mcpBridge.initialize()
  .then(fetchRequests)
  .then(startPoll)
  .catch(function() { setStatus('Host not connected'); });
</script>`;

  return wrapAppHtml(body, { title: 'Network — Metro MCP', extraStyles: styles });
}
