#!/usr/bin/env bun
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
  --host, -H <host>    Metro host (default: localhost, env: METRO_HOST)
  --port, -p <port>    Metro port (default: 8081, env: METRO_PORT)
  --intercept-fetch    Enable fetch interception for network tracking
  --help               Show this help message

Environment Variables:
  METRO_HOST           Metro bundler host
  METRO_PORT           Metro bundler port
  DEBUG                Enable debug logging

Examples:
  metro-mcp
  metro-mcp --port 19000
  METRO_PORT=8082 metro-mcp
`);
    process.exit(0);
  }

  try {
    const config = await loadConfig(args);
    logger.info(`Starting metro-mcp (Metro: ${config.metro.host}:${config.metro.port})`);
    await startServer(config);
  } catch (err) {
    logger.error('Fatal error:', err);
    process.exit(1);
  }
}

main();
