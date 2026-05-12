/** @jsxImportSource preact */
import { render } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { initialize, readResource, getResourceText } from '../shared/bridge';
import { useKeyboard } from '../shared/useKeyboard';

interface CommitComponent {
  name: string;
  actualMs: number;
  selfMs: number;
}

interface CommitData {
  timestamp: number;
  duration: number;
  components: CommitComponent[];
}

interface FunctionStat {
  functionName: string;
  location?: string;
  selfMs?: number;
  selfPercent?: number;
  totalMs?: number;
  totalPercent?: number;
}

interface RenderRecord {
  id: string;
  phase: string;
  actualDuration: number;
  baseDuration: number;
  memoSavingsPercent?: number | null;
}

interface ProfileData {
  mode: 'devtools-hook' | 'cdp' | null;
  devtools: CommitData[] | null;
  cpu: { durationMs: number; sampleCount: number; analysis: { topFunctions: FunctionStat[] } } | null;
  renders: RenderRecord[];
}

interface ComponentStat {
  name: string;
  totalActualMs: number;
  avgActualMs: number;
  avgSelfMs: number;
  commits: number;
}

function heatColor(pct: number): string {
  // green (0%) → yellow (50%) → red (100%)
  const r = Math.round(Math.min(255, pct * 5.1));
  const g = Math.round(Math.max(0, 255 - pct * 3.8));
  return `rgb(${r},${g},40)`;
}

