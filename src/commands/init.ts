import * as fs from 'node:fs';
import * as path from 'node:path';
import { cancel, group, intro, log, outro, text } from '@clack/prompts';

const CONFIG_FILENAMES = ['metro-mcp.config.ts', 'metro-mcp.config.js'];

function generateConfig(host: string, port: number): string {
  return `import { defineConfig } from 'metro-mcp';

export default defineConfig({
  metro: {
    host: '${host}',
    port: ${port},
  },
  // plugins: [
  //   'metro-mcp-plugin-example',
  //   './local-plugin.ts',
  // ],
});
`;
}

export async function runInit(): Promise<void> {
  intro('Initialize metro-mcp config');

  const cwd = process.cwd();

  for (const filename of CONFIG_FILENAMES) {
    if (fs.existsSync(path.join(cwd, filename))) {
      log.warn(`${filename} already exists — remove it first to re-initialize.`);
      process.exit(0);
    }
  }

  const answers = await group(
    {
      host: () =>
        text({
          message: 'Metro host',
          initialValue: 'localhost',
          placeholder: 'localhost',
        }),
      port: () =>
        text({
          message: 'Metro port',
          initialValue: '8081',
          placeholder: '8081',
          validate: (value) => {
            const n = parseInt(value ?? '', 10);
            if (isNaN(n) || n < 1 || n > 65535) return 'Must be a valid port number (1–65535)';
          },
        }),
    },
    {
      onCancel: () => {
        cancel('Cancelled');
        process.exit(0);
      },
    },
  );

  const host = answers.host.trim() || 'localhost';
  const port = parseInt(answers.port.trim(), 10) || 8081;
  const configPath = path.join(cwd, 'metro-mcp.config.ts');

  try {
    fs.writeFileSync(configPath, generateConfig(host, port));
    log.success(`Created metro-mcp.config.ts`);
  } catch (err) {
    log.error(`Failed to write config: ${err}`);
    process.exit(1);
  }

  outro('Done! Edit metro-mcp.config.ts to add plugins or tweak settings.');
}
