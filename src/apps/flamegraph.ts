import { wrapAppHtml, BRIDGE_BOOTSTRAP_JS } from '../utils/apps.js';

export function buildFlamegraphHtml(): string {
  const styles = `
#app{display:flex;flex-direction:column;height:100vh}
#toolbar{display:flex;align-items:center;gap:8px;padding:8px;background:var(--color-surface);border-bottom:1px solid var(--color-border);flex-shrink:0;flex-wrap:wrap}
#search{flex:1;min-width:120px}
#btn-refresh{font-size:11px}
#status{font-size:11px;color:var(--color-text-secondary)}
#main{flex:1;overflow-y:auto;padding:12px 16px}
.section{margin-bottom:24px}
.section-title{font-size:11px;font-weight:700;color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px}
.mode-badge{display:inline-block;font-size:10px;font-weight:600;padding:1px 6px;border-radius:10px;margin-left:6px;vertical-align:middle;background:rgba(79,156,249,.15);color:var(--color-accent)}
.bar-row{display:flex;align-items:center;gap:8px;margin-bottom:5px;cursor:default}
.bar-row:hover .bar{filter:brightness(1.2)}
.bar-label{font-size:11px;color:var(--color-text-primary);width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;font-family:var(--font-mono)}
.bar-track{flex:1;background:rgba(255,255,255,.06);border-radius:3px;height:14px;overflow:hidden;position:relative}
.bar{height:100%;border-radius:3px;transition:width .3s ease;min-width:2px}
.bar-val{font-size:11px;color:var(--color-text-secondary);width:70px;text-align:right;flex-shrink:0;font-family:var(--font-mono)}
.bar-pct{font-size:10px;color:var(--color-text-secondary);width:40px;text-align:right;flex-shrink:0}
table{width:100%;border-collapse:collapse;font-size:11px}
th{color:var(--color-text-secondary);font-weight:600;text-align:left;padding:5px 8px;border-bottom:1px solid var(--color-border);cursor:pointer;user-select:none;white-space:nowrap}
th:hover{color:var(--color-text-primary)}
td{padding:4px 8px;border-bottom:1px solid rgba(255,255,255,.04);font-family:var(--font-mono);vertical-align:middle}
.empty{color:var(--color-text-secondary);font-size:13px;padding:32px 0;text-align:center}
.tip{color:var(--color-text-secondary);font-size:11px;margin-top:4px}
`;

  const body = `
<div id="app">
  <div id="toolbar">
    <input id="search" type="text" placeholder="Filter by component…">
    <button id="btn-refresh" title="Refresh data">↻ Refresh</button>
    <span id="status">Loading…</span>
  </div>
  <div id="main">
    <div id="content"><div class="empty">Loading profiler data…</div></div>
  </div>
</div>
<script>
${BRIDGE_BOOTSTRAP_JS}

var profileData = null;
var searchText = '';
var sortCol = 'totalMs';
var sortAsc = false;

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// Map 0-100% → green→yellow→red HSL
function heatColor(pct) {
  var h = Math.round(120 - pct * 1.2);
  return 'hsl(' + Math.max(0,h) + ',70%,45%)';
}

function renderDevToolsSection(profile) {
  if (!profile || !profile.length) return '';
  var totalDuration = profile.reduce(function(s,c) { return s + c.duration; }, 0);
  var byName = {};
  profile.forEach(function(commit) {
    commit.components.forEach(function(c) {
      if (!byName[c.name]) byName[c.name] = { name: c.name, totalActual: 0, totalSelf: 0, commits: 0 };
      byName[c.name].totalActual += c.actualMs;
      byName[c.name].totalSelf += c.selfMs;
      byName[c.name].commits++;
    });
  });
  var comps = Object.values(byName).sort(function(a,b) { return b.totalActual - a.totalActual; });
  if (searchText) comps = comps.filter(function(c) { return c.name.toLowerCase().indexOf(searchText) !== -1; });
  var maxTotal = comps[0] ? comps[0].totalActual : 1;
  var bars = comps.slice(0, 60).map(function(c) {
    var pct = Math.round(c.totalActual / totalDuration * 100);
    var barW = Math.round(c.totalActual / maxTotal * 100);
    return '<div class="bar-row">' +
      '<span class="bar-label" title="' + escHtml(c.name) + '">' + escHtml(c.name) + '</span>' +
      '<div class="bar-track"><div class="bar" style="width:' + barW + '%;background:' + heatColor(pct) + '"></div></div>' +
      '<span class="bar-val">' + c.totalActual.toFixed(1) + 'ms</span>' +
      '<span class="bar-pct">' + pct + '%</span>' +
      '</div>';
  }).join('');
  return '<div class="section">' +
    '<div class="section-title">React Component Profile <span class="mode-badge">DevTools Hook</span></div>' +
    '<div class="tip" style="margin-bottom:8px">' + profile.length + ' commit' + (profile.length !== 1 ? 's' : '') + ' · ' + totalDuration.toFixed(1) + 'ms total · showing top ' + Math.min(comps.length, 60) + ' components</div>' +
    bars +
    '</div>';
}

function renderCpuSection(cpu) {
  if (!cpu || !cpu.analysis) return '';
  var funcs = cpu.analysis.topFunctions || [];
  if (searchText) funcs = funcs.filter(function(f) { return f.functionName.toLowerCase().indexOf(searchText) !== -1; });
  funcs = funcs.slice().sort(function(a,b) {
    var v = sortAsc ? 1 : -1;
    return (a[sortCol] > b[sortCol] ? 1 : -1) * v;
  });
  var maxSelf = Math.max.apply(null, funcs.map(function(f) { return f.selfMs; })) || 1;
  var bars = funcs.slice(0, 60).map(function(f) {
    var barW = Math.round(f.selfMs / maxSelf * 100);
    return '<div class="bar-row">' +
      '<span class="bar-label" title="' + escHtml(f.functionName) + '">' + escHtml(f.functionName || '(anonymous)') + '</span>' +
      '<div class="bar-track"><div class="bar" style="width:' + barW + '%;background:' + heatColor(f.selfPercent) + '"></div></div>' +
      '<span class="bar-val">' + f.selfMs.toFixed(1) + 'ms</span>' +
      '<span class="bar-pct">' + f.selfPercent.toFixed(1) + '%</span>' +
      '</div>';
  }).join('');
  var tableRows = funcs.slice(0, 60).map(function(f) {
    var loc = f.url ? f.url.split('/').slice(-2).join('/') + ':' + f.lineNumber : '(native)';
    return '<tr>' +
      '<td>' + escHtml(f.functionName || '(anonymous)') + '</td>' +
      '<td style="text-align:right">' + f.selfMs.toFixed(2) + '</td>' +
      '<td style="text-align:right">' + f.selfPercent.toFixed(1) + '</td>' +
      '<td style="text-align:right">' + f.totalMs.toFixed(2) + '</td>' +
      '<td style="text-align:right">' + f.totalPercent.toFixed(1) + '</td>' +
      '<td style="color:var(--color-text-secondary)">' + escHtml(loc) + '</td>' +
      '</tr>';
  }).join('');
  return '<div class="section">' +
    '<div class="section-title">CPU Flamegraph <span class="mode-badge">CDP Profiler</span></div>' +
    '<div class="tip" style="margin-bottom:8px">' + cpu.durationMs.toFixed(0) + 'ms · ' + cpu.sampleCount + ' samples · showing by self time</div>' +
    bars +
    '<div style="margin-top:16px"><table>' +
    '<thead><tr>' +
    '<th>Function</th>' +
    '<th style="text-align:right" data-col="selfMs">Self (ms)</th>' +
    '<th style="text-align:right" data-col="selfPercent">Self %</th>' +
    '<th style="text-align:right" data-col="totalMs">Total (ms)</th>' +
    '<th style="text-align:right" data-col="totalPercent">Total %</th>' +
    '<th>Location</th>' +
    '</tr></thead>' +
    '<tbody>' + tableRows + '</tbody>' +
    '</table></div>' +
    '</div>';
}

function renderRendersSection(renders) {
  if (!renders || !renders.length) return '';
  var sorted = renders.slice().sort(function(a,b) { return b.actualDuration - a.actualDuration; });
  var maxActual = sorted[0].actualDuration || 1;
  var filtered = searchText ? sorted.filter(function(r) { return r.id.toLowerCase().indexOf(searchText) !== -1; }) : sorted;
  var bars = filtered.slice(0,40).map(function(r) {
    var pct = Math.round(r.actualDuration / maxActual * 100);
    return '<div class="bar-row">' +
      '<span class="bar-label" title="' + escHtml(r.id) + '">' + escHtml(r.id) + '</span>' +
      '<div class="bar-track"><div class="bar" style="width:' + pct + '%;background:' + heatColor(pct) + '"></div></div>' +
      '<span class="bar-val">' + r.actualDuration.toFixed(1) + 'ms</span>' +
      '<span class="bar-pct" style="color:' + (r.memoSavingsPercent != null ? 'var(--color-success)' : 'var(--color-text-secondary)') + '">' +
        (r.memoSavingsPercent != null ? r.memoSavingsPercent.toFixed(0) + '% saved' : r.phase) +
      '</span></div>';
  }).join('');
  return '<div class="section">' +
    '<div class="section-title">React Renders — &lt;Profiler&gt; data</div>' +
    bars +
    '</div>';
}

function render() {
  var content = document.getElementById('content');
  if (!profileData) { content.innerHTML = '<div class="empty">No profile data. Call start_profiling, interact with the app, then stop_profiling.</div>'; return; }
  var html = '';
  if (profileData.mode === 'devtools-hook' && profileData.devtools) {
    html += renderDevToolsSection(profileData.devtools);
  } else if (profileData.mode === 'cdp' && profileData.cpu) {
    html += renderCpuSection(profileData.cpu);
  } else {
    html += '<div class="empty">No profile data. Call start_profiling, interact with the app, then stop_profiling.</div>';
  }
  if (profileData.renders && profileData.renders.length) {
    html += renderRendersSection(profileData.renders);
  }
  content.innerHTML = html;
}

document.getElementById('search').addEventListener('input', function(e) {
  searchText = e.target.value.toLowerCase();
  render();
});

document.getElementById('content').addEventListener('click', function(e) {
  var th = e.target.closest('th[data-col]');
  if (!th) return;
  var col = th.dataset.col;
  if (sortCol === col) sortAsc = !sortAsc; else { sortCol = col; sortAsc = false; }
  render();
});

document.getElementById('btn-refresh').addEventListener('click', fetchData);

function setStatus(msg) { document.getElementById('status').textContent = msg; }

function fetchData() {
  setStatus('Loading…');
  mcpBridge.call('resources/read', { uri: 'metro://profiler/data' })
    .then(function(result) {
      var text = result && result.contents && result.contents[0] && result.contents[0].text;
      if (!text) { setStatus('No data'); render(); return; }
      try {
        profileData = JSON.parse(text);
        var mode = profileData.mode === 'devtools-hook' ? 'DevTools Hook' : profileData.mode === 'cdp' ? 'CDP Profiler' : 'No profile';
        var renders = profileData.renders ? profileData.renders.length : 0;
        setStatus(mode + (renders ? ' · ' + renders + ' renders' : ''));
      } catch(e) { setStatus('Parse error'); }
      render();
    })
    .catch(function(e) {
      // Fallback: call get_flamegraph tool and show text
      mcpBridge.call('tools/call', { name: 'get_flamegraph', arguments: {} })
        .then(function(r) {
          var text = r && r.content && r.content[0] && r.content[0].text || '';
          document.getElementById('content').innerHTML = '<pre style="font-family:var(--font-mono);font-size:11px;white-space:pre-wrap;color:var(--color-text-primary)">' + escHtml(text) + '</pre>';
          setStatus('Text mode (resources/read unavailable)');
        })
        .catch(function() { setStatus('Error: ' + e.message); });
    });
}

mcpBridge.on('ui/notifications/tool-result', function(params) {
  // Re-fetch data when stop_profiling result arrives
  if (params && params.toolName && params.toolName.indexOf('profil') !== -1) {
    setTimeout(fetchData, 200);
  }
});

mcpBridge.initialize().then(fetchData).catch(function() { setStatus('Host not connected'); });
</script>`;

  return wrapAppHtml(body, { title: 'Flamegraph — Metro MCP', extraStyles: styles });
}
