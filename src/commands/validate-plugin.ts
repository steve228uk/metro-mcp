import * as fs from 'node:fs';
import * as path from 'node:path';
import { intro, log, outro } from '@clack/prompts';

export async function runValidatePlugin(pluginPath: string | undefined): Promise<void> {
  intro('Validate metro-mcp plugin');

  if (!pluginPath) {
    log.error('No plugin path provided.');
    log.message('Usage: metro-mcp validate-plugin <path>');
    process.exit(1);
  }

  const resolved = path.resolve(process.cwd(), pluginPath);

  if (!fs.existsSync(resolved)) {
    log.error(`File not found: ${resolved}`);
    process.exit(1);
  }

  log.step(`Validating ${pluginPath}`);

  let mod: Record<string, unknown>;
  try {
    mod = await import(resolved);
  } catch (err) {
    log.error(`Failed to import plugin: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Accept default export, or the first named export that looks like a PluginDefinition
  const isPluginShape = (v: unknown) =>
    typeof v === 'object' && v !== null && 'name' in v && 'setup' in v;

  const exported =
    isPluginShape(mod.default)
      ? mod.default
      : Object.values(mod).find(isPluginShape) ?? mod.default ?? mod;

  if (typeof exported !== 'object' || exported === null) {
    log.error('Plugin must export an object (use definePlugin())');
    process.exit(1);
  }

  const plugin = exported as Record<string, unknown>;

  const errors: string[] = [];

  if (typeof plugin.name !== 'string' || plugin.name.trim() === '') {
    errors.push('Missing or invalid "name" property (must be a non-empty string)');
  }

  if (typeof plugin.setup !== 'function') {
    errors.push('Missing or invalid "setup" property (must be a function)');
  }

  if (errors.length > 0) {
    for (const err of errors) {
      log.error(err);
    }
    process.exit(1);
  }

  log.success(`name: "${plugin.name}"`);
  if (typeof plugin.version === 'string') log.success(`version: "${plugin.version}"`);
  if (typeof plugin.description === 'string') log.success(`description: "${plugin.description}"`);
  log.success('setup: function');

  outro('Plugin is valid');
}
