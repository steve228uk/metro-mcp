import { z } from 'zod';
import { definePlugin } from '../plugin.js';

export const storagePlugin = definePlugin({
  name: 'storage',
  version: '0.1.0',
  description: 'AsyncStorage reading via Runtime.evaluate',

  async setup(ctx) {
    ctx.registerTool('get_storage_keys', {
      description: 'List all AsyncStorage keys in the React Native app.',
      parameters: z.object({}),
      handler: async () => {
        const result = await ctx.evalInApp(`
          (async function() {
            try {
              var AsyncStorage = require('@react-native-async-storage/async-storage').default
                || require('react-native').AsyncStorage;
              if (!AsyncStorage) return { error: 'AsyncStorage not found' };
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
      parameters: z.object({
        key: z.string().describe('AsyncStorage key to read'),
      }),
      handler: async ({ key }) => {
        const escapedKey = key.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const result = await ctx.evalInApp(`
          (async function() {
            try {
              var AsyncStorage = require('@react-native-async-storage/async-storage').default
                || require('react-native').AsyncStorage;
              if (!AsyncStorage) return { error: 'AsyncStorage not found' };
              var value = await AsyncStorage.getItem('${escapedKey}');
              try { return { key: '${escapedKey}', value: JSON.parse(value) }; }
              catch(e) { return { key: '${escapedKey}', value: value }; }
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
      parameters: z.object({
        maxLength: z.number().default(500).describe('Max length for each value'),
      }),
      handler: async ({ maxLength }) => {
        const result = await ctx.evalInApp(`
          (async function() {
            try {
              var AsyncStorage = require('@react-native-async-storage/async-storage').default
                || require('react-native').AsyncStorage;
              if (!AsyncStorage) return { error: 'AsyncStorage not found' };
              var keys = await AsyncStorage.getAllKeys();
              var entries = await AsyncStorage.multiGet(keys);
              var data = {};
              for (var i = 0; i < entries.length; i++) {
                var key = entries[i][0];
                var val = entries[i][1];
                if (val && val.length > ${maxLength}) {
                  val = val.substring(0, ${maxLength}) + '...(truncated)';
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
