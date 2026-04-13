import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { intro, log, note, outro } from '@clack/prompts';
import { loadConfig } from '../config.js';

function checkNodeVersion(): { ok: boolean; message: string } {
  const ver = process.versions.node;
  const major = parseInt(ver.split('.')[0], 10);
  if (major >= 18) {
    return { ok: true, message: `Node.js ${ver}` };
  }
  return { ok: false, message: `Node.js ${ver} — requires >=18` };
}

function checkMetro(host: string, port: number): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/', timeout: 3000 }, (res) => {
      resolve({ ok: true, message: `Metro reachable at ${host}:${port} (HTTP ${res.statusCode})` });
      res.resume();
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, message: `Metro not reachable at ${host}:${port} — connection timed out` });
    });
    req.on('error', (err) => {
      resolve({ ok: false, message: `Metro not reachable at ${host}:${port} — ${err.message}` });
    });
  });
}

function findConfigFile(): string | null {
  const cwd = process.cwd();
  for (const name of ['metro-mcp.config.ts', 'metro-mcp.config.js']) {
    if (fs.existsSync(path.join(cwd, name))) return name;
  }
  return null;
}

function checkPluginPaths(plugins: string[]): Array<{ path: string; ok: boolean }> {
  return plugins
    .filter((p) => !p.startsWith('metro-mcp-plugin-') && !p.includes('node_modules'))
    .map((p) => ({
      path: p,
      ok: fs.existsSync(path.resolve(process.cwd(), p)),
    }));
}

export async function runDoctor(): Promise<void> {
  intro('metro-mcp doctor');

  let passed = 0;
  let failed = 0;

  // Node.js version check
  const nodeResult = checkNodeVersion();
  if (nodeResult.ok) {
    log.success(nodeResult.message);
    passed++;
  } else {
    log.error(nodeResult.message);
    failed++;
  }

  // Config file check
  const configFile = findConfigFile();
  if (configFile) {
    log.success(`Config file found: ${configFile}`);
    passed++;
  } else {
    log.warn('No config file found (metro-mcp.config.ts) — using defaults');
  }

  // Load config to get metro host/port and plugin paths
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig([]);
  } catch {
    log.error('Failed to load config');
    outro(`${passed} passed, ${failed + 1} failed`);
    process.exit(1);
  }

  // Metro connectivity check
  const metroResult = await checkMetro(config.metro.host ?? 'localhost', config.metro.port ?? 8081);
  if (metroResult.ok) {
    log.success(metroResult.message);
    passed++;
  } else {
    log.error(metroResult.message);
    failed++;
  }

  // Plugin path checks (local paths only)
  const pluginChecks = checkPluginPaths(config.plugins);
  for (const check of pluginChecks) {
    if (check.ok) {
      log.success(`Plugin found: ${check.path}`);
      passed++;
    } else {
      log.error(`Plugin not found: ${check.path}`);
      failed++;
    }
  }

  if (failed === 0) {
    outro(`All checks passed`);
  } else {
    note(
      [
        'Run metro-mcp --help to see available options.',
        'Visit https://metromcp.dev for documentation.',
      ].join('\n'),
      'Need help?',
    );
    outro(`${passed} passed, ${failed} failed`);
    process.exit(1);
  }
}
