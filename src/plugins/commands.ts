import { z } from 'zod';
import { definePlugin } from '../plugin.js';

export const commandsPlugin = definePlugin({
  name: 'commands',
  version: '0.1.0',
  description: 'Custom app commands via global.__METRO_MCP__.commands',

  async setup(ctx) {
    async function evalInApp(expression: string): Promise<unknown> {
      if (!ctx.cdp.isConnected()) throw new Error('Not connected');
      const result = (await ctx.cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })) as Record<string, unknown>;
      if (result.exceptionDetails) {
        const ex = result.exceptionDetails as Record<string, unknown>;
        throw new Error((ex.text as string) || 'Command execution failed');
      }
      return (result.result as Record<string, unknown>).value;
    }

    ctx.registerTool('list_commands', {
      description:
        'List all custom commands registered by the app. Commands are registered on global.__METRO_MCP__.commands or global.__METRO_MCP_COMMANDS__.',
      parameters: z.object({}),
      handler: async () => {
        const result = await evalInApp(`
          (function() {
            var commands = {};
            // Check both conventions
            var src = (global.__METRO_MCP__ && global.__METRO_MCP__.commands)
              || global.__METRO_MCP_COMMANDS__
              || null;
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
      }),
      handler: async ({ name, params }) => {
        const escapedName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const paramsJson = JSON.stringify(params || {});

        const result = await evalInApp(`
          (async function() {
            var src = (global.__METRO_MCP__ && global.__METRO_MCP__.commands)
              || global.__METRO_MCP_COMMANDS__
              || null;
            if (!src) return { error: 'No commands registered.' };
            var cmd = src['${escapedName}'];
            if (!cmd) return { error: 'Command "${escapedName}" not found. Available: ' + Object.keys(src).join(', ') };
            if (typeof cmd !== 'function') return { error: 'Command "${escapedName}" is not a function.' };
            try {
              var result = await cmd(${paramsJson});
              return { success: true, result: result };
            } catch(e) {
              return { error: e.message || String(e) };
            }
          })()
        `);
        return result;
      },
    });
  },
});
