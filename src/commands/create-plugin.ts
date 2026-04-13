import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { cancel, group, intro, isCancel, log, note, outro, spinner, text } from '@clack/prompts';
import { version as metroMCPVersion } from '../version.js';

function getGitAuthor(): string {
  try {
    return execSync('git config user.name', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

function generatePackageJson(opts: {
  name: string;
  version: string;
  description: string;
  author: string;
}): string {
  const pkg = {
    name: `metro-mcp-plugin-${opts.name}`,
    version: opts.version,
    ...(opts.description && { description: opts.description }),
    ...(opts.author && { author: opts.author }),
    license: 'MIT',
    type: 'module',
    main: './dist/index.js',
    exports: {
      '.': {
        import: './dist/index.js',
      },
    },
    files: ['dist', 'README.md'],
    scripts: {
      build: 'bun build src/index.ts --outfile dist/index.js --target node --external metro-mcp --external zod',
      prepublishOnly: 'bun run build',
    },
    keywords: ['metro-mcp', 'mcp', 'react-native'],
    peerDependencies: {
      'metro-mcp': '>=0.9.0',
      zod: '>=3.24.4',
    },
    devDependencies: {
      '@types/bun': '^1.2.0',
      'metro-mcp': `^${metroMCPVersion}`,
    },
    engines: {
      node: '>=18.0.0',
    },
  };
  return JSON.stringify(pkg, null, 2) + '\n';
}

function generateTsConfig(): string {
  return (
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          skipLibCheck: true,
          outDir: './dist',
        },
        include: ['src/**/*'],
      },
      null,
      2,
    ) + '\n'
  );
}

function generatePlugin(opts: { name: string; version: string; description: string }): string {
  const desc = opts.description || `A metro-mcp plugin`;
  return `import { definePlugin } from 'metro-mcp';
import { z } from 'zod';

export default definePlugin({
  name: 'metro-mcp-plugin-${opts.name}',
  version: '${opts.version}',
  description: '${desc}',

  async setup(ctx) {
    ctx.registerTool('hello_world', {
      description: 'A sample tool — replace with your own logic',
      parameters: z.object({
        name: z.string().default('world').describe('Name to greet'),
      }),
      handler: async ({ name }) => {
        return \`Hello, \${name}! This is the ${opts.name} metro-mcp plugin.\`;
      },
    });

    // Uncomment to register a resource:
    // ctx.registerResource('metro://${opts.name}/data', {
    //   name: '${opts.name} Data',
    //   description: 'Custom data source',
    //   handler: async () => JSON.stringify({ hello: 'world' }),
    // });
  },
});
`;
}

function generateReadme(opts: { name: string; description: string }): string {
  const fullName = `metro-mcp-plugin-${opts.name}`;
  const desc = opts.description || `A plugin for [metro-mcp](https://metromcp.dev).`;
  return `# ${fullName}

${desc}

## Installation

\`\`\`bash
bun add ${fullName}
\`\`\`

## Usage

Add to your \`metro-mcp.config.ts\`:

\`\`\`typescript
import { defineConfig } from 'metro-mcp';

export default defineConfig({
  plugins: ['${fullName}'],
});
\`\`\`

## Development

\`\`\`bash
bun install
bun run build
\`\`\`
`;
}

function generateLicense(author: string): string {
  const year = new Date().getFullYear();
  const copyright = author ? `${year} ${author}` : `${year}`;
  return `MIT License

Copyright (c) ${copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

function generateGitignore(): string {
  return `node_modules/
dist/
*.tsbuildinfo
.DS_Store
`;
}

export async function runCreatePlugin(): Promise<void> {
  intro('Create metro-mcp plugin');

  const gitAuthor = getGitAuthor();

  const answers = await group(
    {
      nameSuffix: () =>
        text({
          message: 'Plugin name suffix',
          placeholder: 'my-plugin',
          validate: (value) => {
            if (!value || value.trim().length === 0) return 'Plugin name is required';
            if (!/^[a-z0-9][a-z0-9-]*$/.test(value.trim())) {
              return 'Must be lowercase alphanumeric with hyphens only (e.g. my-plugin)';
            }
          },
        }),
      description: () =>
        text({
          message: 'Description',
          placeholder: 'A metro-mcp plugin',
        }),
      author: () =>
        text({
          message: 'Author',
          initialValue: gitAuthor,
          placeholder: gitAuthor || 'Your Name',
        }),
      version: () =>
        text({
          message: 'Version',
          initialValue: '0.1.0',
          placeholder: '0.1.0',
        }),
    },
    {
      onCancel: () => {
        cancel('Cancelled');
        process.exit(0);
      },
    },
  );

  const name = answers.nameSuffix.trim();
  const version = answers.version.trim() || '0.1.0';
  const description = answers.description.trim();
  const author = answers.author.trim();
  const packageName = `metro-mcp-plugin-${name}`;
  const targetDir = path.join(process.cwd(), packageName);

  if (fs.existsSync(targetDir)) {
    log.error(`Directory "${packageName}" already exists.`);
    process.exit(1);
  }

  const s = spinner();
  s.start('Creating plugin files');

  try {
    fs.mkdirSync(path.join(targetDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'package.json'), generatePackageJson({ name, version, description, author }));
    fs.writeFileSync(path.join(targetDir, 'tsconfig.json'), generateTsConfig());
    fs.writeFileSync(path.join(targetDir, 'src', 'index.ts'), generatePlugin({ name, version, description }));
    fs.writeFileSync(path.join(targetDir, 'README.md'), generateReadme({ name, description }));
    fs.writeFileSync(path.join(targetDir, 'LICENSE'), generateLicense(author));
    fs.writeFileSync(path.join(targetDir, '.gitignore'), generateGitignore());
    s.stop('Plugin files created');
  } catch (err) {
    s.error('Failed to create plugin files');
    log.error(String(err));
    process.exit(1);
  }

  const installSpinner = spinner();
  installSpinner.start('Installing dependencies');
  try {
    execSync('bun install', { cwd: targetDir, stdio: 'pipe' });
    installSpinner.stop('Dependencies installed');
  } catch {
    installSpinner.error('Failed to install dependencies');
    log.warn(`Run \`bun install\` manually inside ${packageName}/`);
  }

  note(`cd ${packageName}\nbun run build`, 'Next steps');

  outro(`Plugin ${packageName} ready!`);
}
