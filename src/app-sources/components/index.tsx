/** @jsxImportSource preact */
import { render } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { initialize, callTool, getToolText } from '../shared/bridge';
import { useKeyboard } from '../shared/useKeyboard';

interface FiberNode {
  id: string;
  parentId: string | null;
  depth: number;
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

interface Traversal {
  scope: 'focused-scene' | 'all-scenes';
  complete: boolean;
  depthReached: number;
  scannedNodes: number;
  truncationReason?: string;
}

interface TreePage {
  snapshotId: string | null;
  nodes: FiberNode[];
  traversal: Traversal;
  nextCursor?: string;
  error?: string;
}

interface InspectEnvelope {
  result: InspectResult | null;
  traversal: Traversal;
}

function App() {
  const [tree, setTree] = useState<FiberNode[]>([]);
  const [selected, setSelected] = useState<InspectResult | null>(null);
  const [inspecting, setInspecting] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [warning, setWarning] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const fetchTree = useCallback(async () => {
    try {
      const nodes: FiberNode[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let lastPage: TreePage | null = null;
      do {
        const result = await callTool('get_component_tree', {
          structureOnly: true,
          pageSize: 250,
          ...(cursor ? { cursor } : {}),
        });
        const page = JSON.parse(getToolText(result)) as TreePage;
        lastPage = page;
        nodes.push(...page.nodes);
        cursor = page.nextCursor;
        if (cursor && seenCursors.has(cursor)) throw new Error('Repeated component-tree cursor');
        if (cursor) seenCursors.add(cursor);
      } while (cursor);

      if (lastPage?.error) {
        setMsg(lastPage.error);
        setTree([]);
        setWarning('');
      } else {
        setTree(reconstructTree(nodes));
        setMsg('');
        setWarning(
          lastPage && !lastPage.traversal.complete
            ? `Incomplete ${lastPage.traversal.scope} traversal: ${lastPage.traversal.truncationReason ?? 'limit reached'} after ${lastPage.traversal.scannedNodes} fibers (depth ${lastPage.traversal.depthReached}).`
            : '',
        );
      }
    } catch {
      setMsg('Component tree unavailable. Ensure the app is running.');
      setWarning('');
    } finally {
      setLoading(false);
    }
  }, []);

  const inspect = useCallback(async (name: string) => {
    setInspecting(name);
    try {
      const result = await callTool('inspect_component', { name });
      const envelope = JSON.parse(getToolText(result)) as InspectEnvelope;
      setSelected(envelope.result);
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
          {warning && (
            <div style="margin:0 0 8px;padding:7px 9px;border:1px solid var(--warn);border-radius:var(--r);color:var(--warn);font-size:11px">
              {warning}
            </div>
          )}
          {loading && <div class="empty">Loading…</div>}
          {!loading && msg && <div class="empty">{msg}<p>Ensure the app is running and React DevTools hook is active.</p></div>}
          {!loading && !msg && tree.map(node => (
            <NodeTree
              key={node.id}
              node={node}
              search={search}
              depth={0}
              activeInspect={selected?.name ?? ''}
              onInspect={inspect}
              inspecting={inspecting}
            />
          ))}
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

function reconstructTree(flatNodes: FiberNode[]): FiberNode[] {
  const byId = new Map<string, FiberNode>();
  const roots: FiberNode[] = [];
  for (const flatNode of flatNodes) {
    byId.set(flatNode.id, { ...flatNode, children: [] });
  }
  for (const flatNode of flatNodes) {
    const node = byId.get(flatNode.id)!;
    const parent = flatNode.parentId ? byId.get(flatNode.parentId) : undefined;
    if (parent) parent.children!.push(node);
    else roots.push(node);
  }
  return roots;
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
