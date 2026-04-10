import { z } from 'zod';
import { definePlugin } from '../plugin.js';

const CREDENTIAL_DENY_PATTERN = /SECRET|KEY|TOKEN|PASSWORD|PASS|PRIVATE|AUTH|CREDENTIAL|DSN|API_KEY/i;

const GET_BUILD_INFO_EXPR = `(function() {
  var result = {
    isDev: typeof __DEV__ !== 'undefined' ? __DEV__ : null,
    hermesEnabled: typeof HermesInternal !== 'undefined',
    newArch: typeof nativeFabricUIManager !== 'undefined',
  };
  try {
    var Platform = require('react-native').Platform;
    result.platform = Platform.OS;
    result.version = Platform.Version;
  } catch(e) {}
  try {
    var Application = require('expo-application');
    result.bundleId = Application.applicationId;
    result.appVersion = Application.nativeApplicationVersion;
    result.buildNumber = Application.nativeBuildVersion;
  } catch(e) {}
  try {
    var DeviceInfo = require('react-native-device-info');
    if (!result.bundleId) result.bundleId = DeviceInfo.getBundleId();
    if (!result.appVersion) result.appVersion = DeviceInfo.getVersion();
    if (!result.buildNumber) result.buildNumber = DeviceInfo.getBuildNumber();
  } catch(e) {}
  return result;
})()`;

const GET_PLATFORM_CONSTANTS_EXPR = `(function() {
  try {
    var Platform = require('react-native').Platform;
    return Platform.constants || null;
  } catch(e) {
    return { error: e.message };
  }
})()`;

const GET_EXPO_CONFIG_EXPR = `(function() {
  try {
    var C = require('expo-constants').default;
    return C.expoConfig || C.manifest2 || C.manifest || null;
  } catch(e) {
    return null;
  }
})()`;

export const environmentPlugin = definePlugin({
  name: 'environment',
  description:
    'Inspect the app runtime environment: build flags, platform constants, and a credential-safe subset of process.env.',

  async setup(ctx) {
    ctx.registerTool('get_build_info', {
      description:
        'Get runtime build information for the running app: ' +
        '__DEV__ flag, platform (ios/android), OS version, Hermes engine status, ' +
        'New Architecture status, bundle ID, and app version. ' +
        'Uses expo-application or react-native-device-info if available.',
      annotations: { readOnlyHint: true },
      parameters: z.object({}),
      handler: async () => {
        try {
          const result = await ctx.evalInApp(GET_BUILD_INFO_EXPR);
          return result ?? { error: 'Could not read build info from app runtime' };
        } catch (err) {
          return `Failed to get build info: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('get_env_vars', {
      description:
        'Read process.env variables from the app runtime. ' +
        'By default, keys matching credential patterns (SECRET, KEY, TOKEN, PASSWORD, etc.) are redacted. ' +
        'Use filter to search by key name substring. ' +
        'Use includeAll=true to bypass the credential filter (use with caution).',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        filter: z
          .string()
          .optional()
          .describe('Only return keys containing this substring (case-insensitive)'),
        includeAll: z
          .boolean()
          .default(false)
          .describe('Include keys matching credential patterns (SECRET, TOKEN, KEY, etc.)'),
      }),
      handler: async ({ filter, includeAll }) => {
        const expr = `(function() {
  try {
    var env = typeof process !== 'undefined' ? process.env : {};
    if (!env) return { error: 'process.env not available' };
    var DENY = ${JSON.stringify(CREDENTIAL_DENY_PATTERN.source)};
    var denyRe = new RegExp(DENY, 'i');
    var filterStr = ${filter ? JSON.stringify(filter) : 'null'};
    var includeAll = ${includeAll ? 'true' : 'false'};
    var result = {};
    var redacted = 0;
    Object.keys(env).forEach(function(k) {
      if (!includeAll && denyRe.test(k)) { redacted++; return; }
      if (filterStr && k.toLowerCase().indexOf(filterStr.toLowerCase()) === -1) return;
      result[k] = env[k];
    });
    return { vars: result, redactedCount: redacted };
  } catch(e) {
    return { error: e.message };
  }
})()`;

        try {
          const result = await ctx.evalInApp(expr);
          return result;
        } catch (err) {
          return `Failed to read env vars: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('get_platform_constants', {
      description:
        'Get React Native Platform.constants for the running app. ' +
        'Includes OS-specific constants like isTesting, reactNativeVersion, osVersion, ' +
        'and platform-specific values (e.g. interfaceIdiom on iOS, Release on Android).',
      annotations: { readOnlyHint: true },
      parameters: z.object({}),
      handler: async () => {
        try {
          const result = await ctx.evalInApp(GET_PLATFORM_CONSTANTS_EXPR);
          if (!result) return 'Platform.constants not available in this runtime.';
          return result;
        } catch (err) {
          return `Failed to get platform constants: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerTool('get_expo_config', {
      description:
        'Get the Expo app config (expoConfig / manifest) from expo-constants. ' +
        'Returns null if expo-constants is not installed. ' +
        'Includes fields like name, slug, version, extra, plugins, and scheme.',
      annotations: { readOnlyHint: true },
      parameters: z.object({}),
      handler: async () => {
        try {
          const result = await ctx.evalInApp(GET_EXPO_CONFIG_EXPR);
          if (!result) return 'expo-constants is not installed or no config is available.';
          return result;
        } catch (err) {
          return `Failed to get Expo config: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
  },
});
