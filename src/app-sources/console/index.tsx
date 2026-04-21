/** @jsxImportSource preact */
import { render } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { initialize, callTool, getToolText, onNotification } from '../shared/bridge';
import { usePolling } from '../shared/usePolling';
import { useKeyboard } from '../shared/useKeyboard';

interface LogEntry {
  timestamp: number;
  level: string;
  message: string;
  stackTrace?: string;
}

const LEVELS = ['all', 'log', 'info', 'warn', 'error', 'debug'] as const;
type Level = typeof LEVELS[number];

function App() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<Level>('all');
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const fetchLogs = useCallback(async () => {
    try {
      const result = await callTool('get_console_logs', { format: 'json', limit: 200 });
      const data = JSON.parse(getToolText(result)) as LogEntry[];
      setLogs(Array.isArray(data) ? data : []);
    } catch {
      // keep existing logs
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    initialize().then(fetchLogs).catch(() => setLoading(false));
    onNotification('ui/notifications/tool-result', (params) => {
      const text = ((params as Record<string, unknown>)?.result as Record<string, unknown>)?.content?.[0]?.text as string | undefined;
      if (!text) return;
      try { const d = JSON.parse(text); if (Array.isArray(d)) setLogs(d); } catch {}
    });
  }, []);

  usePolling(fetchLogs, 3000);

  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  useKeyboard({
    '/': () => searchRef.current?.focus(),
    Escape: () => { setSearch(''); searchRef.current?.blur(); },
  });

  const visible = logs.filter(l =>
    (level === 'all' || l.level === level) &&
    (!search || l.message.toLowerCase().includes(search.toLowerCase()))
  );

  const counts: Record<string, number> = { all: logs.length };
  for (const lv of ['log', 'info', 'warn', 'error', 'debug']) {
    counts[lv] = logs.filter(l => l.level === lv).length;
  }

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  const clearLogs = () => callTool('clear_console_logs', {}).then(() => setLogs([]));

  return (
    <div class="layout">
      <div class="toolbar">
        <div class="pill-group">
          {LEVELS.map(lv => (
            <button
              key={lv}
              class={`pill${level === lv ? lv === 'error' ? ' on on-err' : ' on' : ''}`}
              onClick={() => setLevel(lv)}
            >
              {lv.toUpperCase()}
              {counts[lv] > 0 && <span class="badge">{counts[lv]}</span>}
            </button>
          ))}
        </div>
        <div class="toolbar-sep" />
        <input
          ref={searchRef}
          class="toolbar-search"
          placeholder="Search… (/)"
          value={search}
          onInput={e => setSearch((e.target as HTMLInputElement).value)}
        />
        <span class="toolbar-status">{visible.length} entries</span>
        <button onClick={clearLogs}>Clear</button>
      </div>
      <div class="scrollable" ref={listRef} onScroll={onScroll}>
        {loading && <div class="empty">Loading…</div>}
        {!loading && visible.length === 0 && (
          <div class="empty">
            No {level !== 'all' ? level + ' ' : ''}logs{search ? ' matching filter' : ''}.
            <p>Waiting for console output…</p>
          </div>
        )}
        {visible.map((log, i) => <LogRow key={`${log.timestamp}-${i}`} log={log} search={search} />)}
        <button
          class={`scroll-paused${autoScroll ? '' : ' show'}`}
          onClick={() => { setAutoScroll(true); listRef.current!.scrollTop = listRef.current!.scrollHeight; }}
        >↓ Scroll to latest</button>
      </div>
    </div>
  );
}

function LogRow({ log, search }: { log: LogEntry; search: string }) {
  const [open, setOpen] = useState(false);
  const ts = new Date(log.timestamp).toTimeString().slice(0, 12);
  const lv = log.level.toLowerCase();
  const validLvl = ['log', 'info', 'warn', 'error', 'debug'].includes(lv) ? lv : 'log';
  const rowBg = lv === 'warn' ? ' row-warn' : lv === 'error' ? ' row-error' : '';

  return (
    <div class={rowBg} style="padding:0">
      <div style="display:flex;gap:8px;padding:2px 10px;align-items:flex-start;font-family:var(--mono);font-size:12px">
        <span style="color:var(--text-2);font-size:11px;flex-shrink:0;padding-top:1px">{ts}</span>
        <span class={`lvl lvl-${validLvl}`}>{validLvl.slice(0, 4).toUpperCase()}</span>
        <span style="flex:1;white-space:pre-wrap;word-break:break-all;line-height:1.45">
          {search ? <Highlight text={log.message} q={search} /> : log.message}
        </span>
        {log.stackTrace && (
          <button
            style="background:none;border:none;color:var(--text-2);cursor:pointer;padding:0 2px;font-size:10px;flex-shrink:0"
            onClick={() => setOpen(v => !v)}
          >{open ? '▲' : '▼'}</button>
        )}
      </div>
      {open && log.stackTrace && (
        <div class="code" style="margin:2px 10px 4px 88px">{fmtStack(log.stackTrace)}</div>
      )}
    </div>
  );
}

function Highlight({ text, q }: { text: string; q: string }) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, i)}
      <mark style="background:var(--accent);color:var(--bg);border-radius:2px;padding:0 1px">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </span>
  );
}

function fmtStack(raw: string): string {
  try {
    const frames = JSON.parse(raw) as Array<Record<string, unknown>>;
    return frames.map(f => `  at ${f.functionName || '<anon>'} (${f.url || '?'}:${f.lineNumber ?? '?'})`).join('\n');
  } catch {
    return raw;
  }
}

render(<App />, document.getElementById('app')!);
