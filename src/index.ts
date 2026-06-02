#!/usr/bin/env node
import { loadConfig } from './config.js';
import { startHttpServer, startServer } from './server.js';
import { getDaemonKeyFromEnv, startStdioProxy, writeDaemonRecord } from './daemon.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('main');

async function main() {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (subcommand === 'create-plugin') {
    const { runCreatePlugin } = await import('./commands/create-plugin.js');
    await runCreatePlugin();
    process.exit(0);
  }

  if (subcommand === 'init') {
    const { runInit } = await import('./commands/init.js');
    await runInit();
    process.exit(0);
  }

  if (subcommand === 'doctor') {
    const { runDoctor } = await import('./commands/doctor.js');
    await runDoctor();
    process.exit(0);
  }

  if (subcommand === 'validate-plugin') {
    const { runValidatePlugin } = await import('./commands/validate-plugin.js');
    await runValidatePlugin(args[1]);
    process.exit(0);
  }

  const serverArgs = subcommand === 'serve' ? args.slice(1) : args;

  // Catch unknown subcommands (args that look like commands, not flags)
  if (subcommand && subcommand !== 'serve' && !subcommand.startsWith('-')) {
    console.error(`Unknown command: ${subcommand}\nRun \`metro-mcp --help\` for usage.`);
    process.exit(1);
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.error(`
metro-mcp — React Native MCP Server

Commands:
  serve                   Start the shared localhost MCP HTTP server
  create-plugin           Scaffold a new metro-mcp plugin package
  init                    Create a metro-mcp.config.ts in the current project
  doctor                  Check Metro connectivity and config health
  validate-plugin <path>  Validate a plugin file exports a valid PluginDefinition

Usage:
  metro-mcp [options]

Options:
  --host, -H <host>       Metro host (default: localhost, env: METRO_HOST)
  --port, -p <port>       Metro port (default: 8081, env: METRO_PORT)
  --config, -c <path>     Path to config file (env: METRO_MCP_CONFIG)
  --plugin <path>         Load a plugin (repeatable, env: METRO_MCP_PLUGINS)
  --mcp-port <port>       Port for \`serve\` mode (default: random, env: METRO_MCP_MCP_PORT)
  --stdio-direct          Run one legacy stdio server process without multiplexing
  --help                  Show this help message

Environment Variables:
  METRO_HOST              Metro bundler host
  METRO_PORT              Metro bundler port
  METRO_MCP_CONFIG        Path to config file (absolute or relative to CWD)
  METRO_MCP_PLUGINS       Colon-separated plugin paths
  METRO_MCP_MCP_PORT      Port for the shared MCP HTTP server
  METRO_MCP_MULTIPLEX     Set to "false" to disable the stdio daemon/proxy
  DEBUG                   Enable debug logging

Examples:
  metro-mcp
  metro-mcp serve --mcp-port 8765
  metro-mcp --port 19000
  metro-mcp --config /path/to/metro-mcp.config.ts
  METRO_MCP_CONFIG=/path/to/metro-mcp.config.ts metro-mcp
  METRO_PORT=8082 metro-mcp
`);
    process.exit(0);
  }

  try {
    const config = await loadConfig(serverArgs);
    logger.info(`Starting metro-mcp (Metro: ${config.metro.host}:${config.metro.port})`);

    if (subcommand === 'serve') {
      const mcpPort = resolveMcpPort(serverArgs);
      const key = getDaemonKeyFromEnv(serverArgs);
      await startHttpServer(config, serverArgs, {
        port: mcpPort,
        onListening: ({ host, port, url }) => {
          writeDaemonRecord({
            pid: process.pid,
            host,
            port,
            url,
            key,
            args: serverArgs,
            startedAt: new Date().toISOString(),
          });
        },
      });
      return;
    }

    if (serverArgs.includes('--stdio-direct') || process.env.METRO_MCP_MULTIPLEX === 'false') {
      await startServer(config, serverArgs.filter((arg) => arg !== '--stdio-direct'));
      return;
    }

    await startStdioProxy(serverArgs);
  } catch (err) {
    logger.error('Fatal error:', err);
    process.exit(1);
  }
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function resolveMcpPort(args: string[]): number {
  const fromEnv = parseOptionalInt(process.env.METRO_MCP_MCP_PORT);
  if (fromEnv !== undefined) return fromEnv;
  const index = args.indexOf('--mcp-port');
  if (index === -1) return 0;
  return parseOptionalInt(args[index + 1]) ?? 0;
}

main();
