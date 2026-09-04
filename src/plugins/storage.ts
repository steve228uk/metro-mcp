import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { resolveAsyncStorageExpression } from '../utils/storage.js';

const ASYNC_STORAGE = resolveAsyncStorageExpression();
const UNSUPPORTED = 'Unsupported capability: initialized AsyncStorage module is unavailable.';

export const storagePlugin = definePlugin({
  name: 'storage',

  description: 'AsyncStorage reading via Runtime.evaluate',

  async setup(ctx) {
    ctx.registerTool('get_storage_keys', {
      description: 'List all AsyncStorage keys in the React Native app.',
      annotations: { readOnlyHint: true },
      parameters: z.object({}),
      handler: async () => {
        const result = await ctx.evalInApp(`
          (async function() {
            try {
              var AsyncStorage = ${ASYNC_STORAGE};
              if (!AsyncStorage) return { error: '${UNSUPPORTED}' };
              var keys = await AsyncStorage.getAllKeys();
              return { keys: keys };
            } catch(e) {
              return { error: e.message };
            }
          })()
        `, { awaitPromise: true });
        return result;
      },
    });

    ctx.registerTool('get_storage_item', {
      description: 'Read a specific AsyncStorage key value.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        key: z.string().describe('AsyncStorage key to read'),
      }),
      handler: async ({ key }) => {
        const keyLiteral = JSON.stringify(key);
        const result = await ctx.evalInApp(`
          (async function() {
            try {
              var AsyncStorage = ${ASYNC_STORAGE};
              if (!AsyncStorage) return { error: '${UNSUPPORTED}' };
              var value = await AsyncStorage.getItem(${keyLiteral});
              try { return { key: ${keyLiteral}, value: JSON.parse(value) }; }
              catch(e) { return { key: ${keyLiteral}, value: value }; }
            } catch(e) {
              return { error: e.message };
            }
          })()
        `, { awaitPromise: true });
        return result;
      },
    });

    ctx.registerTool('get_all_storage', {
      description: 'Dump all AsyncStorage key-value pairs.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        maxLength: z.number().default(500).describe('Max length for each value'),
      }),
      handler: async ({ maxLength }) => {
        const result = await ctx.evalInApp(`
          (async function() {
            try {
              var AsyncStorage = ${ASYNC_STORAGE};
              if (!AsyncStorage) return { error: '${UNSUPPORTED}' };
              var keys = await AsyncStorage.getAllKeys();
              var entries = await AsyncStorage.multiGet(keys);
              var data = {};
              for (var i = 0; i < entries.length; i++) {
                var key = entries[i][0];
                var val = entries[i][1];
                if (val && val.length > ${JSON.stringify(maxLength)}) {
                  val = val.substring(0, ${JSON.stringify(maxLength)}) + '...(truncated)';
                }
                try { data[key] = JSON.parse(val); }
                catch(e) { data[key] = val; }
              }
              return data;
            } catch(e) {
              return { error: e.message };
            }
          })()
        `, { awaitPromise: true });
        return result;
      },
    });
  },
});
