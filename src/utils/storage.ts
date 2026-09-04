/**
 * Resolve an initialized AsyncStorage export without requiring a module by
 * name. Hermes exposes Metro's numeric module registry, while `require` may
 * be unavailable in the debugger runtime.
 */
export function resolveAsyncStorageExpression(): string {
  return `(function() {
    var storage = null;
    function isAsyncStorage(value) {
      return value && typeof value.getAllKeys === 'function' &&
        typeof value.getItem === 'function' && typeof value.multiGet === 'function';
    }
    function inspect(value) {
      if (isAsyncStorage(value)) return value;
      if (value && isAsyncStorage(value.default)) return value.default;
      return null;
    }

    var metroRequire = globalThis.__r;
    if (metroRequire && typeof metroRequire.getModules === 'function') {
      try {
        var modules = metroRequire.getModules();
        if (modules && typeof modules.forEach === 'function') {
          modules.forEach(function(module) {
            if (storage) return;
            try {
              var exports = module && module.publicModule && module.publicModule.exports;
              storage = inspect(exports);
            } catch (_) {}
          });
        }
      } catch (_) {}
    }

    // Keep compatibility with legacy runtimes that provide a callable require.
    if (!storage && typeof require === 'function') {
      try { storage = inspect(require('@react-native-async-storage/async-storage')); }
      catch (_) {}
      if (!storage) {
        try {
          var reactNative = require('react-native');
          storage = inspect(reactNative && reactNative.AsyncStorage);
        } catch (_) {}
      }
    }
    return storage;
  })()`;
}
