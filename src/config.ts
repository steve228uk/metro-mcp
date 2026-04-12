import { resolve } from 'node:path';
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
  profiler: {
    newArchitecture: true,
  },
  proxy: {
    enabled: true,
    port: 0,
  },
};

/**
 * Load configuration from environment variables, CLI args, and config file.
 * @param rootPath - Directory to search for a config file. Overrides CWD for
 *   auto-discovery but is ignored when an explicit --config / METRO_MCP_CONFIG path
 *   is provided.
 */
export async function loadConfig(args: string[], rootPath?: string): Promise<Required<MetroMCPConfig>> {
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

  if (process.env.METRO_MCP_PROXY_PORT) {
    const port = parseInt(process.env.METRO_MCP_PROXY_PORT, 10);
    if (!isNaN(port)) config.proxy.port = port;
  }
  if (process.env.METRO_MCP_PROXY_ENABLED === 'false') {
    config.proxy.enabled = false;
  }

  // CLI args
  let configFilePath: string | undefined;
  const extraPlugins: string[] = [];

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
    } else if ((arg === '--config' || arg === '-c') && args[i + 1]) {
      configFilePath = args[++i];
    } else if (arg === '--plugin' && args[i + 1]) {
      extraPlugins.push(args[++i]);
    }
  }

  // Env var fallbacks (CLI flags take precedence)
  if (!configFilePath && process.env.METRO_MCP_CONFIG) {
    configFilePath = process.env.METRO_MCP_CONFIG;
  }
  if (process.env.METRO_MCP_PLUGINS) {
    extraPlugins.push(...process.env.METRO_MCP_PLUGINS.split(':').filter(Boolean));
  }

  // Load config file
  const cwd = rootPath ?? process.cwd();
  logger.debug(`Config search CWD: ${cwd}`);

  if (configFilePath) {
    // Explicit path — throw on failure (user asserted this file exists)
    const fullPath = resolve(cwd, configFilePath);
    try {
      const mod = await import(fullPath);
      const fileConfig: MetroMCPConfig = mod.default || mod;
      mergeConfig(config, fileConfig);
      logger.info(`Loaded config from ${fullPath}`);
    } catch (err) {
      throw new Error(`Failed to load config from ${fullPath}: ${err}`);
    }
  } else {
    // Auto-discover from CWD
    // Note: .ts files only load under Bun runtime; use .js with npx/Node.js
    const configPaths = ['metro-mcp.config.ts', 'metro-mcp.config.js'];
    for (const configPath of configPaths) {
      try {
        const fullPath = resolve(cwd, configPath);
        const mod = await import(fullPath);
        const fileConfig: MetroMCPConfig = mod.default || mod;
        mergeConfig(config, fileConfig);
        logger.info(`Loaded config from ${fullPath}`);
        break;
      } catch {
        // Config file not found or invalid, continue
      }
    }
  }

  // Append any plugins from CLI/env (additive — supplements config file plugins)
  if (extraPlugins.length > 0) {
    config.plugins = [...config.plugins, ...extraPlugins];
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
  if (source.profiler) {
    if (source.profiler.newArchitecture !== undefined) target.profiler.newArchitecture = source.profiler.newArchitecture;
  }
  if (source.proxy) {
    if (source.proxy.enabled !== undefined) target.proxy.enabled = source.proxy.enabled;
    if (source.proxy.port !== undefined) target.proxy.port = source.proxy.port;
  }
}
