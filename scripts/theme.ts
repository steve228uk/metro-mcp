/**
 * Shared CSS design system for all Metro MCP app sources.
 * Imported by scripts/build-apps.ts and embedded in each app's HTML.
 */
export const SHARED_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

/* ── Design tokens ── */
:root{
  --bg:#0d0d0d;
  --surface:#141414;
  --surface-2:#1e1e1e;
  --border:#2a2a2a;
  --text:#e8e8e8;
  --text-2:#888;
  --accent:#4f9cf9;
  --warn:#f59e0b;
  --error:#ef4444;
  --success:#22c55e;
  --purple:#a78bfa;
  --font:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --mono:'SF Mono','Fira Code','Cascadia Code',monospace;
  --r:5px;
}

/* Light theme — also overridden by host via host-context-changed */
@media(prefers-color-scheme:light){
  :root{
    --bg:#f5f5f7;
    --surface:#ffffff;
    --surface-2:#f0f0f2;
    --border:#e2e2e2;
    --text:#111111;
    --text-2:#666666;
    --accent:#1a73e8;
    --warn:#d97706;
    --error:#dc2626;
    --success:#16a34a;
    --purple:#7c3aed;
  }
}

/* ── Base ── */
body{
  background:var(--bg);color:var(--text);
  font-family:var(--font);font-size:13px;line-height:1.5;
  height:100vh;overflow:hidden;
}
button{
  background:var(--surface);color:var(--text);
  border:1px solid var(--border);border-radius:var(--r);
  padding:4px 10px;cursor:pointer;font-size:12px;font-family:inherit;
}
button:hover{background:var(--surface-2)}
button:active{opacity:.8}
input,select{
  background:var(--surface-2);color:var(--text);
  border:1px solid var(--border);border-radius:var(--r);
  padding:5px 8px;font-size:12px;font-family:inherit;outline:none;
}
input:focus,select:focus{border-color:var(--accent)}
a{color:var(--accent);text-decoration:none}

/* ── Layout ── */
.layout{display:flex;flex-direction:column;height:100vh}
.toolbar{
  display:flex;align-items:center;gap:6px;padding:8px;
  background:var(--surface);border-bottom:1px solid var(--border);
  flex-shrink:0;flex-wrap:wrap;
}
.toolbar-search{flex:1;min-width:120px}
.toolbar-sep{width:1px;height:16px;background:var(--border);flex-shrink:0}
.toolbar-status{font-size:11px;color:var(--text-2);margin-left:auto;white-space:nowrap}
.scrollable{flex:1;overflow-y:auto;min-height:0}
.split{display:flex;flex:1;overflow:hidden;min-height:0}
.split-main{flex:1;overflow-y:auto;min-width:0}
.split-side{
  width:320px;flex-shrink:0;border-left:1px solid var(--border);
  overflow-y:auto;background:var(--surface);display:none;flex-direction:column;
}
.split-side.open{display:flex}

/* ── Pills ── */
.pill{
  padding:3px 9px;border-radius:12px;font-size:11px;cursor:pointer;
  border:1px solid var(--border);background:transparent;color:var(--text-2);white-space:nowrap;
}
.pill:hover{border-color:var(--text-2);color:var(--text)}
.pill.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.pill.on-err{background:var(--error);color:#fff;border-color:var(--error)}
.pill-group{display:flex;gap:3px;flex-wrap:wrap}

/* ── Badge ── */
.badge{
  display:inline-block;background:currentColor;color:var(--bg);
  border-radius:9px;padding:0 5px;font-size:10px;margin-left:3px;opacity:.85;
}

/* ── Table ── */
table{width:100%;border-collapse:collapse;font-size:12px}
thead{position:sticky;top:0;z-index:1;background:var(--surface)}
th{
  color:var(--text-2);font-weight:600;text-align:left;
  padding:6px 8px;border-bottom:1px solid var(--border);
  cursor:pointer;user-select:none;white-space:nowrap;font-size:11px;
}
th:hover{color:var(--text)}
th.sorted{color:var(--accent)}
td{padding:5px 8px;border-bottom:1px solid color-mix(in srgb,var(--border) 50%,transparent);vertical-align:middle}
tr:hover td{background:color-mix(in srgb,var(--text) 4%,transparent)}
tr.selected td{background:color-mix(in srgb,var(--accent) 10%,transparent)}
.url-cell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px}

