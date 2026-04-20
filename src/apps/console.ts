import { wrapAppHtml, BRIDGE_BOOTSTRAP_JS } from '../utils/apps.js';

export function buildConsoleHtml(): string {
  const styles = `
#app{display:flex;flex-direction:column;height:100vh}
#toolbar{display:flex;align-items:center;gap:8px;padding:8px;background:var(--color-surface);border-bottom:1px solid var(--color-border);flex-shrink:0;flex-wrap:wrap}
#search{flex:1;min-width:120px}
.level-btn{padding:3px 8px;border-radius:12px;font-size:11px;cursor:pointer;border:1px solid transparent;transition:all .15s}
.level-btn.active{border-color:currentColor}
.level-btn[data-level="all"]{color:var(--color-text-primary)}
.level-btn[data-level="log"]{color:var(--color-text-secondary)}
.level-btn[data-level="info"]{color:var(--color-accent)}
.level-btn[data-level="warn"]{color:var(--color-warn)}
.level-btn[data-level="error"]{color:var(--color-error)}
.level-btn[data-level="debug"]{color:#a78bfa}
.badge{background:currentColor;color:var(--color-bg);border-radius:9px;padding:0 5px;font-size:10px;margin-left:3px;opacity:.9}
#log-list{flex:1;overflow-y:auto;font-family:var(--font-mono);font-size:12px;padding:4px 0}
.log-row{display:flex;gap:8px;padding:3px 10px;cursor:default;align-items:flex-start}
.log-row:hover{background:rgba(255,255,255,.04)}
.log-row.warn{background:rgba(245,158,11,.07)}
.log-row.error{background:rgba(239,68,68,.08)}
.ts{color:var(--color-text-secondary);flex-shrink:0;user-select:none;font-size:11px;margin-top:1px}
.lvl{flex-shrink:0;width:38px;text-align:center;font-size:10px;font-weight:600;border-radius:3px;padding:1px 3px}
.lvl.log{color:var(--color-text-secondary);background:rgba(255,255,255,.05)}
.lvl.info{color:var(--color-accent);background:rgba(79,156,249,.12)}
.lvl.warn{color:var(--color-warn);background:rgba(245,158,11,.12)}
.lvl.error{color:var(--color-error);background:rgba(239,68,68,.12)}
.lvl.debug{color:#a78bfa;background:rgba(167,139,250,.12)}
.msg{flex:1;white-space:pre-wrap;word-break:break-all;line-height:1.45}
.stack-toggle{font-size:10px;color:var(--color-text-secondary);cursor:pointer;margin-left:4px}
.stack-toggle:hover{color:var(--color-accent)}
.stack-body{display:none;color:var(--color-text-secondary);font-size:11px;padding:3px 0 3px 54px;white-space:pre}
.stack-body.open{display:block}
#status{font-size:11px;color:var(--color-text-secondary);padding:0 6px;white-space:nowrap}
#scroll-paused{display:none;background:var(--color-accent);color:#000;font-size:11px;padding:2px 8px;border-radius:0 0 4px 4px;position:absolute;top:0;left:50%;transform:translateX(-50%);cursor:pointer}
#log-list.paused + #scroll-paused,#scroll-paused.show{display:block}
`;

  const body = `
<div id="app">
  <div id="toolbar">
    <input id="search" type="text" placeholder="Search logs…">
    <div id="level-filters" style="display:flex;gap:4px;flex-wrap:wrap">
      <button class="level-btn active" data-level="all">ALL <span class="badge" id="cnt-all">0</span></button>
      <button class="level-btn" data-level="log">LOG <span class="badge" id="cnt-log">0</span></button>
      <button class="level-btn" data-level="info">INFO <span class="badge" id="cnt-info">0</span></button>
      <button class="level-btn" data-level="warn">WARN <span class="badge" id="cnt-warn">0</span></button>
      <button class="level-btn" data-level="error">ERR <span class="badge" id="cnt-error">0</span></button>
      <button class="level-btn" data-level="debug">DBG <span class="badge" id="cnt-debug">0</span></button>
    </div>
    <button id="btn-clear" title="Clear logs">Clear</button>
    <button id="btn-refresh" title="Refresh now">↻</button>
    <span id="status">Loading…</span>
  </div>
  <div id="scroll-anchor-wrap" style="position:relative;flex:1;display:flex;flex-direction:column;overflow:hidden">
    <div id="scroll-paused">▲ Scroll paused — click to resume</div>
    <div id="log-list"></div>
  </div>
</div>
<script>
${BRIDGE_BOOTSTRAP_JS}

var allLogs = [];
var activeLevel = 'all';
var searchText = '';
var autoScroll = true;
var pollTimer = null;

var logList = document.getElementById('log-list');
var statusEl = document.getElementById('status');
var scrollPaused = document.getElementById('scroll-paused');

// Level → log line regex: "HH:MM:SS.mmm [level] message"
var LINE_RE = /^(\\d{2}:\\d{2}:\\d{2}\\.\\d{3}) \\[(\\w+)\\] ([\\s\\S]*)$/;

function parseLogs(text) {
  if (!text || !text.trim()) return [];
  return text.split('\\n').filter(Boolean).map(function(line) {
    var m = LINE_RE.exec(line);
    if (m) return { ts: m[1], level: m[2], msg: m[3] };
    return { ts: '', level: 'log', msg: line };
  });
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function levelAlias(l) {
  var map = { warn: 'warn', warning: 'warn', error: 'error', info: 'info', debug: 'debug', verbose: 'debug' };
  return map[l] || 'log';
}

function updateCounts() {
  var counts = { all: allLogs.length, log: 0, info: 0, warn: 0, error: 0, debug: 0 };
  allLogs.forEach(function(l) {
    var k = levelAlias(l.level);
    if (counts[k] !== undefined) counts[k]++;
  });
  Object.keys(counts).forEach(function(k) {
    var el = document.getElementById('cnt-' + k);
    if (el) el.textContent = counts[k];
  });
}

function renderLogs() {
  var visible = allLogs.filter(function(l) {
    if (activeLevel !== 'all' && levelAlias(l.level) !== activeLevel) return false;
    if (searchText && l.msg.toLowerCase().indexOf(searchText) === -1) return false;
    return true;
  });

  var html = visible.map(function(l, i) {
    var lv = levelAlias(l.level);
    var msgHtml = escHtml(l.msg);
    var stackHtml = '';
    // Detect stack trace lines appended after the message (lines starting with spaces or "at ")
    return '<div class="log-row ' + lv + '" data-i="' + i + '">' +
      '<span class="ts">' + escHtml(l.ts) + '</span>' +
      '<span class="lvl ' + lv + '">' + lv.toUpperCase().slice(0,3) + '</span>' +
      '<span class="msg">' + msgHtml + '</span>' +
      stackHtml +
      '</div>';
  }).join('');

  logList.innerHTML = html;

  if (autoScroll) {
    logList.scrollTop = logList.scrollHeight;
  }
}

logList.addEventListener('scroll', function() {
  var atBottom = logList.scrollHeight - logList.scrollTop - logList.clientHeight < 40;
  if (atBottom) {
    autoScroll = true;
    scrollPaused.classList.remove('show');
  } else {
    autoScroll = false;
    scrollPaused.classList.add('show');
  }
});

scrollPaused.addEventListener('click', function() {
  autoScroll = true;
  scrollPaused.classList.remove('show');
  logList.scrollTop = logList.scrollHeight;
});

document.getElementById('search').addEventListener('input', function(e) {
  searchText = e.target.value.toLowerCase();
  renderLogs();
});

document.getElementById('level-filters').addEventListener('click', function(e) {
  var btn = e.target.closest('.level-btn');
  if (!btn) return;
  activeLevel = btn.dataset.level;
  document.querySelectorAll('.level-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  renderLogs();
});

document.getElementById('btn-clear').addEventListener('click', function() {
  mcpBridge.call('tools/call', { name: 'clear_console_logs', arguments: {} })
    .then(function() { allLogs = []; updateCounts(); renderLogs(); setStatus('Cleared'); })
    .catch(function(e) { setStatus('Error: ' + e.message); });
});

document.getElementById('btn-refresh').addEventListener('click', fetchLogs);

function setStatus(msg) {
  statusEl.textContent = msg;
}

function fetchLogs() {
  mcpBridge.call('tools/call', { name: 'get_console_logs', arguments: { limit: 200 } })
    .then(function(result) {
      var text = '';
      if (result && result.content) {
        var item = result.content.find(function(c) { return c.type === 'text'; });
        if (item) text = item.text || '';
      }
      allLogs = parseLogs(text);
      updateCounts();
      renderLogs();
      setStatus(allLogs.length + ' entries');
    })
    .catch(function(e) { setStatus('Error: ' + e.message); });
}

// Also listen for tool-result notifications from the host
mcpBridge.on('ui/notifications/tool-result', function(params) {
  if (params && params.result && params.result.content) {
    var item = params.result.content.find(function(c) { return c.type === 'text'; });
    if (item && item.text) {
      allLogs = parseLogs(item.text);
      updateCounts();
      renderLogs();
      setStatus(allLogs.length + ' entries');
    }
  }
});

mcpBridge.initialize()
  .then(fetchLogs)
  .catch(function() { setStatus('Host not connected'); });

// Poll every 3s
pollTimer = setInterval(fetchLogs, 3000);
</script>`;

  return wrapAppHtml(body, { title: 'Console Logs — Metro MCP', extraStyles: styles });
}
