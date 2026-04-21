/** @jsxImportSource preact */
import { render } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { initialize, callTool, getToolText, onNotification } from '../shared/bridge';
import { usePolling } from '../shared/usePolling';
import { useKeyboard } from '../shared/useKeyboard';

interface NetworkRequest {
  id: string;
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  startTime: number;
  endTime?: number;
  error?: string;
  size?: number;
}

const METHODS = ['ALL', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
const STATUS_FILTERS = ['ALL', '2xx', '3xx', '4xx', '5xx', 'ERR'] as const;

function statusClass(req: NetworkRequest): string {
  if (req.error) return 's-err';
  if (!req.status) return 's-pend';
  if (req.status < 300) return 's-ok';
  if (req.status < 400) return 's-3xx';
  return 's-err';
}

function methodClass(m: string): string {
  const classes: Record<string, string> = { GET: 'm-GET', POST: 'm-POST', PUT: 'm-PUT', DELETE: 'm-DELETE', PATCH: 'm-PATCH' };
  return classes[m.toUpperCase()] ?? 'm-other';
}

function fmtDur(req: NetworkRequest): string {
  if (!req.endTime) return '—';
  const ms = req.endTime - req.startTime;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function fmtSize(bytes?: number): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

function matchesStatusFilter(req: NetworkRequest, f: string): boolean {
  if (f === 'ALL') return true;
  if (f === 'ERR') return !!req.error;
  if (!req.status) return false;
  if (f === '2xx') return req.status >= 200 && req.status < 300;
  if (f === '3xx') return req.status >= 300 && req.status < 400;
  if (f === '4xx') return req.status >= 400 && req.status < 500;
  if (f === '5xx') return req.status >= 500;
  return true;
}

function App() {
  const [requests, setRequests] = useState<NetworkRequest[]>([]);
  const [method, setMethod] = useState('ALL');
  const [statusF, setStatusF] = useState('ALL');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<NetworkRequest | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(true);
  const [sortCol, setSortCol] = useState<'time' | 'method' | 'status' | 'dur' | 'size'>('time');
  const [sortAsc, setSortAsc] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const fetchRequests = useCallback(async () => {
    try {
      const result = await callTool('get_network_requests', { format: 'json', limit: 200 });
      const data = JSON.parse(getToolText(result)) as NetworkRequest[];
      setRequests(Array.isArray(data) ? data : []);
    } catch {
      // keep existing
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    initialize().then(fetchRequests).catch(() => setLoading(false));
    onNotification('ui/notifications/tool-result', (params) => {
      const text = ((params as Record<string, unknown>)?.result as Record<string, unknown>)?.content?.[0]?.text as string | undefined;
      if (!text) return;
      try { const d = JSON.parse(text); if (Array.isArray(d)) setRequests(d); } catch {}
    });
  }, []);

  usePolling(fetchRequests, 2500, autoRefresh);

  useKeyboard({
    '/': () => searchRef.current?.focus(),
    Escape: () => { if (selected) setSelected(null); else { setSearch(''); searchRef.current?.blur(); } },
    ArrowUp: () => {
      if (!selected) return;
      const idx = visible.indexOf(selected);
      if (idx > 0) setSelected(visible[idx - 1]);
    },
    ArrowDown: () => {
      if (!selected) return;
      const idx = visible.indexOf(selected);
      if (idx < visible.length - 1) setSelected(visible[idx + 1]);
    },
  });

  const visible = requests
    .filter(r =>
      (method === 'ALL' || r.method.toUpperCase() === method) &&
      matchesStatusFilter(r, statusF) &&
      (!search || r.url.toLowerCase().includes(search.toLowerCase()))
    )
    .sort((a, b) => {
      let cmp = 0;
      if (sortCol === 'time') cmp = a.startTime - b.startTime;
      else if (sortCol === 'method') cmp = a.method.localeCompare(b.method);
      else if (sortCol === 'status') cmp = (a.status ?? 0) - (b.status ?? 0);
      else if (sortCol === 'dur') cmp = ((a.endTime ?? a.startTime) - a.startTime) - ((b.endTime ?? b.startTime) - b.startTime);
      else if (sortCol === 'size') cmp = (a.size ?? 0) - (b.size ?? 0);
      return sortAsc ? cmp : -cmp;
    });

  const onSort = (col: typeof sortCol) => {
    if (sortCol === col) setSortAsc(v => !v);
    else { setSortCol(col); setSortAsc(false); }
  };

  const clearAll = () => callTool('clear_network_requests', {}).then(() => { setRequests([]); setSelected(null); });

  return (
    <div class="layout">
      <div class="toolbar">
        <div class="pill-group">
          {METHODS.map(m => (
            <button key={m} class={`pill${method === m ? ' on' : ''}`} onClick={() => setMethod(m)}>{m}</button>
          ))}
        </div>
        <div class="toolbar-sep" />
        <div class="pill-group">
          {STATUS_FILTERS.map(f => (
            <button key={f} class={`pill${statusF === f ? f === 'ERR' ? ' on on-err' : ' on' : ''}`} onClick={() => setStatusF(f)}>{f}</button>
          ))}
        </div>
        <div class="toolbar-sep" />
        <input ref={searchRef} class="toolbar-search" placeholder="Filter URL… (/)" value={search}
          onInput={e => setSearch((e.target as HTMLInputElement).value)} />
        <span class="toolbar-status">{visible.length} requests</span>
        <button class={autoRefresh ? 'pill on' : 'pill'} onClick={() => setAutoRefresh(v => !v)}>Auto</button>
        <button onClick={fetchRequests}>↻</button>
        <button onClick={clearAll}>Clear</button>
      </div>
      <div class="split">
        <div class="split-main">
          {loading && <div class="empty">Loading…</div>}
          {!loading && visible.length === 0 && (
            <div class="empty">No requests{search || method !== 'ALL' || statusF !== 'ALL' ? ' matching filter' : ''}.
              <p>Network requests appear here when your app makes them.</p>
            </div>
          )}
          {visible.length > 0 && (
            <table>
              <thead>
                <tr>
                  <Th label="Method" col="method" sort={sortCol} asc={sortAsc} onSort={onSort} />
                  <Th label="URL" col={null} sort={sortCol} asc={sortAsc} onSort={onSort} />
                  <Th label="Status" col="status" sort={sortCol} asc={sortAsc} onSort={onSort} />
                  <Th label="Duration" col="dur" sort={sortCol} asc={sortAsc} onSort={onSort} />
                  <Th label="Size" col="size" sort={sortCol} asc={sortAsc} onSort={onSort} />
                </tr>
              </thead>
              <tbody>
                {visible.map(req => (
                  <tr
                    key={req.id}
                    class={selected?.id === req.id ? 'selected' : ''}
                    onClick={() => setSelected(req)}
                  >
                    <td><span class={`method ${methodClass(req.method)}`}>{req.method}</span></td>
                    <td class="url-cell" title={req.url}>{req.url}</td>
                    <td><span class={statusClass(req)}>{req.error ? 'ERR' : req.status ?? '…'}</span></td>
                    <td style="color:var(--text-2);text-align:right;white-space:nowrap">{fmtDur(req)}</td>
                    <td style="color:var(--text-2);text-align:right;white-space:nowrap">{fmtSize(req.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {selected && (
          <div class="split-side open">
            <div class="detail-header">
              <span class="detail-title" title={selected.url}>{selected.url}</span>
              <button class="detail-close" onClick={() => setSelected(null)}>✕</button>
            </div>
            <div class="detail-section">
              <h4>Request</h4>
              <div class="kv"><span class="kv-k">Method</span><span class="kv-v"><span class={`method ${methodClass(selected.method)}`}>{selected.method}</span></span></div>
              <div class="kv"><span class="kv-k">Status</span><span class={`kv-v ${statusClass(selected)}`}>{selected.error ? `ERR: ${selected.error}` : selected.status ?? 'pending'}</span></div>
              <div class="kv"><span class="kv-k">Duration</span><span class="kv-v">{fmtDur(selected)}</span></div>
              <div class="kv"><span class="kv-k">Size</span><span class="kv-v">{fmtSize(selected.size)}</span></div>
            </div>
            {selected.requestHeaders && Object.keys(selected.requestHeaders).length > 0 && (
              <div class="detail-section">
                <h4>Request Headers</h4>
                {Object.entries(selected.requestHeaders).map(([k, v]) => (
                  <div key={k} class="kv"><span class="kv-k">{k}</span><span class="kv-v">{v}</span></div>
                ))}
              </div>
            )}
            {selected.responseHeaders && Object.keys(selected.responseHeaders).length > 0 && (
              <div class="detail-section">
                <h4>Response Headers</h4>
                {Object.entries(selected.responseHeaders).map(([k, v]) => (
                  <div key={k} class="kv"><span class="kv-k">{k}</span><span class="kv-v">{v}</span></div>
                ))}
              </div>
            )}
            {selected.responseBody !== undefined && (
              <div class="detail-section">
                <h4>Response Body</h4>
                <div class="code">{fmtBody(selected.responseBody)}</div>
              </div>
            )}
            {selected.requestBody !== undefined && (
              <div class="detail-section">
                <h4>Request Body</h4>
                <div class="code">{fmtBody(selected.requestBody)}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Th({ label, col, sort, asc, onSort }: { label: string; col: string | null; sort: string; asc: boolean; onSort: (c: string) => void }) {
  if (!col) return <th>{label}</th>;
  return (
    <th class={sort === col ? 'sorted' : ''} onClick={() => onSort(col)}>
      {label}{sort === col ? (asc ? ' ↑' : ' ↓') : ''}
    </th>
  );
}

function fmtBody(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

render(<App />, document.getElementById('app')!);