/* ── Method badges ── */
.method{font-weight:700;font-size:11px;border-radius:3px;padding:1px 5px;white-space:nowrap;font-family:var(--mono)}
.m-GET   {color:#22c55e;background:rgba(34,197,94,.1)}
.m-POST  {color:#4f9cf9;background:rgba(79,156,249,.1)}
.m-PUT   {color:#f59e0b;background:rgba(245,158,11,.1)}
.m-DELETE{color:#ef4444;background:rgba(239,68,68,.1)}
.m-PATCH {color:#a78bfa;background:rgba(167,139,250,.1)}
.m-other {color:var(--text-2);background:color-mix(in srgb,var(--text) 8%,transparent)}
.s-ok  {color:var(--success)}
.s-3xx {color:var(--warn)}
.s-err {color:var(--error)}
.s-pend{color:var(--text-2)}

/* ── Log level badges ── */
.lvl{flex-shrink:0;width:36px;text-align:center;font-size:10px;font-weight:700;border-radius:3px;padding:1px 3px}
.lvl-log  {color:var(--text-2);background:color-mix(in srgb,var(--text) 8%,transparent)}
.lvl-info {color:var(--accent);background:rgba(79,156,249,.12)}
.lvl-warn {color:var(--warn);background:rgba(245,158,11,.12)}
.lvl-error{color:var(--error);background:rgba(239,68,68,.12)}
.lvl-debug{color:var(--purple);background:rgba(167,139,250,.12)}
.row-warn {background:rgba(245,158,11,.05)}
.row-error{background:rgba(239,68,68,.07)}

/* ── Detail pane ── */
.detail-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:10px 12px;border-bottom:1px solid var(--border);flex-shrink:0;
}
.detail-title{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.detail-close{background:none;border:none;color:var(--text-2);cursor:pointer;font-size:16px;line-height:1;padding:0}
.detail-close:hover{color:var(--text);background:none}
.detail-section{padding:10px 12px;border-bottom:1px solid var(--border)}
.detail-section h4{font-size:10px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.kv{display:flex;gap:8px;font-size:11px;padding:2px 0;word-break:break-all}
.kv-k{color:var(--accent);flex-shrink:0;min-width:80px;max-width:130px}
.kv-v{color:var(--text);overflow:hidden;text-overflow:ellipsis}
.code{
  font-family:var(--mono);font-size:11px;white-space:pre-wrap;word-break:break-all;
  color:var(--text);background:var(--bg);padding:8px;border-radius:4px;
  max-height:280px;overflow-y:auto;margin-top:4px;
}

/* ── Empty state ── */
.empty{text-align:center;padding:40px 16px;color:var(--text-2);font-size:13px}
.empty p{margin-top:6px;font-size:11px}

/* ── Tree nodes ── */
.tree-row{display:flex;align-items:center;gap:5px;padding:2px 8px;border-radius:3px;cursor:pointer;white-space:nowrap}
.tree-row:hover{background:color-mix(in srgb,var(--text) 5%,transparent)}
.tree-row.selected{background:color-mix(in srgb,var(--accent) 10%,transparent)}
.tree-row.active{background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.2)}
.tree-toggle{width:14px;text-align:center;color:var(--text-2);font-size:10px;flex-shrink:0;user-select:none}
.tree-children{border-left:1px solid var(--border);margin-left:12px;padding-left:2px}

/* ── JSON tree ── */
.j-key {color:var(--accent)}
.j-str {color:#86efac}
.j-num {color:#fca5a5}
.j-bool{color:#fcd34d}
.j-null{color:var(--text-2)}

/* ── Heat bars ── */
.bar-row{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.bar-label{font-size:11px;width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;font-family:var(--mono)}
.bar-track{flex:1;background:color-mix(in srgb,var(--text) 7%,transparent);border-radius:3px;height:14px;overflow:hidden}
.bar-fill{height:100%;border-radius:3px;transition:width .3s ease;min-width:2px}
.bar-val{font-size:11px;color:var(--text-2);width:70px;text-align:right;flex-shrink:0;font-family:var(--mono)}
.bar-pct{font-size:10px;color:var(--text-2);width:40px;text-align:right;flex-shrink:0}

/* ── Scroll anchor ── */
.scroll-paused{
  display:none;position:sticky;bottom:8px;left:50%;transform:translateX(-50%);
  background:var(--accent);color:#fff;font-size:11px;padding:3px 12px;
  border-radius:12px;cursor:pointer;width:max-content;border:none;
}
.scroll-paused.show{display:block}

/* ── Route type badges ── */
.rtype{font-size:10px;font-weight:700;border-radius:3px;padding:1px 5px;flex-shrink:0}
.rt-stack {color:var(--accent);background:rgba(79,156,249,.12)}
.rt-tab   {color:var(--purple);background:rgba(167,139,250,.12)}
.rt-drawer{color:var(--warn);background:rgba(245,158,11,.12)}
.rt-screen{color:var(--text-2);background:color-mix(in srgb,var(--text) 7%,transparent)}

/* ── Mono ── */
.mono{font-family:var(--mono)}
`;
