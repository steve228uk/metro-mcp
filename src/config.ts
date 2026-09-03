import fs from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { MetroMCPConfig } from './plugin.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('config');

const DEFAULT_CONFIG: Required<MetroMCPConfig> = {
  projectRoot: '',
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
  input: {
    nativeBackend: 'auto',
  },
};

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/** Resolve and validate the one project this metro-mcp process serves. */
export function resolveProjectRoot(
  args: string[] = [],
  baseDir = process.cwd(),
): string {
  const configured =
    valueAfter(args, '--project-root') ?? process.env.METRO_MCP_PROJECT_ROOT;
  const candidate = resolve(baseDir, configured ?? '.');

  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidate);
  } catch {
    throw new Error(
      `Invalid Metro MCP project root "${candidate}": the path does not exist. ` +
        `Pass --project-root <directory> or set METRO_MCP_PROJECT_ROOT to an existing directory.`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `Invalid Metro MCP project root "${candidate}": the path is not a directory. ` +
        `Pass --project-root <directory> or set METRO_MCP_PROJECT_ROOT to a directory.`,
    );
  }

  return fs.realpathSync(candidate);
}

function resolveConfigPath(value: string, projectRoot: string): string {
  return fs.realpathSync(
    isAbsolute(value) ? value : resolve(projectRoot, value),
  );
}

function resolvePluginPath(value: string, projectRoot: string): string {
  if (
    isAbsolute(value) ||
    value === '.' ||
    value === '..' ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('.\\') ||
    value.startsWith('..\\')
  ) {
    return resolve(projectRoot, value);
  }
  return value;
}

/**
 * Load configuration from environment variables, CLI args, and config file.
 * Relative config and local plugin paths are always rooted at the effective
 * project root, never at the launcher's incidental working directory.
 */
export async function loadConfig(
  args: string[],
  rootPath?: string,
): Promise<Required<MetroMCPConfig>> {
  const projectRoot = resolveProjectRoot(args, rootPath ?? process.cwd());
  const config = structuredClone(DEFAULT_CONFIG);
  config.projectRoot = projectRoot;

  if (process.env.METRO_HOST) config.metro.host = process.env.METRO_HOST;
  if (process.env.METRO_PORT) {
    const port = parseInt(process.env.METRO_PORT, 10);
    if (!Number.isNaN(port)) {
      config.metro.port = port;
      config.metro.autoDiscover = false;
    }
  }
  if (process.env.METRO_MCP_PROXY_PORT) {
    const port = parseInt(process.env.METRO_MCP_PROXY_PORT, 10);
    if (!Number.isNaN(port)) config.proxy.port = port;
  }
  if (process.env.METRO_MCP_PROXY_ENABLED === 'false')
    config.proxy.enabled = false;

  let configFilePath: string | undefined;
  const extraPlugins: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--host' || arg === '-H') && args[i + 1]) {
      config.metro.host = args[++i];
    } else if ((arg === '--port' || arg === '-p') && args[i + 1]) {
      const port = parseInt(args[++i], 10);
      if (!Number.isNaN(port)) {
        config.metro.port = port;
        config.metro.autoDiscover = false;
      }
    } else if ((arg === '--config' || arg === '-c') && args[i + 1]) {
      configFilePath = args[++i];
    } else if (arg === '--plugin' && args[i + 1]) {
      extraPlugins.push(args[++i]);
    }
  }

  if (!configFilePath && process.env.METRO_MCP_CONFIG)
    configFilePath = process.env.METRO_MCP_CONFIG;
  if (process.env.METRO_MCP_PLUGINS) {
    extraPlugins.push(
      ...process.env.METRO_MCP_PLUGINS.split(':').filter(Boolean),
    );
  }

  logger.debug(`Project root: ${projectRoot}`);

  if (configFilePath) {
    const fullPath = resolveConfigPath(configFilePath, projectRoot);
    try {
      const mod = await import(fullPath);
      const fileConfig: MetroMCPConfig = mod.default || mod;
      mergeConfig(config, fileConfig);
      logger.info(`Loaded config from ${fullPath}`);
    } catch (err) {
      throw new Error(`Failed to load config from ${fullPath}: ${err}`);
    }
  } else {
    for (const configPath of ['metro-mcp.config.ts', 'metro-mcp.config.js']) {
      const fullPath = resolve(projectRoot, configPath);
      if (!fs.existsSync(fullPath)) continue;
      try {
        const mod = await import(fullPath);
        const fileConfig: MetroMCPConfig = mod.default || mod;
        mergeConfig(config, fileConfig);
        logger.info(`Loaded config from ${fullPath}`);
        break;
      } catch (err) {
        throw new Error(`Failed to load config from ${fullPath}: ${err}`);
      }
    }
  }

  config.projectRoot = projectRoot;
  config.plugins = [...config.plugins, ...extraPlugins].map((plugin) =>
    resolvePluginPath(plugin, projectRoot),
  );
  return config;
}

function mergeConfig(
  target: Required<MetroMCPConfig>,
  source: MetroMCPConfig,
): void {
  if (source.projectRoot !== undefined) {
    throw new Error(
      'projectRoot is controlled by --project-root or METRO_MCP_PROJECT_ROOT and cannot be set in a config file',
    );
  }
  if (source.metro) {
    if (source.metro.host !== undefined) target.metro.host = source.metro.host;
    if (source.metro.port !== undefined) {
      target.metro.port = source.metro.port;
      target.metro.autoDiscover = false;
    }
    if (source.metro.autoDiscover !== undefined)
      target.metro.autoDiscover = source.metro.autoDiscover;
  }
  if (source.plugins) target.plugins = source.plugins;
  if (source.bufferSizes) {
    if (source.bufferSizes.logs !== undefined)
      target.bufferSizes.logs = source.bufferSizes.logs;
    if (source.bufferSizes.network !== undefined)
      target.bufferSizes.network = source.bufferSizes.network;
    if (source.bufferSizes.errors !== undefined)
      target.bufferSizes.errors = source.bufferSizes.errors;
  }
  if (source.profiler?.newArchitecture !== undefined)
    target.profiler.newArchitecture = source.profiler.newArchitecture;
  if (source.proxy) {
    if (source.proxy.enabled !== undefined)
      target.proxy.enabled = source.proxy.enabled;
    if (source.proxy.port !== undefined) target.proxy.port = source.proxy.port;
  }
  if (source.input) {
    if (source.input.nativeBackend !== undefined)
      target.input.nativeBackend = source.input.nativeBackend;
    if (source.input.simviewCommand !== undefined)
      target.input.simviewCommand = source.input.simviewCommand;
    if (source.input.idbCommand !== undefined)
      target.input.idbCommand = source.input.idbCommand;
  }
}
