import type { MetroMCPConfig } from './plugin.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('config');

const DEFAULT_CONFIG: Required<MetroMCPConfig> = {
  metro: {
    host: 'localhost',
    port: 8081,
    autoDiscover: true,
  },
  plugins: [],
  bufferSizes: {
    logs: 500,
    network: 200,
    errors: 100,
  },
  network: {
    interceptFetch: false,
  },
  profiler: {
    newArchitecture: true,
  },
};

/**
 * Load configuration from environment variables, CLI args, and config file.
 */
export async function loadConfig(args: string[]): Promise<Required<MetroMCPConfig>> {
  const config = structuredClone(DEFAULT_CONFIG);

  // Environment variables
  if (process.env.METRO_HOST) {
    config.metro.host = process.env.METRO_HOST;
  }
  if (process.env.METRO_PORT) {
    const port = parseInt(process.env.METRO_PORT, 10);
    if (!isNaN(port)) {
      config.metro.port = port;
      config.metro.autoDiscover = false;
    }
  }

  // CLI args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--host' || arg === '-h') && args[i + 1]) {
      config.metro.host = args[++i];
    } else if ((arg === '--port' || arg === '-p') && args[i + 1]) {
      const port = parseInt(args[++i], 10);
      if (!isNaN(port)) {
        config.metro.port = port;
        config.metro.autoDiscover = false;
      }
    } else if (arg === '--intercept-fetch') {
      config.network.interceptFetch = true;
    }
  }

  // Try to load config file
  const configPaths = ['metro-mcp.config.ts', 'metro-mcp.config.js'];
  for (const configPath of configPaths) {
    try {
      const fullPath = `${process.cwd()}/${configPath}`;
      const file = Bun.file(fullPath);
      if (await file.exists()) {
        const mod = await import(fullPath);
        const fileConfig: MetroMCPConfig = mod.default || mod;
        mergeConfig(config, fileConfig);
        logger.info(`Loaded config from ${configPath}`);
        break;
      }
    } catch {
      // Config file not found or invalid, continue
    }
  }

  return config;
}

function mergeConfig(target: Required<MetroMCPConfig>, source: MetroMCPConfig): void {
  if (source.metro) {
    if (source.metro.host !== undefined) target.metro.host = source.metro.host;
    if (source.metro.port !== undefined) {
      target.metro.port = source.metro.port;
      target.metro.autoDiscover = false;
    }
    if (source.metro.autoDiscover !== undefined) target.metro.autoDiscover = source.metro.autoDiscover;
  }
  if (source.plugins) target.plugins = source.plugins;
  if (source.bufferSizes) {
    if (source.bufferSizes.logs !== undefined) target.bufferSizes.logs = source.bufferSizes.logs;
    if (source.bufferSizes.network !== undefined) target.bufferSizes.network = source.bufferSizes.network;
    if (source.bufferSizes.errors !== undefined) target.bufferSizes.errors = source.bufferSizes.errors;
  }
  if (source.network) {
    if (source.network.interceptFetch !== undefined) target.network.interceptFetch = source.network.interceptFetch;
  }
  if (source.profiler) {
    if (source.profiler.newArchitecture !== undefined) target.profiler.newArchitecture = source.profiler.newArchitecture;
  }
}
