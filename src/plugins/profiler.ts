import { z } from 'zod';
import { definePlugin } from '../plugin.js';

// ── CDP CPU profiler types ────────────────────────────────────────────────────

interface CallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  hitCount: number;
  children?: number[];
}

interface CpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

// ── React DevTools hook types ─────────────────────────────────────────────────

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

type DevToolsProfile = CommitData[];

// ── React render record (trackRender / <Profiler>) ────────────────────────────

interface RenderRecord {
  id: string;
  phase: 'mount' | 'update' | 'nested-update';
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
}

// ── CDP CPU analysis ──────────────────────────────────────────────────────────

interface FunctionStat {
  functionName: string;
  url: string;
  lineNumber: number;
  selfMs: number;
  selfPercent: number;
  totalMs: number;
  totalPercent: number;
}

interface CpuAnalysis {
  durationMs: number;
  sampleCount: number;
  topFunctions: FunctionStat[];
  totalSamplesMap: Map<number, number>;
  selfSamplesMap: Map<number, number>;
}

const SKIP_FN_NAMES = new Set(['(root)', '(idle)', '(program)']);

function analyzeCpuProfile(profile: CpuProfile, topN: number, includeNative: boolean): CpuAnalysis {
  const durationMs = (profile.endTime - profile.startTime) / 1000;
  const samples = profile.samples ?? [];

  const parentMap = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const childId of node.children ?? []) parentMap.set(childId, node.id);
  }

  const selfSamplesMap = new Map<number, number>();
  const totalSamplesMap = new Map<number, number>();

  for (const nodeId of samples) {
    selfSamplesMap.set(nodeId, (selfSamplesMap.get(nodeId) ?? 0) + 1);
    let current: number | undefined = nodeId;
    const visited = new Set<number>();
    while (current !== undefined && !visited.has(current)) {
      visited.add(current);
      totalSamplesMap.set(current, (totalSamplesMap.get(current) ?? 0) + 1);
      current = parentMap.get(current);
    }
  }

  const total = samples.length || 1;
  const stats: FunctionStat[] = [];

  for (const node of profile.nodes) {
    const self = selfSamplesMap.get(node.id) ?? 0;
    const tot = totalSamplesMap.get(node.id) ?? 0;
    if (self === 0 && tot === 0) continue;
    const fnName = node.callFrame.functionName || '(anonymous)';
    if (SKIP_FN_NAMES.has(fnName)) continue;
    if (!includeNative && (!node.callFrame.url || node.callFrame.url.startsWith('native '))) continue;
    stats.push({
      functionName: fnName,
      url: node.callFrame.url ?? '',
      lineNumber: node.callFrame.lineNumber + 1,
      selfMs: parseFloat(((self / total) * durationMs).toFixed(2)),
      selfPercent: parseFloat(((self / total) * 100).toFixed(1)),
      totalMs: parseFloat(((tot / total) * durationMs).toFixed(2)),
      totalPercent: parseFloat(((tot / total) * 100).toFixed(1)),
    });
  }

  stats.sort((a, b) => b.selfMs - a.selfMs);
  return { durationMs: parseFloat(durationMs.toFixed(2)), sampleCount: samples.length, topFunctions: stats.slice(0, topN), totalSamplesMap, selfSamplesMap };
}

// ── Text renderers ────────────────────────────────────────────────────────────

const BAR_WIDTH = 24;
const MAX_DEPTH = 8;
const MIN_PERCENT = 0.5;

function bar(value: number, max: number): string {
  const filled = max > 0 ? Math.max(1, Math.round((value / max) * BAR_WIDTH)) : 0;
  return '█'.repeat(filled).padEnd(BAR_WIDTH);
}

function barPct(pct: number): string {
  return '█'.repeat(Math.max(1, Math.round((pct / 100) * BAR_WIDTH))).padEnd(BAR_WIDTH);
}

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function memoSavings(r: RenderRecord): number | null {
  return r.baseDuration > 0
    ? parseFloat((((r.baseDuration - r.actualDuration) / r.baseDuration) * 100).toFixed(1))
    : null;
}

