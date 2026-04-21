/** @jsxImportSource preact */
import { render } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { initialize, callTool, getToolText, onNotification } from '../shared/bridge';
import { useKeyboard } from '../shared/useKeyboard';

function App() {
  const [data, setData] = useState<unknown>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const fetchState = useCallback(async () => {
    try {
      const result = await callTool('get_redux_state', {});
      const text = getToolText(result);
      setData(JSON.parse(text));
      setMsg('');
    } catch {
      setMsg('Redux store not found. Ensure your app uses Redux with the metro-bridge client.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    initialize().then(fetchState).catch(() => setLoading(false));
    onNotification('ui/notifications/tool-result', (params) => {
      const text = ((params as Record<string, unknown>)?.result as Record<string, unknown>)?.content?.[0]?.text as string | undefined;
      if (!text) return;
      try { setData(JSON.parse(text)); setMsg(''); } catch {}
    });
  }, []);

  useKeyboard({
    '/': () => searchRef.current?.focus(),
    Escape: () => { setSearch(''); searchRef.current?.blur(); },
  });

  const onCopy = (path: string, val: unknown) => {
    navigator.clipboard?.writeText(JSON.stringify(val, null, 2)).catch(() => {});
    setCopied(path);
    setTimeout(() => setCopied(''), 1500);
  };

  return (
    <div class="layout">
      <div class="toolbar">
        <span style="font-weight:600;font-size:12px">Redux State</span>
        <div class="toolbar-sep" />
        <input ref={searchRef} class="toolbar-search" placeholder="Filter keys… (/)" value={search}
          onInput={e => setSearch((e.target as HTMLInputElement).value)} />
        <button onClick={fetchState}>↻</button>
      </div>
      <div class="scrollable" style="padding:8px;font-size:12px">
        {loading && <div class="empty">Loading…</div>}
        {!loading && msg && <div class="empty">{msg}</div>}
        {!loading && !msg && data !== null && (
          <JsonNode value={data} path="$" depth={0} search={search} copied={copied} onCopy={onCopy} />
        )}
      </div>
    </div>
  );
}

interface NodeProps {
  value: unknown;
  path: string;
  depth: number;
  search: string;
  copied: string;
  onCopy: (path: string, val: unknown) => void;
  keyLabel?: string;
}

function JsonNode({ value, path, depth, search, copied, onCopy, keyLabel }: NodeProps) {
  const [open, setOpen] = useState(depth < 2);
  const isObj = value !== null && typeof value === 'object';
  const isArr = Array.isArray(value);
  const entries = isObj ? Object.entries(value as Record<string, unknown>) : [];
  const keyMatch = search && keyLabel && keyLabel.toLowerCase().includes(search.toLowerCase());

  const label = keyLabel != null ? (
    <span class="j-key" style={keyMatch ? 'background:var(--accent);color:var(--bg);border-radius:2px' : ''}>{keyLabel}: </span>
  ) : null;

  if (!isObj) {
    return (
      <div class="tree-row" style={`padding-left:${depth * 14}px`} onMouseEnter={() => {}} title={path}>
        {label}
        <ScalarValue value={value} search={search} />
        <button style="background:none;border:none;color:var(--text-2);cursor:pointer;font-size:10px;padding:0 4px;opacity:0;transition:opacity .15s"
          class="copy-btn" onClick={() => onCopy(path, value)}>
          {copied === path ? '✓' : '⎘'}
        </button>
      </div>
    );
  }

  const summary = isArr ? `[${entries.length}]` : `{${entries.length > 0 ? '…' : ''}}`;

  return (
    <div>
      <div
        class="tree-row"
        style={`padding-left:${depth * 14}px`}
        onClick={() => setOpen(v => !v)}
      >
        <span class="tree-toggle">{entries.length > 0 ? (open ? '▾' : '▸') : ' '}</span>
        {label}
        <span style="color:var(--text-2)">{summary}</span>
        {!open && entries.length > 0 && (
          <span style="color:var(--text-2);font-size:10px;margin-left:4px">{entries.length} {isArr ? 'items' : 'keys'}</span>
        )}
        <button style="background:none;border:none;color:var(--text-2);cursor:pointer;font-size:10px;padding:0 4px;margin-left:auto"
          onClick={e => { e.stopPropagation(); onCopy(path, value); }}>
          {copied === path ? '✓' : '⎘'}
        </button>
      </div>
      {open && entries.length > 0 && (
        <div>
          {entries.map(([k, v]) => (
            <JsonNode
              key={k}
              value={v}
              path={`${path}.${k}`}
              depth={depth + 1}
              search={search}
              copied={copied}
              onCopy={onCopy}
              keyLabel={k}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ScalarValue({ value, search }: { value: unknown; search: string }) {
  if (value === null) return <span class="j-null">null</span>;
  if (typeof value === 'boolean') return <span class="j-bool">{String(value)}</span>;
  if (typeof value === 'number') return <span class="j-num">{String(value)}</span>;
  const str = JSON.stringify(value);
  if (search && str.toLowerCase().includes(search.toLowerCase())) {
    return <span class="j-str" style="background:color-mix(in srgb,var(--accent) 20%,transparent);border-radius:2px">{str}</span>;
  }
  return <span class="j-str">{str}</span>;
}

render(<App />, document.getElementById('app')!);
