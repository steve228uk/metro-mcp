import { z } from 'zod';
import { definePlugin } from '../plugin.js';

export const environmentPlugin = definePlugin({
  name: 'environment',

  description: 'Inspect app runtime environment: build flags, platform constants, Metro connection state, and a filtered subset of process.env',

  async setup(ctx) {
    ctx.registerTool('get_build_info', {
      description:
        'Return build-time and runtime flags for the running React Native app: __DEV__, platform, OS version, Hermes engine, New Architecture, and expo-application fields if available.',
      annotations: { readOnlyHint: true },
      parameters: z.object({}),
      handler: async () => {
        try {
          const result = await ctx.evalInApp(
            `(function() {
  var RN = require('react-native');
  var Platform = RN.Platform;
  var result = {
    isDev: typeof __DEV__ !== 'undefined' ? __DEV__ : null,
    platform: Platform.OS,
    version: Platform.Version,
    hermesEnabled: typeof HermesInternal !== 'undefined',
    newArch: typeof nativeFabricUIManager !== 'undefined',
  };
  try {
    var Application = require('expo-application');
    result.bundleId = Application.applicationId;
    result.appVersion = Application.nativeApplicationVersion;
    result.buildNumber = Application.nativeBuildVersion;
  } catch(e) {}
  return result;
})()`,
          );
          return result;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('get_env_vars', {
      description:
        'Return a filtered subset of process.env from the running app. Credential-like keys (SECRET, KEY, TOKEN, PASSWORD, etc.) are redacted by default. Use filter to search by key name substring.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        filter: z
          .string()
          .optional()
          .describe('Substring to match against env var key names (case-insensitive)'),
        includeAll: z
          .boolean()
          .default(false)
          .describe('When true, includes credential keys that are otherwise redacted'),
      }),
      handler: async ({ filter, includeAll }) => {
        const filterStr = filter ?? '';
        const includeAllBool = includeAll ?? false;

        const expression = `(function() {
  var env = typeof process !== 'undefined' ? process.env : {};
  var DENY = /SECRET|KEY|TOKEN|PASSWORD|PASS|PRIVATE|AUTH|CREDENTIAL|DSN/i;
  var filter = ${JSON.stringify(filterStr)};
  var includeAll = ${JSON.stringify(includeAllBool)};
  var result = {};
  Object.keys(env).forEach(function(k) {
    if (!includeAll && DENY.test(k)) return;
    if (filter && k.toLowerCase().indexOf(filter.toLowerCase()) === -1) return;
    result[k] = env[k];
  });
  return result;
})()`;

        try {
          const result = await ctx.evalInApp(expression);
          return result;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('get_platform_constants', {
      description: 'Return the full Platform.constants object from React Native, including OS-specific build details.',
      annotations: { readOnlyHint: true },
      parameters: z.object({}),
      handler: async () => {
        try {
          const result = await ctx.evalInApp(`require('react-native').Platform.constants`);
          return result;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('get_expo_config', {
      description:
        'Return expo-constants manifest/expoConfig fields if the app uses Expo, otherwise null.',
      annotations: { readOnlyHint: true },
      parameters: z.object({}),
      handler: async () => {
        try {
          const result = await ctx.evalInApp(
            `(function() {
  try {
    return require('expo-constants').default.expoConfig ||
           require('expo-constants').default.manifest;
  } catch(e) { return null; }
})()`,
          );
          return result;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
  },
});