function buildCpuFlamegraph(profile: CpuProfile, analysis: CpuAnalysis): string {
  const { durationMs, sampleCount, totalSamplesMap, selfSamplesMap, topFunctions } = analysis;
  const nodeMap = new Map<number, ProfileNode>(profile.nodes.map((n) => [n.id, n]));
  const lines: string[] = [];

  lines.push('=== CPU Flamegraph (by total time) ===');
  lines.push(`Duration: ${durationMs}ms | Samples: ${sampleCount}`);
  lines.push('');

  function renderNode(nodeId: number, depth: number): void {
    if (depth > MAX_DEPTH) return;
    const node = nodeMap.get(nodeId);
    if (!node) return;
    const fnName = node.callFrame.functionName || '(anonymous)';
    if (SKIP_FN_NAMES.has(fnName) && depth === 0) {
      for (const c of node.children ?? []) renderNode(c, depth);
      return;
    }
    const total = totalSamplesMap.get(nodeId) ?? 0;
    const self = selfSamplesMap.get(nodeId) ?? 0;
    const totalPct = sampleCount > 0 ? (total / sampleCount) * 100 : 0;
    const selfPct = sampleCount > 0 ? (self / sampleCount) * 100 : 0;
    if (totalPct < MIN_PERCENT && depth > 0) return;
    const indent = '  '.repeat(depth);
    const hasChildren = (node.children ?? []).some((c) => sampleCount > 0 && ((totalSamplesMap.get(c) ?? 0) / sampleCount) * 100 >= MIN_PERCENT);
    const label = trunc(fnName, 30).padEnd(30);
    const ms = parseFloat((((hasChildren ? total : self) / (sampleCount || 1)) * durationMs).toFixed(1));
    const pct = hasChildren ? totalPct : selfPct;
    lines.push(`${indent}${hasChildren ? '▼' : '■'} ${label} ${pct.toFixed(1).padStart(5)}% ${barPct(pct)} ${ms}ms ${hasChildren ? 'total' : 'self'}`);
    for (const c of node.children ?? []) renderNode(c, depth + 1);
  }

  if (profile.nodes.length > 0) renderNode(profile.nodes[0].id, 0);
  else lines.push('(no profile data)');

  lines.push('');
  lines.push('=== Ranked by Self Time ===');
  if (topFunctions.length === 0) {
    lines.push('(no data)');
  } else {
    const hdr = ` #  ${'Function'.padEnd(30)} ${'Self%'.padStart(6)}  ${'Self ms'.padStart(8)}  ${'Total%'.padStart(6)}  ${'Total ms'.padStart(9)}  Location`;
    lines.push(hdr);
    lines.push('-'.repeat(hdr.length));
    topFunctions.forEach((f, i) =>
      lines.push(` ${String(i + 1).padStart(2)}  ${trunc(f.functionName, 30).padEnd(30)} ${`${f.selfPercent}%`.padStart(6)}  ${`${f.selfMs}ms`.padStart(8)}  ${`${f.totalPercent}%`.padStart(6)}  ${`${f.totalMs}ms`.padStart(9)}  ${f.url ? `${f.url}:${f.lineNumber}` : '(unknown)'}`)
    );
  }

  return lines.join('\n');
}

function buildDevToolsChart(profile: DevToolsProfile): string {
  const lines: string[] = [];
  const totalDuration = profile.reduce((s, c) => s + c.duration, 0);

  lines.push('=== React DevTools Profile ===');
  lines.push(`${profile.length} commit${profile.length !== 1 ? 's' : ''} | ${totalDuration.toFixed(1)}ms total`);
  lines.push('');

  // Aggregate by component name across all commits
  const byName = new Map<string, { totalActual: number; totalSelf: number; commits: number }>();
  for (const commit of profile) {
    for (const comp of commit.components) {
      const entry = byName.get(comp.name) ?? { totalActual: 0, totalSelf: 0, commits: 0 };
      entry.totalActual += comp.actualMs;
      entry.totalSelf += comp.selfMs;
      entry.commits++;
      byName.set(comp.name, entry);
    }
  }

  const sorted = [...byName.entries()]
    .map(([name, s]) => ({ name, ...s, avgActual: s.totalActual / s.commits, avgSelf: s.totalSelf / s.commits }))
    .sort((a, b) => b.totalActual - a.totalActual);

  const maxTotal = sorted[0]?.totalActual ?? 1;

  lines.push('=== Components by Total Actual Duration ===');
  const hdr = ` #  ${'Component'.padEnd(30)} ${'Commits'.padStart(8)}  ${'Total'.padStart(9)}  ${'Avg'.padStart(8)}  ${'Self avg'.padStart(9)}  Chart`;
  lines.push(hdr);
  lines.push('-'.repeat(hdr.length + BAR_WIDTH));

  sorted.forEach((s, i) =>
    lines.push(
      ` ${String(i + 1).padStart(2)}  ${trunc(s.name, 30).padEnd(30)} ${String(s.commits).padStart(8)}  ${`${s.totalActual.toFixed(1)}ms`.padStart(9)}  ${`${s.avgActual.toFixed(1)}ms`.padStart(8)}  ${`${s.avgSelf.toFixed(1)}ms`.padStart(9)}  ${bar(s.totalActual, maxTotal)}`
    )
  );

  return lines.join('\n');
}

