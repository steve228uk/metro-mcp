/**
 * Performance marks and measures, plus React Profiler render tracking.
 */

export interface RenderRecord {
  id: string;
  phase: 'mount' | 'update' | 'nested-update';
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
}

const MAX_RENDERS = 200;

interface MetroMCPRenders {
  renders: RenderRecord[];
  clearRenders: () => void;
}

function getOrInitRenders(): MetroMCPRenders {
  const g = globalThis as Record<string, unknown>;
  if (!g.__METRO_MCP__) g.__METRO_MCP__ = {};
  const mcp = g.__METRO_MCP__ as Record<string, unknown>;
  if (!mcp.renders) {
    const renders: RenderRecord[] = [];
    const clearRenders = () => { renders.length = 0; };
    mcp.renders = renders;
    mcp.clearRenders = clearRenders;
  }
  return { renders: mcp.renders as RenderRecord[], clearRenders: mcp.clearRenders as () => void };
}

/**
 * Drop-in onRender callback for React's <Profiler> component.
 *
 * Usage:
 *   import { trackRender } from 'metro-mcp/client';
 *   <Profiler id="sidebar" onRender={trackRender}>
 *     <Sidebar />
 *   </Profiler>
 */
export function trackRender(
  id: string,
  phase: 'mount' | 'update' | 'nested-update',
  actualDuration: number,
  baseDuration: number,
  startTime: number,
  commitTime: number
): void {
  const { renders } = getOrInitRenders();
  renders.push({ id, phase, actualDuration, baseDuration, startTime, commitTime });
  if (renders.length > MAX_RENDERS) renders.splice(0, renders.length - MAX_RENDERS);
}

export interface PerformanceMeasure {
  name: string;
  startMark: string;
  endMark: string;
  duration: number;
}

export class PerformanceTracker {
  marks = new Map<string, number>();
  measures: PerformanceMeasure[] = [];

  mark(name: string): void {
    this.marks.set(name, Date.now());
  }

  measure(name: string, startMark: string, endMark: string): number | null {
    const start = this.marks.get(startMark);
    const end = this.marks.get(endMark);
    if (start === undefined || end === undefined) return null;

    const duration = end - start;
    this.measures.push({ name, startMark, endMark, duration });

    // Keep last 100 measures
    if (this.measures.length > 100) {
      this.measures = this.measures.slice(-100);
    }

    return duration;
  }

  getMeasures(): PerformanceMeasure[] {
    return [...this.measures];
  }

  clear(): void {
    this.marks.clear();
    this.measures = [];
  }
}
