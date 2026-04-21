/** @jsxImportSource preact */
import { render } from 'preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import { initialize, callTool, getToolText, onNotification } from '../shared/bridge';

interface NavRoute {
  name: string;
  key?: string;
  params?: Record<string, unknown>;
  state?: NavState;
}

interface NavState {
  key?: string;
  index?: number;
  type?: string;
  routeNames?: string[];
  routes: NavRoute[];
}

function routeType(state: NavState): string {
  if (state.type === 'stack') return 'stack';
  if (state.type === 'tab') return 'tab';
  if (state.type === 'drawer') return 'drawer';
  return 'screen';
}

function rtClass(type: string): string {
  if (type === 'stack') return 'rt-stack';
  if (type === 'tab') return 'rt-tab';
  if (type === 'drawer') return 'rt-drawer';
  return 'rt-screen';
}

function isFocused(state: NavState, routeIndex: number): boolean {
  const focused = state.index !== undefined ? state.index : state.routes.length - 1;
  return routeIndex === focused;
}

function App() {
  const [state, setState] = useState<NavState | null>(null);
  const [selected, setSelected] = useState<NavRoute | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  const fetchState = useCallback(async () => {
    try {
      const result = await callTool('get_navigation_state', {});
      const text = getToolText(result);
      if (text.startsWith('Navigation state not found')) {
        setMsg(text);
      } else {
        const data = JSON.parse(text) as NavState;
        setState(data);
        setMsg('');
      }
    } catch {
      setMsg('Navigation state unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    initialize().then(fetchState).catch(() => setLoading(false));
    onNotification('ui/notifications/tool-result', (params) => {
      const text = ((params as Record<string, unknown>)?.result as Record<string, unknown>)?.content?.[0]?.text as string | undefined;
      if (!text || text.startsWith('Navigation')) return;
      try { setState(JSON.parse(text) as NavState); setMsg(''); } catch {}
    });
  }, []);

  return (
    <div class="layout">
      <div class="toolbar">
        <span style="font-weight:600;font-size:12px">Navigation</span>
        <button onClick={fetchState}>↻</button>
      </div>
      <div class="split">
        <div class="split-main" style="padding:8px">
          {loading && <div class="empty">Loading…</div>}
          {!loading && msg && <div class="empty">{msg}<p>Ensure your app uses React Navigation or Expo Router.</p></div>}
          {!loading && !msg && state && (
            <NavStateTree state={state} depth={0} selected={selected} onSelect={setSelected} />
          )}
        </div>
        {selected && (
          <div class="split-side open">
            <div class="detail-header">
              <span class="detail-title">{selected.name}</span>
              <button class="detail-close" onClick={() => setSelected(null)}>✕</button>
            </div>
            <div class="detail-section">
              <h4>Route</h4>
              <div class="kv"><span class="kv-k">name</span><span class="kv-v">{selected.name}</span></div>
              {selected.key && <div class="kv"><span class="kv-k">key</span><span class="kv-v mono" style="font-size:10px">{selected.key}</span></div>}
            </div>
            {selected.params && Object.keys(selected.params).length > 0 && (
              <div class="detail-section">
                <h4>Params</h4>
                {Object.entries(selected.params).map(([k, v]) => (
                  <div key={k} class="kv">
                    <span class="kv-k">{k}</span>
                    <span class="kv-v mono">{JSON.stringify(v)}</span>
                  </div>
                ))}
              </div>
            )}
            {!selected.params || Object.keys(selected.params).length === 0 && (
              <div class="detail-section"><span style="color:var(--text-2);font-size:11px">No params</span></div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function NavStateTree({ state, depth, selected, onSelect, parentFocused = true }: {
  state: NavState;
  depth: number;
  selected: NavRoute | null;
  onSelect: (r: NavRoute) => void;
  parentFocused?: boolean;
}) {
  const type = routeType(state);

  return (
    <div>
      {depth === 0 && (
        <div style="margin-bottom:6px">
          <span class={`rtype ${rtClass(type)}`}>{type}</span>
          {state.routeNames && <span style="color:var(--text-2);font-size:11px;margin-left:6px">{state.routeNames.join(', ')}</span>}
        </div>
      )}
      {state.routes.map((route, i) => {
        const focused = parentFocused && isFocused(state, i);
        return (
          <div key={route.key ?? route.name + i} style={`margin-left:${depth * 16}px`}>
            <div
              class={`tree-row${selected?.key === route.key ? ' selected' : ''}${focused ? ' active' : ''}`}
              onClick={() => onSelect(route)}
            >
              <span class="tree-toggle">{route.state ? '▾' : ' '}</span>
              <span style={focused ? 'font-weight:600' : ''}>{route.name}</span>
              {focused && <span style="color:var(--success);font-size:10px;margin-left:4px">● active</span>}
              {route.params && Object.keys(route.params).length > 0 && (
                <span style="color:var(--text-2);font-size:10px;margin-left:4px">
                  {Object.entries(route.params).slice(0, 2).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}
                </span>
              )}
            </div>
            {route.state && (
              <NavStateTree
                state={route.state}
                depth={depth + 1}
                selected={selected}
                onSelect={onSelect}
                parentFocused={focused}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