function buildRenderChart(renders: RenderRecord[]): string {
  const lines: string[] = [];
  const sorted = [...renders].sort((a, b) => b.actualDuration - a.actualDuration);
  const maxActual = sorted[0]?.actualDuration ?? 1;

  lines.push('=== React Renders — Ranked by Actual Duration ===');
  const hdr = ` #  ${'Component'.padEnd(26)} ${'Phase'.padEnd(14)} ${'Actual'.padStart(8)}  ${'Base'.padStart(8)}  Savings  Chart`;
  lines.push(hdr);
  lines.push('-'.repeat(hdr.length + BAR_WIDTH));
  sorted.forEach((r, i) => {
    const savings = memoSavings(r);
    lines.push(` ${String(i + 1).padStart(2)}  ${trunc(r.id, 26).padEnd(26)} ${r.phase.padEnd(14)} ${`${r.actualDuration.toFixed(1)}ms`.padStart(8)}  ${`${r.baseDuration.toFixed(1)}ms`.padStart(8)}  ${savings !== null ? `${savings.toFixed(0)}%`.padStart(7) : '    n/a'}  ${bar(r.actualDuration, maxActual)}`);
  });

  const byId = new Map<string, { totalActual: number; count: number; phases: Set<string> }>();
  for (const r of renders) {
    const e = byId.get(r.id) ?? { totalActual: 0, count: 0, phases: new Set() };
    e.totalActual += r.actualDuration; e.count++; e.phases.add(r.phase);
    byId.set(r.id, e);
  }
  const summaries = [...byId.entries()]
    .map(([id, s]) => ({ id, avg: s.totalActual / s.count, count: s.count, phases: [...s.phases].join(', ') }))
    .sort((a, b) => b.avg - a.avg);

  lines.push('');
  lines.push('=== Summary by Component ===');
  const sHdr = ` ${'Component'.padEnd(28)} ${'Renders'.padStart(8)}  ${'Avg actual'.padStart(11)}  Phases`;
  lines.push(sHdr);
  lines.push('-'.repeat(sHdr.length));
  for (const s of summaries)
    lines.push(` ${trunc(s.id, 28).padEnd(28)} ${String(s.count).padStart(8)}  ${`${s.avg.toFixed(1)}ms`.padStart(11)}  ${s.phases}`);

  return lines.join('\n');
}

// ── Eval expressions ──────────────────────────────────────────────────────────

const DEVTOOLS_START_EXPR = `(function() {
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) return { error: 'no-hook' };

  // Path 1: renderer has startProfiling (React DevTools backend connected)
  var count = 0;
  if (hook.renderers && typeof hook.renderers.forEach === 'function') {
    hook.renderers.forEach(function(r) {
      if (typeof r.startProfiling === 'function') { r.startProfiling(true); count++; }
    });
  }
  if (count > 0) return { ok: true, method: 'startProfiling', count: count };

  // Path 2: patch onCommitFiberRoot — works without DevTools backend.
  // React calls this on every commit; fiber.actualDuration is tracked in dev builds.
  if (typeof hook.onCommitFiberRoot === 'undefined') return { error: 'no-hook-method' };
  var orig = hook.onCommitFiberRoot;
  var commits = [];
  hook.onCommitFiberRoot = function(rendererID, root, priorityLevel) {
    if (orig) try { orig.call(this, rendererID, root, priorityLevel); } catch(e) {}
    if (commits.length >= MAX_COMMITS) return;
    var components = [];
    var stack = root && root.current ? [root.current] : [];
    var depth = 0;
    while (stack.length > 0 && depth < 2000) {
      depth++;
      var fiber = stack.pop();
      var ad = fiber.actualDuration;
      if (typeof ad === 'number' && ad > 0.01) {
        var name = null;
        var type = fiber.type;
        if (typeof type === 'function') { name = type.displayName || type.name || null; }
        else if (typeof type === 'string') { name = type; }
        if (name) components.push({ name: name, actualMs: ad, selfMs: fiber.selfBaseDuration || 0 });
      }
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
    if (components.length > 0) {
      components.sort(function(a, b) { return b.actualMs - a.actualMs; });
      commits.push({ timestamp: Date.now(), duration: (root && root.current && root.current.actualDuration) || 0, components: components });
    }
  };
  var MAX_COMMITS = 500;
  globalThis.__METRO_MCP_PROFILER__ = { commits: commits, orig: orig, max: MAX_COMMITS };
  return { ok: true, method: 'commit-hook', count: 1 };
})()`;

const DEVTOOLS_STOP_EXPR = `(function() {
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;

  // Path 1: renderer had startProfiling (DevTools backend path)
  if (hook && hook.renderers && typeof hook.renderers.forEach === 'function') {
    var rdCommits = [];
    hook.renderers.forEach(function(renderer) {
      if (typeof renderer.stopProfiling !== 'function') return;
      renderer.stopProfiling();
      if (typeof renderer.getProfilingData !== 'function') return;
      var data; try { data = renderer.getProfilingData(); } catch(e) { return; }
      if (!data || !data.commitData) return;
      var infoMap = data.displayInfoMap;
      data.commitData.forEach(function(commit) {
        var components = [];
        var fiberActual = commit.fiberActualDurations;
        var fiberSelf = commit.fiberSelfDurations;
        if (fiberActual && typeof fiberActual.forEach === 'function') {
          fiberActual.forEach(function(actualMs, fiberId) {
            var selfMs = (fiberSelf && fiberSelf.get ? fiberSelf.get(fiberId) : 0) || 0;
            var name = String(fiberId);
            if (infoMap && infoMap.get) { var info = infoMap.get(fiberId); if (info) name = info.displayName || info.type || name; }
            if (actualMs > 0.01) components.push({ name: name, actualMs: actualMs, selfMs: selfMs });
          });
        }
        components.sort(function(a, b) { return b.actualMs - a.actualMs; });
        rdCommits.push({ timestamp: commit.timestamp || 0, duration: commit.duration || 0, components: components });
      });
    });
    if (rdCommits.length > 0) return rdCommits;
  }

  // Path 2: commit-hook patch
  var profiler = globalThis.__METRO_MCP_PROFILER__;
  if (!profiler) return null;
  if (hook) hook.onCommitFiberRoot = profiler.orig;
  var data = profiler.commits.slice();
  globalThis.__METRO_MCP_PROFILER__ = undefined;
  return data;
})()`;

