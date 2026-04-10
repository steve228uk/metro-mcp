import { z } from 'zod';
import { definePlugin } from '../plugin.js';

const PLATFORM_SCHEMA = z
  .enum(['ios', 'android', 'auto'])
  .default('auto')
  .describe("Target platform. 'auto' detects from active device.");

const MAX_BYTES_DEFAULT = 50 * 1024; // 50 KB
const MAX_BYTES_LIMIT = 1024 * 1024; // 1 MB

async function detectPlatform(ctx: { exec: (cmd: string) => Promise<string> }): Promise<'ios' | 'android'> {
  try {
    await ctx.exec('xcrun simctl list devices --json');
    return 'ios';
  } catch {
    return 'android';
  }
}

function safePath(p: string): string {
  if (p.includes('..')) throw new Error('Path traversal (.. segments) is not allowed.');
  return p;
}

async function resolveBundleId(
  ctx: { exec: (cmd: string) => Promise<string>; evalInApp: (expr: string) => Promise<unknown>; config: Record<string, unknown> },
  provided?: string
): Promise<string | null> {
  if (provided) return provided;
  if (ctx.config.bundleId) return String(ctx.config.bundleId);
  try {
    const id = await ctx.evalInApp(
      `(function() {
        try { return require('expo-application').applicationId; } catch(e) {}
        try { return require('react-native-device-info').getBundleId(); } catch(e) {}
        return null;
      })()`
    );
    if (id) return String(id);
  } catch {
    // ignore
  }
  return null;
}

async function getIosContainerRoot(
  ctx: { exec: (cmd: string) => Promise<string> },
  bundleId: string
): Promise<string> {
  const root = await ctx.exec(`xcrun simctl get_app_container booted ${JSON.stringify(bundleId)} data`);
  return root.trim();
}

function parseIosLs(output: string, baseDir: string): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const line of output.split('\n')) {
    // BSD ls -la format: permissions links owner group size month day time name
    const match = line.match(
      /^([dlrwx-]{10})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w+\s+\d+\s+[\d:]+)\s+(.+)$/
    );
    if (!match) continue;
    const perms = match[1];
    const size = parseInt(match[2], 10);
    const modified = match[3];
    const name = match[4];
    if (name === '.' || name === '..') continue;
    entries.push({
      name,
      path: baseDir ? `${baseDir}/${name}` : name,
      isDirectory: perms.startsWith('d'),
      size,
      modified,
    });
  }
  return entries;
}

function parseAndroidLs(output: string, baseDir: string): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const line of output.split('\n')) {
    // Android ls -la: permissions links owner group size date time name
    const match = line.match(
      /^([dlrwx-]{10})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+(.+)$/
    );
    if (!match) continue;
    const perms = match[1];
    const size = parseInt(match[2], 10);
    const modified = match[3];
    const name = match[4];
    if (name === '.' || name === '..') continue;
    entries.push({
      name,
      path: baseDir ? `${baseDir}/${name}` : name,
      isDirectory: perms.startsWith('d'),
      size,
      modified,
    });
  }
  return entries;
}

