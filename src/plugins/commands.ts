import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { escapeJsString } from '../utils/format.js';

// Shared JS snippet: resolves the commands source from either global convention.
const METRO_MCP_SRC_JS = `
  var src = (globalThis.__METRO_BRIDGE__ && globalThis.__METRO_BRIDGE__.commands)
    || (globalThis.__METRO_MCP__ && globalThis.__METRO_MCP__.commands)
    || globalThis.__METRO_BRIDGE_COMMANDS__
    || globalThis.__METRO_MCP_COMMANDS__
    || null;
`;

let _cmdSeq = 0;

export const commandsPlugin = definePlugin({
  name: 'commands',

  description: 'Custom app commands via global.__METRO_BRIDGE__.commands',

  async setup(ctx) {
    ctx.registerTool('list_commands', {
      description:
        'List all custom commands registered by the app. Commands are registered on global.__METRO_BRIDGE__.commands or global.__METRO_BRIDGE_COMMANDS__.',
      parameters: z.object({}),
      handler: async () => {
        const result = await ctx.evalInApp(`
          (function() {
            var commands = {};
            ${METRO_MCP_SRC_JS}
            if (!src) return { available: false, message: 'No commands registered. See metro-mcp docs for setup.' };
            var names = Object.keys(src);
            for (var i = 0; i < names.length; i++) {
              commands[names[i]] = typeof src[names[i]] === 'function' ? 'function' : typeof src[names[i]];
            }
            return { available: true, commands: commands };
          })()
        `);
        return result;
      },
    });

    ctx.registerTool('run_command', {
      description:
        'Execute a custom command registered by the app. Pass parameters as a JSON object.',
      parameters: z.object({
        name: z.string().describe('Command name to execute'),
        params: z.record(z.unknown()).optional().describe('Parameters to pass to the command'),
        timeout: z.number().default(15000).describe('Max ms to wait for async commands (default 15000)'),
      }),
      handler: async ({ name, params, timeout }) => {
        const escapedName = escapeJsString(name);
        const paramsJson = JSON.stringify(params || {});
        // awaitPromise:true is unreliable in Hermes CDP for freshly created promises —
        // store the settled result in a global and poll instead.
        const key = `__METRO_MCP_CMD_${++_cmdSeq}__`;

        await ctx.evalInApp(`
          (function() {
            ${METRO_MCP_SRC_JS}
            if (!src) { globalThis['${key}'] = { done: true, error: 'No commands registered.' }; return; }
            var cmd = src['${escapedName}'];
            if (!cmd) { globalThis['${key}'] = { done: true, error: 'Command not found. Available: ' + Object.keys(src).join(', ') }; return; }
            if (typeof cmd !== 'function') { globalThis['${key}'] = { done: true, error: 'Not a function.' }; return; }
            globalThis['${key}'] = { done: false };
            Promise.resolve(cmd(${paramsJson}))
              .then(function(r) { globalThis['${key}'] = { done: true, result: r }; })
              .catch(function(e) { globalThis['${key}'] = { done: true, error: e && e.message ? e.message : String(e) }; });
          })()
        `);

        const deadline = Date.now() + timeout;
        const pollExpr = `(function() { var r = globalThis['${key}']; if (!r || !r.done) return null; delete globalThis['${key}']; return r; })()`;

        while (Date.now() < deadline) {
          const result = await ctx.evalInApp(pollExpr) as Record<string, unknown> | null;
          if (result?.done) {
            if (result.error) return { error: result.error };
            return result.result ?? { ok: true };
          }
          await new Promise((r) => setTimeout(r, 200));
        }

        await ctx.evalInApp(`delete globalThis['${key}']`).catch(() => {});
        return { error: `Command "${name}" timed out after ${timeout}ms` };
      },
    });
  },
});
