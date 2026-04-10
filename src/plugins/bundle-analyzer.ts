import { z } from 'zod';
import { definePlugin } from '../plugin.js';

interface ModuleEntry {
  name: string;
  size: number;
  deps?: string[];
  dependents?: string[];
}

interface ParsedStats {
  modules: ModuleEntry[];
  totalSize: number;
  fetchedAt: number;
  platform: string;
  source: 'stats-json' | 'bundle-parse';
}

type StatsCache = Map<string, ParsedStats>;

// Metro stats.json shape (simplified)
interface MetroStatsModule {
  name: string;
  size?: number;
  deps?: string[];
  inverseDeps?: string[];
}

interface MetroStats {
  modules?: MetroStatsModule[];
  [key: string]: unknown;
}

function parseMetroStats(json: MetroStats, platform: string): ParsedStats {
  const modules: ModuleEntry[] = (json.modules ?? []).map((m) => ({
    name: m.name,
    size: m.size ?? 0,
    deps: m.deps ?? [],
    dependents: m.inverseDeps ?? [],
  }));
  const totalSize = modules.reduce((sum, m) => sum + m.size, 0);
  return { modules, totalSize, fetchedAt: Date.now(), platform, source: 'stats-json' };
}

// Fallback: parse module names from Metro bundle using __d() wrapper regex
function parseBundleSource(source: string, platform: string): ParsedStats {
  const modulePattern = /__d\(function[^,]*,[^,]*,["']([^"']+)["']/g;
  const modules: ModuleEntry[] = [];
  let match: RegExpExecArray | null;
  let lastIndex = 0;

  const positions: Array<{ name: string; start: number }> = [];
  while ((match = modulePattern.exec(source)) !== null) {
    positions.push({ name: match[1], start: match.index });
  }

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].start;
    const end = i + 1 < positions.length ? positions[i + 1].start : source.length;
    modules.push({ name: positions[i].name, size: end - start });
    lastIndex = end;
  }

  const totalSize = modules.reduce((sum, m) => sum + m.size, 0);
  return { modules, totalSize, fetchedAt: Date.now(), platform, source: 'bundle-parse' };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function summarizeModule(m: ModuleEntry, totalSize: number) {
  return {
    name: m.name,
    sizeBytes: m.size,
    sizeFormatted: formatBytes(m.size),
    sizePercent: totalSize > 0 ? parseFloat(((m.size / totalSize) * 100).toFixed(2)) : 0,
  };
}

