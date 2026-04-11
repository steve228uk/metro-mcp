import { z } from 'zod';
import { definePlugin } from '../plugin.js';

// Minified deep-clean helper — strips null/undefined/empty-string from objects and arrays recursively
const CLEAN_FN = `function clean(v){if(v==null||v==='')return undefined;if(Array.isArray(v)){var a=v.map(clean).filter(function(x){return x!==undefined});return a.length?a:undefined;}if(typeof v==='object'){var o={};Object.keys(v).forEach(function(k){var c=clean(v[k]);if(c!==undefined)o[k]=c;});return Object.keys(o).length?o:undefined;}return v;}`;
const FMT_RNV_FN = `function fmtRnv(v){return v.major+'.'+v.minor+'.'+v.patch;}`;

export const environmentPlugin = definePlugin({
  name: 'environment',

  description: 'Inspect app runtime environment: build flags, platform constants, and a filtered subset of process.env',

  async setup(ctx) {
    ctx.registerTool('get_build_info', {
      description:
        'Return build-time and runtime flags for the running React Native app: __DEV__, platform, OS version, RN version, Hermes engine, New Architecture, and expo-application fields if available.',
      annotations: { readOnlyHint: true },
      parameters: z.object({}),
      handler: async () => {
        try {
          return await ctx.evalInApp(
            `(function() {
  ${CLEAN_FN}
  ${FMT_RNV_FN}
  var constants = nativeModuleProxy.PlatformConstants.getConstants();
  var systemName = constants.systemName || '';
  var rnv = constants.reactNativeVersion;
  var result = {
    isDev: typeof __DEV__ !== 'undefined' ? __DEV__ : null,
    platform: systemName.toLowerCase() === 'ios' ? 'ios' : 'android',
    version: constants.osVersion,
    rnVersion: rnv ? fmtRnv(rnv) : null,
    hermesEnabled: typeof HermesInternal !== 'undefined',
    newArch: typeof nativeFabricUIManager !== 'undefined',
  };
  try {
    var app = nativeModuleProxy.ExpoApplication;
    if (app && app.getConstants) {
      var appC = app.getConstants();
      if (appC) {
        result.bundleId = appC.applicationId;
        result.appVersion = appC.nativeApplicationVersion;
        result.buildNumber = appC.nativeBuildVersion;
      }
    }
  } catch(e) {}
  return clean(result) || {};
})()`,
          );
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
        const expression = `(function() {
  var env = typeof process !== 'undefined' ? process.env : {};
  var DENY = /SECRET|KEY|TOKEN|PASSWORD|PASS|PRIVATE|AUTH|CREDENTIAL|DSN/i;
  var filter = ${JSON.stringify(filter ?? '')};
  var filterLower = filter.toLowerCase();
  var includeAll = ${JSON.stringify(includeAll)};
  var result = {};
  Object.keys(env).forEach(function(k) {
    if (!includeAll && DENY.test(k)) return;
    if (filter && !k.toLowerCase().includes(filterLower)) return;
    if (env[k] != null && env[k] !== '') result[k] = env[k];
  });
  return result;
})()`;

        try {
          return await ctx.evalInApp(expression);
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
          return await ctx.evalInApp(
            `(function() {
  ${CLEAN_FN}
  ${FMT_RNV_FN}
  var c = nativeModuleProxy.PlatformConstants.getConstants();
  var out = Object.assign({}, c);
  if (out.reactNativeVersion) out.reactNativeVersion = fmtRnv(out.reactNativeVersion);
  return clean(out);
})()`,
          );
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
          return await ctx.evalInApp(
            `(function() {
  ${CLEAN_FN}
  try {
    var c = globalThis.expo && globalThis.expo.modules && globalThis.expo.modules.ExponentConstants;
    if (!c) return null;
    var cfg = c.expoConfig || c.manifest || null;
    if (!cfg) return null;
    var SKIP = ['plugins', 'hooks', '_internal', 'doctor', 'extra', 'locales', 'web', 'platforms', 'nodeModulesDir'];
    var r = {};
    Object.keys(cfg).forEach(function(k) {
      if (SKIP.indexOf(k) === -1) r[k] = cfg[k];
    });
    return clean(r) || null;
  } catch(e) { return null; }
})()`,
          );
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
  },
});