const READ_RENDERS_EXPR = `(function() {
  var mcp = globalThis.__METRO_BRIDGE__ || globalThis.__METRO_MCP__;
  return (mcp && Array.isArray(mcp.renders)) ? mcp.renders.slice() : null;
})()`;

const READ_AND_CLEAR_EXPR = `(function() {
  var mcp = globalThis.__METRO_BRIDGE__ || globalThis.__METRO_MCP__;
  if (!mcp || !Array.isArray(mcp.renders)) return null;
  var data = mcp.renders.slice();
  if (typeof mcp.clearRenders === 'function') mcp.clearRenders();
  return data;
})()`;

const NOT_SETUP_MSG =
  'No render data available. Add <Profiler id="..." onRender={trackRender}> to your app and import trackRender from metro-bridge/client.';

const CONSOLE_PROFILE_TITLE = 'metro-mcp';

// ── Plugin ────────────────────────────────────────────────────────────────────

export const profilerPlugin = definePlugin({
  name: 'profiler',

  description: 'CPU profiling via React DevTools hook (primary) or CDP Profiler domain, plus React render tracking',

  async setup(ctx) {
    type ProfilingMode = 'devtools-hook' | 'cdp' | 'console' | null;

    let profilingMode: ProfilingMode = null;
    let lastCpuProfile: CpuProfile | null = null;
    let lastCpuAnalysis: CpuAnalysis | null = null;
    let lastDevToolsProfile: DevToolsProfile | null = null;

    const profilerConfig = (ctx.config as Record<string, unknown>).profiler as { newArchitecture?: boolean } | undefined;
    const newArchitecture = profilerConfig?.newArchitecture ?? true;

    function isFuseboxTarget(): boolean {
      return ctx.cdp.getTarget()?.reactNative?.capabilities?.prefersFuseboxFrontend === true;
    }

    function shouldSkipCdpFallback(): boolean {
      return newArchitecture || isFuseboxTarget();
    }

    let pendingConsoleProfile: {
      resolve: (profile: CpuProfile) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    } | null = null;

    // Only needed for legacy arch CDP fallback path
    if (!newArchitecture) {
      ctx.cdp.on('Profiler.consoleProfileFinished', (params: Record<string, unknown>) => {
        const { title, profile } = params as { id: string; profile: CpuProfile; title?: string };
        if (title === CONSOLE_PROFILE_TITLE && pendingConsoleProfile) {
          clearTimeout(pendingConsoleProfile.timer);
          pendingConsoleProfile.resolve(profile);
          pendingConsoleProfile = null;
        }
      });
    }

    async function buildFlamegraphText(): Promise<string> {
      const sections: string[] = [];
      if (lastDevToolsProfile && lastDevToolsProfile.length > 0) {
        sections.push(buildDevToolsChart(lastDevToolsProfile));
      } else if (lastCpuProfile && lastCpuAnalysis) {
        sections.push(buildCpuFlamegraph(lastCpuProfile, lastCpuAnalysis));
      } else {
        sections.push('(no profile — call start_profiling, interact, then stop_profiling)');
      }
      sections.push('');
      try {
        const raw = (await ctx.evalInApp(READ_RENDERS_EXPR)) as RenderRecord[] | null;
        sections.push(raw && raw.length > 0 ? buildRenderChart(raw) : `=== React Renders ===\n${raw === null ? NOT_SETUP_MSG : 'No renders recorded yet.'}`);
      } catch {
        sections.push(`=== React Renders ===\n${NOT_SETUP_MSG}`);
      }
      return sections.join('\n');
    }

    ctx.registerTool('start_profiling', {
      description:
        'Start profiling the running React Native app. ' +
        'Primary path: injects into the React DevTools hook (__REACT_DEVTOOLS_GLOBAL_HOOK__) via evalInApp — ' +
        'captures all component render durations without requiring <Profiler> wrappers, works on all architectures. ' +
        'Fallback (legacy arch only): CDP Profiler domain for JS CPU call-graph sampling. ' +
        'Perform the interaction you want to measure, then call stop_profiling.',
      parameters: z.object({
        samplingInterval: z
          .number().int().min(100).max(100_000).default(1_000)
          .describe('CDP fallback only: sampling interval in microseconds (default 1000).'),
      }),
      handler: async ({ samplingInterval }) => {
        if (profilingMode !== null) return 'A profiling session is already active. Call stop_profiling first.';

        try {
          const result = (await ctx.evalInApp(DEVTOOLS_START_EXPR)) as { ok?: boolean; count?: number; method?: string; error?: string } | null;
          if (result?.ok) {
            profilingMode = 'devtools-hook';
            const method = result.method === 'commit-hook' ? 'fiber commit hook (no DevTools backend required)' : `renderer.startProfiling (${result.count} renderer${result.count !== 1 ? 's' : ''})`;
            return `Profiling started via ${method}. Perform the interaction you want to measure, then call stop_profiling.`;
          }
          if (result?.error === 'no-hook') {
            ctx.logger.debug('React DevTools hook not found, trying CDP fallback');
          } else if (result?.error === 'no-hook-method') {
            ctx.logger.debug('DevTools hook found but onCommitFiberRoot unavailable, trying CDP fallback');
          }
        } catch (e) {
          ctx.logger.debug(`DevTools hook injection failed: ${e instanceof Error ? e.message : String(e)}`);
        }

        if (shouldSkipCdpFallback()) {
          return (
            'CPU profiling unavailable: __REACT_DEVTOOLS_GLOBAL_HOOK__ is not present in this JS environment. ' +
            'This can happen if the app has not yet rendered or is running in a context where React is not active.\n\n' +
            'Try calling any tool that interacts with the app first (e.g. get_component_tree), then retry start_profiling.'
          );
        }

        try {
          await ctx.cdp.send('Profiler.enable');
          await ctx.cdp.send('Profiler.setSamplingInterval', { interval: samplingInterval });
          await ctx.cdp.send('Profiler.start');
          profilingMode = 'cdp';
          return `Profiling started via CDP (sampling every ${samplingInterval} µs). Perform the interaction you want to measure, then call stop_profiling.`;
        } catch (cdpErr) {
          const msg = cdpErr instanceof Error ? cdpErr.message : String(cdpErr);
          if (!msg.includes('Unsupported method') && !msg.includes('not supported')) {
            return `Failed to start profiling: ${msg}`;
          }
        }

        try {
          await ctx.evalInApp(`console.profile(${JSON.stringify(CONSOLE_PROFILE_TITLE)})`);
          profilingMode = 'console';
          return 'Profiling started via console.profile(). Perform the interaction you want to measure, then call stop_profiling.';
        } catch (consoleErr) {
          return `Failed to start profiling: all paths exhausted — ${consoleErr instanceof Error ? consoleErr.message : String(consoleErr)}`;
        }
      },
    });

    ctx.registerTool('stop_profiling', {
      description:
        'Stop profiling and return an analysis of the captured data. ' +
        'DevTools hook mode: returns top components by total render duration across all commits. ' +
        'CDP mode: returns top JS functions by self time and total time. ' +
        'Must call start_profiling first.',
      parameters: z.object({
        topN: z.number().int().min(1).max(100).default(20)
          .describe('Number of top entries to return.'),
        includeNative: z.boolean().default(false)
          .describe('CDP mode only: include native/internal Hermes frames.'),
      }),
      handler: async ({ topN, includeNative }) => {
        if (profilingMode === null) return 'No profiling session in progress. Call start_profiling first.';

        try {
          if (profilingMode === 'devtools-hook') {
            const raw = (await ctx.evalInApp(DEVTOOLS_STOP_EXPR)) as DevToolsProfile | null;
            profilingMode = null;

            if (!raw || raw.length === 0) {
              return { mode: 'devtools-hook', commitCount: 0, message: 'No commits recorded — profiling window may be too short.' };
            }

            lastDevToolsProfile = raw;

            // Aggregate by component name
            const byName = new Map<string, { totalActual: number; totalSelf: number; commits: number }>();
            for (const commit of raw) {
              for (const comp of commit.components) {
                const e = byName.get(comp.name) ?? { totalActual: 0, totalSelf: 0, commits: 0 };
                e.totalActual += comp.actualMs; e.totalSelf += comp.selfMs; e.commits++;
                byName.set(comp.name, e);
              }
            }

            const topComponents = [...byName.entries()]
              .map(([name, s]) => ({ name, commits: s.commits, totalActualMs: parseFloat(s.totalActual.toFixed(2)), avgActualMs: parseFloat((s.totalActual / s.commits).toFixed(2)), avgSelfMs: parseFloat((s.totalSelf / s.commits).toFixed(2)) }))
              .sort((a, b) => b.totalActualMs - a.totalActualMs)
              .slice(0, topN);

            const totalDuration = raw.reduce((s, c) => s + c.duration, 0);
            return { mode: 'devtools-hook', commitCount: raw.length, totalDurationMs: parseFloat(totalDuration.toFixed(2)), topComponents };
          }

          // ── CDP / console ──────────────────────────────────────────────────
          let profile: CpuProfile;

          if (profilingMode === 'cdp') {
            const result = (await ctx.cdp.send('Profiler.stop')) as { profile: CpuProfile };
            await ctx.cdp.send('Profiler.disable').catch(() => {});
            profile = result.profile;
          } else {
            const profilePromise = new Promise<CpuProfile>((resolve, reject) => {
              const timer = setTimeout(() => {
                pendingConsoleProfile = null;
                reject(new Error('Timed out waiting for profileEnd data (10s).'));
              }, 10_000);
              pendingConsoleProfile = { resolve, reject, timer };
            });
            await ctx.evalInApp(`console.profileEnd(${JSON.stringify(CONSOLE_PROFILE_TITLE)})`);
            profile = await profilePromise;
          }

          profilingMode = null;
          lastCpuProfile = profile;
          lastCpuAnalysis = analyzeCpuProfile(profile, topN, includeNative);

          const { durationMs, sampleCount, topFunctions } = lastCpuAnalysis;
          if (sampleCount === 0) return { mode: 'cdp', durationMs, sampleCount: 0, message: 'No samples collected.', topFunctions: [] };

          return {
            mode: 'cdp',
            durationMs,
            sampleCount,
            samplingRateMs: parseFloat((durationMs / sampleCount).toFixed(3)),
            topFunctions: topFunctions.map((f) => ({
              functionName: f.functionName,
              location: f.url ? `${f.url}:${f.lineNumber}` : '(unknown)',
              selfTime: `${f.selfMs}ms (${f.selfPercent}%)`,
              totalTime: `${f.totalMs}ms (${f.totalPercent}%)`,
            })),
          };
        } catch (err) {
          profilingMode = null;
          return `Failed to stop profiling: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('get_profile_status', {
      description: 'Check whether profiling is active, which mode is in use, and whether a previous profile is available.',
      parameters: z.object({}),
      handler: async () => ({
        isProfiling: profilingMode !== null,
        profilingMode,
        hasDevToolsProfile: lastDevToolsProfile !== null,
        hasCpuProfile: lastCpuProfile !== null,
        lastDevToolsCommits: lastDevToolsProfile?.length ?? null,
        lastCpuDurationMs: lastCpuProfile ? parseFloat(((lastCpuProfile.endTime - lastCpuProfile.startTime) / 1000).toFixed(2)) : null,
        newArchitectureMode: newArchitecture,
      }),
    });

    ctx.registerTool('get_flamegraph', {
      description:
        'Return the current profiling results as a human-readable text chart. ' +
        'Shows React DevTools component profile (if captured), CPU flamegraph (if CDP profile captured), ' +
        'and React render data from <Profiler> components (if set up). ' +
        'Call stop_profiling first to populate the profile data.',
      parameters: z.object({}),
      handler: buildFlamegraphText,
    });

    ctx.registerTool('get_react_renders', {
      description:
        'Read React render timing data collected via <Profiler onRender={trackRender}>. ' +
        'Returns all recorded renders sorted by actualDuration descending, with memoization savings from baseDuration. ' +
        'Requires importing trackRender from metro-mcp/client. Use clear=true to reset the buffer.',
      parameters: z.object({
        clear: z.boolean().default(false).describe('Clear the render buffer after reading.'),
      }),
      handler: async ({ clear }) => {
        try {
          const raw = (await ctx.evalInApp(clear ? READ_AND_CLEAR_EXPR : READ_RENDERS_EXPR)) as RenderRecord[] | null;
          if (!raw) return NOT_SETUP_MSG;
          if (raw.length === 0) return clear ? 'Render buffer cleared (was already empty).' : 'No renders recorded yet.';
          return [...raw].sort((a, b) => b.actualDuration - a.actualDuration).map((r) => ({
            id: r.id, phase: r.phase,
            actualDuration: parseFloat(r.actualDuration.toFixed(2)),
            baseDuration: parseFloat(r.baseDuration.toFixed(2)),
            memoSavingsPercent: memoSavings(r),
            startTime: r.startTime, commitTime: r.commitTime,
          }));
        } catch (err) {
          return `Failed to read render data: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('get_memory_info', {
      description:
        'Get current JavaScript heap memory usage from the running app. ' +
        'Returns used heap, total heap, and heap size limit (when available). ' +
        'Call repeatedly to track memory growth over time or to detect leaks.',
      parameters: z.object({}),
      handler: async () => {
        const result = (await ctx.evalInApp(`(function() {
          try {
            if (typeof performance !== 'undefined' && performance.memory) {
              var m = performance.memory;
              return { source: 'performance.memory', usedJSHeapSize: m.usedJSHeapSize, totalJSHeapSize: m.totalJSHeapSize, jsHeapSizeLimit: m.jsHeapSizeLimit };
            }
          } catch(e) {}
          try {
            if (typeof process !== 'undefined' && process.memoryUsage) {
              var p = process.memoryUsage();
              return { source: 'process.memoryUsage', usedJSHeapSize: p.heapUsed, totalJSHeapSize: p.heapTotal, jsHeapSizeLimit: null, rss: p.rss, external: p.external };
            }
          } catch(e) {}
          return null;
        })()`)) as Record<string, unknown> | null;

        if (!result) {
          return 'Memory info not available: neither performance.memory nor process.memoryUsage is accessible in this runtime.';
        }

        const fmt = (n: unknown) => typeof n === 'number' ? `${(n / 1024 / 1024).toFixed(2)} MB` : null;
        return {
          source: result.source,
          usedHeap: fmt(result.usedJSHeapSize),
          totalHeap: fmt(result.totalJSHeapSize),
          heapLimit: fmt(result.jsHeapSizeLimit),
          rss: fmt(result.rss),
          ...(typeof result.usedJSHeapSize === 'number' && typeof result.totalJSHeapSize === 'number'
            ? { usedPercent: `${((result.usedJSHeapSize as number) / (result.totalJSHeapSize as number) * 100).toFixed(1)}%` }
            : {}),
        };
      },
    });

    ctx.registerTool('profile_action', {
      description:
        'Profile a specific JavaScript expression or code path in a single call. ' +
        'Starts profiling, evaluates the expression, waits for it to complete (plus optional extra duration), ' +
        'then stops and returns the top functions by self time. ' +
        'Use instead of calling start_profiling / stop_profiling manually for focused measurements.',
      parameters: z.object({
        expression: z.string()
          .describe('JavaScript expression to profile (can be an async IIFE)'),
        extraMs: z.number().int().min(0).max(30000).default(0)
          .describe('Additional milliseconds to wait after the expression resolves before stopping (default 0)'),
        topN: z.number().int().min(1).max(50).default(15)
          .describe('Number of top functions to return'),
      }),
      handler: async ({ expression, extraMs, topN }) => {
        if (profilingMode !== null) {
          return 'A profiling session is already active. Call stop_profiling first.';
        }

        // Start
        let startedMode: ProfilingMode = null;
        try {
          const r = (await ctx.evalInApp(DEVTOOLS_START_EXPR)) as { ok?: boolean; method?: string } | null;
          if (r?.ok) startedMode = 'devtools-hook';
        } catch { /* try CDP fallback */ }

        if (!startedMode && !shouldSkipCdpFallback()) {
          try {
            await ctx.cdp.send('Profiler.enable');
            await ctx.cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
            await ctx.cdp.send('Profiler.start');
            startedMode = 'cdp';
          } catch { /* ignore */ }
        }

        if (!startedMode) {
          return 'Could not start profiling: React DevTools hook not available and CDP Profiler domain not supported.';
        }

        profilingMode = startedMode;

        // Evaluate expression
        try {
          await ctx.evalInApp(expression, { awaitPromise: true, timeout: 30000 });
        } catch (err) {
          // Don't abort — still stop and return profile even if expression errored
          ctx.logger.debug(`profile_action expression error: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Extra wait
        if (extraMs > 0) {
          await new Promise<void>((r) => setTimeout(r, extraMs));
        }

        // Stop — reuse stop_profiling logic inline
        try {
          if (profilingMode === 'devtools-hook') {
            const raw = (await ctx.evalInApp(DEVTOOLS_STOP_EXPR)) as DevToolsProfile | null;
            profilingMode = null;
            if (!raw || raw.length === 0) {
              return { mode: 'devtools-hook', commitCount: 0, message: 'No commits recorded — expression may have been too fast.' };
            }
            lastDevToolsProfile = raw;
            const byName = new Map<string, { totalActual: number; commits: number }>();
            for (const commit of raw) {
              for (const comp of commit.components) {
                const e = byName.get(comp.name) ?? { totalActual: 0, commits: 0 };
                e.totalActual += comp.actualMs; e.commits++;
                byName.set(comp.name, e);
              }
            }
            const topComponents = [...byName.entries()]
              .map(([name, s]) => ({ name, commits: s.commits, totalActualMs: parseFloat(s.totalActual.toFixed(2)), avgActualMs: parseFloat((s.totalActual / s.commits).toFixed(2)) }))
              .sort((a, b) => b.totalActualMs - a.totalActualMs)
              .slice(0, topN);
            return { mode: 'devtools-hook', commitCount: raw.length, topComponents };
          }

          const result = (await ctx.cdp.send('Profiler.stop')) as { profile: CpuProfile };
          await ctx.cdp.send('Profiler.disable').catch(() => {});
          profilingMode = null;
          lastCpuProfile = result.profile;
          lastCpuAnalysis = analyzeCpuProfile(result.profile, topN, false);
          const { durationMs, sampleCount, topFunctions } = lastCpuAnalysis;
          return {
            mode: 'cdp',
            durationMs,
            sampleCount,
            topFunctions: topFunctions.map((f) => ({
              functionName: f.functionName,
              location: f.url ? `${f.url}:${f.lineNumber}` : '(unknown)',
              selfTime: `${f.selfMs}ms (${f.selfPercent}%)`,
              totalTime: `${f.totalMs}ms (${f.totalPercent}%)`,
            })),
          };
        } catch (err) {
          profilingMode = null;
          return `Profiling stopped but analysis failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('start_heap_sampling', {
      description:
        'Start Hermes heap allocation sampling via CDP HeapProfiler. ' +
        'Records memory allocation call stacks to identify where objects are being allocated. ' +
        'Call stop_heap_sampling to retrieve the top allocation sites.',
      parameters: z.object({
        samplingInterval: z.number().int().min(128).max(1048576).default(32768)
          .describe('Average bytes between samples (default 32768). Lower = more detail, higher overhead.'),
      }),
      handler: async ({ samplingInterval }) => {
        try {
          await ctx.cdp.send('HeapProfiler.enable').catch(() => {});
          await ctx.cdp.send('HeapProfiler.startSampling', { samplingInterval });
          return `Heap sampling started (interval: ${samplingInterval} bytes). Reproduce the memory-intensive operation, then call stop_heap_sampling.`;
        } catch (err) {
          return `Failed to start heap sampling: ${err instanceof Error ? err.message : String(err)}. HeapProfiler may not be supported by this Hermes version.`;
        }
      },
    });

    ctx.registerTool('stop_heap_sampling', {
      description:
        'Stop heap allocation sampling and return the top allocation sites. ' +
        'Shows which functions are allocating the most memory, useful for diagnosing memory leaks. ' +
        'Must call start_heap_sampling first.',
      parameters: z.object({
        topN: z.number().int().min(1).max(100).default(20)
          .describe('Number of top allocation sites to return'),
      }),
      handler: async ({ topN }) => {
        interface SamplingHeapProfileNode {
          callFrame: { functionName: string; url: string; lineNumber: number };
          selfSize: number;
          children?: SamplingHeapProfileNode[];
        }
        interface SamplingHeapProfile {
          head: SamplingHeapProfileNode;
        }

        let profile: SamplingHeapProfile;
        try {
          const result = (await ctx.cdp.send('HeapProfiler.stopSampling')) as { profile: SamplingHeapProfile };
          await ctx.cdp.send('HeapProfiler.disable').catch(() => {});
          profile = result.profile;
        } catch (err) {
          return `Failed to stop heap sampling: ${err instanceof Error ? err.message : String(err)}`;
        }

        // Flatten the tree and aggregate by function
        const siteMap = new Map<string, { functionName: string; url: string; line: number; totalBytes: number }>();

        function walkNode(node: SamplingHeapProfileNode): void {
          if (node.selfSize > 0) {
            const fnName = node.callFrame.functionName || '(anonymous)';
            const url = node.callFrame.url ?? '';
            const key = `${fnName}|${url}|${node.callFrame.lineNumber}`;
            const existing = siteMap.get(key) ?? { functionName: fnName, url, line: node.callFrame.lineNumber + 1, totalBytes: 0 };
            existing.totalBytes += node.selfSize;
            siteMap.set(key, existing);
          }
          for (const child of node.children ?? []) walkNode(child);
        }

        walkNode(profile.head);

        const sites = [...siteMap.values()]
          .sort((a, b) => b.totalBytes - a.totalBytes)
          .slice(0, topN)
          .map((s) => ({
            functionName: s.functionName,
            location: s.url ? `${s.url}:${s.line}` : '(unknown)',
            allocatedKB: parseFloat((s.totalBytes / 1024).toFixed(2)),
          }));

        const totalKB = [...siteMap.values()].reduce((sum, s) => sum + s.totalBytes, 0) / 1024;
        return { totalSampledKB: parseFloat(totalKB.toFixed(2)), topAllocationSites: sites };
      },
    });

    // ── Resources ─────────────────────────────────────────────────────────────

    ctx.registerResource('metro://profiler/flamegraph', {
      name: 'profiler-flamegraph',
      description: 'Human-readable profiling output: React DevTools component chart or CPU flamegraph, plus React render chart from <Profiler> components.',
      mimeType: 'text/plain',
      handler: buildFlamegraphText,
    });

    ctx.registerResource('metro://profiler/data', {
      name: 'profiler-data',
      description: 'Raw JSON profiling data: React DevTools commit data or CDP Profile object, plus React render records.',
      mimeType: 'application/json',
      handler: async () => {
        let renders: RenderRecord[] = [];
        try {
          const raw = (await ctx.evalInApp(READ_RENDERS_EXPR)) as RenderRecord[] | null;
          if (Array.isArray(raw)) renders = raw;
        } catch { /* renders stays empty */ }

        return JSON.stringify({
          mode: lastDevToolsProfile ? 'devtools-hook' : lastCpuProfile ? 'cdp' : null,
          devtools: lastDevToolsProfile ?? null,
          cpu: lastCpuProfile && lastCpuAnalysis ? {
            durationMs: lastCpuAnalysis.durationMs,
            sampleCount: lastCpuAnalysis.sampleCount,
            nodes: lastCpuProfile.nodes,
            samples: lastCpuProfile.samples,
            timeDeltas: lastCpuProfile.timeDeltas,
            analysis: { topFunctions: lastCpuAnalysis.topFunctions },
          } : null,
          renders: renders.map((r) => ({ ...r, memoSavingsPercent: memoSavings(r) })),
        }, null, 2);
      },
    });
  },
});