export const bundleAnalyzerPlugin = definePlugin({
  name: 'bundle-analyzer',
  description:
    "Analyze Metro bundle composition to surface the largest modules by size. Uses Metro's /stats.json endpoint.",

  async setup(ctx) {
    const cache: StatsCache = new Map();

    // Invalidate cache when the bundle reloads
    ctx.cdp.on('Runtime.executionContextCreated', () => {
      cache.clear();
    });

    async function fetchStats(platform: string, refresh: boolean): Promise<ParsedStats> {
      const cacheKey = platform;
      if (!refresh && cache.has(cacheKey)) {
        return cache.get(cacheKey)!;
      }

      // Try /stats.json first
      try {
        const response = await ctx.metro.fetch(`/stats.json?platform=${platform}`);
        if (response.ok) {
          const json = (await response.json()) as MetroStats;
          if (json.modules && Array.isArray(json.modules) && json.modules.length > 0) {
            const stats = parseMetroStats(json, platform);
            cache.set(cacheKey, stats);
            return stats;
          }
        }
      } catch {
        // Fall through to bundle parse
      }

      // Fallback: fetch raw bundle and parse __d() wrappers
      // Use minify=false so module names are preserved
      const bundleResponse = await ctx.metro.fetch(
        `/index.bundle?platform=${platform}&dev=false&minify=false`
      );
      if (!bundleResponse.ok) {
        throw new Error(
          `Metro returned ${bundleResponse.status} for bundle request. ` +
          'Ensure Metro is running and the app has been bundled at least once. ' +
          'For /stats.json, enable bundleStats in your Metro config.'
        );
      }
      const source = await bundleResponse.text();
      const stats = parseBundleSource(source, platform);
      cache.set(cacheKey, stats);
      return stats;
    }

    ctx.registerTool('get_bundle_stats', {
      description:
        'Get an overview of the Metro bundle: total size, module count, and the largest modules. ' +
        'Uses /stats.json if available, otherwise falls back to parsing the raw bundle. ' +
        'Enable bundleStats in Metro config for more accurate dependency information.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        platform: z
          .enum(['ios', 'android'])
          .default('ios')
          .describe("Target platform for the bundle (default: 'ios')"),
        topN: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('Number of largest modules to return (default 20)'),
        refresh: z
          .boolean()
          .default(false)
          .describe('Force re-fetch even if cached stats are available'),
      }),
      handler: async ({ platform, topN, refresh }) => {
        try {
          const stats = await fetchStats(platform, refresh);
          const sorted = [...stats.modules].sort((a, b) => b.size - a.size);
          return {
            platform,
            source: stats.source,
            totalModules: stats.modules.length,
            totalSize: formatBytes(stats.totalSize),
            totalSizeBytes: stats.totalSize,
            fetchedAt: new Date(stats.fetchedAt).toISOString(),
            topModules: sorted.slice(0, topN).map((m) => summarizeModule(m, stats.totalSize)),
          };
        } catch (err) {
          return `Failed to analyze bundle: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('find_large_modules', {
      description:
        'Find all modules in the bundle that exceed a size threshold. ' +
        'Useful for identifying candidates for lazy loading or code splitting.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        minSizeKB: z
          .number()
          .min(0.1)
          .default(10)
          .describe('Minimum module size in kilobytes (default 10 KB)'),
        platform: z.enum(['ios', 'android']).default('ios'),
        refresh: z.boolean().default(false),
      }),
      handler: async ({ minSizeKB, platform, refresh }) => {
        try {
          const stats = await fetchStats(platform, refresh);
          const minBytes = minSizeKB * 1024;
          const large = stats.modules
            .filter((m) => m.size >= minBytes)
            .sort((a, b) => b.size - a.size)
            .map((m) => summarizeModule(m, stats.totalSize));

          return {
            platform,
            threshold: `${minSizeKB} KB`,
            count: large.length,
            totalSize: formatBytes(large.reduce((s, m) => s + m.sizeBytes, 0)),
            modules: large,
          };
        } catch (err) {
          return `Failed to find large modules: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('get_module_info', {
      description:
        'Get detailed information about a specific module including its size, dependencies, and dependents. ' +
        'Use a partial name for substring matching. Dependency info requires /stats.json to be available.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        moduleName: z
          .string()
          .describe('Module name or partial name to search for (substring match)'),
        platform: z.enum(['ios', 'android']).default('ios'),
        refresh: z.boolean().default(false),
      }),
      handler: async ({ moduleName, platform, refresh }) => {
        try {
          const stats = await fetchStats(platform, refresh);
          const lower = moduleName.toLowerCase();
          const matches = stats.modules.filter((m) => m.name.toLowerCase().includes(lower));

          if (matches.length === 0) {
            return `No module matching "${moduleName}" found in the bundle.`;
          }

          return matches.slice(0, 10).map((m) => ({
            ...summarizeModule(m, stats.totalSize),
            dependencyCount: m.deps?.length ?? null,
            dependentCount: m.dependents?.length ?? null,
            deps: m.deps?.slice(0, 20) ?? null,
            dependents: m.dependents?.slice(0, 20) ?? null,
            note:
              stats.source === 'bundle-parse'
                ? 'Dependency info not available (enable bundleStats in Metro config for /stats.json)'
                : undefined,
          }));
        } catch (err) {
          return `Failed to get module info: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('get_bundle_summary', {
      description:
        'Get a concise summary of the bundle: total size, module count, and top 5 largest modules. ' +
        'Quick overview before diving into get_bundle_stats or find_large_modules.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        platform: z.enum(['ios', 'android']).default('ios'),
        refresh: z.boolean().default(false),
      }),
      handler: async ({ platform, refresh }) => {
        try {
          const stats = await fetchStats(platform, refresh);
          const sorted = [...stats.modules].sort((a, b) => b.size - a.size);
          const top5 = sorted.slice(0, 5).map((m) => summarizeModule(m, stats.totalSize));

          // Top by dependent count (if available)
          const top5ByDeps = stats.source === 'stats-json'
            ? [...stats.modules]
                .sort((a, b) => (b.dependents?.length ?? 0) - (a.dependents?.length ?? 0))
                .slice(0, 5)
                .map((m) => ({ name: m.name, dependentCount: m.dependents?.length ?? 0 }))
            : null;

          return {
            platform,
            source: stats.source,
            totalModules: stats.modules.length,
            totalSize: formatBytes(stats.totalSize),
            top5BySize: top5,
            top5ByDependents: top5ByDeps,
          };
        } catch (err) {
          return `Failed to get bundle summary: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
  },
});
