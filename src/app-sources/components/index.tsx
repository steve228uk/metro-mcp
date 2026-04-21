/** @jsxImportSource preact */
import { render } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { initialize, callTool, getToolText } from '../shared/bridge';
import { useKeyboard } from '../shared/useKeyboard';

interface FiberNode {
  name: string;
  children?: FiberNode[];
  props?: Record<string, unknown>;
  testID?: string;
  accessibilityLabel?: string;
}

interface InspectResult {
  name: string;
  props: Record<string, unknown>;
  state: unknown;
  hooks: Array<{ index: number; value: unknown }>;
}

function App() {
  const [tree, setTree] = useState<FiberNode | null>(null);
  const [selected, setSelected] = useState<InspectResult | null>(null);
  const [inspecting, setInspecting] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const fetchTree = useCallback(async () => {
    try {
      const result = await callTool('get_component_tree', { structureOnly: true, maxDepth: 30 });
      const text = getToolText(result);
      if (text.startsWith('Component tree not available')) {
        setMsg(text);
      } else {
        setTree(JSON.parse(text) as FiberNode);
        setMsg('');
      }
    } catch {
      setMsg('Component tree unavailable. Ensure the app is running.');
    } finally {
      setLoading(false);
    }
  }, []);

  const inspect = useCallback(async (name: string) => {
    setInspecting(name);
    try {
      const result = await callTool('inspect_component', { name });
      const text = getToolText(result);
      if (text.includes('not found')) {
        setSelected(null);
      } else {
        setSelected(JSON.parse(text) as InspectResult);
      }
    } catch {
      setSelected(null);
    } finally {
      setInspecting('');
    }
  }, []);

  useEffect(() => { initialize().then(fetchTree).catch(() => setLoading(false)); }, []);

  useKeyboard({
    '/': () => searchRef.current?.focus(),
    Escape: () => { if (selected) setSelected(null); else { setSearch(''); searchRef.current?.blur(); } },
  });

  return (
    <div class="layout">
      <div class="toolbar">
        <input ref={searchRef} class="toolbar-search" placeholder="Filter components… (/)" value={search}
          onInput={e => setSearch((e.target as HTMLInputElement).value)} />
        <button onClick={fetchTree}>↻</button>
      </div>
      <div class="split">
        <div class="split-main" style="padding:8px">
          {loading && <div class="empty">Loading…</div>}
          {!loading && msg && <div class="empty">{msg}<p>Ensure the app is running and React DevTools hook is active.</p></div>}
          {!loading && !msg && tree && (
            <NodeTree
              node={tree}
              search={search}
              depth={0}
              activeInspect={selected?.name ?? ''}
              onInspect={inspect}
              inspecting={inspecting}
            />
          )}
        </div>
        {selected && (
          <div class="split-side open">
            <div class="detail-header">
              <span class="detail-title">{selected.name}</span>
              <button class="detail-close" onClick={() => setSelected(null)}>✕</button>
            </div>
            {Object.keys(selected.props).length > 0 && (
              <div class="detail-section">
                <h4>Props</h4>
                {Object.entries(selected.props).map(([k, v]) => (
                  <div key={k} class="kv">
                    <span class="kv-k">{k}</span>
                    <span class="kv-v mono" style="font-size:11px">{fmtVal(v)}</span>
                  </div>
                ))}
              </div>
            )}
            {selected.hooks.length > 0 && (
              <div class="detail-section">
                <h4>Hooks / State</h4>
                {selected.hooks.map(h => (
                  <div key={h.index} class="kv">
                    <span class="kv-k">#{h.index}</span>
                    <span class="kv-v mono" style="font-size:11px">{fmtVal(h.value)}</span>
                  </div>
                ))}
              </div>
            )}
            {Object.keys(selected.props).length === 0 && selected.hooks.length === 0 && (
              <div class="detail-section"><span style="color:var(--text-2);font-size:11px">No props or hooks</span></div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function NodeTree({ node, search, depth, activeInspect, onInspect, inspecting }: {
  node: FiberNode;
  search: string;
  depth: number;
  activeInspect: string;
  onInspect: (name: string) => void;
  inspecting: string;
}) {
  const [open, setOpen] = useState(depth < 3);
  const hasChildren = (node.children?.length ?? 0) > 0;
  const matches = !search || node.name.toLowerCase().includes(search.toLowerCase());

  if (!matches && !hasChildren) return null;

  const isActive = activeInspect === node.name;
  const isInspecting = inspecting === node.name;

  return (
    <div>
      <div
        class={`tree-row${isActive ? ' selected' : ''}`}
        style={`padding-left:${depth * 14 + 4}px`}
      >
        <span
          class="tree-toggle"
          onClick={() => hasChildren && setOpen(v => !v)}
          style={hasChildren ? 'cursor:pointer' : 'cursor:default;opacity:0.3'}
        >
          {hasChildren ? (open ? '▾' : '▸') : '·'}
        </span>
        <span
          style={`flex:1;${!matches ? 'opacity:0.4' : ''}`}
          onClick={() => onInspect(node.name)}
        >
          <span style={search && matches ? 'color:var(--accent)' : ''}>{node.name}</span>
          {node.testID && <span style="color:var(--text-2);font-size:10px;margin-left:4px">#{node.testID}</span>}
          {node.accessibilityLabel && <span style="color:var(--purple);font-size:10px;margin-left:4px">{node.accessibilityLabel}</span>}
        </span>
        {isInspecting && <span style="color:var(--text-2);font-size:10px">…</span>}
      </div>
      {open && hasChildren && (
        <div class="tree-children" style={`margin-left:${depth * 14 + 8}px`}>
          {node.children!.map((child, i) => (
            <NodeTree
              key={child.name + i}
              node={child}
              search={search}
              depth={depth + 1}
              activeInspect={activeInspect}
              onInspect={onInspect}
              inspecting={inspecting}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function fmtVal(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return `"${v.slice(0, 80)}${v.length > 80 ? '…' : ''}"`;
  if (typeof v === 'object') {
    try { return JSON.stringify(v).slice(0, 120); } catch { return '[object]'; }
  }
  return String(v);
}

render(<App />, document.getElementById('app')!);
