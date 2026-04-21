/** @jsxImportSource preact */
import { render } from 'preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import { initialize, callTool, getToolText, onNotification } from '../shared/bridge';
import { usePolling } from '../shared/usePolling';

interface ErrorEntry {
  timestamp: number;
  message: string;
  stack?: string;
  symbolicatedStack?: string;
}

function App() {
  const [errors, setErrors] = useState<ErrorEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchErrors = useCallback(async () => {
    try {
      const result = await callTool('get_errors', { format: 'json', limit: 50 });
      const text = getToolText(result);
      if (text && text !== '(no errors)') {
        const data = JSON.parse(text) as ErrorEntry[];
        setErrors(Array.isArray(data) ? [...data].reverse() : []);
      } else {
        setErrors([]);
      }
    } catch {
      // keep existing
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    initialize().then(fetchErrors).catch(() => setLoading(false));
    onNotification('ui/notifications/tool-result', (params) => {
      const text = ((params as Record<string, unknown>)?.result as Record<string, unknown>)?.content?.[0]?.text as string | undefined;
      if (!text || text === '(no errors)') return;
      try { const d = JSON.parse(text); if (Array.isArray(d)) setErrors([...d].reverse()); } catch {}
    });
  }, []);

  usePolling(fetchErrors, 5000);

  const clearErrors = () => callTool('clear_errors', {}).then(() => setErrors([]));

  return (
    <div class="layout">
      <div class="toolbar">
        <span style="font-weight:600;font-size:12px">Errors</span>
        {errors.length > 0 && <span class="badge" style="color:var(--error)">{errors.length}</span>}
        <span class="toolbar-status">{errors.length} error{errors.length !== 1 ? 's' : ''}</span>
        <button onClick={fetchErrors}>↻</button>
        <button onClick={clearErrors}>Clear</button>
      </div>
      <div class="scrollable" style="padding:8px">
        {loading && <div class="empty">Loading…</div>}
        {!loading && errors.length === 0 && (
          <div class="empty">No errors recorded.
            <p>Uncaught exceptions will appear here automatically.</p>
          </div>
        )}
        {errors.map((err, i) => <ErrorCard key={`${err.timestamp}-${i}`} err={err} />)}
      </div>
    </div>
  );
}

function ErrorCard({ err }: { err: ErrorEntry }) {
  const [open, setOpen] = useState(false);
  const ts = new Date(err.timestamp).toLocaleTimeString();
  const stack = err.symbolicatedStack || err.stack;

  return (
    <div class="row-error" style="border-radius:var(--r);margin-bottom:8px;border:1px solid var(--border);overflow:hidden">
      <div
        style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px;cursor:pointer"
        onClick={() => setOpen(v => !v)}
      >
        <span style="color:var(--error);font-size:14px;flex-shrink:0;line-height:1.3">✕</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:600;color:var(--text);word-break:break-word">{err.message}</div>
          <div style="font-size:11px;color:var(--text-2);margin-top:2px">{ts}</div>
        </div>
        {stack && (
          <span style="color:var(--text-2);font-size:11px;flex-shrink:0">{open ? '▲' : '▼'} stack</span>
        )}
      </div>
      {open && stack && (
        <div style="border-top:1px solid var(--border)">
          <div class="code" style="border-radius:0;max-height:360px">{fmtStack(stack)}</div>
          {err.symbolicatedStack && (
            <div style="padding:4px 10px;font-size:10px;color:var(--success)">✓ Symbolicated</div>
          )}
        </div>
      )}
    </div>
  );
}

function fmtStack(raw: string): string {
  try {
    const frames = JSON.parse(raw) as Array<Record<string, unknown>>;
    return frames.map(f => `at ${f.functionName || '<anon>'} (${f.url || '?'}:${f.lineNumber ?? '?'}:${f.columnNumber ?? '?'})`).join('\n');
  } catch {
    return raw;
  }
}

render(<App />, document.getElementById('app')!);
