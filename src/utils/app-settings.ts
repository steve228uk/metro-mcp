/** Resolve initialized React Native exports from Metro without requiring modules by name. */
export function openAppSettingsExpression(platform: 'auto' | 'ios' | 'android'): string {
  return `(function() {
    var metroRequire = globalThis.__r;
    if (!metroRequire || typeof metroRequire.getModules !== 'function') {
      throw new Error('Unsupported capability: Metro module registry is unavailable.');
    }
    var modules = metroRequire.getModules();
    if (!modules || typeof modules.forEach !== 'function') {
      throw new Error('Unsupported capability: Metro module registry is unavailable.');
    }
    var linking = null;
    var runtimePlatform = null;
    function inspect(value) {
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) return;
      // The public React Native entrypoint exposes lazy getters. Reading Linking
      // here lets Metro initialize it by its real module ID when necessary.
      if ('AppRegistry' in value && 'View' in value && 'Platform' in value) {
        var candidate = value.Linking;
        if (candidate && typeof candidate.openSettings === 'function') {
          linking = candidate;
          runtimePlatform = value.Platform && value.Platform.OS;
        }
      }
      // Also support already initialized internal Linking and Platform modules.
      if (!linking && typeof value.openSettings === 'function' &&
          typeof value.openURL === 'function' && typeof value.canOpenURL === 'function' &&
          typeof value.getInitialURL === 'function') {
        linking = value;
      }
      if (!runtimePlatform && typeof value.select === 'function' && typeof value.OS === 'string') {
        runtimePlatform = value.OS;
      }
    }
    modules.forEach(function(module) {
      if (linking && runtimePlatform) return;
      try {
        var value = module && module.publicModule && module.publicModule.exports;
        inspect(value);
        if (value && value.default) inspect(value.default);
      } catch (_) {}
    });
    if (!linking) throw new Error('Unsupported capability: React Native Linking.openSettings is unavailable.');
    var requestedPlatform = ${JSON.stringify(platform)};
    if (requestedPlatform !== 'auto' && runtimePlatform !== requestedPlatform) {
      throw new Error(runtimePlatform
        ? 'Connected app platform does not match requested platform ' + requestedPlatform + '.'
        : 'Unsupported capability: connected app platform could not be verified.');
    }
    return linking.openSettings();
  })()`;
}
