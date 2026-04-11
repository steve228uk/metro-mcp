import { z } from 'zod';
import { definePlugin } from '../plugin.js';

const MAX_BYTES_DEFAULT = 50 * 1024;  // 50 KB
const MAX_BYTES_CAP     = 1024 * 1024; // 1 MB

// Matches one ls -la entry line on both macOS and Android busybox.
// Handles both month-first (Apr 11 10:19) and day-first (11 Apr 10:19) date formats.
const LS_LINE_RE =
  /^([dlrwxbcpst\-]{10}[+@.]?)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+((?:\w{3}\s+\d+|\d+\s+\w{3})\s+[\d:]+)/;

export const filesystemPlugin = definePlugin({
  name: 'filesystem',

  description:
    'Browse and read files in the app sandboxed directories ' +
    '(Documents, Library/Caches, temp). Supports iOS Simulator and Android.',

  async setup(ctx) {
    // Cache the detected platform for the lifetime of this plugin session so
    // tools with platform:'auto' don't re-run xcrun/adb on every call.
    let detectedPlatform: 'ios' | 'android' | null | undefined;

    async function detectPlatform(): Promise<'ios' | 'android' | null> {
      if (detectedPlatform !== undefined) return detectedPlatform;
      try {
        const out = await ctx.exec('xcrun simctl list booted 2>/dev/null');
        if (out.includes('Booted')) return (detectedPlatform = 'ios');
      } catch {}
      try {
        const out = await ctx.exec('adb devices 2>/dev/null');
        const connected = out
          .trim()
          .split('\n')
          .slice(1)
          .filter((l) => l.trim() && !l.startsWith('*'));
        if (connected.length > 0) return (detectedPlatform = 'android');
      } catch {}
      return (detectedPlatform = null);
    }

    function assertSafePath(p: string): void {
      if (p.split('/').includes('..')) {
        throw new Error('Directory traversal not allowed: ".." segments are forbidden');
      }
    }

    async function getIosContainer(bundleId: string): Promise<string> {
      const out = await ctx.exec(
        `xcrun simctl get_app_container booted "${bundleId}" data`
      );
      return out.trim();
    }

    // Parse `ls -la` output (macOS or Android busybox) into a compact text listing.
    // Format: `d`/`f` + padded size + modified + name (dirs get trailing `/`).
    // First line is `# parentPath` so the AI can reconstruct full paths.
    function parseLsOutput(output: string, parentPath: string): string {
      const lines: string[] = [`# ${parentPath}`];
      for (const line of output.trim().split('\n')) {
        if (!line.trim() || line.startsWith('total ')) continue;
        const match = line.match(
          /^([dlrwxbcpst\-]{10}[+@.]?)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+((?:\w{3}\s+\d+|\d+\s+\w{3})\s+[\d:]+)\s+(.+)$/
        );
        if (!match) continue;
        const [, perms, sizeStr, modified, name] = match;
        if (name === '.' || name === '..') continue;
        const type = perms.startsWith('d') ? 'd' : 'f';
        lines.push(`${type}  ${sizeStr.padStart(7)}  ${modified}  ${name}${type === 'd' ? '/' : ''}`);
      }
      return lines.join('\n');
    }

    // Parse a single `ls -lad` line into a compact text entry.
    function parseFileInfoLine(output: string, itemPath: string): string | null {
      for (const line of output.trim().split('\n')) {
        if (!line.trim() || line.startsWith('total ')) continue;
        const match = line.match(LS_LINE_RE);
        if (!match) continue;
        const [, perms, sizeStr, modified] = match;
        const name = itemPath.split('/').filter(Boolean).pop() ?? itemPath;
        const type = perms.startsWith('d') ? 'd' : 'f';
        return `${type}  ${parseInt(sizeStr, 10).toString().padStart(7)}  ${modified}  ${name}${type === 'd' ? '/' : ''}`;
      }
      return null;
    }

    // Prefix for Android `adb shell` commands that need app-private access.
    // Package names are alphanumeric+dots, so no quoting is required.
    function runAs(bundleId?: string): string {
      return bundleId ? `run-as ${bundleId} ` : '';
    }

    ctx.registerTool('get_app_directories', {
      description:
        'Get known app sandbox directory paths (documents, cache, temp, library). ' +
        'Returns absolute paths usable with list_directory and read_file.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        bundleId: z
          .string()
          .optional()
          .describe(
            'App bundle ID (iOS, e.g. com.example.app) or package name (Android). ' +
            'Required for iOS; used for Android private-directory resolution.'
          ),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ bundleId, platform }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return { error: 'No simulator/emulator detected' };

        if (p === 'ios') {
          if (!bundleId) return { error: 'bundleId is required for iOS' };
          try {
            const root = await getIosContainer(bundleId);
            return {
              root,
              documents: `${root}/Documents`,
              library:   `${root}/Library`,
              cache:     `${root}/Library/Caches`,
              temp:      `${root}/tmp`,
            };
          } catch (err) {
            return {
              error: `Failed to get container path: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }

        // Android — try adb first, fall back to evalInApp
        if (bundleId) {
          try {
            const homeOut = await ctx.exec(
              `adb shell ${runAs(bundleId)}sh -c 'echo $HOME' 2>/dev/null`
            );
            const home = homeOut.trim() || `/data/data/${bundleId}`;
            return {
              root:      home,
              documents: `${home}/files`,
              library:   home,
              cache:     `${home}/cache`,
              temp:      `${home}/cache`,
            };
          } catch {}
        }

        try {
          const result = await ctx.evalInApp(
            `(function() {
              try {
                var FS;
                try { FS = require('expo-file-system'); } catch(e) {}
                if (!FS) try { FS = require('react-native-fs'); } catch(e) {}
                if (FS) return {
                  documents: FS.documentDirectory  || FS.DocumentDirectoryPath  || null,
                  cache:     FS.cacheDirectory     || FS.CachesDirectoryPath    || null,
                  temp:      FS.cacheDirectory     || FS.TemporaryDirectoryPath || null,
                  library:   FS.libraryDirectory   || FS.LibraryDirectoryPath   || null,
                };
                return { error: 'expo-file-system and react-native-fs not available' };
              } catch(e) { return { error: e.message }; }
            })()`
          );
          return result;
        } catch (err) {
          return {
            error: `Failed to resolve app directories: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    });

    ctx.registerTool('list_directory', {
      description:
        'List files and directories in an app sandbox path. ' +
        'Call get_app_directories first to obtain the root path.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        path: z
          .string()
          .optional()
          .describe(
            'Absolute directory path to list. ' +
            'Defaults to the app data container root (bundleId required).'
          ),
        bundleId: z
          .string()
          .optional()
          .describe(
            'App bundle ID (iOS) or package name (Android). ' +
            'Required when path is omitted; also used for Android run-as access.'
          ),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
        recursive: z
          .boolean()
          .default(false)
          .describe('Recursively list subdirectories (returns raw text)'),
      }),
      handler: async ({ path, bundleId, platform, recursive }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return { error: 'No simulator/emulator detected' };

        let targetPath = path;
        if (!targetPath) {
          if (!bundleId) return { error: 'Provide either path or bundleId' };
          targetPath =
            p === 'ios'
              ? await getIosContainer(bundleId)
              : `/data/data/${bundleId}`;
        }

        assertSafePath(targetPath);

        try {
          const flags = recursive ? '-laR' : '-la';
          const output =
            p === 'ios'
              ? await ctx.exec(`ls ${flags} "${targetPath}" 2>&1`)
              : await ctx.exec(`adb shell ${runAs(bundleId)}ls ${flags} "${targetPath}" 2>&1`);

          if (recursive) return output;
          return parseLsOutput(output, targetPath);
        } catch (err) {
          return {
            error: `Failed to list directory: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    });

    ctx.registerTool('read_file', {
      description:
        'Read the contents of a file from the app sandbox. ' +
        'Enforces a configurable size cap (default 50 KB, max 1 MB) to avoid flooding context.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        path: z.string().describe('Absolute path to the file'),
        bundleId: z
          .string()
          .optional()
          .describe('App package name (Android, for run-as access to private files)'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
        encoding: z
          .enum(['utf8', 'base64'])
          .default('utf8')
          .describe('Output encoding. Use base64 for binary files (images, SQLite, etc.)'),
        maxBytes: z
          .number()
          .default(MAX_BYTES_DEFAULT)
          .describe('Maximum bytes to read (default 50 KB, hard cap 1 MB)'),
      }),
      handler: async ({ path, bundleId, platform, encoding, maxBytes }) => {
        assertSafePath(path);
        const limit = Math.min(maxBytes, MAX_BYTES_CAP);
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return { error: 'No simulator/emulator detected' };

        try {
          let content: string;

          if (p === 'ios') {
            content =
              encoding === 'base64'
                ? await ctx.exec(`head -c ${limit} "${path}" | base64`)
                : await ctx.exec(`head -c ${limit} "${path}"`);
          } else {
            // bs=${limit} count=1 reads up to `limit` bytes in a single I/O op,
            // equivalent to bs=1 count=${limit} but without the per-byte syscall overhead.
            const ra = runAs(bundleId);
            content =
              encoding === 'base64'
                ? await ctx.exec(`adb shell ${ra}sh -c 'dd if="${path}" bs=${limit} count=1 2>/dev/null | base64'`)
                : await ctx.exec(`adb shell ${ra}dd if="${path}" bs=${limit} count=1 2>/dev/null`);
          }

          const truncated = encoding === 'base64'
            ? content.length >= Math.ceil(limit / 3) * 4
            : content.length >= limit;
          return truncated ? { content, truncated: true } : content;
        } catch (err) {
          return {
            error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    });

    ctx.registerTool('get_file_info', {
      description:
        'Get file or directory metadata: size, modification date, and whether it is a directory.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        path: z.string().describe('Absolute path to the file or directory'),
        bundleId: z
          .string()
          .optional()
          .describe('App package name (Android, for run-as)'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ path, bundleId, platform }) => {
        assertSafePath(path);
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return { error: 'No simulator/emulator detected' };

        try {
          const output =
            p === 'ios'
              ? await ctx.exec(`ls -lad "${path}" 2>&1`)
              : await ctx.exec(`adb shell ${runAs(bundleId)}ls -lad "${path}" 2>&1`);

          const info = parseFileInfoLine(output, path);
          return info ?? output.trim();
        } catch (err) {
          return {
            error: `Failed to get file info: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    });

    ctx.registerTool('delete_file', {
      description:
        'Delete a file from the app sandbox. ' +
        'Requires confirm: true to prevent accidental deletion.',
      annotations: { destructiveHint: true },
      parameters: z.object({
        path: z.string().describe('Absolute path to the file to delete'),
        bundleId: z
          .string()
          .optional()
          .describe('App package name (Android, for run-as)'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
        confirm: z
          .boolean()
          .describe('Must be set to true to confirm the deletion'),
      }),
      handler: async ({ path, bundleId, platform, confirm }) => {
        if (!confirm) {
          return { error: 'Deletion not confirmed. Pass confirm: true to proceed.' };
        }
        assertSafePath(path);
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return { error: 'No simulator/emulator detected' };

        try {
          if (p === 'ios') {
            await ctx.exec(`rm -f "${path}"`);
          } else {
            await ctx.exec(`adb shell ${runAs(bundleId)}rm "${path}"`);
          }
          return { success: true, deleted: path };
        } catch (err) {
          return {
            error: `Failed to delete file: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    });
  },
});