function App() {
  const [data, setData] = useState<ProfileData | null>(null);
  const [filter, setFilter] = useState('');
  const [tab, setTab] = useState<'components' | 'cpu' | 'renders'>('components');
  const [sortCol, setSortCol] = useState<'totalActualMs' | 'avgActualMs' | 'avgSelfMs' | 'commits'>('totalActualMs');
  const [sortAsc, setSortAsc] = useState(false);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);

  const fetchData = useCallback(async () => {
    try {
      const result = await readResource('metro://profiler/data');
      const text = getResourceText(result);
      const parsed: ProfileData = JSON.parse(text);
      setData(parsed);
      setMsg('');
    } catch {
      setMsg('No profile data available. Use start_profiling → interact → stop_profiling.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { initialize().then(fetchData).catch(() => setLoading(false)); }, []);

  useKeyboard({ '/': () => filterRef.current?.focus(), Escape: () => { setFilter(''); filterRef.current?.blur(); } });

  const componentStats = (): ComponentStat[] => {
    if (!data?.devtools) return [];
    const map = new Map<string, { totalActual: number; totalSelf: number; commits: number }>();
    for (const commit of data.devtools) {
      for (const c of commit.components) {
        const e = map.get(c.name) ?? { totalActual: 0, totalSelf: 0, commits: 0 };
        e.totalActual += c.actualMs;
        e.totalSelf += c.selfMs;
        e.commits++;
        map.set(c.name, e);
      }
    }
    return [...map.entries()]
      .map(([name, s]) => ({
        name,
        totalActualMs: parseFloat(s.totalActual.toFixed(2)),
        avgActualMs: parseFloat((s.totalActual / s.commits).toFixed(2)),
        avgSelfMs: parseFloat((s.totalSelf / s.commits).toFixed(2)),
        commits: s.commits,
      }))
      .filter(s => !filter || s.name.toLowerCase().includes(filter.toLowerCase()))
      .sort((a, b) => {
        const cmp = a[sortCol] - b[sortCol];
        return sortAsc ? cmp : -cmp;
      });
  };

  const stats = componentStats();
  const maxMs = stats[0]?.totalActualMs ?? 1;

  const cpuFuncs = (data?.cpu?.analysis.topFunctions ?? [])
    .filter(f => !filter || f.functionName.toLowerCase().includes(filter.toLowerCase()));

  const renders = (data?.renders ?? [])
    .filter(r => !filter || r.id.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => b.actualDuration - a.actualDuration);

  const onSort = (col: typeof sortCol) => {
    if (sortCol === col) setSortAsc(v => !v);
    else { setSortCol(col); setSortAsc(false); }
  };

  const commitCount = data?.devtools?.length ?? 0;
  const totalMs = data?.devtools?.reduce((s, c) => s + c.duration, 0).toFixed(1) ?? '0';

  return (
    <div class="layout">
      <div class="toolbar">
        <div class="pill-group">
          {data?.devtools && <button class={`pill${tab === 'components' ? ' on' : ''}`} onClick={() => setTab('components')}>Components{commitCount > 0 && <span class="badge">{commitCount}</span>}</button>}
          {data?.cpu && <button class={`pill${tab === 'cpu' ? ' on' : ''}`} onClick={() => setTab('cpu')}>CPU</button>}
          {data?.renders && data.renders.length > 0 && <button class={`pill${tab === 'renders' ? ' on' : ''}`} onClick={() => setTab('renders')}>Renders<span class="badge">{data.renders.length}</span></button>}
        </div>
        <div class="toolbar-sep" />
        <input ref={filterRef} class="toolbar-search" placeholder="Filter… (/)" value={filter}
          onInput={e => setFilter((e.target as HTMLInputElement).value)} />
        {data?.devtools && tab === 'components' && (
          <span class="toolbar-status">{totalMs}ms total · {stats.length} components</span>
        )}
        <button onClick={fetchData}>↻</button>
      </div>
      <div class="scrollable">
        {loading && <div class="empty">Loading…</div>}
        {!loading && msg && <div class="empty">{msg}<p>Run start_profiling, interact with your app, then stop_profiling.</p></div>}

        {!loading && !msg && tab === 'components' && stats.length > 0 && (
          <div style="padding:8px">
            {stats.map(s => {
              const pct = maxMs > 0 ? (s.totalActualMs / maxMs) * 100 : 0;
              return (
                <div key={s.name} class="bar-row" title={`${s.name}: ${s.totalActualMs}ms total, ${s.commits} commits`}>
                  <div class="bar-label mono">{s.name}</div>
                  <div class="bar-track">
                    <div class="bar-fill" style={`width:${pct}%;background:${heatColor(pct)}`} />
                  </div>
                  <div class="bar-val">{s.totalActualMs}ms</div>
                  <div class="bar-pct">{s.commits}×</div>
                </div>
              );
            })}
            <table style="margin-top:16px">
              <thead>
                <tr>
                  <th>Component</th>
                  <Th label="Total ms" col="totalActualMs" sort={sortCol} asc={sortAsc} onSort={onSort} />
                  <Th label="Avg ms" col="avgActualMs" sort={sortCol} asc={sortAsc} onSort={onSort} />
                  <Th label="Avg self" col="avgSelfMs" sort={sortCol} asc={sortAsc} onSort={onSort} />
                  <Th label="Commits" col="commits" sort={sortCol} asc={sortAsc} onSort={onSort} />
                </tr>
              </thead>
              <tbody>
                {stats.map(s => (
                  <tr key={s.name}>
                    <td class="mono" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{s.name}</td>
                    <td style="text-align:right">{s.totalActualMs}</td>
                    <td style="text-align:right">{s.avgActualMs}</td>
                    <td style="text-align:right;color:var(--text-2)">{s.avgSelfMs}</td>
                    <td style="text-align:right;color:var(--text-2)">{s.commits}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && !msg && tab === 'cpu' && (
          <table>
            <thead>
              <tr><th>Function</th><th style="text-align:right">Self%</th><th style="text-align:right">Self ms</th><th style="text-align:right">Total%</th><th style="text-align:right">Total ms</th><th>Location</th></tr>
            </thead>
            <tbody>
              {cpuFuncs.map((f, i) => (
                <tr key={i}>
                  <td class="mono" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={f.functionName}>{f.functionName}</td>
                  <td style="text-align:right;color:var(--accent)">{f.selfPercent}%</td>
                  <td style="text-align:right">{f.selfMs}ms</td>
                  <td style="text-align:right;color:var(--text-2)">{f.totalPercent}%</td>
                  <td style="text-align:right;color:var(--text-2)">{f.totalMs}ms</td>
                  <td class="mono" style="color:var(--text-2);font-size:10px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={f.location ?? ''}>{f.location ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!loading && !msg && tab === 'renders' && (
          <table>
            <thead>
              <tr><th>Component</th><th>Phase</th><th style="text-align:right">Actual ms</th><th style="text-align:right">Base ms</th><th style="text-align:right">Savings</th></tr>
            </thead>
            <tbody>
              {renders.map((r, i) => (
                <tr key={i}>
                  <td class="mono">{r.id}</td>
                  <td style="color:var(--text-2)">{r.phase}</td>
                  <td style="text-align:right">{r.actualDuration.toFixed(1)}</td>
                  <td style="text-align:right;color:var(--text-2)">{r.baseDuration.toFixed(1)}</td>
                  <td style={`text-align:right;color:${r.memoSavingsPercent != null && r.memoSavingsPercent > 50 ? 'var(--success)' : 'var(--text-2)'}`}>{r.memoSavingsPercent != null ? `${r.memoSavingsPercent.toFixed(0)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Th({ label, col, sort, asc, onSort }: { label: string; col: string; sort: string; asc: boolean; onSort: (c: string) => void }) {
  return (
    <th class={sort === col ? 'sorted' : ''} style="text-align:right;cursor:pointer" onClick={() => onSort(col)}>
      {label}{sort === col ? (asc ? ' ↑' : ' ↓') : ''}
    </th>
  );
}

render(<App />, document.getElementById('app')!);