export const filesystemPlugin = definePlugin({
  name: 'filesystem',
  description:
    "Browse and read files in the app's sandboxed directories on iOS Simulator and Android Emulator.",

  async setup(ctx) {
    ctx.registerTool('get_app_directories', {
      description:
        "Get the paths of the app's key directories: documents, cache, temp, and library. " +
        'On iOS uses xcrun simctl get_app_container. ' +
        'On Android resolves standard /data/data/<package> subdirectories.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        platform: PLATFORM_SCHEMA,
        bundleId: z.string().optional().describe('App bundle ID or package name. Auto-detected if omitted.'),
      }),
      handler: async ({ platform, bundleId }) => {
        const resolved = platform === 'auto' ? await detectPlatform(ctx) : platform;
        const id = await resolveBundleId(ctx, bundleId);
        if (!id) return 'Could not determine bundle ID. Provide bundleId parameter.';

        if (resolved === 'ios') {
          try {
            const root = await getIosContainerRoot(ctx, id);
            return {
              platform: 'ios',
              bundleId: id,
              root,
              documents: `${root}/Documents`,
              library: `${root}/Library`,
              cache: `${root}/Library/Caches`,
              temp: `${root}/tmp`,
            };
          } catch (err) {
            return `Failed to get iOS app directories: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        // Android
        const base = `/data/data/${id}`;
        return {
          platform: 'android',
          packageName: id,
          root: base,
          documents: `${base}/files`,
          cache: `${base}/cache`,
          databases: `${base}/databases`,
          sharedPrefs: `${base}/shared_prefs`,
          note: 'Use list_directory with these paths. Requires the emulator to have run-as access.',
        };
      },
    });

    ctx.registerTool('list_directory', {
      description:
        "List files and directories inside the app's container. " +
        'Provide a path relative to the app root, or an absolute path for iOS. ' +
        'Use get_app_directories first to find the relevant base paths.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        path: z.string().default('').describe("Path to list. Empty string or '/' = app container root."),
        platform: PLATFORM_SCHEMA,
        bundleId: z.string().optional().describe('App bundle ID or package name. Auto-detected if omitted.'),
      }),
      handler: async ({ path: dirPath, platform, bundleId }) => {
        const resolved = platform === 'auto' ? await detectPlatform(ctx) : platform;
        const id = await resolveBundleId(ctx, bundleId);
        if (!id) return 'Could not determine bundle ID. Provide bundleId parameter.';

        try {
          safePath(dirPath);
        } catch (err) {
          return String(err instanceof Error ? err.message : err);
        }

        if (resolved === 'ios') {
          try {
            const root = await getIosContainerRoot(ctx, id);
            const fullPath = dirPath ? `${root}/${dirPath}` : root;
            const output = await ctx.exec(`ls -la ${JSON.stringify(fullPath)}`);
            return { platform: 'ios', path: fullPath, entries: parseIosLs(output, dirPath) };
          } catch (err) {
            return `Failed to list iOS directory: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        // Android
        try {
          const androidPath = dirPath || `/data/data/${id}`;
          const output = await ctx.exec(`adb shell run-as ${JSON.stringify(id)} ls -la ${JSON.stringify(androidPath)}`);
          return { platform: 'android', path: androidPath, entries: parseAndroidLs(output, dirPath) };
        } catch (err) {
          return `Failed to list Android directory: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('read_file', {
      description:
        "Read the contents of a file from the app's container. " +
        'Text files are returned as UTF-8 strings; use encoding=base64 for binary files. ' +
        'Capped at maxBytes (default 50KB, max 1MB) to avoid flooding context.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        path: z.string().describe('Path to the file (absolute, or relative to app container root)'),
        platform: PLATFORM_SCHEMA,
        bundleId: z.string().optional().describe('App bundle ID or package name. Auto-detected if omitted.'),
        encoding: z
          .enum(['utf8', 'base64'])
          .default('utf8')
          .describe("File encoding. Use 'base64' for binary files."),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(MAX_BYTES_LIMIT)
          .default(MAX_BYTES_DEFAULT)
          .describe('Maximum bytes to read (default 50KB, max 1MB)'),
      }),
      handler: async ({ path: filePath, platform, bundleId, encoding, maxBytes }) => {
        const resolved = platform === 'auto' ? await detectPlatform(ctx) : platform;
        const id = await resolveBundleId(ctx, bundleId);
        if (!id) return 'Could not determine bundle ID. Provide bundleId parameter.';

        try {
          safePath(filePath);
        } catch (err) {
          return String(err instanceof Error ? err.message : err);
        }

        if (resolved === 'ios') {
          try {
            const root = await getIosContainerRoot(ctx, id);
            const fullPath = filePath.startsWith('/') ? filePath : `${root}/${filePath}`;
            const content = await ctx.exec(`head -c ${maxBytes} ${JSON.stringify(fullPath)}`);
            if (encoding === 'base64') {
              return {
                path: fullPath,
                encoding: 'base64',
                content: Buffer.from(content, 'binary').toString('base64'),
              };
            }
            return { path: fullPath, encoding: 'utf8', content, truncated: content.length >= maxBytes };
          } catch (err) {
            return `Failed to read iOS file: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        // Android
        try {
          const androidPath = filePath.startsWith('/') ? filePath : `/data/data/${id}/${filePath}`;
          const content = await ctx.exec(
            `adb shell "run-as ${id} cat ${JSON.stringify(androidPath)} | head -c ${maxBytes}"`
          );
          if (encoding === 'base64') {
            return {
              path: androidPath,
              encoding: 'base64',
              content: Buffer.from(content, 'binary').toString('base64'),
            };
          }
          return { path: androidPath, encoding: 'utf8', content, truncated: content.length >= maxBytes };
        } catch (err) {
          return `Failed to read Android file: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('get_file_info', {
      description: 'Get metadata for a file or directory: size, modification time, and type.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        path: z.string().describe('Path to the file or directory'),
        platform: PLATFORM_SCHEMA,
        bundleId: z.string().optional().describe('App bundle ID or package name. Auto-detected if omitted.'),
      }),
      handler: async ({ path: filePath, platform, bundleId }) => {
        const resolved = platform === 'auto' ? await detectPlatform(ctx) : platform;
        const id = await resolveBundleId(ctx, bundleId);
        if (!id) return 'Could not determine bundle ID. Provide bundleId parameter.';

        try {
          safePath(filePath);
        } catch (err) {
          return String(err instanceof Error ? err.message : err);
        }

        if (resolved === 'ios') {
          try {
            const root = await getIosContainerRoot(ctx, id);
            const fullPath = filePath.startsWith('/') ? filePath : `${root}/${filePath}`;
            const output = await ctx.exec(`stat ${JSON.stringify(fullPath)}`);
            return { platform: 'ios', path: fullPath, stat: output.trim() };
          } catch (err) {
            return `Failed to stat iOS file: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        try {
          const androidPath = filePath.startsWith('/') ? filePath : `/data/data/${id}/${filePath}`;
          const output = await ctx.exec(
            `adb shell run-as ${JSON.stringify(id)} stat ${JSON.stringify(androidPath)}`
          );
          return { platform: 'android', path: androidPath, stat: output.trim() };
        } catch (err) {
          return `Failed to stat Android file: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('delete_file', {
      description:
        "Delete a file from the app's container. Requires confirm=true to proceed. " +
        'Use with caution — this permanently removes the file.',
      annotations: { destructiveHint: true },
      parameters: z.object({
        path: z.string().describe('Path to the file to delete'),
        platform: PLATFORM_SCHEMA,
        bundleId: z.string().optional().describe('App bundle ID or package name. Auto-detected if omitted.'),
        confirm: z
          .boolean()
          .describe('Must be set to true to confirm deletion. This is a destructive operation.'),
      }),
      handler: async ({ path: filePath, platform, bundleId, confirm }) => {
        if (!confirm) {
          return 'Set confirm=true to confirm deletion. This operation is irreversible.';
        }

        const resolved = platform === 'auto' ? await detectPlatform(ctx) : platform;
        const id = await resolveBundleId(ctx, bundleId);
        if (!id) return 'Could not determine bundle ID. Provide bundleId parameter.';

        try {
          safePath(filePath);
        } catch (err) {
          return String(err instanceof Error ? err.message : err);
        }

        if (resolved === 'ios') {
          try {
            const root = await getIosContainerRoot(ctx, id);
            const fullPath = filePath.startsWith('/') ? filePath : `${root}/${filePath}`;
            await ctx.exec(`rm ${JSON.stringify(fullPath)}`);
            return { platform: 'ios', path: fullPath, deleted: true };
          } catch (err) {
            return `Failed to delete iOS file: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        try {
          const androidPath = filePath.startsWith('/') ? filePath : `/data/data/${id}/${filePath}`;
          await ctx.exec(`adb shell run-as ${JSON.stringify(id)} rm ${JSON.stringify(androidPath)}`);
          return { platform: 'android', path: androidPath, deleted: true };
        } catch (err) {
          return `Failed to delete Android file: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
  },
});
