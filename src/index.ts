#!/usr/bin/env node
import { loadConfig } from './config.js';
import { startServer } from './server.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('main');

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.error(`
metro-mcp — React Native MCP Server

Usage:
  metro-mcp [options]

Options:
  --host, -H <host>       Metro host (default: localhost, env: METRO_HOST)
  --port, -p <port>       Metro port (default: 8081, env: METRO_PORT)
  --config, -c <path>     Path to config file (env: METRO_MCP_CONFIG)
  --plugin <path>         Load a plugin (repeatable, env: METRO_MCP_PLUGINS)
  --help                  Show this help message

Environment Variables:
  METRO_HOST              Metro bundler host
  METRO_PORT              Metro bundler port
  METRO_MCP_CONFIG        Path to config file (absolute or relative to CWD)
  METRO_MCP_PLUGINS       Colon-separated plugin paths
  DEBUG                   Enable debug logging

Examples:
  metro-mcp
  metro-mcp --port 19000
  metro-mcp --config /path/to/metro-mcp.config.ts
  METRO_MCP_CONFIG=/path/to/metro-mcp.config.ts metro-mcp
  METRO_PORT=8082 metro-mcp
`);
    process.exit(0);
  }

  try {
    const config = await loadConfig(args);
    logger.info(`Starting metro-mcp (Metro: ${config.metro.host}:${config.metro.port})`);
    await startServer(config, args);
  } catch (err) {
    logger.error('Fatal error:', err);
    process.exit(1);
  }
}

main();
